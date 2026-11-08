<?php
/**
 * The real arrival date for an app, where Community Applications' own one is
 * missing or only approximate.
 *
 * Two cases. A plugin whose FirstSeen CA never recorded is dated from its own
 * changelog, as described next. Any app CA did date is checked against its
 * template's first commit in the maintainer's repository, because CA's date
 * is the feed build that first carried it and those builds lump every app
 * published since the previous one onto a single stamp. See publishedDates().
 *
 * CA writes FirstSeen as the integer 1 for an app whose arrival it never
 * logged, and its own skin floors anything below 1433649600 to the constant
 * 1433000000, printing that as an ordinary date ("May 30, 2015"). applist.php
 * matches that floor exactly, so CA's own drawer and this addon's grid never
 * disagree about what CA would show, but the date itself is manufactured, not
 * observed. A good share of the apps landing on it turn out to be plugins,
 * and a plugin's own .plg carries a <CHANGES> block whose entries are headed
 * by date-shaped version numbers (###2015.04.18### or
 * ### 2026.08.04.0141 ###), so a plugin's real arrival is usually sitting in
 * its own changelog, verifiable rather than guessed.
 *
 * Not every changelog reaches that far back. Some are truncated with a note
 * like "For older releases, see https://github.com/...", and a truncated
 * changelog's oldest VISIBLE entry is only the oldest one still PUBLISHED
 * there, not the oldest one that ever existed. Treating it as a first-release
 * date would be a guess wearing a fact's clothes, so a changelog is only
 * trusted once it says, in its own words, that it reaches an initial release.
 * See firstReleaseFrom() below.
 *
 * POST {"p":["<app path>", ...]} -> {"<app path>": <unix ts>}
 *
 * An app that cannot be resolved to a trustworthy date answers -1, which the
 * caller reads as "asked, and there is no answer" rather than asking again on
 * every render.
 *
 * Answers are cached to the addon's data directory on flash and kept: a
 * plugin's changelog only grows, so a first-release date already found is
 * never wrong, only possibly reached by a shorter route than a later, longer
 * changelog would offer. Only paths the catalog names, and only records the
 * catalog itself marks as a plugin carrying a PluginURL, are ever fetched, so
 * this endpoint cannot be pointed at anything else on the network.
 */
header('Content-Type: application/json');

$dataDir   = '/boot/config/plugins/modern.appstore';
$cacheFile = $dataDir . '/addeddate.json';
// CA's own template list, the same file applist.php reads. The addon's own
// apps.json carries no application type and no plugin URL: those two come from
// CA's templates, so this is the file that can say whether a path is a plugin
// and where its .plg lives.
$caTmp     = '/tmp/community.applications/tempFiles';
$tmplFile  = "$caTmp/templates_new.json";
// CA's skin floors every FirstSeen below this to a constant it manufactures.
const FLOOR = 1433649600;
const FEED_DIR = '/tmp/GitHub/AppFeed/';

$req  = json_decode(file_get_contents('php://input'), true);
$want = (is_array($req) && isset($req['p']) && is_array($req['p'])) ? $req['p'] : [];
$want = array_values(array_unique(array_filter(array_map('strval', $want))));
if (!$want) { echo '{}'; exit; }
if (count($want) > 60) $want = array_slice($want, 0, 60);

$cache = [];
if (is_file($cacheFile)) {
    $d = json_decode(@file_get_contents($cacheFile), true);
    if (is_array($d)) $cache = $d;
}

$out = [];
$todo = [];
foreach ($want as $p) {
    if (array_key_exists($p, $cache)) $out[$p] = $cache[$p];
    else $todo[] = $p;
}

// Only paths the catalog actually names are ever looked up, and only at hosts
// the catalog itself points to: a plugin's own PluginURL, or the GitHub
// repository CA lists for the maintainer. Anything CA's templates do not name
// is dropped here and never reaches curl.
//
// Which question an app gets depends on what CA recorded for it. An app whose
// FirstSeen sits on CA's floor has no date at all, and for a plugin the
// changelog below is the answer. An app CA did date still carries only the
// timestamp of the feed build that first picked it up, and those builds run
// every few days: 2,452 apps share their FirstSeen with up to 42 others,
// because everything published since the previous build lands on one stamp.
// Two apps published a day apart print the same date. For those the
// template's first commit in the maintainer's repository is the real
// arrival, and it is trusted only inside the window CA's own stamps allow:
// after the previous build (or that build would have carried it) and no later
// than the build that did.
$plgTodo = [];
$gitTodo = [];
if ($todo) {
    // Despite the .json name CA writes this file PHP-serialized, so it is
    // unserialized first and only falls back to json_decode.
    $raw  = @file_get_contents($tmplFile);
    $tmpl = $raw !== false ? @unserialize($raw) : false;
    if (!is_array($tmpl)) $tmpl = $raw !== false ? json_decode($raw, true) : [];
    $wanted = array_flip($todo);
    $stamps = [];
    foreach ((array)$tmpl as $t) {
        if (!is_array($t)) continue;
        $fs = (int)($t['FirstSeen'] ?? 0);
        if ($fs >= FLOOR) $stamps[$fs] = true;
        $p = (string)($t['Path'] ?? '');
        if ($p === '' || !isset($wanted[$p])) continue;
        if ($fs < FLOOR) {
            $u = trim((string)($t['PluginURL'] ?? ''));
            if (!empty($t['Plugin']) && $u !== '') $plgTodo[$p] = $u;
        } else {
            $gitTodo[$p] = $t;
        }
    }
    $stamps = array_keys($stamps);
    sort($stamps);
}

$dirty = false;
if ($plgTodo) {
    foreach (fetchFirstRelease($plgTodo) as $p => $ts) {
        $val = $ts > 0 ? $ts : -1;
        $out[$p] = $val;
        $cache[$p] = $val;
        $dirty = true;
    }
}
if ($gitTodo) {
    $repoUrl = [];
    $rl = @unserialize((string)@file_get_contents("$caTmp/repositoryList.json"));
    foreach ((array)$rl as $name => $r) if (is_array($r)) $repoUrl[(string)$name] = (string)($r['url'] ?? '');
    $cfg   = @parse_ini_file("$dataDir/modern.appstore.cfg");
    $token = trim((string)($cfg['TOKEN'] ?? ''));
    foreach (publishedDates($gitTodo, $stamps, $repoUrl, $token) as $p => $val) {
        // null is a rate limit or an outage: answered as unknown for now, but
        // not written down, so the next visit asks again.
        $out[$p] = $val ?? -1;
        if ($val !== null) { $cache[$p] = $val; $dirty = true; }
    }
}
if ($dirty && (is_dir($dataDir) || @mkdir($dataDir, 0755, true))) {
    $tmp = $cacheFile . '.tmp';
    if (@file_put_contents($tmp, json_encode($cache)) !== false) @rename($tmp, $cacheFile);
}

echo json_encode($out);

/**
 * Downloads each plugin's .plg, ten at a time, and hands each body to
 * firstReleaseFrom(). Keyed by app path rather than URL: two plugins from the
 * same maintainer can share nothing about their URL shape, but never share a
 * catalog path.
 */
function fetchFirstRelease(array $urlByPath) {
    $res = [];
    foreach (array_chunk($urlByPath, 10, true) as $chunk) {
        $mh = curl_multi_init();
        $handles = [];
        foreach ($chunk as $p => $u) {
            $c = curl_init($u);
            curl_setopt_array($c, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS      => 3,
                CURLOPT_CONNECTTIMEOUT => 5,
                CURLOPT_TIMEOUT        => 20,
                CURLOPT_USERAGENT      => 'unraid-modern-appstore',
            ]);
            curl_multi_add_handle($mh, $c);
            $handles[$p] = $c;
        }
        $running = null;
        do { curl_multi_exec($mh, $running); curl_multi_select($mh, 0.2); } while ($running > 0);

        foreach ($handles as $p => $c) {
            $body = curl_multi_getcontent($c);
            curl_multi_remove_handle($mh, $c);
            curl_close($c);
            $res[$p] = firstReleaseFrom((string)$body);
        }
        curl_multi_close($mh);
    }
    return $res;
}

/**
 * Pulls a plugin's first-release date out of its own <CHANGES> block, or
 * returns 0 when nothing in it can be trusted as one.
 */
function firstReleaseFrom(string $body): int {
    if (!preg_match('#<CHANGES>(.*?)</CHANGES>#s', $body, $m)) return 0;
    $block = $m[1];

    // A changelog that does not reach a first release cannot tell us when the
    // plugin actually arrived: some are truncated with a note like "For older
    // releases, see https://github.com/...", and a truncated block's oldest
    // VISIBLE entry is only the oldest one still PUBLISHED here, not the
    // oldest one that ever existed. Treating that as a first-release date
    // would be a guess wearing a fact's clothes, so the block is trusted only
    // once its own text says, near the end, that it reaches one.
    $tail = strtolower(substr($block, -500));
    $reaches = false;
    foreach (['initial release', 'first release', 'initial version', 'initial commit'] as $needle) {
        if (strpos($tail, $needle) !== false) { $reaches = true; break; }
    }
    if (!$reaches) return 0;

    // Every date-shaped version number in the block, e.g. ###2015.04.18### or
    // ### 2026.08.04.0141 ###. The window excludes anything before Unraid
    // plugins existed and anything in the future: a version string is not
    // always a date, and one plugin's changelog on this catalog yields
    // 2002.05.23, which predates Unraid plugins entirely.
    if (!preg_match_all('/\b(20\d{2})\.(\d{2})\.(\d{2})\b/', $block, $mm, PREG_SET_ORDER)) return 0;

    $min = 1262304000; // 1 Jan 2010
    $max = time();
    $best = 0;
    foreach ($mm as $d) {
        $ts = @mktime(12, 0, 0, (int)$d[2], (int)$d[3], (int)$d[1]);
        if ($ts === false || $ts < $min || $ts > $max) continue;
        if ($best === 0 || $ts < $best) $best = $ts;
    }
    return $best;
}

/**
 * When each template first appeared in its maintainer's GitHub repository,
 * kept only inside CA's window for it. Two rounds of parallel requests to the
 * GitHub API: the newest commit touching the file, whose Link header names the
 * last page, and that last page, which holds the first. The author date is
 * read rather than the committer date, because a rebase or a squash restamps
 * the committer and template repositories get tidied that way often.
 *
 * Returns path => unix ts, -1 when there is no trustworthy answer, or null
 * when GitHub could not be asked right now.
 */
function publishedDates(array $byPath, array $stamps, array $repoUrl, string $token): array {
    $res = [];
    $job = [];
    foreach ($byPath as $p => $t) {
        $fs = (int)$t['FirstSeen'];
        $prev = 0;
        foreach ($stamps as $s) { if ($s >= $fs) break; $prev = $s; }
        $url  = $repoUrl[(string)($t['RepoName'] ?? '')] ?? '';
        // CA's feed keeps each template at the path it has in the
        // maintainer's repository, under its own checkout directory.
        $file = (string)($t['TemplatePath'] ?? '');
        $file = strncmp($file, FEED_DIR, strlen(FEED_DIR)) === 0 ? substr($file, strlen(FEED_DIR)) : '';
        if ($prev === 0 || $file === '' || strpos($file, '..') !== false
            || !preg_match('~^https://github\.com/([A-Za-z0-9-]{1,39})/([A-Za-z0-9._-]{1,100})~i', $url, $m)) {
            $res[$p] = -1;
            continue;
        }
        $repo = $m[1] . '/' . preg_replace('~\.git$~i', '', $m[2]);
        $job[$p] = ['repo' => $repo, 'file' => $file, 'fs' => $fs, 'prev' => $prev];
    }
    if (!$job) return $res;

    $first = [];
    foreach ($job as $p => $j) {
        $first[$p] = 'https://api.github.com/repos/' . $j['repo'] . '/commits?per_page=1&path=' . rawurlencode($j['file']);
    }
    $newest = ghMulti($first, $token);

    $last = [];
    foreach ($newest as $p => $r) {
        if ($r['code'] !== 200) { $res[$p] = ghFailed($r['code']); continue; }
        if (preg_match('~<(https://api\.github\.com/[^>]+)>;\s*rel="last"~', $r['link'], $m)) $last[$p] = $m[1];
        else $res[$p] = inWindow($r['body'], $job[$p]);   // one commit, or none: not in this repository
    }
    foreach (ghMulti($last, $token) as $p => $r) {
        $res[$p] = $r['code'] === 200 ? inWindow($r['body'], $job[$p]) : ghFailed($r['code']);
    }
    return $res;
}

// The one commit in a per_page=1 page, if it falls after the previous feed
// build and no later than the one that first carried the app.
function inWindow(string $body, array $j): int {
    $d = json_decode($body, true);
    $ts = strtotime((string)($d[0]['commit']['author']['date'] ?? ''));
    return ($ts && $ts > $j['prev'] && $ts <= $j['fs']) ? $ts : -1;
}

// A missing or empty repository is an answer; a rate limit or an outage is not.
function ghFailed(int $code): ?int {
    return ($code === 0 || $code === 403 || $code === 429 || $code >= 500) ? null : -1;
}

function ghMulti(array $urls, string $token): array {
    $res = [];
    $hdr = ['Accept: application/vnd.github+json', 'X-GitHub-Api-Version: 2022-11-28'];
    if ($token !== '') $hdr[] = 'Authorization: Bearer ' . $token;
    foreach (array_chunk($urls, 20, true) as $chunk) {
        $mh = curl_multi_init();
        $hs = [];
        foreach ($chunk as $k => $u) {
            $link = '';
            $c = curl_init($u);
            curl_setopt_array($c, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_PROTOCOLS      => CURLPROTO_HTTPS,
                CURLOPT_CONNECTTIMEOUT => 5,
                CURLOPT_TIMEOUT        => 15,
                CURLOPT_USERAGENT      => 'unraid-modern-appstore',
                CURLOPT_HTTPHEADER     => $hdr,
            ]);
            $hs[$k] = ['h' => $c, 'link' => ''];
            curl_setopt($c, CURLOPT_HEADERFUNCTION, function ($ch, $line) use (&$hs, $k) {
                if (stripos($line, 'link:') === 0) $hs[$k]['link'] = trim(substr($line, 5));
                return strlen($line);
            });
            curl_multi_add_handle($mh, $c);
        }
        $running = null;
        do { curl_multi_exec($mh, $running); curl_multi_select($mh, 0.2); } while ($running > 0);
        foreach ($hs as $k => $h) {
            $res[$k] = [
                'code' => (int)curl_getinfo($h['h'], CURLINFO_HTTP_CODE),
                'body' => (string)curl_multi_getcontent($h['h']),
                'link' => $h['link'],
            ];
            curl_multi_remove_handle($mh, $h['h']);
            curl_close($h['h']);
        }
        curl_multi_close($mh);
    }
    return $res;
}
