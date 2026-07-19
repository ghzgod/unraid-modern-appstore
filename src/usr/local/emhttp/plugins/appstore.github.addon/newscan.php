<?php
/**
 * App Store GitHub Addon — on-demand new-repo check.
 *
 * Called by inject.js when the Apps page loads. Launches a lightweight
 * --new-only scan (fetches stars only for repos not yet in the DB), so newly
 * published app-store apps get their badge within seconds instead of waiting
 * for the hourly cron. Throttled server-side and a no-op while a scan runs.
 */
header('Content-Type: application/json');

const THROTTLE = 180;   // at most one on-demand check every 3 minutes
$base = '/usr/local/emhttp/plugins/appstore.github.addon';
$php  = $base . '/fetch_stars.php';
$cfg  = @parse_ini_file('/boot/config/plugins/appstore.github.addon/appstore.github.addon.cfg') ?: [];
$dataDir = trim($cfg['DATA_DIR'] ?? '') ?: '/boot/config/plugins/appstore.github.addon';

$now = time();
$f = $dataDir . '/last_newscan.json';
$last = (int)(@json_decode(@file_get_contents($f), true)['ts'] ?? 0);
if ($now - $last < THROTTLE) { echo json_encode(['started' => false, 'throttled' => true]); exit; }
if (trim(@shell_exec("pgrep -f 'fetch_stars\\.php' 2>/dev/null") ?? '') !== '') { echo json_encode(['started' => false, 'running' => true]); exit; }

@file_put_contents($f, json_encode(['ts' => $now]));
@exec('nohup php ' . escapeshellarg($php) . ' --new-only 1 >/dev/null 2>&1 &');
echo json_encode(['started' => true]);
