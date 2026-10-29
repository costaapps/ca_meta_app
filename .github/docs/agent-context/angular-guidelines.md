# Angular Guidelines

## Goals For This Repository
- Preserve current behavior first.
- Keep the code consistent with the real Angular 21 standalone app already in place.
- Use strict typing and small, feature-scoped edits.

Evidence:
- `apps/web/package.json`
- `apps/web/tsconfig.json`
- `apps/web/src/app/**/*`

## Patterns To Preserve
- Standalone components
- Feature-oriented folders under `apps/web/src/app/features`
- Shared API logic in `core/services`
- Shared TypeScript contracts in `core/models`
- SCSS per component plus minimal global styles
- Explicit HTTP typing where practical

Evidence:
- `apps/web/src/app/features/channels/pages/*/*.ts`
- `apps/web/src/app/core/services/meta-integration.service.ts`
- `apps/web/src/app/core/models/channel.model.ts`

## Patterns To Replace Gradually
- `alert(...)` for user-visible failures
- Repeated `company_uuid` string building in multiple places
- Duplicated `ConnectedChannel` interface definitions in service and component
- Console-only error handling
- Specs still written for old Jasmine-era architecture

Evidence:
- `apps/web/src/app/core/services/meta-integration.service.ts`
- `apps/web/src/app/features/channels/pages/channel-list/channel-list.component.ts`
- `apps/web/src/app/features/channels/pages/channel-list/channel-list.component.spec.ts`

## Signals And RxJS
- Current code is RxJS-first and that is acceptable for now.
- Do not add Signals just because Angular 21 supports them.
- Prefer Signals only when introducing synchronous UI state that benefits from fine-grained derivation.
- When bridging Observables to Signals, use `@angular/core/rxjs-interop` deliberately and create the signal once, not repeatedly.
- For this codebase today, new API calls and async backend flows should continue to use `HttpClient` + Observable unless a local state need clearly favors Signals.

Project default:
- Preserve existing `Subject<void> + takeUntil` unless you are already refactoring a component deeply enough to justify `takeUntilDestroyed`.

Evidence:
- `apps/web/src/app/features/channels/**/*.ts`
- Angular docs consulted in `references.md`

## Dependency Injection
- Continue using constructor injection for consistency with current files.
- If a new file starts from scratch and remains simple, `inject()` is acceptable only if it does not mix styles confusingly within the same file.
- Keep providers centralized unless a feature-scoped provider is clearly needed.

Evidence:
- `apps/web/src/app/app.config.ts`
- `apps/web/src/app/core/services/meta-integration.service.ts`

## Typing
- Keep `strict` compatibility.
- Avoid `any`; if temporary uncertainty exists, prefer `unknown` and narrow it.
- Promote shared response types into `core/models` when they are used in more than one place.
- Align spec imports and mocks with the current public API before extending tests.

Evidence:
- `apps/web/tsconfig.json`
- `apps/web/src/app/features/channels/components/notification-bell/notification-bell.component.ts`

## Components
- One page component should own one main screen concern.
- Keep template logic shallow; move parsing, placeholder derivation, and payload shaping into TypeScript methods.
- Avoid placing backend contract details directly in templates.
- Keep UI states explicit:
  - loading
  - empty
  - success
  - error

Evidence:
- `apps/web/src/app/features/channels/pages/channel-templates/channel-templates.component.ts`
- `apps/web/src/app/features/channels/pages/channel-list/channel-list.component.html`

## Forms
- The current code uses template-driven forms with `FormsModule`.
- Do not switch a page to reactive forms unless the task materially benefits from it.
- If a form becomes more complex, migrate the entire form coherently instead of mixing paradigms.

Evidence:
- `apps/web/src/app/features/channels/pages/channel-list/channel-list.component.html`
- `apps/web/src/app/features/channels/pages/channel-templates/channel-templates.component.html`

## HTTP And Error Handling
- Use `HttpClient`.
- Keep response shapes typed.
- Normalize user-facing errors close to the boundary or introduce a shared error mapper only if multiple screens start repeating the same logic.
- Avoid swallowing errors silently; at minimum log and surface a UI state.

Evidence:
- `apps/web/src/app/app.config.ts`
- `apps/web/src/app/core/services/meta-integration.service.ts`

## Accessibility
- Preserve semantic buttons and labels already present.
- Ensure interactive elements remain keyboard-usable.
- For new modal/dropdown work, include focus and escape-key behavior if complexity grows.
- Do not rely on color alone for status.

## Testing
- Update or add tests only against the actual Angular 21 component API.
- Use the configured test toolchain; do not reintroduce Jasmine globals as a default.
- Prioritize tests for:
  - route/query behavior
  - payload construction
  - validation branches
  - template placeholder handling

See also:
- [testing-and-validation.md](testing-and-validation.md)
- [known-issues.md](known-issues.md)
