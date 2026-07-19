<?php
/**
 * App Store GitHub Addon — sort augmentation.
 *
 * Injects our GitHub metrics (ghstars + trend deltas) into Community
 * Applications' OWN displayed.json (the transient, regenerable view cache),
 * keyed by app Name. CA's native changeSortOrder() then sorts and renders its
 * REAL tiles by those keys — so the GitHub view is literally CA's app page,
 * just orderable by stars/trending. We only ADD numeric fields; CA rebuilds
 * this cache on the next navigation, so nothing is permanently changed.
 */
header('Content-Type: application/json');

// CA (7.2.3) writes a single displayed.json (see include/paths.php:
// community-templates-displayed => tempFiles/displayed.json). If a build ever
// appends a per-tab suffix, fall back to the newest displayed*.json.
$dir = '/tmp/community.applications/tempFiles';
$displayed = "$dir/displayed.json";
if (!is_file($displayed)) {
    $newest = 0;
    foreach (glob("$dir/displayed*.json") ?: [] as $f) {
        $m = @filemtime($f);
        if ($m !== false && $m > $newest) { $newest = $m; $displayed = $f; }
    }
}
$base = '/usr/local/emhttp/plugins/appstore.github.addon';

$apps = @json_decode(@file_get_contents($base . '/apps.json'), true);
$map = [];   // keyed by unique template path (names are NOT unique)
if ($apps && isset($apps['apps'])) {
    foreach ($apps['apps'] as $a) {
        $p = $a['p'] ?? '';
        if ($p === '') continue;
        $map[$p] = $a;
    }
}

if (!is_file($displayed)) { echo json_encode(['ok' => false, 'err' => 'no displayed.json']); exit; }
$d = @unserialize(file_get_contents($displayed));
if (!is_array($d) || !isset($d['community']) || !is_array($d['community'])) {
    echo json_encode(['ok' => false, 'err' => 'unexpected displayed.json']); exit;
}

function gi($m, $k) { return ($m && $m[$k] !== null) ? (int)$m[$k] : -1; }

// Relative growth for a window, in basis points (0.01%) so CA sorts it as an
// integer. delta / (stars at the window's start). A 10-star baseline floor keeps
// trivial repos (2->4 stars = "+100%") from dominating the percent sort.
function gp($m, $k) {
    if (!$m || $m[$k] === null || $m['s'] === null) return -1;
    $d = (int)$m[$k]; $base = (int)$m['s'] - $d;
    if ($base < 10) return -1;
    return (int)round($d / $base * 10000);
}

$n = 0;
foreach ($d['community'] as &$app) {
    if (!is_array($app)) continue;
    $m = $map[$app['Path'] ?? ''] ?? null;
    $app['ghstars'] = ($m && $m['s'] !== null) ? (int)$m['s'] : -1;
    $app['ght1']    = gi($m, 't1');
    $app['ght7']    = gi($m, 't7');
    $app['ght30']   = gi($m, 't30');
    $app['ght365']  = gi($m, 't365');
    $app['ghp1']    = gp($m, 't1');
    $app['ghp7']    = gp($m, 't7');
    $app['ghp30']   = gp($m, 't30');
    $app['ghp365']  = gp($m, 't365');
    $n++;
}
unset($app);

@file_put_contents($displayed, serialize($d));
echo json_encode(['ok' => true, 'count' => $n]);
