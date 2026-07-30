<?php
/**
 * Membership lists for the addon's own grid views (Pinned, Installed).
 *
 * Community Applications' own Pinned/Installed views are broken in the 2026.07
 * rewrite (they render the home screen instead of the list), so the modern grid
 * renders them itself. This endpoint returns the membership sets so the grid can
 * filter to them.
 *
 * READ-ONLY. Reads CA's pinned file and the user's Docker templates; writes
 * nothing. CA keys each pin as "<image ref>&<SortName>"
 * (e.g. "leppermesiah/belot:latest&Belot").
 */
header('Content-Type: application/json');

// pinned: CA's flash file, keyed "<image ref>&<SortName>"
$file = '/boot/config/plugins/community.applications/pinned_appsV2.json';
$pinned = [];
if (is_file($file)) {
    $raw = @file_get_contents($file);
    $d = @unserialize($raw);
    if ($d === false) $d = @json_decode($raw, true);
    if (is_array($d)) {
        foreach ($d as $k => $v) { if ($v !== false && $v !== null && $v !== '') $pinned[] = (string)$k; }
    }
}

// installed: image refs (repo, tag stripped) from the user's Docker templates
$installed = [];
foreach (glob('/boot/config/plugins/dockerMan/templates-user/*.xml') ?: [] as $x) {
    $c = @file_get_contents($x);
    if ($c !== false && preg_match('#<Repository>([^<]+)</Repository>#', $c, $m)) {
        $repo = strtolower(trim($m[1]));
        if ($repo !== '') { $repo = explode(':', $repo)[0]; $installed[$repo] = true; }
    }
}

echo json_encode(['pinned' => $pinned, 'installed' => array_keys($installed)]);
