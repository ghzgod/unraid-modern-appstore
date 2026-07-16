<?php
/**
 * App Store GitHub Addon — star fetcher.
 *
 * Reads the Community Applications catalog cache READ-ONLY, derives owner/repo
 * from each app's Project/Support GitHub URL, queries the GitHub API (token +
 * fabricated User-Agent + ETag), and caches results in SQLite. Exports:
 *   - stars.json : compact name->stars map for the badge painter
 *   - apps.json  : full catalog (name, path, icon, author, category, stars,
 *                  downloads, trend deltas) for the dedicated GitHub view
 * Records a star-history snapshot per run so trending (1d/1w/1m/1y) can be
 * computed over time.
 *
 * Persistent data (DB + JSON) lives in a configurable appdata dir on the cache
 * SSD so it survives reboots; served copies go to the tmpfs webroot. curl_multi
 * keep-alive for speed; a flock guarantees one scan at a time.
 *
 * NEVER writes to any CA-owned path. NEVER logs the token. UA is fabricated.
 */

error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE);

const UA = 'unraid-app-stars/1.0 (+https://example.com)';
const PLUGIN = 'appstore.github.addon';

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
    'trends-only' => '0',  // 1 = no network: recompute trend deltas from stored star history and rewrite JSON
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

$appdataDefault = '/mnt/user/appdata/appstore_github_addon';
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
function write_progress(string $outDir, bool $running, int $done, int $total, array $status): void {
    @file_put_contents($outDir . '/progress.json', json_encode([
        'running' => $running, 'done' => $done, 'total' => $total,
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
function derive_repo(array $app): ?array {
    foreach (['Project', 'Support'] as $field) {
        $url = $app[$field] ?? '';
        if (!$url) continue;
        if (preg_match('~github\.com/([^/]+)/([^/#?\s]+)~i', $url, $m)) {
            $repo = preg_replace('~\.git$~', '', $m[2]);
            if (strtolower($repo) === 'issues') continue;
            return ['owner' => $m[1], 'repo' => $repo, 'full' => strtolower($m[1] . '/' . $repo)];
        }
    }
    return null;
}

$repoMeta = [];      // full => ['owner','repo']
$appRepoMap = [];    // app index => full
foreach ($apps as $idx => $app) {
    if (!is_array($app)) continue;
    $d = derive_repo($app);
    if (!$d) continue;
    $repoMeta[$d['full']] = ['owner' => $d['owner'], 'repo' => $d['repo']];
    $appRepoMap[$idx] = $d['full'];
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
// trend columns persist computed deltas so a --new-only run doesn't wipe them
foreach (['t1', 't7', 't30', 't365'] as $tcol) { @$db->exec("ALTER TABLE repos ADD COLUMN $tcol INTEGER"); }
$db->exec('CREATE TABLE IF NOT EXISTS star_history (repo TEXT, ts INTEGER, stars INTEGER)');
$db->exec('CREATE INDEX IF NOT EXISTS idx_hist ON star_history(repo, ts)');

function db_get(SQLite3 $db, string $repo): ?array {
    $s = $db->prepare('SELECT stars, etag FROM repos WHERE repo = :r');
    $s->bindValue(':r', $repo, SQLITE3_TEXT);
    return $s->execute()->fetchArray(SQLITE3_ASSOC) ?: null;
}
function db_upsert(SQLite3 $db, string $repo, string $owner, string $name, ?int $stars, ?string $etag, int $hs, int $ts): void {
    $s = $db->prepare('INSERT INTO repos (repo, owner, name, stars, etag, http_status, fetched_at)
        VALUES (:repo,:owner,:name,:stars,:etag,:hs,:ts)
        ON CONFLICT(repo) DO UPDATE SET owner=:owner,name=:name,stars=:stars,etag=:etag,http_status=:hs,fetched_at=:ts');
    $s->bindValue(':repo', $repo, SQLITE3_TEXT); $s->bindValue(':owner', $owner, SQLITE3_TEXT);
    $s->bindValue(':name', $name, SQLITE3_TEXT);
    $s->bindValue(':stars', $stars, $stars === null ? SQLITE3_NULL : SQLITE3_INTEGER);
    $s->bindValue(':etag', $etag, $etag === null ? SQLITE3_NULL : SQLITE3_TEXT);
    $s->bindValue(':hs', $hs, SQLITE3_INTEGER); $s->bindValue(':ts', $ts, SQLITE3_INTEGER);
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
    if (!empty($row['etag'])) $h[] = 'If-None-Match: ' . $row['etag'];
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
            $stars = (int)((json_decode($body, true)['stargazers_count']) ?? 0);
            db_upsert($db, $full, $m['owner'], $m['repo'], $stars, $heads['etag'] ?? ($row['etag'] ?? null), 200, time());
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

$sgTrends = $trendsOnly ? [] : backfill_trends($repoMeta, $starsByRepo, $token, $outDir, $status, (int)$opt['sg-limit'], $newRepoSet);

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
    if ($stars !== null && $full !== null) {
        // Prefer uncapped snapshot deltas; the stored stargazer-page counts
        // saturate at 100 and can't rank fast-growing repos, so they're only a
        // last-resort fallback for windows longer than our star history.
        $fb = $dbTrends[$full] ?? [null, null, null, null];
        $t1   = trend_window($baseQ, $oldQ, $full, 86400,       $stars, $now, $fb[0]);
        $t7   = trend_window($baseQ, $oldQ, $full, 7 * 86400,   $stars, $now, $fb[1]);
        $t30  = trend_window($baseQ, $oldQ, $full, 30 * 86400,  $stars, $now, $fb[2]);
        $t365 = trend_window($baseQ, $oldQ, $full, 365 * 86400, $stars, $now, $fb[3]);
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
        'au' => $app['Author'] ?? ($app['Repository'] ?? ''),
        'ct' => $cat,
        'de' => $desc,
        'pr' => $app['Project'] ?? '',
        'su' => $app['Support'] ?? '',
        'rp' => $full,
        's'  => $stars,
        'dl' => (int)($app['downloads'] ?? 0),
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

fwrite(STDERR, sprintf("fetch_stars: repos=%d ok=%d notmod=%d missing=%d rate=%s errors=%d apps=%d sgTrends=%d\n",
    $status['repos_total'], $status['ok'], $status['not_modified'], $status['missing'],
    var_export($status['rate_remaining'], true), count($status['errors']), count($catalog), count($sgTrends)));
exit(0);
