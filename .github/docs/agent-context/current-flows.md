# Current Flows

## Purpose
- This file is a map of the main runtime flows.
- It intentionally stays above implementation detail so it remains useful as the code evolves.

## Main User Journeys

### App Entry
- The app is route-driven and starts at the setup experience by default.
- Tenant initialization happens close to the setup flow rather than in a global app bootstrap.

Evidence:
- `src/app/app.routes.ts`
- `src/app/features/channels/pages/channel-setup/channel-setup.component.ts`

### Tenant Capture
- The active tenant is currently derived from `cUUID`.
- That value is persisted locally and reused across the integration flows.
- There is no stronger parent-platform handshake yet.

Evidence:
- `src/app/features/channels/pages/channel-setup/channel-setup.component.ts`
- `src/app/core/services/meta-integration.service.ts`

### Meta Connection Flow
- The setup screen delegates login URL generation to the backend.
- The current authorization journey is still combined across Meta products.
- After external authorization, the backend redirects the user back into the app.

Evidence:
- `src/app/features/channels/pages/channel-setup/channel-setup.component.ts`
- `src/app/core/services/meta-integration.service.ts`
- `backend/connect.php`

### Connected Channel Management
- The channels area loads the connected assets for the active tenant.
- It also owns the current automation/message configuration UX.
- WhatsApp behavior should be treated as structurally distinct from Facebook and Instagram even when shown in the same screen.

Evidence:
- `src/app/features/channels/pages/channel-list/channel-list.component.ts`
- `backend/connect.php`

### WhatsApp Template Flow
- The templates area is a WhatsApp-specific flow built on top of connected numbers.
- It supports template listing and creation through the backend boundary.

Evidence:
- `src/app/features/channels/pages/channel-templates/channel-templates.component.ts`
- `backend/connect.php`

### Review Notification Flow
- The notification bell loads review-related items and dispatches actions back through the backend.
- Treat it as a separate operational concern from the main setup flow.

Evidence:
- `src/app/features/channels/components/notification-bell/notification-bell.component.ts`
- `backend/connect.php`

## Navigation Shape
- `/setup`: onboarding and connection entry
- `/channels`: primary operational area
- `/templates`: WhatsApp template subflow
- callback returns currently land on `/channels`

Evidence:
- `src/app/app.routes.ts`
- `backend/connect.php`

## Read The Code When
- you need exact payload shape
- you need exact redirect behavior
- you need detailed validation logic
- you need product-specific branching

See also:
- [backend-contracts.md](backend-contracts.md)
- [meta-integrations.md](meta-integrations.md)
- [iframe-integration.md](iframe-integration.md)
