import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFile(resolve(root, path), 'utf8');
const fixture = JSON.parse(await read('tools/m1-08/fixtures/walkthrough.json'));
const spec = await read('docs/meta-v2/experience/journey-spec.md');
const wireframes = await read('docs/meta-v2/experience/wireframes.md');
const statusCsv = await read('docs/meta-v2/experience/status-copy-matrix.csv');
const mapCsv = await read('docs/meta-v2/experience/screen-api-permission-test.csv');
const openapi = await read('docs/meta-v2/contracts/openapi.yaml');
const inbox = JSON.parse(await read('docs/meta-v2/contracts/events/inbox-event.schema.json'));
const outbox = JSON.parse(await read('docs/meta-v2/contracts/events/outbox-event.schema.json'));

const checks = [];
function check(id, fn) {
  try {
    fn();
    checks.push({ id, status: 'PASS' });
  } catch (error) {
    checks.push({ id, status: 'FAIL', message: error.message });
  }
}

function parseCsv(text) {
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value.length > 0)) records.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted value.');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  return records;
}

const statusRows = parseCsv(statusCsv);
const mapRows = parseCsv(mapCsv);
const statusHeader = statusRows[0];
const mapHeader = mapRows[0];
const statusIndex = Object.fromEntries(statusHeader.map((value, index) => [value, index]));
const mapIndex = Object.fromEntries(mapHeader.map((value, index) => [value, index]));
const statusChecks = new Set(statusRows.slice(1).map((row) => row[statusIndex.fixture_check]));
const mappedTraceIds = new Set(mapRows.slice(1).map((row) => row[mapIndex.trace_id]));

function allStrings(value, acc = []) {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allStrings(item, acc));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => allStrings(item, acc));
  return acc;
}

check('FLOW-01', () => {
  assert.equal(fixture.choices.length, 4, 'must keep four top-level product choices');
  const variantSet = new Set(fixture.flowVariants);
  assert.equal(variantSet.size, 5, 'five configured API variants must stay distinct');
  for (const choice of fixture.choices) {
    assert.ok(choice.variants.length > 0, `${choice.id} maps to at least one contract variant`);
    for (const variant of choice.variants) assert.ok(variantSet.has(variant), `${variant} is configured`);
  }
  assert.ok(spec.includes('Four user-facing choices'));
});

check('FLOW-02', () => {
  for (const variant of fixture.flowVariants) assert.ok(openapi.includes(`- ${variant}`), `${variant} exists in OpenAPI`);
  assert.ok(spec.includes('Se ambos estão habilitados') || spec.includes('If both are enabled'));
  assert.ok(spec.includes('INSTAGRAM_LOGIN') && spec.includes('INSTAGRAM_VIA_FACEBOOK_LOGIN'));
});

check('FLOW-03', () => {
  const paths = [
    '/api/v1/auth/preauth',
    '/api/v1/auth/exchanges',
    '/api/v1/auth/magic-links',
    '/api/v1/session',
    '/api/v1/integrations/flows',
    '/api/v1/onboarding-sessions',
    '/api/v1/connections'
  ];
  for (const path of paths) assert.ok(openapi.includes(path), `contract contains ${path}`);
  assert.ok(spec.includes('cUUID') && spec.includes('never grants authority'));
  assert.ok(spec.includes('tenantDisplayName') && spec.includes('Not confirmed'));
});

check('ENTRY-01', () => {
  const entry = fixture.suite4Entry;
  assert.deepEqual(entry.operations, [
    'POST /api/v1/auth/preauth',
    'POST /api/v1/auth/exchanges'
  ], 'preauth must precede ticket exchange');
  const preauthIndex = openapi.indexOf('/api/v1/auth/preauth:');
  const exchangeIndex = openapi.indexOf('/api/v1/auth/exchanges:');
  assert.ok(preauthIndex >= 0 && exchangeIndex > preauthIndex, 'contract declares preauth before exchange');
  assert.equal(entry.preauthResponseStatus, 201);
  assert.equal(entry.preauthCookieName, '__Host-meta_preauth');
  assert.equal(entry.preauthCookieValueExposed, false);
  assert.equal(entry.challengeRefPresent, true);
  assert.equal(entry.exchangeRequiresCookieAndChallengeRef, true);
  assert.equal(entry.sameBrowserContext, true);
  assert.equal(entry.ticketIncludedInFixture, false);
  assert.ok(openapi.includes('name: __Host-meta_preauth'));
  const exchangeContract = openapi.split('/api/v1/auth/exchanges:')[1].split('/api/v1/auth/magic-links:')[0];
  assert.ok(exchangeContract.includes('- preAuthCookie: []'));
  assert.ok(exchangeContract.includes('#/components/schemas/PortalEntryExchangeRequest'));
  const exchangeSchema = openapi.split('    PortalEntryExchangeRequest:')[1].split('    MagicLinkRequest:')[0];
  assert.ok(exchangeSchema.includes('- ticket') && exchangeSchema.includes('- challengeRef'));
  assert.ok(mappedTraceIds.has('ENTRY-01'));
});

check('ENTRY-03', () => {
  const entry = fixture.suite4Entry;
  assert.equal(entry.preauthResponseLostRecovery, 'fresh_challenge_may_be_started');
  assert.equal(entry.exchangeResponseLostRecovery, 'fresh_preauth_same_browser');
  assert.equal(entry.replayOneUseTicket, false);
  assert.equal(entry.replayOneUseChallenge, false);
  assert.equal(entry.additionalRetrySemantics, 'not_defined');
  assert.ok(openapi.includes('A consumed ticket is never replayed'));
  assert.ok(spec.includes('If the exchange response is lost, do not replay the one-use ticket'));
  assert.ok(mappedTraceIds.has('ENTRY-03'));
});

check('FLOW-04', () => {
  assert.ok(fixture.choices.some((choice) => choice.id === 'WHATSAPP_API' && choice.variants.includes('WHATSAPP_CLOUD_API')));
  assert.ok(fixture.choices.some((choice) => choice.id === 'WHATSAPP_APP' && choice.variants.includes('WHATSAPP_COEXISTENCE')));
  assert.ok(fixture.choices.some((choice) => choice.id === 'FACEBOOK' && choice.variants.includes('FACEBOOK_LOGIN')));
});

check('FLOW-05', () => {
  assert.ok(spec.includes('Meta ineligibility'));
  assert.ok(spec.includes('não está disponível') || spec.includes('unavailable in this environment'));
});

check('CTX-01', () => {
  assert.ok(fixture.session.tenantRef.startsWith('tenant_fixture_'));
  assert.equal(fixture.session.tenantDisplayName, null, 'fixture preserves the missing safe label gap');
  assert.ok(fixture.connections.every((connection) => connection.tenantRef === fixture.session.tenantRef));
  assert.equal(fixture.session.companySwitcherVisible, false, 'do not render a switcher without a safe company label');
  assert.equal(fixture.session.writeActionsEnabled, false, 'block all writes when the company cannot be identified safely');
  assert.equal(fixture.session.writeBlockReason, 'tenant_display_name_missing');
  assert.deepEqual(fixture.session.blockedTenantWrites, [
    'company_switch', 'onboarding_start', 'asset_refresh', 'reauthorize', 'disconnect',
    'template_create', 'automation_save', 'notification_mark_read', 'notification_dismiss', 'notification_reply'
  ], 'all tenant-scoped mutation families stay blocked without a safe company label');
  assert.ok(spec.includes('Identidade da empresa não confirmada'));
  assert.ok(spec.includes('block all tenant-scoped writes'));
  assert.doesNotMatch(wireframes, /\[trocar\]/);
  assert.ok(wireframes.includes('Alterações indisponíveis até identificar a empresa com segurança'));
  assert.ok(spec.includes('Do not display an arbitrary tenant UUID'));
});

check('CTX-02', () => {
  assert.ok(spec.includes('URL parameter, `cUUID`, browser storage value'));
  assert.ok(spec.includes('block all tenant-scoped writes'));
});

check('COEX-01', () => {
  const coex = fixture.connections.filter((connection) => connection.flowVariant === 'WHATSAPP_COEXISTENCE');
  assert.equal(coex.length, 4, 'four Coexistence connections are represented');
  assert.equal(new Set(coex.map((connection) => connection.id)).size, 4, 'each connection retains its own distinct ref');
  assert.equal(new Set(coex.flatMap((connection) => connection.assets.map((asset) => asset.id))).size, 4);
  const seen = [];
  for (const addition of fixture.coexistenceAdditions) {
    seen.push(addition.createdConnectionRef);
    assert.deepEqual(addition.connectionRefsAfterAdd, seen, `step ${addition.step} appends without replacing prior connections`);
  }
  assert.deepEqual(new Set(seen), new Set(coex.map((connection) => connection.id)));
  assert.ok(spec.includes('later starts append, never overwrite previous refs'));
});

check('STATE-01', () => {
  assert.ok(statusChecks.has('STATE-01'));
  assert.ok(statusRows.slice(1).some((row) => row[statusIndex.server_state_or_condition] === 'loading'));
  assert.ok(wireframes.includes('Loading:'));
});

check('STATE-02', () => {
  assert.ok(statusChecks.has('STATE-02'));
  assert.ok(statusRows.slice(1).some((row) => row[statusIndex.server_state_or_condition] === '200 items empty'));
  assert.ok(wireframes.includes('Empty:'));
});

check('STATE-03', () => {
  assert.ok(statusChecks.has('STATE-03'));
  const errorRow = statusRows.slice(1).find((row) => row[statusIndex.fixture_check] === 'STATE-03');
  assert.ok(errorRow[statusIndex.display_copy_pt_br].includes('Não foi possível'));
  assert.ok(errorRow[statusIndex.notes].includes('Do not render empty'));
});

check('STATE-04', () => {
  const active = fixture.connections.find((connection) => connection.status === 'ACTIVE' && connection.readiness === 'READY');
  assert.ok(active?.observedAt);
  assert.equal(active.stale, false);
  assert.ok(statusChecks.has('STATE-04'));
});

check('STATE-05', () => {
  assert.ok(fixture.connections.some((connection) => connection.status === 'PARTIAL'));
  assert.ok(statusChecks.has('STATE-05'));
  assert.ok(spec.includes('A `PARTIAL` connection remains visible and recoverable.'));
});

check('STATE-06', () => {
  assert.ok(fixture.connections.some((connection) => connection.status === 'REAUTH_REQUIRED'));
  assert.equal(fixture.reauthorization.responseStatus, 202);
  assert.equal(fixture.reauthorization.hasOnboardingRef, false);
  assert.equal(fixture.reauthorization.hasLaunchUrl, false);
  assert.equal(fixture.reauthorization.uiActionEnabled, false);
  assert.ok(statusChecks.has('STATE-06'));
  const reauthState = statusRows.slice(1).find((row) => row[statusIndex.server_state_or_condition] === 'REAUTH_REQUIRED');
  assert.equal(reauthState[statusIndex.primary_action], 'show disabled explanation until safe onboarding launch ref exists');
  assert.equal(reauthState[statusIndex.automatic_retry], 'no');
  assert.ok(statusRows.slice(1).some((row) => row[statusIndex.server_state_or_condition] === 'reauth launch reference unavailable'));
  assert.ok(spec.includes('preserve the prior connection while valid'));
  assert.ok(wireframes.includes('[Reautorizar disabled: etapa de autorização não disponível ainda]'));
  assert.ok(wireframes.includes('[Reautorizar disabled: abertura segura indisponível]'));
  assert.ok(mapRows.slice(1).some((row) => row[mapIndex.trace_id] === 'STATE-06' && row[mapIndex.displayed_data_and_user_effect].includes('keep action disabled')));
});

check('STATE-07', () => {
  assert.ok(fixture.connections.some((connection) => connection.status === 'UNKNOWN' && connection.readiness === 'UNKNOWN'));
  assert.ok(statusChecks.has('STATE-07'));
  assert.ok(statusRows.slice(1).some((row) => row[statusIndex.server_state_or_condition] === 'UNKNOWN or readiness=UNKNOWN' && row[statusIndex.automatic_retry].includes('never')));
});

check('STATE-08', () => {
  assert.ok(fixture.connections.some((connection) => connection.status === 'DISCONNECTED'));
  assert.ok(statusChecks.has('STATE-08'));
});

check('STATE-09', () => {
  assert.ok(fixture.connections.some((connection) => connection.stale === true));
  assert.ok(statusChecks.has('STATE-09'));
  assert.ok(statusRows.slice(1).some((row) => row[statusIndex.server_state_or_condition] === 'stale=true' && row[statusIndex.last_confirmed_display].includes('observedAt')));
});

check('STATE-10/11/12', () => {
  const authStates = new Set(fixture.connections.flatMap((connection) => connection.assets.map((asset) => asset.authorizationStatus)));
  assert.ok(authStates.has('VERIFIED') && authStates.has('REVOKED') && authStates.has('UNKNOWN'));
  assert.ok(statusChecks.has('STATE-10') && statusChecks.has('STATE-11') && statusChecks.has('STATE-12'));
});

check('STATE-13', () => {
  assert.ok(fixture.connections.every((connection) => connection.subscriptionStatus === null));
  assert.ok(statusChecks.has('STATE-13'));
  assert.ok(spec.includes('does not prove a webhook subscription is active'));
  assert.ok(inbox.properties.eventType.enum.includes('provider.unclassified'));
  assert.ok(inbox.properties.routingState.enum.includes('QUARANTINED'));
  assert.ok(outbox.properties.eventType.enum.includes('connection.changed'));
});

check('REC-01', () => {
  const popup = fixture.onboardingCases.find((item) => item.case === 'popup_closed');
  assert.equal(popup.status, 'AWAITING_PROVIDER');
  assert.equal(popup.nextAction, 'CHECK_STATUS');
  assert.equal(popup.providerCodeVisible, false);
  assert.ok(statusChecks.has('REC-01'));
  assert.ok(spec.includes('Closing the popup is an interruption, not proof of cancel or success.'));
});

check('REC-02', () => {
  const cancelled = fixture.onboardingCases.find((item) => item.case === 'user_cancelled');
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.providerCodeVisible, false);
  assert.ok(statusChecks.has('REC-02'));
});

check('REC-03', () => {
  const timeout = fixture.onboardingCases.find((item) => item.case === 'timeout_outcome_unknown');
  assert.equal(timeout.jobStatus, 'UNKNOWN');
  assert.equal(timeout.automaticExternalRetry, false);
  assert.ok(statusChecks.has('REC-03'));
  assert.ok(spec.includes('do not repeat the external effect'));
});

check('REC-04', () => {
  const switched = fixture.onboardingCases.find((item) => item.case === 'company_switched_in_other_tab');
  assert.equal(switched.errorCode, 'CONTEXT_CHANGED');
  assert.equal(switched.writeAllowed, false);
  assert.equal(switched.originalTenantRef, fixture.session.tenantRef);
  assert.ok(statusChecks.has('REC-04'));
});

check('FEATURE-01', () => {
  const feature = fixture.features.templates;
  assert.equal(feature.currentFormHasLanguage, true);
  assert.equal(feature.currentFormHasExamples, true);
  assert.equal(feature.contractAcceptsLanguage, true);
  assert.equal(feature.contractAcceptsExamples, false);
  assert.equal(feature.createEnabled, false, 'must not submit an incompatible reduced payload');
  assert.ok(mapRows.slice(1).some((row) => row[mapIndex.trace_id] === 'FEATURE-01' && row[mapIndex.error_and_retry_boundary].includes('disabled')));
});

check('FEATURE-02', () => {
  assert.equal(fixture.features.automation.staleEtag, true);
  assert.equal(fixture.features.automation.automaticOverwrite, false);
  assert.equal(fixture.features.automation.writeEnabled, false);
  assert.equal(fixture.features.automation.contractFields.length, 2);
  assert.equal(fixture.features.automation.baselineFields.length, 3);
  assert.ok(mapRows.slice(1).some((row) => row[mapIndex.api_operation_and_method].includes('replaceAutomationConfig PATCH')));
});

check('FEATURE-03', () => {
  assert.ok(fixture.features.notifications.actionsReturned.includes('REPLY'));
  assert.equal(fixture.features.notifications.replyStatus, 'PENDING');
  assert.equal(fixture.features.notifications.automaticRepeat, false);
  assert.equal(fixture.features.notifications.currentMessageText, true);
  assert.equal(fixture.features.notifications.contractSafeSummaryOnly, true);
  assert.equal(fixture.features.notifications.authorizedMessageContextAvailable, false);
  assert.equal(fixture.features.notifications.replyEnabled, false);
  const notificationStates = statusRows.slice(1).filter((row) => row[statusIndex.domain] === 'notification');
  const expectedStates = new Map([
    ['FEATURE-03-LOADING', ['loading', 'info', 'Carregando notificações…']],
    ['FEATURE-03-EMPTY', ['200 empty', 'info', 'Nenhuma notificação disponível.']],
    ['FEATURE-03-ERROR', ['read failure', 'error', 'Não foi possível carregar notificações.']]
  ]);
  assert.deepEqual(Object.values(fixture.features.notifications.stateFixtureChecks), [...expectedStates.keys()]);
  for (const [checkId, [condition, severity, copy]] of expectedStates) {
    const row = notificationStates.find((item) => item[statusIndex.fixture_check] === checkId);
    assert.ok(row, `${checkId} has a distinct status matrix row`);
    assert.equal(row[statusIndex.server_state_or_condition], condition);
    assert.equal(row[statusIndex.severity], severity);
    assert.equal(row[statusIndex.display_copy_pt_br], copy);
  }
  assert.equal(notificationStates.filter((row) => expectedStates.has(row[statusIndex.fixture_check])).length, 3);
  assert.ok(mapRows.slice(1).some((row) => row[mapIndex.api_operation_and_method].includes('actOnNotification POST')));
});

check('SEC-01', () => {
  const forbidden = /"(?:accessToken|appSecret|authorizationCode|credential|password|rawProviderPayload)"\s*:/i;
  assert.doesNotMatch(JSON.stringify(fixture), forbidden);
  const strings = allStrings(fixture);
  assert.ok(strings.every((value) => !/[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(value)), 'no UUIDs or operational IDs in fixtures');
  assert.equal(fixture.providerCalls, 0);
  assert.equal(fixture.productionWrites, 0);
  assert.equal(fixture.secretsIncluded, false);
});

check('MAP-01', () => {
  for (const [index, row] of statusRows.entries()) assert.equal(row.length, statusHeader.length, `status CSV row ${index + 1} has the header width`);
  for (const [index, row] of mapRows.entries()) assert.equal(row.length, mapHeader.length, `screen/API CSV row ${index + 1} has the header width`);
  assert.ok(statusHeader.includes('server_state_or_condition'));
  assert.ok(statusHeader.includes('display_copy_pt_br'));
  assert.ok(statusHeader.includes('severity'));
  assert.ok(statusHeader.includes('primary_action'));
  assert.ok(statusHeader.includes('automatic_retry'));
  assert.ok(statusHeader.includes('last_confirmed_display'));
  assert.ok(mapHeader.includes('server_context_and_authorization_gate'));
  assert.ok(mapHeader.includes('automated_or_manual_check'));
  assert.ok(mapRows.length > 15, 'screen/API/test map covers all portal regions');
  assert.ok(mappedTraceIds.has('ENTRY-01') && mappedTraceIds.has('ENTRY-03') && mappedTraceIds.has('FEATURE-03'));
});

check('A11Y-01/02', () => {
  for (const source of [
    'https://www.w3.org/TR/WCAG22/',
    'https://www.w3.org/WAI/tutorials/forms/labels/',
    'https://www.w3.org/WAI/tutorials/forms/instructions/'
  ]) assert.ok(spec.includes(source), `${source} is cited`);
  assert.ok(wireframes.includes('[Cancelar]'));
  assert.ok(spec.includes('focus') && spec.includes('Escape'));
  assert.ok(spec.includes('WCAG 2.2 SC 2.5.8 AA'));
  assert.ok(spec.includes('24×24 CSS px'));
  assert.ok(wireframes.includes('24×24 CSS px minimum'));
  for (const control of ['[Conectar disabled:', '[Adicionar conexão disabled:', '[Atualizar disabled:', '[Desconectar disabled:', '[Solicitar desconexão disabled:', '[Cancelar disabled sem identidade]', 'Mutation actions disabled']) {
    assert.ok(wireframes.includes(control), `${control} is visibly gated in the no-label wireframe`);
  }
  assert.ok(spec.includes('spacing, inline, user-agent control, or essential'));
});

const failures = checks.filter((item) => item.status === 'FAIL');
for (const item of checks) {
  const suffix = item.message ? ` — ${item.message}` : '';
  process.stdout.write(`${item.status} ${item.id}${suffix}\n`);
}
process.stdout.write(`\nM1.08 synthetic walkthrough: ${checks.length - failures.length}/${checks.length} checks passed; fixtures only; provider calls=0; production writes=0.\n`);
if (failures.length > 0) process.exitCode = 1;
