<?php
/**
 * Membership lists for the addon's own grid views (Pinned, Installed).
 *
 * Community Applications' own Pinned/Installed views are broken in the 2026.07
 * rewrite (they render the home screen instead of the list), so the modern grid
 * renders them itself. This endpoint returns the membership sets so the grid can
 * filter to them.
 *
 * READ-ONLY. Reads CA's pinned file, the user's Docker templates and Unraid's
 * own record of installed plugins; writes nothing. CA keys each pin as
 * "<image ref>&<SortName>" (e.g. "leppermesiah/belot:latest&Belot").
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

// installed plugins: Unraid records every installed plugin as a file in
// /var/log/plugins named for the .plg itself, and CA's app feed names each
// plugin's template after that same .plg
// (/tmp/GitHub/AppFeed/plugins/modern.appstore.xml for modern.appstore.plg),
// so the filename is the key both sides share.
//
// CA's own checkInstalledPlugin() does not use it. It compares the feed's
// PluginURL against the installed file's, and the feed now publishes those as
// opaque ca.unraid.net/cdn blobs that no installed file carries: on a server
// with 46 plugins installed, CA reports 0 of the catalog's 308 plugins as
// installed. That is why every plugin here showed an Install button, including
// ones the server was already running.
//
// A .plg name is a single flat namespace: two plugins that share one cannot
// both be installed, so a name that matches is the app that occupies it.
$plugins = [];
$pluginsNorm = [];
foreach (glob('/var/log/plugins/*.plg') ?: [] as $p) {
    $b = strtolower(preg_replace('/\.plg$/i', '', basename($p)));
    if ($b === '') continue;
    $plugins[$b] = true;
    // Punctuation-stripped, for the few feed templates that spell a name with
    // different separators than the .plg does: unassigned.devices.plus.xml
    // against unassigned.devices-plus.plg. Kept as its own list rather than
    // folded into the one above, so a loose form can never be mistaken for an
    // exact filename match.
    $n = preg_replace('/[^a-z0-9]/', '', $b);
    if ($n !== '') $pluginsNorm[$n] = true;
}

echo json_encode([
    'pinned'      => $pinned,
    'installed'   => array_keys($installed),
    'plugins'     => array_keys($plugins),
    'pluginsNorm' => array_keys($pluginsNorm),
]);
