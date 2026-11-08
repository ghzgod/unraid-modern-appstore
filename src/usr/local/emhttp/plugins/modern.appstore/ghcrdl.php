<?php
/**
 * Unraid Modern App Store: download count for an image on GitHub's container
 * registry.
 *
 * Community Applications only counts Docker Hub pulls, so 1,273 of the 1,649
 * ghcr.io apps in its feed carry no download figure at all and their cards
 * read N/A. GitHub publishes the figure on the package's own public page
 * ("Total downloads", exact value in the title attribute), and
 * github.com/users/<owner>/packages/container/package/<name> reaches that page
 * for user and organisation owners alike. There is no anonymous API for it.
 *
 * READ-ONLY with respect to everything the plugin and CA own. The only thing
 * written is this endpoint's own cache under /tmp, which never reaches flash.
 *
 * GET ghcrdl.php?repo=ghcr.io/<owner>/<name>[:tag]
 * -> {"n": <int, or null when unresolved>, "cached": <bool>}
 */
header('Content-Type: application/json');
error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE);
ini_set('display_errors', '0');

const CACHE_DIR  = '/tmp/modern.appstore';
const CACHE_FILE = CACHE_DIR . '/ghcr_downloads.json';
const CACHE_MAX  = 4000;
const TTL_HIT    = 86400;   // a running total; once a day is plenty
const TTL_MISS   = 21600;   // a page that did not answer is retried sooner

function respond($n, bool $cached): void {
    echo json_encode(['n' => $n, 'cached' => $cached]);
    exit;
}

// The only untrusted input, and it becomes part of an outbound URL, so the
// host is fixed and the owner and name are held to GitHub's own character
// sets before anything is fetched.
$repo = strtolower(trim((string)($_GET['repo'] ?? '')));
$repo = preg_replace('~:[^/]*$~', '', $repo);
if (!preg_match('~^ghcr\.io/([a-z0-9](?:[a-z0-9-]{0,38}))/([a-z0-9][a-z0-9._/-]{0,199})$~', $repo, $m)) respond(null, false);
$owner = $m[1];
$name  = $m[2];

$map = json_decode((string)@file_get_contents(CACHE_FILE), true);
if (!is_array($map)) $map = [];
if (isset($map[$repo])) {
    $e = $map[$repo];
    $ttl = ($e['n'] ?? null) === null ? TTL_MISS : TTL_HIT;
    if (time() - (int)($e['at'] ?? 0) < $ttl) respond($e['n'] ?? null, true);
}

$url = 'https://github.com/users/' . $owner . '/packages/container/package/' . rawurlencode($name);
$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS      => 3,
    CURLOPT_PROTOCOLS      => CURLPROTO_HTTPS,
    CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
    CURLOPT_CONNECTTIMEOUT => 4,
    CURLOPT_TIMEOUT        => 8,
    CURLOPT_USERAGENT      => 'unraid-modern-appstore',
]);
$body = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$host = parse_url((string)curl_getinfo($ch, CURLINFO_EFFECTIVE_URL), PHP_URL_HOST);
curl_close($ch);

$n = null;
if ($body !== false && $code === 200 && $host === 'github.com'
    && preg_match('~Total downloads</span>\s*<h3[^>]*\btitle="(\d+)"~', $body, $mm)) {
    $n = (int)$mm[1];
}

// Re-read under lock so two cards resolving at once do not drop each other's
// entry; pruned by age only once the map outgrows its cap.
if (!is_dir(CACHE_DIR)) @mkdir(CACHE_DIR, 0755, true);
$fh = @fopen(CACHE_FILE, 'c+');
if ($fh !== false && flock($fh, LOCK_EX)) {
    $cur = json_decode((string)stream_get_contents($fh), true);
    if (!is_array($cur)) $cur = [];
    $cur[$repo] = ['n' => $n, 'at' => time()];
    if (count($cur) > CACHE_MAX) {
        uasort($cur, function ($a, $b) { return ($a['at'] ?? 0) <=> ($b['at'] ?? 0); });
        $cur = array_slice($cur, (int)(count($cur) / 2), null, true);
    }
    rewind($fh);
    ftruncate($fh, 0);
    fwrite($fh, json_encode($cur, JSON_UNESCAPED_SLASHES));
    fflush($fh);
    flock($fh, LOCK_UN);
}
if ($fh !== false) fclose($fh);

respond($n, false);
