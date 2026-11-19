import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const shaPattern = /^[0-9a-f]{40}$/;
const requiredAcceptance = [
  'sloObservedForOwnerRatifiedWindow',
  'noUnownedStalledJobsOrProjections',
  'runbooksReproducedByAnotherOperator',
  'userManagesConnectionsWithoutSecretsOrManualSql',
  'legacyAndGlobalTokenDependenciesInventoried',
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function validateOperationsLedger(ledger) {
  requireValue(ledger && typeof ledger === 'object' && !Array.isArray(ledger), 'Operations ledger must be a JSON object.');
  requireValue(ledger.formatVersion === 1 && ledger.package === 'M6.09', 'Unsupported operations ledger version or package.');
  requireValue(ledger.status === 'preparation-only' && ledger.evidenceMode === 'structural-only', 'Ledger must remain structural preparation only.');
  requireValue(ledger.operationalRunStarted === false && ledger.deploymentReady === false, 'No production operation or readiness may be claimed.');
  requireValue(ledger.source?.milestoneBranch === 'desktop/milestone-m6' && shaPattern.test(ledger.source?.milestoneBaseSha), 'Milestone base reference is invalid.');
  requireValue(ledger.source?.releaseCandidateRevision === null && ledger.source?.releaseManifestRef === null, 'No release candidate identity is available.');

  requireValue(ledger.owners?.status === 'Not confirmed', 'Operational owners must remain Not confirmed.');
  for (const owner of ['operations', 'support', 'security', 'product']) {
    requireValue(ledger.owners[owner] === null, `${owner} owner must not be invented.`);
  }

  const hypercare = ledger.hypercare;
  requireValue(hypercare?.status === 'Not confirmed' && hypercare.issueProposedMinimumDays === 7, 'Hypercare status or issue proposal changed.');
  for (const field of ['approvedStartAt', 'approvedEndAt', 'observedDurationDays', 'coverageScheduleRef']) {
    requireValue(hypercare[field] === null, `Hypercare field ${field} must remain unset.`);
  }
  requireValue(Array.isArray(hypercare.observations) && hypercare.observations.length === 0, 'No real hypercare observations may be fabricated.');

  const slo = ledger.slo;
  requireValue(slo?.ratified === false && slo.window === null && slo.ownerReference === null && slo.status === 'Not confirmed', 'SLO ratification, window and owner must remain Not confirmed.');
  for (const metric of Object.values(slo.metricEvidence ?? {})) {
    requireValue(metric.observedValue === null && metric.status === 'Not confirmed' && metric.evidenceReferences?.length === 0, 'SLO observations must remain empty until verified.');
  }

  requireValue(ledger.operations?.incidentHistoryStatus === 'Not confirmed' && ledger.operations.status === 'Not confirmed', 'An empty incident list must not imply an incident-free operation.');
  requireValue(ledger.operations.incidentRecords?.length === 0 && ledger.operations.routineObservations?.length === 0, 'Operational records must remain empty.');
  for (const field of ['stalledJobCount', 'unownedJobCount', 'stalledProjectionCount']) {
    requireValue(ledger.operations[field] === null, `${field} cannot be reported without production observations.`);
  }
  requireValue(ledger.operations.queueAndProjectionStatus === 'Not confirmed', 'Queue and projection health must remain Not confirmed.');

  requireValue(ledger.support?.status === 'Not confirmed' && ledger.support.userGuideStatus === 'Not confirmed', 'User guide and support workflow require real review.');
  requireValue(ledger.support.supportRunbookStatus === 'draft-only', 'Support material cannot be represented as exercised.');
  for (const field of ['authorizedUserReviewReference', 'secondOperatorReviewReference', 'ticketingRouteReference']) {
    requireValue(ledger.support[field] === null, `Support field ${field} must remain unassigned.`);
  }
  requireValue(ledger.support.unknownDeliveryOutcomeMayBeRetried === false, 'Unknown delivery outcomes must not be replayed.');

  requireValue(ledger.adoption?.status === 'Not confirmed' && ledger.adoption.evidenceReferences?.length === 0, 'Adoption evidence must remain Not confirmed.');
  for (const measurement of Object.values(ledger.adoption.measurements ?? {})) {
    requireValue(measurement === null, 'Adoption values must not be invented.');
  }
  requireValue(ledger.legacyDependencies?.status === 'Not confirmed', 'Legacy dependency inventory must remain Not confirmed.');
  for (const field of ['hostingerRouteInventoryReference', 'callbackAndCronInventoryReference', 'globalTokenConsumerInventoryReference', 'retirementDecisionReference']) {
    requireValue(ledger.legacyDependencies[field] === null, `Legacy inventory field ${field} must remain unset.`);
  }

  requireValue(Object.keys(ledger.acceptance ?? {}).length === requiredAcceptance.length, 'Acceptance criteria inventory is incomplete.');
  for (const criterion of requiredAcceptance) {
    requireValue(ledger.acceptance[criterion] === 'Not confirmed', `${criterion} must remain Not confirmed.`);
  }
  requireValue(ledger.dependencies?.m6_04?.productionReceiverAndSloRatification === 'Not confirmed', 'M6.04 external evidence is still a gate.');
  requireValue(ledger.dependencies?.m6_05?.productionBackupKeyCustodyAndIndependentRestore === 'Not confirmed', 'M6.05 external evidence is still a gate.');
  requireValue(ledger.dependencies?.m6_08?.integrationAndRealRollback === 'Not confirmed', 'M6.08 real canary/rollback evidence is still a gate.');
  return { operationalRunStarted: false, deploymentReady: false, acceptanceCriteria: requiredAcceptance.length };
}

function expectReject(label, action) {
  try {
    action();
  } catch {
    return `${label}: rejected`;
  }
  throw new Error(`${label}: unsupported operational claim was accepted.`);
}

export async function runOperationsLedgerValidation(path = resolve('docs/delivery/M6/M6.09-operations-ledger.structural.json')) {
  const ledger = JSON.parse(await readFile(path, 'utf8'));
  const result = validateOperationsLedger(ledger);
  const cases = ['preparation ledger remains inactive: pass'];

  const windowClaim = structuredClone(ledger);
  windowClaim.hypercare.approvedStartAt = '2026-11-18T00:00:00Z';
  cases.push(expectReject('invented hypercare window', () => validateOperationsLedger(windowClaim)));

  const incidentClaim = structuredClone(ledger);
  incidentClaim.operations.incidentRecords.push({ id: 'incident-1' });
  cases.push(expectReject('fabricated incident record', () => validateOperationsLedger(incidentClaim)));

  const sloClaim = structuredClone(ledger);
  sloClaim.slo.ratified = true;
  cases.push(expectReject('unapproved SLO ratification', () => validateOperationsLedger(sloClaim)));

  const ownerClaim = structuredClone(ledger);
  ownerClaim.owners.operations = 'on-call';
  cases.push(expectReject('invented operations owner', () => validateOperationsLedger(ownerClaim)));

  const adoptionClaim = structuredClone(ledger);
  adoptionClaim.adoption.measurements.activeUsers = 1;
  cases.push(expectReject('fabricated adoption count', () => validateOperationsLedger(adoptionClaim)));

  return { ...result, cases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runOperationsLedgerValidation(process.argv[2] ? resolve(process.argv[2]) : undefined);
    console.log(`M6.09 structural operations validation passed: ${result.cases.join('; ')}. Hypercare, SLOs, incidents, adoption and owners remain Not confirmed.`);
  } catch (error) {
    console.error(`M6.09 operations ledger rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
