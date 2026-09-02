<?php
/**
 * Unraid Modern App Store: settings endpoint for the Apps page slide-in panel.
 *
 * Runs the same shared code from config.php, against the same cfg file, as
 * ModernAppStore.page (Settings -> Utilities -> Unraid Modern App Store). The
 * two surfaces mirror each other exactly because they share validation,
 * defaults, and the cron write, not because anyone kept them in sync by hand.
 *
 * GET returns the current settings. POST saves them, or (with action=refresh)
 * fires a background scan the same way the settings page's "Refresh now"
 * button does. Anything else is a 405.
 */
require_once __DIR__ . '/config.php';

header('Content-Type: application/json');

// this is a JSON API: a stray PHP warning printed ahead of the '{' would
// break every response for the panel, and none of the moving parts below
// (a missing cfg file, an unwritable data dir) are anything the caller can
// act on anyway, so they are suppressed rather than surfaced.
error_reporting(0);

$gas_dir  = '/boot/config/plugins/modern.appstore';
$gas_cfg  = "$gas_dir/modern.appstore.cfg";
$gas_cron = "$gas_dir/modern.appstore.cron";
$gas_php  = '/usr/local/emhttp/plugins/modern.appstore/fetch_stars.php';

if (!is_dir($gas_dir)) @mkdir($gas_dir, 0755, true);

function gas_settings_response($cfg, $extra = []) {
    return array_merge([
        'service'       => $cfg['service'],
        'notifications' => $cfg['notifications'],
        // never the token itself, only whether one is set. The browser has
        // no legitimate use for the secret, and returning it would put a
        // GitHub token into page JS state, dev tools, and any network log.
        'hasToken'      => trim($cfg['token']) !== '',
        // the MASK is safe to send where the token is not: kind, dots, last
        // four. It lets the panel show which token is saved the way GitHub
        // and Stripe do, instead of a sentence claiming one exists.
        'tokenHint'     => gas_mask_token($cfg['token']),
        'scanDays'      => $cfg['scandays'],
        'defaultSort'   => $cfg['defaultsort'],
        'dataDir'       => $cfg['datadir'],
        'cardsPerRow'   => $cfg['cardsperrow'],
        'hideIncompatible' => ($cfg['hideincompatible'] === 'yes'),
    ], $extra);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    echo json_encode(gas_settings_response(gas_read_cfg($gas_cfg)));
    exit;
}

if ($method === 'POST') {
    if (($_POST['action'] ?? '') === 'refresh') {
        @exec('nohup php ' . escapeshellarg($gas_php) . ' >/dev/null 2>&1 &');
        echo json_encode(['started' => true]);
        exit;
    }

    // read what is on disk first, then overlay only the fields this request
    // actually sent. The panel may submit a single changed field (say, just
    // SCAN_DAYS), and a field that is absent has to keep its saved value
    // rather than fall back to gas_write_cfg's own defaults, or every partial
    // save from the panel would quietly reset the fields it did not send.
    $current = gas_read_cfg($gas_cfg);

    $service       = $_POST['SERVICE'] ?? $current['service'];
    $notifications = $_POST['NOTIFICATIONS'] ?? $current['notifications'];
    $datadir       = $_POST['DATA_DIR'] ?? $current['datadir'];
    $scandays      = $_POST['SCAN_DAYS'] ?? $current['scandays'];
    $defaultsort   = $_POST['DEFAULT_SORT'] ?? $current['defaultsort'];
    $cardsperrow   = $_POST['CARDS_PER_ROW'] ?? $current['cardsperrow'];
    $hideincompatible = $_POST['HIDE_INCOMPATIBLE'] ?? $current['hideincompatible'];

    // TOKEN is the subtle one. The panel's password field always renders
    // blank, since a browser should never echo a saved secret back into a
    // form, so an absent or empty TOKEN on save has to mean "leave the saved
    // token alone", not "the user wants it cleared". Otherwise every save
    // made from the panel without retyping the token would silently wipe it.
    // CLEAR_TOKEN=1 is the one deliberate way to blank it instead.
    if (!empty($_POST['CLEAR_TOKEN'])) {
        $token = '';
    } elseif (isset($_POST['TOKEN']) && trim($_POST['TOKEN']) !== '') {
        $token = $_POST['TOKEN'];
    } else {
        $token = $current['token'];
    }

    gas_write_cfg($gas_cfg, $token, $service, $notifications, $datadir, $scandays, $defaultsort, $cardsperrow, $hideincompatible);
    gas_write_cron($gas_cron, $scandays);

    echo json_encode(gas_settings_response(gas_read_cfg($gas_cfg), ['saved' => true]));
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'method not allowed']);
