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
 * Output: { "generated": <ts>, "feedReady": <bool>, "docker": {...},
 *           "apps": [ { p,n,sn,ic,ct,s,dl,fs,lu,lk,ca,t1,t7,t30,t365 } ] }
 *   p  = template path (passed to CA's showSidebarApp for Info/Install)
 *   n  = display name          sn = lowercase sort-name
 *   ic = icon URL              ct = category
 *   s  = GitHub stars (or null)  dl = Unraid downloads (or 0)
 *   fs = FirstSeen unix ts (date added; 0 if unknown)
 *   lu = last-update unix ts (0 if unknown)   lk = its source: 'r' registry push, 'v' plugin version
 *   sa = last star-fetch attempt for this app's repo (0 = never tried)
 *   ca = repo creation unix ts (or null), for the lifetime growth-rate sort
 *   t1/t7/t30/t365 = star trend deltas (day/week/month/year)
 */
header('Content-Type: application/json');

$dataDir = '/boot/config/plugins/modern.appstore';
$caTmp   = '/tmp/community.applications/tempFiles';

// An author line is a person or org, never a URL. CA leaves Author empty for
// most plugins and puts the .plg URL (cdn-wrapped) in Repository, so a stored or
// feed value that is a link is dropped in favour of the repository owner's name.
// Long values are trimmed here too, so one bad record cannot dominate a card.
function display_author($stored, array $t) {
    foreach ([$stored, $t['Author'] ?? ''] as $cand) {
        $cand = trim((string)$cand);
        if ($cand !== '' && !preg_match('~^https?://~i', $cand)) return clip($cand, 60);
    }
    $rn = trim((string)($t['RepoName'] ?? $t['Repo'] ?? ''));
    $rn = trim(preg_replace('~[\x27\x{2019}]s Repository$~ui', '', $rn));
    if ($rn !== '' && !preg_match('~^https?://~i', $rn)) return clip($rn, 60);
    return '';
}
// Hard cap on any single-line field the grid renders, so a malformed template
// cannot blow out a card. The CSS wraps too; this keeps the payload sane.
function clip($s, $max) {
    $s = trim((string)$s);
    if (function_exists('mb_strlen')) return mb_strlen($s) > $max ? mb_substr($s, 0, $max - 1) . '…' : $s;
    return strlen($s) > $max ? substr($s, 0, $max - 1) . '…' : $s;
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
    // "owner/name" and keep their genuine count.
    $dl = (int)($t['downloads'] ?? 0);
    $imgName = explode(':', trim($t['Repository'] ?? ''))[0];
    if ($imgName === '' || strpos($imgName, '/') === false) $dl = 0;

    // description: prefer our stored copy, fall back to CA's Overview; trim to a
    // card-sized blurb (tiles clamp it anyway) to keep the payload lean.
    $desc = $mine['de'] ?? ($t['Overview'] ?? '');
    $desc = trim(preg_replace('/\s+/', ' ', strip_tags($desc)));
    if (strlen($desc) > 400) $desc = substr($desc, 0, 400) . '…';

    // CA carries FirstSeen = 1 for apps that predate its record-keeping (all of
    // binhex's catalog, 78 apps today). That is a sentinel, not a 1970 date, and
    // CA's own fixTemplates() blanks it the same way ("if Date == 1, Date = null").
    // Report it as unknown so the grid omits the line instead of printing 1969.
    $fs = (int)($t['FirstSeen'] ?? 0);
    if ($fs <= 1) $fs = 0;

    list($lu, $lk) = last_update($t);

    $out[] = [
        'p'   => $path,
        'n'   => $name,
        'sn'  => strtolower($t['SortName'] ?? $name),
        'ic'  => $mine['ic'] ?? ($t['Icon'] ?? ''),
        'ct'  => clip($mine['ct'] ?? ($t['Category'] ?? ''), 48),
        'au'  => display_author($mine['au'] ?? '', $t),
        'de'  => $desc,
        'pr'  => $mine['pr'] ?? ($t['Project'] ?? ''),
        'su'  => $mine['su'] ?? ($t['Support'] ?? ''),
        'ri'  => $t['Repository'] ?? '',                     // image ref, CA's pin key part 1
        'pn'  => $t['SortName'] ?? $name,                    // exact SortName, CA's pin key part 2
        'rp'  => $mine['rp'] ?? '',                          // owner/repo, for the icon fallback
        'ty'  => !empty($t['Plugin']) ? 'plugin' : 'docker', // app type
        'pu'  => $t['PluginURL'] ?? '',                      // plugin .plg url (plugins install differently)
        's'   => isset($mine['s']) ? $mine['s'] : null,
        'dl'  => $dl,
        'fs'  => $fs,
        'lu'  => $lu,
        'lk'  => $lk,
        'sa'  => $fetchedAt[strtolower($mine['rp'] ?? '')] ?? 0,
        'ca'  => $mine['ca'] ?? null,
        't1'  => $mine['t1'] ?? null,
        't7'  => $mine['t7'] ?? null,
        't30' => $mine['t30'] ?? null,
        't365'=> $mine['t365'] ?? null,
    ];
}

// Whether the configured token can read star dates. The year trending windows
// depend on them, so the grid needs to tell an empty result from an unreadable
// one rather than just showing "No apps to show".
$scan = read_json_ro("$dataDir/status.json") ?: [];
$starDates = empty($scan['stargazers_blocked']);

// JSON_INVALID_UTF8_SUBSTITUTE: some feed descriptions carry stray bytes that
// would otherwise make json_encode() return false and emit an empty body.
echo json_encode(
    ['generated' => time(), 'count' => count($out), 'starDates' => $starDates,
     'feedReady' => $feedReady, 'docker' => docker_state(), 'apps' => $out],
    JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
);
