<?php
/**
 * Checks whether a newer version of this plugin has been published, for the
 * update glyph in the Apps page toolbar and the second line it adds to the
 * About panel.
 *
 * The installed version is read straight out of
 * /boot/config/plugins/modern.appstore.plg, the same version entity
 * about.php already reads for the About panel, sitting at byte offset 121 of
 * a 328,501 byte file. The published version is that same entity in that
 * same file on GitHub, fetched with a "Range: bytes=0-2047" request:
 * raw.githubusercontent.com honours that header and answers with 2,048
 * bytes (HTTP 206), 160 times less than pulling the whole 328KB file down
 * just to read one line near its top.
 *
 * Caching policy: once the cache already says an update is available there
 * is nothing left to learn by asking again, an update is an update whether
 * it is one version old or five, so that answer is served straight back and
 * no request is made at all until the installed version itself changes.
 * That comparison is always against a fresh read of the .plg, never a
 * cached one, so a plugin update picked up between requests is noticed on
 * the very next call without this file having to track it separately. Only
 * while this server is reported up to date does it re-check GitHub at all,
 * and even then no more often than every 6 hours, which is what stops a
 * plugin that is already current from hitting GitHub on every page load.
 *
 * READ-ONLY with respect to everything except its own cache file,
 * /boot/config/plugins/modern.appstore/latest.json. A failed fetch (network
 * down, GitHub unreachable, rate limited) degrades to the installed version
 * with an empty latest and updateAvailable false rather than breaking the
 * response the toolbar and About panel are waiting on, and a failed cache
 * write (flash mounted read only) is swallowed the same way: the request
 * still answers, it just has nothing durable to remember for next time.
 */
header('Content-Type: application/json');

$plg         = '/boot/config/plugins/modern.appstore.plg';
$cache_file  = '/boot/config/plugins/modern.appstore/latest.json';
$remote_url  = 'https://raw.githubusercontent.com/ghzgod/unraid-modern-appstore/main/modern.appstore.plg';
$range_bytes = 2048;
$timeout_sec = 8;
$throttle_sec = 6 * 3600;

// Same regex about.php uses on the same entity, so the two files can never
// disagree about what "the version" means.
function latest_read_version($raw) {
    if (preg_match('/<!ENTITY\s+version\s+"([^"]*)"/', (string)$raw, $m)) return $m[1];
    return '';
}

// Pulls only the first $bytes of $url via a Range request, curl when it is
// available (it always has been so far on Unraid) and a stream context
// otherwise, so a stripped-down PHP build still gets a working check rather
// than a fatal error. Returns the body on HTTP 200 or 206, false on
// anything else, including a timeout, so the caller has one failure path to
// handle instead of two.
function latest_fetch_range($url, $bytes, $timeout_sec) {
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_RANGE          => '0-' . ($bytes - 1),
            CURLOPT_TIMEOUT        => $timeout_sec,
            CURLOPT_CONNECTTIMEOUT => $timeout_sec,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 3,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_USERAGENT      => 'unraid-modern-appstore',
        ]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($body === false || ($code !== 200 && $code !== 206)) return false;
        return $body;
    }

    $opts = [
        'http' => [
            'method'          => 'GET',
            'header'          => "Range: bytes=0-" . ($bytes - 1) . "\r\nUser-Agent: unraid-modern-appstore\r\n",
            'timeout'         => $timeout_sec,
            'follow_location' => 1,
            'ignore_errors'   => true,
        ],
    ];
    $ctx = stream_context_create($opts);
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false) return false;
    // file_get_contents() drops the response headers into this auto-vivified
    // local variable; it is the only way to reach them without a second
    // request, so it is worth the deprecation notice PHP 8.4+ prints for the
    // handful of hosts old enough to be missing curl in the first place.
    $ok = false;
    if (isset($http_response_header) && is_array($http_response_header)) {
        foreach ($http_response_header as $line) {
            if (preg_match('#^HTTP/\S+\s+(200|206)\b#', $line)) { $ok = true; break; }
        }
    }
    return $ok ? $body : false;
}

// Write-temp-then-rename, so a reader never sees a half-written cache file,
// and the whole thing is wrapped in @ because the flash share this lives on
// is sometimes mounted read only; a failed write here must not turn into a
// failed response, it just means next request re-checks instead of reusing.
function latest_write_cache($path, $data) {
    $dir = dirname($path);
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) return false;
    $tmp = $path . '.tmp-' . getmypid();
    $json = json_encode($data, JSON_UNESCAPED_SLASHES);
    if ($json === false) return false;
    if (@file_put_contents($tmp, $json) === false) return false;
    if (!@rename($tmp, $path)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

$installed = '';
$raw = is_file($plg) ? @file_get_contents($plg) : false;
if ($raw !== false && $raw !== '') $installed = latest_read_version($raw);

$cache = null;
if (is_file($cache_file)) {
    $cj = @file_get_contents($cache_file);
    if ($cj !== false && $cj !== '') {
        $decoded = @json_decode($cj, true);
        if (is_array($decoded)) $cache = $decoded;
    }
}

$latest    = ($cache && isset($cache['latest'])) ? (string)$cache['latest'] : '';
$checkedAt = ($cache && isset($cache['checkedAt'])) ? (int)$cache['checkedAt'] : 0;

// The two skip conditions below are the whole caching policy. Versions are
// date strings like 2026.08.23d and 2026.08.29, so a plain strcmp orders
// them correctly: a letter suffix sorts after the bare date it extends, and
// a longer string sorts after its own prefix.
$need_fetch = true;
if ($installed !== '' && $latest !== '' && strcmp($installed, $latest) < 0) {
    // cache already shows this server behind; that fact does not change by
    // asking GitHub again, so nothing is fetched until $installed itself does
    $need_fetch = false;
} elseif ($latest !== '' && $checkedAt > 0 && (time() - $checkedAt) < $throttle_sec) {
    // cache shows current, and it is not yet 6 hours stale; too soon to re-ask
    $need_fetch = false;
}

if ($need_fetch) {
    $body = latest_fetch_range($remote_url, $range_bytes, $timeout_sec);
    $fetched = ($body !== false) ? latest_read_version($body) : '';
    if ($fetched !== '') {
        $latest    = $fetched;
        $checkedAt = time();
        latest_write_cache($cache_file, ['latest' => $latest, 'checkedAt' => $checkedAt]);
    } else {
        // fetch failed, or the 2,048 byte window did not contain the entity
        // (a truncated response, a redirect to something unexpected); fail
        // soft rather than show a stale or guessed answer
        $latest = '';
    }
}

$updateAvailable = ($installed !== '' && $latest !== '' && strcmp($installed, $latest) < 0);

echo json_encode([
    'installed'       => $installed,
    'latest'          => $latest,
    'updateAvailable' => $updateAvailable,
], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
