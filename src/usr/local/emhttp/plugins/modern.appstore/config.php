<?php
/**
 * Unraid Modern App Store: shared settings layer.
 *
 * This file is the single definition of the plugin's settings, their
 * validation rules, their defaults, and the cron line a save produces. Two
 * callers pull it in: the Unraid settings page (ModernAppStore.page) and the
 * Apps page's slide-in settings panel (settings.php). If each kept its own
 * copy of these rules the two could drift apart, one showing a value the
 * other does not agree is valid. Routing both through this file means there
 * is exactly one place that decides what a valid SCAN_DAYS or DEFAULT_SORT
 * is, and exactly one place that writes the cfg and cron files, so the two
 * surfaces can never disagree.
 *
 * Single source of truth on disk:
 * /boot/config/plugins/modern.appstore/modern.appstore.cfg
 */

// require_once keys its cache off the resolved include path, but the page and
// the endpoint each reach this file through a different base (one via
// $docroot, one via __DIR__), so nothing guarantees PHP treats those as the
// same file. Guard with function_exists as well, so a second load is a
// harmless no-op instead of a "cannot redeclare function" fatal.
if (!function_exists('gas_scan_days')) {

// Only the intervals the cron line below can express, so a hand-edited config
// cannot write a schedule that never fires.
function gas_scan_days($v) {
    $v = (int)$v;
    return in_array($v, [1, 2, 3, 7], true) ? $v : 1;
}

// The grid's own SORT_OPTS list, mirrored here so a hand-edited config cannot
// name a sort order the grid does not have; anything unrecognised opens on
// Newest to the App Store instead.
function gas_default_sort($v) {
    $valid = ['name_asc', 'name_desc', 'downloads', 'new', 'updated', 'spotlight', 'trending',
              'newinstalls', 'popplugins', 'ghstars', 'ght1', 'ght7', 'ght30', 'ght365',
              'ghp1', 'ghp7', 'ghp30', 'ghp365', 'ghpall'];
    return in_array($v, $valid, true) ? $v : 'new';
}

function gas_write_cfg($path, $token, $service, $notifications, $datadir, $scanDays, $defaultSort) {
    $token   = str_replace(["\"", "\n", "\r"], "", $token);
    $datadir = rtrim(str_replace(["\"", "\n", "\r"], "", $datadir), '/');
    if ($datadir === '') $datadir = '/boot/config/plugins/modern.appstore';
    $service = ($service === 'enabled') ? 'enabled' : 'disabled';
    $notifications = ($notifications === 'disabled') ? 'disabled' : 'enabled';
    $scanDays = gas_scan_days($scanDays);
    $defaultSort = gas_default_sort($defaultSort);
    $out = "TOKEN=\"$token\"\nSERVICE=\"$service\"\nNOTIFICATIONS=\"$notifications\"\nDATA_DIR=\"$datadir\"\nSCAN_DAYS=\"$scanDays\"\nDEFAULT_SORT=\"$defaultSort\"\n";
    file_put_contents($path, $out);
    @chmod($path, 0600);
    @mkdir($datadir, 0755, true);
}

function gas_write_cron($path, $scanDays = 1) {
    $php = "php /usr/local/emhttp/plugins/modern.appstore/fetch_stars.php";
    $scanDays = gas_scan_days($scanDays);
    // A full scan on the chosen interval, plus an hourly check that pulls only
    // NEWLY published app-store repos (it bypasses the manual-refresh cooldown).
    // The trending orders are differences between two full scans, so the
    // interval is also the finest trending window that can hold any data: on a
    // three-day schedule the "today" window compares a star count against
    // itself and every app reads as zero.
    $day = ($scanDays === 1) ? "*" : "*/$scanDays";
    $lines = "0 4 $day * * $php >/dev/null 2>&1\n23 * * * * $php --new-only 1 >/dev/null 2>&1\n";
    file_put_contents($path, $lines);
    @exec("/usr/local/sbin/update_cron 2>/dev/null");
}

// Reads the cfg file and applies the exact same defaults the settings page
// has always used when the file is missing, empty, or only partially
// written, so a fresh install and a hand-edited config both land on values
// the rest of the plugin, and every caller of this function, can trust.
/**
 * A token rendered the way every other web app renders a saved secret: its
 * kind, then dots, then the last four characters. That is enough for someone
 * to recognise WHICH token is saved without the value ever being useful.
 *
 * The prefix is kept because it is the part that identifies the token type
 * (ghp_ for classic, github_pat_ for fine-grained) and is not secret. The
 * run of dots is a fixed length rather than the token's real one, so the
 * mask does not quietly publish how long the secret is.
 */
function gas_mask_token($token) {
    $token = trim((string)$token);
    if ($token === '') return '';
    $prefix = '';
    // the LAST underscore in the opening stretch, not the first: a classic
    // token prefixes with ghp_ (one underscore) but a fine-grained one with
    // github_pat_ (two), and splitting on the first would call that github_
    // and hide the part that actually names the type.
    $us = strrpos(substr($token, 0, 13), '_');
    if ($us !== false) {
        $prefix = substr($token, 0, $us + 1);
        $token  = substr($token, $us + 1);
    }
    // too short to reveal a tail from without giving away most of it
    if (strlen($token) < 8) return $prefix . str_repeat("\u{2022}", 8);
    return $prefix . str_repeat("\u{2022}", 12) . substr($token, -4);
}

function gas_read_cfg($path) {
    $cfg = is_file($path) ? @parse_ini_file($path) : [];
    if (!is_array($cfg)) $cfg = [];
    return [
        'token'         => $cfg['TOKEN'] ?? '',
        'service'       => $cfg['SERVICE'] ?? 'enabled',
        'notifications' => (($cfg['NOTIFICATIONS'] ?? 'enabled') === 'disabled') ? 'disabled' : 'enabled',
        'datadir'       => $cfg['DATA_DIR'] ?? '/boot/config/plugins/modern.appstore',
        'scandays'      => (string)gas_scan_days($cfg['SCAN_DAYS'] ?? 1),
        'defaultsort'   => gas_default_sort($cfg['DEFAULT_SORT'] ?? 'new'),
    ];
}

}
