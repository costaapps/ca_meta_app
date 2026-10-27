# Current Flows

## Purpose
- This file maps the main runtime flows at a stable level.

## Main User Journeys

### App Entry
- The app still starts at the setup experience.
- The setup screen now shows three explicit product paths instead of one combined Meta login.

Evidence:
- `src/app/app.routes.ts`
- `src/app/features/channels/pages/channel-setup/channel-setup.component.ts`

### Tenant Capture
- The active tenant is still derived from `cUUID`.
- That value is persisted locally and reused across the Meta flows.

Evidence:
- `src/app/features/channels/pages/channel-setup/channel-setup.component.ts`
- `src/app/core/services/meta-integration.service.ts`

### Meta Connection Flow
- The setup screen now treats WhatsApp, Facebook and Instagram as separate journeys.
- Each journey has its own CTA, backend entrypoint and in-page state.
- WhatsApp is prepared as a dedicated Embedded Signup path.

Evidence:
- `src/app/features/channels/pages/channel-setup/channel-setup.component.ts`
- `src/app/core/services/meta-auth.service.ts`
- `src/app/app.routes.ts`

### Connected Channel Management
- The channels area still loads connected assets for the active tenant.
- It continues to own the automation/message configuration UX.

Evidence:
- `src/app/features/channels/pages/channel-list/channel-list.component.ts`
- `src/app/core/services/meta-integration.service.ts`

### WhatsApp Template Flow
- The templates area remains a WhatsApp-specific flow built on connected numbers.

Evidence:
- `src/app/features/channels/pages/channel-templates/channel-templates.component.ts`
- `src/app/core/services/meta-integration.service.ts`

## Navigation Shape
- `/setup`: onboarding entry with three visible product cards
- `backend/connect.php`: WhatsApp entrypoint and callback handler
- `backend/connect_facebook.php`: Facebook entrypoint and callback handler
- `backend/connect_instagram.php`: Instagram entrypoint and callback handler
- `/setup/callback`: legacy callback alias retained for compatibility
- `/channels`: primary operational area
- `/templates`: WhatsApp template subflow

Evidence:
- `src/app/app.routes.ts`
- `src/app/features/channels/pages/channel-setup/channel-setup.component.ts`

## Read The Code When
- you need exact callback handling
- you need tenant capture details
- you need product-specific branching

See also:
- [backend-contracts.md](backend-contracts.md)
- [meta-integrations.md](meta-integrations.md)
- [iframe-integration.md](iframe-integration.md)
