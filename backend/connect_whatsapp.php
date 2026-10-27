<?php
/**
 * MSG4 Meta Backend API (Login, Callback, Channel Management)
 * Arquivo: api.php
 */

$rootDir = dirname(dirname(dirname(__DIR__))); 
if (!file_exists($rootDir . '/config/bootstrap.php')) {
    $rootDir = dirname(__DIR__); 
}
require_once $rootDir . '/config/bootstrap.php';

// Configs
$META_APP_ID            = $_ENV['META_APP_ID'] ?? '';
$META_APP_SECRET        = $_ENV['META_APP_SECRET'] ?? '';
$BACKEND_URL            = $_ENV['META_APP_BACKEND_URL'] ?? ''; 
$FRONTEND_URL           = $_ENV['META_APP_FRONTEND_URL'] ?? '';
$SYSTEM_ROOT_USER_TOKEN = $_ENV['META_APP_SYSTEM_ROOT_TOKEN'] ?? ''; // Apenas para aprovação na Meta.

logMessage('metaBackend', 'request', "Iniciando. Backend: $BACKEND_URL | Front: $FRONTEND_URL");

// ============ HEADERS & CORS ============
$allowedOrigins = [
    $_ENV['META_APP_FRONTEND_URL'] ?? '' 
];
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';

if (in_array($origin, $allowedOrigins)) {
    header('Access-Control-Allow-Origin: ' . $origin);
} else {
    header('Access-Control-Allow-Origin: ' . ($FRONTEND_URL ?: '*'));
}

header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
header('Access-Control-Allow-Credentials: true'); 

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// ============ ROTEAMENTO ============

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$path = str_replace('/api', '', $path); 
$method = $_SERVER['REQUEST_METHOD'];

try {
    if ($method === 'GET' && strpos($path, '/login-url') !== false) {
        getLoginUrl();
    } elseif ($method === 'GET' && strpos($path, '/facebook/callback') !== false) {
        facebookCallback();
    } elseif ($method === 'GET' && strpos($path, '/whatsapp/templates') !== false) {
        getWhatsappTemplates();
    } elseif ($method === 'POST' && strpos($path, '/whatsapp/templates') !== false) {
        createWhatsappTemplate();
    } elseif ($method === 'GET' && strpos($path, '/channels') !== false) {
        getChannels();
    } elseif ($method === 'POST' && strpos($path, '/save_auto_reply') !== false) {
        saveAutoReply();
    } elseif ($method === 'GET' && strpos($path, '/notifications') !== false) {
        getNotifications();
    } elseif ($method === 'POST' && strpos($path, '/notifications/action') !== false) {
        actionNotification();
    } else {
        http_response_code(404);
        echo json_encode(['error' => 'Route not found: ' . $path]);
    }
} catch (Exception $e) {
    logMessage('metaBackend', 'error', 'Fatal: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['error' => 'Internal Server Error']);
}
exit;

// ============ FUNÇÕES HANDLERS ============

/**
 * GET /auth/meta/login-url
 */
function getLoginUrl() {
    global $META_APP_ID, $BACKEND_URL;

    $companyUUID = $_GET['company_uuid'] ?? '';
    
    if (empty($companyUUID)) {
        http_response_code(400);
        echo json_encode(['error' => 'company_uuid is required']);
        return;
    }

    $stateData = json_encode(['companyUUID' => $companyUUID]);
    $stateEncoded = base64_encode($stateData);

    // Como você usa Facebook Login for Business com System User Token delegation,
    // os escopos agora servem para sinalizar o que o App vai operar de forma geral.
    $scopesProfile = ['public_profile'];

    $scopesFacebook = [
        'pages_show_list',
        'pages_manage_metadata',
        'pages_messaging',
        'pages_read_engagement',
        'pages_read_user_content',
        'pages_manage_engagement'
    ];

    $scopesInstagram = [
        'instagram_basic',
        'instagram_manage_comments',
        'instagram_manage_messages'
    ];

    $scopesWhatsApp = [
        'whatsapp_business_management',
        'whatsapp_business_messaging'
    ];

    $allScopes = array_merge($scopesProfile, $scopesFacebook, $scopesInstagram, $scopesWhatsApp);
    $scopeString = implode(',', $allScopes);
    
    // Configura os parâmetros injetando a nova variação de Login Corporativo
    $params = [
        'client_id'           => $META_APP_ID,
        'redirect_uri'        => $BACKEND_URL . '/facebook/callback',
        'scope'               => $scopeString,
        'response_type'       => 'code',
        'state'               => $stateEncoded,
        'config_id'           => '1374123204539248',
        'auth_type'           => 'reauthenticate' 
    ];

    // ADAPTADO: Mudança para o endpoint correto de Login Corporativo (Business Login)
    $loginUrl = 'https://www.facebook.com/v24.0/dialog/oauth?' . http_build_query($params);
    echo json_encode(['loginUrl' => $loginUrl]);
}

/**
 * GET /auth/facebook/callback
 * Insere Facebook, Instagram E WhatsApp.
 */
function facebookCallback() {
    global $pdo, $META_APP_ID, $META_APP_SECRET, $BACKEND_URL, $FRONTEND_URL;

    $code  = $_GET['code'] ?? null;
    $state = $_GET['state'] ?? null;
    $error = $_GET['error'] ?? null;

    if ($error || !$code) {
        header('Location: ' . $FRONTEND_URL . '/channels?error=' . urlencode($error ?: 'No code'));
        exit;
    }

    // Decodifica UUID
    $companyUUID = null;
    if ($state) {
        $decoded = json_decode(base64_decode($state), true);
        $companyUUID = $decoded['companyUUID'] ?? null;
    }

    if (!$companyUUID) {
        header('Location: ' . $FRONTEND_URL . '/channels?error=Missing_Company_ID');
        exit;
    }

    // Busca Database
    try {
        $stmtDb = $pdo->prepare("SELECT IdDatabase, IdCompany FROM Company WHERE CompanyUUID = ?");
        $stmtDb->execute([$companyUUID]);
        $dbInfo = $stmtDb->fetch(PDO::FETCH_ASSOC);

        if (!$dbInfo) {
            header('Location: ' . $FRONTEND_URL . '/channels?error=Database_Not_Found');
            exit;
        }
        $idDatabase = $dbInfo['IdDatabase'];
        $idCompany = $dbInfo['IdCompany'];
    } catch (PDOException $e) {
        header('Location: ' . $FRONTEND_URL . '/channels?error=System_Error');
        exit;
    }

    // Troca Code por Token (Esse passo continua igual)
    $tokenParams = [
        'client_id'     => $META_APP_ID,
        'client_secret' => $META_APP_SECRET,
        'redirect_uri'  => $BACKEND_URL . '/facebook/callback',
        'code'          => $code
    ];
    $tokenRes = callMetaApi('/oauth/access_token', $tokenParams, 'GET', false);

    if (!$tokenRes || !isset($tokenRes['access_token'])) {
        header('Location: ' . $FRONTEND_URL . '/channels?error=Failed_to_get_token');
        exit;
    }
    $shortUserToken = $tokenRes['access_token'];

    // Token Longo (Necessário para as operações de FB/IG do cliente)
    $longTokenParams = [
        'grant_type'        => 'fb_exchange_token',
        'client_id'         => $META_APP_ID,
        'client_secret'     => $META_APP_SECRET,
        'fb_exchange_token' => $shortUserToken
    ];
    $longTokenRes = callMetaApi('/oauth/access_token', $longTokenParams, 'GET', false);
    $userAccessToken = $longTokenRes['access_token'] ?? $shortUserToken;
    $userExpiresIn = $longTokenRes['expires_in'] ?? 5184000;
    $expiresUserTokenAt = date('Y-m-d H:i:s', time() + $userExpiresIn);
    
    $pdo->beginTransaction();
    $connectedCount = 0;

    try {
        // Query de Inserção Genérica
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

        // Define o App Access Token para o debug
        $appAccessToken = $META_APP_ID . '|' . $META_APP_SECRET;

        // ADAPTADO: Definir o Token System User fixo do seu servidor.
        // Como o login novo gera uma delegação de ativos B2B, o SEU token root agora tem poder sobre o WABA dele.
        // Dica: Configure isso em uma variável global ou arquivo .env para produção.
        $mySystemUserToken = $SYSTEM_ROOT_USER_TOKEN;

        // 1. Inspeciona o token do usuário para descobrir quais páginas e WABAs ele autorizou
        $debugRes = callMetaApi('/debug_token', [
            'input_token'  => $userAccessToken,
            'access_token' => $appAccessToken
        ]);

        $authorizedPageIds = [];

        // 2. Vasculha os escopos granulares atrás dos IDs das páginas
        if (!empty($debugRes['data']['granular_scopes'])) {
            foreach ($debugRes['data']['granular_scopes'] as $scopeItem) {
                if (in_array($scopeItem['scope'], ['pages_messaging', 'pages_show_list'])) {
                    if (!empty($scopeItem['target_ids'])) {
                        foreach ($scopeItem['target_ids'] as $targetId) {
                            $authorizedPageIds[$targetId] = $targetId;
                        }
                    }
                }
            }
        }

        if (empty($authorizedPageIds)) {
            logMessage('metaBackend', 'warning', 'Nenhuma página encontrada nos escopos granulares do token.');
        } else {
            logMessage('metaBackend', 'info', 'Páginas autorizadas encontradas: ' . implode(', ', $authorizedPageIds));

            // 3. Busca os dados de cada página diretamente pelo ID
            foreach ($authorizedPageIds as $pageId) {
                $pageData = callMetaApi("/$pageId", [
                    'fields'       => 'id,name,access_token,instagram_business_account',
                    'access_token' => $userAccessToken
                ]);

                if (!empty($pageData['id']) && !empty($pageData['access_token'])) {
                    // -- A. FACEBOOK PAGE --
                    $fbPageId    = $pageData['id'];
                    $fbPageName  = $pageData['name'];
                    $fbPageToken = $pageData['access_token'];
                    
                    logMessage('metaBackend', 'info', ">> Processando página capturada: {$fbPageName}");
                    
                    try {
                        $picData = callMetaApi("/$fbPageId/picture", ['redirect' => 'false', 'type' => 'normal', 'access_token' => $fbPageToken]);
                        $fbPicUrl = $picData['data']['url'] ?? '';
                    } catch (Exception $e) {
                        $fbPicUrl = '';
                    }

                    // INSERÇÃO NO BANCO
                    $stmt->execute([
                        $idDatabase, $idCompany, 'FACEBOOK', $fbPageId, $fbPageName, $fbPicUrl, 
                        $userAccessToken, $fbPageToken, $expiresUserTokenAt, 'Never', null
                    ]);
                    
                    $fbDbId = $pdo->lastInsertId();
                    if (!$fbDbId) {
                        $stmtGet = $pdo->prepare("SELECT Id FROM MetaConnectedPages WHERE IdDatabase = ? AND IdCompany = ? AND ExternalId = ? AND `Type` = 'FACEBOOK'");
                        $stmtGet->execute([$idDatabase, $idCompany, $fbPageId]);
                        $fbDbId = $stmtGet->fetchColumn();
                    }

                    $connectedCount++; 

                    // ASSINATURA DE WEBHOOK (Facebook Pages continua usando o Page Token)
                    try {
                        callMetaApi('/' . $fbPageId . '/subscribed_apps', [
                            'subscribed_fields' => 'messages,mention,feed',
                            'access_token'      => $fbPageToken
                        ], 'POST');
                    } catch (Exception $e) {
                        logMessage('metaBackend', 'error', "Erro Webhook {$fbPageName}: " . $e->getMessage());
                    }

                    // -- B. INSTAGRAM --
                    if (isset($pageData['instagram_business_account']['id'])) {
                        $igAccountId = $pageData['instagram_business_account']['id'];
                        
                        $igDetails = callMetaApi('/' . $igAccountId, [
                            'fields'       => 'id,username,profile_picture_url',
                            'access_token' => $fbPageToken
                        ]);

                        $igUsername = $igDetails['username'] ?? '';
                        $igPic      = $igDetails['profile_picture_url'] ?? '';

                        $stmt->execute([
                            $idDatabase, $idCompany, 'INSTAGRAM', $igAccountId, $igUsername, $igPic, 
                            $userAccessToken, $fbPageToken, $expiresUserTokenAt, 'Never', $fbDbId               
                        ]);
                        $connectedCount++; 
                    }
                }
            }
        }
        
        // ==========================================
        // PARTE 2: WHATSAPP (WABAs e Números via Raio-X)
        // ==========================================
        logMessage('metaBackend', 'info', 'Iniciando extração de WABAs e Números via Debug Token...');

        $authorizedWabaIds = [];

        // 1. Extrai os IDs das contas WABA dos escopos granulares
        if (!empty($debugRes['data']['granular_scopes'])) {
            foreach ($debugRes['data']['granular_scopes'] as $scopeItem) {
                if (in_array($scopeItem['scope'], ['whatsapp_business_messaging', 'whatsapp_business_management'])) {
                    if (!empty($scopeItem['target_ids'])) {
                        foreach ($scopeItem['target_ids'] as $targetId) {
                            $authorizedWabaIds[$targetId] = $targetId;
                        }
                    }
                }
            }
        }

        if (empty($authorizedWabaIds)) {
            logMessage('metaBackend', 'info', 'Nenhuma WABA encontrada nos escopos granulares.');
        } else {
            // Prepara a query de inserção para a nova tabela de Números
            $sqlInsertPhone = "INSERT INTO MetaConnectedNumbers 
                               (IdWaba, ExternalId, DisplayPhoneNumber, VerifiedName, QualityRating, ConnectedAt)
                               VALUES (?, ?, ?, ?, ?, NOW())
                               ON DUPLICATE KEY UPDATE
                               DisplayPhoneNumber = VALUES(DisplayPhoneNumber),
                               VerifiedName = VALUES(VerifiedName),
                               QualityRating = VALUES(QualityRating)";
            $stmtPhone = $pdo->prepare($sqlInsertPhone);

            // 2. Itera sobre cada WABA encontrada
            foreach ($authorizedWabaIds as $wabaId) {
                logMessage('metaBackend', 'info', ">> Buscando detalhes da WABA: {$wabaId}");
                
                try {
                    $wabaData = callMetaApi("/$wabaId", [
                        'fields'       => 'name,currency,message_template_namespace,phone_numbers',
                        'access_token' => $userAccessToken
                    ]);

                    if (!empty($wabaData['id'])) {
                        $wabaName = $wabaData['name'] ?? "WABA {$wabaId}";
                        $waPic    = 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/WhatsApp.svg/1200px-WhatsApp.svg.png';

                        // A. SALVA A CONTA WABA (Na tabela principal MetaConnectedPages)
                        $stmt->execute([
                            $idDatabase, $idCompany, 'WHATSAPP', $wabaId, $wabaName, $waPic, 
                            $userAccessToken, null, $expiresUserTokenAt, 'Never', null
                        ]);

                        $wabaDbId = $pdo->lastInsertId();
                        
                        if (!$wabaDbId) {
                            $stmtGetWaba = $pdo->prepare("SELECT Id FROM MetaConnectedPages WHERE IdDatabase = ? AND IdCompany = ? AND ExternalId = ? AND `Type` = 'WHATSAPP'");
                            $stmtGetWaba->execute([$idDatabase, $idCompany, $wabaId]);
                            $wabaDbId = $stmtGetWaba->fetchColumn();
                        }

                        $connectedCount++;
                        
                        // B. ASSINA O APP NOS WEBHOOKS DA WABA
                        // ADAPTADO: Substituído o token do cliente pelo SEU System User Token permanente ($mySystemUserToken). 
                        // Isso vai fazer a Meta aceitar a inscrição do webhook de primeira.
                        try {
                            $subscribeWabaRes = callMetaApi("/$wabaId/subscribed_apps", [
                                'access_token' => $mySystemUserToken
                            ], 'POST');
                            
                            if (isset($subscribeWabaRes['error'])) {
                                logMessage(
                                    'metaBackend',
                                    'error',
                                    "Erro ao assinar webhook WhatsApp para WABA {$wabaId}: " . json_encode($subscribeWabaRes['error'])
                                );
                            } else {
                                logMessage(
                                    'metaBackend',
                                    'info',
                                    "Webhook WhatsApp assinado com sucesso para WABA {$wabaId}: " . json_encode($subscribeWabaRes)
                                );
                            }
                        } catch (Exception $e) {
                            logMessage(
                                'metaBackend',
                                'error',
                                "Erro ao assinar webhook WhatsApp para WABA {$wabaId}: " . $e->getMessage()
                            );
                        }

                        // C. SALVA OS NÚMEROS
                        if (!empty($wabaData['phone_numbers']['data'])) {
                            foreach ($wabaData['phone_numbers']['data'] as $phone) {
                                $phoneId       = $phone['id'];
                                $displayNum    = $phone['display_phone_number'] ?? $phoneId;
                                $verifiedName  = $phone['verified_name'] ?? 'WhatsApp Number';
                                $qualityRating = $phone['quality_rating'] ?? null;

                                logMessage('metaBackend', 'info', "Inserindo Telefone: {$verifiedName} ({$displayNum}) atrelado à WABA ID Banco: {$wabaDbId}");

                                $stmtPhone->execute([
                                    $wabaDbId, 
                                    $phoneId, 
                                    $displayNum, 
                                    $verifiedName,
                                    $qualityRating
                                ]);
                            }
                        } else {
                            logMessage('metaBackend', 'info', "A WABA {$wabaName} não possui números de telefone cadastrados.");
                        }
                    }
                } catch (Exception $e) {
                    logMessage('metaBackend', 'error', "Erro ao processar WABA {$wabaId}: " . $e->getMessage());
                }
            }
        }
        
        $pdo->commit();
        
    } catch (Exception $e) {
        $pdo->rollBack();
        logMessage('metaBackend', 'error', 'Erro DB: ' . $e->getMessage());
        header('Location: ' . $FRONTEND_URL . '/channels?error=Database_error');
        exit;
    }

    header('Location: ' . $FRONTEND_URL . '/channels?auth_success=true');
    exit;
}

/**
 * GET /channels
 */
function getChannels() {
    global $pdo;
    
    $companyUUID = $_GET['company_uuid'] ?? null;
    
    if (empty($companyUUID)) {
        http_response_code(400);
        echo json_encode(['error' => 'companyUUID is required']);
        return;
    }

    try {
        $stmtDb = $pdo->prepare("SELECT IdDatabase, IdCompany FROM Company WHERE CompanyUUID = ?");
        $stmtDb->execute([$companyUUID]);
        $dbInfo = $stmtDb->fetch(PDO::FETCH_ASSOC);

        if (!$dbInfo) {
            http_response_code(404);
            echo json_encode(['error' => 'Company not found']);
            return;
        }
        $idDatabase = $dbInfo['IdDatabase'];
        $idCompany = $dbInfo['IdCompany'];

        // A Engenhoca: Puxamos Face e Insta normal + Fazemos um UNION com os Números de WhatsApp 
        // mascarando o resultado para o frontend achar que é tudo o mesmo tipo de "Canal".
        $sql = "SELECT 
                    Id as id,
                    `Type` as type,
                    ExternalId as externalId,
                    ExternalName as name,
                    ProfilePicture as profilePicture,
                    PrivateWelcomeMessage as privateWelcomeMessage,
                    CommentPublicReply as commentPublicReply,
                    CommentPrivateReply as commentPrivateReply,
                    ConnectedAt as connectedAt
                FROM MetaConnectedPages 
                WHERE IdDatabase = ? AND IdCompany = ? AND `Type` IN ('FACEBOOK', 'INSTAGRAM')
                
                UNION ALL
                
                SELECT 
                    n.Id as id,
                    'WHATSAPP' as type,
                    n.ExternalId as externalId,
                    CONCAT(n.VerifiedName, ' (', n.DisplayPhoneNumber, ')') as name,
                    p.ProfilePicture as profilePicture,
                    p.PrivateWelcomeMessage as privateWelcomeMessage,
                    NULL as commentPublicReply,
                    NULL as commentPrivateReply,
                    n.ConnectedAt as connectedAt
                FROM MetaConnectedNumbers n
                INNER JOIN MetaConnectedPages p ON n.IdWaba = p.Id
                WHERE p.IdDatabase = ? AND p.IdCompany = ? AND p.`Type` = 'WHATSAPP'
                
                ORDER BY connectedAt DESC";

        $stmt = $pdo->prepare($sql);
        $stmt->execute([$idDatabase, $idCompany, $idDatabase, $idCompany]);
        $channels = $stmt->fetchAll(PDO::FETCH_ASSOC);
        
        echo json_encode($channels ?: []);

    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Database Query Error']);
    }
}

/**
 * POST /save_auto_reply
 */
function saveAutoReply() {
    global $pdo;
    
    $input = json_decode(file_get_contents('php://input'), true);

    $companyUUID  = $input['CompanyUUID'] ?? $_GET['company_uuid'] ?? null;
    $externalID   = $input['ExternalId'] ?? $input['PageID'] ?? null;
    $type         = isset($input['Type']) ? strtoupper($input['Type']) : null;
    
    $welcomeMsg   = $input['PrivateWelcomeMessage'] ?? $input['WelcomeMessage'] ?? null;
    $publicReply  = $input['CommentPublicReply'] ?? null;
    $privateReply = $input['CommentPrivateReply'] ?? null;
    
    if (empty($externalID) || empty($companyUUID)) {
        http_response_code(400);
        echo json_encode(['error' => 'Dados incompletos (ExternalId/UUID)']);
        return;
    }

    try {
        // A Engenhoca: Se for WHATSAPP, a gente intercepta e salva a mensagem na WABA pai!
        if ($type === 'WHATSAPP') {
            $sql = "UPDATE MetaConnectedPages mcp
                    INNER JOIN `Databases` db ON mcp.IdDatabase = db.IdDatabase
                    INNER JOIN MetaConnectedNumbers mcn ON mcn.IdWaba = mcp.Id
                    SET mcp.PrivateWelcomeMessage = :welcome
                    WHERE db.CompanyUUID = :uuid
                    AND mcn.ExternalId = :eid
                    AND mcp.`Type` = 'WHATSAPP'";
                    
            $stmt = $pdo->prepare($sql);
            $stmt->execute([
                ':welcome' => $welcomeMsg,
                ':uuid'    => $companyUUID,
                ':eid'     => $externalID
            ]);
        } else {
            // Comportamento normal original para FACEBOOK e INSTAGRAM
            $sql = "UPDATE MetaConnectedPages mcp
                    INNER JOIN `Databases` db ON mcp.IdDatabase = db.IdDatabase
                    SET mcp.PrivateWelcomeMessage = :welcome,
                        mcp.CommentPublicReply = :pub,
                        mcp.CommentPrivateReply = :priv
                    WHERE db.CompanyUUID = :uuid
                    AND mcp.ExternalId = :eid
                    AND mcp.`Type` = :type";
                    
            $stmt = $pdo->prepare($sql);
            $stmt->execute([
                ':welcome' => $welcomeMsg,
                ':pub'     => $publicReply,
                ':priv'    => $privateReply,
                ':uuid'    => $companyUUID,
                ':eid'     => $externalID,
                ':type'    => $type
            ]);
        }

        http_response_code(200); 
        echo json_encode(['status' => 'success', 'message' => 'Configurações salvas.']);

    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Erro interno ao salvar.']);
    }
}

/**
 * GET /notifications
 * Busca notificações não lidas para o sininho
 */
function getNotifications() {
    global $pdo;
    $companyUUID = $_GET['company_uuid'] ?? null;

    if (!$companyUUID) {
        http_response_code(400);
        echo json_encode(['error' => 'company_uuid required']);
        return;
    }

    try {
        $stmtDb = $pdo->prepare("SELECT IdDatabase FROM Company WHERE CompanyUUID = ?");
        $stmtDb->execute([$companyUUID]);
        $idDatabase = $stmtDb->fetchColumn();

        if (!$idDatabase) {
            http_response_code(404);
            echo json_encode(['error' => 'Company not found']);
            return;
        }

        $stmt = $pdo->prepare("SELECT * FROM MetaAppReviewNotifications WHERE IdDatabase = ? AND IsRead = 0 ORDER BY CreatedAt DESC");
        $stmt->execute([$idDatabase]);
        $notifications = $stmt->fetchAll(PDO::FETCH_ASSOC);

        echo json_encode(['success' => true, 'data' => $notifications]);
    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Database error']);
    }
}

/**
 * POST /notifications/action
 * Processa o clique do botão na UI
 */
function actionNotification() {
    global $pdo;
    $input = json_decode(file_get_contents('php://input'), true);

    $notificationId = $input['NotificationId'] ?? null;
    $actionType     = $input['ActionType'] ?? null;
    $companyUUID    = $input['CompanyUUID'] ?? null;
    $templateName   = $input['TemplateName'] ?? null;
    $templateLang   = $input['TemplateLanguage'] ?? 'en';
    $templateParams = $input['TemplateParams'] ?? null;

    if (!$notificationId || !$actionType || !$companyUUID) {
        http_response_code(400);
        echo json_encode(['error' => 'Missing parameters']);
        return;
    }

    try {
        // 1. Validar Tenant e buscar a notificação
        $stmtDb = $pdo->prepare("SELECT IdDatabase FROM Company WHERE CompanyUUID = ?");
        $stmtDb->execute([$companyUUID]);
        $idDatabase = $stmtDb->fetchColumn();

        $stmt = $pdo->prepare("SELECT * FROM MetaAppReviewNotifications WHERE Id = ? AND IdDatabase = ?");
        $stmt->execute([$notificationId, $idDatabase]);
        $notif = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$notif) {
            http_response_code(404);
            echo json_encode(['error' => 'Notification not found']);
            return;
        }

        $result = null;

        // 2. Disparar ação para a Meta
        if ($notif['PlatformType'] === 'WHATSAPP') {
            if ($actionType === 'SEND_TEMPLATE') {
                if (!$templateName) {
                    http_response_code(400);
                    echo json_encode(['error' => 'TemplateName is required']);
                    return;
                }

                $templatePayload = [
                    "name" => $templateName,
                    "language" => ["code" => $templateLang]
                ];

                if (is_array($templateParams) && !empty($templateParams)) {
                    $templatePayload["components"] = [[
                        "type" => "body",
                        "parameters" => array_map(static function ($param) {
                            return ["type" => "text", "text" => (string) $param];
                        }, $templateParams)
                    ]];
                }

                $payload = [
                    "messaging_product" => "whatsapp",
                    "to" => $notif['OriginId'],
                    "type" => "template",
                    "template" => $templatePayload
                ];

                $result = sendWhatsAppMessage($notif['DestinationId'], $payload);
            } elseif ($actionType === 'SEND_MESSAGE') {
                // Busca a mensagem configurada da página para poder responder
                // IMPLEMENTAR CONSULTA VÁLIDA
                // $stmtDb = $pdo->prepare("SELECT MP.PrivateWelcomeMessage FROM MetaAppReviewNotifications MN INNER JOIN MetaConnectedPages MP ON MN.IdDatabase = MP.IdDatabase");
                // $stmtDb->execute();
                // $message = $stmtDb->fetchColumn();
                // $payload = [
                //     "messaging_product" => "whatsapp",
                //     "recipient_type" => "individual",
                //     "to" => $notif['OriginId'],
                //     "type" => "text",
                //     "text" => ["preview_url" => false, "body" => $message ?? '']
                // ];
                // $result = sendWhatsAppMessage($notif['DestinationId'], $payload);
            }
        } 
        elseif ($notif['PlatformType'] === 'FACEBOOK' && $actionType === 'REPLY_COMMENT') {
            // Busca o token da página para poder responder
            $stmtDb = $pdo->prepare("SELECT CommentPublicReply, PageAccessToken FROM MetaConnectedPages WHERE ExternalId = ? AND IdDatabase = ?");
            $stmtDb->execute([$notif['DestinationId'], $idDatabase]);
            $dbInfo = $stmtDb->fetch(PDO::FETCH_ASSOC);
            
            $message = $dbInfo["CommentPublicReply"] ?? null;
            $pageToken = $dbInfo["PageAccessToken"] ?? null;

            $params = [
                "message" => $message,
                "access_token" => $pageToken
            ];
            $endpoint = "/{$notif['OriginId']}/comments";
            $result = callMetaApi($endpoint, $params, 'POST');
        }

        // 3. Marcar como lida
        $stmtUpdate = $pdo->prepare("UPDATE MetaAppReviewNotifications SET IsRead = 1 WHERE Id = ?");
        $stmtUpdate->execute([$notificationId]);

        echo json_encode(['success' => true, 'meta_response' => $result]);

    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Internal server error: ' . $e->getMessage()]);
    }
}

/**
 * GET /whatsapp/templates
 * Params: company_uuid, phone_number_id
 */
function getWhatsappTemplates() {
    global $pdo, $SYSTEM_ROOT_USER_TOKEN;

    $companyUUID = $_GET['company_uuid'] ?? null;
    $phoneNumberId = $_GET['phone_number_id'] ?? null;

    if (!$companyUUID || !$phoneNumberId) {
        http_response_code(400);
        echo json_encode(['error' => 'company_uuid and phone_number_id are required']);
        return;
    }

    $context = getCompanyContext($pdo, $companyUUID);
    if (!$context) {
        http_response_code(404);
        echo json_encode(['error' => 'Company not found']);
        return;
    }

    $wabaExternalId = getWabaExternalIdByPhoneNumber(
        $pdo,
        $context['IdDatabase'],
        $context['IdCompany'],
        $phoneNumberId
    );

    if (!$wabaExternalId) {
        http_response_code(404);
        echo json_encode(['error' => 'WhatsApp number not found']);
        return;
    }

    $templates = callMetaApi('/' . $wabaExternalId . '/message_templates', [
        'fields' => 'name,status,category,language,components',
        'limit' => 200,
        'access_token' => $SYSTEM_ROOT_USER_TOKEN
    ]);

    echo json_encode(['data' => $templates['data'] ?? []]);
}

/**
 * POST /whatsapp/templates
 * Body: company_uuid, phone_number_id, name, category, body
 */
function createWhatsappTemplate() {
    global $pdo, $SYSTEM_ROOT_USER_TOKEN;

    $input = json_decode(file_get_contents('php://input'), true);
    $companyUUID = $input['company_uuid'] ?? null;
    $phoneNumberId = $input['phone_number_id'] ?? null;
    $name = $input['name'] ?? null;
    $category = $input['category'] ?? null;
    $body = $input['body'] ?? null;
    $language = $input['language'] ?? 'pt_BR';
    $exampleValues = $input['example_values'] ?? [];

    if (!$companyUUID || !$phoneNumberId || !$name || !$category || !$body) {
        http_response_code(400);
        echo json_encode(['error' => 'company_uuid, phone_number_id, name, category, body are required']);
        return;
    }

    $context = getCompanyContext($pdo, $companyUUID);
    if (!$context) {
        http_response_code(404);
        echo json_encode(['error' => 'Company not found']);
        return;
    }

    $wabaExternalId = getWabaExternalIdByPhoneNumber(
        $pdo,
        $context['IdDatabase'],
        $context['IdCompany'],
        $phoneNumberId
    );

    if (!$wabaExternalId) {
        http_response_code(404);
        echo json_encode(['error' => 'WhatsApp number not found']);
        return;
    }

    $bodyComponent = [
        'type' => 'BODY',
        'text' => $body
    ];

    if (is_array($exampleValues) && !empty($exampleValues)) {
        $bodyComponent['example'] = [
            'body_text' => [array_map('strval', $exampleValues)]
        ];
    }

    $components = [$bodyComponent];

    $payload = [
        'name' => $name,
        'language' => $language,
        'category' => $category,
        'components' => json_encode($components)
    ];

    $result = callMetaApi('/' . $wabaExternalId . '/message_templates', array_merge($payload, [
        'access_token' => $SYSTEM_ROOT_USER_TOKEN
    ]), 'POST');

    echo json_encode(['success' => true, 'data' => $result]);
}

/**
 * Resolve IdDatabase + IdCompany by CompanyUUID
 */
function getCompanyContext($pdo, $companyUUID) {
    $stmtDb = $pdo->prepare("SELECT IdDatabase, IdCompany FROM Company WHERE CompanyUUID = ?");
    $stmtDb->execute([$companyUUID]);
    return $stmtDb->fetch(PDO::FETCH_ASSOC) ?: null;
}

/**
 * Resolve WABA ExternalId for a phone number
 */
function getWabaExternalIdByPhoneNumber($pdo, $idDatabase, $idCompany, $phoneNumberId) {
    $stmt = $pdo->prepare("SELECT mcp.ExternalId FROM MetaConnectedNumbers mcn INNER JOIN MetaConnectedPages mcp ON mcn.IdWaba = mcp.Id WHERE mcn.ExternalId = ? AND mcp.IdDatabase = ? AND mcp.IdCompany = ? AND mcp.Type = 'WHATSAPP'");
    $stmt->execute([$phoneNumberId, $idDatabase, $idCompany]);
    return $stmt->fetchColumn() ?: null;
}

/**
 * HELPER PARA WHATSAPP (EXIGE JSON E BEARER)
 */
function sendWhatsAppMessage($phoneNumberId, $payload) {
    global $SYSTEM_ROOT_USER_TOKEN;
    
    $url = "https://graph.facebook.com/v24.0/{$phoneNumberId}/messages";
    $ch = curl_init($url);
    
    $headers = [
        'Authorization: Bearer ' . $SYSTEM_ROOT_USER_TOKEN,
        'Content-Type: application/json'
    ];

    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_POSTFIELDS     => json_encode($payload),
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_TIMEOUT        => 30
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    logMessage('metaBackend', 'whatsapp_out', "Status: $httpCode | Resposta: $response");
    return json_decode($response, true);
}

/**
 * HELPER API
 */
function callMetaApi($endpoint, $params = [], $method = 'GET', $useGraph = true) {
    $baseUrl = 'https://graph.facebook.com/v24.0';
    $url = $baseUrl . $endpoint;
    
    $logParams = $params;
    if(isset($logParams['access_token'])) $logParams['access_token'] = '***MASKED***';
    if(isset($logParams['fb_exchange_token'])) $logParams['fb_exchange_token'] = '***MASKED***';
    
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
?>