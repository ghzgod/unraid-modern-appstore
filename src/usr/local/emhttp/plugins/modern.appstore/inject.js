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
    // repo: the maintainer name a 'repo' special view is filtering to (CA's
    // RepoName, exactly as it arrives in data-repository). Only meaningful
    // when special === 'repo'; every other special view leaves it untouched.
    var view = { sort: 'new', q: '', cat: '', catLabel: 'All Apps', special: '', repo: '', page: 1, perPage: 96 };
    // the configured opening sort, overwritten once applist.php answers with the
    // server's real value; 'new' is only what's used before that response lands
    // or if the config on disk can't be read
    var defaultSort = 'new';
    // initSort() must run exactly once per page load (see its own comment); this
    // is the guard, since loadApps() itself refires several times after start()
    var sortInited = false;
    var polling = false, wasRunning = false;
    var pageItemsNow = [];        // apps the grid is currently showing
    // bumped by render() on every repaint, so an in-flight fillMissingDates()
    // left over from a page the user has since paged away from knows to stop
    // touching tiles that no longer belong to the page it started on
    var renderGen = 0;
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
    // 'repos' used to live in this list too: CA's own repo search, which the
    // drawer's All Apps button ran, landed here and forced the fallback. Now
    // that wireRepoClick() renders a maintainer's apps in our own grid (rn +
    // view.special === 'repo'), CA never needs to take that view over, so it
    // is not one of the views left to hand back.
    var caSpecial = false;
    var CA_SPECIAL = /^(previous_apps|prev_docker|prev_plugins|action_centre)$/;
    function stripTag(ri) { return (ri || '').toLowerCase().split(':')[0]; }
    // Template path of the app whose drawer is open. The drawer is CA's and CA
    // never tells us which app it just painted, so the path we handed
    // showSidebarApp is kept here for fixDrawerDetails() to look the app back
    // up with. Every open goes through openSidebar() so this cannot go stale.
    var openPath = '';
    // Image ref -> registry push time, filled by lastupdate.php. 0 means asked
    // and nothing was there, which is remembered too so re-opening a drawer
    // never refires a request that already came back empty.
    var regDates = {};

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
    // The card date footer's two icons (Change: icon + age, full date moved to
    // the tooltip). Same currentColor pattern as GH_MARK/UN_MARK above, so both
    // follow the theme rather than carrying a fixed colour of their own.
    var CAL_ICON = '<svg class="asga-ficon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
    // A clock face, not the curved-arrow-and-clock "history" glyph this used to
    // be. That one is the same mark every UI uses for refresh or undo, so on a
    // card it read as a button you could press rather than a fact about the
    // app. The pair now says what each half is: a calendar for the date the
    // app arrived, a clock for how long since it last changed.
    var CLOCK_ICON = '<svg class="asga-ficon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.4 2"/></svg>';
    // A shield for the 114 apps whose container is given elevated privileges
    // on the host. CA carries a moderator comment on only 273 templates in
    // total, so most of these say nothing about it anywhere the reader would
    // see.
    var PRIV_ICON = '<svg class="asga-ficon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5.5c0 4.2-2.9 7.6-7 8.5-4.1-.9-7-4.3-7-8.5V6z"/><path d="M12 9v3"/><path d="M12 15v.01"/></svg>';
    // The footer's star and download figures used to be literal text glyphs
    // (a ★ and a ⤓), which render at the font's own size and sit on the text
    // baseline, so they could never match the two fixed 12px SVG date icons
    // above. Built the same way, and carrying the same asga-ficon class, so
    // all four footer icons are one size and one shape.
    var STAR_ICON = '<svg class="asga-ficon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z"/></svg>';
    var DL_ICON = '<svg class="asga-ficon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>';
    // The card header used to spell "Docker" or "Plugin" out as a text pill on
    // its own line; these two replace it with an icon that shares the name's
    // line instead, so the header buys that line back. Carries asga-ficon like
    // the four icons above, plus asga-ficon-lg, since it needs to read at 16px
    // here rather than the 12px a footer glyph gets away with beside its text.
    // Docker's own brand blue, which is why it is allowed to sit alongside this
    // card's own palette: it names a real external mark, not a second hue.
    var DOCKER_ICON = '<svg class="asga-ficon asga-ficon-lg asga-kind-docker" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="This is a Docker application"><title>This is a Docker application</title><path d="M4 12h17a1 1 0 0 1 1 1 7 7 0 0 1-7 7H9a7 7 0 0 1-7-7v-1z"/><path d="M6 12V9h3v3M10 12V9h3v3M14 12V9h3v3M10 8V5h3v3"/></svg>';
    // Violet, and deliberately not the #ff8c2f accent: the accent means
    // interactive everywhere else on this card, and this icon states a fact
    // about the app rather than offering to do anything.
    var PLUGIN_ICON = '<svg class="asga-ficon asga-ficon-lg asga-kind-plugin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="This is a plugin application"><title>This is a plugin application</title><path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8z"/><path d="M12 17v5"/></svg>';
    // The button row used to be six words in six pills. A mark in front of each
    // lets the row be read at a glance rather than word by word. They are 10px
    // rather than the 12px a footer glyph gets, because six buttons and their
    // labels have to fit one line of a 340px column and the marks are what that
    // line can least afford to spend on.
    var INFO_ICON    = '<svg class="asga-bicon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5v.01"/></svg>';
    var PIN_ICON     = '<svg class="asga-bicon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 4 3v2H6v-2l4-3z"/><path d="M12 15v5"/></svg>';
    var PROJECT_ICON = '<svg class="asga-bicon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
    var SUPPORT_ICON = '<svg class="asga-bicon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.6"/><path d="M14.6 9.4 18 6M9.4 9.4 6 6M14.6 14.6 18 18M9.4 14.6 6 18"/></svg>';
    var REPO_ICON    = '<svg class="asga-bicon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 8-4 4 4 4"/><path d="m15 8 4 4-4 4"/></svg>';
    var INSTALL_ICON = '<svg class="asga-bicon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>';
    // The maintainer's own picture goes beside their name; this stands in for
    // the 511 of CA's 1182 maintainers who have published none.
    var PERSON_ICON  = '<svg class="asga-bicon asga-bicon-line" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.4"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>';
    // A tag rather than the folder Project wears: the two sit on the same card
    // and a category is a label attached to the app, not a place its files live.
    var TAG_ICON     = '<svg class="asga-bicon asga-bicon-line" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12.5V5a2 2 0 0 1 2-2h7.5L21 11.5 12.5 20z"/><circle cx="7.6" cy="7.6" r="1.4"/></svg>';
    // The two figures in the card's stat column, at the size a boxed mark needs
    // rather than the 12px a footer glyph gets away with.
    var STAR_MARK = '<svg class="asga-smark" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z"/></svg>';
    var DL_MARK   = '<svg class="asga-smark" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>';
    // Exclamation-in-a-circle for the About panel's "Report an issue" header
    // button (see makeDrawer's headerAction and ensureAboutPanel below). No
    // asga-ficon class: that class forces its own 12px/16px sizing, and this
    // one needs to stay the 14px it's built at, sitting in the same 28px box
    // the close button uses.
    var ISSUE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.5v.01"/></svg>';
    // /issues/new/choose rather than /issues/new, so GitHub offers this
    // repo's own issue templates instead of a blank form. No query string:
    // nothing about the server this loads on (version, hostname, IP) belongs
    // riding along in a link a user clicks from their own box.
    var ISSUE_URL = 'https://github.com/ghzgod/unraid-modern-appstore/issues/new/choose';
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

    // ---- what to put behind an icon ----
    //
    // Roughly a fifth of the catalog's icons are dark artwork drawn for a light
    // page, and this addon's icon tile is a near-black plate, so those arrived
    // invisible: dark ink on a plate of the same brightness is a blank square.
    // The plate answers the icon rather than the theme, so a bright icon keeps
    // the quiet tile it already had and only a dark one gets a light plate.
    //
    // The measuring cannot happen here. Most icons are served by ca.unraid.net,
    // which sends no CORS header, so drawing one to a canvas taints it and the
    // pixels cannot be read back; icontone.php reads them server side instead.
    // Every answer is held in localStorage, so a second visit asks for nothing.
    var TONE_KEY = 'asga_icontone_v1';
    var TONE_DARK = 78;   // 0-255 mean luminance; below this needs a plate
    var toneMap = {};
    try { toneMap = JSON.parse(localStorage.getItem(TONE_KEY) || '{}') || {}; } catch (e) { toneMap = {}; }
    // the catalog runs to four and a half thousand icons and localStorage to a
    // few megabytes, so the map starts over rather than growing without end
    if (Object.keys(toneMap).length > 2500) toneMap = {};
    var tonePending = {};
    var toneTimer = null;
    function paintTone(img, lum) {
      if (lum == null || lum < 0) return;
      img.dataset.tone = (lum < TONE_DARK) ? 'dark' : 'lit';
    }
    // Bound on load rather than on creation, because a card swaps in the
    // maintainer's GitHub avatar when a template's own icon 404s and the tone
    // has to describe whichever picture actually arrived.
    function watchTone(img) {
      if (!img || img.__asgaTone) return;
      img.__asgaTone = true;
      if (img.complete && img.naturalWidth) queueTone(img);
      else img.addEventListener('load', function () { queueTone(this); });
    }
    function queueTone(img) {
      var url = img.currentSrc || img.src || '';
      if (!url || url.indexOf('data:') === 0) return;
      if (toneMap[url] !== undefined) { paintTone(img, toneMap[url]); return; }
      (tonePending[url] = tonePending[url] || []).push(img);
      if (!toneTimer) toneTimer = setTimeout(flushTone, 200);
    }
    function flushTone() {
      toneTimer = null;
      var urls = Object.keys(tonePending);
      if (!urls.length) return;
      var batch = urls.slice(0, 80);
      fetch(PREFIX + 'icontone.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ u: batch })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          batch.forEach(function (u) {
            var lum = (j && j[u] !== undefined) ? j[u] : -1;
            toneMap[u] = lum;
            (tonePending[u] || []).forEach(function (im) { paintTone(im, lum); });
            delete tonePending[u];
          });
          try { localStorage.setItem(TONE_KEY, JSON.stringify(toneMap)); } catch (e) {}
          if (Object.keys(tonePending).length && !toneTimer) toneTimer = setTimeout(flushTone, 200);
        })
        .catch(function () {
          // the endpoint is missing or the server refused; the queue is dropped
          // rather than asked again on every render
          batch.forEach(function (u) { toneMap[u] = -1; delete tonePending[u]; });
        });
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
    // The query as the words the filters actually test, shared by the list and
    // by the cards so the two can never disagree about what matched.
    function searchWords() {
      return view.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    }
    function currentList() {
      var words = searchWords();
      var opt = optFor(view.sort);
      var list = APPS.filter(function (a) {
        if (view.special === 'pinned') { if (!pinnedSet || !pinnedSet.has((a.ri || '') + '&' + (a.pn || ''))) return false; }
        else if (view.special === 'installed') { if (!installedSet || !installedSet.has(stripTag(a.ri))) return false; }
        // repo: CA hands the maintainer name back from an HTML attribute
        // (data-repository), so it is compared trimmed and case-insensitively
        // rather than as an exact string match against rn. view.repo keeps its
        // original casing (it doubles as the heading text), so both sides are
        // lowercased here rather than when view.repo is set.
        else if (view.special === 'repo') { if ((a.rn || '').trim().toLowerCase() !== view.repo.trim().toLowerCase()) return false; }
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
          } else if (btn.classList.contains('asga-maint')) {
            // CA's own repo drawer, the same one its Profile button opens
            var repo = tile.getAttribute('data-repo');
            if (repo) { holdDrawer(); try { window.showRepoPopup(repo); } catch (err) {} }
          } else if (btn.classList.contains('asga-pin')) {
            pinApp(tile, btn);
          } else { // Info
            openSidebar(p, n);
          }
          return;
        }
        // click anywhere else on the card opens the Info/Install drawer
        openSidebar(p, n);
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

    // Blank until finished. Set the moment a drawer is asked for, cleared by
    // drawerReady() once CA's own render has landed and this file's own fixups
    // have run over it.
    function holdDrawer() {
      var host = document.getElementById('sidenavContent');
      if (host) host.classList.add('asga-drawer-wait');
      clearTimeout(holdDrawer.t);
      // A render that never completes must not leave the panel blank for good.
      holdDrawer.t = setTimeout(showDrawer, 6000);
    }
    function showDrawer() {
      clearTimeout(holdDrawer.t);
      var host = document.getElementById('sidenavContent');
      if (host) host.classList.remove('asga-drawer-wait');
    }
    // What finished looks like. CA closes an app drawer with its Details table
    // and a maintainer profile with its statistics table, so either one standing
    // in the panel means its render has landed. The check runs at the end of the
    // observer's own pass, after this file has moved what it moves, so the frame
    // the reader finally sees is the finished one rather than CA's.
    function drawerReady() {
      var host = document.getElementById('sidenavContent');
      if (!host || !host.classList.contains('asga-drawer-wait')) return;
      if (host.querySelector('.popupTable.contents') || host.querySelector('.repoTable') || host.querySelector('.asga-repo-apps')) showDrawer();
    }
    // The one way the grid opens CA's drawer, so the app it is showing is
    // always recorded. Everything the drawer does on our side (see
    // fixDrawerDetails) needs to know which app that is, and CA offers no way
    // to ask after the fact.
    // One render, and the reader sees it once.
    //
    // This used to stash each drawer's finished markup and paint the stash back
    // the instant the app was re-opened, to skip the hardcoded half second CA
    // waits before it even asks for the contents. It bought perhaps a second,
    // and it cost the thing that second was for: CA's own answer still arrived
    // behind the stash and replaced it, so the reader watched a complete drawer
    // turn into a different complete drawer. Worse, the stash was taken AFTER
    // this file had added its own rows to the Details table, and the flag that
    // says a table has already been added to is a property on the DOM node,
    // which does not survive being written back through innerHTML: the restored
    // table looked untouched, got a second Last Update and a second GitHub
    // stars row, and then lost them again when CA's render landed on top.
    // The wait is the honest version, and the panel says Loading while it runs.
    function openSidebar(p, n) {
      openPath = p || '';
      holdDrawer();
      try { window.showSidebarApp(p, n); } catch (e) {}
    }

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
        // A video is not a picture. CA marks the two apart by class in the same
        // strip: an image opens mfp-image and a video opens mfp-iframe, which is
        // an embedded player in a modal. Playing a video inside a drawer inside
        // a page is three frames deep and YouTube's own controls fight the
        // outermost one for the click, so it leaves for a tab of its own,
        // behind the same confirm every other outbound link in this plugin
        // goes through.
        if (scr.classList.contains('mfp-iframe')) {
          e.preventDefault(); e.stopImmediatePropagation();
          var vid = scr.getAttribute('href') || '';
          if (vid) attentionModal(
            'This opens the video on YouTube in a new tab.\n\n' +
            'YouTube will see the visit, and whatever cookies your browser already holds for it.',
            function () { openExt(vid); }
          );
          return;
        }
        e.preventDefault(); e.stopImmediatePropagation();
        if (scr.classList.contains('popupIcon')) { var s = srcOf(scr); if (s) openLightbox([s], 0); return; }
        var items = [].slice.call(document.querySelectorAll('#sidenavContent .screenshot')).filter(function (el) { return !el.classList.contains('popupIcon') && !el.classList.contains('mfp-iframe'); });
        var srcs = items.map(srcOf).filter(Boolean);
        openLightbox(srcs, Math.max(0, items.indexOf(scr)));
      }, true);
    }
    // CA's slide-out drawer carries a Maintainer block with three buttons
    // (ca_repoSearchPopUp/repoPopup/ca_favouriteRepo), which our drawer already
    // renders and styles. All Apps runs CA's own repo search by default, which
    // used to be let through to CA_SPECIAL's 'repos' entry and hand the whole
    // page back to CA's grid: the user asked to see one maintainer's apps and
    // got CA's cards instead of ours. This intercepts that one button and
    // drives our own grid to a maintainer view instead, the same way the left
    // menu's Pinned/Installed entries already do.
    function wireRepoClick() {
      if (document.body.__asgaRepoClick) return;
      document.body.__asgaRepoClick = true;
      document.addEventListener('click', function (e) {
        if (!isOn()) return;   // modern view off: leave CA's own handler alone
        var btn = e.target.closest ? e.target.closest('#sidenavContent .ca_repoSearchPopUp') : null;
        if (!btn) return;
        e.preventDefault(); e.stopImmediatePropagation();
        var repo = (btn.getAttribute('data-repository') || '').trim();
        if (!repo) return;
        if (typeof window.closeSidebar === 'function') try { window.closeSidebar(); } catch (e2) {}
        view.special = 'repo'; view.repo = repo;
        view.page = 1; view.q = ''; view.cat = '';
        var box = document.getElementById('searchBox'); if (box) box.value = '';
        applyViewMode();
        render();
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
        if (node.nodeValue.indexOf(' ') !== -1) node.nodeValue = node.nodeValue.replace(/ +/g, ' ');
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
    function blankText(n) { return n && n.nodeType === 3 && !/[^\s ]/.test(n.nodeValue); }
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

    // ---- CA's own Details table: the two dates, plus stars and downloads ----
    //
    // CA prints "Last Update: Unknown" whenever its feed carries no LastUpdate
    // for an app, which is 1,164 of the 4,251 docker apps in the catalog. It
    // then tries to fill the row asynchronously, but that fallback only ever
    // asks Docker Hub, so an image published solely to ghcr.io, lscr.io or
    // quay.io stays Unknown for good however long you wait.
    //
    // The grid already knows the feed's date (applist.php sends it as lu, and
    // the card footer prints it), and lastupdate.php resolves the rest from
    // whichever registry actually hosts the image, so in modern view both dates
    // in this table are answered from our own data. Added gains its age for the
    // same reason the card shows one, and Last Update moves up to sit directly
    // under Added, because the two are the same kind of fact and reading them
    // together is the point.
    //
    // Taking the row over means dropping the id CA hung on it. CA fills it with
    // $("#template<ID>").html(...) once its own lookup returns; with the id
    // gone that call finds nothing and leaves our value alone, which is cleaner
    // than racing it. CA's asterisk marker goes with it: it points at a
    // footnote about statistics gathered every 30 days, and our value is not
    // that statistic.
    //
    // Below the dates go GitHub stars and Unraid downloads, the grid's s and dl
    // fields. Both figures already sit on the card as a corner badge, but a
    // badge only has room for an abbreviated number ("1.2k"), so the drawer is
    // where the exact count belongs. Downloads reuses CA's own row when it
    // wrote one, because applist.php's count is the more honest of the two: CA
    // credits an app built FROM an official base image with pulls of that base
    // image rather than the app, and CA omits the row for plugins entirely.
    //
    // CA runs every label in this table through window.tr() (its own
    // javascript/helpers.js), which swaps in the active language's string, so
    // recognising a row CA already wrote means asking tr() the same question
    // rather than matching the English text directly.
    // This file now also runs its own labels ('Total GitHub Stars' among them)
    // through tr() to check whether CA already wrote the row, and CA's
    // dictionary has no entry for a label it never shipped. A lookup that
    // returns empty or undefined for those is not a translation, it is a miss,
    // so only a genuine non-empty string is used and anything else falls
    // through to the English.
    function caLabel(english) {
      try {
        var t = (typeof window.tr === 'function') ? window.tr(english) : english;
        return (typeof t === 'string' && t) ? t : english;
      } catch (e) { return english; }
    }
    function rowByLabel(table, english) {
      var want = caLabel(english);
      for (var i = 0; i < table.rows.length; i++) {
        var cell = table.rows[i].querySelector('.popupTableLeft');
        if (cell && cell.textContent.trim() === want) return table.rows[i];
      }
      return null;
    }
    function wireDrawerDetails() {
      if (document.body.__asgaDrawerDetails) return;
      document.body.__asgaDrawerDetails = true;
      var host = document.getElementById('sidenavContent') || document.querySelector('.sidenav');
      if (!host) return;
      new MutationObserver(function () { fixDrawerDetails(); addReadmeButton(); cardSections(); fixDrawerIcon(); fixMaintainerIcon(); fixRepoDrawer(); drawerReady(); })
        .observe(host, { childList: true, subtree: true });
      fixDrawerDetails();
      addReadmeButton();
      cardSections();
      fixDrawerIcon();
      fixMaintainerIcon();
      fixRepoDrawer();
      wireDrawerNav();
      drawerReady();
    }
    // The drawer must show the same icon the card did. CA resolves the drawer's
    // icon separately from the grid's, and when its own lookup comes up empty it
    // renders a Font Awesome glyph (<i class="fa fa-star popupIcon">) instead of
    // an image, so clicking a card with a perfectly good icon could open a
    // drawer showing a star. The grid already holds the URL that worked, so it
    // is copied across rather than trusting CA to resolve it twice.
    //
    // CA's own markup for this image is <img class="popupIcon screenshot">, and
    // the screenshot class is what our lightbox binds to, so a replacement has
    // to carry both classes or clicking the icon stops opening it.
    // Is the open drawer the maintainer profile rather than an app? CA emits a
    // BACK button in that drawer and in no other, and fixRepoDrawer marks the
    // same drawer with a class of our own the first time it runs; either alone
    // is enough, and both are asked because the class is not set until the
    // pass after the markup lands.
    function isRepoDrawer() {
      return !!document.querySelector('#sidenavContent .popUpBack') ||
             !!document.querySelector('#sidenavContent .asga-repo-drawer');
    }
    function fixDrawerIcon() {
      if (!isOn()) return;
      // Only the APP drawer. The maintainer profile CA opens from the Profile
      // button renders into this same #sidenavContent, and its icon is the
      // maintainer's avatar, not the app's, so copying the card's icon across
      // there replaced a correct picture with the wrong one.
      //
      // The test used to be the presence of .popupRepoDescription, CA's bio
      // block. buildRepoApps deletes that element to put the maintainer's own
      // app list where it was, so from the next mutation onwards this guard
      // saw an app drawer and painted the app's icon over the maintainer's
      // face. BACK is CA's own markup, appears in no other drawer, and nothing
      // here ever removes it.
      if (isRepoDrawer()) return;
      var host = document.querySelector('#sidenavContent .popupIcon');
      if (!host || host.__asgaIcon) return;
      var app = drawerApp();
      if (!app || !app.ic) return;
      host.__asgaIcon = true;
      var img = host.tagName === 'IMG' ? host : host.querySelector('img');
      if (!img) {
        // CA fell back to its glyph, so there is no image to correct
        var glyph = host.querySelector('i');
        if (glyph) glyph.remove();
        img = document.createElement('img');
        img.className = 'popupIcon screenshot';
        img.alt = '';
        host.appendChild(img);
      }
      img.setAttribute('href', app.ic);
      // Through holdImage rather than a bare src assignment, so a single
      // dropped request cannot leave a question mark standing on an icon that
      // loads perfectly well. See holdImage below for what does that.
      holdImage(img, app.ic);
    }

    // Keeps an image on the URL it is meant to be showing.
    //
    // CA's own showSidebarApp binds ONE error handler across every img on the
    // page after each drawer render, and it rewrites any image that fails to
    // load to the Docker question mark. github.com drops avatar requests when
    // a run of them is asked for at once, so one dropped request was enough to
    // leave a permanent placeholder on a picture that loads on the next open,
    // and nothing ever put it back: the rewrite is an attribute change, and
    // the drawer's own observer only watches for new nodes.
    //
    // The picture is loaded off-DOM and only swapped in once it has decoded,
    // so the element never stands empty (empty is a bordered box of alt text
    // sitting where a face should be). A dropped request is retried once, and
    // gone() decides what stands there when the URL really will not load.
    var IMG_RETRY_MS = 1200;
    function holdImage(img, url, gone) {
      if (!img || !url) return;
      img.__asgaWant = url;
      img.__asgaGone = gone || null;
      img.__asgaTries = 0;
      loadHeldImage(img);
      if (img.__asgaWatch) return;
      img.__asgaWatch = new MutationObserver(function () {
        var cur = img.getAttribute('src') || '';
        if (cur === img.__asgaWant || cur.indexOf('question.png') < 0) return;
        img.__asgaTries = 0;
        loadHeldImage(img);
      });
      img.__asgaWatch.observe(img, { attributes: true, attributeFilter: ['src'] });
    }
    function loadHeldImage(img) {
      var url = img.__asgaWant;
      var probe = new Image();
      probe.onload = function () {
        if (img.getAttribute('src') !== url) {
          img.setAttribute('src', url);
          // Whatever stood here before may already have been measured for its
          // brightness, and that verdict describes a different picture.
          img.__asgaTone = false;
        }
        watchTone(img);
      };
      probe.onerror = function () {
        if (++img.__asgaTries < 2) { setTimeout(function () { loadHeldImage(img); }, IMG_RETRY_MS); return; }
        if (img.__asgaWatch) { img.__asgaWatch.disconnect(); img.__asgaWatch = null; }
        if (img.__asgaGone) img.__asgaGone(img);
      };
      probe.src = url;
    }

    // The GitHub account behind an app, for anything that needs a face and has
    // not been handed one: the starred repository when the scanner matched it,
    // else whichever of the app's own links points at github.com. Plugins
    // carry no docker repository to read an owner off, which is why the
    // Project and plugin URLs are asked as well.
    var GH_OWNER_RE = /(?:github\.com|raw\.githubusercontent\.com)\/([^\/?#]+)\//i;
    function ghOwner(a) {
      if (!a) return '';
      if (a.rp && a.rp.indexOf('/') > 0) return a.rp.split('/')[0];
      var m = GH_OWNER_RE.exec(a.pr || '') || GH_OWNER_RE.exec(a.pu || '');
      return m ? m[1] : '';
    }
    function ghAvatarFor(a) {
      var owner = ghOwner(a);
      return owner ? ('https://github.com/' + owner + '.png?size=128') : '';
    }

    // The picture that stands for an app, built into whatever box the caller
    // has. The order of answers is CA's own, which is the point: a card and
    // the drawer it opens are the same app and must never disagree about what
    // it looks like.
    //
    //   1. the icon the template names
    //   2. the FontAwesome glyph it names INSTEAD when it names no icon. 117
    //      displayable apps have no icon of their own and 59 of those carry
    //      one of these, which CA's drawer renders and this grid used to throw
    //      away, so Unassigned Devices sat on the page as a question mark
    //      while its own drawer drew the broken-link mark the author chose.
    //   3. the GitHub avatar of whoever publishes it, for the rest
    //   4. CA's question mark, which by here is the honest answer
    var ICON_FALLBACK = '/plugins/dynamix.docker.manager/images/question.png';
    function appIcon(a, cls) {
      if (!a.ic && a.fa) {
        var glyph = document.createElement('i');
        // a.fa is the bare glyph name; applist.php whitelists it to the
        // characters such a name is made of before it is ever sent, since it
        // lands in a class attribute here.
        //
        // Two icon fonts, not one. Unraid's webGui ships its own, whose
        // classes are the whole name and carry an icon- prefix
        // (icon-preclear), and putting FontAwesome's fa- in front of one of
        // those resolves to nothing: CA does exactly that, which is why
        // Unassigned Devices Preclear opens a drawer with a blank square where
        // its mark should be. A name that names the Unraid font is used as it
        // stands, and everything else is FontAwesome.
        var fontCls = a.fa.indexOf('icon-') === 0 ? a.fa : ('fa fa-' + a.fa);
        glyph.className = fontCls + (cls ? ' ' + cls : '') + ' asga-icon-fa';
        glyph.setAttribute('aria-hidden', 'true');
        return glyph;
      }
      var img = document.createElement('img');
      if (cls) img.className = cls;
      var ghAvatar = ghAvatarFor(a);
      img.src = a.ic || ghAvatar || ICON_FALLBACK;
      img.loading = 'lazy';
      img.alt = '';
      img.onerror = function (e) {
        // CA binds one error handler across every img on the page each time a
        // drawer renders, and it paints the Docker question mark on whatever
        // failed. This handler was assigned first, so stopping the event here
        // is what leaves the chain below in charge of its own fallbacks
        // instead of CA overwriting each one the moment it is chosen.
        if (e && e.stopImmediatePropagation) e.stopImmediatePropagation();
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
        if (this.src.indexOf('question.png') < 0) this.src = ICON_FALLBACK;
      };
      watchTone(img);
      return img;
    }

    // CA publishes no icon for 511 of its 1182 repositories and serves the
    // Docker question mark for those, which is how the same maintainer ends up
    // with a face on the card and a placeholder in the drawer beside it.
    // applist.php already answers this for the grid by deriving their GitHub
    // avatar from the repository's own URL, so the drawer is handed the same
    // picture, and an app the catalog knows no repository for falls back to
    // the owner of its own GitHub links. Only the placeholder is replaced: a
    // maintainer who has published an icon keeps the one they chose, and it is
    // held there against CA's error handler like every other picture is.
    function paintMaintainerIcon(img, app) {
      if (!img || img.__asgaMaint) return;
      img.__asgaMaint = true;
      var cur = img.getAttribute('src') || '';
      var url = (cur && cur.indexOf('question.png') < 0) ? cur : ((app && app.mi) || ghAvatarFor(app));
      if (!url || url.indexOf('question.png') >= 0) { avatarGlyph(img); return; }
      holdImage(img, url, avatarGlyph);
    }
    // Nothing anywhere holds a picture of this maintainer. The card answers
    // that with a person glyph rather than a question mark, and so does the
    // drawer: the image is swapped for the same drawn mark, keeping whichever
    // of CA's classes sized the box it stood in. In the profile drawer the
    // image is wrapped in a lightbox link, and that goes with it rather than
    // being left behind to open a full-screen question mark.
    function avatarGlyph(img) {
      var host = img;
      var link = img.parentNode;
      if (link && link.tagName === 'A' && link.classList.contains('screenshot')) host = link;
      if (!host.parentNode) return;
      var span = document.createElement('span');
      span.className = img.className + ' asga-avatar-glyph';
      span.title = 'This maintainer has published no picture';
      span.insertAdjacentHTML('afterbegin', PERSON_ICON);
      host.parentNode.replaceChild(span, host);
    }
    function fixMaintainerIcon() {
      if (!isOn()) return;
      // Identified by what the app drawer HAS rather than by what the profile
      // drawer is not. Only the app drawer carries a Maintainer card, so its
      // heading is proof enough on its own, and asking that question cannot
      // misfire the way excluding the other drawer could: isRepoDrawer() reads
      // a class this file writes and a button CA writes, and either being left
      // behind by a previous drawer was enough to skip a card that was sitting
      // right there.
      if (!document.querySelector('#sidenavContent .popupInfoLeft .popupAuthorTitle')) return;
      // The app record is what carries the derived avatar, but a drawer opened
      // for an app the grid does not hold (CA restoring one from its cookie,
      // say) still gets the placeholder taken off it, since the icon CA
      // rendered is usually right and only ever needs holding in place.
      paintMaintainerIcon(document.querySelector('#sidenavContent img.popupAuthorIcon'), drawerApp());
    }
    // Which app the open drawer is showing. CA restores a drawer from its own
    // cookie on a page load, which never goes through openSidebar(), so its own
    // record of what is open is the fallback.
    function drawerApp() {
      var path = openPath || (window.data && window.data.sidebarapppath) || '';
      for (var i = 0; i < APPS.length; i++) { if (APPS[i].p === path) return APPS[i]; }
      return null;
    }
    // Every app this maintainer publishes, as a scrollable list in place of the
    // repository bio. The catalogue is already in memory, so this needs no
    // request: the grid's own records carry the maintainer key (rn) that CA's
    // drawer is keyed by.
    // Twitter is X, and has been since 2023. CA still labels the link Twitter
    // and still draws the bird, both off its own .ca_twitter class: the glyph
    // is a FontAwesome ::before, so dropping the class is what removes it. The
    // mark that replaces it is inlined for the same reason every other icon in
    // this file is, so it draws in currentColor and follows the pill into the
    // accent on hover.
    var X_MARK = '<svg class="asga-x-mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
    function retwitter(a) {
      if (!a.classList.contains('ca_twitter')) return;
      a.classList.remove('ca_twitter');
      a.textContent = 'X';
      a.title = 'This maintainer on X';
      a.insertAdjacentHTML('afterbegin', X_MARK);
    }
    // Every app the open profile drawer's maintainer publishes. CA keys this
    // drawer by the repository name it prints as the title, and the grid's own
    // records carry that same key in rn, so the catalogue in memory answers
    // this without a request.
    function repoApps() {
      var nameEl = document.querySelector('#sidenavContent .popupName');
      var repo = nameEl ? nameEl.textContent.trim() : '';
      if (!repo) return [];
      var key = repo.toLowerCase();
      return APPS.filter(function (a) { return (a.rn || '').trim().toLowerCase() === key; });
    }
    function buildRepoApps(bio) {
      var mine = repoApps();
      if (!mine.length) return;   // nothing to show, leave CA's bio alone

      var list = document.createElement('div');
      list.className = 'asga-repo-apps';
      mine.sort(function (a, b) { return (a.sn || '').localeCompare(b.sn || ''); });
      mine.forEach(function (a) {
        var row = document.createElement('div');
        row.className = 'asga-repo-app';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.title = 'Show ' + a.n + ' in the app store';

        // Same four answers the grid's own card gets, from the same builder,
        // so a row here and a card out there can no more disagree about an
        // app's picture than they already can about its numbers.
        row.appendChild(appIcon(a, 'asga-repo-app-icon'));

        var text = document.createElement('div');
        text.className = 'asga-repo-app-text';
        var nm = document.createElement('div');
        nm.className = 'asga-repo-app-name';
        nm.textContent = a.n;
        var de = document.createElement('div');
        de.className = 'asga-repo-app-desc';
        de.textContent = a.de || '';
        text.appendChild(nm);
        text.appendChild(de);
        row.appendChild(text);

        // The same four facts the grid's own card carries, built by the same
        // two helpers, so a row here and a card out there can never disagree
        // about a number or a date. Stars and downloads ride at the top of the
        // right column and the two dates sit under them, which is the card's
        // own arrangement turned on its side.
        var badges = document.createElement('div');
        badges.className = 'asga-repo-app-badges';
        badges.appendChild(statSpan('asga-stat-stars', STAR_ICON, a.s, 'star', starTitle(a.s)));
        badges.appendChild(statSpan('asga-stat-dl', DL_ICON, a.dl, a.ty === 'plugin' ? 'install' : 'pull', downloadTitle(a.dl, a.ty, a.dz)));
        row.appendChild(badges);

        var dates = document.createElement('div');
        dates.className = 'asga-repo-app-dates';
        // Same pair in the same order the card uses, and the same answer for an
        // app that predates CA's records.
        var rowAdded = addedSpan(a);
        if (rowAdded) dates.appendChild(rowAdded);
        if (a.lu) dates.appendChild(dateSpan('asga-tile-updated', CLOCK_ICON, 'Updated', a.lu, a.lk !== 'r', a.lk === 'r'));
        row.appendChild(dates);

        // The row is the button now. A pill at the end of every row said Show
        // App as many times as the maintainer has apps and took the width the
        // figures above it needed; hovering the row fades the figures out and
        // this in, in the same place, so the card visibly becomes the control
        // rather than carrying one.
        var go = document.createElement('span');
        go.className = 'asga-repo-app-go';
        go.textContent = 'Show App';
        row.appendChild(go);

        function show() {
          flashPath = a.p;
          if (typeof window.closeSidebar === 'function') try { window.closeSidebar(); } catch (e2) {}
          var box = document.getElementById('searchBox');
          if (box) box.value = a.n;
          applySearch(a.n);
        }
        row.addEventListener('click', show);
        row.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); }
        });
        list.appendChild(row);
      });
      bio.parentNode.insertBefore(list, bio);
      bio.parentNode.removeChild(bio);
      // A scroll container takes its scrollbar out of its own content box, so
      // without this every row would end a scrollbar's width short of the
      // drawer's right edge while starting flush against the left one. Pulling
      // the box out by that same width puts the scrollbar in the drawer's own
      // gutter and hands the rows the full column back. Measured rather than
      // assumed: the width differs between browsers, and it is zero outright
      // when the user has overlay scrollbars or the list is short enough not
      // to scroll.
      var sbw = list.offsetWidth - list.clientWidth;
      if (sbw > 0) list.style.marginRight = (-sbw) + 'px';
    }

    // The two rows CA leaves out for anyone who does not publish Docker
    // containers. Its own counters are fed only by templates carrying a
    // Registry, so a maintainer of plugins alone gets neither row and a
    // maintainer of both gets a total that counts only half of what they make.
    // Both are answered here from the same dl figure the grid's cards print,
    // which covers a plugin's installs and a container's pulls alike, and CA's
    // own values are replaced rather than left beside ours so every profile
    // drawer reports the same six statistics on the same basis.
    //
    // The average divides by the apps that actually have a figure rather than
    // by all of them, which is CA's own definition: a maintainer whose newest
    // app has no count yet should not see their average fall because of it.
    //
    // a.rp is the owner/repo of the GitHub project an app is built from, and
    // a.s is that project's star count. Two templates by one maintainer often
    // package the SAME upstream project, so each distinct repository is
    // counted once rather than once per app: on a live catalog, "Firecrawl for
    // Unraid" publishes 5 apps that all point at one repository, and summing
    // per app reported 870,905 stars where the true figure is 174,181. 64 of
    // the 1,111 maintainers scanned are affected by this same duplication.
    //
    // The answer is null rather than 0 when nothing is known, which is what
    // keeps the row out of the table entirely: for a server with no GitHub
    // token configured every app's s is null, and for 258 of the 1,111
    // maintainers the scanner has matched no repository to any of their apps.
    function repoStarTotal(mine) {
      var seen = {}, total = 0, n = 0;
      for (var i = 0; i < mine.length; i++) {
        var a = mine[i];
        if (a.s == null || !a.rp) continue;
        if (seen[a.rp]) continue;
        seen[a.rp] = 1;
        total += a.s;
        n++;
      }
      return n ? total : null;
    }
    function fixRepoStats(mine) {
      var table = document.querySelector('#sidenavContent .repoTable');
      if (!table) return;
      var total = 0, counted = 0;
      mine.forEach(function (a) { if (a.dl > 0) { total += a.dl; counted++; } });
      if (counted) {
        setRepoRow(table, 'Total Known Downloads', total.toLocaleString());
        setRepoRow(table, 'Average Downloads Per App', Math.round(total / counted).toLocaleString());
      }
      // CA keeps no statistic on GitHub stars at all. This one lands directly
      // above Total Docker Applications, and the tooltip says plainly that it
      // totals the upstream projects a maintainer packages, not their own work.
      var stars = repoStarTotal(mine);
      if (stars != null) {
        var starRow = setRepoRow(table, 'Total GitHub Stars', stars.toLocaleString(), 'Total Docker Applications');
        if (starRow) starRow.title = 'Combined stars of the GitHub projects this maintainer packages, each project counted once. These are the upstream projects, not this maintainer\'s own repositories.';
      }
      // A count of zero is not a statistic, it is a row saying this maintainer
      // does not do a thing nobody asked whether they did. CA prints all three
      // regardless: its own guard on the language row is an isset() against a
      // variable it initialises to zero at the top, so the test can never fail.
      // Total Applications stays whatever it reads, because that one is the
      // headline the rest of the table qualifies.
      ['Total Docker Applications', 'Total Plugin Applications', 'Total Languages'].forEach(function (label) {
        dropRepoRowIfZero(table, label);
      });
    }
    // CA runs every label in this table through its own tr(), so a row is
    // recognised by asking tr() the same question rather than by matching the
    // English text, which would find nothing on a server in any other language.
    // Shared by setRepoRow and dropRepoRowIfZero, which used to each run this
    // same scan on their own.
    function repoRowByLabel(table, english) {
      var want = caLabel(english);
      for (var i = 0; i < table.rows.length; i++) {
        var left = table.rows[i].querySelector('.repoLeft');
        if (left && left.textContent.trim() === want) return table.rows[i];
      }
      return null;
    }
    // Where a statistic sits in this table is part of what it says, so a
    // caller building a new row can name beforeEnglish, the row it should land
    // above, rather than always landing at the bottom. Appending is the
    // fallback when that row is not present. Either way the row itself is
    // returned, so the caller can go on to set something CA's own markup has
    // no row for, such as a title tooltip.
    function setRepoRow(table, english, value, beforeEnglish) {
      var want = caLabel(english);
      var body = table.tBodies[0] || table;
      var row = repoRowByLabel(table, english);
      if (row) {
        var right = row.querySelector('.repoRight');
        if (right) { right.textContent = value; return row; }
      }
      var tr = document.createElement('tr');
      var td1 = document.createElement('td');
      td1.className = 'repoLeft';
      td1.textContent = want;
      var td2 = document.createElement('td');
      td2.className = 'repoRight';
      td2.textContent = value;
      tr.appendChild(td1);
      tr.appendChild(td2);
      // Inserted against the anchor's OWN parent rather than the tbody this
      // function would otherwise append to. The two are the same element on
      // every table CA emits, but insertBefore throws when they are not, and
      // this runs inside the drawer's mutation observer, where a throw would
      // take the rest of that pass with it and leave the panel held on Loading
      // until its failsafe fires.
      var anchor = beforeEnglish ? repoRowByLabel(table, beforeEnglish) : null;
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(tr, anchor);
      else body.appendChild(tr);
      return tr;
    }
    // CA runs every label in this table through its own tr(), so a row is found
    // by asking tr() the same question rather than by matching English text,
    // which would match nothing on a server in any other language.
    function dropRepoRowIfZero(table, english) {
      var row = repoRowByLabel(table, english);
      if (!row) return;
      var right = row.querySelector('.repoRight');
      var n = right ? right.textContent.replace(/[^0-9]/g, '') : '';
      if (n === '' || parseInt(n, 10) === 0) row.parentNode.removeChild(row);
    }

    // The two buttons inside CA's own drawer that swap it for another one:
    // Profile, and BACK. Neither went through the blank-until-finished hold
    // every opener on the grid's side already uses, so both of them dropped
    // the reader into CA's half-built markup and then moved it around under
    // them. Both wait now. BACK used to repaint from a stash instead, which
    // was the same false economy openSidebar has stopped making: CA's own
    // request runs behind any repaint and lands on top of it either way, so
    // all the stash ever did was show the reader one finished drawer and then
    // replace it with another.
    function wireDrawerNav() {
      if (document.body.__asgaDrawerNav) return;
      document.body.__asgaDrawerNav = true;
      document.addEventListener('click', function (e) {
        if (!isOn() || !e.target.closest) return;
        if (e.target.closest('#sidenavContent .repoPopup') ||
            e.target.closest('#sidenavContent .popUpBack')) holdDrawer();
      }, true);
    }
    // The maintainer profile drawer, tidied the same way the app drawer is.
    //
    // CA files the repository link as a row of its Statistics table, where it
    // is the only row with no value and the only thing in the table that is not
    // a number. It moves up to sit with See All Apps and Favourite, which is
    // where a link belongs. CA also emits CLOSE before BACK, so BACK lands to
    // the right of the close control; the order is flipped in CSS rather than
    // by moving nodes, since both are CA's own markup.
    function fixRepoDrawer() {
      if (!isOn()) return;
      var bio = document.querySelector('#sidenavContent .popupRepoDescription');
      if (!bio) return;
      var host = bio.parentNode;
      if (!host || host.__asgaRepo) return;
      host.__asgaRepo = true;
      // The stylesheet keys the whole profile-drawer theme off this class rather
      // than off .popupRepoDescription, because buildRepoApps below deletes that
      // bio element and every :has() rule that named it would die with it. CA
      // replaces the children of #sidenavContent on each open, so this marker
      // cannot leak into the next app drawer.
      host.classList.add('asga-repo-drawer');
      watchTone(document.querySelector('#sidenavContent .popupIcon img'));
      var actions = document.querySelector('#sidenavContent .ca_repoSearchPopUp');
      actions = actions && actions.parentNode;
      if (!actions) return;
      // CA only prints the Repository URL row when the server is in its own
      // developer mode, so on an ordinary install everything below this used
      // to be unreachable: the whole function returned the moment the link was
      // missing. Now the only thing that depends on the link is the link.
      var link = document.querySelector('#sidenavContent .repoTable a.popUpLink');
      if (link) {
        var row = link.closest ? link.closest('tr') : null;
        var btn = document.createElement('a');
        btn.className = 'caButton asga-repo-url';
        btn.href = link.getAttribute('href') || '#';
        btn.target = '_blank';
        btn.rel = 'noopener';
        btn.textContent = link.textContent.trim() || 'Repository';
        btn.title = 'Open this maintainer\'s repository';
        actions.appendChild(btn);
        if (row && row.parentNode) row.parentNode.removeChild(row);
      }

      // See All Apps reads Show All Apps, to pair with the Show App button on
      // each row of the list below: one shows the whole catalogue filtered to
      // this maintainer, the other shows a single app.
      var allBtn = document.querySelector('#sidenavContent .ca_repoSearchPopUp');
      if (allBtn && /see all apps/i.test(allBtn.textContent)) allBtn.textContent = 'Show All Apps';

      // Web Page, Forum Profile and the rest are the maintainer's own links.
      // CA files them in a block of their own below the bio, which left the
      // header holding three buttons and a second run floating further down.
      // They join the header run so every action for this maintainer is in one
      // place, and the empty wrapper goes with them.
      var linkArea = document.querySelector('#sidenavContent .repoLinkArea');
      if (linkArea) {
        var links = [].slice.call(linkArea.querySelectorAll('a.appIconsPopUp'));
        links.forEach(function (a) { retwitter(a); actions.appendChild(a); });
        // CA nests the whole Statistics block inside .repoLinks alongside the
        // link area, so the wrapper only goes when moving the links out has
        // genuinely emptied it. The old test asked whether any anchor was
        // left, which the Repository URL row above had already taken away, and
        // the statistics table went out of the drawer with it.
        var wrap = linkArea.closest ? linkArea.closest('.repoLinks') : null;
        if (linkArea.parentNode) linkArea.parentNode.removeChild(linkArea);
        if (wrap && !wrap.children.length && wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }

      // The bio CA prints here is whatever the maintainer wrote about their
      // repository, which on this drawer answers a question nobody asked: the
      // reason to open a maintainer is to see what they make. It is replaced by
      // the list of their apps, each with its icon, name, blurb and a way
      // through to it.
      var mine = repoApps();
      // The profile drawer's own header icon is the same repository picture, so
      // it takes the same fallback. Any one of this maintainer's apps carries
      // it, since mi is a property of the repository rather than of the app.
      // Called even when the grid holds none of their apps: with no record to
      // read a face off, the placeholder still becomes this plugin's own person
      // glyph rather than a Docker question mark.
      paintMaintainerIcon(document.querySelector('#sidenavContent .popupIcon img'), mine[0] || null);
      fixRepoStats(mine);
      buildRepoApps(bio);
    }
    function fixDrawerDetails() {
      if (!isOn()) return;
      var table = document.querySelector('#sidenavContent .popupTable.contents');
      // Marked in the DOM rather than with a property on the node. This
      // function ADDS rows, so running it twice on one table is two Last
      // Update rows and two GitHub stars rows, and a property is exactly the
      // kind of mark that goes missing: it is lost the moment the markup is
      // written back through innerHTML, which is how a drawer restored from a
      // stash used to arrive already carrying our rows while looking untouched.
      // An attribute is part of the markup and survives that round trip.
      if (!table || table.getAttribute('data-asga-details')) return;
      table.setAttribute('data-asga-details', '1');
      var app = drawerApp();
      if (!app) return;

      // Added is the third row CA emits and is the only one always present, so
      // it is found by position. Matching its label would break on every
      // non-English server, since CA runs every one of these through tr().
      var addedRow = table.rows.length > 2 ? table.rows[2] : null;
      var addedCell = addedRow && addedRow.querySelector('.popupTableRight');
      if (addedCell && app.fs) {
        addedCell.textContent = absDate(app.fs, false) + ageBracket(app.fs, false);
        addedCell.title = absDate(app.fs, app.fs > 1433649600);
      }

      // The Last Update row is found by the id CA hangs on it rather than by
      // its label, for the same translation reason. This whole block is
      // skippable rather than an early return, because stars and downloads
      // below still need to run even on the apps that qualify for neither a
      // CA row nor a built one.
      var span = table.querySelector('td.popupTableRight span[id^="template"]');
      var luRow = span ? span.parentNode.parentNode : null;
      if (span) span.removeAttribute('id');
      // CA omits this row for plugins, and for any app pinned to a tag other
      // than :latest, because the only date CA has is the repository's rather
      // than that tag's. Both now have a real answer here: a plugin's version
      // number IS its release date, and lastupdate.php resolves the exact tag
      // from the registry rather than the repository, so the row is built in
      // both cases.
      if (!luRow && ((app.lu && app.lk === 'v') || (app.ty === 'docker' && app.ri))) luRow = buildDetailRow(table, 'Last Update');
      if (luRow) {
        var luCell = luRow.querySelector('.popupTableRight');
        if (luCell) {
          // CA labels this one row "Last Update:" while every other row in the
          // table goes without a colon. Sitting three rows down that was easy
          // to miss; directly under Added it is the only punctuation in the
          // column.
          var luLabel = luRow.querySelector('.popupTableLeft');
          if (luLabel) luLabel.textContent = luLabel.textContent.replace(/\s*:\s*$/, '');
          if (addedRow && addedRow.parentNode) addedRow.parentNode.insertBefore(luRow, addedRow.nextSibling);
          if (app.lu) setLuCell(luCell, app.lu, app.lk);
          else resolveLastUpdate(app, luCell);
        }
      }

      // The maintainer belongs with the app's identity, not filed under the
      // change log. CA emits it as the second card inside .popupInfoSection,
      // after Details, which puts it below the Attention notice and the
      // statistics. Moved up to sit directly under the description, above
      // Attention, so who made this is answered before anything is said about
      // it. Matched by the heading it contains rather than by position, since
      // CA omits the whole card for an app with no repository.
      var maint = document.querySelector('#sidenavContent .popupInfoLeft:has(.popupAuthorTitle)');
      var desc = document.querySelector('#sidenavContent .popupDescription');
      if (maint && desc && desc.parentNode) desc.parentNode.insertBefore(maint, desc.nextSibling);

      // Stars then downloads, directly under whichever of Last Update / Added
      // is the last row placed above, so the run reads as one story: when it
      // arrived, when it last changed, how popular it is upstream, how popular
      // it is here. insertBefore against the anchor's own nextSibling each
      // time keeps the second insert from pushing the first out of order.
      var anchor = luRow || addedRow;
      if (anchor && anchor.parentNode && app.s != null) {
        var starRow = buildDetailRow(table, 'GitHub stars');
        anchor.parentNode.insertBefore(starRow, anchor.nextSibling);
        var starCell = starRow.querySelector('.popupTableRight');
        starCell.textContent = app.s.toLocaleString();
        starCell.title = starTitle(app.s);
        anchor = starRow;
      }
      if (anchor && anchor.parentNode && app.dl > 0) {
        var dlRow = rowByLabel(table, 'Downloads') || buildDetailRow(table, 'Downloads');
        anchor.parentNode.insertBefore(dlRow, anchor.nextSibling);
        var dlCell = dlRow.querySelector('.popupTableRight');
        dlCell.textContent = app.dl.toLocaleString();
        dlCell.title = downloadTitle(app.dl, app.ty, app.dz);
      }
    }
    // 721 templates name a readme and neither this grid nor CA's own drawer
    // ever linked it. It joins the run of actions in the drawer header, as
    // CA's own markup would have written it, so it reads as one more thing you
    // can do with the app rather than as something bolted on.
    function addReadmeButton() {
      if (!isOn() || isRepoDrawer()) return;
      var info = document.querySelector('#sidenavContent .popupInfo');
      if (!info || info.querySelector('.asga-readme-btn')) return;
      var app = drawerApp();
      if (!app || !app.rm) return;
      var btn = document.createElement('a');
      btn.className = 'caButton asga-readme-btn';
      btn.href = app.rm;
      btn.target = '_blank';
      btn.rel = 'noopener';
      btn.textContent = 'Readme';
      btn.title = 'Open this app\'s readme in a new tab';
      info.appendChild(btn);
    }
    // Five sections of this drawer arrive as a bare heading with loose text
    // sitting under it, while every other section (Description, Maintainer,
    // Details, Spotlight, the moderator comment) sits inside a grey card, so
    // the drawer read as two different designs stacked on top of each other.
    // CA emits Additional Requirements, the Trends chart, a changelog, the
    // Template Errors block and the maintainer profile's Statistics table as
    // flat siblings with no container of their own, so there is nothing for a
    // stylesheet to select and the wrapper has to be built by hand instead.
    //
    // A section runs from its heading down to the element before the next
    // thing that is either another heading or a block that already stands on
    // its own, and SECTION_STOP names that whole set. The test asks whether
    // the next element IS one of those or CONTAINS one, because CA wraps the
    // Details table in an unclassed div and the closing "statistics gathered
    // every 30 days" footnote in another, and a plain SECTION_STOP match
    // against the element itself would miss both of those wrapper divs even
    // though neither belongs inside the section sitting above it.
    //
    // It needs no idempotency flag of its own. Wrapping moves the heading out
    // of the host's direct children and into the new card, so a second pass
    // over host.children simply does not find it there again, which matters
    // because this runs on every mutation of the drawer.
    var SECTION_HEADS = '.additionalRequirementsHeader, .chartTitle, .changelogTitle, .templateErrors, .repoStats';
    var SECTION_STOP = SECTION_HEADS + ', .ca_popupIconArea, .popupCloseArea, .popupDescription, .popupInfoLeft, .popupInfoSection, .spotlightPopup, .modComment, .ca_note';
    function cardSections() {
      if (!isOn()) return;
      // Two hosts, not one. The app drawer hangs its sections off .popupContent,
      // but the maintainer profile puts its Statistics heading and table inside
      // a .repoLinks of their own, a sibling of that element rather than a child
      // of it, so a scan of one host walked straight past the profile drawer's
      // only section and left it the last split card in the plugin.
      var hosts = [
        document.querySelector('#sidenavContent .popupContent') || document.querySelector('#sidenavContent .popup'),
        document.querySelector('#sidenavContent .repoLinks')
      ];
      for (var h = 0; h < hosts.length; h++) if (hosts[h]) cardSectionsIn(hosts[h]);
    }
    function cardSectionsIn(host) {
      var kids = [].slice.call(host.children);
      for (var i = 0; i < kids.length; i++) {
        var head = kids[i];
        if (!head.matches || !head.matches(SECTION_HEADS)) continue;
        var card = document.createElement('div');
        card.className = 'asga-card';
        head.parentNode.insertBefore(card, head);
        var el = head;
        while (el) {
          var next = el.nextElementSibling;
          card.appendChild(el);
          if (!next) break;
          if (next.matches(SECTION_STOP) || next.querySelector(SECTION_STOP)) break;
          el = next;
        }
      }
    }
    // CA's own markup for a Details row, so the drawer's stylesheet applies to
    // this one exactly as it does to the rows CA wrote. The label loses CA's
    // trailing colon, which no other row in the table carries. Shared by the
    // Last Update, GitHub stars and Downloads rows, since all three are this
    // same two-cell shape with only the label differing.
    function buildDetailRow(table, label) {
      var tr = document.createElement('tr');
      var td1 = document.createElement('td');
      td1.className = 'popupTableLeft';
      td1.textContent = label;
      var td2 = document.createElement('td');
      td2.className = 'popupTableRight';
      tr.appendChild(td1); tr.appendChild(td2);
      (table.tBodies[0] || table).appendChild(tr);
      return tr;
    }
    function ageBracket(ts, dayOnly) {
      var rel = relDate(ts, dayOnly);
      return rel ? ' (' + rel + ')' : '';
    }
    function setLuCell(cell, ts, kind) {
      cell.textContent = absDate(ts, false) + ageBracket(ts, kind !== 'r');
      cell.title = kind === 'v'
        ? 'Release date of this plugin\'s current version, read from the version number itself.'
        : 'When this app\'s image was last published to its container registry.\n' + absDate(ts, true);
    }
    // Nothing in CA's feed, so ask the registry that actually hosts the image.
    // The answer is written back onto the catalog entry as well, so the app's
    // own card carries the date the next time the grid repaints.
    function resolveLastUpdate(app, cell) {
      var ref = app.ri || '';
      if (!ref || app.ty !== 'docker') { cell.textContent = 'Unknown'; return; }
      var done = function (ts) {
        // the drawer can be closed or already showing another app by the time
        // this lands, and writing into a detached cell would be invisible at
        // best and wrong at worst
        if (!document.contains(cell)) return;
        if (!ts) { cell.textContent = 'Unknown'; return; }
        app.lu = ts; app.lk = 'r';
        setLuCell(cell, ts, 'r');
      };
      if (regDates[ref] != null) { done(regDates[ref]); return; }
      cell.textContent = 'Checking…';
      fetch(PREFIX + 'lastupdate.php?repo=' + encodeURIComponent(ref))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { var ts = (j && j.ts) || 0; regDates[ref] = ts; done(ts); })
        .catch(function () { regDates[ref] = 0; done(0); });
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
      if (tile.getAttribute('data-incompatible')) return;
      if (ty === 'plugin') {
        // plugins: let CA drive its own plugin install (its flow differs from docker)
        openSidebar(p, tile.getAttribute('data-appname'));
        return;
      }
      // Nothing to install into, or nothing that would run if there were. The
      // card already says which, so this is a silent refusal rather than a
      // second telling.
      if (!docker.running) return;

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

    // A real arrival date for the apps CA never recorded one for. Its own value
    // for those is a constant its skin manufactures, so asking is worth a
    // request: addeddate.php reads the oldest dated entry of a plugin's own
    // changelog, and answers -1 when the changelog cannot prove it reaches a
    // first release. The answers are cached on flash, so this costs a request
    // once per app for the life of the install.
    var addedMap = {};
    var addedPending = {};
    var addedTimer = null;
    function queueAdded(a) {
      if (!a || a.fx !== 1 || !a.p) return;
      if (addedMap[a.p] !== undefined) return;
      addedPending[a.p] = true;
      if (!addedTimer) addedTimer = setTimeout(flushAdded, 200);
    }
    function flushAdded() {
      addedTimer = null;
      var paths = Object.keys(addedPending);
      if (!paths.length) return;
      var batch = paths.slice(0, 60);
      fetch(PREFIX + 'addeddate.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p: batch })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          batch.forEach(function (p) {
            addedMap[p] = (j && j[p] !== undefined) ? j[p] : -1;
            delete addedPending[p];
            repaintAdded(p);
          });
          if (Object.keys(addedPending).length && !addedTimer) addedTimer = setTimeout(flushAdded, 200);
        })
        .catch(function () {
          // the endpoint is missing or the server refused; the queue is dropped
          // rather than asked again on every render
          batch.forEach(function (p) { addedMap[p] = -1; delete addedPending[p]; repaintAdded(p); });
        });
    }
    // The card was drawn before the answer arrived, so the one date it could be
    // wrong about is replaced in place. Same tile-lookup form paintFilledDate
    // uses for the Updated half of the footer: CSS.escape guards the path
    // going into the attribute selector, and the whole thing is a no-op when
    // the tile isn't on screen any more (paged away, or never in the grid, as
    // buildRepoApps' maintainer-drawer rows are).
    function repaintAdded(p) {
      if (typeof CSS === 'undefined' || !CSS.escape) return;
      var tile = document.querySelector('#asga-grid .asga-tile[data-apppath="' + CSS.escape(p) + '"]');
      if (!tile) return;
      var old = tile.querySelector('.asga-tile-added');
      var a = null;
      for (var i = 0; i < APPS.length; i++) { if (APPS[i].p === p) { a = APPS[i]; break; } }
      if (!a) return;
      var fresh = addedSpan(a);
      if (!fresh) { if (old) old.remove(); return; }
      if (old) old.replaceWith(fresh);
      else {
        var dates = tile.querySelector('.asga-tile-dates');
        if (dates) dates.insertBefore(fresh, dates.firstChild);
      }
    }

    // applist.php already applies CA's own floor to FirstSeen, so every app has
    // a date here and it is the same date CA's stock drawer prints. The time of
    // day is asked for only above that floor: below it the clock reads whatever
    // CA's constant happens to encode rather than anything that happened.
    function addedSpan(a) {
      // Not one of the apps CA lost the date for: its own value stands.
      if (a.fx !== 1) {
        if (!a.fs) return null;
        return dateSpan('asga-tile-added', CAL_ICON, 'Added', a.fs, false, a.fs > 1433649600);
      }
      queueAdded(a);
      var resolved = addedMap[a.p];
      // The plugin's own changelog said when it was first released. That is a
      // date somebody published, not one inferred from anything.
      if (resolved > 0) {
        var s = dateSpan('asga-tile-added', CAL_ICON, 'Added', resolved, true, false);
        s.title = 'First released ' + absDate(resolved, false) + ', read from this plugin’s own changelog. The app catalog holds no record of when it was added.';
        return s;
      }
      // Failing that, the repository it is built from has a birthday, which is
      // the earliest the app can possibly have existed.
      if (resolved !== undefined && a.ca) {
        var g = dateSpan('asga-tile-added', CAL_ICON, 'Added', a.ca, true, false);
        g.title = 'Source repository created ' + absDate(a.ca, false) + '. The app catalog holds no record of when this app was added, and this is the earliest it can have existed.';
        return g;
      }
      // Nothing anywhere holds it. The field stays rather than the card growing
      // a gap its neighbours do not have, and it says so plainly instead of
      // printing the date CA manufactures for these.
      if (resolved !== undefined) {
        var u = document.createElement('span');
        u.className = 'asga-tile-added asga-stat-none';
        u.insertAdjacentHTML('afterbegin', CAL_ICON);
        u.title = 'The app catalog holds no record of when this app was added';
        var t = document.createElement('span');
        t.className = 'asga-datetext';
        t.textContent = 'Unknown';
        u.appendChild(t);
        return u;
      }
      // The answer has not come back yet. CA's own value holds the slot so the
      // footer does not jump, and repaintAdded replaces it the moment it does.
      return dateSpan('asga-tile-added', CAL_ICON, 'Added', a.fs, false, false);
    }

    // Why this app is in the results. The search reads an app's whole overview,
    // and the card only ever prints the first sentence or two of it, so a
    // result could match on a passage the reader cannot see and the list then
    // looks like it is returning anything at all. When the words that matched
    // are not in what the card would print, the card prints the passage that
    // did instead, with those words marked. The snippet is cut on word
    // boundaries so it never opens or closes mid-word.
    function matchSnippet(a, words) {
      if (!words.length) return null;
      var shown = (a.de || '').toLowerCase();
      var missing = words.filter(function (w) { return shown.indexOf(w) < 0; });
      if (!missing.length) return null;              // the card already shows why
      var full = ((a.de || '') + ' ' + (a.sx || '')).replace(/\s+/g, ' ').trim();
      var hay = full.toLowerCase();
      var at = -1;
      for (var i = 0; i < missing.length && at < 0; i++) at = hay.indexOf(missing[i]);
      if (at < 0) return null;                        // matched a field, not the prose
      var start = Math.max(0, at - 60);
      var end = Math.min(full.length, at + 120);
      if (start > 0) { var sp = full.indexOf(' ', start); if (sp > -1 && sp < at) start = sp + 1; }
      if (end < full.length) { var ep = full.lastIndexOf(' ', end); if (ep > at) end = ep; }
      return (start > 0 ? '…' : '') + full.slice(start, end) + (end < full.length ? '…' : '');
    }

    // Built as text nodes and marked spans rather than as a string of markup,
    // because every character of this came out of a public feed and none of it
    // may be parsed as HTML.
    function fillSnippet(el, text, words) {
      el.textContent = '';
      var low = text.toLowerCase();
      var marks = [];
      words.forEach(function (w) {
        var from = 0, at;
        while ((at = low.indexOf(w, from)) > -1) { marks.push([at, at + w.length]); from = at + w.length; }
      });
      if (!marks.length) { el.textContent = text; return; }
      marks.sort(function (x, y) { return x[0] - y[0]; });
      var merged = [marks[0]];
      for (var i = 1; i < marks.length; i++) {
        var last = merged[merged.length - 1];
        if (marks[i][0] <= last[1]) last[1] = Math.max(last[1], marks[i][1]);
        else merged.push(marks[i]);
      }
      var pos = 0;
      merged.forEach(function (m) {
        if (m[0] > pos) el.appendChild(document.createTextNode(text.slice(pos, m[0])));
        var hit = document.createElement('span');
        hit.className = 'asga-hit';
        hit.textContent = text.slice(m[0], m[1]);
        el.appendChild(hit);
        pos = m[1];
      });
      if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
    }

    // CA files a category as space separated tokens, each either a parent with a
    // trailing colon or a parent and child joined by one: "Other: Productivity:
    // Tools:Utilities Plugins:". The trailing colons are punctuation marking the
    // end of a token rather than part of a name, so they come off, and what is
    // left reads as the list it always was.
    function allCategories(cf) {
      if (!cf) return '';
      return String(cf).split(/\s+/).filter(Boolean)
        .map(function (t) { return t.replace(/:+$/, ''); })
        .filter(Boolean).join(', ');
    }

    // Which app the reader just asked to be shown, so the grid can point at it.
    // A search for an app's name can return a dozen cards and nothing in the
    // result says which one was asked for, so the one that was gets marked and
    // the mark is cleared the moment the reader looks anywhere else.
    var flashPath = '';
    function clearFlash() {
      if (!flashPath) return;
      flashPath = '';
      var lit = document.querySelectorAll('#asga-grid .asga-tile.asga-flash');
      for (var i = 0; i < lit.length; i++) lit[i].classList.remove('asga-flash');
    }
    function wireFlashDismiss() {
      if (document.body.__asgaFlash) return;
      document.body.__asgaFlash = true;
      // Capture, so a click that lands on a card and opens its drawer still
      // clears the mark on the way through rather than leaving it lit behind
      // the panel.
      document.addEventListener('click', clearFlash, true);
    }

    function makeTile(a) {
      var tile = document.createElement('div');
      tile.className = 'asga-tile';
      if (flashPath && a.p === flashPath) tile.classList.add('asga-flash');
      tile.setAttribute('data-apppath', a.p);
      tile.setAttribute('data-appname', a.n);
      if (a.rn) tile.setAttribute('data-repo', a.rn);
      if (a.pr) tile.setAttribute('data-project', a.pr);
      if (a.su) tile.setAttribute('data-support', a.su);
      if (a.ri) { tile.setAttribute('data-pinrepo', a.ri); tile.setAttribute('data-pinname', a.pn || a.n); }
      tile.setAttribute('data-type', a.ty || 'docker');
      if (a.xc) tile.setAttribute('data-incompatible', '1');
      if (a.pu) tile.setAttribute('data-plugurl', a.pu);
      if (a.rq) tile.setAttribute('data-requires', a.rq);
      if (a.po && a.po.length) tile.setAttribute('data-ports', a.po.join(','));
      tile.title = a.n;

      // header: icon + name/author/category
      var head = document.createElement('div');
      head.className = 'asga-tile-head';

      var iconWrap = document.createElement('div');
      iconWrap.className = 'asga-tile-icon';
      iconWrap.appendChild(appIcon(a, ''));
      head.appendChild(iconWrap);


      var htext = document.createElement('div');
      htext.className = 'asga-tile-htext';
      var nameRow = document.createElement('div');
      nameRow.className = 'asga-tile-namerow';
      var name = document.createElement('div');
      name.className = 'asga-tile-name';
      name.textContent = a.n;
      // The name is one line now and ellipsises rather than wrapping, so the
      // hover has to be able to give back what the line could not fit. Set on
      // the name itself rather than relying on the card's own title, the same
      // way the category line below answers for the categories it clipped.
      name.title = a.n;
      nameRow.appendChild(name);
      // The catalog carries several competing templates for some apps, and
      // official is the one fact that separates them, so it belongs where the
      // eye already is, beside the name, rather than in a drawer nobody opens
      // to compare two cards. 394 apps are official and 211 are pre-release.
      if (a.of) nameRow.appendChild(mkFlag('Official', 'asga-flag-official',
        'Published by the people who make this software, rather than repackaged by a third party'));
      if (a.bt) nameRow.appendChild(mkFlag('Beta', 'asga-flag-beta',
        'The maintainer marks this template as pre-release'));
      htext.appendChild(nameRow);
      // The maintainer wears their own face. CA publishes an icon for 671 of
      // its 1182 repositories and the rest fall back to a person glyph, which
      // is the shape this line always had; the picture is simply better at
      // saying which of two similarly named maintainers this is.
      if (a.au) {
        var au = document.createElement('div');
        au.className = 'asga-tile-author';
        if (a.mi) {
          var av = document.createElement('img');
          av.className = 'asga-tile-avatar';
          av.src = a.mi;
          av.loading = 'lazy';
          av.alt = '';
          av.onerror = function (e) {
            // Same hijack the tile icon above guards against, and the same
            // guard. What is left behind is the person glyph the branch below
            // draws for a maintainer with no picture at all, so a face that
            // fails to load reads as one that was never published rather than
            // as a hole in the line.
            if (e && e.stopImmediatePropagation) e.stopImmediatePropagation();
            var line = this.parentNode;
            this.remove();
            if (line && !line.querySelector('.asga-bicon')) line.insertAdjacentHTML('afterbegin', PERSON_ICON);
          };
          au.appendChild(av);
        } else {
          au.insertAdjacentHTML('afterbegin', PERSON_ICON);
        }
        var aun = document.createElement('span');
        aun.className = 'asga-tile-authorname';
        aun.textContent = a.au;
        au.appendChild(aun);
        htext.appendChild(au);
      }
      // CA files a category as "Parent: Child, Child". The parent is the part
      // worth reading first, so it carries the weight and the children trail
      // after it muted, rather than the whole string arriving at one strength.
      var cat = document.createElement('div');
      cat.className = 'asga-tile-cat';
      cat.insertAdjacentHTML('afterbegin', TAG_ICON);
      var raw = a.ct || '';
      // The line the card prints is a label applist.php already shortened, so a
      // card filed under five categories reads "and 2 more" and the tooltip,
      // asked the same question, answered "and 2 more" as well. The tooltip is
      // built from cf instead, CA's own untouched category string, which is
      // never clipped: every category the app is filed under, in full.
      if (a.cf || raw) cat.title = allCategories(a.cf) || raw;
      var colon = raw.indexOf(':');
      if (colon > 0) {
        var lead = document.createElement('span');
        lead.className = 'asga-tile-catlead';
        lead.textContent = raw.slice(0, colon + 1);
        var rest = document.createElement('span');
        rest.className = 'asga-tile-catrest';
        rest.textContent = raw.slice(colon + 1);
        cat.appendChild(lead);
        cat.appendChild(rest);
      } else {
        var only = document.createElement('span');
        only.className = 'asga-tile-catrest';
        only.textContent = raw;
        cat.appendChild(only);
      }
      htext.appendChild(cat);
      head.appendChild(htext);

      // The two figures move out of the corner badge they used to float in and
      // into a column of their own, ruled off from the text. A badge had room
      // for an abbreviated number and nothing else, so a card could show "22k"
      // without ever saying 22 thousand what; given a column, each figure gets
      // the word underneath it.
      var stats = document.createElement('div');
      stats.className = 'asga-tile-stats';
      stats.appendChild(statTile('asga-tile-stat-stars', STAR_MARK, a.s, 'Stars', starTitle(a.s)));
      stats.appendChild(statTile('asga-tile-stat-dl', DL_MARK, a.dl, a.ty === 'plugin' ? 'Installs' : 'Downloads', downloadTitle(a.dl, a.ty, a.dz)));
      tile.appendChild(head);
      // Appended to the card rather than to the header: the stylesheet places
      // it in a column of the card that spans both the header and the
      // description, which is what lets the rule beside it run the full height
      // of the two rather than stopping at the header's own bottom edge.
      tile.appendChild(stats);

      // description (verbiage)
      // Always appended, even empty. The card is a four-band subgrid and each
      // band occupies one of the grid's own row tracks, so a card that skipped
      // its description would slide every band below it up a track and stop
      // lining up with its neighbours.
      var desc = document.createElement('div');
      desc.className = 'asga-tile-desc';
      var snip = matchSnippet(a, searchWords());
      if (snip) { desc.classList.add('asga-tile-desc-hit'); fillSnippet(desc, snip, searchWords()); }
      else desc.textContent = a.de || '';
      tile.appendChild(desc);

      // Why Install is off. It goes INSIDE the description band rather than
      // becoming a fifth child, because the card spans exactly four of the
      // grid's row tracks and an extra top-level element would push the button
      // row out of its track on blocked cards only.
      if (blocked(a)) {
        tile.classList.add('asga-tile-blocked');
        var note = document.createElement('div');
        note.className = 'asga-tile-blocked-note';
        note.textContent = blockReason(a) + ', install unavailable';
        // Ahead of the blurb, not after it. The band is clamped to two lines
        // and the clamp counts this note as one of them, so appended it landed
        // on line three of any app whose blurb already filled both and was
        // clipped away unseen: the card dimmed Install and gave no reason at
        // all, which on the 36 apps CA marks incompatible is the whole message.
        desc.insertBefore(note, desc.firstChild);
      }

      // Info / Pin / Project / Support / Install buttons (Project + Support are
      // direct links, no submenu)
      var btns = document.createElement('div');
      btns.className = 'asga-tile-btns';
      btns.appendChild(mkBtn('Info', 'asga-info', INFO_ICON));
      if (a.ri) {
        var isPinned = pinnedSet && pinnedSet.has(a.ri + '&' + (a.pn || ''));
        var pb = mkBtn(isPinned ? 'Unpin' : 'Pin App', 'asga-pin', PIN_ICON);
        if (isPinned) pb.classList.add('asga-pinned');
        btns.appendChild(pb);
      }
      // Project always renders, greyed out when the template carries no link,
      // so every card in a row has the same buttons in the same places rather
      // than a row of cards whose button count varies. 347 of the 3,889 apps
      // in the feed have no Project URL at all: their template simply never
      // declared one, which CA answers by leaving the entry out of its own
      // Support menu entirely.
      var prBtn = mkBtn('Project', 'asga-project', PROJECT_ICON);
      if (!a.pr) {
        prBtn.classList.add('asga-btn-off');
        prBtn.title = 'This app\'s template does not list a project page';
      }
      btns.appendChild(prBtn);
      // Support gets the same treatment for the same reason, on the 198 apps
      // whose template names no support thread.
      var suBtn = mkBtn('Support', 'asga-support', SUPPORT_ICON);
      if (!a.su) {
        suBtn.classList.add('asga-btn-off');
        suBtn.title = 'This app\'s template does not list a support thread';
      }
      btns.appendChild(suBtn);
      // Straight to the maintainer's own drawer, the one the app drawer's
      // Profile button opens. Labelled Repo rather than Maintainer because the
      // drawer it opens is titled "<name>'s Repository" and the word has to fit
      // a card pill beside five others.
      var mtBtn = mkBtn('Repo', 'asga-maint', REPO_ICON);
      if (a.rn) {
        mtBtn.title = 'Open ' + a.rn;
      } else {
        mtBtn.classList.add('asga-btn-off');
        mtBtn.title = 'This app\'s template names no maintainer repository';
      }
      btns.appendChild(mtBtn);
      // An app already on this server has nothing for Install to do, so it gets
      // a plain marker instead. asga-btn-installed matches none of the click
      // handler's button branches, which is what leaves a click on it falling
      // through to the Info/Install drawer like the rest of the card.
      if (a.ri && installedSet && installedSet.has(stripTag(a.ri))) {
        var instBtn = mkBtn('Installed', 'asga-btn-installed', INSTALL_ICON);
        instBtn.title = 'Already installed on this server';
        btns.appendChild(instBtn);
      } else {
        var ib = mkBtn('Install', 'asga-install', INSTALL_ICON);
        // Docker down: the card still lists the app and still opens its Info
        // drawer, only Install is off, exactly as CA behaves.
        if (blocked(a)) {
          ib.classList.add('asga-btn-off');
          ib.title = blockReason(a) + ', this app cannot be installed';
        }
        btns.appendChild(ib);
      }

      // when CA's feed first saw this app, and when the app itself last shipped.
      // These used to print as full sentences ("Added Jun 21, 2025 (14 months
      // ago)"), which no longer fits across a 340px card; now it's an icon plus
      // the age, and the exact date (with time of day) moves to the tooltip.
      // Both halves are appended even when their date is unknown, so a card
      // that knows only one of the two reserves the same footer line as its
      // neighbours and every button row in a grid row still bottom-aligns.
      var dates = document.createElement('div');
      dates.className = 'asga-tile-dates';
      // The card's actual footer now: two dates and what kind of app this is,
      // left aligned, directly under the buttons. Stars and downloads used to
      // ride here too, as a run of four facts, which is why this band once had
      // to fit that many; they moved up into the header's own stat column, so
      // the footer only ever has to hold the two dates and the kind icon.
      // Added leads and Updated follows: when an app arrived is the more stable
      // of the two facts and the one the eye should land on first. A date the
      // catalog holds nothing at all for still takes no room rather than
      // printing a word where a date belongs.
      var added = addedSpan(a);
      if (added) dates.appendChild(added);
      if (a.lu) dates.appendChild(dateSpan('asga-tile-updated', CLOCK_ICON, 'Updated', a.lu, a.lk !== 'r', a.lk === 'r'));
      // What kind of app this is, at the far end of the same row the two date
      // icons sit on, so every icon along the card's bottom shares one line.
      var kind = document.createElement('span');
      kind.className = 'asga-tile-kind';
      kind.insertAdjacentHTML('beforeend', (a.ty === 'plugin') ? PLUGIN_ICON : DOCKER_ICON);
      if (a.pv) {
        var priv = document.createElement('span');
        priv.className = 'asga-tile-priv';
        priv.title = 'This container runs privileged, with elevated access to the host';
        priv.insertAdjacentHTML('beforeend', PRIV_ICON);
        dates.appendChild(priv);
      }
      dates.appendChild(kind);
      // Buttons directly under the description, dates last along the bottom
      // left. The 10px row-gap that used to separate the dates from the buttons
      // now separates the description from them, unchanged, because the gap
      // belongs to the grid rather than to either band.
      tile.appendChild(btns);
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
    // How long ago, expressed in one unit, at any distance. This used to stop
    // at 30 days and return nothing, because a bare "94 days ago" reads worse
    // than a date and the caller printed the date instead. Now that both are
    // always shown together (see setLuCell), the interval is the gloss rather
    // than the whole answer, and a coarse "3 months ago" is exactly what it
    // should say at that distance.
    // dayOnly is for a value that was only ever a day, such as a plugin's
    // date-formed version number. Its clock reads midnight because that is what
    // a bare date parses to, not because anything happened then, so those never
    // report hours or minutes.
    function relDate(ts, dayOnly) {
      var now = Math.floor(Date.now() / 1000);
      var age = now - ts;
      // a feed clock running ahead of ours would otherwise read "-2 hours ago"
      if (age < 0) return '';
      if (!dayOnly) {
        if (age < 60) return 'just now';
        if (age < 3600) return countOf(Math.floor(age / 60), 'minute') + ' ago';
        if (age < 86400) return countOf(Math.floor(age / 3600), 'hour') + ' ago';
      }
      var days = dayGap(ts, now);
      if (days <= 0) return 'today';
      if (days === 1) return 'yesterday';
      if (days < 14) return countOf(days, 'day') + ' ago';
      if (days < 61) return countOf(Math.floor(days / 7), 'week') + ' ago';
      var months = monthGap(ts, now);
      if (months < 24) return countOf(Math.max(1, months), 'month') + ' ago';
      return countOf(Math.floor(months / 12), 'year') + ' ago';
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
    // Calendar months for the same reason: someone reading "Nov 13, 2024" on
    // the 29th of August counts nine months off a calendar, not 289 days
    // divided by 30. The day-of-month test is what stops a date eight days
    // short of its anniversary being called a full month older.
    function monthGap(ts, now) {
      var a = new Date(ts * 1000), b = new Date(now * 1000);
      var m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
      if (b.getDate() < a.getDate()) m--;
      return m;
    }
    // One half of the card's date footer (Added or Updated): an icon plus the
    // age only, so the two halves can't drift apart the way separately-written
    // label functions would. word/dayOnly/withTime are what actually differ
    // between Added and Updated; everything else about the two is identical.
    // ts falsy (date unknown) returns the wrapper empty, no icon, no text, no
    // title, so the footer still reserves its line.
    // An unknown date still renders its icon and the word "unknown" rather
    // than vanishing. A card that quietly drops a field it has no value for
    // reads as a different card from the one beside it, and a grid of those is
    // what makes a wall of cards look untidy. The slot is always there; only
    // what fills it changes, and an unknown one is dimmed so a real value still
    // wins the eye.
    function dateSpan(cls, icon, word, ts, dayOnly, withTime) {
      var wrap = document.createElement('span');
      wrap.className = cls;
      wrap.insertAdjacentHTML('afterbegin', icon);
      var txt = document.createElement('span');
      txt.className = 'asga-datetext';
      if (!ts) {
        wrap.classList.add('asga-stat-none');
        wrap.title = word + ' date is not in the app catalog';
        txt.textContent = 'unknown';
      } else {
        if (dayGap(ts, Math.floor(Date.now() / 1000)) <= 0) wrap.classList.add('asga-date-today');
        wrap.title = word + ' ' + absDate(ts, withTime);
        // relDate returns '' only for a feed clock running ahead of ours; fall
        // back to the absolute date so a date that IS known is never blank.
        txt.textContent = relDate(ts, dayOnly) || absDate(ts, false);
      }
      wrap.appendChild(txt);
      return wrap;
    }
    // One footer stat: its icon, the abbreviated figure, and the word for what
    // is being counted. The word is what the old corner badge had no room for,
    // which is why a number in the corner never said whether it meant stars,
    // pulls or anything else. The exact figure stays in the tooltip. Built the
    // same shape dateSpan() builds above (icon then text, one flex box), so a
    // star and a download count line up with the two dates beside them.
    // The noun is pluralised off the RAW count rather than the abbreviated
    // figure beside it, because "1.2k" is many and "1" is one, and the two do
    // not agree once fmt() has shortened the number.
    //
    // This card used to print the number nought for a figure nobody had
    // measured, on 998 cards for downloads and 1,689 for stars, where only 4
    // and 164 respectively were real zeros. A zero is a claim. The word is
    // not, so a null count now reads as "n/a" instead. The noun is dropped in
    // that case too, so a missing count never grows into something like
    // "n/a stars" that could be mistaken for a real figure at a glance.
    function statSpan(cls, icon, n, noun, title) {
      var s = document.createElement('span');
      var known = (n != null);
      s.className = 'asga-stat ' + cls + (known && n > 0 ? '' : ' asga-stat-none');
      s.title = title;
      s.insertAdjacentHTML('afterbegin', icon);
      s.appendChild(document.createTextNode(known ? fmt(n) : 'n/a'));
      if (known) {
        // the noun rides in its own element so the button row, which has no
        // room for it, can drop the word and keep the figure. The tooltip
        // still spells the whole thing out either way.
        var w = document.createElement('span');
        w.className = 'asga-stat-noun';
        w.textContent = ' ' + noun + (n === 1 ? '' : 's');
        s.appendChild(w);
      }
      return s;
    }
    // One figure in the card's stat column: a boxed mark, the abbreviated
    // number, and the word for what is being counted under it. The exact figure
    // stays in the tooltip, as it does everywhere else in this file. A figure
    // nothing is known about keeps its slot and dims, for the same reason the
    // footer's do: a missing box on one card and not the next is what makes a
    // wall of cards read as ragged.
    //
    // This card used to print the number nought for a figure nobody had
    // measured, on 998 cards for downloads and 1,689 for stars, where only 4
    // and 164 respectively were real zeros. A zero is a claim. The word is
    // not, so a null count now prints as "n/a" in place of the figure. Unlike
    // the seven character word "unknown" this replaced, "n/a" fits the same
    // slot a four character figure like 1.2M was sized for, so the shrink
    // this element's class used to trigger is gone from inject.css; the
    // class name itself stays put here as the hook, just with nothing left
    // to shrink it now.
    function statTile(cls, mark, n, word, title) {
      var s = document.createElement('div');
      var known = (n != null);
      s.className = 'asga-tile-stat ' + cls + (known && n > 0 ? '' : ' asga-stat-none');
      s.title = title;
      var box = document.createElement('span');
      box.className = 'asga-tile-statbox';
      box.insertAdjacentHTML('afterbegin', mark);
      var num = document.createElement('span');
      num.className = 'asga-tile-statnum' + (known ? '' : ' asga-tile-statnum-none');
      num.textContent = known ? fmt(n) : 'n/a';
      var lab = document.createElement('span');
      lab.className = 'asga-tile-statlabel';
      lab.textContent = word;
      s.appendChild(box);
      s.appendChild(num);
      s.appendChild(lab);
      return s;
    }
    function starTitle(s) {
      if (s == null) return 'This app has not been matched to a GitHub repository yet';
      if (s === 0) return 'This app\'s source repository has no stars yet';
      return s.toLocaleString() + ' GitHub star' + (s === 1 ? '' : 's') +
             ' on this app\'s source repository';
    }
    // Plugins carry a real install count of their own, and "Docker image pulls"
    // is the wrong noun for something that was never pulled from a registry.
    //
    // A null count and a real zero used to read the same tooltip, which is the
    // same mistake the number nought made on the tile itself: 998 cards showed
    // "0 Downloads" when only 4 apps in the whole catalog carry an explicit
    // zero, the rest being an image CA never got a pull count for at all (most
    // often because it is published outside Docker Hub, which is where CA's
    // count comes from). Null and 0 now get their own sentence apiece.
    // Three different reasons a figure is missing, and the reader is owed the
    // one that applies. 72 apps run a shared official base image (mongo,
    // postgres, nginx, redis) and were being told they are "published
    // somewhere else", which is plainly untrue: those images are on Docker Hub,
    // and the reason there is no number is that the only number available is
    // that base image's global pulls across every project using it, which says
    // nothing whatever about this app. dz carries which case it is, because dl
    // is null either way and the card cannot tell them apart from that alone.
    function downloadTitle(dl, ty, dz) {
      if (dl == null) {
        if (dz === 'b') {
          return 'This app runs a shared official base image, and the only count available is that image\'s pulls across every project using it, which says nothing about this app. So it is not shown.';
        }
        return ty === 'plugin'
          ? 'The app catalog has no install count for this plugin'
          : 'The app catalog has no pull count for this image. Counts come from Docker Hub, and this app is published somewhere else.';
      }
      if (dl === 0) {
        return ty === 'plugin'
          ? 'No Unraid server has installed this plugin yet'
          : 'This app\'s image has no pulls recorded yet';
      }
      return ty === 'plugin'
        ? dl.toLocaleString() + ' Unraid servers have installed this plugin'
        : dl.toLocaleString() + ' pulls of this app\'s Docker image';
    }
    // The icon is optional so a caller that wants a bare pill still gets one.
    // The label rides in its own span because the row is nowrap and the span is
    // what ellipsises when a column gets narrow, rather than the button growing
    // and pushing Install off the card.
    function mkBtn(label, cls, icon) {
      var b = document.createElement('span');
      b.className = 'asga-btn ' + cls;
      if (icon) b.insertAdjacentHTML('afterbegin', icon);
      var t = document.createElement('span');
      t.className = 'asga-btn-label';
      t.textContent = label;
      b.appendChild(t);
      return b;
    }
    function mkFlag(label, cls, title) {
      var s = document.createElement('span');
      s.className = 'asga-flag ' + cls;
      s.title = title;
      s.textContent = label;
      return s;
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
    // Two different reasons an app cannot be installed, and the card says
    // which. CA marks 36 of the 3,873 displayable apps incompatible with this
    // server and its own drawer answers by rendering no install action at
    // all, while this grid used to offer them a working Install button.
    // Docker being down is the other reason and it stops docker apps only,
    // since a plugin still installs fine.
    function blockReason(a) {
      if (a.xc) return 'Not compatible with this version of Unraid';
      if (!docker.running && (a.ty || 'docker') !== 'plugin') return (DOCKER_MSG[docker.reason] || 'Docker not available');
      return '';
    }
    function blocked(a) { return !!blockReason(a); }

    function render() {
      if (!isOn() || caSpecial) return;
      renderGen++;
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
          : view.special === 'repo' ? 'No apps by ' + view.repo + ' matched the App Store catalog.'
          : view.q ? 'No apps match "' + view.q + '".'
          : emptySortNote() || 'No apps to show.'));
        grid.appendChild(empty);
      } else {
        var frag = document.createDocumentFragment();
        for (var i = 0; i < pageItems.length; i++) frag.appendChild(makeTile(pageItems[i]));
        grid.appendChild(frag);
      }

      var noun = view.special === 'pinned' ? 'pinned apps' : view.special === 'installed' ? 'installed apps' : view.special === 'repo' ? 'apps by this maintainer' : 'apps';
      var title = view.special === 'pinned' ? 'Pinned Apps' : view.special === 'installed' ? 'Installed Apps' : view.special === 'repo' ? view.repo : (view.cat ? view.catLabel : 'All Apps');
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
      fillMissingDates();
    }

    // 1,164 of the 4,251 docker apps in CA's feed carry no LastUpdate at all,
    // and every app pinned to a tag other than :latest reports none either,
    // so those cards land here with an empty right-hand slot. lastupdate.php
    // can resolve all of them from the registry that actually hosts the
    // image, same as a drawer open already does for one app at a time; this
    // walks the page that just painted and asks for the rest of it. Capped at
    // 4 requests in flight because this is a background fill behind a page
    // the user is already reading, not something that should open dozens of
    // sockets at once. The server caches each repo's answer, so paging back
    // and forth through the catalog costs nothing after the first pass.
    function fillMissingDates() {
      try {
        var gen = renderGen;
        var queue = [];
        for (var i = 0; i < pageItemsNow.length; i++) {
          var a = pageItemsNow[i];
          if (!a || a.lu || a.ty !== 'docker' || !a.ri) continue;
          if (Object.prototype.hasOwnProperty.call(regDates, a.ri)) {
            // already asked this session; a real answer still needs painting
            // onto this card, since a freshly rendered tile has lost the text
            if (regDates[a.ri]) paintFilledDate(a, regDates[a.ri], gen);
            continue;
          }
          queue.push(a);
        }
        var pump = function () {
          if (!queue.length) return;
          fetchOne(queue.shift());
        };
        var fetchOne = function (a) {
          var ref = a.ri;
          fetch(PREFIX + 'lastupdate.php?repo=' + encodeURIComponent(ref))
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { var ts = (j && j.ts) || 0; regDates[ref] = ts; if (ts) paintFilledDate(a, ts, gen); })
            .catch(function () { regDates[ref] = 0; })
            .then(function () { pump(); });
        };
        var n = Math.min(4, queue.length);
        for (var k = 0; k < n; k++) pump();
      } catch (e) {}
    }
    // Writing the date onto the app record happens whether or not this page
    // is still the one on screen, since the next render should not have to
    // ask again; painting the tile itself is guarded by gen, because a paint
    // that lands after the user has turned the page would touch a card that
    // no longer belongs to this walk (or, worse, a different app that has
    // since reused the same DOM node).
    function paintFilledDate(a, ts, gen) {
      a.lu = ts; a.lk = 'r';
      try {
        if (gen !== renderGen) return;
        if (typeof CSS === 'undefined' || !CSS.escape) return;
        var tile = document.querySelector('#asga-grid .asga-tile[data-apppath="' + CSS.escape(a.p) + '"]');
        if (!tile) return;
        var up = tile.querySelector('.asga-tile-updated');
        if (!up) return;
        // rebuilt through the same helper the initial paint uses, so a date
        // filled in after the fact gets its icon and today highlight too,
        // rather than the old textContent write that would have wiped the icon
        up.replaceWith(dateSpan('asga-tile-updated', CLOCK_ICON, 'Updated', a.lu, a.lk !== 'r', a.lk === 'r'));
      } catch (e) {}
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
      if (!want.length) {
        setRefreshSpin(false);
        // only when the user asked: the automatic top-up runs on every page
        // turn and has nothing to announce when the page is already current
        if (force) scanStatus('Nothing to refresh on this page');
        return;
      }
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
          var changed = 0;
          want.forEach(function (p) {
            var a = byPath[p];
            if (!a) return;
            a.sa = now;                                    // tried; don't ask again this week
            if (!Object.prototype.hasOwnProperty.call(stars, p)) return;
            if (stars[p] !== a.s) changed++;
            a.s = stars[p];
          });
          paintStars(stars);
          if (force) {
            if (!j) scanStatus('Refresh failed, the server did not answer');
            else scanStatus('Checked ' + want.length + ' app' + (want.length === 1 ? '' : 's') + ', ' +
                            (changed ? changed + ' star count' + (changed === 1 ? '' : 's') + ' changed' : 'all up to date'));
          }
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
        // The stat lives in the header's own column now, not a footer badge, so
        // a star count arriving after the page painted just rewrites that box's
        // number rather than rebuilding an element that no longer exists.
        var row = t.querySelector('.asga-tile-stat-stars');
        if (!row) continue;
        var num = row.querySelector('.asga-tile-statnum');
        if (num) num.textContent = fmt(v);
        row.title = starTitle(v);
        row.classList.toggle('asga-stat-none', !(v > 0));
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
          // not even an empty-labelled one. data-mark carries the option's
          // own m property onto the optgroup markup itself, so themeSelect()
          // can draw the GitHub/Unraid glyph on the group heading by reading
          // the DOM, the same place it reads everything else about this
          // list, rather than reaching back into SORT_OPTS.
          if (o.g) opts += '<optgroup label="' + o.g + '"' + (o.m ? ' data-mark="' + o.m + '"' : '') + '>';
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
        // Hidden by default (inline style, not a class, so CA's own CSS
        // reset on <a> elements cannot un-hide it by accident) and only
        // un-hidden by checkForUpdate() once latest.php actually reports a
        // newer version. A control that is always present and almost always
        // means nothing stops being read at all, so this one only exists on
        // the page at all when there is something to act on. It is an
        // anchor to /Plugins rather than a button so a middle click or a
        // ctrl/cmd click opens the plugins page in a tab like any other link.
        '<a id="asga-update" class="asga-update" href="/Plugins" style="display:none" ' +
          'title="A newer version of this plugin is available. Opens the Plugins page, where it can be updated." ' +
          'aria-label="Plugin update available">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M8 1.5v8.4"/><path d="M4.6 6.5 8 9.9l3.4-3.4"/><path d="M2.5 12.5h11"/></svg>' +
        '</a>' +
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
      // toolbar specifics (the button's own id, its width measured from the
      // widest label, and the menu positioned absolute inside .asga-sortwrap
      // so it matches the button's exact left edge and width) are passed in
      // as options; the shared widget itself knows none of that
      themeSelect(sel, {
        btnId: 'asga-sortbtn',
        btnClass: 'asga-sortbtn',
        btnTitle: 'Change the sort order',
        fixedWidth: true,
        position: 'absolute'
      });
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
      checkForUpdate();
    }

    // Safari renders a <select>'s open list as a native macOS menu that no CSS
    // can theme, so this turns ANY native select into a button that opens a
    // themed menu of our own, drawn with the refresh menu's language. 7.1
    // keeps every native select, since that layout is verified and left
    // alone. The select stays in the DOM as the state holder: it is what
    // code reads and writes, and it keeps firing a change event when a menu
    // item is picked, so an existing change listener (the toolbar's own,
    // wired before this is called) never has to know this widget exists.
    //
    // Started life as the toolbar's own sort menu; the settings drawer's four
    // selects need the identical look, so this is now that same code with
    // its toolbar-only specifics (the fixed id, the width measured from the
    // widest label, the menu positioned to match a non-scrolling button)
    // pulled out into options, and the drawer-only specifics (full width,
    // no id transfer needed vs. transferred, fixed positioning so the drawer's
    // own scrolling body can't clip the open list) added as options too.
    //
    // options:
    //   btnId          a fixed id for the trigger button (the toolbar's own)
    //   moveIdToButton if true, moves the SELECT's existing id onto the
    //                  button instead (so a <label for> written before
    //                  theming keeps pointing at whichever element is now
    //                  the interactive one)
    //   btnClass       class(es) for the trigger button
    //   btnTitle       the trigger button's title attribute
    //   fixedWidth     true sizes the button to its widest OPTION TEXT, read
    //                  off the select's own <option> elements, never
    //                  SORT_OPTS, since reading the DOM rather than any one
    //                  caller's data is what makes this reusable. Left
    //                  unset, the button takes whatever width its CSS gives
    //                  it (100%, for the drawer's full-width fields).
    //   position       'absolute' (default): the menu is inserted next to
    //                  the button and positioned to match its exact left
    //                  edge and width, the way the toolbar always has.
    //                  'fixed': the menu is appended to <body> instead and
    //                  pinned with position:fixed from the button's live
    //                  getBoundingClientRect(). Needed inside the settings
    //                  drawer, whose body scrolls (overflow-y:auto) and
    //                  would otherwise clip an absolutely positioned menu;
    //                  appending to <body> also steps around the drawer
    //                  panel's own transform, which would otherwise become
    //                  the containing block for a fixed-position descendant.
    //   scrollHost     (fixed mode only) the scrolling ancestor to close the
    //                  menu on scroll, since a fixed menu does not follow
    //                  its trigger and re-tracking it on every scroll tick
    //                  is not worth doing when closing is the honest fix.
    function themeSelect(sel, options) {
      if (document.documentElement.classList.contains('Theme--legacyOS')) return null;
      var opts = options || {};
      var wrap = sel.parentNode;
      var btn = document.createElement('button');
      btn.type = 'button';
      if (opts.moveIdToButton && sel.id) { btn.id = sel.id; sel.removeAttribute('id'); }
      else if (opts.btnId) { btn.id = opts.btnId; }
      btn.className = opts.btnClass || '';
      if (opts.btnTitle) btn.title = opts.btnTitle;
      wrap.insertBefore(btn, sel);
      sel.classList.add('asga-sortsel-hidden');

      function label() {
        var o = sel.options[sel.selectedIndex];
        btn.textContent = o ? o.text : '';
      }
      label();
      sel.addEventListener('change', label);
      // A caller that sets sel.value directly, rather than through this
      // widget's own menu, never fires a change event (the settings drawer
      // repopulates its selects with fresh server data every time it opens,
      // straight assignment, no event), so the button would silently go
      // stale. Wrapping the property is what lets every existing
      // "sel.value = x" line keep working untouched while the button still
      // follows it.
      var nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      if (nativeValue && nativeValue.configurable) {
        Object.defineProperty(sel, 'value', {
          configurable: true,
          get: function () { return nativeValue.get.call(sel); },
          set: function (v) { nativeValue.set.call(sel, v); label(); }
        });
      }

      if (opts.fixedWidth) {
        // The button is as wide as the widest entry, measured in its own
        // font, so changing the selection never resizes it and the open
        // list can share its exact box.
        var probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;';
        wrap.appendChild(probe);
        probe.style.font = getComputedStyle(btn).font;
        var maxW = 0;
        for (var i = 0; i < sel.options.length; i++) {
          probe.textContent = sel.options[i].text;
          maxW = Math.max(maxW, probe.getBoundingClientRect().width);
        }
        wrap.removeChild(probe);
        // 14px left padding plus 30px right padding, and a little slack so a
        // fractional measurement never wraps the longest label
        btn.style.width = Math.ceil(maxW + 44 + 4) + 'px';
      }

      btn.addEventListener('click', function (e) {
        e.stopPropagation(); e.preventDefault();
        if (openThemeMenu && openThemeMenu.btn === btn) { closeThemeMenu(); return; }
        closeThemeMenu();
        openThemeMenuFor(sel, btn, wrap, opts);
      });

      return { sel: sel, btn: btn };
    }

    // Only one themed menu is ever open at a time anywhere on the page: the
    // toolbar's sort menu and the drawer's four each go through this same
    // slot, so opening one closes whichever other is already up first.
    var openThemeMenu = null;
    function closeThemeMenu() {
      if (!openThemeMenu) return;
      var cur = openThemeMenu;
      openThemeMenu = null;
      cur.cleanup();
    }

    // Builds the menu's items straight from the select's own <option> and
    // <optgroup> elements, in document order, so the menu can never drift
    // out of step with whatever the select actually offers. curValue is
    // read once, at open time, and marks the matching item the way the sort
    // menu always has: the accent colour alone, no tick, since a tick would
    // knock its label out of line with every other entry.
    function appendThemeItems(menu, optList, curValue) {
      for (var i = 0; i < optList.length; i++) {
        var opt = optList[i];
        var it = document.createElement('span');
        it.className = 'asga-refitem asga-sortmenu-item' + (opt.value === curValue ? ' asga-sortmenu-cur' : '');
        it.setAttribute('data-v', opt.value);
        if (opt.title) it.title = opt.title;
        it.textContent = opt.text;
        menu.appendChild(it);
      }
    }
    function buildThemeMenuBody(menu, sel) {
      var curValue = sel.value;
      var kids = sel.children;
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (el.tagName === 'OPTGROUP') {
          var h = document.createElement('div');
          h.className = 'asga-sortmenu-group';
          // the group header carries a mark to say where its numbers come
          // from, read off the optgroup's own data-mark attribute (see
          // sortOptionsHtml()) rather than a string test on the group name,
          // which a rename would silently break. It goes AFTER the name, not
          // before: the two marks are different widths, so leading them
          // would start the two headers on different left edges instead of
          // one.
          var mark = el.getAttribute('data-mark');
          h.textContent = el.label;
          if (mark === 'un') h.insertAdjacentHTML('beforeend', UN_MARK);
          else if (mark === 'gh') h.insertAdjacentHTML('beforeend', GH_MARK);
          menu.appendChild(h);
          appendThemeItems(menu, el.children, curValue);
        } else if (el.tagName === 'OPTION') {
          appendThemeItems(menu, [el], curValue);
        }
      }
    }

    // Positions a position:fixed menu from the trigger's live viewport box.
    // Opens downward by default; if the list is taller than the room left
    // below the button before the viewport's bottom edge, and there is more
    // room above, it opens upward instead. Either way its height is capped
    // to whatever room it actually has, so a long list (the drawer's Default
    // sort order field carries 19 entries) scrolls internally rather than
    // running off the screen.
    function positionFixedMenu(menu, btn) {
      var r = btn.getBoundingClientRect();
      var gap = 6;
      menu.style.position = 'fixed';
      menu.style.left = r.left + 'px';
      menu.style.width = r.width + 'px';
      menu.style.zIndex = '10070';   // above the drawer panel (10061) and its backdrop (10060)
      // already appended to <body> by the caller, so scrollHeight reads the
      // list's full natural height even though its own CSS caps what shows
      var natural = menu.scrollHeight;
      var vh = window.innerHeight;
      var below = vh - r.bottom - gap;
      var above = r.top - gap;
      if (natural > below && above > below) {
        menu.style.top = 'auto';
        menu.style.bottom = (vh - r.top + gap) + 'px';
        menu.style.maxHeight = Math.max(100, Math.min(natural, above)) + 'px';
      } else {
        menu.style.bottom = 'auto';
        menu.style.top = (r.bottom + gap) + 'px';
        menu.style.maxHeight = Math.max(100, Math.min(natural, below)) + 'px';
      }
    }

    function openThemeMenuFor(sel, btn, wrap, opts) {
      var menu = document.createElement('div');
      menu.className = 'asga-refmenu asga-sortmenu';
      buildThemeMenuBody(menu, sel);

      var fixed = opts.position === 'fixed';
      if (fixed) {
        document.body.appendChild(menu);
        positionFixedMenu(menu, btn);
      } else {
        wrap.insertBefore(menu, btn.nextSibling);
        // the open list wears the button's exact left edge and width
        menu.style.left = btn.offsetLeft + 'px';
        menu.style.width = btn.offsetWidth + 'px';
      }

      function pick(ev) {
        var item = ev.target.closest ? ev.target.closest('.asga-sortmenu-item') : null;
        if (!item) return;
        closeThemeMenu();
        sel.value = item.getAttribute('data-v');   // the wrapped setter above keeps the button's label in step
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      menu.addEventListener('click', pick);

      function outside(ev) {
        if (menu.contains(ev.target) || ev.target === btn) return;
        closeThemeMenu();
      }
      function onKey(ev) { if (ev.key === 'Escape') closeThemeMenu(); }
      function onScroll() { closeThemeMenu(); }
      function onResize() { closeThemeMenu(); }

      setTimeout(function () { document.addEventListener('click', outside, true); }, 0);
      document.addEventListener('keydown', onKey, true);
      if (fixed) {
        window.addEventListener('resize', onResize);
        if (opts.scrollHost) opts.scrollHost.addEventListener('scroll', onScroll);
      }

      openThemeMenu = {
        btn: btn,
        menu: menu,
        cleanup: function () {
          menu.remove();
          document.removeEventListener('click', outside, true);
          document.removeEventListener('keydown', onKey, true);
          if (fixed) {
            window.removeEventListener('resize', onResize);
            if (opts.scrollHost) opts.scrollHost.removeEventListener('scroll', onScroll);
          }
        }
      };
    }

    // ---- drawer shell: a right-edge slide-in panel with a backdrop, a
    // sticky header (title + close), a scrollable body, Escape to close,
    // backdrop click to close, focus into the panel on open and back to the
    // opener on close, and a body.asga-drawer-open scroll lock. The About
    // panel and the Settings panel are both built from this, so all of that
    // is written, and fixed, exactly once. Only one drawer is ever open at a
    // time: opening one closes whichever other one is already open first. ----
    var openDrawerNow = null;   // the drawer object currently open, or null
    // A themed select's own menu (see themeSelect() above) also closes on
    // Escape, and its keydown listener sits on the same document node this
    // one does, so without this check one Escape press would close both at
    // once. The first press instead only closes the open menu; a second
    // press is what closes the drawer behind it.
    function drawerEscHandler(ev) {
      if (ev.key !== 'Escape') return;
      if (openThemeMenu) { closeThemeMenu(); return; }
      closeDrawer(openDrawerNow);
    }

    // headerAction is optional and only the About panel passes one (see
    // ensureAboutPanel): { icon, title, onClick } for a button that sits left
    // of Close. An argument rather than a second method keeps every drawer
    // built through this one call; Settings passes nothing, so its header
    // keeps the single close button it always had.
    function makeDrawer(id, titleText, headerAction) {
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

      // Close (and the optional action beside it) sit in their own cluster
      // rather than as direct children of the header, so the header always
      // has exactly two flex children (title, cluster). That keeps the
      // header's own justify-content:space-between doing the same job it
      // always did, title flush left and the cluster flush right, instead of
      // centering a third top-level child in the gap between title and Close.
      var actions = document.createElement('div');
      actions.className = 'asga-drawer-actions';
      if (headerAction) {
        var actionBtn = document.createElement('button');
        actionBtn.type = 'button';
        actionBtn.className = 'asga-drawer-action';
        actionBtn.title = headerAction.title;
        actionBtn.setAttribute('aria-label', headerAction.title);
        actionBtn.innerHTML = headerAction.icon;
        actionBtn.addEventListener('click', headerAction.onClick);
        actions.appendChild(actionBtn);
      }
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'asga-drawer-close';
      closeBtn.title = 'Close';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', function () { closeDrawer(d); });
      actions.appendChild(closeBtn);
      header.appendChild(title);
      header.appendChild(actions);

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
      // a fixed-position themed menu is appended to <body>, outside the
      // panel, so it would otherwise be left floating on screen with its
      // trigger already gone
      closeThemeMenu();
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
    var updateInfo = null;   // latest.php's answer, set once checkForUpdate()'s fetch lands; null means "not answered yet"

    // Confirms before leaving the page: reuses attentionModal, this plugin's
    // own confirm dialog, rather than a second one. Confirming opens the
    // issue chooser in a new tab (openExt); cancelling closes the confirm and
    // does nothing else.
    function reportIssue() {
      attentionModal(
        'Reporting an issue opens this plugin\'s GitHub page in a new tab.\n\n' +
        'You will need a GitHub account, and the issue form opens with the repository\'s own template already selected.',
        function () { openExt(ISSUE_URL); }
      );
    }

    function ensureAboutPanel() {
      if (aboutPanel) return aboutPanel;
      aboutPanel = makeDrawer('asga-about-panel', 'Unraid Modern App Store', {
        icon: ISSUE_ICON,
        title: 'Report an issue',
        onClick: reportIssue
      });
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

      // A second, separately coloured line only when checkForUpdate() has
      // actually found something newer than what is installed; updateInfo
      // stays null until that fetch lands and stays an object with
      // updateAvailable: false once it lands clean but current, so both of
      // those read as "say nothing" here, the same way the toolbar glyph
      // stays hidden for them.
      if (updateInfo && updateInfo.updateAvailable && updateInfo.latest) {
        var upLine = document.createElement('p');
        upLine.className = 'asga-about-update';
        upLine.textContent = 'Version ' + updateInfo.latest + ' is available. Update it from the Plugins page.';
        body.appendChild(upLine);
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

      // Every select in this drawer gets the same themed button the toolbar's
      // sort control uses (see themeSelect() above): a native <select>'s open
      // list is browser chrome no CSS can reach, and it read as a jarring,
      // unthemed system menu next to every other control here. Full width
      // rather than the toolbar's fixed-to-the-widest-label sizing, since
      // every other control in this form is full width too, and 'fixed'
      // positioning rather than 'absolute', since this panel's body scrolls
      // (overflow-y:auto) and would otherwise clip the open list. The id
      // already carries the <label for> written by addSettingsField(), so it
      // moves onto the button instead of a fixed one being set here.
      function themeSettingsSelect(sel) {
        themeSelect(sel, {
          moveIdToButton: true,
          btnClass: 'asga-settings-selectbtn',
          position: 'fixed',
          scrollHost: body
        });
      }

      els.service = addSettingsSelect(body, 'asga-set-service', 'Enable Unraid Modern App Store', [
        { v: 'enabled', label: 'Yes' }, { v: 'disabled', label: 'No' }
      ]);
      themeSettingsSelect(els.service);
      els.notif = addSettingsSelect(body, 'asga-set-notif', 'Enable Notifications', [
        { v: 'enabled', label: 'Yes' }, { v: 'disabled', label: 'No' }
      ]);
      themeSettingsSelect(els.notif);

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
      themeSettingsSelect(els.scanDays);

      // built FROM SORT_OPTS via the same helper the toolbar's own sort
      // select uses, so this list is exactly the grid's own sort menu and
      // cannot drift out of step with it
      var sortSel = document.createElement('select');
      sortSel.className = 'asga-settings-select';
      sortSel.innerHTML = sortOptionsHtml();
      els.sort = addSettingsField(body, 'asga-set-sort', 'Default sort order', sortSel);
      themeSettingsSelect(els.sort);

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

    // Whether the plugin itself has a newer release, checked once per page
    // load and read back by both the toolbar glyph below and the About
    // panel's version line. updateChecked is the guard: addSortBar() can be
    // re-entered whenever CA rebuilds its own toolbar (a category switch, a
    // view refresh), and a second call must not refire the request or blank
    // out an answer the first call already found.
    var updateChecked = false;
    function checkForUpdate() {
      if (updateChecked) return;
      updateChecked = true;
      fetch(PREFIX + 'latest.php?_=' + Date.now())
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return;
          updateInfo = j;
          if (j.updateAvailable) {
            var el = document.getElementById('asga-update');
            if (el) el.style.display = '';
          }
        })
        // same silent-no-op contract as every other fetch in this file: a
        // dead endpoint just means the glyph stays hidden, never a broken page
        .catch(function () {});
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
      view.special = ''; view.repo = ''; view.cat = ''; view.catLabel = 'All Apps';
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
        // A maintainer view has no menu item to light up, and the ternary
        // below treats anything that is not 'pinned' as 'installed', so
        // without this the Installed Apps entry lit up whenever someone
        // opened a maintainer's apps.
        if (view.special === 'repo') on = false;
        else if (view.special) on = (cat === (view.special === 'pinned' ? 'pinned_apps' : 'installed_apps'));
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
          view.repo = ''; view.cat = ''; view.q = ''; if (box) box.value = ''; view.page = 1;
          loadViews(function () { applyViewMode(); render(); });
          return;
        }
        if (CA_SPECIAL.test(cat)) {
          // Previous Apps / Action Centre / Repositories: hand back to CA for now.
          caSpecial = true; applyViewMode(); return;
        }
        // Home (startup screens) and All Apps both mean the full catalog for us.
        caSpecial = false; view.special = ''; view.repo = '';
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
    // "Refresh this page" rescans the stars for what is on screen, and a scan
    // that finds every count unchanged (the normal outcome on a page looked at
    // recently) repaints identical numbers, so the only thing that moved was a
    // 14px icon in the corner. That reads as a dead button. The word beside the
    // icon says what is happening instead, then says what happened, then goes
    // back to being the catalog timestamp it normally is.
    var stampRestore = null;
    function scanStatus(msg, hold) {
      var el = document.getElementById('asga-updated');
      if (!el) return;
      clearTimeout(stampRestore);
      el.textContent = msg;
      el.title = '';
      if (!hold) stampRestore = setTimeout(updateStamp, 4000);
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
        if (item.getAttribute('data-act') === 'page') {
          setRefreshSpin(true);
          scanStatus('Refreshing this page…', true);
          scanVisible(true);
        }
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
      wireDrawerDetails();
      wireRepoClick();
      wireFlashDismiss();
      showWarningIfNeeded();
      applyViewMode();
      dismissCaLoading();
      if (isOn() && !document.getElementById('asga-view')) render();
    }

    // Our grid is up, so CA's own search box and left column can come back from
    // behind the loading modal. Called from render() rather than from attachUI,
    // because attachUI runs before the first paint and the point of the class is
    // that there is now something of ours to look at.
    function markReady() {
      document.documentElement.classList.add('asga-ready');
    }

    function start() {
      // A render that never happens must not leave the page stripped of CA's
      // chrome for good, so the same class lands on a timer whatever else does
      // or does not occur.
      setTimeout(markReady, 15000);
      triggerNewScan();
      loadViews();   // pin/installed membership, so tiles show correct pin state
      loadApps(function () {
        // has to run after loadApps() lands: that's what carries the configured
        // default this falls back to, and it must run before attachUI()/render()
        // paint the sort menu and the first page
        initSort();    // restore last sort (or the configured default after 20 min)
        attachUI();
        render();
        markReady();
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
