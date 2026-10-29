# Meta Integrations

## Current Reality
- The frontend now separates Meta setup into three product journeys: WhatsApp Embedded Signup, Facebook and Instagram.
- The setup page renders one card per product and routes callbacks separately.
- The backend now has product-specific entrypoints for Facebook and Instagram, while WhatsApp keeps the existing `backend/connect.php` flow.

Evidence:
- `apps/web/src/app/features/channels/pages/channel-setup/channel-setup.component.ts`
- `apps/web/src/app/app.routes.ts`
- `apps/web/src/app/core/services/meta-auth.service.ts`
- `apps/web/src/app/core/services/meta-integration.service.ts`
- `backend/connect.php`
- `backend/connect_facebook.php`
- `backend/connect_instagram.php`
- `backend/meta_auth_helper.php`

## Responsibility Split Today
- Angular:
  - starts product-specific connection flows
  - stores tenant context
  - shows setup and callback state per product
  - manages channel and template UI
- PHP:
  - now owns product-specific login initiation and callback processing through separate files
  - still owns connected channel and WhatsApp template operations

Evidence:
- `apps/web/src/app/core/services/meta-auth.service.ts`
- `apps/web/src/app/core/services/meta-integration.service.ts`
- `apps/web/src/app/features/channels/pages/channel-setup/channel-setup.component.ts`

## Product Boundaries Today
- WhatsApp is treated as a dedicated Embedded Signup journey.
- Facebook and Instagram now have separate frontend journeys and backend entrypoints.

## Historical Reference
- `backend/connect_old.php` remains a local comparison point for the older unified flow.

Evidence:
- `backend/connect_old.php`

## Read The Code When
- you need the current frontend auth split
- you need the shared backend boundary
- you need product-specific branching details

See also:
- [backend-contracts.md](backend-contracts.md)
- [security.md](security.md)
- [roadmap.md](roadmap.md)
