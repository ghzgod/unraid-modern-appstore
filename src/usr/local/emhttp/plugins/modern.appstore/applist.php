<?php
/**
 * App list endpoint for the Unraid Modern App Store's own grid.
 *
 * Community Applications' 2026.07 rewrite made its client-side sort unreliable
 * (it collapses the All-Apps view to a ~36-app subset and sorts only those).
 * Rather than fight CA's display pipeline, the addon renders its OWN grid and
 * sorts the FULL catalog client-side. This endpoint hands that grid one compact
 * JSON array of every displayable app.
 *
 * READ-ONLY. It only reads:
 *   - this plugin's own apps.json  (name/icon/category/stars/trends, our data)
 *   - CA's templates_new.json      (FirstSeen, LastUpdate, downloads, displayable flags), never written
 * It writes nothing, anywhere. All CA paths are opened read-only.
 *
 * Output: { "generated": <ts>, "feedReady": <bool>, "docker": {...}, "defaultSort": <string>,
 *           "historyDays": <int>,
 *           "apps": [ { p,n,sn,ic,fa,xc,ct,s,dl,fs,fx,fk,lu,lk,ca,sx,rn,mi,t1,t7,t30,t365,rd,dt,td,tc,of,bt,pv,rm } ] }
 *   p  = template path (passed to CA's showSidebarApp for Info/Install)
 *   n  = display name          sn = lowercase sort-name
 *   ic = icon URL              ct = category
 *   fa = FontAwesome glyph name, and only when ic is empty: what CA's own drawer
 *        draws for an app whose template names no icon (see icon_fa())
 *   s  = GitHub stars (or null)  dl = Unraid downloads, null when CA never counted this app (943 templates carry no count, and an image published outside Docker Hub usually never gets one)
 *   dz = why dl is null: 'b' when the count was suppressed because the app runs a
 *        shared official base image (72 apps), '' when CA never counted it at all
 *   fs = FirstSeen unix ts (date added; 0 if unknown or if the app predates CA's records)
 *   fx = 1 when fs is CA's manufactured floor (1433000000) rather than a date it
 *        recorded, 0 otherwise
 *   fk = 'e' when CA's FirstSeen was the sentinel 1 rather than a real date, meaning
 *        the app existed before CA started keeping records; '' otherwise
 *   lu = last-update unix ts (0 if unknown)   lk = its source: 'r' registry push, 'v' plugin version
 *   sa = last star-fetch attempt for this app's repo (0 = never tried)
 *   sx = text the grid searches but never shows (full description + hidden keywords)
 *   rn = CA's RepoName (or Repo), verbatim and unclipped: the maintainer key CA's own All Apps button filters by
 *   mi = maintainer's own icon URL (or their GitHub avatar, or '' if neither is known)
 *   ca = repo creation unix ts (or null), for the lifetime growth-rate sort
 *   t1/t7/t30/t365 = star trend deltas (day/week/month/year)
 *   rq = install-time Attention notice text (requires/moderator comment), '' if none
 *   po = bridge-mode host ports the template claims, for the install port-conflict warning
 *   rd = RecommendedDate unix ts (0 if never), CA's Spotlight Apps list
 *   dt = CA's trending value, week-on-week download growth percent (null if absent)
 *   td = CA's trendDelta value, change in that growth percent (null if absent)
 *   tc = count of CA's weekly trend samples (0 if absent), for CA's ranking floor
 *   xc = 1 when CA marks the app incompatible with this server (36 apps), 0 otherwise
 *   of = 1 when the template is vendor-official (394 apps)
 *   bt = 1 when the template is marked pre-release (211 apps)
 *   pv = 1 when the container runs privileged (114 apps)
 *   rm = the maintainer's readme URL, '' when the template names none (721 apps have one)
 */
header('Content-Type: application/json');

$dataDir = '/boot/config/plugins/modern.appstore';
$caTmp   = '/tmp/community.applications/tempFiles';
// Same tempFiles directory as templates_new.json above, one repo per
// maintainer rather than one row per app; see repo_meta() for what it holds
// and why it needs unserialize() instead of json_decode() despite its name.
$repoList = "$caTmp/repositoryList.json";

// the grid has no other channel to the plugin's config, so the chosen
// opening sort rides along on this same response. sanitised loosely
// (charset and length only) rather than validated against the full sort
// list: the grid checks the value against its own SORT_OPTS and falls back
// silently for anything it doesn't recognise, so a second copy of that
// whitelist here would just be a thing that goes stale.
$gas_cfg = '/boot/config/plugins/modern.appstore/modern.appstore.cfg';
$cfg = is_file($gas_cfg) ? @parse_ini_file($gas_cfg) : [];
$defaultSort = preg_replace('/[^a-z0-9_]/', '', strtolower((string)($cfg['DEFAULT_SORT'] ?? '')));
$defaultSort = substr($defaultSort, 0, 20);

// Who the card names under an app, and it has to be the same person the
// drawer names and the same person the picture beside it shows.
//
// CA carries two different people here and they are not the same question.
// Author is whoever makes the SOFTWARE (grafana, redis, browserless, uroni),
// and RepoName is whoever publishes the TEMPLATE to Community Applications
// (atribe, Masterwishx, FlippinTurt). They disagree on 2,722 of the 3,873
// displayable apps, and this used to prefer Author, while the avatar beside
// it has always been keyed off RepoName: on seventy per cent of the catalog
// the card was showing one person's face next to another one's name, and
// naming someone the drawer, one click away, did not mention at all.
//
// RepoName wins now, which is the value CA's own Maintainer card prints. Every
// displayable app has one, so the rest is only for a feed that has gone wrong.
// An author line is a person or org, never a URL: CA leaves Author empty for
// most plugins and puts the .plg URL (cdn-wrapped) in Repository, so a value
// that is a link is dropped rather than printed. Long values are trimmed here
// too, so one bad record cannot dominate a card.
function display_author($stored, array $t, array $repoMeta = []) {
    $raw = (string)($t['RepoName'] ?? $t['Repo'] ?? '');
    // A repository whose title is not a person's name carries the name to
    // print as its own field, which is what CA reads: "Official Unraid Plugin
    // Repository" is Unraid, "Selfhosters Unraid Discord Repository" is
    // Selfhosters. No amount of trimming gets there from the title.
    $short = trim((string)($repoMeta[$raw]['short'] ?? ''));
    if ($short !== '') return clip($short, 60);
    // s? because a maintainer whose name already ends in one writes the
    // possessive with a bare apostrophe: 103 of the catalog's 1,112 repository
    // names read "MediaOps' Repository" rather than "atribe's Repository", and
    // a pattern that insisted on the s left the whole suffix sitting on the
    // card while CA's own drawer, two inches away, had trimmed it.
    $rn = trim(preg_replace('~[\x27\x{2019}]s? Repository$~ui', '', trim($raw)));
    if ($rn !== '' && !preg_match('~^https?://~i', $rn)) return clip($rn, 60);
    foreach ([$stored, $t['Author'] ?? ''] as $cand) {
        $cand = trim((string)$cand);
        if ($cand !== '' && !preg_match('~^https?://~i', $cand)) return clip($cand, 60);
    }
    return '';
}
// Hard cap on any single-line field the grid renders, so a malformed template
// cannot blow out a card. The CSS wraps too; this keeps the payload sane.
function clip($s, $max) {
    $s = trim((string)$s);
    if (function_exists('mb_strlen')) return mb_strlen($s) > $max ? mb_substr($s, 0, $max - 1) . '…' : $s;
    return strlen($s) > $max ? substr($s, 0, $max - 1) . '…' : $s;
}

// CA's feed carries no short-summary field: of the 3,889 currently
// displayable apps, only 25 have a Description at all, and 4 of those just
// repeat the Overview. So the card blurb has to be carved out of the
// Overview paragraph itself, whose median length is 289 characters, and the
// sentence that says what the app actually IS is almost always the first
// one. A fixed character cut chopped that sentence off mid-word or
// mid-thought as often as not ("...and everyone plays from their own
// browser on your LAN, spymaster view and g..."), so this finds the real
// sentence boundary instead: the first `.`, `!` or `?` that is followed by
// whitespace and then an uppercase letter, a digit, or the end of the
// string. Requiring what comes AFTER the punctuation, not just the
// punctuation itself, is what stops it cutting inside an abbreviation.
function first_sentence($s) {
    $s = trim((string)$s);
    if ($s === '') return $s;

    $mb = function_exists('mb_strlen');
    $charlen = function($x) use ($mb) { return $mb ? mb_strlen($x) : strlen($x); };

    // A period that is really an abbreviation still satisfies the
    // punctuation-then-capital test below ("Dr. Smith", "vs. the field"), so
    // every candidate is checked against this list before it is accepted.
    // Version and decimal numbers (v1.2, 2.5) and domains or paths
    // (example.com, ca.mover.tuning) never become candidates in the first
    // place: nothing but whitespace is allowed between the punctuation and
    // what follows it, and those never have a space in the middle.
    $abbrev = '/\b(?:e\.g|i\.e|etc|vs|dr|mr|mrs|st|approx|min|max)\.$/i';

    preg_match_all('/[.!?](?=\s+[A-Z0-9]|\s+$|$)/', $s, $m, PREG_OFFSET_CAPTURE);
    $candidates = $m[0] ?? [];

    $skip = function($pos) use ($s, $abbrev) {
        // an ellipsis the author typed ("...") trails a thought off; it is
        // never the sentence-ending punctuation itself
        if ($pos >= 2 && $s[$pos] === '.' && $s[$pos - 1] === '.' && $s[$pos - 2] === '.') return true;
        $start = max(0, $pos - 24);
        return (bool)preg_match($abbrev, substr($s, $start, $pos - $start + 1));
    };

    $end = null;
    foreach ($candidates as $cand) {
        if ($skip($cand[1])) continue;
        $end = $cand[1];
        break;
    }

    $sentence = null;
    if ($end !== null) {
        $sentence = substr($s, 0, $end + 1);
        // a one-word opener like "Warning." is not a useful blurb on its
        // own, so fold in the next sentence when this one is too short
        if ($charlen($sentence) < 40) {
            foreach ($candidates as $cand) {
                if ($cand[1] <= $end || $skip($cand[1])) continue;
                $sentence = substr($s, 0, $cand[1] + 1);
                break;
            }
        }
    }

    // No sentence boundary found, or the one settled on runs too long for a
    // card: fall back to a hard cap, same as clip(), but trimmed back to the
    // last space first so it never lands mid-word the way clip() can.
    if ($sentence === null || $charlen($sentence) > 300) {
        $max = 300;
        if ($charlen($s) <= $max) return $s;
        $cut = $mb ? mb_substr($s, 0, $max - 1) : substr($s, 0, $max - 1);
        $sp  = $mb ? mb_strrpos($cut, ' ') : strrpos($cut, ' ');
        if ($sp !== false && $sp > 0) $cut = $mb ? mb_substr($cut, 0, $sp) : substr($cut, 0, $sp);
        return rtrim($cut) . '…';
    }

    return $sentence;
}

// The categories a card shows, formatted exactly the way Community
// Applications formats them on its own cards.
//
// CA writes them as a space separated list of Parent:Child pairs, and every one
// of the 3,867 categorised apps uses that colon form while 2,421 carry more
// than one pair. CA's own categoryList() in include/helpers.php turns the
// separators into commas, trims a trailing colon (which is why "Backup:" must
// render as "Backup"), keeps the internal colon exactly as written, shows the
// first two and appends "and N more" for the rest. This mirrors that, so a card
// here and a card in the stock view never disagree about what an app is filed
// under.
function card_category($feed, $stored) {
    $raw = trim((string)$feed);
    if ($raw === '') $raw = trim((string)$stored);
    if ($raw === '') return '';
    $raw = str_replace([':,', ': ', ' '], ',', $raw);
    $raw = rtrim($raw, ': ');
    $all = array_values(array_filter(array_map(function ($c) { return rtrim(trim($c), ':'); }, explode(',', $raw)), 'strlen'));
    if (!$all) return '';
    $shown = array_slice($all, 0, 2);
    $excess = count($all) - count($shown);
    $out = implode(', ', $shown);
    if ($excess > 0) $out .= ' and ' . $excess . ' more';
    return clip($out, 48);
}

// When the app itself last shipped, and where that date came from.
//
// Docker apps: CA's LastUpdate is the registry push time for the image. It is
// the repository's date, not a specific tag's, so an app pinned to a tag other
// than :latest would be shown a date that has nothing to do with the version it
// installs. CA's own drawer suppresses the row in exactly that case, and so does
// this. Returns 'r' for those.
//
// Plugins: the feed carries no LastUpdate for them. Unraid plugin versions are
// dates by convention (2026.06.10a), which IS the release date, so that is read
// back out. Only the day is meaningful there, so the grid renders it without a
// time. Returns 'v'. Semver-style plugin versions (1.3.13) yield nothing rather
// than a guess.
function last_update(array $t) {
    if (!empty($t['Plugin'])) {
        $v = (string)($t['pluginVersion'] ?? '');
        if (preg_match('/^(20\d{2})\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])(?![\d])/', $v, $m)) {
            return [(int)mktime(0, 0, 0, (int)$m[2], (int)$m[3], (int)$m[1]), 'v'];
        }
        return [0, ''];
    }
    $tag = strtolower(explode(':', trim((string)($t['Repository'] ?? '')))[1] ?? '');
    if ($tag !== '' && $tag !== 'latest') return [0, ''];
    $lu = (int)($t['LastUpdate'] ?? 0);
    return $lu > 1 ? [$lu, 'r'] : [0, ''];
}

// CA gates the install behind an "Attention" confirm whenever a template
// carries additional requirements or a moderator note (its popupInstallXML).
// The modern grid installs without going through CA's own button, so the same
// notice is rebuilt here from the template fields CA reads.
function install_notice(array $t) {
    $comment = trim((string)($t['ModeratorComment'] ?? '')) ?: trim((string)($t['CAComment'] ?? ''));
    $req     = trim((string)($t['Requires'] ?? ''));
    $parts = [];
    if ($req !== '') {
        $req = trim(strip_tags(str_replace(["\r\n", "\r", "&#xD;"], "\n", $req)));
        $parts[] = "This application has additional requirements\n" . $req;
    }
    if ($comment !== '') $parts[] = trim(strip_tags(str_replace(["\r\n", "\r"], "\n", $comment)));
    return implode("\n", $parts);
}

// Mirrors CA's portsUsed() (include/helpers.php): only bridge-network templates
// publish fixed host ports worth warning about, so anything else reports none.
// Config entries come through as either a list or, for a template with exactly
// one, a single associative array, so that single-entry shape is normalised
// the same way CA does before walking it.
function template_ports(array $t) {
    if (($t['Network'] ?? '') !== 'bridge') return [];
    $cfg = $t['Config'] ?? [];
    if (isset($cfg['@attributes'])) $cfg = [$cfg];
    $ports = [];
    foreach ((array)$cfg as $c) {
        if (!is_array($c)) continue;
        $attr = $c['@attributes'] ?? [];
        if (($attr['Type'] ?? '') !== 'Port') continue;
        $val = $c['value'] ?? ($attr['Default'] ?? '');
        if ($val !== '' && $val !== null) $ports[] = $val;
    }
    return $ports;
}

// Community Applications' own docker-availability check, mirrored from its
// skins/Narrow/skin.php: the daemon counts as up only when its pid file points
// at a live process, and when it is not CA keeps listing every app but blocks
// docker installs and says why. The reason is read off the array state and the
// docker service setting, exactly as CA derives its 1/2/3 warning code.
//   1 = array started, docker service disabled
//   2 = array started, docker enabled but the daemon failed to start
//   3 = array not started
// CA suppresses the warning entirely while its own install disclaimer has not
// been accepted (nothing is installable then anyway), so this reports that as
// warn=false rather than inventing a message CA would not show.
function docker_state() {
    $pid = @file_get_contents('/var/run/dockerd.pid');
    if ($pid !== false && is_dir('/proc/' . trim($pid))) {
        return ['running' => true, 'reason' => 0, 'warn' => false];
    }
    $vars = @parse_ini_file('/var/local/emhttp/var.ini') ?: [];
    $dcfg = @parse_ini_file('/boot/config/docker.cfg') ?: [];
    if (($vars['mdState'] ?? '') !== 'STARTED')            $reason = 3;
    elseif (($dcfg['DOCKER_ENABLED'] ?? '') !== 'yes')     $reason = 1;
    else                                                   $reason = 2;
    $accepted = is_file('/boot/config/plugins/community.applications/accepted');
    return ['running' => false, 'reason' => $reason, 'warn' => $accepted];
}

function read_json_ro($path) {
    if (!is_file($path)) return null;
    $raw = @file_get_contents($path);
    if ($raw === false) return null;
    $d = @json_decode($raw, true);
    if ($d === null) $d = @unserialize($raw);   // CA files are serialized
    return is_array($d) ? $d : null;
}

// The maintainer's own picture lives in a different CA file than the app
// catalog: repositoryList.json, one row per repository rather than one per
// template, keyed by RepoName exactly as templates carry it. Despite the
// .json name it is PHP-serialized, not JSON, so it is read with unserialize()
// rather than json_decode(). A repository with no icon of its own still gets
// a face on the card when its url is a github.com address: that owner's
// GitHub avatar stands in, the same way an app with no icon of its own falls
// back to one elsewhere in this file. A missing or not-yet-populated file
// (CA has not written its temp files this boot) yields an empty map rather
// than a warning, so the grid just shows the generic glyph until it exists.
// Two things per repository, from one pass over the file: the maintainer's
// picture, and the short name CA prints for them when the repository's own
// title is not a person's name. Only 6 of the 1,182 repositories carry a
// shortName, and they are exactly the 6 the possessive strip in
// display_author() cannot help ("Official Unraid Plugin Repository" is
// "Unraid", "Selfhosters Unraid Discord Repository" is "Selfhosters"), which
// is why reading it is worth the field.
function repo_meta($path) {
    $raw = @file_get_contents($path);
    if ($raw === false) return [];
    $repos = @unserialize($raw);
    if (!is_array($repos)) return [];
    $map = [];
    foreach ($repos as $name => $r) {
        if (!is_array($r)) continue;
        $icon = trim((string)($r['icon'] ?? ''));
        if ($icon === '') {
            $url = (string)($r['url'] ?? '');
            if (preg_match('~github\.com/([A-Za-z0-9._-]+)~i', $url, $m)) {
                $icon = 'https://github.com/' . $m[1] . '.png?size=128';
            }
        }
        $map[(string)$name] = [
            'icon'  => $icon,
            'short' => trim((string)($r['shortName'] ?? '')),
        ];
    }
    return $map;
}

// One reader for every flag CA's templates carry, because the raw shapes
// disagree with each other. Compatible, Official and Beta arrive as a real
// PHP boolean on some templates and as the string 'true' on others, and
// Privileged goes a step further: on some templates it is an array of
// strings such as array('false','false'), true if any element of it is. A
// plain truthy test on these values gets it wrong in the direction that
// matters most, since it would have counted the string 'false' as true, and
// that is not a rare shape: 3,409 of the 3,523 templates that carry
// Privileged at all hold it as that literal string 'false'. So every call
// site reads through this instead of comparing the raw value itself.
function flag_true($v) {
    if (is_array($v)) {
        foreach ($v as $x) if (flag_true($x)) return true;
        return false;
    }
    if (is_bool($v)) return $v;
    return strtolower(trim((string)$v)) === 'true';
}

// The FontAwesome glyph a template names when it names no icon, and only
// then: an app with a real picture has nothing to gain from one. CA stores it
// as a bare glyph name ("unlink", "hdd-o") and draws it as fa fa-<name>, so
// what comes back here is the name alone and the grid builds the class.
// Whitelisted to the characters a FontAwesome name is made of, because this
// value is written straight into a class attribute on the other side and it
// arrives from a third-party template.
function icon_fa($t) {
    if (trim((string)($t['Icon'] ?? '')) !== '') return '';
    $fa = strtolower(trim((string)($t['IconFA'] ?? '')));
    // CA tolerates authors who write the whole class out; only the name is
    // wanted, since the grid supplies the fa- prefix itself.
    $fa = preg_replace('~^fa[\s-]+~', '', $fa);
    return preg_match('~^[a-z0-9-]{1,40}$~', $fa) ? $fa : '';
}

// our own catalog (already has name/path/icon/category/stars/trends for every app)
$ours = read_json_ro("$dataDir/apps.json");
$byPath = [];
foreach (($ours['apps'] ?? []) as $a) {
    if (!empty($a['p'])) $byPath[$a['p']] = $a;
}

// CA's master template list: name, FirstSeen, downloads, displayable flags.
// It lives in /tmp, so it is gone after every boot until CA's Apps page has
// downloaded the feed again. The modern grid loads faster than that download,
// so an empty read here means "not ready yet", never "the catalog is empty",
// and the grid is told which of the two it is so it can wait instead of
// printing "No apps to show" and sitting there until a manual reload.
$tmpl = read_json_ro("$caTmp/templates_new.json") ?: [];
$feedReady = !empty($tmpl);

// When each repo was last tried for stars, so the grid can ask for a scan of
// only the apps on screen that are missing or stale. Read-only; no DB is fine.
$fetchedAt = [];
if (class_exists('SQLite3') && is_file("$dataDir/stars.db")) {
    try {
        $sdb = new SQLite3("$dataDir/stars.db", SQLITE3_OPEN_READONLY);
        $sdb->busyTimeout(2000);
        $r = $sdb->query('SELECT repo, fetched_at FROM repos');
        while ($row = $r->fetchArray(SQLITE3_ASSOC)) $fetchedAt[$row['repo']] = (int)$row['fetched_at'];
        $sdb->close();
    } catch (Throwable $e) { $fetchedAt = []; }
}

// Built once, not per app: repositoryList.json has one row per maintainer,
// so 1182 repos are worth one pass regardless of how many templates they own.
$repoMeta = repo_meta($repoList);

$out = [];
foreach ($tmpl as $t) {
    if (!is_array($t)) continue;
    // match CA's "All Apps" visibility: displayable, not blacklisted, not deprecated
    if (empty($t['Displayable'])) continue;
    if (!empty($t['Blacklist'])) continue;
    if (!empty($t['Deprecated'])) continue;
    // language packs are CA UI translations, not apps; CA files them under a
    // "Language:" category. Exclude them from the app grid entirely.
    if (!empty($t['Language'])) continue;

    $path = $t['Path'] ?? '';
    if ($path === '') continue;

    $mine = $byPath[$path] ?? null;
    $name = $t['Name'] ?? ($mine['n'] ?? '');
    if ($name === '') continue;

    // Download count comes from CA's catalog (DockerHub pulls of the app's
    // image). BUT apps built on an official base image (nginx, redis, postgres)
    // reference it as a bare "name:tag" with no owner namespace, and then this
    // number is the BASE image's global pulls (e.g. nginx = 13.2B), not the
    // app's. That's misleading, so we drop it for those; real app images are
    // "owner/name" and keep their genuine count. Plugins are exempt from this
    // guard: a plugin's Repository is a CDN link to its .plg file, not a docker
    // image reference, so the namespace test means nothing there and was
    // silently zeroing every plugin's download count.
    //
    // 943 of the 3,873 displayable templates carry no downloads key whatsoever
    // and only 4 carry an explicit zero, so coercing a missing key to 0 stated
    // a measurement that was never taken. Null now means not counted and 0
    // means counted as none, and the grid renders the two differently. The
    // base-image case above joins it: suppressing a misleading base image
    // figure is right, but the result is an unknown count rather than a count
    // of zero.
    $dl = array_key_exists('downloads', $t) && $t['downloads'] !== null && $t['downloads'] !== ''
        ? (int)$t['downloads'] : null;
    // Why the count is absent, when it is, so the card can say which of the
    // two it is rather than guessing. 'b' is the base image case below and it
    // is a different sentence entirely: those 72 images (mongo, postgres,
    // nginx, redis) are on Docker Hub, and telling the reader the app is
    // published somewhere else would be plainly untrue. Everything else with
    // no count is an image Docker Hub does not carry.
    $dz = '';
    if (empty($t['Plugin'])) {
        $imgName = explode(':', trim($t['Repository'] ?? ''))[0];
        if ($imgName === '' || strpos($imgName, '/') === false) { $dl = null; $dz = 'b'; }
    }

    // description: prefer our stored copy, fall back to CA's Overview; cut to
    // its opening sentence (tiles clamp it anyway) to keep the payload lean.
    // See first_sentence() above for why a sentence cut beats a character cut.
    $desc = $mine['de'] ?? ($t['Overview'] ?? '');
    $desc = trim(preg_replace('/\s+/', ' ', strip_tags($desc)));
    $desc = first_sentence($desc);

    // Text the grid searches but never shows. Community Applications matches a
    // query against the app's FULL description and against ExtraSearchTerms, a
    // hidden keyword list many templates carry, which is why a search for
    // "emulator" finds apps there that never say it in their name. The blurb
    // above is trimmed for the card (the stored copy is shorter still), so the
    // searchable text rides along separately, capped so that one 15KB overview
    // cannot dominate the payload.
    // CA's Author leads this, because the card no longer prints it: the line
    // under an app names the person who publishes the template now (see
    // display_author), and the searchable text is where the name of whoever
    // makes the software goes instead. Without it, a search for "jokobsk" or
    // "browserless" would stop finding the app it publishes, which the old
    // author line answered by accident.
    $overview = trim(preg_replace('/\s+/', ' ', strip_tags((string)($t['Overview'] ?? ''))));
    $vendor = trim((string)($t['Author'] ?? ''));
    if (preg_match('~^https?://~i', $vendor)) $vendor = '';
    $sx = clip(trim($vendor . ' ' . (string)($t['ExtraSearchTerms'] ?? '') . ' ' . $overview), 2000);

    // CA's own floor, lifted from its skins/Narrow/skin.php:
    //     $FirstSeen = ($FirstSeen < 1433649600) ? 1433000000 : $FirstSeen;
    //     $DateAdded = tr(date("M j, Y", $FirstSeen), 0);
    // Anything earlier than the 7th of June 2015, including the sentinel of 1
    // it writes for an app whose arrival it never recorded, becomes 1433000000
    // and prints as an ordinary date. That is why CA's stock drawer reads
    // "May 30, 2015" for those apps. Matching it exactly is the whole point:
    // that drawer is one toggle away and the two must not disagree. fx below
    // flags exactly that substitution, so the grid can tell a date CA observed
    // from one it manufactured, without either of them changing what CA itself
    // would print.
    $fs = (int)($t['FirstSeen'] ?? 0);
    if ($fs < 1433649600) $fs = 1433000000;
    $fx = $fs === 1433000000 ? 1 : 0;

    list($lu, $lk) = last_update($t);

    $out[] = [
        'p'   => $path,
        'n'   => $name,
        'sn'  => strtolower($t['SortName'] ?? $name),
        // The card and CA's own drawer are the same app and must never show two
        // different icons for it. CA's drawer always renders $template['Icon']
        // from the feed, so that is the value that settles a disagreement; our
        // stored copy is only the fallback for when the feed has none.
        'ic'  => $t['Icon'] ?? ($mine['ic'] ?? ''),
        // What CA draws when a template names no icon at all: the FontAwesome
        // glyph the author picked instead, which CA's own drawer renders as
        // <i class="fa fa-unlink popupIcon">. 117 displayable apps have no
        // Icon, and 59 of those carry one of these, so leaving the field out
        // is what put a question mark on a card whose drawer, sitting right
        // beside it, drew a perfectly good mark. Sent as the bare glyph name;
        // it goes straight into a class attribute on the other side, so
        // anything that is not a FontAwesome name is dropped here rather than
        // trusted there.
        'fa'  => icon_fa($t),
        // CA decided this app cannot run on this server, and its own drawer answers
        // by rendering no install action at all. 36 of the 3,873 displayable apps
        // are marked so, and without this the grid offered them a working Install
        // button. Only an explicit false counts: a template that simply never
        // declared the field is not a template declaring incompatibility.
        'xc'  => (array_key_exists('Compatible', $t) && $t['Compatible'] !== null && !flag_true($t['Compatible'])) ? 1 : 0,
        'ct'  => card_category($t['Category'] ?? '', $mine['ct'] ?? ''),
        // ct is the card LABEL only. fetch_stars.php keeps just the app's first
        // category and strips the colons out of it, which reads well on a tile
        // ("Network Management") but matches nothing the left menu ever asks
        // for: CA's data-category values are the raw colon form, always, and
        // are matched as a substring - "Network:" for the parent, and
        // "Network:Management" for the child. The grid gets CA's untouched
        // Category string as a filter-only field so the menu can match it the
        // way CA itself does, and so an app filed under several categories is
        // found under all of them rather than only its first.
        // Deliberately not clipped: the longest real value is 152 characters,
        // and cutting it would silently drop an app's trailing categories.
        'cf'  => (string)($t['Category'] ?? ''),
        'au'  => display_author($mine['au'] ?? '', $t, $repoMeta),
        // CA's own maintainer key, kept byte-for-byte: display_author() above
        // trims this same RepoName down to a person's name for the card, but
        // the All Apps button in CA's drawer hands this value back UNTRIMMED
        // in data-repository, so the grid needs the raw form to match against.
        'rn'  => (string)($t['RepoName'] ?? $t['Repo'] ?? ''),
        // The maintainer's own picture, keyed off the same RepoName as 'rn'
        // just above so a mismatch between the two is impossible. Looked up
        // in the map built once before this loop; see repo_meta() for how a
        // maintainer with no icon of their own still ends up with a GitHub
        // avatar here.
        'mi'  => $repoMeta[(string)($t['RepoName'] ?? $t['Repo'] ?? '')]['icon'] ?? '',
        'de'  => $desc,
        'sx'  => $sx,
        'pr'  => $mine['pr'] ?? ($t['Project'] ?? ''),
        'su'  => $mine['su'] ?? ($t['Support'] ?? ''),
        'ri'  => $t['Repository'] ?? '',                     // image ref, CA's pin key part 1
        'pn'  => $t['SortName'] ?? $name,                    // exact SortName, CA's pin key part 2
        'rp'  => $mine['rp'] ?? '',                          // owner/repo, for the icon fallback
        'ty'  => !empty($t['Plugin']) ? 'plugin' : 'docker', // app type
        'pu'  => $t['PluginURL'] ?? '',                      // plugin .plg url (plugins install differently)
        's'   => isset($mine['s']) ? $mine['s'] : null,
        'dl'  => $dl,
        // Why dl is null, when it is: 'b' means the count was suppressed
        // because the app runs a shared official base image, '' means CA
        // simply never had one. The card owes the reader a different
        // sentence for each and cannot tell them apart from dl alone.
        'dz'  => $dz,
        'fs'  => $fs,
        'fx'  => $fx,                                        // 1 when fs is CA's floor rather than a date it recorded
        'lu'  => $lu,
        'lk'  => $lk,
        'sa'  => $fetchedAt[strtolower($mine['rp'] ?? '')] ?? 0,
        'ca'  => $mine['ca'] ?? null,
        't1'  => $mine['t1'] ?? null,
        't7'  => $mine['t7'] ?? null,
        't30' => $mine['t30'] ?? null,
        't365'=> $mine['t365'] ?? null,
        // CA's own homepage ranking inputs, read straight out of its feed. rd is
        // the Spotlight Apps date, dt/td are the Top Trending Apps growth percent
        // and its change, and tc is how many weekly samples back them, the same
        // floor (3 for Trending, 6 for New Installs) CA itself enforces before
        // ranking an app at all.
        'rd'  => (int)($t['RecommendedDate'] ?? 0),
        'dt'  => isset($t['trending']) ? (float)$t['trending'] : null,
        'td'  => isset($t['trendDelta']) ? (float)$t['trendDelta'] : null,
        'tc'  => count((array)($t['trends'] ?? [])),
        'rq'  => install_notice($t),
        'po'  => template_ports($t),
        // Vendor-official templates, 394 of them. Worth saying on a card, because
        // the catalog carries five competing templates for some apps and this is
        // the one fact that separates them.
        'of'  => flag_true($t['Official'] ?? '') ? 1 : 0,
        // Pre-release, 211 apps.
        'bt'  => flag_true($t['Beta'] ?? '') ? 1 : 0,
        // Runs with elevated Docker privileges, 114 apps. CA carries a moderator
        // comment on only 273 templates in total, so most of these say nothing
        // about it anywhere the reader would see.
        'pv'  => flag_true($t['Privileged'] ?? '') ? 1 : 0,
        // The maintainer's own readme, on 721 apps. Neither the grid nor CA's
        // drawer links it today.
        'rm'  => (string)($t['ReadMe'] ?? ''),
    ];
}

$scan = read_json_ro("$dataDir/status.json") ?: [];

// How many days of the plugin's own star-history snapshots this install has.
// GitHub restricted the stargazers-listing endpoints to admins and
// collaborators in July 2026, so the "this year" trending windows (t365) can
// no longer get a year-ago baseline by walking a repo's stargazer pages; that
// data is gone for every token type, for good. Their only remaining source is
// star_history in stars.db, this plugin's own daily snapshot table, so this
// count is the only honest way to tell a user when those two windows will
// start working, rather than blaming a token setting that can no longer fix it.
$historyDays = 0;
if (class_exists('SQLite3') && is_file("$dataDir/stars.db")) {
    try {
        $sdb = new SQLite3("$dataDir/stars.db", SQLITE3_OPEN_READONLY);
        $sdb->busyTimeout(2000);
        $oldest = (int)$sdb->querySingle('SELECT MIN(ts) FROM star_history');
        if ($oldest > 0) $historyDays = max(0, (int)floor((time() - $oldest) / 86400));
        $sdb->close();
    } catch (Throwable $e) { $historyDays = 0; }
}

// JSON_INVALID_UTF8_SUBSTITUTE: some feed descriptions carry stray bytes that
// would otherwise make json_encode() return false and emit an empty body.
echo json_encode(
    ['generated' => time(), 'count' => count($out), 'historyDays' => $historyDays,
     'feedReady' => $feedReady, 'docker' => docker_state(), 'defaultSort' => $defaultSort,
     // when CA last synced its feed (the store's own check for new and updated
     // apps) and when the last star scan ran, for the toolbar's Updated stamp
     'feedAt' => (int)@filemtime("$caTmp/templates_new.json"),
     'scanAt' => (int)($scan['ran_at'] ?? 0),
     'apps' => $out],
    JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
);
