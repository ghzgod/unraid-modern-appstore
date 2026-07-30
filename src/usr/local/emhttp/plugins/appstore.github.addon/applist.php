<?php
/**
 * App list endpoint for the App Store GitHub Addon's own grid.
 *
 * Community Applications' 2026.07 rewrite made its client-side sort unreliable
 * (it collapses the All-Apps view to a ~36-app subset and sorts only those).
 * Rather than fight CA's display pipeline, the addon renders its OWN grid and
 * sorts the FULL catalog client-side. This endpoint hands that grid one compact
 * JSON array of every displayable app.
 *
 * READ-ONLY. It only reads:
 *   - this plugin's own apps.json  (name/icon/category/stars/trends, our data)
 *   - CA's templates_new.json      (FirstSeen, downloads, displayable flags), never written
 * It writes nothing, anywhere. All CA paths are opened read-only.
 *
 * Output: { "generated": <ts>, "apps": [ { p,n,sn,ic,ct,s,dl,fs,t1,t7,t30,t365 } ] }
 *   p  = template path (passed to CA's showSidebarApp for Info/Install)
 *   n  = display name          sn = lowercase sort-name
 *   ic = icon URL              ct = category
 *   s  = GitHub stars (or null)  dl = Unraid downloads (or 0)
 *   fs = FirstSeen unix ts (date added; 0 if unknown)
 *   t1/t7/t30/t365 = star trend deltas (day/week/month/year)
 */
header('Content-Type: application/json');

$dataDir = '/boot/config/plugins/appstore.github.addon';
$caTmp   = '/tmp/community.applications/tempFiles';

function read_json_ro($path) {
    if (!is_file($path)) return null;
    $raw = @file_get_contents($path);
    if ($raw === false) return null;
    $d = @json_decode($raw, true);
    if ($d === null) $d = @unserialize($raw);   // CA files are serialized
    return is_array($d) ? $d : null;
}

// our own catalog (already has name/path/icon/category/stars/trends for every app)
$ours = read_json_ro("$dataDir/apps.json");
$byPath = [];
foreach (($ours['apps'] ?? []) as $a) {
    if (!empty($a['p'])) $byPath[$a['p']] = $a;
}

// CA's master template list: name, FirstSeen, downloads, displayable flags
$tmpl = read_json_ro("$caTmp/templates_new.json") ?: [];

$out = [];
foreach ($tmpl as $t) {
    if (!is_array($t)) continue;
    // match CA's "All Apps" visibility: displayable, not blacklisted, not deprecated
    if (empty($t['Displayable'])) continue;
    if (!empty($t['Blacklist'])) continue;
    if (!empty($t['Deprecated'])) continue;
    // language packs are CA UI translations, not apps; CA files them under a
    // "Language:" category. Exclude them from the app grid entirely.
    if (!empty($t['Language'])) continue;

    $path = $t['Path'] ?? '';
    if ($path === '') continue;

    $mine = $byPath[$path] ?? null;
    $name = $t['Name'] ?? ($mine['n'] ?? '');
    if ($name === '') continue;

    // Download count comes from CA's catalog (DockerHub pulls of the app's
    // image). BUT apps built on an official base image (nginx, redis, postgres)
    // reference it as a bare "name:tag" with no owner namespace, and then this
    // number is the BASE image's global pulls (e.g. nginx = 13.2B), not the
    // app's. That's misleading, so we drop it for those; real app images are
    // "owner/name" and keep their genuine count.
    $dl = (int)($t['downloads'] ?? 0);
    $imgName = explode(':', trim($t['Repository'] ?? ''))[0];
    if ($imgName === '' || strpos($imgName, '/') === false) $dl = 0;

    // description: prefer our stored copy, fall back to CA's Overview; trim to a
    // card-sized blurb (tiles clamp it anyway) to keep the payload lean.
    $desc = $mine['de'] ?? ($t['Overview'] ?? '');
    $desc = trim(preg_replace('/\s+/', ' ', strip_tags($desc)));
    if (strlen($desc) > 400) $desc = substr($desc, 0, 400) . '…';

    $out[] = [
        'p'   => $path,
        'n'   => $name,
        'sn'  => strtolower($t['SortName'] ?? $name),
        'ic'  => $mine['ic'] ?? ($t['Icon'] ?? ''),
        'ct'  => $mine['ct'] ?? ($t['Category'] ?? ''),
        'au'  => $mine['au'] ?? ($t['Author'] ?? ''),
        'de'  => $desc,
        'pr'  => $mine['pr'] ?? ($t['Project'] ?? ''),
        'su'  => $mine['su'] ?? ($t['Support'] ?? ''),
        'rn'  => $t['RepoName'] ?? '',                       // pin key (repo display name)
        'rp'  => $mine['rp'] ?? '',                          // owner/repo, for the icon fallback
        's'   => isset($mine['s']) ? $mine['s'] : null,
        'dl'  => $dl,
        'fs'  => (int)($t['FirstSeen'] ?? 0),
        't1'  => $mine['t1'] ?? null,
        't7'  => $mine['t7'] ?? null,
        't30' => $mine['t30'] ?? null,
        't365'=> $mine['t365'] ?? null,
    ];
}

// JSON_INVALID_UTF8_SUBSTITUTE: some feed descriptions carry stray bytes that
// would otherwise make json_encode() return false and emit an empty body.
echo json_encode(
    ['generated' => time(), 'count' => count($out), 'apps' => $out],
    JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
);
