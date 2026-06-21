<?php
/**
 * App Store GitHub Addon — cancel a running scan.
 * Kills the fetcher and marks progress.json as not running.
 */
header('Content-Type: application/json');

$base = '/usr/local/emhttp/plugins/appstore.github.addon';
@exec("pkill -f 'fetch_stars\\.php' 2>/dev/null");

$p = @json_decode(@file_get_contents($base . '/progress.json'), true) ?: [];
$p['running'] = false;
$p['updated_at'] = time();
@file_put_contents($base . '/progress.json', json_encode($p, JSON_UNESCAPED_SLASHES));

echo json_encode(['canceled' => true]);
