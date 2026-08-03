<?php
/**
 * Unraid Modern App Store: star fetcher.
 *
 * Reads the Community Applications catalog cache READ-ONLY, derives owner/repo
 * from each app's Project GitHub URL, queries the GitHub API (token +
 * fabricated User-Agent + ETag), and caches results in SQLite. Exports:
 *   - stars.json : compact name->stars map for the badge painter
 *   - apps.json  : full catalog (name, path, icon, author, category, stars,
 *                  downloads, repo age, trend deltas) for the dedicated GitHub view
 * Records a star-history snapshot per run so trending (1d/1w/1m/1y) can be
 * computed over time.
 *
 * The 1d/1w/1m windows come from those daily snapshots. A YEAR window cannot:
 * a fresh install has no year-old snapshot and would never populate one, so the
 * year-ago baseline is walked out of GitHub's stargazer list instead (see
 * backfill_year_baselines) and cached per repo. created_at is recorded too, so
 * the grid can rank by lifetime growth rate.
 *
 * Persistent data (DB + JSON) lives in a configurable appdata dir on the cache
 * SSD so it survives reboots; served copies go to the tmpfs webroot. curl_multi
 * keep-alive for speed; a flock guarantees one scan at a time.
 *
 * NEVER writes to any CA-owned path. NEVER logs the token. The User-Agent names
 * the project only; it carries nothing about the server it runs on.
 */

error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE);

const UA = 'unraid-modern-appstore/1.0 (+https://github.com/ghzgod/unraid-modern-appstore)';
const PLUGIN = 'modern.appstore';

$cfgPath = '/boot/config/plugins/' . PLUGIN . '/' . PLUGIN . '.cfg';

$defaults = [
    'cfg'         => $cfgPath,
    'data-dir'    => '',   // resolved below (cfg DATA_DIR or appdata default)
    'db'          => '',
    'out-dir'     => '/usr/local/emhttp/plugins/' . PLUGIN,
    'ca-cache'    => '/tmp/community.applications/tempFiles/templates_new.json',
    'limit'       => '0',
    'concurrency' => '8',
    'manual'      => '0',  // 1 = invoked by the Refresh button (records manual time)
    'sg-limit'    => '0',  // cap repos for the stargazer-trend backfill (0 = all)
    'new-only'    => '0',  // 1 = only fetch repos not yet in the DB (newly-published apps)
    'only-paths'  => '',   // file of CA template paths, one per line: scan only these apps
    'stale-days'  => '0',  // with --only-paths: skip repos already tried within N days
    'trends-only' => '0',  // 1 = no network: recompute trend deltas from stored star history and rewrite JSON
    'year-limit'  => '400',// max repos to walk for a year-ago star baseline per run (0 = no cap)
];

// ---- arg parsing -----------------------------------------------------------
$opt = $defaults;
for ($i = 1; $i < $argc; $i++) {
    if (substr($argv[$i], 0, 2) === '--') {
        $key = substr($argv[$i], 2);
        if (!array_key_exists($key, $opt)) continue;
        $next = $argv[$i + 1] ?? null;
        if ($next === null || substr($next, 0, 2) === '--') {
            $opt[$key] = '1';          // valueless flag, e.g. "--new-only"
        } else {
            $opt[$key] = $next; $i++;  // "--limit 5"
        }
    }
}
$limit       = (int)$opt['limit'];
$concurrency = max(1, min(16, (int)$opt['concurrency']));
$trendsOnly  = ((int)$opt['trends-only'] === 1);   // recompute trends from history, no GitHub calls

// ---- read cfg early (TOKEN + DATA_DIR) -------------------------------------
$cfg = is_file($opt['cfg']) ? @parse_ini_file($opt['cfg']) : [];
$token = trim($cfg['TOKEN'] ?? '');
$cfgDataDir = trim($cfg['DATA_DIR'] ?? '');

$appdataDefault = '/boot/config/plugins/modern.appstore';
$dataDir = $opt['data-dir'] !== '' ? $opt['data-dir'] : ($cfgDataDir !== '' ? $cfgDataDir : $appdataDefault);
$dataDir = rtrim($dataDir, '/');
$db_path = $opt['db'] !== '' ? $opt['db'] : ($dataDir . '/stars.db');
$outDir  = rtrim($opt['out-dir'], '/');
@mkdir($dataDir, 0755, true);

$status = [
    'ran_at' => time(), 'repos_total' => 0, 'ok' => 0, 'not_modified' => 0,
    'missing' => 0, 'rate_remaining' => null, 'errors' => [],
];

function write_status(array $status, string $outDir, string $dataDir): void {
    $json = json_encode($status, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    @file_put_contents($outDir . '/status.json', $json);
    @file_put_contents($dataDir . '/status.json', $json);
}
function write_progress(string $outDir, bool $running, int $done, int $total, array $status, string $phase = 'stars'): void {
    @file_put_contents($outDir . '/progress.json', json_encode([
        'running' => $running, 'done' => $done, 'total' => $total, 'phase' => $phase,
        'ok' => $status['ok'], 'not_modified' => $status['not_modified'],
        'missing' => $status['missing'], 'errors' => count($status['errors']),
        'updated_at' => time(),
    ], JSON_UNESCAPED_SLASHES));
}

// ---- single-instance lock --------------------------------------------------
$lockFh = @fopen($dataDir . '/fetch.lock', 'c');
if ($lockFh && !flock($lockFh, LOCK_EX | LOCK_NB)) {
    fwrite(STDERR, "fetch_stars: another scan is already running; exiting.\n");
    exit(0);
}
if ((int)$opt['manual'] === 1) {
    @file_put_contents($dataDir . '/last_manual.json', json_encode(['ts' => time()]));
}

// ---- rolling archives of CA's catalog --------------------------------------
// Three snapshots of Community Applications' own template catalog kept in this
// plugin's data directory: one never older than a week, one than a month, one
// than a year. Each is a gzip of CA's templates_new.json exactly as CA wrote it.
//
// That data directory lives on the Unraid flash, which is a USB stick, so this
// is written as seldom as it can be. The due check is a filemtime comparison
// that opens nothing; the 27 MB catalog is only read once a window has actually
// elapsed; it is gzipped (5.5 MB, measured) before it lands; and when two windows
// come due in the same run the bytes are compressed once and reused. Steady
// state is one write a week, one a month, one a year.
const ARCHIVE_WINDOWS = ['weekly' => 604800, 'monthly' => 2592000, 'yearly' => 31536000];

function archive_path(string $dataDir, string $name): string {
    return $dataDir . '/catalog_' . $name . '.json.gz';
}

// Which archives exist and when each was taken, for status.json.
function archive_state(string $dataDir): array {
    $out = [];
    foreach (ARCHIVE_WINDOWS as $name => $window) {
        $ts = @filemtime(archive_path($dataDir, $name));
        $out[$name] = $ts === false ? 0 : $ts;
    }
    return $out;
}

// Returns the names of the archives actually written this run (often none).
function archive_catalogs(string $src, string $dataDir): array {
    $now = time();
    $due = [];
    foreach (ARCHIVE_WINDOWS as $name => $window) {
        $path = archive_path($dataDir, $name);
        $ts = @filemtime($path);
        if ($ts === false || ($now - $ts) >= $window) $due[$name] = $path;
    }
    if (!$due || !is_file($src)) return [];

    $raw = @file_get_contents($src);              // read-only, CA's file is never touched
    if ($raw === false || $raw === '') return [];
    $gz = @gzencode($raw, 6);
    unset($raw);
    if ($gz === false) return [];

    $written = [];
    $len = strlen($gz);
    foreach ($due as $name => $path) {
        // temp file then rename, so an interrupted write cannot leave a
        // truncated archive standing in for a good one
        $tmp = $path . '.tmp';
        if (@file_put_contents($tmp, $gz) === $len && @rename($tmp, $path)) $written[] = $name;
        else @unlink($tmp);
    }
    return $written;
}

$archived = archive_catalogs($opt['ca-cache'], $dataDir);
if ($archived) fwrite(STDERR, 'fetch_stars: archived CA catalog (' . implode(', ', $archived) . ")\n");
$status['archives'] = archive_state($dataDir);

if ($token === '' && !$trendsOnly) {
    $status['errors'][] = 'No GitHub token configured.';
    write_status($status, $outDir, $dataDir);
    write_progress($outDir, false, 0, 0, $status);
    fwrite(STDERR, "fetch_stars: no token; aborting.\n");
    exit(0);
}
if (!is_file($opt['ca-cache'])) {
    $status['errors'][] = 'CA catalog cache not found at ' . $opt['ca-cache'];
    write_status($status, $outDir, $dataDir);
    write_progress($outDir, false, 0, 0, $status);
    exit(0);
}
$apps = @unserialize(file_get_contents($opt['ca-cache']));   // read-only
if (!is_array($apps)) {
    $status['errors'][] = 'Failed to unserialize CA catalog cache.';
    write_status($status, $outDir, $dataDir);
    write_progress($outDir, false, 0, 0, $status);
    exit(0);
}

// ---- derive owner/repo per app ---------------------------------------------
// Only the Project URL is a reliable source for an app's OWN repo. The Support
// URL is a "get help" link that template authors routinely point at an umbrella
// project's issues/discussions page (e.g. every Immich component links to
// github.com/immich-app/immich), which would mis-attribute that project's star
// count to unrelated components (postgres, redis, ...). Derive from Project
// only, and ignore GitHub non-repo paths (issues/discussions/org pages/etc).
//
// CA no longer publishes most Project URLs directly: it hands out opaque
// https://ca.unraid.net/cdn/<blob> redirectors that 302 to the real link. Those
// carry no "github.com" for the regex to find, which is why roughly half the
// catalog had no star count. Those links are resolved once and cached in
// cdn_links.json, so a rescan costs nothing for links already seen.
const CDN_PREFIX = 'https://ca.unraid.net/cdn/';

function is_cdn_link(string $url): bool { return strncmp($url, CDN_PREFIX, strlen(CDN_PREFIX)) === 0; }

// HEAD each link, following redirects, and record where it lands. Failures are
// deliberately NOT cached, so a transient outage retries on the next scan.
function resolve_cdn_links(array $urls, int $concurrency, ?callable $onProgress = null): array {
    $out = [];
    $total = count($urls);
    $done = 0;
    $queue = array_values($urls);
    $mh = curl_multi_init();
    $active = [];
    $spawn = function () use (&$queue, &$active, $mh) {
        if (!$queue) return;
        $url = array_shift($queue);
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_NOBODY         => true,     // HEAD: we only want the destination
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 4,
            CURLOPT_TIMEOUT        => 8,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_USERAGENT      => UA,
            CURLOPT_RETURNTRANSFER => true,
        ]);
        curl_multi_add_handle($mh, $ch);
        $active[(int)$ch] = ['h' => $ch, 'url' => $url];
    };
    for ($i = 0; $i < $concurrency; $i++) $spawn();
    do {
        curl_multi_exec($mh, $running);
        curl_multi_select($mh, 0.5);
        while ($info = curl_multi_info_read($mh)) {
            $ch = $info['handle'];
            $meta = $active[(int)$ch] ?? null;
            if ($meta) {
                $final = (string)curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
                $code  = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
                // Cache on any real response, including a 404 destination: the
                // redirect still told us where the link points, and a dead repo
                // is better recorded than re-resolved on every scan. Only a
                // transport failure (code 0) is left uncached, to retry later.
                if ($final !== '' && $final !== $meta['url'] && $code > 0) $out[$meta['url']] = $final;
                unset($active[(int)$ch]);
            }
            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
            $done++;
            if ($onProgress && $done % 25 === 0) $onProgress($done, $total);
            $spawn();
        }
    } while ($running > 0 || $active || $queue);
    curl_multi_close($mh);
    return $out;
}

// An author line is a person or org, never a URL. CA leaves Author empty for
// most plugins and puts the .plg URL (cdn-wrapped) in Repository, so falling
// back to that printed a link across the card. Prefer the repository owner's
// name, then the GitHub owner, then nothing at all.
// $repoFull is null for every app with no GitHub repository behind it, which is
// most of the catalog, so the parameter has to accept null: a bare "string" type
// makes this a TypeError and kills the run before any JSON is written.
function display_author(array $app, ?string $repoFull = ''): string {
    $repoFull = (string)$repoFull;
    $au = trim((string)($app['Author'] ?? ''));
    if ($au !== '' && !preg_match('~^https?://~i', $au)) return $au;
    $rn = trim((string)($app['RepoName'] ?? $app['Repo'] ?? ''));
    $rn = trim(preg_replace('~[\x27\x{2019}]s Repository$~ui', '', $rn));
    if ($rn !== '' && !preg_match('~^https?://~i', $rn)) return $rn;
    if ($repoFull !== '' && strpos($repoFull, '/') !== false) return explode('/', $repoFull)[0];
    return '';
}

function derive_repo(array $app, array $cdnCache): ?array {
    $url = $app['Project'] ?? '';
    if (!$url) return null;
    if (is_cdn_link($url)) $url = $cdnCache[$url] ?? '';
    if (!$url) return null;
    if (preg_match('~github\.com/([^/]+)/([^/#?\s]+)~i', $url, $m)) {
        $owner = strtolower($m[1]);
        $repo  = preg_replace('~\.git$~', '', $m[2]);
        if (in_array($owner, ['orgs','sponsors','topics','marketplace','features','about','apps'], true)) return null;
        if (in_array(strtolower($repo), ['issues','discussions','wiki','pulls','releases'], true)) return null;
        return ['owner' => $m[1], 'repo' => $repo, 'full' => strtolower($m[1] . '/' . $repo)];
    }
    // GitHub Pages: owner.github.io/repo is that repo's site; owner.github.io on
    // its own is the user-pages repo, which is literally named owner.github.io.
    if (preg_match('~^https?://([^./]+)\.github\.io(?:/([^/#?\s]+))?~i', $url, $m)) {
        $owner = $m[1];
        $repo  = ($m[2] ?? '') !== '' ? $m[2] : ($owner . '.github.io');
        return ['owner' => $owner, 'repo' => $repo, 'full' => strtolower($owner . '/' . $repo)];
    }
    return null;
}

// --only-paths restricts the whole run to the apps the grid is currently
// showing, so browsing fills stars in where they are actually being read
// instead of scanning the entire 3600-app catalog.
$wantedPaths = null;
if (trim($opt['only-paths']) !== '' && is_file($opt['only-paths'])) {
    $wantedPaths = [];
    foreach (file($opt['only-paths'], FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line !== '') $wantedPaths[$line] = 1;
    }
}
function app_wanted(array $app, ?array $wantedPaths): bool {
    if ($wantedPaths === null) return true;
    $p = $app['Path'] ?? '';
    return $p !== '' && isset($wantedPaths[$p]);
}

// resolve every unseen CDN Project link in one batched pass before deriving
$cdnPath  = $dataDir . '/cdn_links.json';
$cdnCache = @json_decode((string)@file_get_contents($cdnPath), true);
if (!is_array($cdnCache)) $cdnCache = [];
$pending = [];
foreach ($apps as $app) {
    if (!is_array($app)) continue;
    if (!app_wanted($app, $wantedPaths)) continue;
    $u = $app['Project'] ?? '';
    if ($u && is_cdn_link($u) && !isset($cdnCache[$u])) $pending[$u] = $u;
}
if ($pending && !$trendsOnly) {
    fwrite(STDERR, 'fetch_stars: resolving ' . count($pending) . " CA cdn links...\n");
    write_progress($outDir, true, 0, count($pending), $status, 'links');
    $resolved = resolve_cdn_links($pending, $concurrency, function ($done, $total) use ($outDir, $status) {
        write_progress($outDir, true, $done, $total, $status, 'links');
    });
    if ($resolved) {
        $cdnCache = $resolved + $cdnCache;
        @file_put_contents($cdnPath, json_encode($cdnCache, JSON_UNESCAPED_SLASHES));
    }
    $status['cdn_resolved'] = count($resolved);
    $status['cdn_pending']  = count($pending) - count($resolved);
}
$status['cdn_cached'] = count($cdnCache);

$repoMeta = [];      // full => ['owner','repo']
$appRepoMap = [];    // app index => full
$wantedRepos = $wantedPaths === null ? null : [];
foreach ($apps as $idx => $app) {
    if (!is_array($app)) continue;
    $d = derive_repo($app, $cdnCache);
    if (!$d) continue;
    $repoMeta[$d['full']] = ['owner' => $d['owner'], 'repo' => $d['repo']];
    $appRepoMap[$idx] = $d['full'];
    // note which repos the requested page needs; the map itself stays whole so
    // the JSON export at the end still covers the entire catalog
    if ($wantedRepos !== null && app_wanted($app, $wantedPaths)) $wantedRepos[$d['full']] = 1;
}
$status['repos_total'] = count($repoMeta);

// ---- SQLite ----------------------------------------------------------------
if (!class_exists('SQLite3')) {
    $status['errors'][] = 'SQLite3 extension unavailable.';
    write_status($status, $outDir, $dataDir);
    exit(1);
}
try { $db = new SQLite3($db_path); $db->busyTimeout(8000); }
catch (Throwable $e) {
    $status['errors'][] = 'SQLite open failed: ' . $e->getMessage();
    write_status($status, $outDir, $dataDir);
    exit(1);
}
$db->exec('CREATE TABLE IF NOT EXISTS repos (
    repo TEXT PRIMARY KEY, owner TEXT, name TEXT,
    stars INTEGER, etag TEXT, http_status INTEGER, fetched_at INTEGER)');
// trend columns persist computed deltas so a --new-only run doesn't wipe them.
// created_at = repo creation (drives the lifetime growth-rate sort); y_base is
// the stargazer-walked star count at y_cut, refreshed every 30 days.
foreach (['t1', 't7', 't30', 't365', 'created_at', 'y_base', 'y_cut', 'y_at'] as $tcol) {
    @$db->exec("ALTER TABLE repos ADD COLUMN $tcol INTEGER");
}
$db->exec('CREATE TABLE IF NOT EXISTS star_history (repo TEXT, ts INTEGER, stars INTEGER)');
$db->exec('CREATE INDEX IF NOT EXISTS idx_hist ON star_history(repo, ts)');

function db_get(SQLite3 $db, string $repo): ?array {
    $s = $db->prepare('SELECT stars, etag, created_at FROM repos WHERE repo = :r');
    $s->bindValue(':r', $repo, SQLITE3_TEXT);
    return $s->execute()->fetchArray(SQLITE3_ASSOC) ?: null;
}
// created_at is COALESCEd rather than assigned: a 304 carries no body, so those
// runs pass null and must not blank a value an earlier 200 already recorded.
function db_upsert(SQLite3 $db, string $repo, string $owner, string $name, ?int $stars, ?string $etag, int $hs, int $ts, ?int $created = null): void {
    $s = $db->prepare('INSERT INTO repos (repo, owner, name, stars, etag, http_status, fetched_at, created_at)
        VALUES (:repo,:owner,:name,:stars,:etag,:hs,:ts,:cr)
        ON CONFLICT(repo) DO UPDATE SET owner=:owner,name=:name,stars=:stars,etag=:etag,http_status=:hs,fetched_at=:ts,
                                        created_at=COALESCE(:cr, created_at)');
    $s->bindValue(':repo', $repo, SQLITE3_TEXT); $s->bindValue(':owner', $owner, SQLITE3_TEXT);
    $s->bindValue(':name', $name, SQLITE3_TEXT);
    $s->bindValue(':stars', $stars, $stars === null ? SQLITE3_NULL : SQLITE3_INTEGER);
    $s->bindValue(':etag', $etag, $etag === null ? SQLITE3_NULL : SQLITE3_TEXT);
    $s->bindValue(':hs', $hs, SQLITE3_INTEGER); $s->bindValue(':ts', $ts, SQLITE3_INTEGER);
    $s->bindValue(':cr', $created, $created === null ? SQLITE3_NULL : SQLITE3_INTEGER);
    $s->execute();
}

// ---- concurrent scan (curl_multi + pooled keep-alive) ----------------------
$starsByRepo = [];
$total = 0; $scanned = 0; $stop = false; $newRepoSet = null;
$queue = array_keys($repoMeta);

// trends-only: no network. Fill stars from the DB (below) and jump to the trend
// recompute + JSON rebuild, so a hot fix to the trend maths takes effect at once.
if (!$trendsOnly) {

// --new-only: limit to repos we have never recorded (newly-published apps).
// This runs on a frequent cron and bypasses the manual-refresh cooldown so new
// app-store repos get their stars within the hour, without re-scanning the rest.
$newOnly = ((int)$opt['new-only'] === 1);
$newRepoSet = null;
if ($newOnly) {
    $existing = [];
    $er = $db->query('SELECT repo FROM repos');
    while ($row = $er->fetchArray(SQLITE3_ASSOC)) $existing[$row['repo']] = 1;
    $queue = array_values(array_filter($queue, function ($k) use ($existing) { return !isset($existing[$k]); }));
    if (empty($queue)) {
        write_progress($outDir, false, 0, 0, $status);
        fwrite(STDERR, "fetch_stars: new-only, no new repos.\n");
        exit(0);
    }
    $newRepoSet = array_flip($queue);
}

// --only-paths: fetch stars for just the apps the grid is showing
if ($wantedRepos !== null) {
    $queue = array_values(array_filter($queue, function ($k) use ($wantedRepos) { return isset($wantedRepos[$k]); }));
}

// --stale-days: drop repos already tried inside the window, whatever the result.
// Keying on fetched_at rather than stars means a 404 is not retried on every
// page view, while a repo with no stars yet (never tried) always qualifies.
$staleDays = (int)$opt['stale-days'];
if ($staleDays > 0) {
    $cut = time() - $staleDays * 86400;
    $recent = [];
    $rr = $db->query('SELECT repo FROM repos WHERE fetched_at > ' . (int)$cut);
    while ($row = $rr->fetchArray(SQLITE3_ASSOC)) $recent[$row['repo']] = 1;
    $queue = array_values(array_filter($queue, function ($k) use ($recent) { return !isset($recent[$k]); }));
}
if ($wantedPaths !== null && empty($queue)) {
    write_progress($outDir, false, 0, 0, $status);
    fwrite(STDERR, "fetch_stars: page scan, nothing due.\n");
    exit(0);
}

if ($limit > 0) $queue = array_slice($queue, 0, $limit);
$total = count($queue);
$stop = false; $scanned = 0;
write_progress($outDir, true, 0, $total, $status);

$mh = curl_multi_init();
$inflight = []; $hdr = [];
$makeHandle = function (string $full) use (&$repoMeta, &$inflight, &$hdr, $mh, $token, $db) {
    $m = $repoMeta[$full]; $row = db_get($db, $full);
    $ch = curl_init('https://api.github.com/repos/' . rawurlencode($m['owner']) . '/' . rawurlencode($m['repo']));
    $h = ['Authorization: Bearer ' . $token, 'User-Agent: ' . UA,
          'Accept: application/vnd.github+json', 'X-GitHub-Api-Version: 2022-11-28'];
    // Skip the ETag for repos whose created_at we don't have yet: a 304 has no
    // body to read it from, so an already-cached repo would never fill it in.
    // Costs one full response per repo, once, then ETags resume.
    if (!empty($row['etag']) && !empty($row['created_at'])) $h[] = 'If-None-Match: ' . $row['etag'];
    $id = spl_object_id($ch); $hdr[$id] = [];
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $h,
        CURLOPT_TIMEOUT => 30, CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 5,
        CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$hdr, $id) {
            $p = explode(':', $line, 2);
            if (count($p) === 2) $hdr[$id][strtolower(trim($p[0]))] = trim($p[1]);
            return strlen($line);
        },
    ]);
    $inflight[$id] = ['full' => $full, 'row' => $row, 'ch' => $ch];
    curl_multi_add_handle($mh, $ch);
};
for ($i = 0; $i < $concurrency && $queue; $i++) $makeHandle(array_shift($queue));

do {
    curl_multi_exec($mh, $running);
    if ($running) curl_multi_select($mh, 1.0);
    while ($done = curl_multi_info_read($mh)) {
        $ch = $done['handle']; $id = spl_object_id($ch);
        $ctx = $inflight[$id] ?? null; unset($inflight[$id]);
        $heads = $hdr[$id] ?? []; unset($hdr[$id]);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $body = curl_multi_getcontent($ch); $err = curl_error($ch);
        curl_multi_remove_handle($mh, $ch); curl_close($ch);
        if (!$ctx) continue;
        $full = $ctx['full']; $row = $ctx['row']; $m = $repoMeta[$full]; $scanned++;
        if (isset($heads['x-ratelimit-remaining'])) $status['rate_remaining'] = (int)$heads['x-ratelimit-remaining'];

        if ($code === 200) {
            $j = json_decode($body, true);
            $stars = (int)(($j['stargazers_count']) ?? 0);
            $created = isset($j['created_at']) ? (strtotime($j['created_at']) ?: null) : null;
            db_upsert($db, $full, $m['owner'], $m['repo'], $stars, $heads['etag'] ?? ($row['etag'] ?? null), 200, time(), $created);
            $starsByRepo[$full] = $stars; $status['ok']++;
        } elseif ($code === 304) {
            $stars = (int)($row['stars'] ?? 0);
            db_upsert($db, $full, $m['owner'], $m['repo'], $stars, $row['etag'] ?? null, 304, time());
            $starsByRepo[$full] = $stars; $status['not_modified']++;
        } elseif ($code === 404 || $code === 451) {
            db_upsert($db, $full, $m['owner'], $m['repo'], null, $row['etag'] ?? null, $code, time());
            $status['missing']++;
        } elseif ($code === 403 || $code === 429) {
            if (!$stop) $status['errors'][] = "Rate limited ($code) after $scanned repos; resuming next run via ETags.";
            $stop = true;
        } else {
            $status['errors'][] = "HTTP $code for $full" . ($err ? " ($err)" : '');
            if (isset($row['stars'])) $starsByRepo[$full] = (int)$row['stars'];
        }
        if ($scanned % 25 === 0) write_progress($outDir, true, $scanned, $total, $status);
        if (!$stop && $queue) $makeHandle(array_shift($queue));
    }
} while ($running || !empty($inflight) || (!$stop && $queue));
foreach ($inflight as $ctx) { @curl_multi_remove_handle($mh, $ctx['ch']); @curl_close($ctx['ch']); }
curl_multi_close($mh);
}   // end if (!$trendsOnly)

// merge in repos not scanned this run (in trends-only mode this loads ALL stars)
$res = $db->query('SELECT repo, stars FROM repos WHERE stars IS NOT NULL');
while ($ar = $res->fetchArray(SQLITE3_ASSOC)) {
    if (!isset($starsByRepo[$ar['repo']])) $starsByRepo[$ar['repo']] = (int)$ar['stars'];
}

// ---- star-history snapshot (~1/day per repo) + trend computation -----------
$now = time();
if (!$trendsOnly) {
$db->exec('BEGIN');
$ins = $db->prepare('INSERT INTO star_history (repo, ts, stars) VALUES (:r,:t,:s)');
$lastQ = $db->prepare('SELECT MAX(ts) AS m FROM star_history WHERE repo = :r');
foreach ($starsByRepo as $repo => $st) {
    $lastQ->reset(); $lastQ->bindValue(':r', $repo, SQLITE3_TEXT);
    $last = (int)($lastQ->execute()->fetchArray(SQLITE3_ASSOC)['m'] ?? 0);
    if ($last < $now - 20 * 3600) {
        $ins->reset();
        $ins->bindValue(':r', $repo, SQLITE3_TEXT);
        $ins->bindValue(':t', $now, SQLITE3_INTEGER);
        $ins->bindValue(':s', (int)$st, SQLITE3_INTEGER);
        $ins->execute();
    }
}
$db->exec('DELETE FROM star_history WHERE ts < ' . ($now - 400 * 86400));
$db->exec('COMMIT');
}   // end if (!$trendsOnly)

$baseQ = $db->prepare('SELECT stars FROM star_history WHERE repo=:r AND ts<=:c ORDER BY ts DESC LIMIT 1');
$oldQ  = $db->prepare('SELECT stars, ts FROM star_history WHERE repo=:r ORDER BY ts ASC LIMIT 1');
function trend_at(SQLite3Stmt $baseQ, string $repo, int $cutoff): ?int {
    $baseQ->reset(); $baseQ->bindValue(':r', $repo, SQLITE3_TEXT); $baseQ->bindValue(':c', $cutoff, SQLITE3_INTEGER);
    $row = $baseQ->execute()->fetchArray(SQLITE3_ASSOC);
    return $row ? (int)$row['stars'] : null;
}
function delta(?int $base, int $cur): ?int { return $base === null ? null : ($cur - $base); }

/*
 * Uncapped trend for a rolling window: current stars minus the snapshot at (or
 * just before) the window's start. If star history is younger than the window
 * but still covers >=60% of it, approximate using the OLDEST snapshot (so a
 * "30-day" trend works off ~25 days of history rather than showing nothing).
 * Only when history is too short to be meaningful do we fall back to $fallback
 * (the stargazer-page count, which saturates at 100 and can't rank hot repos).
 */
function trend_window(SQLite3Stmt $baseQ, SQLite3Stmt $oldQ, string $repo, int $window, int $stars, int $now, ?int $fallback): ?int {
    $base = trend_at($baseQ, $repo, $now - $window);
    if ($base !== null) return $stars - $base;
    $oldQ->reset(); $oldQ->bindValue(':r', $repo, SQLITE3_TEXT);
    $o = $oldQ->execute()->fetchArray(SQLITE3_ASSOC);
    if ($o && ($now - (int)$o['ts']) >= 0.6 * $window) return $stars - (int)$o['stars'];
    return $fallback;
}

/**
 * Does this token have starred_at access?
 *
 * GitHub refuses the stargazers endpoint to FINE-GRAINED tokens (github_pat_*)
 * with a 403 "Resource not accessible by personal access token" that has
 * nothing to do with the rate limit, and GraphQL refuses it the same way. Only
 * a CLASSIC token (ghp_*) can read it, with no scopes needed. Without it the
 * only star timeline available is this plugin's own daily snapshots.
 *
 * One probe request per run settles it, which beats a stored flag (it notices
 * a swapped token immediately) and beats discovering it 2,000 failed requests
 * in. Returns true when starred_at is readable.
 */
function stargazers_readable(array $repoMeta, string $token, array &$status): bool {
    $m = reset($repoMeta);
    if (!$m) return false;
    $ch = curl_init('https://api.github.com/repos/' . rawurlencode($m['owner']) . '/' .
                    rawurlencode($m['repo']) . '/stargazers?per_page=1');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $token, 'User-Agent: ' . UA,
            'Accept: application/vnd.github.star+json', 'X-GitHub-Api-Version: 2022-11-28'],
    ]);
    $body = (string)curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code === 200) return true;
    if ($code === 403 && strpos($body, 'not accessible by personal access token') !== false) {
        $status['stargazers_blocked'] = true;
        $status['errors'][] = 'This GitHub token cannot read star dates, so the "this year" trending windows '
            . 'stay empty until the plugin has recorded a year of its own history. A classic token '
            . '(ghp_...) with no scopes can read them; a fine-grained token (github_pat_...) cannot.';
        return false;
    }
    // anything else (rate limit, transient error) is not a permission verdict:
    // skip the walks this run and try again on the next one
    $status['stargazers_probe'] = $code;
    return false;
}

/**
 * Stargazer-timestamp trend backfill. Fetches each repo's newest stargazer page
 * (per_page=100, the last page) with star+json so every star carries starred_at,
 * then counts stars gained in the last 1d/7d/30d/365d. Repos above ~40k stars
 * exceed GitHub's stargazer pagination cap (~400 pages) so they're skipped here
 * and fall back to the daily snapshots. Returns full => [c1,c7,c30,c365].
 */
function backfill_trends(array $repoMeta, array $starsByRepo, string $token, string $outDir, array &$status, int $sgLimit, ?array $restrict = null): array {
    $now = time();
    $periods = [86400, 7 * 86400, 30 * 86400, 365 * 86400];
    $trends = [];
    $list = [];
    foreach ($starsByRepo as $full => $s) {
        if ($restrict !== null && !isset($restrict[$full])) continue;   // new-only: just the new repos
        if ($s <= 0 || $s > 40000) continue;
        $m = $repoMeta[$full] ?? null; if (!$m) continue;
        $list[] = ['full' => $full, 'owner' => $m['owner'], 'name' => $m['repo'], 'page' => max(1, (int)ceil($s / 100))];
    }
    if ($sgLimit > 0) $list = array_slice($list, 0, $sgLimit);
    $total = count($list); $i = 0; $done = 0; $stop = false; $C = 8;
    if ($total === 0) return $trends;

    $mh = curl_multi_init(); $inflight = [];
    $add = function ($it) use (&$inflight, $mh, $token) {
        $url = 'https://api.github.com/repos/' . rawurlencode($it['owner']) . '/' . rawurlencode($it['name']) .
               '/stargazers?per_page=100&page=' . $it['page'];
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $token, 'User-Agent: ' . UA,
                'Accept: application/vnd.github.star+json', 'X-GitHub-Api-Version: 2022-11-28'],
        ]);
        $inflight[spl_object_id($ch)] = $it['full'];
        curl_multi_add_handle($mh, $ch);
    };
    for (; $i < $C && $i < $total; $i++) $add($list[$i]);
    do {
        curl_multi_exec($mh, $run);
        if ($run) curl_multi_select($mh, 1.0);
        while ($d = curl_multi_info_read($mh)) {
            $ch = $d['handle']; $id = spl_object_id($ch); $full = $inflight[$id] ?? null; unset($inflight[$id]);
            $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); $body = curl_multi_getcontent($ch);
            curl_multi_remove_handle($mh, $ch); curl_close($ch);
            if ($full) {
                $done++;
                if ($code === 200) {
                    $arr = json_decode($body, true); $c = [0, 0, 0, 0];
                    if (is_array($arr)) foreach ($arr as $it) {
                        $t = isset($it['starred_at']) ? strtotime($it['starred_at']) : 0;
                        if ($t) for ($p = 0; $p < 4; $p++) if ($t >= $now - $periods[$p]) $c[$p]++;
                    }
                    $trends[$full] = $c;
                } elseif ($code === 403 || $code === 429) { $stop = true; }
            }
            if (!$stop && $i < $total) { $add($list[$i]); $i++; }
            if ($done % 50 === 0) write_progress($outDir, true, $done, $total, $status);
        }
    } while ($run || !empty($inflight) || (!$stop && $i < $total));
    curl_multi_close($mh);
    if ($stop) $status['errors'][] = 'Stargazer trend backfill hit a rate limit; trends partial this run.';
    return $trends;
}

/**
 * Year-ago star baseline: how many of a repo's stars predate the 365-day window.
 *
 * The daily snapshots cannot answer this. A window only resolves once history
 * reaches back that far, so on any install younger than a year the "this year"
 * sort would rank nothing at all, and backfill_trends' single newest stargazer
 * page saturates at 100, tying every repo that gained more than that.
 *
 * GitHub returns stargazers OLDEST FIRST with starred_at attached, so the split
 * point is found by binary-searching pages for the first one that opens inside
 * the window, then counting across that boundary page. ~log2(pages) requests:
 * a 1,000-star repo costs 4, a 40,000-star repo costs 10, and a repo with 100
 * stars or fewer costs 1. Pages already pulled during the search are reused.
 *
 * Deliberate limits, because they affect how the numbers should be read:
 *   - The list holds CURRENT stargazers only, so a star given two years ago and
 *     since removed is invisible. The baseline is therefore a slight undercount
 *     and the year's gain a slight overcount. It ranks correctly; it is not an
 *     audit.
 *   - GitHub stops paginating stargazers at 400 pages, so repos over 40,000
 *     stars are left to the snapshot path rather than guessed at.
 *   - Repos created inside the window need no request: every star they have is
 *     this year's, so the baseline is 0.
 *
 * Returns full => baseline stars at $cutoff.
 */
function backfill_year_baselines(array $repoMeta, array $starsByRepo, array $rowMeta, string $token,
                                 string $outDir, array &$status, int $cap, ?array $restrict, int $now): array {
    $cutoff = $now - 365 * 86400;
    $out = [];
    $search = [];

    foreach ($starsByRepo as $full => $stars) {
        if ($restrict !== null && !isset($restrict[$full])) continue;
        if (!isset($repoMeta[$full])) continue;
        $meta = $rowMeta[$full] ?? [];
        // a baseline drifts by exactly the time since it was taken; refreshing
        // monthly keeps the window between 365 and ~395 days, close enough to
        // rank by and a large saving over recomputing it every run
        if (!empty($meta['y_at']) && ($now - (int)$meta['y_at']) < 30 * 86400) continue;
        if ($stars <= 0) { $out[$full] = 0; continue; }
        $created = (int)($meta['created_at'] ?? 0);
        if ($created > 0 && $created >= $cutoff) { $out[$full] = 0; continue; }   // free: repo is younger than the window
        if ($stars > 40000) continue;                                            // past GitHub's stargazer pagination cap
        $search[] = ['full' => $full, 'stars' => (int)$stars];
    }
    // biggest repos first: they decide the top of every trending ranking, so a
    // capped run still produces a correct-looking leaderboard
    usort($search, function ($a, $b) { return $b['stars'] - $a['stars']; });
    $deferred = 0;
    if ($cap > 0 && count($search) > $cap) { $deferred = count($search) - $cap; $search = array_slice($search, 0, $cap); }
    $status['year_free'] = count($out);
    if (!$search) {
        if ($deferred) $status['year_deferred'] = $deferred;
        return $out;
    }

    $state = [];
    foreach ($search as $it) {
        $pages = min(400, max(1, (int)ceil($it['stars'] / 100)));
        $state[$it['full']] = ['stars' => $it['stars'], 'pages' => $pages, 'lo' => 1, 'hi' => $pages,
                               'ans' => $pages + 1, 'cache' => [], 'phase' => 'search'];
    }
    $queue = array_keys($state);
    $total = count($queue); $done = 0; $stop = false;

    // fold a fetched page into the repo's search, then say which page it needs
    // next; null means the repo is finished and its baseline is recorded
    $consume = function ($full, $page, $arr) use (&$state, $cutoff) {
        $s = &$state[$full];
        $ts = [];
        if (is_array($arr)) foreach ($arr as $it) {
            $t = isset($it['starred_at']) ? strtotime($it['starred_at']) : 0;
            if ($t) $ts[] = $t;
        }
        $s['cache'][$page] = $ts;
        if ($s['phase'] !== 'search') return;
        if (!$ts) { $s['hi'] = $page - 1; return; }        // short/empty page: the end is below it
        if ($ts[0] >= $cutoff) { $s['ans'] = $page; $s['hi'] = $page - 1; }
        else { $s['lo'] = $page + 1; }
    };
    $advance = function ($full) use (&$state, &$out, $cutoff) {
        $s = &$state[$full];
        if ($s['phase'] === 'search') {
            if ($s['lo'] <= $s['hi']) return (int)(($s['lo'] + $s['hi']) >> 1);
            $s['phase'] = 'count';
        }
        // ans = first page that OPENS inside the window, so the boundary itself
        // lies in the page before it (or in the last page, if none opens inside)
        $q = ($s['ans'] > $s['pages']) ? $s['pages'] : $s['ans'] - 1;
        if ($q <= 0) { $out[$full] = 0; return null; }     // every star is inside the window
        if (!isset($s['cache'][$q])) return $q;
        $c = 0;
        foreach ($s['cache'][$q] as $t) if ($t < $cutoff) $c++;
        $out[$full] = max(0, min($s['stars'], ($q - 1) * 100 + $c));
        return null;
    };

    $mh = curl_multi_init(); $inflight = []; $hdrs = []; $C = 8;
    $add = function ($full, $page) use (&$inflight, &$hdrs, $mh, $token, $repoMeta) {
        $m = $repoMeta[$full];
        $url = 'https://api.github.com/repos/' . rawurlencode($m['owner']) . '/' . rawurlencode($m['repo']) .
               '/stargazers?per_page=100&page=' . $page;
        $ch = curl_init($url);
        $id = spl_object_id($ch); $hdrs[$id] = [];
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30, CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $token, 'User-Agent: ' . UA,
                'Accept: application/vnd.github.star+json', 'X-GitHub-Api-Version: 2022-11-28'],
            CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$hdrs, $id) {
                $p = explode(':', $line, 2);
                if (count($p) === 2) $hdrs[$id][strtolower(trim($p[0]))] = trim($p[1]);
                return strlen($line);
            },
        ]);
        $inflight[$id] = ['full' => $full, 'page' => $page];
        curl_multi_add_handle($mh, $ch);
    };
    // kick a repo off, or drop it if it somehow needs nothing
    $startNext = function () use (&$queue, &$state, $advance, $add, &$done) {
        while ($queue) {
            $full = array_shift($queue);
            $p = $advance($full);
            if ($p === null) { $done++; continue; }   // resolved without a request
            $add($full, $p);
            return true;
        }
        return false;
    };
    for ($i = 0; $i < $C; $i++) if (!$startNext()) break;

    do {
        curl_multi_exec($mh, $run);
        if ($run) curl_multi_select($mh, 1.0);
        while ($d = curl_multi_info_read($mh)) {
            $ch = $d['handle']; $id = spl_object_id($ch);
            $ctx = $inflight[$id] ?? null; unset($inflight[$id]);
            $heads = $hdrs[$id] ?? []; unset($hdrs[$id]);
            $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $body = curl_multi_getcontent($ch);
            curl_multi_remove_handle($mh, $ch); curl_close($ch);
            if (!$ctx) continue;
            $full = $ctx['full'];
            if (isset($heads['x-ratelimit-remaining'])) {
                $status['rate_remaining'] = (int)$heads['x-ratelimit-remaining'];
                // leave headroom for the next star scan rather than draining the
                // hour here; whatever is left is picked up on the following run
                if ((int)$heads['x-ratelimit-remaining'] < 200) $stop = true;
            }
            if ($code === 403 || $code === 429) { $stop = true; $done++; continue; }
            if ($code !== 200) { $done++; if (!$stop) $startNext(); continue; }   // give up on this repo, not the run

            $consume($full, $ctx['page'], json_decode($body, true));
            $next = $advance($full);
            if ($next !== null && !$stop) { $add($full, $next); continue; }
            $done++;
            if ($done % 25 === 0) write_progress($outDir, true, $done, $total, $status, 'year');
            if (!$stop) $startNext();
        }
    } while ($run || !empty($inflight));
    curl_multi_close($mh);

    if ($stop) $status['errors'][] = 'Year-baseline walk stopped early on the GitHub rate limit; the rest resumes next run.';
    if ($deferred) $status['year_deferred'] = $deferred;
    $status['year_walked'] = count($out) - (int)($status['year_free'] ?? 0);
    return $out;
}

// Existing repo rows: created_at drives the free skips above, y_at the refresh
// window, and the snapshot floor decides who still needs the capped stargazer
// fallback for the SHORT windows.
$rowMeta = [];
$rm = $db->query('SELECT repo, created_at, y_base, y_cut, y_at FROM repos');
while ($r = $rm->fetchArray(SQLITE3_ASSOC)) {
    $rowMeta[$r['repo']] = ['created_at' => (int)$r['created_at'], 'y_at' => (int)$r['y_at']];
}

// backfill_trends answers the 1d/1w/1m windows for repos the snapshot history
// cannot yet cover. Once a repo has a snapshot older than a day the snapshots
// win outright, so re-walking the whole catalog every run bought nothing and
// cost a request per repo; restrict it to repos that genuinely lack a baseline.
$sgNeed = [];
if (!$trendsOnly) {
    $histFloor = $now - 86400;
    $seen = [];
    $hq = $db->query('SELECT repo, MIN(ts) AS m FROM star_history GROUP BY repo');
    while ($r = $hq->fetchArray(SQLITE3_ASSOC)) $seen[$r['repo']] = (int)$r['m'];
    foreach ($starsByRepo as $full => $_) {
        if (!isset($seen[$full]) || $seen[$full] > $histFloor) $sgNeed[$full] = 1;
    }
    if ($newRepoSet !== null) $sgNeed = array_intersect_key($sgNeed, $newRepoSet);
    if ($wantedRepos !== null) $sgNeed = array_intersect_key($sgNeed, $wantedRepos);
}
// Both backfills below read starred_at, so a token that cannot see it makes
// every one of their requests a guaranteed 403. Settle that with one probe.
$sgOk = (!$trendsOnly && $token !== '') ? stargazers_readable($repoMeta, $token, $status) : false;

$sgTrends = ($trendsOnly || !$sgOk || !$sgNeed) ? []
    : backfill_trends($repoMeta, $starsByRepo, $token, $outDir, $status, (int)$opt['sg-limit'], $sgNeed);

// Year-ago baselines. On a page scan this is limited to the apps on screen, so
// browsing fills the year window in exactly the way browsing fills stars in.
$yearNew = ($trendsOnly || !$sgOk) ? []
    : backfill_year_baselines($repoMeta, $starsByRepo, $rowMeta, $token, $outDir, $status,
                              (int)$opt['year-limit'], $wantedRepos, $now);
if ($yearNew) {
    $yu = $db->prepare('UPDATE repos SET y_base=:b, y_cut=:c, y_at=:a WHERE repo=:r');
    $db->exec('BEGIN');
    foreach ($yearNew as $full => $b) {
        $yu->reset();
        $yu->bindValue(':b', (int)$b, SQLITE3_INTEGER);
        $yu->bindValue(':c', $now - 365 * 86400, SQLITE3_INTEGER);
        $yu->bindValue(':a', $now, SQLITE3_INTEGER);
        $yu->bindValue(':r', $full, SQLITE3_TEXT);
        $yu->execute();
    }
    $db->exec('COMMIT');
}
// every stored baseline, including repos untouched this run
$yBase = [];
$yq = $db->query('SELECT repo, y_base FROM repos WHERE y_base IS NOT NULL');
while ($r = $yq->fetchArray(SQLITE3_ASSOC)) $yBase[$r['repo']] = (int)$r['y_base'];

// repo creation dates, for the lifetime growth-rate sort
$createdAt = [];
$cq = $db->query('SELECT repo, created_at FROM repos WHERE created_at IS NOT NULL');
while ($r = $cq->fetchArray(SQLITE3_ASSOC)) $createdAt[$r['repo']] = (int)$r['created_at'];

// persist freshly-computed trends so a later --new-only run keeps them
if ($sgTrends) {
    $tu = $db->prepare('UPDATE repos SET t1=:a,t7=:b,t30=:c,t365=:d WHERE repo=:r');
    $db->exec('BEGIN');
    foreach ($sgTrends as $full => $c) {
        $tu->reset();
        $tu->bindValue(':a', $c[0], SQLITE3_INTEGER); $tu->bindValue(':b', $c[1], SQLITE3_INTEGER);
        $tu->bindValue(':c', $c[2], SQLITE3_INTEGER); $tu->bindValue(':d', $c[3], SQLITE3_INTEGER);
        $tu->bindValue(':r', $full, SQLITE3_TEXT);
        $tu->execute();
    }
    $db->exec('COMMIT');
}
// read all stored trends (existing repos preserved + the ones we just refreshed)
$dbTrends = [];
$trq = $db->query('SELECT repo, t1, t7, t30, t365 FROM repos WHERE t7 IS NOT NULL');
while ($row = $trq->fetchArray(SQLITE3_ASSOC)) {
    $dbTrends[$row['repo']] = [(int)$row['t1'], (int)$row['t7'], (int)$row['t30'], (int)$row['t365']];
}

// ---- build outputs ---------------------------------------------------------
$byId = $byName = $byRepo = $byPath = [];
$catalog = [];   // for apps.json
foreach ($apps as $idx => $app) {
    if (!is_array($app)) continue;
    $name = $app['Name'] ?? '';
    if ($name === '') continue;
    $full  = $appRepoMap[$idx] ?? null;
    $stars = ($full !== null && isset($starsByRepo[$full])) ? (int)$starsByRepo[$full] : null;

    if ($stars !== null) {
        $byRepo[$full] = $stars;
        if (isset($app['ID'])) $byId[(string)$app['ID']] = $stars;
        $byName[strtolower(trim($name))] = $stars;                 // last-wins (not unique)
        if (!empty($app['Path'])) $byPath[$app['Path']] = $stars;  // unique per template
    }

    $t1 = $t7 = $t30 = $t365 = null;
    $created = null;
    if ($stars !== null && $full !== null) {
        // Prefer uncapped snapshot deltas; the stored stargazer-page counts
        // saturate at 100 and can't rank fast-growing repos, so they're only a
        // last-resort fallback for windows longer than our star history.
        $fb = $dbTrends[$full] ?? [null, null, null, null];
        $t1   = trend_window($baseQ, $oldQ, $full, 86400,       $stars, $now, $fb[0]);
        $t7   = trend_window($baseQ, $oldQ, $full, 7 * 86400,   $stars, $now, $fb[1]);
        $t30  = trend_window($baseQ, $oldQ, $full, 30 * 86400,  $stars, $now, $fb[2]);
        // Year window, best source first: a genuine year-old snapshot if this
        // install has run that long, else the stargazer-walked baseline, else
        // the capped fallback. The walk is what makes "this year" work at all
        // on an install younger than a year.
        $snap365 = trend_at($baseQ, $full, $now - 365 * 86400);
        if ($snap365 !== null)             $t365 = $stars - $snap365;
        elseif (isset($yBase[$full]))      $t365 = max(0, $stars - $yBase[$full]);
        else                               $t365 = trend_window($baseQ, $oldQ, $full, 365 * 86400, $stars, $now, $fb[3]);
        $created = $createdAt[$full] ?? null;
    }

    $desc = (string)($app['Overview'] ?? '');
    $desc = preg_replace('/\[[^\]]{1,40}\]/', ' ', $desc);   // strip BBCode ([br], [b], [/b], …)
    $desc = trim(preg_replace('/\s+/', ' ', strip_tags($desc)));
    if (function_exists('mb_substr')) { if (mb_strlen($desc) > 240) $desc = mb_substr($desc, 0, 237) . '…'; }
    else { if (strlen($desc) > 240) $desc = substr($desc, 0, 237) . '…'; }
    $cat = is_array($app['Category'] ?? null) ? implode(' ', $app['Category']) : ($app['Category'] ?? '');
    $cat = trim(str_replace(':', ' ', explode(' ', trim($cat))[0] ?? ''));   // first category, no colons

    $catalog[] = [
        'n'  => $name,
        'p'  => $app['Path'] ?? '',
        'ic' => $app['Icon'] ?? '',
        'au' => display_author($app, $full),
        'ct' => $cat,
        'de' => $desc,
        'pr' => $app['Project'] ?? '',
        'su' => $app['Support'] ?? '',
        'rp' => $full,
        's'  => $stars,
        'dl' => (int)($app['downloads'] ?? 0),
        'ca' => $created,   // repo creation, unix ts (lifetime growth-rate sort)
        't1' => $t1, 't7' => $t7, 't30' => $t30, 't365' => $t365,
    ];
}

$starsJson = json_encode(['generated' => $now, 'byId' => $byId, 'byName' => $byName, 'byRepo' => $byRepo, 'byPath' => $byPath], JSON_UNESCAPED_SLASHES);
$appsJson  = json_encode(['generated' => $now, 'apps' => $catalog], JSON_UNESCAPED_SLASHES);
foreach ([$outDir, $dataDir] as $d) {
    @file_put_contents($d . '/stars.json', $starsJson);
    @file_put_contents($d . '/apps.json', $appsJson);
}

write_status($status, $outDir, $dataDir);
write_progress($outDir, false, $scanned, $total, $status);

fwrite(STDERR, sprintf("fetch_stars: repos=%d ok=%d notmod=%d missing=%d rate=%s errors=%d apps=%d sgTrends=%d year=%d(free=%d,left=%d)\n",
    $status['repos_total'], $status['ok'], $status['not_modified'], $status['missing'],
    var_export($status['rate_remaining'], true), count($status['errors']), count($catalog), count($sgTrends),
    count($yearNew), (int)($status['year_free'] ?? 0), (int)($status['year_deferred'] ?? 0)));
exit(0);
