<?php

function meta_env($key, $default = '')
{
    $value = getenv($key);
    if ($value !== false && $value !== '') {
        return $value;
    }

    if (isset($_ENV[$key]) && $_ENV[$key] !== '') {
        return $_ENV[$key];
    }

    return $default;
}

function meta_backend_bootstrap()
{
    $rootDir = dirname(dirname(dirname(__DIR__)));
    if (!file_exists($rootDir . '/config/bootstrap.php')) {
        $rootDir = dirname(__DIR__);
    }

    require_once $rootDir . '/config/bootstrap.php';

    $frontendUrl = meta_env('META_APP_FRONTEND_URL');
    $allowedOrigins = [$frontendUrl];
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';

    if (in_array($origin, $allowedOrigins, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
    } else {
        header('Access-Control-Allow-Origin: ' . ($frontendUrl ?: '*'));
    }

    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
    header('Access-Control-Allow-Credentials: true');

    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
        http_response_code(200);
        exit;
    }

    return [
        'pdo' => $GLOBALS['pdo'] ?? null,
        'META_APP_ID' => meta_env('META_APP_ID'),
        'META_APP_SECRET' => meta_env('META_APP_SECRET'),
        'BACKEND_URL' => meta_env('META_APP_BACKEND_URL'),
        'FRONTEND_URL' => $frontendUrl,
        'SYSTEM_ROOT_USER_TOKEN' => meta_env('META_APP_SYSTEM_ROOT_TOKEN'),
        'META_FACEBOOK_CONFIG_ID' => meta_env('META_FACEBOOK_CONFIG_ID'),
        'META_INSTAGRAM_CONFIG_ID' => meta_env('META_INSTAGRAM_CONFIG_ID'),
        'META_WHATSAPP_CONFIG_ID' => meta_env('META_WHATSAPP_CONFIG_ID'),
    ];
}

function meta_build_login_url($configId, $backendUrl, $callbackPath, $companyUUID, array $scopes, $appId, $stateExtras = [])
{
    $stateData = array_merge([
        'companyUUID' => $companyUUID
    ], $stateExtras);

    $params = [
        'client_id' => $appId,
        'redirect_uri' => rtrim($backendUrl, '/') . '/' . ltrim($callbackPath, '/'),
        'scope' => implode(',', $scopes),
        'response_type' => 'code',
        'state' => base64_encode(json_encode($stateData)),
        'config_id' => $configId,
        'auth_type' => 'reauthenticate'
    ];

    return 'https://www.facebook.com/v24.0/dialog/oauth?' . http_build_query($params);
}

function meta_decode_state($state)
{
    if (!$state) {
        return null;
    }

    $decoded = json_decode(base64_decode($state), true);
    return is_array($decoded) ? $decoded : null;
}

function meta_redirect_frontend($frontendUrl, $route, array $params = [])
{
    $query = http_build_query($params);
    $target = rtrim($frontendUrl, '/') . '/' . ltrim($route, '/');
    if ($query !== '') {
        $target .= '?' . $query;
    }

    header('Location: ' . $target);
    exit;
}

function meta_get_company_context($pdo, $companyUUID)
{
    $stmtDb = $pdo->prepare('SELECT IdDatabase, IdCompany FROM Company WHERE CompanyUUID = ?');
    $stmtDb->execute([$companyUUID]);
    return $stmtDb->fetch(PDO::FETCH_ASSOC) ?: null;
}

function meta_call_meta_api($endpoint, $params = [], $method = 'GET')
{
    $baseUrl = 'https://graph.facebook.com/v24.0';
    $url = $baseUrl . $endpoint;

    $logParams = $params;
    if (isset($logParams['access_token'])) {
        $logParams['access_token'] = '***MASKED***';
    }
    if (isset($logParams['fb_exchange_token'])) {
        $logParams['fb_exchange_token'] = '***MASKED***';
    }

    logMessage('metaBackend', 'api_call', "Chamando [$method] $endpoint | Params: " . json_encode($logParams));

    $ch = curl_init();
    if ($method === 'GET') {
        $url .= '?' . http_build_query($params);
    } else {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($params));
    }

    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_TIMEOUT => 30
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($curlError) {
        logMessage('metaBackend', 'error', "Erro cURL chamando $endpoint: $curlError");
        return null;
    }

    $json = json_decode($response, true);
    if ($httpCode >= 400) {
        logMessage('metaBackend', 'error', "API Meta retornou erro ($httpCode) para $endpoint: " . substr($response, 0, 300));
    } else {
        logMessage('metaBackend', 'api_call', "Sucesso ($httpCode).");
    }

    return $json;
}

function meta_collect_granular_scope_ids(array $debugRes, array $allowedScopes)
{
    $ids = [];

    if (empty($debugRes['data']['granular_scopes'])) {
        return $ids;
    }

    foreach ($debugRes['data']['granular_scopes'] as $scopeItem) {
        if (!in_array($scopeItem['scope'] ?? '', $allowedScopes, true)) {
            continue;
        }

        if (!empty($scopeItem['target_ids'])) {
            foreach ($scopeItem['target_ids'] as $targetId) {
                $ids[$targetId] = $targetId;
            }
        }
    }

    return $ids;
}
