#!/bin/bash
# Build a self-contained, SHAREABLE modern.appstore.plg from src/.
# Embeds every src file inline (CDATA) plus install/remove scripts.
# Contains NO secrets. The GitHub token is left empty and each user sets their
# own at Settings -> Utilities -> Unraid Modern App Store. Safe to publish.
#
# Usage: ./build.sh [version]   (default version below)
set -euo pipefail

cd "$(dirname "$0")"
VERSION="${1:-2026.08.06a}"
NAME="modern.appstore"
SRC="src/usr/local/emhttp/plugins/$NAME"
OUT="$NAME.plg"
PLUGIN_URL="https://raw.githubusercontent.com/ghzgod/unraid-modern-appstore/main/modern.appstore.plg"
SUPPORT_URL="https://github.com/ghzgod/unraid-modern-appstore"

# --- payload files (order: php, js, css, pages, readme) --------------------
FILES=(fetch_stars.php refresh.php cancel.php newscan.php scanpage.php applist.php pinned.php inject.js inject.css ModernAppStore.page ModernAppStoreLoader.page README.md)

# guard: CDATA cannot contain ]]>
for f in "${FILES[@]}"; do
  if grep -q ']]>' "$SRC/$f"; then echo "ERROR: $f contains ]]> (breaks CDATA)" >&2; exit 1; fi
done

emit_payload() {
  local f="$1"
  printf '<FILE Name="/usr/local/emhttp/plugins/%s/%s">\n<INLINE>\n<![CDATA[\n' "$NAME" "$f"
  cat "$SRC/$f"
  printf ']]>\n</INLINE>\n</FILE>\n\n'
}

{
cat <<XMLHEAD
<?xml version='1.0' standalone='yes'?>
<!DOCTYPE PLUGIN [
<!ENTITY name    "$NAME">
<!ENTITY author  "ghzgod">
<!ENTITY version "$VERSION">
<!ENTITY plugin  "$PLUGIN_URL">
<!ENTITY support "$SUPPORT_URL">
]>
<PLUGIN name="&name;" author="&author;" version="&version;" pluginURL="&plugin;" launch="Settings/ModernAppStore" min="6.12" icon="star" support="&support;">

<CHANGES>
##$VERSION
- Every card now shows when the app itself last shipped, on the same line as the
  Added date: Added at the left edge of the card's foot, Updated at the right.
  For a Docker app the date is when the image was last published to its registry,
  the same figure Community Applications shows as "Last Update" in its own
  drawer, and it is left off an app pinned to a tag other than :latest because
  that number belongs to the repository rather than to the pinned tag. Plugins
  carry no such field in the feed, so their date-formed version number
  (2026.06.10a) is read back as the release date it is, and shown without a time
  of day since only the day is real there. A semver plugin version yields no date
  rather than a guess. Roughly seven of every ten apps have one.
- Both dates now read as an interval while they are recent ("just now", "3 hours
  ago", "yesterday", "12 days ago") and switch to the full date past a month,
  where an interval stops helping. The exact timestamp is in the tooltip.
- The card's date line reserves its height whether or not either date is known,
  so a card missing a date no longer lifts its own button row above the rest of
  its grid row.
- The Info drawer's description no longer hides behind a SHOW MORE button. The
  block keeps the same height and scrolls, so the whole description is one
  gesture away instead of an expand followed by a scroll.
- The drawer's close bar is now 40px, the same height as Unraid's own menu bar,
  rather than a taller strip of its own.

##2026.08.03a
- Three rolling archives of Community Applications' own template catalog, kept in
  this plugin's data directory as catalog_weekly.json.gz, catalog_monthly.json.gz
  and catalog_yearly.json.gz. Each is a gzip of CA's templates_new.json exactly as
  CA wrote it, so there is always a copy no older than a week, one no older than a
  month, and one no older than a year. The data directory is on the Unraid flash,
  so the check for whether an archive is due reads no file at all, the catalog is
  only opened once a window has elapsed, and windows that come due together share
  a single compression pass. Steady state is one write a week.
- Docker-unavailable cards keep the grid aligned: the reason now sits above the
  button row rather than below it, so every card in a row still bottom-aligns its
  buttons and its Added line. The notice strip's edges line up with the tile grid.

##2026.08.03
- Fix: the modern grid was empty after a reboot. Community Applications keeps its
  app catalog in /tmp, so it is gone on every boot until CA's own Apps page has
  re-downloaded the feed. The modern grid loaded first, found nothing, printed
  "No apps to show" and stayed that way until a manual reload, which is why the
  store looked empty in modern view but full with modern view switched off. It
  now recognises a catalog that has not been published yet, says so, and fills in
  by itself the moment CA writes it.
- The modern view now mirrors CA's behaviour when Docker is not running. CA never
  empties the store in that state: it lists every app, keeps plugins fully
  installable, and blocks only Docker installs. The grid now does the same, with
  CA's own reason (Docker service not enabled, Docker failed to start, or array
  not started) shown above the grid and on each Docker card, and Install disabled
  on those cards only.

##2026.08.02
- Four new Sort By orders: Trending (this year), Trending (all time),
  Trending % (this year) and Trending % (all time). All five trending windows now
  rank by GitHub stars and differ only in the period they measure.
  - "This year" is a real 365-day star delta. The plugin's daily snapshots cannot
    reach back that far on a young install, so the year-ago baseline is
    binary-searched out of the repo's stargazer list (about four requests for a
    1,000-star repo) and cached for 30 days. Repos created inside the window cost
    no request at all. The biggest repos are walked first, so a capped run still
    produces a correct leaderboard, and browsing fills the rest in page by page.
  - "All time" is every star the repo has ever gained. Its percentage form is a
    lifetime rate (stars per year of repo age) because the other percent sorts
    divide by the star count at the window's start, which at a repo's creation is
    zero. It separates 5,000 stars in two years from 20,000 in twelve.
- Fix (critical): the star fetcher crashed on every run before writing any data.
  Apps with no GitHub repository passed null into a parameter typed as a plain
  string, which is a TypeError in PHP 8, so the run died partway through building
  the catalog. Star counts, trends and the app list had silently stopped updating.
- A GitHub token that cannot read star dates is now detected with a single probe
  request instead of thousands of failed ones, and is reported in plain language.
  GitHub refuses fine-grained tokens (github_pat_...) access to the stargazers
  endpoint, which is what the "this year" windows are built from; a classic token
  (ghp_...) with no scopes reads them. The settings page explains this when it
  applies, and the empty grid says which of the two reasons it is empty for.
- The short trending windows no longer re-walk the whole catalog every scan.
  Once a repo has a star snapshot older than a day the snapshots are used
  outright, so that pass is now limited to repos that genuinely lack a baseline.
- The Sort By dropdown is grouped (Name, Popularity, Trending, Trending %) rather
  than one flat list of fifteen near-identical labels, and each trending entry
  carries a tooltip naming exactly what it measures.
- Fix: updating the plugin did not replace its files. Unraid's plugin manager
  skips any bundled file that already exists, so an update over a running install
  kept every old file and only took effect after a reboot (the plugin webroot
  lives in RAM). The installer now clears its own webroot before unpacking. The
  data directory on the flash, with the settings and star history, is untouched.
- Renamed to "Unraid Modern App Store" throughout, and the plugin id is now
  modern.appstore: its folders are /usr/local/emhttp/plugins/modern.appstore and
  /boot/config/plugins/modern.appstore, and the settings page moved to
  Settings -> Utilities -> Unraid Modern App Store. Installing this version
  migrates the GitHub token and the whole star history from the old id and
  removes the old plugin, so nothing has to be set up again.
- Fix: templates with no author showed a raw ca.unraid.net link across the card
  (CA leaves Author empty for most plugins and puts the .plg URL in its place).
  The repository owner's name is used instead, and a URL is never shown as an
  author.
- Cards can no longer be pushed out of shape by a template: long names, authors
  and categories wrap or ellipsise inside the card, and a long title stops short
  of the star badges instead of running under them.
- Removed sortinject.php. It was left over from the old design and was the only
  code that wrote into Community Applications' own cache files; the modern grid
  has not used it since. The plugin now writes nothing outside its own folders.
- If inject.js ever fails to load, the page no longer stays blank: CA's stock
  view is restored after 5 seconds.
- Stars are now fetched for the apps on screen instead of the whole catalog.
  Browsing to a page tops up whatever that page is missing, and an app is only
  re-checked if it has never been tried or its last attempt is over a week old.
- The refresh icon now offers "Refresh this page" (rescan what you are looking
  at, ignoring the weekly window) or "Refresh everything" (the full catalog scan,
  still limited to once every 3 days).
- Fix: CA's stock grid, sort row and Results-Per-Page button no longer flash on
  screen before the modern view takes over on a page load.
- Fix: about half the catalog had no GitHub star count. CA stopped publishing
  most Project URLs directly and now hands out opaque ca.unraid.net/cdn/...
  redirectors, so there was no github.com link left to read. Those are resolved
  once and cached, and GitHub Pages URLs (owner.github.io/repo) now map to their
  repo too. Apps whose project link is a plain homepage still have no stars,
  because there is no repository to count.
- The progress bar names the link-resolution pass, which runs before the star
  fetch on the first scan after this update.
- Info drawer: Description, Details and Maintainer are now one full-width column
  of equal-width cards, with Maintainer compressed to two rows.
- Tiles now show when an app was added to the App Store (date and time from CA's
  own feed), in small text at the bottom right of the card.
- Fix: the Details table text had no breathing room and Unraid's global table
  background painted a lighter slab behind it, so the values looked clipped at
  the card edge.
- Fix: the drawer's X close glyph is centred in its circle (the shared button
  gap was pushing it off centre).
- Info drawer redesigned. The app header, description, Details and Maintainer
  now read as one modern card layout instead of stock CA styling:
  - CLOSE is a round X in a slim bar that stays pinned to the top while the
    drawer scrolls, rather than a pill floating in the corner.
  - Details labels are legible (they were near-invisible dark grey), values are
    right-aligned, and long repository names no longer get clipped.
  - Details and Maintainer sit side by side in cards, and stack on a phone.
  - The Maintainer's All Apps / Profile / Favourite buttons match the rest of
    the drawer instead of being stock white App Store pills.
  - Section headings, screenshots, spotlight, moderator notes and the change log
    all follow the same type scale and card treatment.
  - Colours now derive from the active Unraid theme, so the drawer is readable on
    the white themes too.
- Fix: the drawer CLOSE button text is now light (was black on dark, invisible
  until hovered).
- Fix: tile buttons no longer wrap to two lines ("Pin App" stayed on one line and
  all five buttons fit one row).
- Info drawer: removed the blank space at the top and moved CLOSE up in line with
  the app title.
- Fix: the Info-drawer description text was black on the dark card (unreadable);
  CA set it via a more specific rule, now forced to a light colour.
- Fix: preview screenshots now open in a built-in lightbox. CA's own gallery closed
  the whole Info drawer when a preview opened and re-opened it on close, which
  flashed the drawer blank and could show two images overlaid. The drawer now stays
  put behind the lightbox.
- Repo renamed to unraid-modern-appstore; the plugin update URL now points there.
- Fix: the Sort By dropdown is vertically aligned with the toolbar labels.
- Renamed to "Unraid Modern Appstore" (settings page, in-app labels, README and the
  GitHub page). The internal plugin id is unchanged, so no reinstall is required.
- Fix: CA's "Updating Content / Please Wait" modal and spinner no longer get
  stuck open over the modern grid.
- Home now shows All Apps in the modern grid (was empty); the empty-state message
  is centered.
- Tiles show whether an app is a Docker container or a Plugin, and duplicate
  listings of the same app are collapsed.
- Tiles now have direct Project and Support buttons (no submenu); Install opens
  the template in a new tab.
- The chosen sort persists across reloads, and resets to Newest after 20 minutes
  away from the Apps page.
- Higher-contrast buttons and description text in the modern Info drawer.
- Pinned Apps and Installed Apps now render in the modern grid (with GitHub stars),
  because CA's own Pinned/Installed views are broken in its 2026.07 rewrite (they
  showed the home screen). Pin/Unpin works from the tiles and the drawer alike.
- Home and category browsing stay in the modern grid; only Previous Apps, Action
  Centre and Repositories still hand off to CA for now.
- Fix: the leaked CA category label next to the toolbar is hidden; each view shows
  a proper bold title (All Apps / Pinned Apps / Installed Apps) with its count.
- Fix: Pin App writes CA's real key (image ref + SortName) so pins actually appear.
- Modern Info drawer: the slide-in app drawer is restyled to match the grid
  (rounded icon, orange Install, pill buttons, carded description, orange section
  titles). Turning the modern view off restores CA's stock drawer.
- Fix: CA's own views (Pinned Apps, Installed Apps, Previous Apps, Action Centre,
  Repositories) now display CA's native list instead of being hidden behind our
  grid. Selecting All Apps, a category or searching returns to the modern grid.
- Fix: the Pin App button now pins with CA's real key (image ref + SortName), so
  pinned apps show up under Pinned Apps exactly like CA's own drawer button.
- Tiles: stars and Docker-pull count now sit inline in the top-right corner; a
  Pin App button was added (pins via CA's own pinApp, same as the Info drawer);
  the toggle is labelled "Modern view".
- Icons: apps whose template ships no icon now fall back to the GitHub owner's
  avatar instead of a blank question mark.
- Downloads: the count is Docker image pulls (what CA reports). Apps built on an
  official base image (e.g. nginx:alpine) inherited that base image's pull count
  (nginx = billions), which is meaningless for the app, so those are dropped from
  the count. Language packs are excluded from the grid.
- The stock CA sort row and Results-Per-Page button are hidden while the modern
  view is on (our grid has its own), and restored when it is off.
- Accent colour matches the Unraid logo orange.
- Rearchitected the GitHub view. Community Applications' 2026.07 rewrite broke its
  own client-side sort (any sort collapsed the list to ~36 apps). The addon now
  renders its own grid over the full catalog: reliable sorting by name, Unraid
  downloads, newest, GitHub stars and trending; real pagination; search; and
  category filtering. Clicking a tile opens CA's own Info/Install drawer, so
  installs are unchanged. A toggle switches back to the stock CA view at any time.
- Tiles show the app description, author and category with modern Info/Support/
  Install buttons, a GitHub-star badge and an Unraid-download-count badge.
- Language packs are filtered out of the app grid, matching CA.
- Trending is limited to day/week/month (accurate star-history deltas) and each
  trending view lists only apps that actually moved, instead of the whole catalog.
  The unreliable "this year" window was removed until a year of history exists.
- Accent colour matches the Unraid logo orange.
- Fix: "Newest to the App Store" and "Unraid Downloads" intermittently fell back
  to alphabetical order. They relied on CA's native sort, which does not re-apply
  after CA rebuilds the list A-Z on a results-per-page change. Every sort now runs
  through the addon's own self-healing path, so the order is stable and correct.
- Fix: the 96-results-per-page default did not always take effect. The old code
  marked itself done before 96 was actually applied; it now confirms 96 is active
  and retries until it is.
- Change: removed the "GitHub" item from the left menu. The Sort By dropdown
  covers everything it did, so browsing is just CA's normal All Apps view.
- Fix: the Sort By dropdown is now present in BOTH the GitHub view and All Apps
  (it was missing whenever CA hid its sort area), and the search row no longer
  sits jammed against the nav bar.
- Fix: the Sort By dropdown was invisible. It was placed inside CA's #sortIconArea,
  which CA hides as a unit (clearSearchBox calls hideSortIcons), so it vanished in
  the GitHub view. The dropdown now lives in the toolbar row next to the search box,
  which CA never hides; CA's own sort links are still hidden in place.
- Fix: sorting during a search. The Community Applications 2026.07.21 rewrite sorts
  three view caches (displayed.json plus allSearchResults.json and
  catSearchResults.json) and rebuilds them from the raw feed on every search and
  category change, which dropped our metrics, so a GitHub sort silently fell back
  to feed order and put 0-star apps above 50k-star ones. All three caches are now
  injected, and the addon re-injects and re-sorts once after each CA render.
- Change: one "Sort By:" dropdown instead of two competing sort controls. It holds
  CA's own orders (Name Ascending/Descending, Unraid Downloads) alongside ours
  (Newest to the App Store, GitHub Stars, Trending, Trending %). CA's own sort links
  are hidden, not removed, and its orders are applied by driving CA's own controls,
  so nothing about CA is modified.
- Change: results per page defaults to 96 (CA's largest) once per browser, so a
  stars or trending ranking shows a meaningful page. Your choice is respected after
  that.
- Feature: "Trending %" sort (today/week/month/year) in the GitHub view. Ranks by
  RELATIVE star growth (window delta / stars at the window's start), so fast-growing
  small apps surface above mega-repos that dominate the absolute-delta sort. A
  10-star baseline floor keeps trivial repos (2->4 stars) out of the top.
- Fix: derive each app's repo from its Project URL only, not Support. Support
  URLs are "get help" links that template authors routinely point at an umbrella
  project's issues/discussions page (every Immich component links to
  github.com/immich-app/immich), which mis-attributed that repo's ~108k stars to
  unrelated components (immich-postgres, immich-redis, etc.). Also ignores GitHub
  non-repo paths (issues/discussions/org pages).
- Fix (critical): store data on the flash (/boot/config/plugins/modern.appstore)
  instead of /mnt/user/appdata. The install hook created its data dir under
  /mnt/user before the array mounted, which made Unraid's shfs refuse to mount
  /mnt/user and hid every user share. Existing installs are migrated automatically.
- Fix: compatibility with the Community Applications 7.2.3 rewrite.
  - Star badge sits in the tile's top-right corner (clear of the app icon); on
    Official/Installed cards it slides left of CA's corner ribbon.
  - GitHub sort works again (star + trending): sort injection targets CA's
    displayed.json regardless of layout churn.
- Fix: trending (day/week/month/year) is now a real, uncapped star delta from
  the daily snapshot history instead of a single stargazer page that saturated
  at 100 and tied every hot repo. Recompute path added (--trends-only, no API).
- GitHub star counts on every CA app tile.
- "GitHub" view: the real App Store catalog, sortable by stars, trending, or newest.
- Per-user GitHub token (set in Settings); no secrets shipped.
</CHANGES>

<FILE Run="/bin/bash">
<INLINE>
<![CDATA[
# The plugin manager SKIPS any inline payload whose target file already exists
# ("skipping: ... already exists" in syslog), so an update over a running
# install used to leave every old file in place and only appear to work after a
# reboot, /usr/local/emhttp being tmpfs. Clearing the webroot first is what makes
# an update actually update.
#
# Only the webroot is cleared. It is rebuilt from this package in full a few
# lines later, and the generated JSON is restored from the flash afterwards.
# /boot/config/plugins/$NAME is the DATA directory (settings, star database and
# its history) and is never touched here.
rm -rf /usr/local/emhttp/plugins/$NAME
mkdir -p /usr/local/emhttp/plugins/$NAME
mkdir -p /boot/config/plugins/$NAME
]]>
</INLINE>
</FILE>

XMLHEAD

for f in "${FILES[@]}"; do emit_payload "$f"; done

cat <<'POSTINSTALL'
<FILE Run="/bin/bash">
<INLINE>
<![CDATA[
# Data dir lives on the flash (like every other plugin) so it exists BEFORE the
# array mounts. A directory created under /mnt/user at plugin-install time (which
# runs early in boot, before the array) leaves /mnt/user non-empty and makes shfs
# refuse to mount it, hiding every user share. Never write to /mnt/user here.
APPDATA=/boot/config/plugins/modern.appstore
OLD_ID=appstore.github.addon
OLDDATA=/boot/config/plugins/$OLD_ID
mkdir -p "$APPDATA"

# One-time migration from the plugin's former id. Carries the GitHub token, the
# star database and its history across, then retires the old install so it stops
# running its cron and stops showing up on the Plugins page. Guarded on the old
# directory existing and being a different path, so a reinstall of THIS plugin
# can never delete its own data.
if [ -d "$OLDDATA" ] && [ "$OLDDATA" != "$APPDATA" ]; then
  if [ ! -f "$APPDATA/stars.db" ]; then
    cp -a "$OLDDATA/." "$APPDATA/" 2>/dev/null
    mv -f "$APPDATA/$OLD_ID.cfg" "$APPDATA/modern.appstore.cfg" 2>/dev/null
    rm -f "$APPDATA/$OLD_ID.cron"
    sed -i "s#$OLD_ID#modern.appstore#g" "$APPDATA/modern.appstore.cfg" 2>/dev/null
    echo " Migrated settings and star history from the previous plugin id."
  fi
  rm -f "$OLDDATA/$OLD_ID.cron"
  rm -f "/boot/config/plugins/$OLD_ID.plg"
  rm -rf "/usr/local/emhttp/plugins/$OLD_ID"
  rm -rf "$OLDDATA"
  /usr/local/sbin/update_cron 2>/dev/null
fi

CFG=/boot/config/plugins/modern.appstore/modern.appstore.cfg
# seed an EMPTY token only if no config exists yet (preserves an existing token)
if [ ! -f "$CFG" ]; then
  printf 'TOKEN=""\nSERVICE="enabled"\nDATA_DIR="%s"\n' "$APPDATA" > "$CFG"
  chmod 600 "$CFG"
fi
# migrate a legacy DATA_DIR under /mnt/user off the array (it breaks shfs mounting)
if grep -q 'DATA_DIR="/mnt/user' "$CFG" 2>/dev/null; then
  sed -i 's#^DATA_DIR=.*#DATA_DIR="'"$APPDATA"'"#' "$CFG"
fi
CRON=/boot/config/plugins/modern.appstore/modern.appstore.cron
# full scan every 3 days; hourly check that only pulls NEWLY published repos
{
  echo '0 4 */3 * * php /usr/local/emhttp/plugins/modern.appstore/fetch_stars.php >/dev/null 2>&1'
  echo '23 * * * * php /usr/local/emhttp/plugins/modern.appstore/fetch_stars.php --new-only 1 >/dev/null 2>&1'
} > "$CRON"
/usr/local/sbin/update_cron 2>/dev/null
# restore persisted star data into the tmpfs webroot so badges work after a reboot
cp -f "$APPDATA/stars.json"  /usr/local/emhttp/plugins/modern.appstore/ 2>/dev/null
cp -f "$APPDATA/apps.json"   /usr/local/emhttp/plugins/modern.appstore/ 2>/dev/null
cp -f "$APPDATA/status.json" /usr/local/emhttp/plugins/modern.appstore/ 2>/dev/null
echo "----------------------------------------------------"
echo " Unraid Modern App Store installed."
echo " Set your GitHub token: Settings -> Utilities -> Unraid Modern App Store"
echo "----------------------------------------------------"
]]>
</INLINE>
</FILE>

<FILE Run="/bin/bash" Method="remove">
<INLINE>
<![CDATA[
rm -f /boot/config/plugins/modern.appstore/modern.appstore.cron
/usr/local/sbin/update_cron 2>/dev/null
rm -rf /usr/local/emhttp/plugins/modern.appstore
rm -rf /boot/config/plugins/modern.appstore
]]>
</INLINE>
</FILE>

</PLUGIN>
POSTINSTALL
} > "$OUT"

# Hard gate, not a promise: the installer is published to a public repo, so it
# must never carry a credential. An early build of the pre-rename artifact did,
# which is why this check exists rather than a comment saying it cannot happen.
if grep -qaE 'gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}' "$OUT"; then
  echo "ERROR: $OUT contains something shaped like a GitHub token. Refusing to ship it." >&2
  rm -f "$OUT"
  exit 1
fi
if grep -qaE '^TOKEN="[^"]+"' "$OUT"; then
  echo "ERROR: $OUT ships a non-empty TOKEN= line. Refusing to ship it." >&2
  rm -f "$OUT"
  exit 1
fi

echo "Built $OUT ($VERSION), token-free (verified), ${#FILES[@]} files embedded."
