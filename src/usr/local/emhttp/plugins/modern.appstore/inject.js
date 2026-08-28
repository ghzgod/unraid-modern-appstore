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
    // the configured opening sort, overwritten once applist.php answers with the
    // server's real value; 'new' is only what's used before that response lands
    // or if the config on disk can't be read
    var defaultSort = 'new';
    // initSort() must run exactly once per page load (see its own comment); this
    // is the guard, since loadApps() itself refires several times after start()
    var sortInited = false;
    var polling = false, wasRunning = false;
    var pageItemsNow = [];        // apps the grid is currently showing
    var scanAsked = {};           // path -> 1, so a page is only auto-scanned once
    var scanInFlight = false, scanPending = false, scanTimer = null;
    var pinnedSet = null, installedSet = null;
    // how many days of the plugin's own star-history snapshots this install
    // has. The year trending windows are built from this now, since GitHub
    // restricted the endpoints that used to backfill a year-ago baseline
    var historyDays = 0;
    // CA's docker availability, as applist.php reports it. Docker being down
    // does NOT empty the store: CA still lists everything and still installs
    // plugins, it only blocks docker installs and says why. The modern view is
    // a re-skin of CA's own catalog, so it behaves identically.
    var docker = { running: true, reason: 0, warn: false };
    var DOCKER_MSG = {
      1: 'Docker Service Not Enabled',
      2: 'Docker system failed to start',
      3: 'Array not started'
    };
    // CA's app catalog lives in /tmp, so it is gone after every boot until CA's
    // own page has re-downloaded the feed. Our grid loads first, and used to
    // paint "No apps to show" and stay that way until a manual reload.
    var feedReady = true, feedWaits = 0;
    var stamps = { feed: 0, scan: 0 };   // unix times: CA feed sync, last star scan
    var FEED_POLL_MS = 3000, FEED_MAX_WAITS = 100;   // give up after ~5 minutes
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

    // Every trending sort ranks by GitHub stars; they differ only in the window.
    // Day/week/month/year all come from the plugin's own daily star snapshots
    // in star_history now: GitHub restricted the stargazers-listing endpoints
    // to admins and collaborators in July 2026, so there is no longer any way
    // to backfill a year-ago baseline for a fresh install. The year windows
    // (t365) just take as long to fill in as any other window would, 365 days
    // of the plugin's own recorded history.
    // All time is the repo's whole life: every star it has ever gained, and for
    // the percentage variant the lifetime rate, since dividing by the star count
    // at a repo's birth would be dividing by zero.
    // Trending sorts also FILTER to apps that actually moved in that window, so
    // the view is a real "what's hot" list, not the whole catalog with a few
    // movers on top and everything else in feed order.
    // GitHub's own 16x16 mark, inlined so it draws in currentColor and follows
    // the menu header's muted text on the dark and light themes alike.
    var GH_MARK = '<svg class="asga-gh-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
    // Unraid's own mark (the nine bars from its logo), inlined the same way so
    // it too draws in currentColor and reads correctly on both themes.
    var UN_MARK = '<svg class="asga-un-mark" viewBox="0 0 133.52 76.97" aria-hidden="true"><path d="M0 19.24h6.54v38.49H0zM15.87 45.84h6.54v23.78h-6.54zM31.74 62.27h6.55v14.73h-6.55zM47.62 45.84h6.54v23.78h-6.54zM63.49 19.24h6.51v38.49h-6.51zM79.36 7.35h6.54v23.79h-6.54zM95.23 0h6.54v14.7h-6.54zM111.1 7.35h6.55v23.79h-6.55zM127 19.24h6.52v38.49H127z"/></svg>';
    // Three tiers, top to bottom. The two name orders are global, belonging to
    // neither data source, so they carry no group heading and sit above every
    // section. Everything else is grouped by the source its numbers actually
    // come from (Unraid's own feed, or GitHub), and that source is named once,
    // in the heading, so no label underneath repeats it.
    var SORT_OPTS = [
      { g: '', v: 'name_asc',  label: 'Name (A to Z)', cmp: function (a, b) { return a.sn < b.sn ? -1 : a.sn > b.sn ? 1 : 0; } },
      { g: '', v: 'name_desc', label: 'Name (Z to A)', cmp: function (a, b) { return a.sn < b.sn ? 1 : a.sn > b.sn ? -1 : 0; } },
      { g: 'Unraid', m: 'un', v: 'downloads', label: 'Most Downloaded', cmp: numDesc('dl') },
      { g: 'Unraid', m: 'un', v: 'new',       label: 'Recently Added',  cmp: numDesc('fs') },
      { g: 'Unraid', m: 'un', v: 'updated',   label: 'Recently Updated', cmp: numDesc('lu'), hint: 'Latest app update first; apps with no update date in the feed sort last' },
      // These four mirror Community Applications' own homepage sections
      // (appOfDay() and mySort() in its include/exec.php and include/helpers.php),
      // so the numbers behind them come straight from CA's own feed, never from
      // GitHub. The thresholds each one filters on are CA's own, and since this
      // menu is the only place they show up, they are spelled out in the hints.
      { g: 'Unraid', m: 'un', v: 'spotlight',   label: 'Spotlight',            cmp: numDesc('rd'), filter: hasSpotlight,             hint: 'Apps recommended by the Unraid team, most recently featured first' },
      { g: 'Unraid', m: 'un', v: 'trending',    label: 'Top Trending',         cmp: numDesc('td'), filter: caTrend('td', 3, 10000, false),  hint: 'Up and coming apps: the biggest week-on-week jump in install rate, over apps with 3+ weeks of data and 10,000+ installs' },
      { g: 'Unraid', m: 'un', v: 'newinstalls', label: 'Top New Installs',     cmp: numDesc('dt'), filter: caTrend('dt', 6, 100000, true),  hint: 'The highest percentage of new installs this week, over apps with 6+ weeks of data and 100,000+ installs' },
      { g: 'Unraid', m: 'un', v: 'popplugins',  label: 'Most Popular Plugins', cmp: numDesc('dl'), filter: isCountedPlugin,          hint: 'Plugins only, ranked by Unraid downloads; plugins with no download count are left out' },
      { g: 'GitHub', m: 'gh', v: 'ghstars', label: 'Most Stars',              cmp: numDesc('s') },
      { g: 'GitHub', m: 'gh', v: 'ght1',    label: 'Most Stars Gained (today)',        cmp: numDesc('t1'),   filter: hasTrend('t1'),   hint: 'Most stars added today, whatever the size of the repo' },
      { g: 'GitHub', m: 'gh', v: 'ght7',    label: 'Most Stars Gained (this week)',    cmp: numDesc('t7'),   filter: hasTrend('t7'),   hint: 'Most stars added this week, whatever the size of the repo' },
      { g: 'GitHub', m: 'gh', v: 'ght30',   label: 'Most Stars Gained (this month)',   cmp: numDesc('t30'),  filter: hasTrend('t30'),  hint: 'Most stars added this month, whatever the size of the repo' },
      { g: 'GitHub', m: 'gh', v: 'ght365',  label: 'Most Stars Gained (this year)',    cmp: numDesc('t365'), filter: hasTrend('t365'), hint: 'Most stars added this year, whatever the size of the repo' },
      { g: 'GitHub', m: 'gh', v: 'ghp1',    label: 'Fastest Growing (today)',      cmp: pctDesc('t1'),   filter: hasPct('t1'),   hint: 'Biggest growth today measured against the stars a repo already had, so a small project can beat a large one' },
      { g: 'GitHub', m: 'gh', v: 'ghp7',    label: 'Fastest Growing (this week)',  cmp: pctDesc('t7'),   filter: hasPct('t7'),   hint: 'Biggest growth this week measured against the stars a repo already had, so a small project can beat a large one' },
      { g: 'GitHub', m: 'gh', v: 'ghp30',   label: 'Fastest Growing (this month)', cmp: pctDesc('t30'),  filter: hasPct('t30'),  hint: 'Biggest growth this month measured against the stars a repo already had, so a small project can beat a large one' },
      { g: 'GitHub', m: 'gh', v: 'ghp365',  label: 'Fastest Growing (this year)',  cmp: pctDesc('t365'), filter: hasPct('t365'), hint: 'Biggest growth this year measured against the stars a repo already had, so a small project can beat a large one' },
      { g: 'GitHub', m: 'gh', v: 'ghpall',  label: 'Fastest Growing (all time)',   cmp: rateDesc,        filter: hasRate,        hint: 'Lifetime growth rate: stars per year since the repo was created' }
    ];
    function optFor(v) { for (var i = 0; i < SORT_OPTS.length; i++) if (SORT_OPTS[i].v === v) return SORT_OPTS[i]; return SORT_OPTS[0]; }
    // numeric descending; null/undefined sinks to the bottom
    function numDesc(k) { return function (a, b) { var x = a[k], y = b[k]; if (x == null) x = -Infinity; if (y == null) y = -Infinity; return y - x; }; }
    // relative growth: window delta / stars at window start, 10-star floor so
    // tiny repos (2->4 = +100%) don't dominate. Mirrors the old server logic.
    function pct(a, k) { var d = a[k]; if (d == null || a.s == null) return -Infinity; var base = a.s - d; if (base < 10) return -Infinity; return d / base; }
    function pctDesc(k) { return function (a, b) { return pct(b, k) - pct(a, k); }; }
    // All-time rate: total stars over the repo's age in years. A repo has zero
    // stars at birth, so the percentage form used by the other windows would
    // divide by zero; the lifetime average is the meaningful all-time ranking.
    // The 3-month age floor stops a repo published last week from posting an
    // extrapolated rate in the tens of thousands.
    var YEAR_MS = 365.25 * 24 * 3600 * 1000;
    function rate(a) {
      if (a.s == null || a.s < 10 || !a.ca) return -Infinity;
      var yrs = (Date.now() - a.ca * 1000) / YEAR_MS;
      return a.s / Math.max(0.25, yrs);
    }
    function rateDesc(a, b) { return rate(b) - rate(a); }
    // trending filters: only apps that actually gained stars in the window
    function hasTrend(k) { return function (a) { return a[k] != null && a[k] > 0; }; }
    function hasPct(k) { return function (a) { return pct(a, k) > 0; }; }
    function hasStars(a) { return a.s != null && a.s > 0; }
    function hasRate(a) { return rate(a) > 0; }
    // Spotlight: CA's RecommendedDate, 0 meaning the app was never recommended
    function hasSpotlight(a) { return a.rd > 0; }
    // ich777/steamcmd backs dozens of unrelated game-server apps under one
    // shared image, so without this exclusion both trending sorts would fill
    // up with near-identical numbers instead of reading as "what's hot".
    function isSharedSteamImage(a) { return (a.ri || '').indexOf('ich777/steamcmd') === 0; }
    // Shared by Top Trending and Top New Installs: both need a run of weekly
    // samples and a download floor before a trending number means anything,
    // and both skip the shared SteamCMD image for the reason above. key is the
    // field each list actually ranks by, and it has to be present: the feed
    // carries a trending figure for 41 apps that have no trendDelta yet, and
    // without this they would pass the filter only to sink to the bottom of the
    // list, padding the count with apps that hold no position in it. nonZero is
    // set for New Installs, since CA defines that list as apps still actually
    // gaining installs, not merely ones it happens to have a reading for.
    function caTrend(key, minSamples, minDownloads, nonZero) {
      return function (a) {
        if (a.tc == null || a.tc < minSamples) return false;
        if (!(a.dl > minDownloads)) return false;
        if (a[key] == null) return false;
        if (nonZero && a[key] === 0) return false;
        return !isSharedSteamImage(a);
      };
    }
    // Most Popular Plugins: plugins only, and only ones the feed has a real
    // download count for
    function isCountedPlugin(a) { return a.ty === 'plugin' && a.dl > 0; }

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
        .then(function (j) {
          APPS = dedupe((j && j.apps) || []);
          if (j && j.historyDays != null) historyDays = j.historyDays;
          if (j && j.docker) docker = j.docker;
          // same validity test optFor() already backs the saved-sort read with,
          // so a config value the grid doesn't recognise is silently ignored
          // rather than handed straight to view.sort
          if (j && j.defaultSort && optFor(j.defaultSort).v === j.defaultSort) defaultSort = j.defaultSort;
          if (j) { stamps.feed = j.feedAt || 0; stamps.scan = j.scanAt || 0; updateStamp(); }
          // no answer at all counts as not ready, so a failed request retries
          // rather than freezing the grid on an empty catalog
          feedReady = !!j && j.feedReady !== false;
          cb && cb();
        })
        .catch(function () { APPS = APPS || []; feedReady = false; cb && cb(); });
    }
    // Poll until CA has written its catalog, then paint. Only the wait is new;
    // the grid renders from the same endpoint either way.
    function waitForFeed() {
      if (feedReady || feedWaits >= FEED_MAX_WAITS) return;
      feedWaits++;
      setTimeout(function () { loadApps(function () { render(); waitForFeed(); }); }, FEED_POLL_MS);
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

    // ---- sort persistence: remember the last sort, but reset to the
    // configured default if it has been more than 20 minutes since the Apps
    // page was last opened. Guarded to run once: loadApps() (which this relies
    // on for defaultSort) refires from waitForFeed(), a completed page scan and
    // pollProgress(), and running this again on any of those would yank the
    // sort out from under someone already mid-browse. ----
    function initSort() {
      if (sortInited) return;
      sortInited = true;
      try {
        var ts = parseInt(localStorage.getItem('asga_visit_ts') || '0', 10);
        var saved = localStorage.getItem('asga_sort');
        if (saved && optFor(saved).v === saved && (Date.now() - ts) < 20 * 60 * 1000) view.sort = saved;
        else view.sort = defaultSort;
        localStorage.setItem('asga_visit_ts', '' + Date.now());
      } catch (e) {}
    }
    function saveSort() { try { localStorage.setItem('asga_sort', view.sort); localStorage.setItem('asga_visit_ts', '' + Date.now()); } catch (e) {} }

    // ---- filtering + sorting ----
    function catMatch(a, cat) {
      if (!cat) return true;
      // Matched against cf, CA's raw category list, and never against the ct we
      // print on the tile. ct has had its colons stripped and everything after
      // its first category thrown away, so it cannot match a menu key like
      // "Network:" or "Network:Management" - the key always carries a colon and
      // ct never does, so every category click filtered the grid to nothing.
      // Against cf this substring test is CA's own /category/i filter, down to
      // a parent like "MediaApp:" picking up every "MediaApp:Video" app. ct
      // stays as the fallback so a cached payload from before cf existed
      // degrades to the old behaviour instead of matching nothing at all.
      var c = (a.cf || a.ct || '').toLowerCase();
      cat = cat.toLowerCase();
      return c === cat || c.indexOf(cat) >= 0;
    }
    // Community Applications matches a query against a wide set of fields: the
    // app's name, its author and repository, its categories, its FULL
    // description, and the hidden ExtraSearchTerms many templates carry. This
    // grid matched the name, category and repository alone, so a word like
    // "emulator" came back empty here while CA found dozens of apps that only
    // carry it mid-blurb. applist.php hands us that unshown text as sx. The
    // haystack is joined once per app and kept on the record.
    function haystack(a) {
      if (a.__hay === undefined) {
        a.__hay = [a.n, a.sn, a.au, a.rp, a.ri, a.ct, a.de, a.sx].join(' ').toLowerCase();
      }
      return a.__hay;
    }
    // CA's filterMatch(): every word of the query has to turn up somewhere, but
    // any field will do, so "linuxserver plex" can match on two of them.
    function qMatch(a, words) {
      var h = haystack(a);
      for (var i = 0; i < words.length; i++) if (h.indexOf(words[i]) < 0) return false;
      return true;
    }
    // CA lists apps whose name matches above ones that only mention the word in
    // their blurb, and so does this: a search for "plex" should not bury Plex
    // under everything that talks about it. The chosen sort still orders within
    // each of the two groups.
    function nameMatch(a, words) {
      var h = ((a.n || '') + ' ' + (a.sn || '') + ' ' + (a.au || '') + ' ' + (a.rp || '')).toLowerCase();
      for (var i = 0; i < words.length; i++) if (h.indexOf(words[i]) < 0) return false;
      return true;
    }
    function currentList() {
      var words = view.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
      var opt = optFor(view.sort);
      var list = APPS.filter(function (a) {
        if (view.special === 'pinned') { if (!pinnedSet || !pinnedSet.has((a.ri || '') + '&' + (a.pn || ''))) return false; }
        else if (view.special === 'installed') { if (!installedSet || !installedSet.has(stripTag(a.ri))) return false; }
        if (opt.filter && !opt.filter(a)) return false;   // e.g. trending: only movers
        if (!catMatch(a, view.cat)) return false;
        if (words.length && !qMatch(a, words)) return false;
        return true;
      });
      list.sort(opt.cmp);
      if (words.length) {
        var named = [], other = [];
        for (var i = 0; i < list.length; i++) (nameMatch(list[i], words) ? named : other).push(list[i]);
        list = named.concat(other);
      }
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
      wrap.innerHTML = '<div id="asga-dockerwarn" class="asga-dockerwarn" style="display:none"></div>' +
        '<div id="asga-count" class="asga-count"></div>' +
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
    // CA renders an app's Overview by turning newlines into <br> and leading
    // indentation into &nbsp; runs. Templates are authored in a plain-text
    // editor, so many of them carry hard-wrapped prose: a break mid-sentence
    // every 80-odd characters, each followed by four spaces of indent. Poured
    // into a drawer of a different width that reads as ragged, indented
    // nonsense rather than paragraphs.
    //
    // This is the one place the modern view rewrites CA's markup rather than
    // only restyling it, because the damage is in the markup: &nbsp; is a real
    // character and a <br> is a real element, so no stylesheet can undo either.
    // It is confined to the description block, it runs only in modern view, and
    // it touches nothing CA reads back.
    //
    // A lone break inside a long line is a hard wrap and becomes a space. A run
    // of two or more breaks is the author separating paragraphs and is left
    // alone. A lone break after a SHORT line is left alone too, because that is
    // how a template writes a list ("Port: 8080" on its own line), and joining
    // those would be the same vandalism in the other direction.
    var WRAP_MIN = 60;
    function wireDescriptionTidy() {
      if (document.body.__asgaDescTidy) return;
      document.body.__asgaDescTidy = true;
      var host = document.getElementById('sidenavContent') || document.querySelector('.sidenav');
      if (!host) return;
      // our own edits re-enter this, but the per-element guard makes that a
      // no-op, and CA hands us a fresh element for every app it opens
      new MutationObserver(tidyDescription).observe(host, { childList: true, subtree: true });
      tidyDescription();
    }
    function tidyDescription() {
      if (!isOn()) return;
      var el = document.querySelector('#sidenavContent .popupDescription');
      if (!el || el.__asgaTidied) return;
      el.__asgaTidied = true;
      // the indent first: &nbsp; does not collapse the way a space does, so it
      // has to become one before the lines are joined
      var walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walk.nextNode())) {
        if (node.nodeValue.indexOf(' ') !== -1) node.nodeValue = node.nodeValue.replace(/ +/g, ' ');
      }
      var brs = [].slice.call(el.querySelectorAll('br'));
      for (var i = 0; i < brs.length; i++) {
        var br = brs[i];
        if (!br.parentNode) continue;
        if (isBr(meaningBefore(br)) || isBr(meaningAfter(br))) continue;   // paragraph break
        if (lineBefore(br).length < WRAP_MIN) continue;                    // deliberate short line
        br.parentNode.replaceChild(document.createTextNode(' '), br);
      }
    }
    function isBr(n) { return !!n && n.nodeName === 'BR'; }
    function blankText(n) { return n && n.nodeType === 3 && !/[^\s ]/.test(n.nodeValue); }
    function meaningBefore(n) { n = n.previousSibling; while (blankText(n)) n = n.previousSibling; return n; }
    function meaningAfter(n) { n = n.nextSibling; while (blankText(n)) n = n.nextSibling; return n; }
    // the text of the line this break ends, back to the previous break. Reading
    // it after earlier joins is intended: once a paragraph starts being rebuilt
    // its later wraps look long too, which is exactly when they should join.
    function lineBefore(br) {
      var s = '', n = br.previousSibling;
      while (n && n.nodeName !== 'BR') { s = (n.textContent || '') + s; n = n.previousSibling; }
      return s.replace(/\s+/g, ' ').trim();
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

    // The modern view's own replacement for CA's Attention confirm (its
    // popupInstallXML), shown before an install when the template carries extra
    // requirements, a moderator note, or a port that is already taken. text is
    // rendered as plain lines, never HTML, since it comes from a third-party
    // template.
    function attentionModal(text, onOk) {
      var ov = document.createElement('div');
      ov.className = 'asga-modal-ov';

      var modal = document.createElement('div');
      modal.className = 'asga-modal';

      var icon = document.createElement('div');
      icon.className = 'asga-modal-icon';
      icon.textContent = '!';
      modal.appendChild(icon);

      var title = document.createElement('h2');
      title.className = 'asga-modal-title';
      title.textContent = 'Attention';
      modal.appendChild(title);

      var body = document.createElement('div');
      body.className = 'asga-modal-body';
      // A blank line separates one notice from the next (the requirements text
      // from the port warning, say). Dropping it would leave both reading as one
      // run of prose, so it is carried across as extra space above the paragraph
      // that followed it rather than as an empty paragraph.
      var gap = false;
      String(text).split('\n').forEach(function (line) {
        if (!line.trim()) { gap = true; return; }
        var p = document.createElement('p');
        if (gap && body.firstChild) p.className = 'asga-modal-break';
        gap = false;
        p.textContent = line;
        body.appendChild(p);
      });
      modal.appendChild(body);

      var actions = document.createElement('div');
      actions.className = 'asga-modal-actions';
      var okBtn = document.createElement('button');
      okBtn.className = 'asga-btn asga-modal-ok';
      okBtn.textContent = 'OK';
      var cancelBtn = document.createElement('button');
      cancelBtn.className = 'asga-btn asga-modal-cancel';
      cancelBtn.textContent = 'Cancel';
      actions.appendChild(okBtn);
      actions.appendChild(cancelBtn);
      modal.appendChild(actions);

      ov.appendChild(modal);

      var close = function () { ov.remove(); document.removeEventListener('keydown', key, true); };
      var key = function (ev) { if (ev.key === 'Escape') close(); };
      okBtn.addEventListener('click', function () { close(); onOk(); });
      cancelBtn.addEventListener('click', close);
      ov.addEventListener('click', function (ev) { if (ev.target === ov) close(); });
      document.addEventListener('keydown', key, true);

      document.body.appendChild(ov);
      // preventScroll: on a short window the overlay scrolls, and focusing OK
      // would open the dialog already scrolled past the text it is asking about.
      try { okBtn.focus({ preventScroll: true }); } catch (e) { okBtn.focus(); }
    }

    // CA never opens the template editor directly: it POSTs createXML first, which
    // rewrites the template for THIS server (br0/eth0 fallback, missing-disk path
    // remapping, themed icon) before the editor reads it. Skipping that step, and
    // percent-encoding the path CA passes raw, is why the modern grid's Install
    // used to land on an editor that could not build the container.
    function createAndOpen(p) {
      if (typeof window.post === 'function') {
        window.post({ action: 'createXML', xml: p, type: 'default' }, function (r) {
          if (r && r.status === 'ok') openTemplate(p);
          else attentionModal((r && r.error) || 'The template could not be prepared for install.', function () {});
        });
        return;
      }
      fetch('/plugins/community.applications/include/exec.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'action=createXML&type=default&xml=' + encodeURIComponent(p),
        credentials: 'same-origin'
      }).then(function (r) { return r.json(); }).then(function (r) {
        if (r && r.status === 'ok') openTemplate(p);
      }).catch(function () {});
    }

    function openTemplate(p) {
      try { window.open('/Apps/AddContainer?xmlTemplate=default:' + p, '_blank', 'noopener'); } catch (e) {}
    }

    // Install in a NEW tab. Docker apps run CA's createXML step (see
    // createAndOpen) then open its template editor at /Apps/AddContainer;
    // plugins open CA's plugin-install page. Same targets CA uses, just forced
    // into a new tab.
    function installApp(tile) {
      var p = tile.getAttribute('data-apppath'), ty = tile.getAttribute('data-type'), pu = tile.getAttribute('data-plugurl');
      if (ty === 'plugin') {
        // plugins: let CA drive its own plugin install (its flow differs from docker)
        try { window.showSidebarApp(p, tile.getAttribute('data-appname')); } catch (e) {}
        return;
      }
      if (!docker.running) return;   // nothing to install into; the card says why

      var notice = tile.getAttribute('data-requires') || '';
      var ports = (tile.getAttribute('data-ports') || '').split(',').filter(function (x) { return x !== ''; });
      if (ports.length && Array.isArray(window.portsInUse)) {
        var inUse = window.portsInUse.map(String);
        var collides = ports.some(function (port) { return inUse.indexOf(String(port)) !== -1; });
        if (collides) {
          var warn = 'One or more ports used by this application are already in use by another service or app running on your server. You will need to adjust the host ports accordingly on the template.';
          notice = notice ? (notice + '\n\n' + warn) : warn;
        }
      }

      if (notice) {
        attentionModal(notice, function () { createAndOpen(p); });
      } else {
        createAndOpen(p);
      }
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
      if (a.rq) tile.setAttribute('data-requires', a.rq);
      if (a.po && a.po.length) tile.setAttribute('data-ports', a.po.join(','));
      tile.title = a.n;

      // header: icon + name/author/category
      var head = document.createElement('div');
      head.className = 'asga-tile-head';

      var iconWrap = document.createElement('div');
      iconWrap.className = 'asga-tile-icon';
      var img = document.createElement('img');
      var fallback = '/plugins/dynamix.docker.manager/images/question.png';
      // owner for the avatar fallback: the starred repo when one was matched,
      // else the app's own GitHub links. Plugins carry no docker repository to
      // derive an owner from, so their Project or plugin URL is read instead;
      // before this they always fell through to the question mark.
      var ghOwner = (a.rp && a.rp.indexOf('/') > 0) ? a.rp.split('/')[0] : '';
      if (!ghOwner) {
        var gm = /(?:github\.com|raw\.githubusercontent\.com)\/([^\/?#]+)\//i.exec(a.pr || '') ||
                 /(?:github\.com|raw\.githubusercontent\.com)\/([^\/?#]+)\//i.exec(a.pu || '');
        if (gm) ghOwner = gm[1];
      }
      var ghAvatar = ghOwner ? ('https://github.com/' + ghOwner + '.png?size=128') : '';
      img.src = a.ic || ghAvatar || fallback; img.loading = 'lazy'; img.alt = '';
      img.onerror = function () {
        if (ghAvatar && this.src !== ghAvatar && this.src.indexOf('github.com') < 0) { this.src = ghAvatar; return; }
        // github.com drops some of the avatar requests a full screen of cards
        // fires at once. Without a retry that transient miss became a permanent
        // question mark, on a card whose icon works perfectly on reload.
        if (ghAvatar && this.src.indexOf('github.com') >= 0 && !this.dataset.avatarRetry) {
          this.dataset.avatarRetry = '1';
          var im = this;
          setTimeout(function () { im.src = ghAvatar + '&retry=1'; }, 1200);
          return;
        }
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
        // plugins now carry a real download count of their own, and "Docker
        // image pulls" is simply the wrong noun for something that was never
        // pulled from a registry
        dlb.title = a.dl.toLocaleString() + (a.ty === 'plugin' ? ' Unraid servers have installed this plugin' : ' Docker image pulls');
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

      // Why Install is off, in the flowing part of the card. It has to sit
      // ABOVE the button row: that row carries margin-top:auto and is what
      // bottom-aligns every card, so a line placed after it would push the
      // buttons up on blocked cards only and leave the row ragged.
      if (blocked(a)) {
        tile.classList.add('asga-tile-blocked');
        var note = document.createElement('div');
        note.className = 'asga-tile-blocked-note';
        note.textContent = (DOCKER_MSG[docker.reason] || 'Docker not available') + ', install unavailable';
        tile.appendChild(note);
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
      var ib = mkBtn('Install', 'asga-install');
      // Docker down: the card still lists the app and still opens its Info
      // drawer, only Install is off, exactly as CA behaves.
      if (blocked(a)) {
        ib.classList.add('asga-btn-off');
        ib.title = (DOCKER_MSG[docker.reason] || 'Docker is not available') + ', Docker apps cannot be installed';
      }
      btns.appendChild(ib);
      tile.appendChild(btns);

      // when CA's feed first saw this app, and when the app itself last shipped,
      // on one line at the foot of the card: Added at the left edge, Updated at
      // the right. Both halves are appended even when their date is unknown, so
      // the Updated column stays put on a card that knows only one of the two,
      // and so every button row in a grid row still bottom-aligns.
      var dates = document.createElement('div');
      dates.className = 'asga-tile-dates';
      var added = addedLabel(a.fs);
      var ad = document.createElement('div');
      ad.className = 'asga-tile-added';
      // The label is an interval for anything recent, so the exact date leads the
      // tooltip: hovering is the only way back to it.
      if (added) {
        ad.textContent = added;
        ad.title = absDate(a.fs, a.fs > 1433649600) + '\n'
                 + 'When the Community Applications feed first saw this app. Your server '
                 + 'only picks it up on its next feed refresh, so an app can appear here days later.';
      }
      dates.appendChild(ad);
      var updated = updatedLabel(a.lu, a.lk);
      var up = document.createElement('div');
      up.className = 'asga-tile-updated';
      if (updated) {
        up.textContent = updated;
        up.title = absDate(a.lu, a.lk === 'r') + '\n' + (a.lk === 'v'
          ? 'Release date of this plugin\'s current version, read from the version number itself.'
          : 'When this app\'s image was last published to its container registry.');
      }
      dates.appendChild(up);
      tile.appendChild(dates);
      return tile;
    }
    // The absolute form. CA's FirstSeen is a unix timestamp, and it floors
    // anything older than its own record-keeping to 1433000000 (Jun 2015); for
    // those the time of day is an artefact, so the caller asks for date only.
    function absDate(ts, withTime) {
      var d = new Date(ts * 1000);
      if (isNaN(d.getTime())) return '';
      var opts = { year: 'numeric', month: 'short', day: 'numeric' };
      if (withTime) { opts.hour = 'numeric'; opts.minute = '2-digit'; }
      try { return d.toLocaleString(undefined, opts); }
      catch (e) { return d.toDateString(); }
    }
    // A recent date reads better as an interval than as a timestamp: "3 hours
    // ago" places an app against now, where "Aug 6, 2026, 2:14 PM" has to be
    // worked out first. Past a month the interval stops helping ("94 days ago"
    // is worse than a date), so that is where this returns nothing and the
    // caller falls back to absDate.
    // dayOnly is for a value that was only ever a day, such as a plugin's
    // date-formed version number. Its clock reads midnight because that is what
    // a bare date parses to, not because anything happened then, so those never
    // report hours or minutes.
    var REL_MAX_AGE = 30 * 86400;
    function relDate(ts, dayOnly) {
      var now = Math.floor(Date.now() / 1000);
      var age = now - ts;
      // a feed clock running ahead of ours would otherwise read "-2 hours ago"
      if (age < 0 || age > REL_MAX_AGE) return '';
      if (!dayOnly) {
        if (age < 60) return 'just now';
        if (age < 3600) return countOf(Math.floor(age / 60), 'minute') + ' ago';
        if (age < 86400) return countOf(Math.floor(age / 3600), 'hour') + ' ago';
      }
      var days = dayGap(ts, now);
      if (days <= 0) return 'today';
      if (days === 1) return 'yesterday';
      return countOf(days, 'day') + ' ago';
    }
    function countOf(n, unit) { return n + ' ' + unit + (n === 1 ? '' : 's'); }
    // Calendar days apart rather than 24-hour blocks, so 11pm last night is
    // "yesterday" to someone reading at 1am, which is what they would call it.
    function dayGap(ts, now) {
      var a = new Date(ts * 1000), b = new Date(now * 1000);
      a.setHours(0, 0, 0, 0);
      b.setHours(0, 0, 0, 0);
      return Math.round((b - a) / 86400000);
    }
    function addedLabel(fs) {
      if (!fs) return '';
      var abs = absDate(fs, fs > 1433649600);
      return abs ? 'Added ' + (relDate(fs, false) || abs) : '';
    }
    // A registry push has a real time of day and is shown with one. A plugin's
    // date-formed version carries no time, so that variant stops at the day
    // rather than inventing midnight.
    function updatedLabel(lu, lk) {
      if (!lu) return '';
      var abs = absDate(lu, lk === 'r');
      return abs ? 'Updated ' + (relDate(lu, lk !== 'r') || abs) : '';
    }
    function mkBtn(label, cls) {
      var b = document.createElement('span');
      b.className = 'asga-btn ' + cls;
      b.textContent = label;
      return b;
    }

    // A trending sort filters to apps that moved in its window, so an empty grid
    // is ambiguous: nothing moved, or the data for that window was never
    // gathered. The year windows are the ones that can genuinely be unavailable:
    // GitHub restricted the stargazers-listing endpoints in July 2026, so their
    // only remaining source is the plugin's own recorded star history, and this
    // says exactly how much of that this install has instead of leaving a blank
    // page.
    function emptySortNote() {
      if (view.sort !== 'ght365' && view.sort !== 'ghp365') return '';
      var need = 365 - historyDays;
      var when = '';
      if (historyDays > 0 && need > 0) {
        var target = new Date(Date.now() + need * 86400000);
        var stamp;
        try { stamp = target.toLocaleString(undefined, { month: 'long', year: 'numeric' }); }
        catch (e) { stamp = target.toDateString(); }
        when = ', filling in around ' + stamp;
      }
      return 'The "this year" windows are built from the plugin\'s own recorded star history, not from GitHub. ' +
             'This install has ' + historyDays + ' of the 365 days it needs' + when + '.';
    }

    // The catalog is CA's file in /tmp, rebuilt by CA's own Apps page after a
    // boot. Until it lands there is nothing to show and nothing wrong, so say
    // that rather than "No apps to show", which reads like an empty store.
    function feedWaitNote() {
      if (feedWaits >= FEED_MAX_WAITS) {
        return 'Community Applications has not published its app catalog yet. Reload this page, ' +
               'or turn Modern view off once to let Community Applications download the feed.';
      }
      return 'Waiting for Community Applications to download the app catalog. ' +
             'It is rebuilt after every reboot, and this grid fills in as soon as it lands.';
    }

    // Same message CA puts in its page banner, restated inside the grid. CA's
    // banner is dismissible and stays dismissed for a month by cookie, so the
    // modern view says it itself rather than relying on a banner that may not
    // be there. Plugins remain fully installable, which is the point of it.
    function renderDockerNotice() {
      var el = document.getElementById('asga-dockerwarn');
      if (!el) return;
      if (docker.running || !docker.warn) { el.style.display = 'none'; el.textContent = ''; return; }
      el.textContent = '⚠ ' + (DOCKER_MSG[docker.reason] || 'Docker apps not available to install') +
        '. Only plugins can be installed or managed until Docker is running. Docker apps are still listed here.';
      el.style.display = '';
    }
    // A docker app cannot be installed while the daemon is down; a plugin can.
    function blocked(a) { return !docker.running && (a.ty || 'docker') !== 'plugin'; }

    function render() {
      if (!isOn() || caSpecial) return;
      var wrap = ensureGrid();
      if (!wrap) return;
      renderDockerNotice();
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
        // while the catalog is still downloading the page is working, not
        // empty, so it gets a wheel; the note alone reads like a dead store
        if (!feedReady && feedWaits < FEED_MAX_WAITS) {
          var spin = document.createElement('div');
          spin.className = 'asga-empty-spin';
          empty.appendChild(spin);
        }
        empty.appendChild(document.createTextNode(
          !feedReady ? feedWaitNote()
          : view.special === 'pinned' ? 'No pinned apps yet. Use the Pin App button on any app to add it here.'
          : view.special === 'installed' ? 'No installed apps matched the App Store catalog.'
          : view.q ? 'No apps match "' + view.q + '".'
          : emptySortNote() || 'No apps to show.'));
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
      markCurrentCategory();
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
      if (!want.length) { setRefreshSpin(false); return; }
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
          setRefreshSpin(false);
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

    // Builds the <option>/<optgroup> markup for a sort dropdown straight from
    // SORT_OPTS: grouped by data source, with the two name orders ungrouped
    // at the top since they belong to neither. Shared by the toolbar's own
    // sort select and the settings panel's Default Sort Order field, so the
    // two lists are read off the one array and can never drift apart.
    function sortOptionsHtml() {
      var opts = '', group = '';
      SORT_OPTS.forEach(function (o) {
        if (o.g !== group) {
          if (group) opts += '</optgroup>';
          // g: '' is the ungrouped tier, so no optgroup ever opens for it,
          // not even an empty-labelled one
          if (o.g) opts += '<optgroup label="' + o.g + '">';
          group = o.g;
        }
        opts += '<option value="' + o.v + '"' + (o.hint ? ' title="' + o.hint + '"' : '') + '>' + o.label + '</option>';
      });
      if (group) opts += '</optgroup>';
      return opts;
    }

    // ---- our toolbar (toggle + dropdown + refresh) in CA's search row ----
    function addSortBar() {
      var host = document.getElementById('searchFilter');
      if (!host || document.getElementById('asga-bar')) return;
      var opts = sortOptionsHtml();
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
        '<a id="asga-refresh" class="asga-refreshlink" title="Refresh GitHub star data">↻</a>' +
        '<span id="asga-updated" class="asga-updated"></span></span>' +
        // The help button opens a slide-in panel rather than navigating anywhere,
        // so unlike the gear it is a <button>, not a link: a middle click has
        // nothing to open in a tab. It sits immediately before the gear in the
        // markup so it reads as the gear's left-hand neighbour in both the
        // absolutely-positioned 7.2+ layout and 7.1's inline flow.
        '<button type="button" id="asga-help" class="asga-help" ' +
          'title="About and help" aria-label="About and help">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1z"/>' +
          '<path d="M5.255 5.786a.237.237 0 0 0 .241.247h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 0 0 .25.246h.811a.25.25 0 0 0 .25-.25v-.105c0-.718.273-.927 1.01-1.486.609-.463 1.244-.977 1.244-2.056 0-1.511-1.276-2.241-2.673-2.241-1.267 0-2.655.59-2.75 2.286zm1.557 5.763c0 .533.425.927 1 .927.609 0 1.028-.394 1.028-.927 0-.552-.42-.94-1.028-.94-.575 0-1 .388-1 .94z"/></svg>' +
        '</button>' +
        // The gear lives in the bar so it is present in both view states, and
        // it stays a plain link (see the click handler below) so a middle
        // click or a ctrl/cmd click still opens the real settings page in a
        // tab; only a plain left click is taken over to open the panel.
        '<a id="asga-settings" class="asga-settings" href="/Settings/ModernAppStore" ' +
          'title="Unraid Modern App Store settings (opens here; middle-click or Ctrl/Cmd-click for the full settings page)">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4.75a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5zm0 5a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5z"/>' +
          '<path d="M6.94.75a.75.75 0 0 0-.74.63l-.2 1.2a5.5 5.5 0 0 0-1.05.61l-1.14-.43a.75.75 0 0 0-.9.33l-1.06 1.82a.75.75 0 0 0 .16.94l.94.78a5.6 5.6 0 0 0 0 1.22l-.94.78a.75.75 0 0 0-.16.94l1.06 1.82c.18.31.55.44.9.33l1.14-.43c.32.24.68.45 1.05.61l.2 1.2c.06.36.38.63.74.63h2.12c.36 0 .68-.27.74-.63l.2-1.2c.37-.16.73-.37 1.05-.61l1.14.43c.35.11.72-.02.9-.33l1.06-1.82a.75.75 0 0 0-.16-.94l-.94-.78a5.6 5.6 0 0 0 0-1.22l.94-.78a.75.75 0 0 0 .16-.94l-1.06-1.82a.75.75 0 0 0-.9-.33l-1.14.43a5.5 5.5 0 0 0-1.05-.61l-.2-1.2a.75.75 0 0 0-.74-.63H6.94zm.64 1.5h.84l.17 1.02c.05.3.27.54.56.62.44.13.86.37 1.22.7.22.2.54.26.82.15l.97-.36.42.73-.8.66a.75.75 0 0 0-.26.8c.12.44.12.9 0 1.34a.75.75 0 0 0 .26.8l.8.66-.42.73-.97-.36a.75.75 0 0 0-.82.15c-.36.33-.78.57-1.22.7a.75.75 0 0 0-.56.62l-.17 1.02h-.84l-.17-1.02a.75.75 0 0 0-.56-.62 4 4 0 0 1-1.22-.7.75.75 0 0 0-.82-.15l-.97.36-.42-.73.8-.66a.75.75 0 0 0 .26-.8 3.9 3.9 0 0 1 0-1.34.75.75 0 0 0-.26-.8l-.8-.66.42-.73.97.36c.28.11.6.05.82-.15.36-.33.78-.57 1.22-.7a.75.75 0 0 0 .56-.62l.17-1.02z"/></svg>' +
        '</a>';
      host.appendChild(bar);
      var sel = document.getElementById('asga-sortsel');
      sel.value = view.sort;
      sel.addEventListener('change', function (e) { view.sort = e.target.value; view.page = 1; saveSort(); render(); });
      wireSortMenu(sel);
      document.getElementById('asga-refresh').addEventListener('click', onRefreshClick);
      document.getElementById('asga-help').addEventListener('click', openAboutPanel);
      document.getElementById('asga-settings').addEventListener('click', function (e) {
        // a modifier key or a non-left click is the browser being asked to
        // open the real settings page itself (new tab, new window); only a
        // plain left click is taken over to open the panel instead, so the
        // anchor still behaves like a normal link in every other case
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openSettingsPanel(e.currentTarget);
      });
      var cb = document.getElementById('asga-toggle-cb');
      cb.checked = isOn();
      cb.addEventListener('change', function () { setOn(cb.checked); });
      updateStamp();
      // once a minute so a page left open does not read "just now" all night
      if (!bar.__stampTick) bar.__stampTick = setInterval(updateStamp, 60000);
    }

    // Safari renders a <select>'s open list as a native macOS menu that no CSS
    // can theme, so on 7.2+ the select becomes the state holder for a menu of
    // our own, drawn with the refresh menu's language. 7.1 keeps the native
    // select, since its layout is verified and left alone.
    function wireSortMenu(sel) {
      if (document.documentElement.classList.contains('Theme--legacyOS')) return;
      var wrap = sel.parentNode;   // .asga-sortwrap
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'asga-sortbtn';
      btn.className = 'asga-sortbtn';
      btn.title = 'Change the sort order';
      wrap.insertBefore(btn, sel);
      sel.classList.add('asga-sortsel-hidden');
      function label() {
        var o = sel.options[sel.selectedIndex];
        btn.textContent = o ? o.text : '';
      }
      label();
      sel.addEventListener('change', label);
      // The button is as wide as the widest entry, measured in its own font,
      // so changing the selection never resizes it and the open list can
      // share its exact box.
      var probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;';
      wrap.appendChild(probe);
      probe.style.font = getComputedStyle(btn).font;
      var maxW = 0;
      SORT_OPTS.forEach(function (o) {
        probe.textContent = o.label;
        maxW = Math.max(maxW, probe.getBoundingClientRect().width);
      });
      wrap.removeChild(probe);
      // 14px left padding plus 30px right padding, and a little slack so a
      // fractional measurement never wraps the longest label
      btn.style.width = Math.ceil(maxW + 44 + 4) + 'px';
      btn.addEventListener('click', function (e) {
        e.stopPropagation(); e.preventDefault();
        var open = document.querySelector('.asga-sortmenu');
        if (open) { open.remove(); return; }
        var menu = document.createElement('div');
        menu.className = 'asga-refmenu asga-sortmenu';
        var group = '';
        SORT_OPTS.forEach(function (o) {
          if (o.g !== group) {
            group = o.g;
            // g: '' is the ungrouped tier (the two name orders): no header div
            // is ever built for it, so the list opens straight on an item
            if (group) {
              var h = document.createElement('div');
              h.className = 'asga-sortmenu-group';
              // the group header carries a mark to say where its numbers come
              // from, off the option's own m property rather than a string test
              // on the group name: a rename would silently break a test like that.
              // It goes AFTER the name, not before: the two marks are different
              // widths, so leading them would start the two headers on
              // different left edges instead of one.
              var mark = o.m === 'un' ? UN_MARK : o.m === 'gh' ? GH_MARK : '';
              h.textContent = o.g;
              if (mark) h.insertAdjacentHTML('beforeend', mark);
              menu.appendChild(h);
            }
          }
          var it = document.createElement('span');
          it.className = 'asga-refitem asga-sortmenu-item' + (o.v === view.sort ? ' asga-sortmenu-cur' : '');
          it.setAttribute('data-v', o.v);
          if (o.hint) it.title = o.hint;
          it.textContent = o.label;
          menu.appendChild(it);
        });
        wrap.insertBefore(menu, btn.nextSibling);
        // the open list wears the button's exact left edge and width
        menu.style.left = btn.offsetLeft + 'px';
        menu.style.width = btn.offsetWidth + 'px';
        menu.addEventListener('click', function (ev) {
          var item = ev.target.closest ? ev.target.closest('.asga-sortmenu-item') : null;
          if (!item) return;
          menu.remove();
          sel.value = item.getAttribute('data-v');
          view.sort = sel.value; view.page = 1; saveSort(); label(); render();
        });
        setTimeout(function () {
          document.addEventListener('click', function close(ev) {
            if (menu.contains(ev.target)) return;
            menu.remove();
            document.removeEventListener('click', close, true);
          }, true);
        }, 0);
      });
    }

    // ---- drawer shell: a right-edge slide-in panel with a backdrop, a
    // sticky header (title + close), a scrollable body, Escape to close,
    // backdrop click to close, focus into the panel on open and back to the
    // opener on close, and a body.asga-drawer-open scroll lock. The About
    // panel and the Settings panel are both built from this, so all of that
    // is written, and fixed, exactly once. Only one drawer is ever open at a
    // time: opening one closes whichever other one is already open first. ----
    var openDrawerNow = null;   // the drawer object currently open, or null
    function drawerEscHandler(ev) { if (ev.key === 'Escape') closeDrawer(openDrawerNow); }

    function makeDrawer(id, titleText) {
      var d = {};
      var backdrop = document.createElement('div');
      backdrop.className = 'asga-drawer-backdrop';
      backdrop.addEventListener('click', function () { closeDrawer(d); });

      var panel = document.createElement('div');
      panel.id = id;
      panel.className = 'asga-drawer-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      var titleId = id + '-title';
      panel.setAttribute('aria-labelledby', titleId);

      var header = document.createElement('div');
      header.className = 'asga-drawer-header';
      var title = document.createElement('h2');
      title.id = titleId;
      title.className = 'asga-drawer-title';
      title.textContent = titleText;
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'asga-drawer-close';
      closeBtn.title = 'Close';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', function () { closeDrawer(d); });
      header.appendChild(title);
      header.appendChild(closeBtn);

      var body = document.createElement('div');
      body.className = 'asga-drawer-body';

      panel.appendChild(header);
      panel.appendChild(body);
      document.body.appendChild(backdrop);
      document.body.appendChild(panel);

      d.backdrop = backdrop; d.panel = panel; d.body = body; d.closeBtn = closeBtn; d.opener = null;
      return d;
    }
    function openDrawer(d, opener) {
      // only one drawer at a time: close whatever else is open first, so the
      // two never fight over the Escape handler or the scroll lock
      if (openDrawerNow && openDrawerNow !== d) closeDrawer(openDrawerNow);
      d.opener = opener || null;
      openDrawerNow = d;
      document.body.classList.add('asga-drawer-open');
      d.backdrop.classList.add('asga-open');
      d.panel.classList.add('asga-open');
      document.addEventListener('keydown', drawerEscHandler, true);
      // preventScroll: the button that opened this can sit far down the
      // sticky toolbar, and a plain focus() would otherwise scroll the page
      // back to it
      try { d.closeBtn.focus({ preventScroll: true }); } catch (e) { d.closeBtn.focus(); }
    }
    function closeDrawer(d) {
      if (!d) return;
      d.backdrop.classList.remove('asga-open');
      d.panel.classList.remove('asga-open');
      document.body.classList.remove('asga-drawer-open');
      document.removeEventListener('keydown', drawerEscHandler, true);
      if (openDrawerNow === d) openDrawerNow = null;
      if (d.opener) try { d.opener.focus({ preventScroll: true }); } catch (e) { d.opener.focus(); }
    }

    // ---- About / Help panel: what the plugin is, its last few changelog
    // entries, and when it was last updated. Built once, the first time the
    // help button is clicked, and reused after that (unlike the attention
    // modal or the lightbox, which are thrown away on close), so opening it a
    // second time never rebuilds the DOM or refires the network request. ----
    var aboutData = null;    // about.php's answer, or the string 'error' after a failed fetch; null means "not fetched yet"
    var aboutPanel = null;   // the drawer object, built lazily by ensureAboutPanel()

    function ensureAboutPanel() {
      if (aboutPanel) return aboutPanel;
      aboutPanel = makeDrawer('asga-about-panel', 'Unraid Modern App Store');
      return aboutPanel;
    }

    // one heading plus a run of plain paragraphs, built from our own copy
    // rather than anything the endpoint returns
    function appendAboutSection(body, heading, paragraphs) {
      var sec = document.createElement('div');
      sec.className = 'asga-about-section';
      var h = document.createElement('h3');
      h.className = 'asga-about-heading';
      h.textContent = heading;
      sec.appendChild(h);
      paragraphs.forEach(function (t) {
        var p = document.createElement('p');
        p.textContent = t;
        sec.appendChild(p);
      });
      body.appendChild(sec);
    }

    // Repaints the panel body from aboutData: once with nothing yet (the
    // loading line), and again once the fetch settles, success or failure.
    // The two explainer sections are our own copy and always render; only the
    // version line and the changelog depend on the endpoint actually answering,
    // and the changelog falls back to a plain line rather than staying blank
    // or throwing when it can't be read.
    function renderAboutBody() {
      var body = aboutPanel.body;
      while (body.firstChild) body.removeChild(body.firstChild);

      if (aboutData === null) {
        var loading = document.createElement('p');
        loading.className = 'asga-about-muted';
        loading.textContent = 'Loading...';
        body.appendChild(loading);
        return;
      }
      var data = (aboutData && aboutData !== 'error') ? aboutData : null;

      if (data && data.version) {
        var verLine = document.createElement('p');
        verLine.className = 'asga-about-version';
        var txt = 'Version ' + data.version;
        if (data.updatedAt) txt += ' (updated ' + new Date(data.updatedAt * 1000).toLocaleDateString() + ')';
        verLine.textContent = txt;
        body.appendChild(verLine);
      }

      appendAboutSection(body, 'What this does', [
        'It replaces Community Applications\' own grid with its own: every app in the catalog, sorted and paged right on the page instead of round-tripping to the server.',
        'It adds GitHub star counts to app tiles, and sort orders (trending, most starred, recently updated) the stock store does not have.',
        'The Modern view toggle in the toolbar turns this off and hands the page straight back to Community Applications.'
      ]);

      appendAboutSection(body, 'Why some sorts can be empty', [
        'GitHub restricted its stargazers listing endpoints in July 2026, so dated star data can no longer be fetched from GitHub at all. The plugin records its own daily star snapshot instead, and the "this year" windows need 365 days of that history before they can show anything.'
      ]);

      var whatsNew = document.createElement('div');
      whatsNew.className = 'asga-about-section';
      var wnHead = document.createElement('h3');
      wnHead.className = 'asga-about-heading';
      wnHead.textContent = 'What\'s new';
      whatsNew.appendChild(wnHead);
      if (data && data.entries && data.entries.length) {
        data.entries.forEach(function (entry) {
          var ver = document.createElement('div');
          ver.className = 'asga-about-entry-version';
          ver.textContent = entry.version;
          whatsNew.appendChild(ver);
          var ul = document.createElement('ul');
          ul.className = 'asga-about-entry-list';
          (entry.bullets || []).forEach(function (b) {
            var li = document.createElement('li');
            li.textContent = b;
            ul.appendChild(li);
          });
          whatsNew.appendChild(ul);
        });
      } else {
        var none = document.createElement('p');
        none.className = 'asga-about-muted';
        none.textContent = 'The changelog could not be read.';
        whatsNew.appendChild(none);
      }
      body.appendChild(whatsNew);

      if (data && data.support) {
        var link = document.createElement('a');
        link.className = 'asga-about-link';
        link.href = data.support;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Support and source';
        body.appendChild(link);
      }
    }

    function openAboutPanel() {
      ensureAboutPanel();
      renderAboutBody();
      // fetched once per page load and cached in aboutData; reopening just
      // repaints from the cache instead of asking about.php again
      if (aboutData === null) {
        fetch(PREFIX + 'about.php?_=' + Date.now())
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) { aboutData = j || 'error'; renderAboutBody(); })
          .catch(function () { aboutData = 'error'; renderAboutBody(); });
      }
      openDrawer(aboutPanel, document.getElementById('asga-help'));
    }

    // ---- Settings panel: the same fields as the Unraid settings page
    // (Settings, Utilities, Unraid Modern App Store), read and written
    // through the shared settings.php endpoint the settings page itself
    // uses, so the two are true mirrors of one another rather than two
    // copies of the same config. This panel never touches the config file
    // directly, and it re-reads settings.php every time it OPENS rather than
    // caching them like the About panel does, since the settings page may
    // have changed them in another tab. ----
    var settingsPanel = null;   // the drawer object, plus .els (the form controls), built lazily by ensureSettingsPanel()

    // one label above one full-width control, appended to body; returns the control
    function addSettingsField(body, id, labelText, control) {
      var field = document.createElement('div');
      field.className = 'asga-settings-field';
      var label = document.createElement('label');
      label.className = 'asga-settings-label';
      label.setAttribute('for', id);
      label.textContent = labelText;
      control.id = id;
      field.appendChild(label);
      field.appendChild(control);
      body.appendChild(field);
      return control;
    }
    function addSettingsSelect(body, id, labelText, options) {
      var sel = document.createElement('select');
      sel.className = 'asga-settings-select';
      options.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o.v; opt.textContent = o.label;
        sel.appendChild(opt);
      });
      return addSettingsField(body, id, labelText, sel);
    }

    function setSettingsStatus(text) {
      var el = document.getElementById('asga-set-status');
      if (el) el.textContent = text || '';
    }

    function ensureSettingsPanel() {
      if (settingsPanel) return settingsPanel;
      var d = makeDrawer('asga-settings-panel', 'Unraid Modern App Store Settings');
      var body = d.body;
      var els = {};

      els.service = addSettingsSelect(body, 'asga-set-service', 'Enable Unraid Modern App Store', [
        { v: 'enabled', label: 'Yes' }, { v: 'disabled', label: 'No' }
      ]);
      els.notif = addSettingsSelect(body, 'asga-set-notif', 'Enable Notifications', [
        { v: 'enabled', label: 'Yes' }, { v: 'disabled', label: 'No' }
      ]);

      // token: a password input that never carries the saved secret (the
      // endpoint never returns it either), plus a clear-token control that
      // only shows once a token is actually on file
      var tokInput = document.createElement('input');
      tokInput.type = 'password';
      tokInput.autocomplete = 'new-password';
      tokInput.className = 'asga-settings-input';
      addSettingsField(body, 'asga-set-token', 'GitHub Personal Access Token', tokInput);
      var clearWrap = document.createElement('div');
      clearWrap.className = 'asga-settings-clearwrap';
      clearWrap.style.display = 'none';
      var clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'asga-settings-clearbtn';
      clearBtn.textContent = 'Clear saved token';
      clearBtn.addEventListener('click', clearSettingsToken);
      clearWrap.appendChild(clearBtn);
      tokInput.parentNode.appendChild(clearWrap);
      els.token = tokInput; els.clearWrap = clearWrap;

      els.scanDays = addSettingsSelect(body, 'asga-set-scandays', 'Refresh GitHub Trending Data', [
        { v: '1', label: 'Every day' }, { v: '2', label: 'Every 2 days' },
        { v: '3', label: 'Every 3 days' }, { v: '7', label: 'Every week' }
      ]);

      // built FROM SORT_OPTS via the same helper the toolbar's own sort
      // select uses, so this list is exactly the grid's own sort menu and
      // cannot drift out of step with it
      var sortSel = document.createElement('select');
      sortSel.className = 'asga-settings-select';
      sortSel.innerHTML = sortOptionsHtml();
      els.sort = addSettingsField(body, 'asga-set-sort', 'Default sort order', sortSel);

      var dataDirInput = document.createElement('input');
      dataDirInput.type = 'text';
      dataDirInput.className = 'asga-settings-input';
      els.dataDir = addSettingsField(body, 'asga-set-datadir', 'Database directory', dataDirInput);

      var actions = document.createElement('div');
      actions.className = 'asga-settings-actions';
      var applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'asga-settings-apply';
      applyBtn.textContent = 'Apply';
      applyBtn.addEventListener('click', applySettingsPanel);
      var refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'asga-settings-refreshbtn';
      refreshBtn.textContent = 'Refresh now';
      refreshBtn.addEventListener('click', refreshFromSettingsPanel);
      actions.appendChild(applyBtn);
      actions.appendChild(refreshBtn);
      body.appendChild(actions);

      var status = document.createElement('div');
      status.id = 'asga-set-status';
      status.className = 'asga-settings-status';
      body.appendChild(status);

      d.els = els;
      settingsPanel = d;
      return settingsPanel;
    }

    // fills the form from settings.php's own response shape; called after
    // every GET (panel open) and every successful POST (apply / clear token),
    // so the form always shows exactly what is now on disk
    function fillSettingsForm(j) {
      var els = settingsPanel.els;
      els.service.value = (j.service === 'disabled') ? 'disabled' : 'enabled';
      els.notif.value = (j.notifications === 'disabled') ? 'disabled' : 'enabled';
      els.scanDays.value = j.scanDays || '1';
      // same validity test optFor() backs the saved-sort read with, so a
      // value this select doesn't recognise leaves the field as it was
      // rather than selecting nothing
      if (j.defaultSort && optFor(j.defaultSort).v === j.defaultSort) els.sort.value = j.defaultSort;
      els.dataDir.value = j.dataDir || '';
      // the token field is ALWAYS rendered empty: the endpoint never sends
      // the saved value back, and echoing whatever the user last typed here
      // across a reopen would be the one place this panel disagreed with the
      // settings page, which never does that either
      els.token.value = '';
      // the mask stands in for the saved token the way every other web app
      // shows a stored secret, so the field reads as populated and the user
      // can tell WHICH token is on file. It is a placeholder rather than a
      // value, so it clears itself the moment they start typing a new one,
      // and an empty box still means keep what is saved.
      els.token.placeholder = j.hasToken
        ? (j.tokenHint || 'A token is saved. Leave blank to keep it.')
        : '';
      els.token.title = j.hasToken
        ? 'A token is saved. Leave this box blank to keep it, or type a new one to replace it.'
        : '';
      els.clearWrap.style.display = j.hasToken ? '' : 'none';
    }

    function openSettingsPanel(opener) {
      var d = ensureSettingsPanel();
      openDrawer(d, opener);
      // re-read every time the panel opens, never cached: the settings page
      // may have changed these in another tab, and this panel claims to
      // mirror it, so it has to ask again rather than trust a stale copy
      setSettingsStatus('Loading…');
      fetch(PREFIX + 'settings.php?_=' + Date.now())
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) { setSettingsStatus('Could not load settings.'); return; }
          fillSettingsForm(j);
          setSettingsStatus('');
        })
        .catch(function () { setSettingsStatus('Could not load settings.'); });
    }

    // Unraid's webGui drops any POST that doesn't carry its CSRF token: the
    // request still answers HTTP 200, but with a zero-length body and
    // nothing saved, which is otherwise indistinguishable from success. The
    // token is exposed as window.csrf_token on every webGui page, including
    // this one, so it is appended to every settings.php POST here.
    function csrfBody(params) {
      if (window.csrf_token) params.set('csrf_token', window.csrf_token);
      return params.toString();
    }
    // POSTs params to settings.php and hands cb the parsed JSON, or null for
    // ANY failure: a network error, a non-2xx response, or a response body
    // that doesn't parse as JSON, which is exactly what the silent
    // empty-body CSRF failure above looks like. cb is always reached with
    // something, so a click handler never has to guard its own call, and a
    // bad body can never throw uncaught inside it.
    function postSettingsForm(params, cb) {
      fetch(PREFIX + 'settings.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: csrfBody(params),
        credentials: 'same-origin'
      })
        .then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (txt) {
          var j = null;
          if (txt) { try { j = JSON.parse(txt); } catch (e) { j = null; } }
          cb(j);
        })
        .catch(function () { cb(null); });
    }

    function applySettingsPanel() {
      var els = settingsPanel.els;
      setSettingsStatus('Applying…');
      var params = new URLSearchParams();
      params.set('SERVICE', els.service.value);
      params.set('NOTIFICATIONS', els.notif.value);
      // an empty TOKEN means "leave the saved token alone" on the server
      // side too, but it is left off the request entirely here rather than
      // relied on, so nothing is ever sent for a field the user didn't touch
      if (els.token.value) params.set('TOKEN', els.token.value);
      params.set('SCAN_DAYS', els.scanDays.value);
      params.set('DEFAULT_SORT', els.sort.value);
      params.set('DATA_DIR', els.dataDir.value);
      postSettingsForm(params, function (j) {
        // an empty or unparsable body lands here as j === null, same as any
        // other failure, so a silently-dropped CSRF-less POST reads as an
        // error instead of a false "Settings applied."
        if (!j || !j.saved) { setSettingsStatus('Could not save settings. Try again.'); return; }
        fillSettingsForm(j);
        // the grid's own notion of the configured default follows the save
        // immediately, without reloading the page or touching whatever sort
        // the user is currently looking at
        if (j.defaultSort && optFor(j.defaultSort).v === j.defaultSort) defaultSort = j.defaultSort;
        setSettingsStatus('Settings applied.');
      });
    }

    function clearSettingsToken() {
      setSettingsStatus('Clearing the saved token…');
      var params = new URLSearchParams();
      params.set('CLEAR_TOKEN', '1');
      postSettingsForm(params, function (j) {
        if (!j || !j.saved) { setSettingsStatus('Could not clear the token. Try again.'); return; }
        fillSettingsForm(j);
        setSettingsStatus('Token cleared.');
      });
    }

    function refreshFromSettingsPanel() {
      setSettingsStatus('Starting a scan…');
      var params = new URLSearchParams();
      params.set('action', 'refresh');
      postSettingsForm(params, function (j) {
        if (!j || !j.started) { setSettingsStatus('Could not start a scan. Try again.'); return; }
        setSettingsStatus('Scan started.');
        startPolling();   // same progress bar the toolbar's own refresh uses
      });
    }

    // "Updated 12 min ago" beside the refresh icon. The visible time is CA's
    // own feed sync, which is when the store last checked for new and updated
    // apps; the tooltip carries the star scan too, since that is what the icon
    // itself refreshes.
    function fmtAgo(ts) {
      var s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
      if (s < 60) return 'just now';
      var m = Math.floor(s / 60);
      if (m < 60) return m + ' min ago';
      var h = Math.floor(m / 60);
      if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
      var d = Math.floor(h / 24);
      return d + (d === 1 ? ' day ago' : ' days ago');
    }
    function updateStamp() {
      var el = document.getElementById('asga-updated');
      if (!el) return;
      if (!stamps.feed) { el.textContent = ''; el.title = ''; return; }
      el.textContent = 'Updated ' + fmtAgo(stamps.feed);
      var tip = 'App catalog synced ' + new Date(stamps.feed * 1000).toLocaleString();
      if (stamps.scan) tip += '\nGitHub stars scanned ' + new Date(stamps.scan * 1000).toLocaleString();
      el.title = tip;
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
    function applySearch(q) {
      if (!isOn()) return;
      q = q || '';
      if (q === view.q) return;
      if (caSpecial) { caSpecial = false; applyViewMode(); }   // leave a CA view when searching
      // CA disables its category menu for the duration of a search, so a search
      // there always spans the whole store. This does the same rather than
      // quietly searching inside whichever category was last opened.
      view.special = ''; view.cat = ''; view.catLabel = 'All Apps';
      view.q = q; view.page = 1; render();
    }
    function wireSearch() {
      var box = document.getElementById('searchBox');
      if (!box || box.__asgaWired) return;
      box.__asgaWired = true;
      var deb;
      box.addEventListener('input', function () {
        clearTimeout(deb);
        deb = setTimeout(function () { applySearch(box.value); }, 120);
      });
      // CA's clear button empties the box with jQuery's .val(), which fires no
      // input event, so the grid stayed filtered on a query the user could no
      // longer see. The box is read back after CA's own handler has run.
      document.addEventListener('click', function (e) {
        if (!e.target || !e.target.closest) return;
        if (!e.target.closest('.searchSubmit, #searchButton')) return;
        setTimeout(function () { applySearch(box.value); }, 0);
      }, true);
    }

    // CA's left menu never shows which entry you are looking at, so the grid
    // marks it itself. Pinned and Installed are our own views and match on their
    // data-category; everything else matches on the category we are filtered to,
    // and an unfiltered grid marks whichever entry means "all of it".
    function markCurrentCategory() {
      var items = document.querySelectorAll('.caMenuItem, .startupButton');
      for (var i = 0; i < items.length; i++) {
        var it = items[i], cat = it.getAttribute('data-category') || '';
        var on;
        if (view.special) on = (cat === (view.special === 'pinned' ? 'pinned_apps' : 'installed_apps'));
        else if (view.cat) on = (cat === view.cat);
        else on = it.classList.contains('allApps') || cat === 'All';
        it.classList.toggle('asga-menu-cur', !!on);
      }
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
    // The icon doubles as the page-rescan's progress wheel: it spins from the
    // click until the request lands, since nothing else on screen moves.
    function setRefreshSpin(on) {
      var el = document.getElementById('asga-refresh');
      if (el) el.classList[on ? 'add' : 'remove']('asga-spinning');
    }
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
        if (item.getAttribute('data-act') === 'page') { setRefreshSpin(true); scanVisible(true); }
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
      wireDescriptionTidy();
      showWarningIfNeeded();
      applyViewMode();
      dismissCaLoading();
      if (isOn() && !document.getElementById('asga-view')) render();
    }

    function start() {
      triggerNewScan();
      loadViews();   // pin/installed membership, so tiles show correct pin state
      loadApps(function () {
        // has to run after loadApps() lands: that's what carries the configured
        // default this falls back to, and it must run before attachUI()/render()
        // paint the sort menu and the first page
        initSort();    // restore last sort (or the configured default after 20 min)
        attachUI();
        render();
        waitForFeed();   // no-op unless CA's catalog is still being downloaded
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
