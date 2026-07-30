/*
 * Front-end for the App Store GitHub Addon.
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
    var PREFIX = '/plugins/appstore.github.addon/';

    var APPS = [];
    var view = { sort: 'new', q: '', cat: '', catLabel: 'All Apps', page: 1, perPage: 96 };
    var polling = false, wasRunning = false;

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
        .then(function (j) { APPS = (j && j.apps) || []; cb && cb(); })
        .catch(function () { APPS = APPS || []; cb && cb(); });
    }

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
            try { window.popupInstallXML(p, 'default', '', ''); } catch (err) {}
          } else if (btn.classList.contains('asga-support')) {
            toggleSupportMenu(tile, btn);
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

    // small self-contained Support menu (Project / Support), no CA dependency
    function toggleSupportMenu(tile, btn) {
      var existing = tile.querySelector('.asga-supmenu');
      document.querySelectorAll('.asga-supmenu').forEach(function (m) { m.remove(); });
      if (existing) return;
      var pr = tile.getAttribute('data-project') || '', su = tile.getAttribute('data-support') || '';
      if (!pr && !su) return;
      var menu = document.createElement('div');
      menu.className = 'asga-supmenu';
      if (pr) menu.appendChild(supLink('Project', pr));
      if (su) menu.appendChild(supLink('Support', su));
      btn.parentNode.appendChild(menu);
      setTimeout(function () {
        document.addEventListener('click', function close(ev) {
          if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close, true); }
        }, true);
      }, 0);
    }
    function supLink(label, href) {
      var a = document.createElement('a');
      a.className = 'asga-suplink'; a.textContent = label; a.href = href; a.target = '_blank'; a.rel = 'noopener';
      a.addEventListener('click', function (e) { e.stopPropagation(); });
      return a;
    }

    function makeTile(a) {
      var tile = document.createElement('div');
      tile.className = 'asga-tile';
      tile.setAttribute('data-apppath', a.p);
      tile.setAttribute('data-appname', a.n);
      if (a.pr) tile.setAttribute('data-project', a.pr);
      if (a.su) tile.setAttribute('data-support', a.su);
      tile.title = a.n;

      // header: icon + name/author/category
      var head = document.createElement('div');
      head.className = 'asga-tile-head';

      var iconWrap = document.createElement('div');
      iconWrap.className = 'asga-tile-icon';
      var img = document.createElement('img');
      var fallback = '/plugins/dynamix.docker.manager/images/question.png';
      img.src = a.ic || fallback; img.loading = 'lazy'; img.alt = '';
      img.onerror = function () { if (this.src.indexOf('question.png') < 0) this.src = fallback; };
      iconWrap.appendChild(img);
      if (a.s != null) {
        var badge = document.createElement('span');
        badge.className = 'ghstars-badge';
        badge.textContent = '★ ' + fmt(a.s);
        badge.title = a.s + ' GitHub stars';
        iconWrap.appendChild(badge);
      }
      if (a.dl > 0) {
        var dlb = document.createElement('span');
        dlb.className = 'ghdl-badge';
        dlb.textContent = '⤓ ' + fmt(a.dl);
        dlb.title = a.dl.toLocaleString() + ' Unraid downloads';
        iconWrap.appendChild(dlb);
      }
      head.appendChild(iconWrap);

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
      if (a.ct) {
        var cat = document.createElement('div');
        cat.className = 'asga-tile-cat';
        cat.textContent = a.ct;
        htext.appendChild(cat);
      }
      head.appendChild(htext);
      tile.appendChild(head);

      // description (verbiage)
      if (a.de) {
        var desc = document.createElement('div');
        desc.className = 'asga-tile-desc';
        desc.textContent = a.de;
        tile.appendChild(desc);
      }

      // Info / Support / Install buttons
      var btns = document.createElement('div');
      btns.className = 'asga-tile-btns';
      btns.appendChild(mkBtn('Info', 'asga-info'));
      if (a.pr || a.su) btns.appendChild(mkBtn('Support', 'asga-support'));
      btns.appendChild(mkBtn('Install', 'asga-install'));
      tile.appendChild(btns);
      return tile;
    }
    function mkBtn(label, cls) {
      var b = document.createElement('span');
      b.className = 'asga-btn ' + cls;
      b.textContent = label;
      return b;
    }

    function render() {
      if (!isOn()) return;
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
      var frag = document.createDocumentFragment();
      for (var i = 0; i < pageItems.length; i++) frag.appendChild(makeTile(pageItems[i]));
      grid.appendChild(frag);

      var from = total ? start + 1 : 0, to = Math.min(start + view.perPage, total);
      document.getElementById('asga-count').textContent =
        'Showing ' + from + '–' + to + ' of ' + total + ' apps' + (view.cat ? ' in ' + view.catLabel : '') + (view.q ? ' matching "' + view.q + '"' : '');
      renderPager(pages);
      try { window.scrollTo(0, 0); } catch (e) {}
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
        '<label class="asga-toggle" title="Toggle between the GitHub view and the stock Community Applications view">' +
          '<input type="checkbox" id="asga-toggle-cb"><span class="asga-toggle-track"><span class="asga-toggle-knob"></span></span>' +
          '<span class="asga-toggle-lbl">GitHub view</span>' +
        '</label>' +
        '<span class="asga-sortwrap"><span class="asga-bar-label">Sort By:</span>' +
        '<select id="asga-sortsel" class="asga-sortsel">' + opts + '</select>' +
        '<a id="asga-refresh" class="asga-refreshlink" title="Fetch the latest GitHub data (once every 3 days)">↻</a></span>';
      host.appendChild(bar);
      var sel = document.getElementById('asga-sortsel');
      sel.value = view.sort;
      sel.addEventListener('change', function (e) { view.sort = e.target.value; view.page = 1; render(); });
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
      var on = isOn();
      document.body.classList.toggle('asga-active', on);   // CSS hides CA's grid only when on
      var v = document.getElementById('asga-view'); if (v) v.style.display = on ? '' : 'none';
      var sw = document.querySelector('.asga-sortwrap'); if (sw) sw.style.display = on ? '' : 'none';
      var cb = document.getElementById('asga-toggle-cb'); if (cb) cb.checked = on;
    }

    // filter as the user types in CA's own search box (CA's hidden results are ignored)
    function wireSearch() {
      var box = document.getElementById('searchBox');
      if (!box || box.__asgaWired) return;
      box.__asgaWired = true;
      var deb;
      box.addEventListener('input', function () {
        clearTimeout(deb);
        deb = setTimeout(function () { view.q = box.value || ''; view.page = 1; render(); }, 120);
      });
    }

    // left-menu category clicks filter our grid (capture phase, we don't stop CA)
    function wireCategories() {
      if (document.body.__asgaCatWired) return;
      document.body.__asgaCatWired = true;
      document.addEventListener('click', function (e) {
        var item = e.target.closest ? e.target.closest('.caMenuItem[data-category]') : null;
        if (!item) return;
        var cat = item.getAttribute('data-category') || '';
        var label = (item.textContent || '').trim();
        // CA's "All"/"New"/startup screens mean "no category filter" for us
        if (cat === 'All' || cat === 'New' || cat === '' || item.classList.contains('allApps')) { view.cat = ''; view.catLabel = 'All Apps'; }
        else if (/^(onlynew|spotlight|top_trending|installed|previous_apps|prev_docker|prev_plugins|pinned_apps|action_centre|repos)$/.test(cat)) { return; } // leave CA's special views alone
        else { view.cat = cat; view.catLabel = label || cat; }
        view.q = ''; var box = document.getElementById('searchBox'); if (box) box.value = '';
        view.page = 1;
        setTimeout(render, 0);
      }, true);
    }

    // ---- no-token warning ----
    function showWarningIfNeeded() {
      var cfg = window.__appStoreGhAddon || {};
      if (cfg.hasToken) return;
      if (document.querySelector('.ghstars-warning')) return;
      var main = document.querySelector('.mainArea');
      if (!main) return;
      var w = document.createElement('div');
      w.className = 'ghstars-warning';
      var msg = document.createElement('span');
      msg.innerHTML = '⚠ <b>App Store GitHub Addon:</b> no GitHub personal access token configured, so ' +
        'star counts are disabled. Add a token in <a href="' + (cfg.settingsUrl || '/Settings') +
        '">Settings → App Store GitHub Addon</a>.';
      var x = document.createElement('span');
      x.className = 'ghstars-warning-x'; x.title = 'Dismiss'; x.textContent = '✕';
      x.addEventListener('click', function () { w.parentNode && w.parentNode.removeChild(w); });
      w.appendChild(msg); w.appendChild(x);
      main.insertBefore(w, main.firstChild);
    }

    // ---- refresh + progress (thin top bar) ----
    function onRefreshClick(e) {
      if (e) e.stopPropagation();
      if (!window.confirm('Fetch the latest GitHub star data now? Allowed once every 3 days.')) return;
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
            bar.querySelector('.ghstars-topbar-label').textContent = 'Pulling GitHub stars… ' + (p.total > 0 ? (p.done + '/' + p.total) : 'starting…');
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
    function attachUI() {
      addSortBar();
      wireSearch();
      wireCategories();
      showWarningIfNeeded();
      applyViewMode();
      if (isOn() && !document.getElementById('asga-view')) render();
    }

    function start() {
      triggerNewScan();
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
