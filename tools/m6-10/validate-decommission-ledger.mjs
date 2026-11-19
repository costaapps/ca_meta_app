import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ledgerPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/delivery/M6/M6.10-legacy-ledger.structural.json');
const expectedDomains = [
  'legacy_routes_and_rewrites',
  'callbacks_webhooks_and_subscriptions',
  'cron_and_scheduled_jobs',
  'general_settings_and_global_token_sources',
  'global_token_consumers',
  'client_tenant_and_legacy_consumers',
  'four_flow_and_multi_number_acceptance',
  'observation_window_and_staged_disable',
  'meta_asset_non_deletion',
  'backup_contract_and_recovery',
  'retention_and_hosting_disposition',
  'support_ownership_and_milestone_acceptance',
];
const shaPattern = /^[0-9a-f]{40}$/;
const expectedStartingBase = '3da17eff8fe2fdeb914013c895744716fec8fd6e';
const expectedBase = 'e3ad62659097c9b7611fe4b176bbd7d4a8a14f23';
const errors = [];
const fail = (message) => errors.push(message);

let ledger;
try {
  const raw = await readFile(ledgerPath, 'utf8');
  ledger = JSON.parse(raw.replace(/^\uFEFF/, ''));
} catch (error) {
  console.error(`Cannot read/parse structural ledger: ${error.message}`);
  process.exitCode = 1;
}

if (ledger) {
  if (ledger.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (ledger.packageId !== 'M6.10') fail('packageId must be M6.10');
  if (ledger.issue?.number !== 75 || ledger.issue?.stateAtPreparation !== 'open') fail('issue #75 must remain recorded as open');
  if (ledger.startingBaseCommit !== expectedStartingBase || ledger.baseCommit !== expectedBase || !shaPattern.test(ledger.baseCommit ?? '')) fail('starting and synchronized milestone bases must match the observed history');
  const m608 = ledger.milestoneDependencies?.m6_08;
  if (m608?.pr !== 173 || m608.prHeadSha !== 'acf2cf53fc55743d30d9217bc72e4f50ee3faaa7' || m608.milestoneSha !== '81e22140086167209d8b1d2bf6908b399794defa' || m608.rolloutExecuted !== false || m608.acceptance !== 'Not confirmed') fail('M6.08 preparation/integration reference or external gate is inaccurate');
  const m609 = ledger.milestoneDependencies?.m6_09;
  if (m609?.pr !== 174 || m609.prHeadSha !== '40dd4aec38386746d249cfa8d8794a0b1bd4671a' || m609.milestoneSha !== expectedBase || m609.operationalRunStarted !== false || m609.acceptance !== 'Not confirmed') fail('M6.09 preparation/integration reference or external gate is inaccurate');
  if (ledger.recordType !== 'structural-preparation-only') fail('recordType must remain structural-preparation-only');
  if (ledger.liveInventoryPerformed !== false) fail('liveInventoryPerformed must be false');
  if (ledger.retirementAuthorized !== false) fail('retirementAuthorized must be false');
  if (ledger.externalActionsPerformed !== false) fail('externalActionsPerformed must be false');
  if (typeof ledger.claimBoundary !== 'string' || !ledger.claimBoundary.includes('no live')) fail('claimBoundary must state that no live findings are included');
  if (!Array.isArray(ledger.sourceDocuments) || ledger.sourceDocuments.length === 0) fail('sourceDocuments must identify planning sources');
  if (!Array.isArray(ledger.evidenceDomains)) {
    fail('evidenceDomains must be an array');
  } else {
    const foundIds = ledger.evidenceDomains.map((entry) => entry?.id);
    const duplicates = foundIds.filter((id, index) => foundIds.indexOf(id) !== index);
    if (duplicates.length) fail(`duplicate evidence domain IDs: ${[...new Set(duplicates)].join(', ')}`);
    for (const id of expectedDomains) {
      if (!foundIds.includes(id)) fail(`missing required evidence domain: ${id}`);
    }
    for (const id of foundIds) {
      if (!expectedDomains.includes(id)) fail(`unexpected evidence domain: ${id}`);
    }
    if (ledger.evidenceDomains.length !== expectedDomains.length) fail(`expected exactly ${expectedDomains.length} evidence domains`);
    for (const entry of ledger.evidenceDomains) {
      if (entry?.status !== 'Not confirmed') fail(`${entry?.id ?? '(unnamed domain)'} must remain Not confirmed`);
      if (entry?.ownerAssignmentStatus !== 'Not confirmed') fail(`${entry?.id ?? '(unnamed domain)'} owner assignment must remain Not confirmed`);
      if (!Array.isArray(entry?.ownerRoles) || entry.ownerRoles.length === 0 || entry.ownerRoles.some((role) => typeof role !== 'string' || !role.trim())) {
        fail(`${entry?.id ?? '(unnamed domain)'} must list candidate functional roles`);
      }
      if (!Array.isArray(entry?.requiredEvidence) || entry.requiredEvidence.length === 0 || entry.requiredEvidence.some((item) => typeof item !== 'string' || !item.trim())) {
        fail(`${entry?.id ?? '(unnamed domain)'} must specify evidence to collect`);
      }
      if (!Array.isArray(entry?.evidenceRefs) || entry.evidenceRefs.length !== 0) {
        fail(`${entry?.id ?? '(unnamed domain)'} must not contain operational evidence references in this structural package`);
      }
    }
  }
}

if (errors.length) {
  console.error('M6.10 structural ledger invalid:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else if (ledger) {
  console.log(`M6.10 structural ledger valid: ${ledger.evidenceDomains.length} domains; all Not confirmed; retirementAuthorized=false; issue #75 recorded open.`);
}
