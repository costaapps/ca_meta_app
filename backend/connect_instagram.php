<?php

require_once __DIR__ . '/meta_auth_helper.php';
$runtime = meta_backend_bootstrap();

$pdo = $runtime['pdo'];
$META_APP_ID = $runtime['META_APP_ID'];
$META_APP_SECRET = $runtime['META_APP_SECRET'];
$BACKEND_URL = $runtime['BACKEND_URL'];
$FRONTEND_URL = $runtime['FRONTEND_URL'];
$instagramConfigId = $runtime['META_INSTAGRAM_CONFIG_ID'];

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
        'instagram_basic',
        'instagram_manage_comments',
        'instagram_manage_messages'
    ];

    $loginUrl = meta_build_login_url(
        $instagramConfigId,
        $BACKEND_URL,
        '/connect_instagram.php',
        $companyUUID,
        $scopes,
        $META_APP_ID,
        ['product' => 'INSTAGRAM']
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
        'product' => 'INSTAGRAM'
    ]);
}

$stateData = meta_decode_state($state);
$companyUUID = $stateData['companyUUID'] ?? null;

if (!$companyUUID) {
    meta_redirect_frontend($FRONTEND_URL, '/channels', [
        'error' => 'Missing_Company_ID',
        'product' => 'INSTAGRAM'
    ]);
}

$context = meta_get_company_context($pdo, $companyUUID);
if (!$context) {
    meta_redirect_frontend($FRONTEND_URL, '/channels', [
        'error' => 'Company_Not_Found',
        'product' => 'INSTAGRAM'
    ]);
}

$tokenRes = meta_call_meta_api('/oauth/access_token', [
    'client_id' => $META_APP_ID,
    'client_secret' => $META_APP_SECRET,
    'redirect_uri' => rtrim($BACKEND_URL, '/') . '/connect_instagram.php',
    'code' => $code
], 'GET');

if (!$tokenRes || empty($tokenRes['access_token'])) {
    meta_redirect_frontend($FRONTEND_URL, '/channels', [
        'error' => 'Failed_to_get_token',
        'product' => 'INSTAGRAM'
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

    $authorizedPageIds = meta_collect_granular_scope_ids($debugRes ?: [], ['pages_show_list', 'pages_messaging']);

    foreach ($authorizedPageIds as $pageId) {
        $pageData = meta_call_meta_api("/{$pageId}", [
            'fields' => 'id,name,access_token,instagram_business_account',
            'access_token' => $userAccessToken
        ]);

        if (empty($pageData['instagram_business_account']['id'])) {
            continue;
        }

        $igAccountId = $pageData['instagram_business_account']['id'];
        $igDetails = meta_call_meta_api('/' . $igAccountId, [
            'fields' => 'id,username,profile_picture_url',
            'access_token' => $pageData['access_token'] ?? $userAccessToken
        ]);

        $stmt->execute([
            $context['IdDatabase'],
            $context['IdCompany'],
            'INSTAGRAM',
            $igAccountId,
            $igDetails['username'] ?? '',
            $igDetails['profile_picture_url'] ?? '',
            $userAccessToken,
            $pageData['access_token'] ?? null,
            $expiresUserTokenAt,
            'Never',
            null
        ]);
    }

    $pdo->commit();
} catch (Exception $e) {
    $pdo->rollBack();
    logMessage('metaBackend', 'error', 'Instagram callback DB error: ' . $e->getMessage());
    meta_redirect_frontend($FRONTEND_URL, '/channels', [
        'error' => 'Database_error',
        'product' => 'INSTAGRAM'
    ]);
}

meta_redirect_frontend($FRONTEND_URL, '/channels', [
    'auth_success' => 'true',
    'product' => 'INSTAGRAM'
]);
