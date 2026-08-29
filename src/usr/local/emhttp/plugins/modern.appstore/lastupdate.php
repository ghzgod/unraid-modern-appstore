<?php
/**
 * Unraid Modern App Store: last-update resolver.
 *
 * Community Applications shows "Last Update: Unknown" for roughly 1,164 of the
 * 4,251 apps in its catalog. Its feed only ever recorded a DockerHub push
 * time, and CA's own fallback (getLastUpdate in its exec.php) keeps retrying
 * DockerHub even for images that live on ghcr.io, lscr.io or quay.io instead,
 * so those stay Unknown forever. This endpoint resolves the real date from
 * whichever registry actually hosts the image: DockerHub's own repository API
 * when the image is DockerHub's, otherwise the same anonymous OCI
 * distribution flow every registry implements (ping for a bearer challenge,
 * trade it for a token, walk a multi-platform manifest down to the amd64/
 * linux config digest, read "created" off that blob).
 *
 * READ-ONLY with respect to everything the plugin and CA own. The only thing
 * this writes is its own cache under /tmp, which is why that cache is not
 * filed alongside apps.json in the plugin's data directory: nothing here may
 * ever reach the flash drive.
 *
 * GET lastupdate.php?repo=<image ref>, e.g. ghcr.io/raydak-labs/configarr:latest
 * -> {"ts": <unix int, 0 if unresolved>, "src": "hub"|"registry"|"", "cached": <bool>}
 */
header('Content-Type: application/json');

// This endpoint is a live web request, not a cron job: a stray warning with
// display_errors on would land inside the JSON body and break the drawer's
// parse. Every registry this file talks to is a fetch of the moment (it may
// not exist, may not answer, may answer with a shape nobody promised), so the
// real defense is the isset()/is_array() checks throughout; this just keeps
// the noise out of stdout and lets the server's own error log see it instead.
error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE);
ini_set('display_errors', '0');

const UA = 'unraid-modern-appstore';
const REPO_RE = '/^[A-Za-z0-9][A-Za-z0-9._\-\/:]{0,199}$/';
const DOCKERHUB_HOSTS = ['registry-1.docker.io', 'docker.io', 'index.docker.io', 'registry.hub.docker.com'];
const CACHE_DIR = '/tmp/modern.appstore';
const CACHE_FILE = CACHE_DIR . '/registry_dates.json';
const CACHE_MAX = 4000;
const TTL_HIT = 86400;   // a resolved date does not change; a day between refetches is plenty
const TTL_MISS = 21600;  // an unresolved image is retried sooner, in case the registry was only briefly down

/**
 * One curl call, used for every registry request in this file. Short
 * timeouts matter here specifically: this fires synchronously while the
 * drawer is open, so a slow or dead registry must fail fast rather than hang
 * the page. $followRedirects stays off everywhere except the blob fetch,
 * since only that call is routinely handed off to a CDN.
 */
function http_call(string $url, array $headers, bool $followRedirects): array {
    $ch = curl_init($url);
    if ($ch === false) return ['code' => 0, 'body' => '', 'headers' => []];
    $respHeaders = [];
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_TIMEOUT        => 8,
        CURLOPT_USERAGENT      => UA,
        CURLOPT_FOLLOWLOCATION => $followRedirects,
        CURLOPT_MAXREDIRS      => 5,
        // the blob fetch is handed off to a CDN by Location, and the target of
        // that hop is chosen by the registry rather than by this file, so the
        // schemes it may follow are pinned rather than left at curl's defaults
        CURLOPT_PROTOCOLS       => CURLPROTO_HTTPS | CURLPROTO_HTTP,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
        CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$respHeaders) {
            $p = explode(':', $line, 2);
            if (count($p) === 2) $respHeaders[strtolower(trim($p[0]))] = trim($p[1]);
            return strlen($line);
        },
    ]);
    $body = @curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['code' => $code, 'body' => $body === false ? '' : $body, 'headers' => $respHeaders];
}

/**
 * Splits an image reference the same way every registry client does: a tag is
 * only the text after the LAST colon, and only when that text has no slash in
 * it (a slash there means the colon belongs to a registry port, as in
 * host:5000/name, not a tag). The first path segment is the registry host
 * only when it looks like one (a dot, a colon, or literally "localhost");
 * otherwise DockerHub is implied, and a single bare name is really an
 * official image under the library/ namespace.
 */
function parse_reference(string $repo): array {
    $tag = 'latest';
    $ref = $repo;
    $lastColon = strrpos($ref, ':');
    if ($lastColon !== false) {
        $after = substr($ref, $lastColon + 1);
        if (strpos($after, '/') === false) {
            $tag = $after;
            $ref = substr($ref, 0, $lastColon);
        }
    }

    $slash = strpos($ref, '/');
    $firstSegment = $slash === false ? $ref : substr($ref, 0, $slash);
    $looksLikeHost = strpos($firstSegment, '.') !== false || strpos($firstSegment, ':') !== false
        || $firstSegment === 'localhost';

    if ($looksLikeHost) {
        $host = $firstSegment;
        $path = $slash === false ? '' : substr($ref, $slash + 1);
    } else {
        $host = 'registry-1.docker.io';
        $path = $ref;
        if (strpos($path, '/') === false) $path = 'library/' . $path;
    }

    return ['host' => $host, 'path' => $path, 'tag' => $tag];
}

/**
 * A registry host has to be a public name. The reference this endpoint is
 * handed always comes out of CA's feed, where it is a published image on a
 * public registry, so nothing legitimate is turned away here. What it does
 * rule out is an image reference crafted to point the server at itself or at
 * something else on the LAN: a bare IP literal, localhost, a name with no dot
 * in it, or an explicit port. The endpoint is behind Unraid's own login, so
 * this is not the only thing standing in the way, but a request that reaches
 * out to an arbitrary address should not be one query parameter away either.
 */
function host_is_public(string $host): bool {
    if ($host === '' || strpos($host, ':') !== false) return false;
    if (strcasecmp($host, 'localhost') === 0) return false;
    if (strpos($host, '.') === false) return false;
    return filter_var($host, FILTER_VALIDATE_IP) === false;
}

// Parses `Bearer realm="...",service="..."` out of a WWW-Authenticate value.
// Anything not starting with Bearer, or missing a realm, means this file has
// no way to authenticate against that registry, so the caller falls back to
// treating it as a network failure rather than guessing at a token endpoint.
function parse_www_authenticate(string $header): ?array {
    if (stripos($header, 'Bearer') !== 0) return null;
    preg_match_all('/(\w+)="([^"]*)"/', $header, $m, PREG_SET_ORDER);
    $out = [];
    foreach ($m as $pair) $out[$pair[1]] = $pair[2];
    return isset($out['realm']) ? $out : null;
}

/**
 * Anonymous pull token for one repository path. A 200 with no challenge
 * means the registry is open (ghcr.io behaves this way for public images on
 * some paths), so the empty string stands for "no Authorization header
 * needed" and is a valid success value, distinct from a real failure.
 */
function get_bearer_token(string $host, string $path): array {
    $ping = http_call("https://$host/v2/", [], false);
    $challenge = $ping['headers']['www-authenticate'] ?? '';
    if ($ping['code'] === 200 && $challenge === '') {
        return ['ok' => true, 'token' => ''];
    }
    $auth = $challenge !== '' ? parse_www_authenticate($challenge) : null;
    if ($auth === null) return ['ok' => false, 'token' => ''];

    $scope = 'repository:' . $path . ':pull';
    $tokenUrl = $auth['realm'] . '?' . http_build_query(['service' => $auth['service'] ?? '', 'scope' => $scope]);
    $resp = http_call($tokenUrl, [], false);
    if ($resp['code'] !== 200) return ['ok' => false, 'token' => ''];
    $j = json_decode($resp['body'], true);
    $token = $j['token'] ?? $j['access_token'] ?? null;
    return is_string($token) && $token !== '' ? ['ok' => true, 'token' => $token] : ['ok' => false, 'token' => ''];
}

// Requests every manifest media type this file knows how to read at once,
// since a registry answers with whichever one the tag or digest actually is
// (a multi-platform index and a single-platform image manifest look nothing
// alike) and there is no way to know which in advance without asking first.
function fetch_manifest(string $host, string $path, string $ref, string $token): ?array {
    $accept = 'application/vnd.oci.image.index.v1+json, '
        . 'application/vnd.docker.distribution.manifest.list.v2+json, '
        . 'application/vnd.oci.image.manifest.v1+json, '
        . 'application/vnd.docker.distribution.manifest.v2+json';
    $headers = ['Accept: ' . $accept];
    if ($token !== '') $headers[] = 'Authorization: Bearer ' . $token;
    $resp = http_call("https://$host/v2/$path/manifests/$ref", $headers, false);
    if ($resp['code'] !== 200) return null;
    $j = json_decode($resp['body'], true);
    return is_array($j) ? $j : null;
}

// linux/amd64 is what Unraid actually runs; the second pass is only for the
// odd image that ships a single non-multi-arch entry under an unexpected
// platform label, and the final fallback keeps this from ever returning
// nothing just because the labels are missing entirely.
function pick_platform_manifest(array $manifests): ?array {
    foreach ($manifests as $m) {
        $p = $m['platform'] ?? [];
        if (($p['os'] ?? '') === 'linux' && ($p['architecture'] ?? '') === 'amd64') return $m;
    }
    foreach ($manifests as $m) {
        $arch = $m['platform']['architecture'] ?? '';
        if ($arch !== '' && $arch !== 'unknown') return $m;
    }
    return $manifests[0] ?? null;
}

/**
 * DockerHub's repository API in one call, against four for the OCI walk below.
 * The date it returns belongs to the REPOSITORY rather than to a tag, so this
 * is only ever used for :latest, where the two are the same thing on all but a
 * handful of images. An app pinned to any other tag goes the long way round
 * instead: answering "when did :1.2.3 last change" with the repository's most
 * recent push is the exact mistake that made CA suppress the row in the first
 * place, and a wrong date is worse here than four requests.
 */
function resolve_dockerhub_api(string $path): int {
    $resp = http_call('https://hub.docker.com/v2/repositories/' . $path, [], false);
    if ($resp['code'] !== 200) return 0;
    $j = json_decode($resp['body'], true);
    $updated = $j['last_updated'] ?? null;
    if (!is_string($updated)) return 0;
    $ts = strtotime($updated);
    return $ts === false ? 0 : $ts;
}

/**
 * The generic anonymous OCI flow: token, top manifest, descend into the
 * chosen platform if the top one was a multi-arch index, then read the
 * config blob's "created" field. Works identically for ghcr.io, lscr.io,
 * quay.io and DockerHub, since all of them speak the same distribution spec.
 */
function resolve_registry_generic(string $host, string $path, string $tag): array {
    $auth = get_bearer_token($host, $path);
    if (!$auth['ok']) return ['ts' => 0, 'src' => ''];
    $token = $auth['token'];

    $doc = fetch_manifest($host, $path, $tag, $token);
    if ($doc === null) return ['ts' => 0, 'src' => ''];

    if (isset($doc['manifests']) && is_array($doc['manifests'])) {
        $picked = pick_platform_manifest($doc['manifests']);
        $digest = $picked['digest'] ?? '';
        if (!is_string($digest) || $digest === '') return ['ts' => 0, 'src' => ''];
        $doc = fetch_manifest($host, $path, $digest, $token);
        if ($doc === null) return ['ts' => 0, 'src' => ''];
    }

    $digest = $doc['config']['digest'] ?? '';
    if (!is_string($digest) || $digest === '') return ['ts' => 0, 'src' => ''];

    $headers = [];
    if ($token !== '') $headers[] = 'Authorization: Bearer ' . $token;
    // The one call in this whole flow that follows redirects: config blobs
    // are routinely handed off to a CDN, and the bearer token travels with
    // the redirect since the CDN targets seen in practice ignore it rather
    // than reject it.
    $blob = http_call("https://$host/v2/$path/blobs/$digest", $headers, true);
    if ($blob['code'] !== 200) return ['ts' => 0, 'src' => ''];
    $j = json_decode($blob['body'], true);
    $created = $j['created'] ?? null;
    if (!is_string($created)) return ['ts' => 0, 'src' => ''];
    $ts = strtotime($created);
    return $ts === false ? ['ts' => 0, 'src' => ''] : ['ts' => $ts, 'src' => 'registry'];
}

function cache_load(): array {
    $raw = @file_get_contents(CACHE_FILE);
    if ($raw === false || $raw === '') return [];
    $j = json_decode($raw, true);
    return is_array($j) ? $j : [];
}

/**
 * Re-reads the file under lock rather than trusting whatever cache_load()
 * saw at the top of this request, since a second drawer-open racing this one
 * may have written its own entry in the meantime; a blind overwrite here
 * would throw that entry away. Prunes by age only when the map has actually
 * grown past the cap, so a normal-sized cache never pays the sort cost.
 */
function cache_save(string $key, int $ts): void {
    if (!is_dir(CACHE_DIR)) @mkdir(CACHE_DIR, 0755, true);
    $fh = @fopen(CACHE_FILE, 'c+');
    if ($fh === false) return;
    if (!flock($fh, LOCK_EX)) { fclose($fh); return; }

    $raw = stream_get_contents($fh);
    $map = json_decode((string)$raw, true);
    if (!is_array($map)) $map = [];
    $map[$key] = ['ts' => $ts, 'at' => time()];

    if (count($map) > CACHE_MAX) {
        uasort($map, function ($a, $b) { return ($a['at'] ?? 0) <=> ($b['at'] ?? 0); });
        $map = array_slice($map, (int)(count($map) / 2), null, true);
    }

    rewind($fh);
    ftruncate($fh, 0);
    fwrite($fh, json_encode($map, JSON_UNESCAPED_SLASHES));
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
}

function respond(int $ts, string $src, bool $cached): void {
    echo json_encode(['ts' => $ts, 'src' => $src, 'cached' => $cached]);
    exit;
}

// ---- request handling -------------------------------------------------------
$repo = isset($_GET['repo']) ? (string)$_GET['repo'] : '';

// The only untrusted input in this file, and it becomes part of an outbound
// URL a few lines below, so it is checked before the cache is even opened.
if (!preg_match(REPO_RE, $repo)) respond(0, '', false);

$key = strtolower($repo);
$cache = cache_load();
$hit = $cache[$key] ?? null;
if (is_array($hit)) {
    $cachedTs = (int)($hit['ts'] ?? 0);
    $ttl = $cachedTs > 0 ? TTL_HIT : TTL_MISS;
    if (time() - (int)($hit['at'] ?? 0) < $ttl) respond($cachedTs, '', true);
}

// Everything past this point is a live network round trip against a registry
// this file does not control; any of it can fail in a way PHP itself did not
// anticipate; the answer is always ts 0, never a warning leaking into stdout.
$ts = 0;
$src = '';
try {
    $ref = parse_reference($repo);
    if (!host_is_public($ref['host'])) respond(0, '', false);

    if (in_array($ref['host'], DOCKERHUB_HOSTS, true) && strtolower($ref['tag']) === 'latest') {
        $ts = resolve_dockerhub_api($ref['path']);
        if ($ts > 0) $src = 'hub';
    }

    if ($ts === 0) {
        $host = in_array($ref['host'], DOCKERHUB_HOSTS, true) ? 'registry-1.docker.io' : $ref['host'];
        $result = resolve_registry_generic($host, $ref['path'], $ref['tag']);
        $ts = $result['ts'];
        $src = $result['src'];
    }
} catch (Throwable $e) {
    $ts = 0;
    $src = '';
}

cache_save($key, $ts);
respond($ts, $src, false);
