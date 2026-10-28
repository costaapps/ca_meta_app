# Backend AGENTS

Scope:
- Applies only to files inside `backend/`

Local Rules
- `connect.php` and `connect_old.php` are local sensitive references and must stay out of Git unless the user explicitly approves otherwise.
- Document behavior, contracts, and risks; do not copy secrets, raw token values, or hardcoded sensitive IDs into tracked files.
- The four versioned references are connect_facebook.php, connect_instagram.php, connect_whatsapp.php and meta_auth_helper.php. Use their actual code for frontend-contract discovery; only connect.php/connect_old.php are local sensitive references, not the entire backend directory. Deployment equivalence still needs evidence.
- Before changing PHP behavior, review:
  - [../.github/docs/agent-context/backend-contracts.md](../.github/docs/agent-context/backend-contracts.md)
  - [../.github/docs/agent-context/meta-integrations.md](../.github/docs/agent-context/meta-integrations.md)
  - [../.github/docs/agent-context/security.md](../.github/docs/agent-context/security.md)

What To Check First
- Route matching and redirect behavior
- `company_uuid` and `CompanyUUID` tenant handling
- token exchange and callback logic
- WhatsApp template endpoints and notification actions
