import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const requiredJourneys = new Map([
  ['FACEBOOK', ['FACEBOOK_LOGIN']],
  ['INSTAGRAM', ['INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN']],
  ['WHATSAPP_EXCLUSIVE', ['WHATSAPP_CLOUD_API']],
  ['WHATSAPP_COEXISTENCE', ['WHATSAPP_COEXISTENCE']],
]);
const requiredFunctions = [
  'CONFIGURATION',
  'CREDENTIAL_REFERENCE',
  'LEGACY_PROJECTION',
  'OPERATION_RELAY',
  'WEBHOOK_DISPATCH',
];
const allowedOwners = ['LEGACY', 'CENTRAL', 'PROJECTOR', 'RELAY', 'NEW'];
const shaPattern = /^[0-9a-f]{40}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function validateLedger(ledger) {
  requireValue(ledger && typeof ledger === 'object' && !Array.isArray(ledger), 'Rollout ledger must be a JSON object.');
  requireValue(ledger.formatVersion === 1 && ledger.package === 'M6.08', 'Unsupported rollout ledger version or package.');
  requireValue(ledger.status === 'preparation-only' && ledger.evidenceMode === 'structural-only', 'Ledger must remain structural preparation only.');
  requireValue(ledger.rolloutExecuted === false && ledger.deploymentReady === false, 'A local ledger cannot claim a canary or deployment is ready.');
  requireValue(ledger.source?.milestoneBranch === 'desktop/milestone-m6' && shaPattern.test(ledger.source?.milestoneBaseSha), 'Milestone source reference is invalid.');
  for (const field of ['releaseCandidateRevision', 'releaseManifestRef', 'releaseManifestSha256']) {
    requireValue(ledger.source[field] === null, `Release candidate field ${field} must remain unassigned.`);
  }

  requireValue(ledger.owners?.status === 'Not confirmed', 'Functional owners must remain Not confirmed until assigned.');
  for (const role of ['product', 'security', 'operations', 'incidentCommander']) {
    requireValue(ledger.owners[role] === null, `${role} owner must not be fabricated.`);
  }
  requireValue(Object.values(ledger.preconditions ?? {}).length > 0 && Object.values(ledger.preconditions).every((status) => status === 'Not confirmed'), 'Every external prerequisite must remain Not confirmed.');

  const scopeKeys = ['tenantRef', 'channelFamily', 'consumerKind'];
  requireValue(JSON.stringify(ledger.cohortPlan?.scopeKeys) === JSON.stringify(scopeKeys), 'Cohort scope must be tenant/channel/consumer specific.');
  requireValue(ledger.cohortPlan?.percentage === null && ledger.cohortPlan?.cohorts?.length === 0, 'No random percentage or real cohort may be invented.');
  requireValue(ledger.cohortPlan?.status === 'Not confirmed', 'No cohort phase may be treated as executed.');

  const journeys = ledger.requiredCoverage?.journeys;
  requireValue(Array.isArray(journeys) && journeys.length === requiredJourneys.size, 'All four flow families must be represented separately.');
  for (const [family, variants] of requiredJourneys) {
    const journey = journeys.find((entry) => entry.channelFamily === family);
    requireValue(journey && JSON.stringify(journey.contractVariants) === JSON.stringify(variants), `${family} contract variants are missing or mixed.`);
    requireValue(journey.enabledForCanary === false && journey.credentialChangeAllowed === false, `${family} must remain disabled without credential changes.`);
    requireValue(Array.isArray(journey.assetReferences) && journey.assetReferences.length === 0 && journey.status === 'Not confirmed', `${family} cannot claim real asset or canary evidence.`);
  }
  requireValue(ledger.requiredCoverage.coexistenceNumberRequirement?.requiredDistinctNumbers === 4, 'The Coexistence requirement must preserve four distinct numbers.');
  requireValue(ledger.requiredCoverage.coexistenceNumberRequirement?.numberReferences?.length === 0 && ledger.requiredCoverage.coexistenceNumberRequirement.status === 'Not confirmed', 'Real Coexistence numbers or evidence must not be fabricated.');

  requireValue(ledger.flags?.defaultEnabled === false && ledger.flags?.entries?.length === 0, 'Flags must remain disabled and unassigned.');
  requireValue(ledger.flags?.status === 'Not confirmed' && ledger.flags.actorReference === null && ledger.flags.auditRecordReference === null, 'Flag ownership and audit evidence are not confirmed.');

  const matrix = ledger.writerMatrix;
  requireValue(JSON.stringify(matrix?.allowedOwners) === JSON.stringify(allowedOwners), 'Writer owner vocabulary differs from the M5.09 contract.');
  requireValue(JSON.stringify((matrix?.functions ?? []).map((entry) => entry.functionName)) === JSON.stringify(requiredFunctions), 'The M5.09 writer function inventory is incomplete or reordered.');
  for (const entry of matrix.functions) {
    requireValue(entry.currentOwner === null && entry.targetOwner === null && entry.phase === null && entry.version === null && entry.status === 'Not confirmed', `${entry.functionName} writer assignment must remain unresolved.`);
  }
  requireValue(matrix.cohortAssignments?.length === 0 && matrix.status === 'Not confirmed', 'Writer matrix cannot claim an active cohort.');
  requireValue(matrix.unknownWriterBlocksExpansion === true && matrix.credentialAction === 'NONE' && matrix.grantAction === 'NONE', 'Unknown writer or credential/grant mutation must block rollout.');

  requireValue(ledger.monitoring?.status === 'Not confirmed' && ledger.monitoring.ownerReference === null && ledger.monitoring.evidenceReferences?.length === 0, 'Monitoring owner/evidence must remain Not confirmed.');
  requireValue(Object.values(ledger.monitoring?.thresholds ?? {}).length > 0 && Object.values(ledger.monitoring.thresholds).every((value) => value === null), 'Unratified SLO thresholds and windows must not be guessed.');
  requireValue(ledger.abort?.status === 'Not confirmed' && ledger.abort.operatorReference === null && ledger.abort.evidenceReferences?.length === 0, 'Abort evidence and ownership must remain Not confirmed.');
  for (const trigger of ['CROSS_TENANT_ACCESS', 'SECRET_DISCLOSURE', 'DOUBLE_SEND']) {
    requireValue(ledger.abort.immediateTriggers.includes(trigger), `Immediate abort trigger ${trigger} is missing.`);
  }
  requireValue(ledger.abort.unknownWriterBlocksExpansion === true && ledger.abort.sloThresholdsRatified === false, 'Expansion must fail closed on unknown writers or unratified thresholds.');

  const rollback = ledger.rollback;
  requireValue(rollback?.status === 'Not confirmed', 'Rollback cannot be claimed without an authorized rehearsal.');
  for (const field of ['previousManifestSha256', 'backupReference', 'restoreEvidenceReference', 'operatorReference', 'auditTrailReference', 'rpo', 'rto', 'externalEffectsReconciled']) {
    requireValue(rollback[field] === null, `Rollback field ${field} must remain unassigned.`);
  }
  requireValue(rollback.preserveUnmigratedLegacyCohorts === true && rollback.replayUnknownOutcome === false, 'Rollback must preserve unmigrated legacy and must not replay unknown outcomes.');
  requireValue(rollback.credentialAction === 'NONE' && rollback.grantAction === 'NONE' && rollback.subscriptionAction === 'NONE', 'Rollback must not mutate credentials, grants or subscriptions.');
  for (const rows of ['cohortDecisions', 'abortEvents', 'rollbackEvents', 'expansionApprovals']) {
    requireValue(ledger.ledger?.[rows]?.length === 0, `${rows} must be empty until real evidence exists.`);
  }
  requireValue(ledger.ledger?.status === 'Not confirmed', 'The operational rollout ledger must remain Not confirmed.');
  return { rolloutExecuted: false, deploymentReady: false, journeyFamilies: journeys.length, coexistenceNumbersRequired: 4, writerFunctions: matrix.functions.length };
}

function expectReject(label, action) {
  try {
    action();
  } catch {
    return `${label}: rejected`;
  }
  throw new Error(`${label}: unsafe ledger mutation was accepted.`);
}

export async function runRolloutValidation(path = resolve('docs/delivery/M6/M6.08-rollout-ledger.structural.json')) {
  const ledger = JSON.parse(await readFile(path, 'utf8'));
  const result = validateLedger(ledger);
  const cases = ['structural rollout ledger remains inactive: pass'];

  const enabled = structuredClone(ledger);
  enabled.rolloutExecuted = true;
  cases.push(expectReject('canary execution claim', () => validateLedger(enabled)));

  const activeFlag = structuredClone(ledger);
  activeFlag.flags.entries.push({ tenantRef: 'customer-uuid', channelFamily: 'FACEBOOK', consumerKind: 'PORTAL', enabled: true });
  cases.push(expectReject('unverified scoped flag activation', () => validateLedger(activeFlag)));

  const assignedWriter = structuredClone(ledger);
  assignedWriter.writerMatrix.functions[0].currentOwner = 'LEGACY';
  cases.push(expectReject('unverified writer ownership claim', () => validateLedger(assignedWriter)));

  const guessedThreshold = structuredClone(ledger);
  guessedThreshold.monitoring.thresholds.errorRate = 0.01;
  cases.push(expectReject('unratified SLO threshold', () => validateLedger(guessedThreshold)));

  return { ...result, cases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runRolloutValidation(process.argv[2] ? resolve(process.argv[2]) : undefined);
    console.log(`M6.08 structural rollout validation passed: ${result.cases.join('; ')}. All external evidence remains Not confirmed; no cohort, flag or writer assignment was activated.`);
  } catch (error) {
    console.error(`M6.08 rollout ledger rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
