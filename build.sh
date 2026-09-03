#!/bin/bash
# Build a self-contained, SHAREABLE modern.appstore.plg from src/.
# Embeds every src file inline (CDATA) plus install/remove scripts.
# Contains NO secrets. The GitHub token is left empty and each user sets their
# own at Settings -> Utilities -> Unraid Modern App Store. Safe to publish.
#
# Usage: ./build.sh [version]   (default: today's date, next free suffix)
set -euo pipefail

cd "$(dirname "$0")"

# The version's date is read off the clock, never typed.
#
# Unraid's plugin system documents the version as "YYYY.MM.DD, with a letter
# suffix when several ship on one day", and it is the ONLY date the catalog
# carries for a plugin: Community Applications records when it last scanned a
# plugin, not when the plugin shipped, and neither its cdn redirector nor
# raw.githubusercontent answers a Last-Modified for the .plg itself. So the
# store reads a plugin's version as its release date, because there is nothing
# else to read, and 289 of the catalog's 308 plugins are versioned this way.
#
# Which makes a hand-typed version a way to publish a false fact. This package
# spent ten releases numbered 2026.09.04 while the date was the 2nd of
# September, because the date field was being incremented as though it were a
# serial number: 2026.09.01, then .02, then .03, then .04 and ten letters after
# it, all on the 1st and 2nd. Its own card then read "last updated Sep 4" two
# days before that day existed.
#
# TODAY comes from the clock and SUFFIX is the first letter this date has not
# already shipped under, so a same-day release moves the letter and never the
# date. The guard below refuses to build anything else, including a version
# passed as an argument, which is what makes a future date impossible rather
# than merely unlikely.
TODAY="$(date +%Y.%m.%d)"
next_version() {
  local esc suffix log
  # Read once into a variable and match with a here-string. Piping git log into
  # grep -q looks equivalent and is not: grep exits on its first match, git log
  # takes SIGPIPE, and under `set -o pipefail` the whole pipeline then reports
  # failure, so every suffix tested as unused and the picker always answered
  # with the first one.
  log="$(git log --format='%s' 2>/dev/null || true)"
  esc="$(printf '%s' "$TODAY" | sed 's/\./\\./g')"
  for suffix in '' {a..z}; do
    if ! grep -q "^Release ${esc}${suffix}\b" <<< "$log"; then
      printf '%s%s' "$TODAY" "$suffix"
      return 0
    fi
  done
  echo "ERROR: every suffix for $TODAY is already published" >&2
  return 1
}
VERSION="${1:-$(next_version)}"
case "$VERSION" in
  "$TODAY"|"$TODAY"[a-z]) ;;
  *)
    echo "ERROR: version '$VERSION' does not carry today's date ($TODAY)." >&2
    echo "       A plugin's version IS its release date to every store that reads it," >&2
    echo "       so a version dated anything else publishes a date that is not true." >&2
    exit 1
    ;;
esac
NAME="modern.appstore"
SRC="src/usr/local/emhttp/plugins/$NAME"
OUT="$NAME.plg"
PLUGIN_URL="https://raw.githubusercontent.com/ghzgod/unraid-modern-appstore/main/modern.appstore.plg"
SUPPORT_URL="https://github.com/ghzgod/unraid-modern-appstore"

# --- payload files (order: php, js, css, pages, readme) --------------------
FILES=(fetch_stars.php refresh.php cancel.php newscan.php scanpage.php applist.php pinned.php lastupdate.php icontone.php addeddate.php about.php latest.php config.php settings.php inject.js inject.css ModernAppStore.page ModernAppStoreLoader.page README.md)

# guard: CDATA cannot contain ]]>
for f in "${FILES[@]}"; do
  if grep -q ']]>' "$SRC/$f"; then echo "ERROR: $f contains ]]> (breaks CDATA)" >&2; exit 1; fi
done

# guard: the icon is read through a command substitution further down, where a
# missing file yields an empty payload rather than an error, and the package
# would install a zero-byte icon. Fail here instead.
if [ ! -s icon.png ]; then
  echo "ERROR: icon.png is missing or empty; the plugin icon would ship as a zero-byte file" >&2
  exit 1
fi

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
<!-- No icon attribute on purpose. Community Applications copies it into the
     field it calls IconFA and, when that field is set, draws a Font Awesome
     glyph in the app drawer instead of the app's real icon. With it absent CA
     falls back to the icon image, and Unraid's own Plugins page falls back to
     plugins/<name>/<name>.png, which this package installs below. -->
<PLUGIN name="&name;" author="&author;" version="&version;" pluginURL="&plugin;" launch="Settings/ModernAppStore" min="6.12" support="&support;">

<CHANGES>
##$VERSION
- The version this package publishes is dated the day it is built. It had been
  a hand-typed string in the build script, and the date field was being
  incremented as though it were a serial number, so ten releases went out
  numbered 2026.09.04 while the date was the 2nd of September. A plugin's
  version IS its release date to every store that reads one, this store
  included, so the card for this plugin read "last updated Sep 4" two days
  before that day existed. The build now takes the date off the clock, moves
  the letter suffix for a second release on one day, and refuses to build a
  version dated anything but today.
- Because 2026.09.02b sorts below the 2026.09.04 series it replaces, an
  installation already on one of those will not be offered this release.
  It will pick up the next one as normal.

##2026.09.04j
- A search marks the words it matched inside a card's own blurb instead of
  replacing the blurb with a passage cut from elsewhere. That passage came out
  of the searchable text, which is the maintainer's name, the template's extra
  search terms and the overview joined together, so a search for a maintainer
  landed on the name and printed whatever sentence fragment sat beside it. The
  card said something the app never said.
- A card's blurb stops after its second sentence. It used to keep folding
  sentences in until it had 170 characters, which let a blurb of short
  sentences run to five of them and lose its tail mid-thought. Where two
  sentences still overrun the band, the card ends them on an ellipsis.
- An app whose screenshot no longer resolves shows no screenshot. Community
  Applications writes the picture straight out of the template and never checks
  it, and a fair number of those links now answer 404, so the page-wide error
  handler painted a 200px placeholder that the gallery rule then stretched
  across the whole drawer as a giant question mark. Roughly one template in ten
  is affected, agent-zero and Appwrite among them.
- The drawer's description reads as paragraphs. An author's plain-text indent
  arrived as runs of non-breaking spaces, which do not collapse the way an
  ordinary space does, and a blank line arrived as three or four breaks, so a
  description printed indented halfway down and spread over acres of nothing. Indentation goes, a paragraph break is one
  blank line, and a list of bullets closes up instead of putting a blank line
  between every item.
- Every card's strip wears its icon's colour, whatever order the pictures
  arrive in. The colour was applied from inside the icon's load handler, which
  an already-cached icon fires before the card exists and a lazily-loaded one
  below the fold does not fire at all, so the top of the grid went grey on a
  second visit and the bottom stayed grey until it was scrolled to.
- The artwork inside an icon is measured and centred, so two icons that differ
  only in the margin their author baked in land on the card at the same size.
  SVGs, which cannot be rasterised on the server, are measured in the browser
  and the answer is cached with the rest.
- An app already installed shows a grey Installed button that does nothing,
  in place of Install. CA's own check compares the feed's redirector URL with
  the installed plugin's and matched none of the 308 plugins in the catalog;
  matching on the .plg filename finds them.
- A release date in the future reads N/A. A plugin's version is read as its
  release date, and a version numbered ahead of today printed as a date that
  has not happened yet.

##2026.09.04i
- Project and Support open the template's link exactly as the maintainer
  published it, as CA does. 2026.09.04g had the plugin resolve and repair
  those links; a wrong destination is the template's to fix, and the plugin
  no longer stands between the two.
- The icon plate is a darker grey, so the artwork stands off it.

##2026.09.04h
- A maintainer's drawer lists their apps as the store's own cards, with the
  same strip, facts, byline and buttons, instead of a flat row per app. They
  are the compact cut: every size on its floor and a two-line blurb, since
  they sit in a list.
- The drawer's Total Applications reads the number of apps listed under it
  when CA's own count comes back 0.
- A date the catalog does not have reads N/A in the drawer, the same word a
  missing count wears in the strip, instead of Unknown.

##2026.09.04g
- Project and Support open the page itself. Both used to open CA's
  https://ca.unraid.net/cdn/ redirector, and for seven apps (binhex-paseo,
  code-server, Crafty, Deluge, Emby, get_iplayer, Overseerr) that redirector
  answers with a doubled scheme, https://https://github.com/..., which no
  browser can open. The scan now resolves every Project and Support link once
  and stores where it lands, repairing a doubled scheme on the way; the page
  repairs stored links written before this release; and a click repairs
  whatever still reaches it.
- One plate behind every icon: a mid grey mixed from the theme, on the card,
  in the drawer and in the repo list. Dark artwork used to get a near-white
  plate of its own, so a row of cards showed two kinds of icon box.
- A missing count in the strip reads N/A in capitals. Lower-case n/a sat
  visibly low beside the figures next to it.

##2026.09.04f
- The five groups in the strip (four facts and the docker or plugin glyph)
  sit at one gap. The glyph used to stand a few pixels further from the added
  date than the facts stood from each other.

##2026.09.04e
- Each glyph in the strip sits 2px from its figure instead of 5px, so a star
  and its count read as one mark and the gap between the four facts is what
  separates them.

##2026.09.04d
- Installed is grey. An app whose exact Docker repository or plugin is already
  on the server gets a dimmed Installed pill in place of Install, rather than
  the green the pinned button wears.
- The first paint waits for the installed and pinned sets as well as the
  catalog, so a card can no longer be drawn with Install while the server was
  still saying which apps it has.

##2026.09.04c
- The four facts in the strip sit on one line: the two dates carried a taller
  line box and a lighter weight than the two counts beside them, so their
  text sat a pixel off next to icons that were level.

##2026.09.04b
- Card type is one step larger at every column count; at four columns it
  was sitting on its floor and read small on a 2x display.
- The maintainer and category rows start their text on one edge: the tag
  glyph takes the avatar's box. Both marks are amber now, the person glyph a
  maintainer without a picture gets and the category tag, and the star in
  the maintainer's standing sits before its count, as it does in the strip.

##2026.09.04a
- The categories sit on a line of their own under the maintainer, so both
  print whole. On one line the maintainer's standing left the categories as
  "Downloaders and 2 more" on most cards.

##2026.09.04
- The card is three bands instead of four. The stars, downloads, last update
  and added date now sit in the tinted strip beside the Docker or plugin
  glyph, in their short form (8d, 3w, 5mo, 2y; the tooltip keeps the full
  date), and the description takes the row they left: three lines rather than
  two, with sentences folded in until the blurb fills them.
- Each fact in the strip has its own colour: amber stars, teal downloads, a
  violet clock for the last update and a rose calendar for the added date.
- The maintainer's standing follows their name: how many templates they
  publish and the GitHub stars across them, as "(64 apps · 292k stars)", summed
  from the catalog already in hand.
- Not compatible is a red badge beside the app name, like the Official and
  Unraid flags, instead of a red sentence in the description. A new setting,
  Hide incompatible apps (default No), drops those templates from every list
  except Installed Apps.
- Strip colours no longer go grey for good after one bad batch: a failed icon
  read is held for the page load only, never written to the browser or the
  server cache, so the icon is asked about again next time.

##2026.09.03
- New setting, Cards per row (2 to 6, default 3), in the settings panel and on
  the plugin's settings page. It is the count on a window wide enough to hold
  it; a narrower window shows as many as fit, never squeezing a card under
  340px. Stored in the plugin's own config, so it survives updates.
- Screenshots in the repository, and the README describes the current card.

##2026.09.02a
- The app card is redesigned. A strip across the top of every card is tinted in
  that app's own icon colour, read off the icon on the server: the strongest
  hue by chroma, so a gold compass on a navy plate gives gold, an outline mark
  gives its outline, and an SVG icon gives the colour its shapes are filled
  with. A greyscale icon gets a neutral strip rather than borrowing a colour.
  The strip fades to the right and downward so the icon, which sits on its
  bottom edge on an opaque plate, and the kind glyph in its corner never fight
  it.
- The name has the whole width of the card and always prints whole, with the
  Official, Beta, Privileged and Unraid flags beside it as words. Under it the
  maintainer and the categories share one line, and the line prints as many
  categories as it has room for rather than always two: "and 1 more" no longer
  stands where the word it stood for would have fit. Stars, pulls, updated and
  added sit on one facts line.
- The six buttons are six equal cells on one row at every width, every label
  whole, Install filled in orange on the right. The type steps down with the
  card, to 8.5px on a phone, and never ellipsises.
- Three cards to a row, never four: a fourth column bought nothing but smaller
  type, since every size on the card scales with its column. Two columns below
  1048px of grid, one below 694px.
- Apps published by Unraid wear an Unraid flag, from the feed's LTOfficial
  mark.
- The toolbar no longer breaks apart between 768 and 1200px: the sort control,
  the view toggle and the three buttons move as one row, beside the search box
  when they fit and on the line under it when they do not, with the buttons
  right-aligned at their usual 8px. Below 960 the search box takes the whole
  row and the toggle leads a line of its own with the buttons on the right.
- The icon colour cache moved to a new file and a new browser key, so the
  first load after updating asks the server for every icon again.

##2026.09.02
- The About panel gains a Check for Updates button in its header, beside the
  report-an-issue and close icons. It asks right now rather than waiting on the
  cached check that only re-runs every six hours, spins while it works, and says
  which version you are on when there is nothing to do. When there is an update
  it names both versions and installs it through Unraid's own plugin updater,
  with Unraid's own progress window.
- Updating no longer tells you to set a GitHub token you have already set. That
  line was printed at the end of every install, so an update on a server
  configured months ago read as though the update had wiped it. It now prints
  only when no token is configured, and an ordinary update just says so.

##2026.09.01
- Show All Apps on a maintainer used to filter the grid through a hidden mode
  that left the search box empty, so there was no way back to the full catalog
  short of reloading. It writes a qualifier into the search box now,
  maintainer:atribe, or the quoted form when a name carries a space, so the
  filter is something you can see, edit and clear. It combines with ordinary
  search terms too: maintainer:Unraid nvidia narrows within that maintainer.
  The match is exact rather than a text search, which matters more than it
  sounds: searching a maintainer's name as plain text returns 1,789 apps for
  one who has published 1, because the search reads descriptions and hidden
  keywords as well as names.
- The category line under an app's name sat crooked at some browser zoom levels
  and straight at others. Its two halves were separate boxes, and a flex row
  centres each box on its own centre rather than aligning their baselines, so
  the two rounded to device pixels independently and drifted apart at 100 per
  cent while landing true at 90. They are one run of text now, which shares a
  baseline by definition.
- Seven of the card's icons were not centred inside their own artwork, so a tag
  or a shield sat half a pixel high and the download arrow sat half a pixel low
  against the text beside them. Each is corrected at the source. The tag beside
  a category and the person mark beside a maintainer are also cropped to their
  own drawing, so they line up with the maintainer's photograph in the row above
  rather than starting two pixels to its right.
- The maintainer profile drawer puts its statistics under the header and its app
  list below that, so the list grows downward as a maintainer publishes more
  instead of leaving a band of empty drawer between the two. Its heading spacing
  is even now as well.
- The Favourite button reads Favorite, and no longer grows two pixels wider than
  the button beside it when it is switched on.
- The update indicator's slot in the toolbar closes up when there is no update,
  rather than leaving a gap where the icon would have been.

##2026.08.31
- Every section of the info drawer now sits in the same card. Additional
  Requirements, the Trends chart, the change log, Template Errors and the
  maintainer profile's Statistics all rendered as a bare heading with loose
  text under them, while every other section sat in a grey card, so the drawer
  read as two designs stacked on each other. They also never shared a padding:
  the description and the Details table sat on one value and everything else on
  another, so the text started at a different inset every third block. There is
  one value now.
- The card names the person who publishes the app rather than the company that
  wrote the software. Community Applications carries both, and they disagree on
  2,722 of the 3,873 displayable apps, so seven cards in ten were showing one
  person's face beside another one's name and naming someone the drawer, one
  click away, never mentioned. Grafana read "grafana" on the card and "atribe"
  in its own maintainer panel; both say atribe now.
- A download or star figure nobody measured no longer reads as the number
  nought. Only 4 apps in the catalog have a download count Community
  Applications measured as zero and only 164 have a repository with genuinely
  no stars, yet 998 cards and 1,689 cards respectively were printing one. Those
  read n/a now, and hovering says which of the reasons applies: an image
  Docker Hub does not carry, an app running a shared official base image where
  the only figure available belongs to that base image, or a repository the
  scanner has not matched yet.
- Apps Community Applications marks incompatible with this server no longer
  offer a working Install button. There are 36 of them, and its own drawer
  renders no install action for them at all, while this grid offered one and
  said nothing.
- Official and pre-release templates carry a badge, 394 and 211 of them. The
  catalog has several competing templates for some apps and this is the one
  fact that separates them. An app whose container runs privileged carries a
  shield in the card footer: 114 do, and Community Applications carries a
  moderator comment on only 273 templates in total, so most of those said
  nothing about it anywhere the reader would see.
- An app whose template names no icon draws the glyph its author chose instead
  of a question mark. 117 apps have no icon and 59 of those name a glyph, which
  the stock drawer draws and this grid used to throw away. The two icon fonts
  are told apart, so Unassigned Devices Preclear draws the mark the stock
  drawer leaves as a blank square.
- The maintainer's readme is a button in the drawer, on the 721 apps that name
  one. Neither this plugin nor the stock drawer linked it before.
- The maintainer profile's Statistics gains the total stars of everything that
  maintainer packages, counting each upstream project once rather than once per
  app, since several templates often point at the same repository.
- The drawer says Loading while it fills, and shows its contents once. It used
  to open blank for up to three seconds, and on a second visit it painted a
  stashed copy of the previous render, which the real answer then replaced a
  moment later. On some apps that first copy carried a duplicate Last Update
  and GitHub stars row that then vanished.
- The toolbar gains an update indicator between the help and settings icons. It
  appears only when the installed version is behind the published one, and
  opens the Plugins page, where it can be updated. The About panel names both
  versions.
- Card titles take one line and truncate with an ellipsis rather than wrapping
  to two, so the maintainer and category move up. The full name is on hover.
- Smaller things: the spotlight badge is legible rather than a smudge, the
  maintainer card no longer breaks when a maintainer takes donations, the
  drawer's icon is one fixed square instead of a different size per app, and
  the author line in the drawer header says AUTHOR so it is not mistaken for
  the maintainer named below it.

##2026.08.29
- GitHub locked down its stargazers and watchers listing endpoints
  (/repos/{owner}/{repo}/stargazers and /subscribers) to a repository's own
  admins and collaborators, announced in its changelog on 30 June 2026 and
  effective that July. Its stated reason, verified first-hand against the live
  API: those endpoints exposed public lists of stargazers and watchers, and
  that data "has increasingly been misused to collect user data for spam
  activities." The lock covers the REST endpoints and the GraphQL stargazers
  connection alike, and no token type is exempt: a classic token fails, a
  fine-grained token fails, and so does a repository's own owner testing
  against their own repo. Star counts alone are untouched, since a count comes
  from the repository object rather than the list GitHub just closed off.
- This closed off the only way the two "this year" trending orders had of
  reaching a year-ago baseline, which was walking a repository's stargazer
  list and reading the date on each star. That path is gone for every install,
  not just this one, since GitHub applied the restriction to the API itself
  rather than to any particular caller or use.
- In its place the plugin now keeps its own daily star snapshot for every app
  in the catalog and builds every trending window from that history alone,
  fetching nothing from GitHub or anywhere else to do it. Today, this week and
  this month already run on it. The two year windows need 365 days of recorded
  history before they can produce a real delta, and each fills in on its own
  the day an install crosses that mark.
- A GitHub token is still worth setting, but only for the rate limit: GitHub
  allows 60 requests an hour with no token at all, which a catalog this size
  burns through in minutes, against 5,000 with one. Which kind of token no
  longer matters in the slightest, since the only thing token type ever
  changed was whether star dates could be read, and that door is now shut for
  both kinds alike. The grid itself says plainly how many days of history an
  install has on hand and when its year windows will fill in, rather than
  pointing at the token as if a different one would fix it.
- The four orders the App Store's own front page is built from are in the sort
  menu: Spotlight Apps, Top Trending, Top New Installs and Most Popular
  Plugins. They are worked out from the same feed and the same thresholds the
  App Store uses itself, so a list here holds every app that qualifies rather
  than the handful a front-page row has space for.
- The sort menu is grouped by where its numbers come from. The two name orders
  belong to neither source, so they sit at the top under no heading at all.
  Below them is one section per source, Unraid and GitHub, each carrying its
  own mark. The source is named once, in the heading, so no entry underneath
  repeats it: "Unraid Downloads" is now "Most Downloaded" and "GitHub Stars"
  is "Most Stars".
- The plugin says something when it needs attention, through Unraid's own
  notifications, rather than leaving it on a settings page nobody has a reason
  to open. No GitHub token configured is the case that raises one. It is
  raised once when it starts and not again until it clears, and clicking it
  opens the settings page that explains the fix. There is a switch to turn
  them off next to the one that turns the plugin on.
- Plugins show how many servers have installed them. Every plugin in the store
  reported zero, because the count is thrown away for any image published
  without an owner name (that number belongs to a base image like nginx, not
  to the app), and a plugin has no image reference at all to test.
- The plugin's own icon shows everywhere it should. The Settings tile under
  Utilities, Unraid's Plugins page and the app drawer in Community
  Applications all drew a grey star, because the package declared its icon as
  the word "star" and Unraid reads a bare word as a Font Awesome glyph name.
  The real icon ships with the package now and is named so that every one of
  those three places finds it.
- How often the star data is refreshed is a setting, under Settings, Utilities,
  Unraid Modern App Store. It defaults to once a day. The trending orders are
  differences between two scans, so on the old three-day schedule the
  "today" window compared a number against itself and came up empty.
- The sort dropdown is drawn by the plugin instead of the browser. A page can
  style a select's closed state but never the list it opens, so on Safari that
  list came up as a light system menu on every theme. The list is the plugin's
  own now: the field is sized to its longest entry, the list opens at exactly
  that width and left edge, and the sort you are on is named in the accent
  colour rather than marked with a tick that pushed its label out of line.
- A "Recently Updated" sort, ordering the grid by when each app was last
  updated. Apps the feed carries no update date for sort last.
- The toolbar row shares the grid's width: the search box starts on the first
  card's left edge and the Modern view toggle ends on the last card's right
  edge, at every window width and font size. Nothing is drawn around the row
  itself, so the controls carry that alignment on their own.
- Flipping Modern view off and back on no longer nudges the toggle. It is
  anchored to the search band in both views, so the two layouts cannot move
  it between them.

##2026.08.23b
- The toolbar became a header: the search box and its magnifier join into a
  single control, the sort dropdown is a pill with air around its triangle,
  the refresh icon is a proper button, and the category menu sits beside the
  row rather than under it. 7.1 keeps its own layout, which was left exactly
  as the previous release verified it.
- The store says when it was last brought up to date, next to the refresh
  button: "Updated 12 min ago", counted from Community Applications' own feed
  sync. Hovering it shows the exact time of that sync and of the last GitHub
  star scan.

##2026.08.23a
- The "All Apps" heading and its count are readable again on windows 1024px and
  narrower. CA clamps the search band's sticky holder to a fixed height there
  that is shorter than the band itself, so the band's overflow lay over the
  first line of the content column and hid the heading. The holder now sizes
  to its band and the column starts below it.

##2026.08.23
- On Unraid 7.2 and newer the search row from 2026.08.22a sat 12px left of the
  cards. Those releases lift the search band to the body while the grid keeps
  the inset Unraid draws around the content column, so the band's derived
  offset now adds that inset back on them. Measured flush with the cards on a
  live 7.3.2 server at every font size setting and width. 7.1 and older keep
  the plain sum, which was measured right on a live 7.1.4 server.

##2026.08.22a
- The search box is no longer hidden behind the category menu. On Unraid 7.1 and
  older it was covered at every window size, not only narrow ones. The modern
  view cleared Community Applications' own left padding off the search row and
  set the row's left edge itself with a margin. On 7.1 and older CA never loads
  its responsive stylesheet, and pins that row's margin with an !important rule
  of its own, so the replacement edge was silently discarded: the row collapsed
  to the left of the window, where the category menu sits, and the menu was
  drawn over it. The edge is set with padding now, which CA does not pin, so it
  holds on every release and every theme.
- On the azure and gray themes the row was pulled a further 85px left, well under
  the menu, by a second Community Applications rule that was not cleared. That
  one is cleared too.
- The row's left edge is derived from the width of the menu column rather than
  hard-coded, so it stays with the cards at every font size setting instead of
  only the default.
- Clicking a category in the left menu shows its apps again. Every category came
  up empty in the modern view. The grid filtered on the category text it prints
  on each card, which is the app's first category with the colons taken out of
  it, "Network Management". Community Applications asks for categories in its own
  raw form, which always carries a colon: "Network:" for the parent and
  "Network:Management" for the child. The two can never match, so every category
  selected nothing at all. The grid is handed CA's untouched category text as a
  separate field now and matches on that, the same way CA matches it itself. The
  card keeps its short label.
- An app filed under several categories is found under all of them rather than
  only the first one listed, so a category no longer hides apps that belong in
  it. Tools / Utilities returns a couple of thousand apps where it returned none.
- The category menu stays put while the grid scrolls, on the black and white
  themes. It used to scroll away with the page, so changing category on a long
  page meant scrolling back to the top first. A menu taller than the window
  scrolls within itself and stops clear of the footer, so the entries at the
  bottom stay reachable rather than being pinned off the edge of the screen.

##2026.08.22
- The DockerHub and Apps buttons no longer flash into the toolbar on every page
  load. Community Applications marks them hidden in the markup, but a later
  rule in its own stylesheet gives them a display back at equal weight, so the
  hiding never took and the buttons stayed on screen until CA's script reached
  them by hand. Neither belongs in the modern view (both switch CA's own search
  and draw into the grid this plugin replaces), so they are held down from the
  first frame.
- The same flash on the Docker and Plugins rows nested under Installed Apps and
  Previous Apps is gone too. They are meant to appear only once their parent is
  clicked, and now they do.

##2026.08.16a
- Installing an app from the modern grid works again. The grid opened the
  template editor directly, skipping the step Community Applications always
  runs first, which prepares the template for this specific server (falling
  back from a custom network to br0 or eth0, remapping paths to disks the
  server does not have, and picking the icon for the current theme). It also
  percent-encoded the template path, which CA passes through raw. Both are
  fixed, so the editor now opens on a template it can actually build.
- Apps that carry additional requirements now show the same Attention notice
  before installing that Community Applications shows, styled for the modern
  view, along with a warning when a port the app wants is already in use on
  this server. It sizes itself to the window rather than overflowing it on a
  phone, and a long notice scrolls with the OK button still in reach instead
  of running off the bottom of a short window.

##2026.08.13
- The Info drawer's change log now shows every entry in full. It was clamped
  to a preview height with its expander hidden, which left everything past the
  first entry unreadable, and it was also painted with a fade that dissolved
  the text into the background well before the end of the list. The clamp and
  the fade are both dropped, so the log reads at one contrast to the last line.
- Plugin cards whose template ships no icon now fall back to the author's
  GitHub avatar, the way docker apps already did. Plugins have no docker
  repository to derive an owner from, so their project link is read instead;
  they showed a question mark before.
- An avatar that GitHub dropped while a screenful of cards asked for theirs at
  once is retried before the card gives up on it. One dropped request used to
  leave a permanent question mark on a card whose icon loads fine on reload.
- The search row has equal space above and below it, and the search box now sits
  on the same line as Home in the menu beside it. It had 6px of air on top
  against 14 underneath, so it read as hanging off the navigation bar.
- The search box now starts on the same left edge as the All Apps heading, the
  cards and the pager, so the page has one column edge instead of the search
  box sitting twelve pixels inside it. The heading's own two pixel indent is
  gone with it.
- The search box, the magnifier, the Modern view toggle and the Sort By controls
  share one centre line, and the row wraps instead of running off the right edge
  on a phone. The band also stops reserving the menu's 195px on the widths where
  Community Applications does not draw a menu.

##2026.08.12
- While Community Applications is still downloading its catalog after a boot,
  the grid shows a spinning wheel above the explanation instead of a bare line
  of text, so the wait reads as work in progress rather than an empty store.
- Refresh this page now spins the toolbar's refresh icon while the visible
  apps' star data is refetched, and stops when the new numbers land. The click
  previously gave no sign anything was happening.

##2026.08.10
- Fix: searching in the modern view found nothing for words that Community
  Applications matches dozens of apps on. CA searches an app's full description
  and its ExtraSearchTerms, a hidden keyword list many templates carry, while
  this grid searched the name, category and repository alone. So "emulator" came
  back empty here and listed Companion, romm, ipxbox and twenty others with
  modern view switched off. Every word of a query is now matched the way CA
  matches it, each word having to appear somewhere and any field counting,
  across the name, author, repository, image, categories, the full description
  and those hidden keywords.
- Apps whose name matches are listed ahead of apps that only mention the word
  further down their description, so a search for "plex" no longer buries Plex
  under everything that talks about it. The chosen Sort By still orders each of
  the two groups.
- Clearing the search with Community Applications' own X button now clears the
  grid with it. CA empties the box through jQuery, which fires no input event,
  so the grid stayed filtered on a query that was no longer on screen.
- A search now covers the whole store rather than the category that happened to
  be open, which is what CA does: it disables its category menu for the duration
  of a search.

##2026.08.06c
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
- Descriptions written as hard-wrapped plain text no longer render as ragged,
  indented fragments. Many templates carry a line break every eighty characters
  followed by four spaces of indent, which is invisible in the editor they were
  written in and nonsense in a panel of a different width. Those wraps are now
  joined back into paragraphs, while a deliberate blank line between paragraphs,
  and a short line that was meant to stand alone, are both left as written.
- The description block is the same width as the Details card below it, instead
  of the 90% Community Applications gives it.
- The category menu no longer starts a search bar's height below the toolbar,
  which left a hole in the left column. Home now sits on the search box's line.
  The menu also picks up the grid's own styling, and marks the entry you are
  actually looking at, which it never did before.
- The version Community Applications prints at the foot of that menu is now one
  quiet line rather than two lines set in the same type as the navigation above
  it. A footnote should not read as another place to click.

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

<!-- The plg format has no dependency attribute of its own. The only
     declarative gate the installer honours is min=/max= on the PLUGIN
     element above, and that compares against the Unraid OS version, never
     against another plugin, so a dependency on Community Applications has
     to be enforced imperatively, in a Run script, the same way
     unassigned.devices-plus.plg gates on Unassigned Devices. The installer
     runs every FILE block through popen(), streams its output straight to
     the user as it runs, and stops the whole install the instant a block
     exits non-zero, printing nothing more than "run failed" and the exit
     code. This block runs first, before a single file is written or
     removed, and only stops the install when Community Applications is not
     already on the box. -->
<FILE Run="/bin/bash">
<INLINE>
<![CDATA[
if [ ! -f /boot/config/plugins/community.applications.plg ]; then
  echo ""
  echo "-----------------------------------------------------------------"
  echo " Unraid Modern App Store needs Community Applications."
  echo ""
  echo " This plugin is a new front end for the Apps page. It reads"
  echo " Community Applications' own catalog and draws over its page, so"
  echo " there is nothing for it to do until that plugin is installed."
  echo ""
  echo " Install Community Applications first:"
  echo "   https://forums.unraid.net/topic/38582-plug-in-community-applications/"
  echo ""
  echo " Then install this plugin again. Nothing has been changed on your"
  echo " server and no files were written."
  echo "-----------------------------------------------------------------"
  echo ""
  exit 1
fi
]]>
</INLINE>
</FILE>

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

# The icon is a binary PNG, so it cannot ride in a CDATA payload like the text
# files above. It is base64 encoded into an install script instead and decoded
# in place. The name matches the plugin's, which is where both Unraid's Plugins
# page and the Settings tile look for it.
cat <<ICONBLOCK
<FILE Run="/bin/bash">
<INLINE>
<![CDATA[
cat <<'ICONB64' | base64 -d > /usr/local/emhttp/plugins/$NAME/$NAME.png
$(base64 < icon.png)
ICONB64
chmod 644 /usr/local/emhttp/plugins/$NAME/$NAME.png
]]>
</INLINE>
</FILE>

ICONBLOCK

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
  printf 'TOKEN=""\nSERVICE="enabled"\nDATA_DIR="%s"\nSCAN_DAYS="1"\n' "$APPDATA" > "$CFG"
  chmod 600 "$CFG"
fi
# An install from before the interval was a setting has no SCAN_DAYS line. Give
# it the daily default rather than leaving the scan on the old three-day cycle,
# which is too coarse for the trending windows to hold anything.
if ! grep -q '^SCAN_DAYS=' "$CFG" 2>/dev/null; then
  printf 'SCAN_DAYS="1"\n' >> "$CFG"
fi
# migrate a legacy DATA_DIR under /mnt/user off the array (it breaks shfs mounting)
if grep -q 'DATA_DIR="/mnt/user' "$CFG" 2>/dev/null; then
  sed -i 's#^DATA_DIR=.*#DATA_DIR="'"$APPDATA"'"#' "$CFG"
fi
CRON=/boot/config/plugins/modern.appstore/modern.appstore.cron
# Full scan on the configured interval, plus an hourly check that only pulls
# NEWLY published repos. The interval is read back from the config so an
# install never overwrites the schedule the user chose on the settings page.
SCAN_DAYS=$(sed -n 's/^SCAN_DAYS="\([0-9]*\)".*/\1/p' "$CFG" 2>/dev/null)
case "$SCAN_DAYS" in
  2|3|7) SCAN_DAY_FIELD="*/$SCAN_DAYS" ;;
  *)     SCAN_DAY_FIELD="*" ;;
esac
{
  echo "0 4 $SCAN_DAY_FIELD * * php /usr/local/emhttp/plugins/modern.appstore/fetch_stars.php >/dev/null 2>&1"
  echo '23 * * * * php /usr/local/emhttp/plugins/modern.appstore/fetch_stars.php --new-only 1 >/dev/null 2>&1'
} > "$CRON"
/usr/local/sbin/update_cron 2>/dev/null
# restore persisted star data into the tmpfs webroot so badges work after a reboot
cp -f "$APPDATA/stars.json"  /usr/local/emhttp/plugins/modern.appstore/ 2>/dev/null
cp -f "$APPDATA/apps.json"   /usr/local/emhttp/plugins/modern.appstore/ 2>/dev/null
cp -f "$APPDATA/status.json" /usr/local/emhttp/plugins/modern.appstore/ 2>/dev/null
# What the installer says depends on whether there is anything left to do.
# The token line was printed unconditionally, so every update told a server
# that had a token configured months ago to go and configure one, which reads
# as the update having wiped it. The config lives on the flash at $CFG and
# survives an update untouched, so it can simply be asked. Any non-empty TOKEN
# counts: this is a prompt, not a validity check, and the settings page is
# where a bad token gets reported.
if grep -q '^TOKEN="..*"' "$CFG" 2>/dev/null; then
  echo "----------------------------------------------------"
  echo " Unraid Modern App Store updated."
  echo "----------------------------------------------------"
else
  echo "----------------------------------------------------"
  echo " Unraid Modern App Store installed."
  echo " Set your GitHub token: Settings -> Utilities -> Unraid Modern App Store"
  echo "----------------------------------------------------"
fi
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

# A .plg IS an XML document, and Unraid parses it before it runs a line of it:
# a document that does not parse fails with "XML file doesn't exist or xml parse
# error" and the plugin cannot be installed at all, however good the code inside
# it is. The 2026.09.04j release shipped exactly that way, over one &nbsp; typed
# into the changelog: every entity in a .plg has to be one of the five XML
# defines above, and an HTML entity is not. Nothing else here would have caught
# it, since the payload files are inside CDATA and only the prose around them is
# parsed as markup. So the finished document is parsed before it is called built.
if command -v xmllint >/dev/null 2>&1; then
  if ! xmllint --noout "$OUT" 2>/tmp/plgxml.$$; then
    echo "ERROR: $OUT is not well-formed XML. Refusing to ship it." >&2
    sed 's/^/       /' /tmp/plgxml.$$ >&2
    rm -f /tmp/plgxml.$$ "$OUT"
    exit 1
  fi
  rm -f /tmp/plgxml.$$
elif command -v python3 >/dev/null 2>&1; then
  if ! python3 -c 'import sys,xml.dom.minidom as m; m.parse(sys.argv[1])' "$OUT" 2>/tmp/plgxml.$$; then
    echo "ERROR: $OUT is not well-formed XML. Refusing to ship it." >&2
    sed 's/^/       /' /tmp/plgxml.$$ >&2
    rm -f /tmp/plgxml.$$ "$OUT"
    exit 1
  fi
  rm -f /tmp/plgxml.$$
else
  echo "ERROR: neither xmllint nor python3 is available to parse $OUT." >&2
  echo "       A .plg that does not parse cannot be installed, so it is not shipped unchecked." >&2
  rm -f "$OUT"
  exit 1
fi

echo "Built $OUT ($VERSION), token-free and well-formed (verified), ${#FILES[@]} files embedded."
