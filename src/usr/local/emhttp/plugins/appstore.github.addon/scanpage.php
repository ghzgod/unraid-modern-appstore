<?php
/**
 * Unraid Modern Appstore: star scan for the apps currently on screen.
 *
 * The grid posts the template paths it is displaying; this fetches stars for
 * just those, so browsing fills the catalog in where it is actually being read
 * instead of scanning all ~3600 apps up front. Only apps that have never been
 * tried, or whose last attempt is older than the staleness window, are fetched
 * (fetch_stars.php --only-paths --stale-days does that filtering).
 *
 * Input : POST JSON { "paths": [...], "force": 0|1 }
 * Output: { "scanned": <n requested>, "stars": { "<path>": <stars|null> } }
 *
 * force=1 comes from the Refresh menu's "this page" option and ignores the
 * staleness window. It never bypasses the fetcher's own single-instance lock.
 *
 * Paths are validated against CA's catalog and only ever written to a temp
 * file; nothing from the request reaches a shell.
 */
header('Content-Type: application/json');

const MAX_PATHS  = 200;          // a grid page is 96; leave headroom, refuse floods
const STALE_DAYS = 7;            // re-check an app at most once a week
const RUN_CAP    = 240;          // seconds a page scan may take before we answer anyway

$base    = '/usr/local/emhttp/plugins/appstore.github.addon';
$fetcher = $base . '/fetch_stars.php';
$caCache = '/tmp/community.applications/tempFiles/templates_new.json';
$cfg     = @parse_ini_file('/boot/config/plugins/appstore.github.addon/appstore.github.addon.cfg') ?: [];
$dataDir = rtrim(trim($cfg['DATA_DIR'] ?? '') ?: '/boot/config/plugins/appstore.github.addon', '/');

$raw = file_get_contents('php://input');
$req = json_decode($raw ?: '[]', true);
$paths = is_array($req['paths'] ?? null) ? $req['paths'] : [];
$force = !empty($req['force']);

// keep only real catalog paths, so nothing invented by the caller is written out
$valid = [];
$apps = @unserialize(@file_get_contents($caCache));
if (is_array($apps)) {
    $known = [];
    foreach ($apps as $a) { if (is_array($a) && !empty($a['Path'])) $known[$a['Path']] = 1; }
    foreach ($paths as $p) {
        if (!is_string($p) || $p === '') continue;
        if (isset($known[$p])) $valid[$p] = 1;
        if (count($valid) >= MAX_PATHS) break;
    }
}
if (!$valid) { echo json_encode(['scanned' => 0, 'stars' => (object)[]]); exit; }

$listFile = tempnam(sys_get_temp_dir(), 'asga_paths_');
@file_put_contents($listFile, implode("\n", array_keys($valid)));

$cmd = 'php ' . escapeshellarg($fetcher)
     . ' --only-paths ' . escapeshellarg($listFile)
     . ' --stale-days ' . ($force ? '0' : (string)STALE_DAYS);
@exec('timeout ' . RUN_CAP . ' ' . $cmd . ' >/dev/null 2>&1');
@unlink($listFile);

// answer from the catalog the fetcher just rewrote, so the grid can repaint the
// badges in place rather than re-downloading the whole app list
$out = [];
$mine = @json_decode((string)@file_get_contents($dataDir . '/apps.json'), true);
foreach (($mine['apps'] ?? []) as $a) {
    if (!empty($a['p']) && isset($valid[$a['p']])) $out[$a['p']] = isset($a['s']) ? $a['s'] : null;
}
echo json_encode(['scanned' => count($valid), 'stars' => $out ?: (object)[]], JSON_UNESCAPED_SLASHES);
