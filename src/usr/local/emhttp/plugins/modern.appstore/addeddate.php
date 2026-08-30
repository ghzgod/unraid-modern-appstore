<?php
/**
 * First-release date for a plugin whose FirstSeen date Community Applications
 * never recorded.
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

// Only plugin paths the catalog actually names, fetched only at the PluginURL
// the catalog itself recorded for them. Without this the endpoint would fetch
// whatever URL a caller handed it, from a host sitting inside the user's own
// network; anything CA's own templates do not list as a plugin with a
// PluginURL is dropped here and never reaches curl.
$pluginUrl = [];
if ($todo) {
    // Despite the .json name CA writes this file PHP-serialized, so it is
    // unserialized first and only falls back to json_decode.
    $raw  = @file_get_contents($tmplFile);
    $tmpl = $raw !== false ? @unserialize($raw) : false;
    if (!is_array($tmpl)) $tmpl = $raw !== false ? json_decode($raw, true) : [];
    foreach ((array)$tmpl as $t) {
        $p = (string)($t['Path'] ?? '');
        if ($p === '') continue;
        if (empty($t['Plugin'])) continue;
        $u = trim((string)($t['PluginURL'] ?? ''));
        if ($u === '') continue;
        $pluginUrl[$p] = $u;
    }
    $todo = array_values(array_filter($todo, function ($p) use ($pluginUrl) {
        return isset($pluginUrl[$p]);
    }));
}

if ($todo) {
    $urlByPath = [];
    foreach ($todo as $p) $urlByPath[$p] = $pluginUrl[$p];

    foreach (fetchFirstRelease($urlByPath) as $p => $ts) {
        $val = $ts > 0 ? $ts : -1;
        $out[$p] = $val;
        $cache[$p] = $val;
    }
    if (is_dir($dataDir) || @mkdir($dataDir, 0755, true)) {
        $tmp = $cacheFile . '.tmp';
        if (@file_put_contents($tmp, json_encode($cache)) !== false) @rename($tmp, $cacheFile);
    }
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
