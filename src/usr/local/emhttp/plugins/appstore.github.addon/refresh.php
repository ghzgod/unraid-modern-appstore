<?php
/**
 * App Store GitHub Addon — manual refresh trigger.
 *
 * Launches the fetcher in the background (with --manual so its time is
 * recorded) and returns JSON. Enforces a 3-day cooldown between MANUAL
 * refreshes (the 6-hourly cron is unaffected). Writes an immediate
 * progress.json so the bar appears at once. The fetcher's flock makes a
 * duplicate launch a harmless no-op.
 */
header('Content-Type: application/json');

const COOLDOWN = 3 * 86400;
$base = '/usr/local/emhttp/plugins/appstore.github.addon';
$php  = $base . '/fetch_stars.php';
$cfg  = @parse_ini_file('/boot/config/plugins/appstore.github.addon/appstore.github.addon.cfg') ?: [];
$dataDir = trim($cfg['DATA_DIR'] ?? '') ?: '/boot/config/plugins/appstore.github.addon';

$now = time();
$lm  = @json_decode(@file_get_contents($dataDir . '/last_manual.json'), true);
$last = (int)($lm['ts'] ?? 0);
if ($now - $last < COOLDOWN) {
    echo json_encode(['started' => false, 'cooldown' => true, 'next_allowed' => $last + COOLDOWN, 'last' => $last]);
    exit;
}

if (trim(@shell_exec("pgrep -f 'fetch_stars\\.php' 2>/dev/null") ?? '') !== '') {
    echo json_encode(['started' => false, 'running' => true]);
    exit;
}

@file_put_contents($base . '/progress.json', json_encode([
    'running' => true, 'done' => 0, 'total' => 0,
    'ok' => 0, 'not_modified' => 0, 'missing' => 0, 'errors' => 0, 'updated_at' => $now,
], JSON_UNESCAPED_SLASHES));

@exec('nohup php ' . escapeshellarg($php) . ' --manual 1 >/dev/null 2>&1 &');
echo json_encode(['started' => true, 'running' => true]);
