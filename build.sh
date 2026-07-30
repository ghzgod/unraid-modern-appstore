#!/bin/bash
# Build a self-contained, SHAREABLE appstore.github.addon.plg from src/.
# Embeds every src file inline (CDATA) plus install/remove scripts.
# Contains NO secrets. The GitHub token is left empty and each user sets their
# own at Settings -> Utilities -> App Store GitHub Addon. Safe to publish.
#
# Usage: ./build.sh [version]   (default version below)
set -euo pipefail

cd "$(dirname "$0")"
VERSION="${1:-2026.07.30n}"
NAME="appstore.github.addon"
SRC="src/usr/local/emhttp/plugins/$NAME"
OUT="$NAME.plg"
PLUGIN_URL="https://raw.githubusercontent.com/ghzgod/unraid-modern-appstore/main/appstore.github.addon.plg"
SUPPORT_URL="https://github.com/ghzgod/unraid-modern-appstore"

# --- payload files (order: php, js, css, pages, readme) --------------------
FILES=(fetch_stars.php refresh.php cancel.php sortinject.php newscan.php applist.php pinned.php inject.js inject.css AppStoreGitHubAddon.page AppStoreGitHubAddonLoader.page README.md)

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
<PLUGIN name="&name;" author="&author;" version="&version;" pluginURL="&plugin;" launch="Settings/AppStoreGitHubAddon" min="6.12" icon="star" support="&support;">

<CHANGES>
##$VERSION
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
- Fix (critical): store data on the flash (/boot/config/plugins/appstore.github.addon)
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
APPDATA=/boot/config/plugins/appstore.github.addon
mkdir -p "$APPDATA"
CFG=/boot/config/plugins/appstore.github.addon/appstore.github.addon.cfg
# seed an EMPTY token only if no config exists yet (preserves an existing token)
if [ ! -f "$CFG" ]; then
  printf 'TOKEN=""\nSERVICE="enabled"\nDATA_DIR="%s"\n' "$APPDATA" > "$CFG"
  chmod 600 "$CFG"
fi
# migrate a legacy DATA_DIR under /mnt/user off the array (it breaks shfs mounting)
if grep -q 'DATA_DIR="/mnt/user' "$CFG" 2>/dev/null; then
  sed -i 's#^DATA_DIR=.*#DATA_DIR="'"$APPDATA"'"#' "$CFG"
fi
CRON=/boot/config/plugins/appstore.github.addon/appstore.github.addon.cron
# full scan every 3 days; hourly check that only pulls NEWLY published repos
{
  echo '0 4 */3 * * php /usr/local/emhttp/plugins/appstore.github.addon/fetch_stars.php >/dev/null 2>&1'
  echo '23 * * * * php /usr/local/emhttp/plugins/appstore.github.addon/fetch_stars.php --new-only 1 >/dev/null 2>&1'
} > "$CRON"
/usr/local/sbin/update_cron 2>/dev/null
# restore persisted star data into the tmpfs webroot so badges work after a reboot
cp -f "$APPDATA/stars.json"  /usr/local/emhttp/plugins/appstore.github.addon/ 2>/dev/null
cp -f "$APPDATA/apps.json"   /usr/local/emhttp/plugins/appstore.github.addon/ 2>/dev/null
cp -f "$APPDATA/status.json" /usr/local/emhttp/plugins/appstore.github.addon/ 2>/dev/null
echo "----------------------------------------------------"
echo " App Store GitHub Addon installed."
echo " Set your GitHub token: Settings -> Utilities -> App Store GitHub Addon"
echo "----------------------------------------------------"
]]>
</INLINE>
</FILE>

<FILE Run="/bin/bash" Method="remove">
<INLINE>
<![CDATA[
rm -f /boot/config/plugins/appstore.github.addon/appstore.github.addon.cron
/usr/local/sbin/update_cron 2>/dev/null
rm -rf /usr/local/emhttp/plugins/appstore.github.addon
rm -rf /boot/config/plugins/appstore.github.addon
]]>
</INLINE>
</FILE>

</PLUGIN>
POSTINSTALL
} > "$OUT"

echo "Built $OUT ($VERSION), token-free, ${#FILES[@]} files embedded."
