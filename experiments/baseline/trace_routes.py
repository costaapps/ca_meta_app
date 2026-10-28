"""Offline static trace of the versioned router. Never includes/executes PHP."""
from pathlib import Path
import json
import re
from urllib.parse import urlsplit

root = Path(__file__).resolve().parents[2]
source = (root / 'backend/connect_whatsapp.php').read_text()
router = source[source.index('// ============ ROTEAMENTO'):source.index('// ============ FUNÇÕES HANDLERS')]
routes = re.findall(r"\$method === '(GET|POST)' && strpos\(\$path, '([^']+)'\) !== false\) \{\s*(\w+)\(\);", router)
assert len(routes) == 8, 'Router shape changed: manual reconciliation required'
fixtures = [
    ('GET', '/meta/auth/connect_whatsapp.php?company_uuid=tenant-fixture', None),
    ('GET', '/meta/auth/login-url?company_uuid=tenant-fixture', 'getLoginUrl'),
    ('GET', '/meta/auth/facebook/callback?code=fixture-code&state=fixture-state', 'facebookCallback'),
    ('GET', '/meta/auth/channels?company_uuid=tenant-fixture', 'getChannels'),
    ('POST', '/meta/auth/save_auto_reply', 'saveAutoReply'),
    ('GET', '/meta/auth/notifications?company_uuid=tenant-fixture', 'getNotifications'),
    ('POST', '/meta/auth/notifications/action', 'actionNotification'),
    ('GET', '/meta/auth/whatsapp/templates?company_uuid=tenant-fixture&phone_number_id=phone-fixture', 'getWhatsappTemplates'),
    ('POST', '/meta/auth/whatsapp/templates', 'createWhatsappTemplate'),
    ('DELETE', '/meta/auth/channels', None),
]
for method, uri, expected in fixtures:
    path = urlsplit(uri).path.replace('/api', '')
    handler = next((name for verb, fragment, name in routes if verb == method and fragment in path), None)
    assert handler == expected, (method, uri, expected, handler)
    print(json.dumps({'method': method, 'fixture_uri': uri, 'handler': handler, 'router_status_if_unmatched': 404 if handler is None else None}))
print('PASS: 10 offline static traces; no PHP bootstrap, HTTP, SQL or provider calls executed.')
