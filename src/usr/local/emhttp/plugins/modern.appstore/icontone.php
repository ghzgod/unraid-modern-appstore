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
 * It also measures where the artwork inside the file actually starts and
 * stops. The catalog's icons are not framed alike: some are drawn to the edge
 * of their canvas, others sit in a wide transparent or flat-coloured margin
 * baked into the file. Drawn at one size on one plate, the second kind reads
 * as a small picture on a big tile beside a neighbour that fills its own. The
 * grid scales each icon by this box so the gap between the artwork and the
 * plate's edge is the same on every card, whatever the file was drawn with.
 *
 * POST u=<JSON array of icon urls> (form-encoded, with the webGui's csrf_token) -> {"<icon url>": [<0-255 mean luminance>, <6-hex colour, or empty string>, <[x0,y0,x1,y1] in thousandths of the image, or null>]}
 *
 * An icon that cannot be fetched or decoded answers [-1, '', null], which the
 * caller reads as "leave this tile alone" rather than asking again on every
 * render. A null box on its own means the artwork's edge could not be read
 * with confidence, and the icon is drawn exactly as it always was. The box
 * reads "svg" instead for an icon this cannot rasterise, which asks the grid
 * to measure that one itself; see the ?svg= passthrough below.
 *
 * Answers are cached to the addon's data directory on flash and kept: an
 * icon's artwork does not change, and artwork that does arrives under a new
 * URL. A failed answer is the one thing not kept, so a CDN hiccup is retried
 * on the next request rather than remembered as a fact about the icon.
 * Only URLs the catalog actually names are ever fetched, so this endpoint
 * cannot be pointed at anything else on the network.
 */
$dataDir   = '/boot/config/plugins/modern.appstore';
// New file each time the record's shape changes: the v5 cache's entries are
// [lum, colour] pairs with no artwork box, and v6's null box means both "this
// is a photograph and has no margin to trim" and "this is an SVG and could not
// be rasterised", which are now two different answers.
$cacheFile = $dataDir . '/icontone7.json';
$appsFile  = __DIR__ . '/apps.json';

/**
 * Whether the catalog actually names this icon.
 *
 * Without it either entry point would fetch whatever URL a caller handed it,
 * from a host sitting inside the user's own network.
 */
function iconKnown(string $u, string $appsFile): bool {
    static $known = null;
    if ($known === null) {
        $known = [];
        $apps = json_decode(@file_get_contents($appsFile), true);
        foreach (($apps['apps'] ?? []) as $a) {
            if (!empty($a['ic'])) $known[$a['ic']] = true;
        }
    }
    if (isset($known[$u])) return true;
    // the grid falls back to a maintainer's GitHub avatar when a template
    // names no icon of its own, and those are built rather than listed
    return (bool)preg_match('#^https://github\.com/[A-Za-z0-9._-]+\.png(\?size=\d+(&retry=1)?)?$#', $u);
}

/**
 * GET ?svg=<icon url> -> that icon's own bytes, from this server's address.
 *
 * GD cannot rasterise an SVG and Unraid ships nothing that can, so an SVG icon
 * is the one kind whose artwork this file cannot measure. The browser can: it
 * draws the picture already. What it cannot do is read the result back, because
 * ca.unraid.net and the maintainers' own hosts send no CORS header, and drawing
 * one of their images to a canvas taints it.
 *
 * Served from here it is same-origin, so the canvas stays readable and the grid
 * measures the artwork itself. The bytes are passed through untouched and only
 * for a URL the catalog names, which is the same restriction the POST below
 * works under.
 */
if (isset($_GET['svg'])) {
    $u = (string)$_GET['svg'];
    if (!iconKnown($u, $appsFile)) { http_response_code(404); exit; }
    $ch = curl_init($u);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 3,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_TIMEOUT        => 8,
        CURLOPT_USERAGENT      => 'unraid-modern-appstore',
    ]);
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    // Only an SVG is ever served back, whatever the far end decided to send,
    // so this cannot be used to pull an arbitrary document through the webGui.
    $head = ltrim(substr((string)$body, 0, 64), "\xEF\xBB\xBF \t\r\n");
    if ($code !== 200 || $body === false || $head === '' || $head[0] !== '<' || strlen($body) > 262144) {
        http_response_code(404);
        exit;
    }
    header('Content-Type: image/svg+xml');
    header('Cache-Control: public, max-age=86400');
    echo $body;
    exit;
}

header('Content-Type: application/json');

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

if ($todo) {
    $todo = array_values(array_filter($todo, function ($u) use ($appsFile) {
        return iconKnown($u, $appsFile);
    }));
}

if ($todo) {
    foreach (fetchTone($todo) as $u => $l) {
        $out[$u] = $l;
        // [-1, ''] is a fetch or decode failure, usually a CDN timeout, and
        // is answered but not remembered, so the next request tries again
        if ($l[0] !== -1) $cache[$u] = $l;
    }
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
 * 24x24 for colour, measures the artwork's own edges at up to 128px, and
 * answers all three together. Returns [-1, '', null] on failure.
 */
function toneOf($body) {
    if (!$body || strlen($body) > 4194304) return [-1, '', null];
    // An SVG is text that opens with a tag; a raster opens with its magic
    // bytes. Searching the head for "<svg" instead matched a PNG that carried
    // an SVG inside its metadata chunk and read that as the whole icon.
    $head = ltrim(substr($body, 0, 64), "\xEF\xBB\xBF \t\r\n");
    // An SVG's artwork cannot be measured here; the grid measures it in a
    // canvas instead, through the ?svg= passthrough above. 'svg' is the record
    // that tells it to.
    if ($head !== '' && $head[0] === '<') { $t = svgTone($body); $t[2] = ($t[0] === -1) ? null : 'svg'; return $t; }
    $im = @imagecreatefromstring($body);
    if (!$im) return [-1, '', null];
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

    $box = inkBox($im);

    imagedestroy($im);
    return [$lum, $colour, $box];
}

/**
 * Where the artwork inside the file begins and ends, as [x0,y0,x1,y1] in
 * thousandths of the image's own width and height, or null when it cannot be
 * read with confidence.
 *
 * What counts as background is decided by the four corners, because that is
 * the only part of an icon that is background in every icon that has any:
 *
 *   - all four transparent  -> the margin is transparent, and the artwork is
 *     every pixel that is not
 *   - all four opaque and the same colour -> the icon is drawn on a flat
 *     field, and the artwork is every pixel that differs from it
 *   - anything else -> the image runs to its own edge, or is a photograph, or
 *     is something this cannot describe. It answers null and the icon is left
 *     exactly as it is, rather than being cropped on a guess.
 *
 * The tolerance is deliberately loose on the corner agreement (a gradient
 * field is still a field) and tight on what counts as artwork, so a JPEG's
 * ringing around a logo is background and the logo is not.
 */
function inkBox($im) {
    $w0 = imagesx($im); $h0 = imagesy($im);
    if ($w0 < 8 || $h0 < 8) return null;
    // An icon is being measured, not read: a 512px source costs sixteen times
    // the pixels of a 128px one and answers the same question.
    $src = $im; $scaled = false;
    $mx = max($w0, $h0);
    if ($mx > 128) {
        $s = @imagescale($im, (int)max(1, round($w0 * 128 / $mx)), (int)max(1, round($h0 * 128 / $mx)));
        if ($s) { $src = $s; $scaled = true; }
    }
    $w = imagesx($src); $h = imagesy($src);

    $corners = [
        imagecolorat($src, 0, 0), imagecolorat($src, $w - 1, 0),
        imagecolorat($src, 0, $h - 1), imagecolorat($src, $w - 1, $h - 1),
    ];
    $clear = 0; $solid = 0;
    foreach ($corners as $p) {
        $a = ($p >> 24) & 0x7F;
        if ($a > 96) $clear++;
        elseif ($a <= 32) $solid++;
    }
    $bg = null;                                  // null = transparent background
    if ($clear !== 4) {
        if ($solid !== 4) { if ($scaled) imagedestroy($src); return null; }
        $r = $g = $b = 0;
        foreach ($corners as $p) { $r += ($p >> 16) & 0xFF; $g += ($p >> 8) & 0xFF; $b += $p & 0xFF; }
        $bg = [$r / 4, $g / 4, $b / 4];
        foreach ($corners as $p) {
            $d = sqrt(pow((($p >> 16) & 0xFF) - $bg[0], 2) + pow((($p >> 8) & 0xFF) - $bg[1], 2) + pow(($p & 0xFF) - $bg[2], 2));
            if ($d > 28) { if ($scaled) imagedestroy($src); return null; }
        }
    }

    $x0 = $w; $y0 = $h; $x1 = -1; $y1 = -1; $ink = 0;
    for ($y = 0; $y < $h; $y++) {
        for ($x = 0; $x < $w; $x++) {
            $p = imagecolorat($src, $x, $y);
            if ((($p >> 24) & 0x7F) > 96) continue;              // transparent is never artwork
            if ($bg !== null) {
                $d = sqrt(pow((($p >> 16) & 0xFF) - $bg[0], 2) + pow((($p >> 8) & 0xFF) - $bg[1], 2) + pow(($p & 0xFF) - $bg[2], 2));
                if ($d <= 40) continue;
            }
            $ink++;
            if ($x < $x0) $x0 = $x;
            if ($x > $x1) $x1 = $x;
            if ($y < $y0) $y0 = $y;
            if ($y > $y1) $y1 = $y;
        }
    }
    if ($scaled) imagedestroy($src);

    // Nothing found, or so little that the box is noise rather than a mark:
    // scaling a stray anti-aliased pixel up to fill the plate would be worse
    // than leaving the icon alone.
    if ($x1 < $x0 || $y1 < $y0) return null;
    if ($ink < ($w * $h) * 0.003) return null;
    if (($x1 - $x0 + 1) < $w * 0.06 || ($y1 - $y0 + 1) < $h * 0.06) return null;

    return [
        (int)round($x0 * 1000 / $w),
        (int)round($y0 * 1000 / $h),
        (int)round(($x1 + 1) * 1000 / $w),
        (int)round(($y1 + 1) * 1000 / $h),
    ];
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
