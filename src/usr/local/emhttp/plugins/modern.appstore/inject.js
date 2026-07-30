/*
 * Front-end for Unraid Modern App Store.
 *
 * Community Applications' 2026.07 rewrite made its client-side sort unreliable:
 * applying any sort collapses the All-Apps view to a ~36-app subset and orders
 * only those, and its results-per-page setting no longer reflects the view. So
 * this addon stops depending on CA's display/sort pipeline and renders its OWN
 * grid instead:
 *
 *   - applist.php hands us every displayable app (name/icon/category/stars/
 *     trends/date-added/downloads) for the whole ~3600-app catalog.
 *   - We sort that full list client-side (name / downloads / newest / GitHub
 *     stars / trending), paginate it, and paint a ★ badge on each tile.
 *   - Clicking a tile calls CA's own showSidebarApp(path,name), which opens the
 *     real Info + Install drawer. We never reimplement install, and never write
 *     to or modify anything CA owns.
 *
 * Everything is wrapped so a failure is a silent no-op that never breaks CA.
 */
(function () {
  'use strict';
  try {
    if (location.pathname.indexOf('/Apps') !== 0) return;
    // tells the loader's failsafe that this script is alive, so it leaves the
    // pre-paint class (which hides CA's own grid) in place
    window.__asgaAlive = 1;
    var PREFIX = '/plugins/modern.appstore/';

    var APPS = [];
    var view = { sort: 'new', q: '', cat: '', catLabel: 'All Apps', special: '', page: 1, perPage: 96 };
    var polling = false, wasRunning = false;
    var pageItemsNow = [];        // apps the grid is currently showing
    var scanAsked = {};           // path -> 1, so a page is only auto-scanned once
    var scanInFlight = false, scanPending = false, scanTimer = null;
    var pinnedSet = null, installedSet = null;
    // CA's Pinned/Installed views are broken in the 2026.07 rewrite (they render
    // the home screen), so the modern grid renders those itself (view.special).
    // The few views we can't yet rebuild from our data are handed back to CA.
    var caSpecial = false;
    var CA_SPECIAL = /^(previous_apps|prev_docker|prev_plugins|action_centre|repos)$/;
    function stripTag(ri) { return (ri || '').toLowerCase().split(':')[0]; }

    function loadViews(cb) {
      fetch(PREFIX + 'pinned.php?_=' + Date.now())
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { pinnedSet = new Set((j && j.pinned) || []); installedSet = new Set((j && j.installed) || []); cb && cb(); })
        .catch(function () { pinnedSet = pinnedSet || new Set(); installedSet = installedSet || new Set(); cb && cb(); });
    }

    // Trending windows are limited to day/week/month: those come from accurate
    // daily star-history deltas. A "this year" window would need a full year of
    // history the plugin hasn't accumulated, so it is deliberately omitted
    // rather than shown with fabricated/empty data.
    // Trending sorts also FILTER to apps that actually moved in that window, so
    // the view is a real "what's hot" list, not the whole catalog with a few
    // movers on top and everything else in feed order.
    var SORT_OPTS = [
      { v: 'name_asc',  label: 'Name Ascending',  cmp: function (a, b) { return a.sn < b.sn ? -1 : a.sn > b.sn ? 1 : 0; } },
      { v: 'name_desc', label: 'Name Descending', cmp: function (a, b) { return a.sn < b.sn ? 1 : a.sn > b.sn ? -1 : 0; } },
      { v: 'downloads', label: 'Unraid Downloads', cmp: numDesc('dl') },
      { v: 'new',       label: 'Newest to the App Store', cmp: numDesc('fs') },
      { v: 'ghstars',   label: 'GitHub Stars',    cmp: numDesc('s') },
      { v: 'ght1',      label: 'Trending (today)',      cmp: numDesc('t1'),  filter: hasTrend('t1') },
      { v: 'ght7',      label: 'Trending (this week)',  cmp: numDesc('t7'),  filter: hasTrend('t7') },
      { v: 'ght30',     label: 'Trending (this month)', cmp: numDesc('t30'), filter: hasTrend('t30') },
      { v: 'ghp1',      label: 'Trending % (today)',      cmp: pctDesc('t1'),  filter: hasPct('t1') },
      { v: 'ghp7',      label: 'Trending % (this week)',  cmp: pctDesc('t7'),  filter: hasPct('t7') },
      { v: 'ghp30',     label: 'Trending % (this month)', cmp: pctDesc('t30'), filter: hasPct('t30') }
    ];
    function optFor(v) { for (var i = 0; i < SORT_OPTS.length; i++) if (SORT_OPTS[i].v === v) return SORT_OPTS[i]; return SORT_OPTS[0]; }
    // numeric descending; null/undefined sinks to the bottom
    function numDesc(k) { return function (a, b) { var x = a[k], y = b[k]; if (x == null) x = -Infinity; if (y == null) y = -Infinity; return y - x; }; }
    // relative growth: window delta / stars at window start, 10-star floor so
    // tiny repos (2->4 = +100%) don't dominate. Mirrors the old server logic.
    function pct(a, k) { var d = a[k]; if (d == null || a.s == null) return -Infinity; var base = a.s - d; if (base < 10) return -Infinity; return d / base; }
    function pctDesc(k) { return function (a, b) { return pct(b, k) - pct(a, k); }; }
    // trending filters: only apps that actually gained stars in the window
    function hasTrend(k) { return function (a) { return a[k] != null && a[k] > 0; }; }
    function hasPct(k) { return function (a) { return pct(a, k) > 0; }; }

    function fmt(n) {
      if (n == null) return '';
      var x = Math.abs(n);
      if (x >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
      if (x >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
      if (x >= 1e3) return (n / 1e3).toFixed(x >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
      return '' + n;
    }

    function loadApps(cb) {
      fetch(PREFIX + 'applist.php?_=' + Date.now())
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { APPS = dedupe((j && j.apps) || []); cb && cb(); })
        .catch(function () { APPS = APPS || []; cb && cb(); });
    }
    // The feed carries the same app under multiple templates (e.g. a repo and a
    // mirror), so the grid showed duplicates. Collapse by name+author, keeping
    // the richer record (has an icon, then the longer description).
    function dedupe(apps) {
      var by = {}, order = [];
      apps.forEach(function (a) {
        var key = (a.n || '').toLowerCase().trim() + '|' + (a.au || '').toLowerCase().trim();
        if (!by[key]) { by[key] = a; order.push(key); return; }
        var cur = by[key];
        var better = (!!a.ic && !cur.ic) || ((!!a.ic === !!cur.ic) && (a.de || '').length > (cur.de || '').length);
        if (better) by[key] = a;
      });
      return order.map(function (k) { return by[k]; });
    }

    // ---- sort persistence: remember the last sort, but reset to Newest if it
    // has been more than 20 minutes since the Apps page was last opened. ----
    function initSort() {
      try {
        var ts = parseInt(localStorage.getItem('asga_visit_ts') || '0', 10);
        var saved = localStorage.getItem('asga_sort');
        if (saved && optFor(saved).v === saved && (Date.now() - ts) < 20 * 60 * 1000) view.sort = saved;
        localStorage.setItem('asga_visit_ts', '' + Date.now());
      } catch (e) {}
    }
    function saveSort() { try { localStorage.setItem('asga_sort', view.sort); localStorage.setItem('asga_visit_ts', '' + Date.now()); } catch (e) {} }

    // ---- filtering + sorting ----
    function catMatch(a, cat) {
      if (!cat) return true;
      var c = (a.ct || '').toLowerCase();
      cat = cat.toLowerCase();
      return c === cat || c.indexOf(cat) >= 0;
    }
    function currentList() {
      var q = view.q.trim().toLowerCase();
      var opt = optFor(view.sort);
      var list = APPS.filter(function (a) {
        if (view.special === 'pinned') { if (!pinnedSet || !pinnedSet.has((a.ri || '') + '&' + (a.pn || ''))) return false; }
        else if (view.special === 'installed') { if (!installedSet || !installedSet.has(stripTag(a.ri))) return false; }
        if (opt.filter && !opt.filter(a)) return false;   // e.g. trending: only movers
        if (!catMatch(a, view.cat)) return false;
        if (q) {
          if ((a.n || '').toLowerCase().indexOf(q) < 0 &&
              (a.ct || '').toLowerCase().indexOf(q) < 0 &&
              (a.rp || '').toLowerCase().indexOf(q) < 0) return false;
        }
        return true;
      });
      list.sort(opt.cmp);
      return list;
    }

    // ---- rendering ----
    function ensureGrid() {
      var host = document.querySelector('.mainArea');
      if (!host) return null;
      var wrap = document.getElementById('asga-view');
      if (wrap) return wrap;
      wrap = document.createElement('div');
      wrap.id = 'asga-view';
      wrap.innerHTML = '<div id="asga-count" class="asga-count"></div>' +
        '<div id="asga-grid" class="asga-grid"></div>' +
        '<div id="asga-pager" class="asga-pager"></div>';
      var anchor = document.getElementById('templates_content');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(wrap, anchor);
      else host.appendChild(wrap);
      // one delegated click handles tiles + their Info/Support/Install buttons
      document.getElementById('asga-grid').addEventListener('click', function (e) {
        var el = e.target;
        var tile = el.closest ? el.closest('.asga-tile') : null;
        if (!tile) return;
        var p = tile.getAttribute('data-apppath'), n = tile.getAttribute('data-appname');
        var btn = el.closest ? el.closest('.asga-btn') : null;
        if (btn) {
          e.stopPropagation();
          if (btn.classList.contains('asga-install')) {
            installApp(tile);
          } else if (btn.classList.contains('asga-project')) {
            openExt(tile.getAttribute('data-project'));
          } else if (btn.classList.contains('asga-support')) {
            openExt(tile.getAttribute('data-support'));
          } else if (btn.classList.contains('asga-pin')) {
            pinApp(tile, btn);
          } else { // Info
            try { window.showSidebarApp(p, n); } catch (err) {}
          }
          return;
        }
        // click anywhere else on the card opens the Info/Install drawer
        try { window.showSidebarApp(p, n); } catch (err) {}
      });
      return wrap;
    }

    // pin/unpin via CA's own pinApp action (keyed by RepoName & Name, exactly
    // like CA's drawer button), and reflect the toggled state on our button.
    function pinApp(tile, btn) {
      // CA keys pins by "<image ref>&<SortName>" (exactly what its own drawer
      // sends), so pinnedApps() can find the template again.
      var repo = tile.getAttribute('data-pinrepo') || '', name = tile.getAttribute('data-pinname') || '';
      if (!repo) return;
      var key = repo + '&' + name;
      var willPin = btn.textContent !== 'Unpin';
      btn.textContent = willPin ? 'Unpin' : 'Pin App';
      btn.classList.toggle('asga-pinned', willPin);
      if (pinnedSet) { if (willPin) pinnedSet.add(key); else pinnedSet.delete(key); }
      try {
        window.post({ action: 'pinApp', repository: repo, name: name }, function () {
          if (view.special === 'pinned') render();   // reflect an unpin immediately in the pinned view
        });
      } catch (e) {}
    }

    function openExt(url) { if (url) try { window.open(url, '_blank', 'noopener'); } catch (e) {} }

    // Screenshot lightbox. CA's own gallery (magnificPopup) closes the whole
    // drawer when a preview opens and re-opens it on close, which flashes the
    // pane blank and, because it re-binds each time, sometimes shows two images
    // overlaid. In modern view we intercept the click and show our own overlay
    // instead, so the drawer stays put.
    function wireLightbox() {
      if (document.body.__asgaLightbox) return;
      document.body.__asgaLightbox = true;
      var srcOf = function (el) { return el.getAttribute('href') || (el.querySelector('img') && el.querySelector('img').getAttribute('src')) || el.getAttribute('src'); };
      document.addEventListener('click', function (e) {
        if (!isOn()) return;
        // previews are <a class="screenshot mfp-image">; the app icon is
        // img.popupIcon.screenshot (handle it too so CA's gallery never fires).
        var scr = e.target.closest ? e.target.closest('#sidenavContent .screenshot') : null;
        if (!scr) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (scr.classList.contains('popupIcon')) { var s = srcOf(scr); if (s) openLightbox([s], 0); return; }
        var items = [].slice.call(document.querySelectorAll('#sidenavContent .screenshot')).filter(function (el) { return !el.classList.contains('popupIcon'); });
        var srcs = items.map(srcOf).filter(Boolean);
        openLightbox(srcs, Math.max(0, items.indexOf(scr)));
      }, true);
    }
    function openLightbox(srcs, idx) {
      if (!srcs.length) return;
      var i = idx;
      var ov = document.createElement('div');
      ov.className = 'asga-lightbox';
      ov.innerHTML = '<span class="asga-lb-close">✕</span>' +
        (srcs.length > 1 ? '<span class="asga-lb-nav asga-lb-prev">‹</span><span class="asga-lb-nav asga-lb-next">›</span>' : '') +
        '<img class="asga-lb-img" alt="">';
      var imgEl = ov.querySelector('.asga-lb-img');
      var show = function () { imgEl.src = srcs[(i + srcs.length) % srcs.length]; };
      show();
      var close = function () { ov.remove(); document.removeEventListener('keydown', key, true); };
      var key = function (ev) { if (ev.key === 'Escape') close(); else if (ev.key === 'ArrowRight') { i++; show(); } else if (ev.key === 'ArrowLeft') { i--; show(); } };
      ov.addEventListener('click', function (ev) {
        if (ev.target.classList.contains('asga-lb-close') || ev.target === ov) return close();
        if (ev.target.classList.contains('asga-lb-next')) { i++; show(); }
        else if (ev.target.classList.contains('asga-lb-prev')) { i--; show(); }
      });
      document.addEventListener('keydown', key, true);
      document.body.appendChild(ov);
    }

    // Install in a NEW tab. Docker apps open CA's template editor at
    // /Apps/AddContainer; plugins open CA's plugin-install page. Same targets CA
    // uses, just forced into a new tab.
    function installApp(tile) {
      var p = tile.getAttribute('data-apppath'), ty = tile.getAttribute('data-type'), pu = tile.getAttribute('data-plugurl');
      if (ty === 'plugin') {
        // plugins: let CA drive its own plugin install (its flow differs from docker)
        try { window.showSidebarApp(p, tile.getAttribute('data-appname')); } catch (e) {}
        return;
      }
      try { window.open('/Apps/AddContainer?xmlTemplate=default:' + encodeURIComponent(p), '_blank', 'noopener'); } catch (e) {}
    }

    function makeTile(a) {
      var tile = document.createElement('div');
      tile.className = 'asga-tile';
      tile.setAttribute('data-apppath', a.p);
      tile.setAttribute('data-appname', a.n);
      if (a.pr) tile.setAttribute('data-project', a.pr);
      if (a.su) tile.setAttribute('data-support', a.su);
      if (a.ri) { tile.setAttribute('data-pinrepo', a.ri); tile.setAttribute('data-pinname', a.pn || a.n); }
      tile.setAttribute('data-type', a.ty || 'docker');
      if (a.pu) tile.setAttribute('data-plugurl', a.pu);
      tile.title = a.n;

      // header: icon + name/author/category
      var head = document.createElement('div');
      head.className = 'asga-tile-head';

      var iconWrap = document.createElement('div');
      iconWrap.className = 'asga-tile-icon';
      var img = document.createElement('img');
      var fallback = '/plugins/dynamix.docker.manager/images/question.png';
      // icon fallback chain: the app's own icon, else the GitHub owner's avatar
      // (many templates ship no icon URL), else CA's question mark.
      var ghAvatar = (a.rp && a.rp.indexOf('/') > 0) ? ('https://github.com/' + a.rp.split('/')[0] + '.png?size=128') : '';
      img.src = a.ic || ghAvatar || fallback; img.loading = 'lazy'; img.alt = '';
      img.onerror = function () {
        if (ghAvatar && this.src !== ghAvatar && this.src.indexOf('github.com') < 0) { this.src = ghAvatar; return; }
        if (this.src.indexOf('question.png') < 0) this.src = fallback;
      };
      iconWrap.appendChild(img);
      head.appendChild(iconWrap);

      // stars + downloads sit inline in the tile's top-right corner
      var badges = document.createElement('div');
      badges.className = 'asga-tile-badges';
      if (a.s != null) {
        var badge = document.createElement('span');
        badge.className = 'ghstars-badge';
        badge.textContent = '★ ' + fmt(a.s);
        badge.title = a.s + ' GitHub stars';
        badges.appendChild(badge);
      }
      if (a.dl > 0) {
        var dlb = document.createElement('span');
        dlb.className = 'ghdl-badge';
        dlb.textContent = '⤓ ' + fmt(a.dl);
        dlb.title = a.dl.toLocaleString() + ' Docker image pulls';
        badges.appendChild(dlb);
      }
      if (badges.children.length) { tile.appendChild(badges); tile.classList.add('asga-has-badges'); }

      var htext = document.createElement('div');
      htext.className = 'asga-tile-htext';
      var name = document.createElement('div');
      name.className = 'asga-tile-name';
      name.textContent = a.n;
      htext.appendChild(name);
      if (a.au) {
        var au = document.createElement('div');
        au.className = 'asga-tile-author';
        au.textContent = a.au;
        htext.appendChild(au);
      }
      var metaRow = document.createElement('div');
      metaRow.className = 'asga-tile-metarow';
      var typ = document.createElement('span');
      typ.className = 'asga-type asga-type-' + (a.ty || 'docker');
      typ.textContent = (a.ty === 'plugin') ? 'Plugin' : 'Docker';
      metaRow.appendChild(typ);
      if (a.ct) {
        var cat = document.createElement('span');
        cat.className = 'asga-tile-cat';
        cat.textContent = a.ct;
        metaRow.appendChild(cat);
      }
      htext.appendChild(metaRow);
      head.appendChild(htext);
      tile.appendChild(head);

      // description (verbiage)
      if (a.de) {
        var desc = document.createElement('div');
        desc.className = 'asga-tile-desc';
        desc.textContent = a.de;
        tile.appendChild(desc);
      }

      // Info / Pin / Project / Support / Install buttons (Project + Support are
      // direct links, no submenu)
      var btns = document.createElement('div');
      btns.className = 'asga-tile-btns';
      btns.appendChild(mkBtn('Info', 'asga-info'));
      if (a.ri) {
        var isPinned = pinnedSet && pinnedSet.has(a.ri + '&' + (a.pn || ''));
        var pb = mkBtn(isPinned ? 'Unpin' : 'Pin App', 'asga-pin');
        if (isPinned) pb.classList.add('asga-pinned');
        btns.appendChild(pb);
      }
      if (a.pr) btns.appendChild(mkBtn('Project', 'asga-project'));
      if (a.su) btns.appendChild(mkBtn('Support', 'asga-support'));
      btns.appendChild(mkBtn('Install', 'asga-install'));
      tile.appendChild(btns);

      // when CA's feed first saw this app, bottom-right of the card
      var added = addedLabel(a.fs);
      if (added) {
        var ad = document.createElement('div');
        ad.className = 'asga-tile-added';
        ad.textContent = added;
        tile.appendChild(ad);
      }
      return tile;
    }
    // CA's FirstSeen is a unix timestamp, and it floors anything older than its
    // own record-keeping to 1433000000 (Jun 2015). For those the time of day is
    // an artefact, so only the date is shown.
    function addedLabel(fs) {
      if (!fs) return '';
      var d = new Date(fs * 1000);
      if (isNaN(d.getTime())) return '';
      var opts = { year: 'numeric', month: 'short', day: 'numeric' };
      if (fs > 1433649600) { opts.hour = 'numeric'; opts.minute = '2-digit'; }
      try { return 'Added ' + d.toLocaleString(undefined, opts); }
      catch (e) { return 'Added ' + d.toDateString(); }
    }
    function mkBtn(label, cls) {
      var b = document.createElement('span');
      b.className = 'asga-btn ' + cls;
      b.textContent = label;
      return b;
    }

    function render() {
      if (!isOn() || caSpecial) return;
      var wrap = ensureGrid();
      if (!wrap) return;
      var list = currentList();
      var total = list.length;
      var pages = Math.max(1, Math.ceil(total / view.perPage));
      if (view.page > pages) view.page = pages;
      if (view.page < 1) view.page = 1;
      var start = (view.page - 1) * view.perPage;
      var pageItems = list.slice(start, start + view.perPage);

      var grid = document.getElementById('asga-grid');
      grid.textContent = '';
      if (!total) {
        var empty = document.createElement('div');
        empty.className = 'asga-empty';
        empty.textContent = view.special === 'pinned' ? 'No pinned apps yet. Use the Pin App button on any app to add it here.'
          : view.special === 'installed' ? 'No installed apps matched the App Store catalog.'
          : view.q ? 'No apps match "' + view.q + '".' : 'No apps to show.';
        grid.appendChild(empty);
      } else {
        var frag = document.createDocumentFragment();
        for (var i = 0; i < pageItems.length; i++) frag.appendChild(makeTile(pageItems[i]));
        grid.appendChild(frag);
      }

      var noun = view.special === 'pinned' ? 'pinned apps' : view.special === 'installed' ? 'installed apps' : 'apps';
      var title = view.special === 'pinned' ? 'Pinned Apps' : view.special === 'installed' ? 'Installed Apps' : (view.cat ? view.catLabel : 'All Apps');
      var from = total ? start + 1 : 0, to = Math.min(start + view.perPage, total);
      var cnt = document.getElementById('asga-count');
      cnt.textContent = '';
      var h = document.createElement('span'); h.className = 'asga-count-title'; h.textContent = title;
      var s = document.createElement('span'); s.className = 'asga-count-sub';
      s.textContent = total ? ('  ' + from + '–' + to + ' of ' + total + ' ' + noun + (view.q ? ' matching "' + view.q + '"' : '')) : '';
      cnt.appendChild(h); cnt.appendChild(s);
      renderPager(pages);
      pageItemsNow = pageItems;
      queueScan();
      try { window.scrollTo(0, 0); } catch (e) {}
    }

    // Stars are fetched for the apps on screen rather than the whole 3600-app
    // catalog: paging or filtering tops up whatever the new page is missing.
    // Anything tried within the last week is left alone (the server enforces
    // that too), and each path is only auto-requested once per page load.
    function queueScan() {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(function () { scanVisible(false); }, 400);
    }
    function scanVisible(force) {
      if (!isOn()) return;
      // a page turn while a scan is running would otherwise be dropped, so the
      // new page is picked up as soon as the current request lands
      if (scanInFlight) { scanPending = true; return; }
      scanPending = false;
      var now = Math.floor(Date.now() / 1000);
      var want = [];
      for (var i = 0; i < pageItemsNow.length; i++) {
        var a = pageItemsNow[i];
        if (!a || !a.p) continue;
        var due = force || a.s == null || !a.sa || (now - a.sa) > 7 * 86400;
        if (!due) continue;
        if (!force && scanAsked[a.p]) continue;
        want.push(a.p);
      }
      if (!want.length) return;
      want.forEach(function (p) { scanAsked[p] = 1; });
      scanInFlight = true;
      fetch(PREFIX + 'scanpage.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: want, force: !!force })
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (j) {
          scanInFlight = false;
          if (scanPending) queueScan();
          var stars = (j && j.stars) || {};
          var byPath = {};
          for (var i = 0; i < APPS.length; i++) byPath[APPS[i].p] = APPS[i];
          want.forEach(function (p) {
            var a = byPath[p];
            if (!a) return;
            a.sa = now;                                    // tried; don't ask again this week
            if (Object.prototype.hasOwnProperty.call(stars, p)) a.s = stars[p];
          });
          paintStars(stars);
        });
    }
    // Repaint badges in place. A full render() would jump the page back to the
    // top under the user while they are reading.
    function paintStars(stars) {
      var grid = document.getElementById('asga-grid');
      if (!grid) return;
      var tiles = grid.querySelectorAll('.asga-tile');
      for (var i = 0; i < tiles.length; i++) {
        var t = tiles[i];
        var p = t.getAttribute('data-apppath');
        var v = stars[p];
        if (v == null) continue;
        var wrap = t.querySelector('.asga-tile-badges');
        if (!wrap) {
          wrap = document.createElement('div');
          wrap.className = 'asga-tile-badges';
          t.appendChild(wrap);
        }
        t.classList.add('asga-has-badges');   // reserves title space for the badges
        var b = wrap.querySelector('.ghstars-badge');
        if (!b) {
          b = document.createElement('span');
          b.className = 'ghstars-badge';
          wrap.insertBefore(b, wrap.firstChild);
        }
        b.textContent = '\u2605 ' + fmt(v);
        b.title = v + ' GitHub stars';
      }
    }

    function renderPager(pages) {
      var p = document.getElementById('asga-pager');
      p.textContent = '';
      if (pages <= 1) return;
      var mk = function (label, page, disabled, cur) {
        var b = document.createElement('a');
        b.className = 'asga-page' + (cur ? ' asga-page-cur' : '') + (disabled ? ' asga-page-off' : '');
        b.textContent = label;
        if (!disabled && !cur) b.addEventListener('click', function () { view.page = page; render(); });
        return b;
      };
      p.appendChild(mk('‹ Prev', view.page - 1, view.page <= 1, false));
      // windowed page numbers around current
      var win = 3, lo = Math.max(1, view.page - win), hi = Math.min(pages, view.page + win);
      if (lo > 1) { p.appendChild(mk('1', 1, false, view.page === 1)); if (lo > 2) p.appendChild(dots()); }
      for (var n = lo; n <= hi; n++) p.appendChild(mk('' + n, n, false, n === view.page));
      if (hi < pages) { if (hi < pages - 1) p.appendChild(dots()); p.appendChild(mk('' + pages, pages, false, view.page === pages)); }
      p.appendChild(mk('Next ›', view.page + 1, view.page >= pages, false));
    }
    function dots() { var s = document.createElement('span'); s.className = 'asga-dots'; s.textContent = '…'; return s; }

    // ---- our toolbar (toggle + dropdown + refresh) in CA's search row ----
    function addSortBar() {
      var host = document.getElementById('searchFilter');
      if (!host || document.getElementById('asga-bar')) return;
      var opts = SORT_OPTS.map(function (o) { return '<option value="' + o.v + '">' + o.label + '</option>'; }).join('');
      var bar = document.createElement('span');
      bar.id = 'asga-bar';
      bar.className = 'asga-bar';
      bar.innerHTML =
        '<label class="asga-toggle" title="Toggle between the modern view and the stock Community Applications view">' +
          '<input type="checkbox" id="asga-toggle-cb"><span class="asga-toggle-track"><span class="asga-toggle-knob"></span></span>' +
          '<span class="asga-toggle-lbl">Modern view</span>' +
        '</label>' +
        '<span class="asga-sortwrap"><span class="asga-bar-label">Sort By:</span>' +
        '<select id="asga-sortsel" class="asga-sortsel">' + opts + '</select>' +
        '<a id="asga-refresh" class="asga-refreshlink" title="Refresh GitHub star data">↻</a></span>';
      host.appendChild(bar);
      var sel = document.getElementById('asga-sortsel');
      sel.value = view.sort;
      sel.addEventListener('change', function (e) { view.sort = e.target.value; view.page = 1; saveSort(); render(); });
      document.getElementById('asga-refresh').addEventListener('click', onRefreshClick);
      var cb = document.getElementById('asga-toggle-cb');
      cb.checked = isOn();
      cb.addEventListener('change', function () { setOn(cb.checked); });
    }

    // GitHub view on/off, persisted. When off, we un-hide CA's own grid and let
    // the stock App Store view take over; when on, our grid drives the page.
    function isOn() { try { return localStorage.getItem('asga_view_off') !== '1'; } catch (e) { return true; } }
    function setOn(on) {
      try { localStorage.setItem('asga_view_off', on ? '0' : '1'); } catch (e) {}
      applyViewMode();
      if (on) { render(); }
      else {
        // hand control back to CA: show its grid and load its All-Apps view fresh
        var all = document.querySelector('.caMenuItem.allApps');
        if (all) try { all.click(); } catch (e) {}
      }
    }
    function applyViewMode() {
      var persisted = isOn();
      var showOurs = persisted && !caSpecial;   // a CA special view temporarily wins
      document.body.classList.toggle('asga-active', showOurs);   // CSS hides CA's grid only when ours shows
      // the loader sets this on <html> before CA's markup is parsed, so its
      // stock controls never flash; keep the two in step when toggling live
      document.documentElement.classList.toggle('asga-pre', showOurs);
      var v = document.getElementById('asga-view'); if (v) v.style.display = showOurs ? '' : 'none';
      var sw = document.querySelector('.asga-sortwrap'); if (sw) sw.style.display = showOurs ? '' : 'none';
      var cb = document.getElementById('asga-toggle-cb'); if (cb) cb.checked = persisted;   // toggle reflects the persisted choice
    }

    // filter as the user types in CA's own search box (CA's hidden results are ignored)
    function wireSearch() {
      var box = document.getElementById('searchBox');
      if (!box || box.__asgaWired) return;
      box.__asgaWired = true;
      var deb;
      box.addEventListener('input', function () {
        clearTimeout(deb);
        deb = setTimeout(function () {
          if (!isOn()) return;
          if (caSpecial) { caSpecial = false; applyViewMode(); }   // leave a CA view when searching
          view.special = '';   // search spans the whole store
          view.q = box.value || ''; view.page = 1; render();
        }, 120);
      });
    }

    // left-menu category clicks filter our grid (capture phase, we don't stop CA)
    function wireCategories() {
      if (document.body.__asgaCatWired) return;
      document.body.__asgaCatWired = true;
      document.addEventListener('click', function (e) {
        var item = e.target.closest ? e.target.closest('.caMenuItem[data-category], .startupButton') : null;
        if (!item) return;
        var cat = item.getAttribute('data-category') || '';
        var label = (item.textContent || '').trim();
        var box = document.getElementById('searchBox');
        // Pinned + Installed: CA's own views are broken, so render them ourselves.
        if (cat === 'pinned_apps' || cat === 'installed_apps') {
          caSpecial = false; view.special = (cat === 'installed_apps') ? 'installed' : 'pinned';
          view.cat = ''; view.q = ''; if (box) box.value = ''; view.page = 1;
          loadViews(function () { applyViewMode(); render(); });
          return;
        }
        if (CA_SPECIAL.test(cat)) {
          // Previous Apps / Action Centre / Repositories: hand back to CA for now.
          caSpecial = true; applyViewMode(); return;
        }
        // Home (startup screens) and All Apps both mean the full catalog for us.
        caSpecial = false; view.special = '';
        var homeLike = item.classList.contains('startupButton') || /^(onlynew|spotlight|top_trending|home)$/.test(cat);
        if (homeLike || cat === 'All' || cat === 'New' || cat === '' || item.classList.contains('allApps')) { view.cat = ''; view.catLabel = 'All Apps'; }
        else { view.cat = cat; view.catLabel = label || cat; }
        view.q = ''; if (box) box.value = '';
        view.page = 1;
        applyViewMode();
        setTimeout(render, 0);
      }, true);
    }

    // ---- no-token warning ----
    function showWarningIfNeeded() {
      var cfg = window.__modernAppStore || {};
      if (cfg.hasToken) return;
      if (document.querySelector('.ghstars-warning')) return;
      var main = document.querySelector('.mainArea');
      if (!main) return;
      var w = document.createElement('div');
      w.className = 'ghstars-warning';
      var msg = document.createElement('span');
      msg.innerHTML = '⚠ <b>Unraid Modern App Store:</b> no GitHub personal access token configured, so ' +
        'star counts are disabled. Add a token in <a href="' + (cfg.settingsUrl || '/Settings') +
        '">Settings → Unraid Modern App Store</a>.';
      var x = document.createElement('span');
      x.className = 'ghstars-warning-x'; x.title = 'Dismiss'; x.textContent = '✕';
      x.addEventListener('click', function () { w.parentNode && w.parentNode.removeChild(w); });
      w.appendChild(msg); w.appendChild(x);
      main.insertBefore(w, main.firstChild);
    }

    // ---- refresh + progress (thin top bar) ----
    // The icon offers the cheap option first: rescan what is on screen. A full
    // catalog scan is still there, with its own 3-day cooldown.
    function onRefreshClick(e) {
      if (e) { e.stopPropagation(); e.preventDefault(); }
      var host = document.getElementById('asga-refresh');
      if (!host) return;
      var open = document.querySelector('.asga-refmenu');
      if (open) { open.remove(); return; }
      var menu = document.createElement('div');
      menu.className = 'asga-refmenu';
      menu.innerHTML = '<span class="asga-refitem" data-act="page">Refresh this page</span>' +
                       '<span class="asga-refitem" data-act="all">Refresh everything</span>';
      host.parentNode.insertBefore(menu, host.nextSibling);
      menu.addEventListener('click', function (ev) {
        var item = ev.target.closest ? ev.target.closest('.asga-refitem') : null;
        if (!item) return;
        menu.remove();
        if (item.getAttribute('data-act') === 'page') scanVisible(true);
        else refreshAll();
      });
      setTimeout(function () {
        document.addEventListener('click', function close(ev) {
          if (menu.contains(ev.target)) return;
          menu.remove();
          document.removeEventListener('click', close, true);
        }, true);
      }, 0);
    }
    function refreshAll() {
      if (!window.confirm('Fetch the latest GitHub star data for every app now? Allowed once every 3 days.')) return;
      fetch(PREFIX + 'refresh.php?_=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (res) {
          if (res && res.cooldown) {
            var d = Math.max(1, Math.ceil((res.next_allowed - Math.floor(Date.now() / 1000)) / 86400));
            alert('Already refreshed recently. Next refresh allowed in ~' + d + ' day(s).');
            return;
          }
          startPolling();
        });
    }
    function ensureTopBar() {
      var bar = document.getElementById('ghstars-topbar');
      if (bar) return bar;
      bar = document.createElement('div');
      bar.id = 'ghstars-topbar';
      bar.className = 'ghstars-topbar';
      bar.style.display = 'none';
      bar.innerHTML = '<div class="ghstars-topbar-fill"></div><span class="ghstars-topbar-label"></span><a class="ghstars-topbar-x" title="Cancel">✕</a>';
      document.body.appendChild(bar);
      bar.querySelector('.ghstars-topbar-x').addEventListener('click', function () {
        fetch(PREFIX + 'cancel.php?_=' + Date.now()).catch(function () {});
      });
      return bar;
    }
    function pollProgress() {
      fetch(PREFIX + 'progress.json?_=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (p) {
          var bar = ensureTopBar();
          var stale = p && p.updated_at && (Math.floor(Date.now() / 1000) - p.updated_at) > 90;
          if (p && p.running && !stale) {
            wasRunning = true;
            bar.style.display = '';
            var pct = p.total > 0 ? Math.min(100, Math.round(p.done / p.total * 100)) : 3;
            bar.querySelector('.ghstars-topbar-fill').style.width = pct + '%';
            // a scan opens with a link-resolution pass (CA hides most project
            // URLs behind redirectors), which is slow enough to need its own label
            var what = p.phase === 'links' ? 'Resolving app links… ' : 'Pulling GitHub stars… ';
            bar.querySelector('.ghstars-topbar-label').textContent = what + (p.total > 0 ? (p.done + '/' + p.total) : 'starting…');
            setTimeout(pollProgress, 1200);
          } else {
            bar.style.display = 'none';
            if (wasRunning) { wasRunning = false; loadApps(function () { render(); }); }
            polling = false;
          }
        }).catch(function () { polling = false; });
    }
    function startPolling() { if (polling) return; polling = true; pollProgress(); }
    function triggerNewScan() {
      fetch(PREFIX + 'newscan.php?_=' + Date.now())
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (res) { if (res && res.started) setTimeout(startPolling, 1000); })
        .catch(function () {});
    }

    // ---- lifecycle ----
    // CA keeps re-rendering its own (now hidden) grid; re-attach our UI if CA
    // rebuilt the toolbar, but the grid itself only re-renders on user actions.
    // CA opens an "Updating Content / Please Wait" modal on every Apps visit and
    // relies on its own render finishing to close it. Our grid replaces CA's
    // render, so that modal (and CA's spinner) can get stuck open. Close it.
    function dismissCaLoading() {
      if (!isOn()) return;
      if (document.querySelector('.updateContent-swal')) {
        try { if (typeof window.myCloseAlert === 'function') window.myCloseAlert(true); else if (window.swal && window.swal.close) window.swal.close(); } catch (e) {}
      }
    }

    function attachUI() {
      addSortBar();
      wireSearch();
      wireCategories();
      wireLightbox();
      showWarningIfNeeded();
      applyViewMode();
      dismissCaLoading();
      if (isOn() && !document.getElementById('asga-view')) render();
    }

    function start() {
      initSort();    // restore last sort (or reset to Newest after 20 min)
      triggerNewScan();
      loadViews();   // pin/installed membership, so tiles show correct pin state
      loadApps(function () {
        attachUI();
        render();
        var main = document.querySelector('.mainArea') || document.body;
        var pending = false;
        var mo = new MutationObserver(function () {
          if (pending) return;
          pending = true;
          setTimeout(function () { pending = false; attachUI(); }, 200);
        });
        mo.observe(main, { childList: true, subtree: true });
        startPolling();
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  } catch (e) { /* never break CA */ }
})();
