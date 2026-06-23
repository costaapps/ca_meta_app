# Known Issues

## P0

### Tenant identity trusts raw client input
- `cUUID` enters through query params and is stored in localStorage without proof of origin.
- Impact: multi-tenant isolation is too weak for iframe productization.
- Evidence:
  - `src/app/features/channels/pages/channel-setup/channel-setup.component.ts`
  - `src/app/core/services/meta-integration.service.ts`

### Local backend integration code is outside Git
- `backend/` is untracked even though it defines the real frontend contracts used today.
- Impact: operational drift and undocumented changes can break the frontend silently.
- Evidence:
  - `git status --short --branch`
  - `backend/connect.php`

## P1

### OAuth flow is still unified across products
- Current code asks for Facebook, Instagram, and WhatsApp scopes together.
- Impact: over-scoped auth and harder future separation.
- Evidence:
  - `backend/connect.php`

### Test suite is stale and failing
- At least two specs target removed behavior and Jasmine globals.
- Impact: no trustworthy automated regression signal.
- Evidence:
  - `src/app/app.spec.ts`
  - `src/app/features/channels/pages/channel-list/channel-list.component.spec.ts`

### WhatsApp notification text reply path is not implemented
- `SEND_MESSAGE` branch exists conceptually but does not send.
- Impact: UI exposes behavior the backend cannot complete.
- Evidence:
  - `backend/connect.php::actionNotification`

## P2

### No embed-safe iframe contract yet
- No `postMessage`, `origin` validation, or parent-child auth handshake exists.
- Impact: blocked or unsafe `suite4` embedding.
- Evidence:
  - no matching code found in `src/` or `backend/`

### Service and component duplicate channel types
- `ConnectedChannel` is declared in more than one place.
- Impact: type drift risk.
- Evidence:
  - `src/app/core/services/meta-integration.service.ts`
  - `src/app/features/channels/pages/channel-list/channel-list.component.ts`

### User-visible errors are inconsistent
- Some failures use `alert`, some use inline banners, some only log to console.
- Impact: uneven UX and supportability.
- Evidence:
  - `src/app/core/services/meta-integration.service.ts`
  - `src/app/features/channels/**/*`
