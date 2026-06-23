# Meta Integrations

## Current Reality
- The current implementation still treats Facebook, Instagram, and WhatsApp as parts of one combined authorization journey.
- The code already shows that this is an operational baseline, not the intended long-term architecture.

Evidence:
- `src/app/features/channels/pages/channel-setup/channel-setup.component.ts`
- `backend/connect.php`

## Responsibility Split Today
- Angular:
  - starts the connection flow
  - displays connected assets
  - manages channel and template UI
- PHP:
  - builds the login URL
  - receives the callback
  - exchanges tokens
  - discovers assets
  - persists channels
  - performs Meta-facing backend actions

Evidence:
- `src/app/core/services/meta-integration.service.ts`
- `backend/connect.php`

## Product Boundaries Today
- Facebook is the visible entry point from the frontend.
- Instagram is still discovered through the broader connected-account flow.
- WhatsApp is handled through the same authorization baseline and then exposed in dedicated UI areas such as templates and review actions.
- There is no Embedded Signup implementation yet.

Evidence:
- `src/app/features/channels/**/*`
- `backend/connect.php`

## Why This Matters
- Future work must not assume one callback, one scope bundle, or one token strategy for all Meta products.
- Product-specific auth separation is a roadmap concern and should be treated as an architectural change, not a small refactor.

## Historical Reference
- `backend/connect_old.php` exists as a local comparison point for the older unified flow.
- Use it only for reasoning about drift and migration, not as a documentation target to mirror line by line.

Evidence:
- `backend/connect_old.php`

## Read The Code When
- you need the exact current OAuth parameters
- you need the exact current scope list
- you need product-specific persistence details
- you need to compare the current flow with the older local variant

See also:
- [backend-contracts.md](backend-contracts.md)
- [security.md](security.md)
- [roadmap.md](roadmap.md)
