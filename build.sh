#!/bin/bash
# Build a self-contained, SHAREABLE appstore.github.addon.plg from src/.
# Embeds every src file inline (CDATA) plus install/remove scripts.
# Contains NO secrets — the GitHub token is left empty and each user sets their
# own at Settings -> Utilities -> App Store GitHub Addon. Safe to publish.
#
# Usage: ./build.sh [version]   (default version below)
set -euo pipefail

cd "$(dirname "$0")"
VERSION="${1:-2026.07.20}"
NAME="appstore.github.addon"
SRC="src/usr/local/emhttp/plugins/$NAME"
OUT="$NAME.plg"
PLUGIN_URL="https://raw.githubusercontent.com/ghzgod/appstore-github-addon/main/appstore.github.addon.plg"
SUPPORT_URL="https://github.com/ghzgod/appstore-github-addon"

# --- payload files (order: php, js, css, pages, readme) --------------------
FILES=(fetch_stars.php refresh.php cancel.php sortinject.php newscan.php inject.js inject.css AppStoreGitHubAddon.page AppStoreGitHubAddonLoader.page README.md)

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
# refuse to mount it — hiding every user share. Never write to /mnt/user here.
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

echo "Built $OUT ($VERSION) — token-free, ${#FILES[@]} files embedded."
