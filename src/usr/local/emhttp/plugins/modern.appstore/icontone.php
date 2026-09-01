<?php
/**
 * Mean brightness and a representative colour of an app icon, so the grid can
 * decide what to put behind it and what colour to tint that backing with.
 *
 * Roughly a fifth of the catalog's icons are dark artwork drawn for a light
 * page, and this addon's icon tile is a near-black plate, so those icons
 * arrive with nothing to see. The browser cannot measure them itself: most are
 * served by ca.unraid.net, which sends no CORS header, so drawing one to a
 * canvas taints it and the pixels cannot be read back. The server has no such
 * restriction.
 *
 * POST u=<JSON array of icon urls> (form-encoded, with the webGui's csrf_token) -> {"<icon url>": [<0-255 mean luminance>, <6-hex colour, or empty string>]}
 *
 * An icon that cannot be fetched or decoded answers [-1, ''], which the caller
 * reads as "leave this tile alone" rather than asking again on every render.
 *
 * Answers are cached to the addon's data directory on flash and kept: an
 * icon's artwork does not change, and artwork that does arrives under a new
 * URL. Only URLs the catalog actually names are ever fetched, so this endpoint
 * cannot be pointed at anything else on the network.
 */
header('Content-Type: application/json');

$dataDir   = '/boot/config/plugins/modern.appstore';
// New file: the old cache's entries are plain integers and would be misread
// as a [lum, colour] pair.
$cacheFile = $dataDir . '/icontone5.json';
$appsFile  = __DIR__ . '/apps.json';

// the webGui only lets a form-encoded POST through with its csrf token, so
// the request now arrives as a field rather than a raw JSON body
if (isset($_POST['u'])) {
    $req = ['u' => json_decode((string)$_POST['u'], true)];
} else {
    $req = json_decode(file_get_contents('php://input'), true);
}
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
    foreach (fetchTone($todo) as $u => $l) { $out[$u] = $l; $cache[$u] = $l; }
    if (is_dir($dataDir) || @mkdir($dataDir, 0755, true)) {
        $tmp = $cacheFile . '.tmp';
        if (@file_put_contents($tmp, json_encode($cache)) !== false) @rename($tmp, $cacheFile);
    }
}

echo json_encode($out);

/**
 * Downloads each icon in one pass and hands the bytes to toneOf().
 */
function fetchTone(array $urls) {
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
        $res[$u] = toneOf($body);
    }
    curl_multi_close($mh);
    return $res;
}

/**
 * Scales the image to 16x16 for luminance (unchanged from before) and to
 * 24x24 for colour, and answers both together. Returns [-1, ''] on failure.
 */
function toneOf($body) {
    if (!$body || strlen($body) > 4194304) return [-1, ''];
    // An SVG is text that opens with a tag; a raster opens with its magic
    // bytes. Searching the head for "<svg" instead matched a PNG that carried
    // an SVG inside its metadata chunk and read that as the whole icon.
    $head = ltrim(substr($body, 0, 64), "\xEF\xBB\xBF \t\r\n");
    if ($head !== '' && $head[0] === '<') return svgTone($body);
    $im = @imagecreatefromstring($body);
    if (!$im) return [-1, ''];
    if (!imageistruecolor($im)) @imagepalettetotruecolor($im);

    $lumSrc = @imagescale($im, 16, 16);
    if (!$lumSrc) $lumSrc = $im;
    $sum = 0.0; $n = 0;
    $w = imagesx($lumSrc); $h = imagesy($lumSrc);
    for ($y = 0; $y < $h; $y++) {
        for ($x = 0; $x < $w; $x++) {
            $p = imagecolorat($lumSrc, $x, $y);
            if ((($p >> 24) & 0x7F) > 96) continue;   // all but transparent
            $sum += 0.2126 * (($p >> 16) & 0xFF) + 0.7152 * (($p >> 8) & 0xFF) + 0.0722 * ($p & 0xFF);
            $n++;
        }
    }
    $lum = $n ? (int)round($sum / $n) : -1;
    if ($lumSrc !== $im) imagedestroy($lumSrc);

    $colSrc = @imagescale($im, 48, 48);
    if (!$colSrc) $colSrc = $im;
    $colour = colourOf($colSrc);
    if ($colSrc !== $im) imagedestroy($colSrc);

    imagedestroy($im);
    return [$lum, $colour];
}

/**
 * GD cannot rasterise an SVG and Unraid ships nothing that can, so an SVG
 * icon is read as text instead: every fill, stroke and stop colour it names,
 * each weighted by its chroma squared and by how often it is named. That is
 * the same vote as the pixel pass, cast by shapes rather than by area, and it
 * is right for the icons the catalog actually has, which are a plate, a mark
 * and a highlight. The luminance is the plain mean of the same colours.
 */
function svgTone($body) {
    static $named = [
        'white' => 'ffffff', 'black' => '000000', 'red' => 'ff0000', 'green' => '008000',
        'lime' => '00ff00', 'blue' => '0000ff', 'navy' => '000080', 'orange' => 'ffa500',
        'yellow' => 'ffff00', 'gold' => 'ffd700', 'purple' => '800080', 'violet' => 'ee82ee',
        'magenta' => 'ff00ff', 'cyan' => '00ffff', 'teal' => '008080', 'pink' => 'ffc0cb',
        'brown' => 'a52a2a', 'gray' => '808080', 'grey' => '808080', 'silver' => 'c0c0c0',
        'maroon' => '800000', 'olive' => '808000', 'aqua' => '00ffff', 'crimson' => 'dc143c',
        'tomato' => 'ff6347', 'coral' => 'ff7f50', 'salmon' => 'fa8072', 'indigo' => '4b0082',
        'turquoise' => '40e0d0', 'skyblue' => '87ceeb', 'steelblue' => '4682b4', 'dodgerblue' => '1e90ff',
        'royalblue' => '4169e1', 'limegreen' => '32cd32', 'forestgreen' => '228b22', 'seagreen' => '2e8b57',
        'darkorange' => 'ff8c00', 'orangered' => 'ff4500', 'hotpink' => 'ff69b4', 'deeppink' => 'ff1493',
    ];
    $rgbs = [];
    if (preg_match_all('/(?:fill|stroke|stop-color|color)\s*[:=]\s*["\']?\s*([^;"\'\s>]+)/i', $body, $m)) {
        foreach ($m[1] as $v) {
            $v = strtolower(trim($v));
            if (preg_match('/^#([0-9a-f]{6})/', $v, $h))      $hex = $h[1];
            elseif (preg_match('/^#([0-9a-f]{3})$/', $v, $h)) $hex = $h[1][0].$h[1][0].$h[1][1].$h[1][1].$h[1][2].$h[1][2];
            elseif (preg_match('/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/', $v, $h)) $hex = sprintf('%02x%02x%02x', min(255, $h[1]), min(255, $h[2]), min(255, $h[3]));
            elseif (isset($named[$v])) $hex = $named[$v];
            else continue;
            $rgbs[] = [hexdec(substr($hex, 0, 2)), hexdec(substr($hex, 2, 2)), hexdec(substr($hex, 4, 2))];
        }
    }
    if (!$rgbs) return [-1, ''];
    $lum = 0.0; $bestW = 0.0; $best = null;
    $votes = [];
    foreach ($rgbs as $c) {
        list($r, $g, $b) = $c;
        $lum += 0.2126 * $r + 0.7152 * $g + 0.0722 * $b;
        $k = $r . ',' . $g . ',' . $b;
        $ch = (max($r, $g, $b) - min($r, $g, $b)) / 255;
        $votes[$k] = ($votes[$k] ?? 0) + $ch * $ch;
        if ($votes[$k] > $bestW) { $bestW = $votes[$k]; $best = $c; }
    }
    $lum = (int)round($lum / count($rgbs));
    if ($bestW < 0.02) return [$lum, ''];
    list($hh, $ss, $ll) = rgbToHsl($best[0], $best[1], $best[2]);
    list($nr, $ng, $nb) = hslToRgb($hh, max($ss, 0.6), 0.55);
    return [$lum, sprintf('%02x%02x%02x', $nr, $ng, $nb)];
}

/**
 * A representative colour of an already-scaled icon. Each pixel is weighted
 * by its chroma squared, so a colourful mark outvotes a dark plate, a drop
 * shadow or a white background however many pixels those cover; the weight is
 * bucketed into 24 hue bins and the winning bin, plus its two neighbours,
 * gives the final mean. Below a weight floor there is no colour worth taking
 * and this answers ''.
 *
 * The mean is then pushed to a fixed saturation and lightness before it is
 * handed back: a muddy mean drawn at a quarter alpha reads as dirt on the
 * tile, while a vivid version of the same hue reads as the icon.
 */
function colourOf($im) {
    $w = imagesx($im); $h = imagesy($im);
    $binW = array_fill(0, 24, 0.0);
    $binR = array_fill(0, 24, 0.0);
    $binG = array_fill(0, 24, 0.0);
    $binB = array_fill(0, 24, 0.0);
    $n = 0;
    for ($y = 0; $y < $h; $y++) {
        for ($x = 0; $x < $w; $x++) {
            $p = imagecolorat($im, $x, $y);
            if ((($p >> 24) & 0x7F) > 96) continue;   // all but transparent
            $n++;
            $r = ($p >> 16) & 0xFF; $g = ($p >> 8) & 0xFF; $b = $p & 0xFF;
            $max = max($r, $g, $b); $min = min($r, $g, $b);
            // Chroma, not saturation. Saturation is chroma over the brightest
            // channel, so a near-black navy (10,20,60) scores 0.83 and a
            // plate of it outvotes the gold mark drawn on top; its chroma is
            // 0.2, and squared it is a twentieth of the mark's.
            $c = ($max - $min) / 255;
            $wgt = $c * $c;
            if ($wgt < 0.01) continue;
            $delta = $max - $min;
            if ($max === $r)      $hue = 60 * fmod((($g - $b) / $delta), 6);
            elseif ($max === $g)  $hue = 60 * ((($b - $r) / $delta) + 2);
            else                  $hue = 60 * ((($r - $g) / $delta) + 4);
            if ($hue < 0) $hue += 360;
            $bin = ((int)floor($hue / 15)) % 24;
            $binW[$bin] += $wgt;
            $binR[$bin] += $wgt * $r;
            $binG[$bin] += $wgt * $g;
            $binB[$bin] += $wgt * $b;
        }
    }
    if (!$n) return '';

    $best = 0; $bestW = -1;
    for ($i = 0; $i < 24; $i++) if ($binW[$i] > $bestW) { $bestW = $binW[$i]; $best = $i; }
    $lo = ($best + 23) % 24; $hi = ($best + 1) % 24;
    $totalW = $binW[$lo] + $binW[$best] + $binW[$hi];
    // The floor is half a percent of the pixels, not four: a mark drawn as a
    // thin coloured line on a dark plate (an outline, a lettermark, a ring)
    // is a few dozen saturated pixels of a 48x48 field, and at four percent
    // every one of those answered '' and wore the fallback tint. Below half a
    // percent the icon is greyscale in fact, not just in outline.
    if ($totalW < 0.005 * $n) return '';

    $r = ($binR[$lo] + $binR[$best] + $binR[$hi]) / $totalW;
    $g = ($binG[$lo] + $binG[$best] + $binG[$hi]) / $totalW;
    $b = ($binB[$lo] + $binB[$best] + $binB[$hi]) / $totalW;

    list($hh, $ss, $ll) = rgbToHsl($r, $g, $b);
    list($nr, $ng, $nb) = hslToRgb($hh, max($ss, 0.6), 0.55);
    return sprintf('%02x%02x%02x', $nr, $ng, $nb);
}

function rgbToHsl($r, $g, $b) {
    $r /= 255; $g /= 255; $b /= 255;
    $max = max($r, $g, $b); $min = min($r, $g, $b);
    $l = ($max + $min) / 2;
    if ($max == $min) return [0, 0, $l];
    $d = $max - $min;
    $s = $l > 0.5 ? $d / (2 - $max - $min) : $d / ($max + $min);
    if ($max == $r)      $h = ($g - $b) / $d + ($g < $b ? 6 : 0);
    elseif ($max == $g)  $h = ($b - $r) / $d + 2;
    else                 $h = ($r - $g) / $d + 4;
    return [$h / 6, $s, $l];
}

function hslToRgb($h, $s, $l) {
    if ($s == 0) { $r = $g = $b = $l; }
    else {
        $q = $l < 0.5 ? $l * (1 + $s) : $l + $s - $l * $s;
        $p = 2 * $l - $q;
        $r = hueToRgb($p, $q, $h + 1 / 3);
        $g = hueToRgb($p, $q, $h);
        $b = hueToRgb($p, $q, $h - 1 / 3);
    }
    return [(int)round($r * 255), (int)round($g * 255), (int)round($b * 255)];
}

function hueToRgb($p, $q, $t) {
    if ($t < 0) $t += 1;
    if ($t > 1) $t -= 1;
    if ($t < 1 / 6) return $p + ($q - $p) * 6 * $t;
    if ($t < 1 / 2) return $q;
    if ($t < 2 / 3) return $p + ($q - $p) * (2 / 3 - $t) * 6;
    return $p;
}
