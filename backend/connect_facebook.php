<?php

require_once __DIR__ . '/meta_auth_helper.php';
$runtime = meta_backend_bootstrap();

$pdo = $runtime['pdo'];
$META_APP_ID = $runtime['META_APP_ID'];
$META_APP_SECRET = $runtime['META_APP_SECRET'];
$BACKEND_URL = $runtime['BACKEND_URL'];
$FRONTEND_URL = $runtime['FRONTEND_URL'];
$SYSTEM_ROOT_USER_TOKEN = $runtime['SYSTEM_ROOT_USER_TOKEN'];
$facebookConfigId = $runtime['META_FACEBOOK_CONFIG_ID'];

if (empty($_GET['code'])) {
    $companyUUID = $_GET['company_uuid'] ?? '';
    if (empty($companyUUID)) {
        http_response_code(400);
        echo json_encode(['error' => 'company_uuid is required']);
        exit;
    }

    $scopes = [
        'public_profile',
        'pages_show_list',
        'pages_manage_metadata',
        'pages_messaging',
        'pages_read_engagement',
        'pages_read_user_content',
        'pages_manage_engagement'
    ];

    $loginUrl = meta_build_login_url(
        $facebookConfigId,
        $BACKEND_URL,
        '/connect_facebook.php',
        $companyUUID,
        $scopes,
        $META_APP_ID,
        ['product' => 'FACEBOOK']
    );

    header('Location: ' . $loginUrl);
    exit;
}

$code = $_GET['code'] ?? null;
$state = $_GET['state'] ?? null;
$error = $_GET['error'] ?? null;

if ($error || !$code) {
    meta_redirect_frontend($FRONTEND_URL, '/channels', [
        'error' => $error ?: 'No code',
        'product' => 'FACEBOOK'
    ]);
}

$stateData = meta_decode_state($state);
$companyUUID = $stateData['companyUUID'] ?? null;

if (!$companyUUID) {
    meta_redirect_frontend($FRONTEND_URL, '/channels', [
        'error' => 'Missing_Company_ID',
        'product' => 'FACEBOOK'
    ]);
}

$context = meta_get_company_context($pdo, $companyUUID);
if (!$context) {
    meta_redirect_frontend($FRONTEND_URL, '/channels', [
        'error' => 'Company_Not_Found',
        'product' => 'FACEBOOK'
    ]);
}

$tokenRes = meta_call_meta_api('/oauth/access_token', [
    'client_id' => $META_APP_ID,
    'client_secret' => $META_APP_SECRET,
    'redirect_uri' => rtrim($BACKEND_URL, '/') . '/connect_facebook.php',
    'code' => $code
], 'GET');

if (!$tokenRes || empty($tokenRes['access_token'])) {
    meta_redirect_frontend($FRONTEND_URL, '/channels', [
        'error' => 'Failed_to_get_token',
        'product' => 'FACEBOOK'
    ]);
}

$shortUserToken = $tokenRes['access_token'];
$longTokenRes = meta_call_meta_api('/oauth/access_token', [
    'grant_type' => 'fb_exchange_token',
    'client_id' => $META_APP_ID,
    'client_secret' => $META_APP_SECRET,
    'fb_exchange_token' => $shortUserToken
], 'GET');

$userAccessToken = $longTokenRes['access_token'] ?? $shortUserToken;
$userExpiresIn = $longTokenRes['expires_in'] ?? 5184000;
$expiresUserTokenAt = date('Y-m-d H:i:s', time() + $userExpiresIn);

$pdo->beginTransaction();

try {
    $sqlInsert = "INSERT INTO MetaConnectedPages
                  (IdDatabase, IdCompany, `Type`, ExternalId, ExternalName, ProfilePicture, UserAccessToken, PageAccessToken, ExpiresUserAccessTokenAt, ExpiresPageAccessTokenAt, ParentChannelId, ConnectedAt)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                  ON DUPLICATE KEY UPDATE
                  IdDatabase = VALUES(IdDatabase),
                  ExternalName = VALUES(ExternalName),
                  ProfilePicture = VALUES(ProfilePicture),
                  PageAccessToken = VALUES(PageAccessToken),
                  UserAccessToken = VALUES(UserAccessToken),
                  ParentChannelId = VALUES(ParentChannelId),
                  ConnectedAt = NOW()";
    $stmt = $pdo->prepare($sqlInsert);

    $appAccessToken = $META_APP_ID . '|' . $META_APP_SECRET;
    $debugRes = meta_call_meta_api('/debug_token', [
        'input_token' => $userAccessToken,
        'access_token' => $appAccessToken
    ]);

    $authorizedPageIds = meta_collect_granular_scope_ids($debugRes ?: [], ['pages_messaging', 'pages_show_list']);

    foreach ($authorizedPageIds as $pageId) {
        $pageData = meta_call_meta_api("/{$pageId}", [
            'fields' => 'id,name,access_token',
            'access_token' => $userAccessToken
        ]);

        if (empty($pageData['id']) || empty($pageData['access_token'])) {
            continue;
        }

        $pageToken = $pageData['access_token'];
        $picData = meta_call_meta_api("/{$pageData['id']}/picture", [
            'redirect' => 'false',
            'type' => 'normal',
            'access_token' => $pageToken
        ]);
        $fbPicUrl = $picData['data']['url'] ?? '';

        $stmt->execute([
            $context['IdDatabase'],
            $context['IdCompany'],
            'FACEBOOK',
            $pageData['id'],
            $pageData['name'] ?? '',
            $fbPicUrl,
            $userAccessToken,
            $pageToken,
            $expiresUserTokenAt,
            'Never',
            null
        ]);

        try {
            meta_call_meta_api('/' . $pageData['id'] . '/subscribed_apps', [
                'subscribed_fields' => 'messages,mention,feed',
                'access_token' => $pageToken
            ], 'POST');
        } catch (Exception $e) {
            logMessage('metaBackend', 'error', 'Facebook webhook error: ' . $e->getMessage());
        }
    }

    $pdo->commit();
} catch (Exception $e) {
    $pdo->rollBack();
    logMessage('metaBackend', 'error', 'Facebook callback DB error: ' . $e->getMessage());
    meta_redirect_frontend($FRONTEND_URL, '/channels', [
        'error' => 'Database_error',
        'product' => 'FACEBOOK'
    ]);
}

meta_redirect_frontend($FRONTEND_URL, '/channels', [
    'auth_success' => 'true',
    'product' => 'FACEBOOK'
]);
