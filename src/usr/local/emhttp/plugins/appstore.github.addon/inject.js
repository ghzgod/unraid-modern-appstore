/*
 * Front-end injector for the App Store GitHub Addon.
 *
 * Runs only on /Apps. It does NOT recreate any tiles. It uses Community
 * Applications' OWN rendering:
 *   1. paints a ★ star badge on every GitHub-backed tile,
 *   2. replaces CA's row of "Sort By:" links with ONE dropdown holding both
 *      CA's own sort orders and ours (stars / trending),
 *   3. a small Refresh control (confirm + 3-day cooldown + cancel) and a thin
 *      progress bar while a scan runs.
 *
 * Sorting works by injecting numeric metrics into CA's transient view caches
 * (via sortinject.php) and then calling CA's own changeSortOrder(), so the
 * GitHub view IS the real app page, just orderable by stars/trending, and it
 * tracks any change CA makes to its tiles. CA rebuilds those caches from the
 * raw feed on every search / category change, wiping our fields, so we hook
 * CA's updateDisplay() and re-inject + re-sort once after each render whenever
 * a GitHub sort is active. CA's own sort orders are applied by clicking its
 * hidden .sortIcons anchors, so CA's internal state stays exactly as it
 * expects. Everything is wrapped so a failure is a silent no-op that never
 * breaks CA.
 */
(function () {
  'use strict';
  try {
    if (location.pathname.indexOf('/Apps') !== 0) return;
    var PREFIX = '/plugins/appstore.github.addon/';
    var STARS = null;
    var polling = false, wasRunning = false;
    var activeOpt = null;      // the option currently applied
    var reSorting = false;     // guards the one re-sort we trigger per CA render

    // Every option is sorted through OUR path (applyGhSort + the re-apply hook),
    // including CA's own fields (Name/SortName, downloads, FirstSeen). Clicking
    // CA's native sort anchors instead was unreliable: CA's changeMaxPerPage
    // rebuilds the list alphabetically, and a native sort does not self-heal
    // after that render, so "Newest"/"Downloads" would intermittently fall back
    // to A-Z. Routing everything through the self-healing hook fixes that.
    // `key` is the field CA's mySort() orders by (it maps 'Name' -> 'SortName').
    var SORT_OPTS = [
      { v: 'name_asc',  key: 'Name',      dir: 'Up',   label: 'Name Ascending' },
      { v: 'name_desc', key: 'Name',      dir: 'Down', label: 'Name Descending' },
      { v: 'downloads', key: 'downloads', dir: 'Down', label: 'Unraid Downloads' },
      { v: 'new',       key: 'FirstSeen', dir: 'Down', label: 'Newest to the App Store' },
      { v: 'ghstars',   key: 'ghstars',   dir: 'Down', label: 'GitHub Stars' },
      { v: 'ght1',      key: 'ght1',      dir: 'Down', label: 'Trending (today)' },
      { v: 'ght7',      key: 'ght7',      dir: 'Down', label: 'Trending (this week)' },
      { v: 'ght30',     key: 'ght30',     dir: 'Down', label: 'Trending (this month)' },
      { v: 'ght365',    key: 'ght365',    dir: 'Down', label: 'Trending (this year)' },
      { v: 'ghp1',      key: 'ghp1',      dir: 'Down', label: 'Trending % (today)' },
      { v: 'ghp7',      key: 'ghp7',      dir: 'Down', label: 'Trending % (this week)' },
      { v: 'ghp30',     key: 'ghp30',     dir: 'Down', label: 'Trending % (this month)' },
      { v: 'ghp365',    key: 'ghp365',    dir: 'Down', label: 'Trending % (this year)' }
    ];
    function optFor(v) { for (var i = 0; i < SORT_OPTS.length; i++) if (SORT_OPTS[i].v === v) return SORT_OPTS[i]; return null; }

    function fmt(n) {
      if (n == null) return '';
      var a = Math.abs(n);
      if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
      if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
      if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
      return '' + n;
    }
    function ago(ts) {
      if (!ts) return 'never';
      var s = Math.floor(Date.now() / 1000) - ts;
      if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    }

    function injectUrl() { return PREFIX + 'sortinject.php?_=' + Date.now(); }

    function loadStars(cb) {
      fetch(PREFIX + 'stars.json?_=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { STARS = j || { byName: {} }; cb && cb(); })
        .catch(function () { STARS = STARS || { byName: {} }; cb && cb(); });
    }

    // ---- badges on CA's real tiles ----
    // match each tile to its OWN repo by unique template path (data-apppath);
    // fall back to name only if no path match (names are not unique).
    function starsForTile(t) {
      if (!STARS) return null;
      var path = t.getAttribute('data-apppath');
      if (path && STARS.byPath && Object.prototype.hasOwnProperty.call(STARS.byPath, path)) return STARS.byPath[path];
      var name = (t.getAttribute('data-appname') || '').toLowerCase().trim();
      if (STARS.byName && Object.prototype.hasOwnProperty.call(STARS.byName, name)) return STARS.byName[name];
      return null;
    }
    function paintBadges() {
      var tiles = document.querySelectorAll('.ca_holder[data-appname]:not([data-ghstars-done])');
      for (var i = 0; i < tiles.length; i++) {
        var t = tiles[i];
        t.setAttribute('data-ghstars-done', '1');
        var s = starsForTile(t);
        if (s == null) continue;
        var b = document.createElement('span');
        b.className = 'ghstars-badge';
        // official/installed cards draw a corner ribbon in the top-right; slide left of it
        if (t.querySelector('.officialCardBackground, .LTOfficialCardBackground, .installedCardBackground, .warningCardBackground, .betaCardBackground, .greenCardBackground, .spotlightCardBackground')) {
          b.className += ' ghstars-badge-flagged';
        }
        b.title = s + ' GitHub stars';
        b.textContent = '★ ' + fmt(s);
        t.appendChild(b);
      }
    }

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

    // ---- sort integration ----
    // Re-inject our metrics into CA's view caches, then ask CA to sort+render
    // its own tiles by the chosen field. sortinject.php is a no-op for CA's own
    // fields (Name/downloads/FirstSeen) and adds ours (ghstars/trends) for the
    // rest, so the same path drives every option.
    function applyGhSort(o) {
      // never let a dropped response wedge the re-sort guard
      setTimeout(function () { reSorting = false; }, 15000);
      return fetch(injectUrl())
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function () {
          try {
            var icons = document.querySelectorAll('#sortIconArea .sortIcons');
            for (var i = 0; i < icons.length; i++) icons[i].classList.remove('enabledIcon');
            window.post({ action: 'changeSortOrder', sortOrder: { sortBy: o.key, sortDir: o.dir } }, function () { window.changeSortOrder(); });
          } catch (e) { reSorting = false; }
        });
    }

    function applySort(o) {
      if (!o) return;
      activeOpt = o;
      var sel = document.getElementById('asga-sortsel');
      if (sel && sel.value !== o.v) sel.value = o.v;
      reSorting = true;   // the render this first call causes is already sorted
      applyGhSort(o);
      // Belt-and-suspenders: CA's changeMaxPerPage (our 96/page nudge) rebuilds
      // the list A-Z on a later tick; re-assert the sort once it has settled so
      // the final render is never alphabetical even if the hook missed a beat.
      setTimeout(function () { if (activeOpt === o) { reSorting = true; applyGhSort(o); } }, 900);
    }

    // CA rebuilds its view caches (without our fields, and re-sorted A-Z) on
    // every search, category switch, page change and per-page change, so
    // re-inject and re-sort exactly once after each of its renders while one of
    // our orders is active. This self-heal is what keeps every sort (including
    // CA's own Newest/Downloads) from falling back to alphabetical.
    function hookUpdateDisplay() {
      if (window.__asgaDisplayHooked || typeof window.updateDisplay !== 'function') return;
      window.__asgaDisplayHooked = true;
      var orig = window.updateDisplay;
      window.updateDisplay = function () {
        var r = orig.apply(this, arguments);
        try {
          if (reSorting) {
            reSorting = false;                      // this render IS our re-sort
          } else if (activeOpt) {
            reSorting = true;
            setTimeout(function () { applyGhSort(activeOpt); }, 0);
          }
        } catch (e) { reSorting = false; }
        return r;
      };
    }

    // a native <select> (inherits Unraid's dropdown theme) replacing CA's row
    // of Sort By links, which we hide rather than remove, since CA's own code
    // reads and writes their classes.
    // Hide CA's own Sort By row. Separate from placing our control, because CA
    // hides and shows #sortIconArea as a unit (clearSearchBox -> hideSortIcons),
    // so anything we put INSIDE it disappears with it.
    function hideNativeSortRow() {
      var area = document.getElementById('sortIconArea');
      if (!area || area.classList.contains('asga-sorthidden')) return;
      area.classList.add('asga-sorthidden');
      // CA's "Sort By:" caption is a bare text node, so CSS can't hide it with
      // the anchors. Blank it here and let our own label stand in.
      for (var n = 0; n < area.childNodes.length; n++) {
        var node = area.childNodes[n];
        if (node.nodeType === 3 && node.nodeValue && node.nodeValue.trim()) node.nodeValue = '';
      }
    }

    function addSortBar() {
      // the toolbar row, which CA never hides
      var host = document.getElementById('searchFilter');
      if (!host || document.getElementById('asga-bar')) return;
      var opts = SORT_OPTS.map(function (o) { return '<option value="' + o.v + '">' + o.label + '</option>'; }).join('');
      var bar = document.createElement('span');
      bar.id = 'asga-bar';
      bar.className = 'asga-bar';
      bar.innerHTML = '<span class="asga-bar-label">Sort By:</span>' +
        '<select id="asga-sortsel" class="asga-sortsel">' + opts + '</select>' +
        '<a id="asga-refresh" class="asga-refreshlink" title="Fetch the latest GitHub data (once every 3 days)">↻</a>';
      host.appendChild(bar);
      document.getElementById('asga-sortsel').addEventListener('change', function (e) {
        applySort(optFor(e.target.value));
      });
      document.getElementById('asga-refresh').addEventListener('click', onRefreshClick);
    }

    // CA defaults to 24 results per page, which makes a stars/trending ranking
    // useless. Nudge it to CA's largest option (96). CA persists this
    // server-side, so it only has to succeed once, but the old code set its
    // "done" flag BEFORE 96 actually took effect, so a failed nudge left the
    // browser stuck at 24 forever. Now we only mark it done once we OBSERVE 96
    // is active, and retry on every apply() until then. (New flag key, so
    // browsers stuck under the old key re-run.)
    function maybeSetPerPage() {
      try {
        if (localStorage.getItem('asga_perpage_96')) return;
        if (typeof window.changeMax !== 'function') return;
        var el = document.getElementById('maxPerPage');
        if (!el || !el.textContent) return;
        var m = /(\d+)/.exec(el.textContent);
        var cur = m ? parseInt(m[1], 10) : 0;
        if (cur >= 96) { localStorage.setItem('asga_perpage_96', '1'); return; }
        window.changeMax(96);   // retried next apply() until 96 is observed
      } catch (e) {}
    }

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

    // ---- refresh + progress (thin top bar) ----
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
            if (wasRunning) { wasRunning = false; loadStars(function () { repaintBadges(); }); }
            polling = false;
          }
        }).catch(function () { polling = false; });
    }
    function startPolling() { if (polling) return; polling = true; pollProgress(); }

    function repaintBadges() {
      var marked = document.querySelectorAll('.ca_holder[data-ghstars-done]');
      for (var i = 0; i < marked.length; i++) marked[i].removeAttribute('data-ghstars-done');
      var badges = document.querySelectorAll('.ghstars-badge');
      for (var j = 0; j < badges.length; j++) if (badges[j].parentNode) badges[j].parentNode.removeChild(badges[j]);
      paintBadges();
    }

    // ---- lifecycle ----
    function apply() {
      paintBadges();
      showWarningIfNeeded();
      addSortBar();
      hideNativeSortRow();
      hookUpdateDisplay();
      maybeSetPerPage();
    }
    // on Apps-page load, pull stars for any newly-published repos right away
    // (throttled server-side); the progress poller repaints badges when it finishes.
    function triggerNewScan() {
      fetch(PREFIX + 'newscan.php?_=' + Date.now())
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (res) { if (res && res.started) setTimeout(startPolling, 1000); })
        .catch(function () {});
    }

    function start() {
      triggerNewScan();
      loadStars(function () {
        apply();
        var main = document.querySelector('.mainArea') || document.body;
        var pending = false;
        var mo = new MutationObserver(function () {
          if (pending) return;
          pending = true;
          setTimeout(function () { pending = false; apply(); }, 150);
        });
        mo.observe(main, { childList: true, subtree: true });
        startPolling();
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  } catch (e) { /* never break CA */ }
})();
