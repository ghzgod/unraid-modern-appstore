<?php
/**
 * App Store GitHub Addon — sort augmentation.
 *
 * Injects our GitHub metrics (ghstars + trend deltas) into Community
 * Applications' OWN transient view caches, keyed by unique template Path. CA's
 * native changeSortOrder() then sorts and renders its REAL tiles by those keys,
 * so the GitHub view is literally CA's app page, just orderable by
 * stars/trending. We only ADD numeric fields; CA rebuilds these caches on the
 * next navigation, so nothing is permanently changed.
 *
 * CA 2026.07.21 sorts THREE caches in changeSortOrder(): displayed.json plus
 * allSearchResults.json and catSearchResults.json. A search rebuilds all of
 * them from the raw feed, which drops our fields, so every one has to be
 * (re-)injected, and inject.js re-runs this after each CA render.
 */
header('Content-Type: application/json');

$dir = '/tmp/community.applications/tempFiles';
$targets = [
    "$dir/displayed.json",
    "$dir/allSearchResults.json",
    "$dir/catSearchResults.json",
];
// If a future build ever appends a per-tab suffix to displayed.json, pick those up too.
foreach (glob("$dir/displayed*.json") ?: [] as $f) {
    if (!in_array($f, $targets, true)) $targets[] = $f;
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

$total = 0;
$files = [];
foreach ($targets as $file) {
    if (!is_file($file)) continue;
    $d = @unserialize(@file_get_contents($file));
    if (!is_array($d) || !isset($d['community']) || !is_array($d['community'])) continue;

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

    @file_put_contents($file, serialize($d));
    $files[basename($file)] = $n;
    // 'count' stays the displayed.json tally: inject.js uses it to detect when
    // CA has finished building the full app list.
    if (basename($file) === 'displayed.json') $total = $n;
}

if (!$files) { echo json_encode(['ok' => false, 'err' => 'no CA view cache']); exit; }
echo json_encode(['ok' => true, 'count' => $total, 'files' => $files]);
