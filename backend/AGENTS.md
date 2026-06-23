# Backend AGENTS

Scope:
- Applies only to files inside `backend/`

Local Rules
- `connect.php` and `connect_old.php` are local sensitive references and must stay out of Git unless the user explicitly approves otherwise.
- Document behavior, contracts, and risks; do not copy secrets, raw token values, or hardcoded sensitive IDs into tracked files.
- Treat this directory as the operative source for current frontend contracts, even though it is local-only.
- Before changing PHP behavior, review:
  - [../.github/docs/agent-context/backend-contracts.md](../.github/docs/agent-context/backend-contracts.md)
  - [../.github/docs/agent-context/meta-integrations.md](../.github/docs/agent-context/meta-integrations.md)
  - [../.github/docs/agent-context/security.md](../.github/docs/agent-context/security.md)

What To Check First
- Route matching and redirect behavior
- `company_uuid` and `CompanyUUID` tenant handling
- token exchange and callback logic
- WhatsApp template endpoints and notification actions
