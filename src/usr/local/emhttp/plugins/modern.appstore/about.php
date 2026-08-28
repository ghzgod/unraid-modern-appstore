<?php
/**
 * Version and changelog data for the About / Help panel in the Apps page UI.
 *
 * The About panel reads the plugin PACKAGE actually installed on this server
 * (the .plg Unraid's plugin manager wrote to the flash), not a bundled copy
 * from the source tree, so the version and changelog it shows are the ones
 * really running here rather than whatever the repo happens to contain.
 *
 * READ-ONLY. Reads /boot/config/plugins/modern.appstore.plg only (its version
 * and support entities, its CHANGES block, and its filemtime as the
 * last-installed-or-updated stamp) and writes nothing, anywhere. A missing or
 * unreadable file degrades to the same JSON shape with empty/zero values, so
 * the panel can show "no changelog available" instead of breaking the page.
 */
header('Content-Type: application/json');

$plg = '/boot/config/plugins/modern.appstore.plg';

// a bullet is one top-level "- " line; anything indented under it (a wrapped
// continuation, or a nested "  - " sub-point some entries carry) is folded
// back onto that bullet with a single space, so the panel shows whole
// sentences instead of the fragments the source markdown wraps them into.
function about_parse_bullets($body) {
    $lines = preg_split('/\r\n|\r|\n/', (string)$body);
    $bullets = [];
    $cur = null;
    foreach ($lines as $line) {
        if (preg_match('/^-\s+(.*)$/', $line, $m)) {
            if ($cur !== null) $bullets[] = $cur;
            $cur = $m[1];
        } elseif ($cur !== null && trim($line) !== '') {
            $cur .= ' ' . trim($line);
        }
    }
    if ($cur !== null) $bullets[] = $cur;

    // collapse whitespace, cap each bullet's length and the bullet count per
    // release, so one oversized entry cannot bloat the panel's payload.
    $out = [];
    foreach ($bullets as $b) {
        $b = trim(preg_replace('/\s+/', ' ', $b));
        if ($b === '') continue;
        if (function_exists('mb_strlen')) {
            if (mb_strlen($b) > 400) $b = mb_substr($b, 0, 399) . '…';
        } elseif (strlen($b) > 400) {
            $b = substr($b, 0, 399) . '...';
        }
        $out[] = $b;
        if (count($out) >= 8) break;
    }
    return $out;
}

$version   = '';
$support   = '';
$updatedAt = 0;
$entries   = [];

$raw = is_file($plg) ? @file_get_contents($plg) : false;
if ($raw !== false && $raw !== '') {
    if (preg_match('/<!ENTITY\s+version\s+"([^"]*)"/', $raw, $m)) $version = $m[1];
    if (preg_match('/<!ENTITY\s+support\s+"([^"]*)"/', $raw, $m)) $support = $m[1];

    $mtime = @filemtime($plg);
    if ($mtime !== false) $updatedAt = $mtime;

    // the CHANGES block is already newest-first in the source file; splitting
    // on the "##version" heading line keeps that order, so taking the first
    // three parts is taking the three most recent releases, no re-sorting.
    if (preg_match('/<CHANGES>(.*?)<\/CHANGES>/s', $raw, $cm)) {
        $parts = preg_split('/^##\s*(\S+).*$/m', $cm[1], -1, PREG_SPLIT_DELIM_CAPTURE);
        for ($i = 1; $i < count($parts) && count($entries) < 3; $i += 2) {
            $entries[] = [
                'version' => trim((string)$parts[$i]),
                'bullets' => about_parse_bullets($parts[$i + 1] ?? ''),
            ];
        }
    }
}

echo json_encode([
    'version'   => $version,
    'updatedAt' => $updatedAt,
    'support'   => $support,
    'entries'   => $entries,
], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
