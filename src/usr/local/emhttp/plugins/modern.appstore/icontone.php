<?php
/**
 * Mean brightness of an app icon, so the grid can decide what to put behind it.
 *
 * Roughly a fifth of the catalog's icons are dark artwork drawn for a light
 * page, and this addon's icon tile is a near-black plate, so those icons
 * arrive with nothing to see. The browser cannot measure them itself: most are
 * served by ca.unraid.net, which sends no CORS header, so drawing one to a
 * canvas taints it and the pixels cannot be read back. The server has no such
 * restriction.
 *
 * POST {"u":["<icon url>", ...]} -> {"<icon url>": <0-255 mean luminance>}
 *
 * An icon that cannot be fetched or decoded answers -1, which the caller reads
 * as "leave this tile alone" rather than asking again on every render.
 *
 * Answers are cached to the addon's data directory on flash and kept: an
 * icon's artwork does not change, and artwork that does arrives under a new
 * URL. Only URLs the catalog actually names are ever fetched, so this endpoint
 * cannot be pointed at anything else on the network.
 */
header('Content-Type: application/json');

$dataDir   = '/boot/config/plugins/modern.appstore';
$cacheFile = $dataDir . '/icontone.json';
$appsFile  = __DIR__ . '/apps.json';

$req  = json_decode(file_get_contents('php://input'), true);
$want = (is_array($req) && isset($req['u']) && is_array($req['u'])) ? $req['u'] : [];
$want = array_values(array_unique(array_filter(array_map('strval', $want))));
if (!$want) { echo '{}'; exit; }
if (count($want) > 80) $want = array_slice($want, 0, 80);

$cache = [];
if (is_file($cacheFile)) {
    $d = json_decode(@file_get_contents($cacheFile), true);
    if (is_array($d)) $cache = $d;
}

$out = [];
$todo = [];
foreach ($want as $u) {
    if (array_key_exists($u, $cache)) $out[$u] = $cache[$u];
    else $todo[] = $u;
}

// Only icons the catalog actually names. Without this the endpoint would fetch
// whatever URL a caller handed it, from a host sitting inside the user's own
// network.
if ($todo) {
    $known = [];
    $apps = json_decode(@file_get_contents($appsFile), true);
    foreach (($apps['apps'] ?? []) as $a) {
        if (!empty($a['ic'])) $known[$a['ic']] = true;
    }
    $todo = array_values(array_filter($todo, function ($u) use ($known) {
        if (isset($known[$u])) return true;
        // the grid falls back to a maintainer's GitHub avatar when a template
        // names no icon of its own, and those are built rather than listed
        return (bool)preg_match('#^https://github\.com/[A-Za-z0-9._-]+\.png(\?size=\d+(&retry=1)?)?$#', $u);
    }));
}

if ($todo) {
    foreach (fetchLuminance($todo) as $u => $l) { $out[$u] = $l; $cache[$u] = $l; }
    if (is_dir($dataDir) || @mkdir($dataDir, 0755, true)) {
        $tmp = $cacheFile . '.tmp';
        if (@file_put_contents($tmp, json_encode($cache)) !== false) @rename($tmp, $cacheFile);
    }
}

echo json_encode($out);

/**
 * Downloads each icon in one pass and hands the bytes to luminanceOf().
 */
function fetchLuminance(array $urls) {
    $res = [];
    $mh = curl_multi_init();
    $handles = [];
    foreach ($urls as $u) {
        $c = curl_init($u);
        curl_setopt_array($c, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 3,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_TIMEOUT        => 8,
            CURLOPT_USERAGENT      => 'unraid-modern-appstore',
        ]);
        curl_multi_add_handle($mh, $c);
        $handles[$u] = $c;
    }
    $running = null;
    do { curl_multi_exec($mh, $running); curl_multi_select($mh, 0.2); } while ($running > 0);

    foreach ($handles as $u => $c) {
        $body = curl_multi_getcontent($c);
        curl_multi_remove_handle($mh, $c);
        curl_close($c);
        $res[$u] = luminanceOf($body);
    }
    curl_multi_close($mh);
    return $res;
}

/**
 * Scales the image to 16x16 and averages the luminance of the pixels that are
 * actually painted. Transparent pixels are skipped: an icon is dark because
 * its ink is dark, not because most of its canvas is empty.
 */
function luminanceOf($body) {
    if (!$body || strlen($body) > 4194304) return -1;
    $im = @imagecreatefromstring($body);
    if (!$im) return -1;
    if (!imageistruecolor($im)) @imagepalettetotruecolor($im);
    $small = @imagescale($im, 16, 16);
    if ($small) { imagedestroy($im); $im = $small; }
    $sum = 0.0; $n = 0;
    $w = imagesx($im); $h = imagesy($im);
    for ($y = 0; $y < $h; $y++) {
        for ($x = 0; $x < $w; $x++) {
            $p = imagecolorat($im, $x, $y);
            if ((($p >> 24) & 0x7F) > 96) continue;   // all but transparent
            $sum += 0.2126 * (($p >> 16) & 0xFF) + 0.7152 * (($p >> 8) & 0xFF) + 0.0722 * ($p & 0xFF);
            $n++;
        }
    }
    imagedestroy($im);
    if (!$n) return -1;
    return (int)round($sum / $n);
}
