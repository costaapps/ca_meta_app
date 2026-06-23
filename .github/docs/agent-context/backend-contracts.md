# Backend Contracts

## Purpose
- This file documents the backend surface area at a stable level.
- It is meant to identify responsibility and dependency boundaries, not to duplicate every request and response shape from PHP.

## Contract Classification
- `Comprovado`: directly supported by the current code
- `Inferido`: expected by the current structure but not fully asserted here
- `Planejado`: future-facing and not part of the live flow yet

## Base Boundary
- The Angular frontend talks to a backend base URL defined in the environment files.
- The runtime backend currently consumed here is PHP.

Evidence:
- `src/environments/environment.ts`
- `src/environments/environment.prod.ts`
- `src/app/core/services/meta-integration.service.ts`

## Current Endpoint Families

### Auth And Callback
- Status: Comprovado
- Responsibilities:
  - start the current Meta authorization flow
  - recover tenant context
  - process the callback
  - persist discovered assets
  - redirect the user back into the frontend

Primary sources:
- `src/app/core/services/meta-integration.service.ts`
- `backend/connect.php`

### Connected Channels
- Status: Comprovado
- Responsibilities:
  - return connected channels for the active tenant
  - persist channel automation configuration

Primary sources:
- `src/app/core/services/meta-integration.service.ts`
- `src/app/features/channels/pages/channel-list/channel-list.component.ts`
- `backend/connect.php`

### Notifications And Review Actions
- Status: Comprovado
- Responsibilities:
  - load unread review-related notifications
  - trigger backend-mediated user actions for those notifications

Primary sources:
- `src/app/features/channels/components/notification-bell/notification-bell.component.ts`
- `backend/connect.php`

### WhatsApp Templates
- Status: Comprovado
- Responsibilities:
  - list templates for connected WhatsApp numbers
  - create templates through backend-owned Meta credentials

Primary sources:
- `src/app/core/services/meta-integration.service.ts`
- `src/app/features/channels/pages/channel-templates/channel-templates.component.ts`
- `backend/connect.php`

## Shared Contract Traits
- Tenant context is required across the meaningful backend operations.
- The frontend passes tenant context explicitly rather than through a stronger app session layer.
- Product-specific logic exists behind a shared backend base path.

## Read The Code When
- you need exact payload or response shape
- you need exact error behavior
- you need redirect details
- you need database coupling
- you need product-specific branching

See also:
- [meta-integrations.md](meta-integrations.md)
- [security.md](security.md)
- [open-questions.md](open-questions.md)
