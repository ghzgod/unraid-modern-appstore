/*
 * App Store GitHub Addon — front-end injector.
 *
 * Runs only on /Apps. It does NOT recreate any tiles — it uses Community
 * Applications' OWN rendering:
 *   1. paints a ★ star badge on every GitHub-backed tile,
 *   2. adds "GitHub Stars" + "Trending" options to CA's native Sort By menu,
 *   3. adds a "GitHub ★" left-menu item that opens CA's real All-Apps view
 *      sorted by stars,
 *   4. a small Refresh control (confirm + 3-day cooldown + cancel) and a thin
 *      progress bar while a scan runs.
 *
 * Sorting works by injecting numeric metrics into CA's transient displayed.json
 * (via sortinject.php) and then calling CA's own changeSortOrder() — so the
 * GitHub view IS the real app page, just orderable by stars/trending, and it
 * tracks any change CA makes to its tiles. Everything is wrapped so a failure
 * is a silent no-op that never breaks CA.
 */
(function () {
  'use strict';
  try {
    if (location.pathname.indexOf('/Apps') !== 0) return;
    var PREFIX = '/plugins/appstore.github.addon/';
    var STARS = null;
    var polling = false, wasRunning = false, didDefault = false;

    var SORT_OPTS = [
      { v: 'new',    key: 'FirstSeen', label: 'Newest to the App Store' },
      { v: 'ghstars', key: 'ghstars',  label: 'GitHub Stars' },
      { v: 'ght1',   key: 'ght1',      label: 'Trending — today' },
      { v: 'ght7',   key: 'ght7',      label: 'Trending — this week' },
      { v: 'ght30',  key: 'ght30',     label: 'Trending — this month' },
      { v: 'ght365', key: 'ght365',    label: 'Trending — this year' }
    ];

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
      msg.innerHTML = '⚠ <b>App Store GitHub Addon:</b> no GitHub personal access token configured — ' +
        'star counts are disabled. Add a token in <a href="' + (cfg.settingsUrl || '/Settings') +
        '">Settings → App Store GitHub Addon</a>.';
      var x = document.createElement('span');
      x.className = 'ghstars-warning-x'; x.title = 'Dismiss'; x.textContent = '✕';
      x.addEventListener('click', function () { w.parentNode && w.parentNode.removeChild(w); });
      w.appendChild(msg); w.appendChild(x);
      main.insertBefore(w, main.firstChild);
    }

    // ---- native sort integration ----
    // Inject metrics into CA's displayed.json, then let CA sort+render its own
    // tiles by that key. ('new' uses CA's native FirstSeen field; injecting is
    // harmless there.)
    function applySort(key) {
      return fetch(PREFIX + 'sortinject.php?_=' + Date.now())
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function () {
          try { window.post({ action: 'changeSortOrder', sortOrder: { sortBy: key, sortDir: 'Down' } }, function () { window.changeSortOrder(); }); } catch (e) {}
        });
    }
    function keyFor(v) { for (var i = 0; i < SORT_OPTS.length; i++) if (SORT_OPTS[i].v === v) return SORT_OPTS[i].key; return null; }

    // a native <select> (inherits Unraid's dropdown theme) in the top toolbar
    function addSortBar() {
      var host = document.getElementById('searchFilter');
      if (!host || document.getElementById('asga-bar')) return;
      var opts = SORT_OPTS.map(function (o) { return '<option value="' + o.v + '">' + o.label + '</option>'; }).join('');
      var bar = document.createElement('span');
      bar.id = 'asga-bar';
      bar.className = 'asga-bar';
      bar.innerHTML = '<span class="asga-bar-label">GitHub sort:</span>' +
        '<select id="asga-sortsel" class="asga-sortsel"><option value="">—</option>' + opts + '</select>' +
        '<a id="asga-refresh" class="asga-refreshlink" title="Fetch the latest GitHub data (once every 3 days)">↻</a>';
      host.appendChild(bar);
      document.getElementById('asga-sortsel').addEventListener('change', function (e) {
        var k = keyFor(e.target.value); if (k) applySort(k);
      });
      document.getElementById('asga-refresh').addEventListener('click', onRefreshClick);
    }

    function onRefreshClick(e) {
      if (e) e.stopPropagation();
      if (!window.confirm('Fetch the latest GitHub star data now? Allowed once every 3 days.')) return;
      fetch(PREFIX + 'refresh.php?_=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (res) {
          if (res && res.cooldown) {
            var d = Math.max(1, Math.ceil((res.next_allowed - Math.floor(Date.now() / 1000)) / 86400));
            alert('Already refreshed recently — next refresh allowed in ~' + d + ' day(s).');
            return;
          }
          startPolling();
        });
    }

    // ---- "GitHub ★" left-menu item: CA All Apps + sort by stars ----
    function addMenuItem() {
      if (document.getElementById('asga-menu')) return;
      var cat = document.querySelector('.categoryMenu.caMenuItem');
      if (!cat || !cat.parentNode) return;
      var item = document.createElement(cat.tagName);
      item.id = 'asga-menu';
      item.className = cat.className.replace(/\ballApps\b/g, '') + ' asga-menu';
      item.removeAttribute('data-category');
      item.textContent = 'GitHub ★';
      item.addEventListener('click', function (e) { e.stopPropagation(); openGitHub(); });
      cat.parentNode.insertBefore(item, cat);
    }

    function openGitHub() {
      document.querySelectorAll('.caMenuItem.selectedMenu').forEach(function (x) { x.classList.remove('selectedMenu'); });
      var me = document.getElementById('asga-menu'); if (me) me.classList.add('selectedMenu');
      try { window.getContent(false, 'All', 'GitHub ★', false); } catch (e) { var b = document.querySelector('.allApps'); if (b) b.click(); }
      // wait until CA finishes building the full displayed.json, then sort by stars
      var tries = 0;
      (function waitFill() {
        fetch(PREFIX + 'sortinject.php?_=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (inj) {
            if (inj && inj.count > 1000) {
              var sel = document.getElementById('asga-sortsel'); if (sel) sel.value = 'new';
              applySort('FirstSeen');                 // default: Newest to the App Store
            } else if (tries++ < 40) setTimeout(waitFill, 350);
          }).catch(function () {});
      })();
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
    // make the GitHub view the default landing page (once, after CA's first render)
    function maybeDefaultOpen() {
      if (didDefault) return;
      if (!document.getElementById('asga-menu') || typeof window.getContent !== 'function') return;
      if (!document.querySelector('#templates_content .ca_holder[data-appname]')) return;
      didDefault = true;
      setTimeout(openGitHub, 300);
    }

    function apply() {
      paintBadges();
      showWarningIfNeeded();
      addMenuItem();
      addSortBar();
      maybeDefaultOpen();
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
