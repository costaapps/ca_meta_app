# Security

## Current Security Posture
- Tenant context is lightweight and frontend-visible.
- Secrets and long-lived Meta credentials remain backend-side.
- The repository already shows signs that auth, tenant isolation, and iframe readiness need hardening before productization.

Evidence:
- `apps/web/src/app/core/services/meta-integration.service.ts`
- `apps/web/src/app/features/channels/pages/channel-setup/channel-setup.component.ts`
- `backend/connect.php`

## Priority Risks

### P0
- Tenant context is too easy to trust from the client side.
- Important backend integration behavior is local-only and outside normal Git review.

### P1
- The current Meta auth flow is broader than the future product direction.
- Callback and tenant handling should be treated as redesign candidates before iframe adoption.
- Review and template actions also depend on client-provided tenant context.

### P2
- The application is not yet prepared for secure iframe embedding.
- Error/logging behavior is still more operational than product-grade.

## Tokens And Secrets
- Keep Meta app credentials and permanent tokens in backend-only configuration.
- Do not copy operational identifiers or sensitive integration values into tracked documentation.
- Treat PHP local files as sensitive references even when they are useful for analysis.

## Tenant And Callback Concerns
- Tenant context is reused across frontend and backend boundaries and should be considered a major design axis.
- The current callback/state handling is sufficient to understand the existing flow, but not something to treat as finalized architecture.

## Browser And Embed Concerns
- Current code does not establish a trusted parent-child iframe contract.
- CSP, frame ancestry, and origin-validation concerns should be considered open implementation work, not solved problems.

## Logging And Output
- Frontend logging is still fairly raw.
- Backend-side masking exists, but it should not be assumed complete across every path.

See also:
- [iframe-integration.md](iframe-integration.md)
- [open-questions.md](open-questions.md)
- [known-issues.md](known-issues.md)
