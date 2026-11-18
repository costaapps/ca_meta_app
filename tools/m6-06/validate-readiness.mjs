import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const expectedGates = [
  'infrastructure-and-ownership',
  'dns-tls-network-and-ingress',
  'database-queue-capacity-and-schema-compatibility',
  'secret-store-and-service-account-ownership',
  'immutable-image-digests-sbom-provenance-and-scans',
  'github-staging-and-production-environments-and-gates',
  'callbacks-webhooks-privacy-and-revocation-routes',
  'meta-flow-permissions-eligibility-and-test-assets',
  'm6-01-through-m6-05-integrated-and-revalidated',
  'previous-manifest-backup-and-rollback-evidence',
  'product-security-and-operations-go-no-go',
  'promotion-operator-and-auditable-trail',
];
const expectedPackages = new Map([
  ['M6.01', { issue: 69, pr: 170 }],
  ['M6.02', { issue: 70, pr: 167 }],
  ['M6.03', { issue: 66, pr: 168 }],
  ['M6.04', { issue: 67, pr: 169 }],
  ['M6.05', { issue: 68, pr: 171 }],
]);
const shaPattern = /^[0-9a-f]{40}$/;
const hex256Pattern = /^[0-9a-f]{64}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function validateReadiness(pack) {
  requireValue(pack && typeof pack === 'object' && !Array.isArray(pack), 'Readiness pack must be a JSON object.');
  requireValue(pack.formatVersion === 1 && pack.package === 'M6.06', 'Unsupported readiness pack version or package.');
  requireValue(pack.status === 'preparation-only', 'Readiness status must remain preparation-only.');
  requireValue(pack.deploymentReady === false, 'deploymentReady must remain false in a local preparation pack.');
  requireValue(pack.source?.milestoneBranch === 'desktop/milestone-m6', 'Milestone branch reference is missing.');
  requireValue(shaPattern.test(pack.source?.milestoneBaseSha), 'Milestone base must be a full Git SHA.');
  requireValue(pack.source?.releaseCommit === null && pack.source?.releaseTag === null && pack.source?.releaseId === null, 'No production release identity may be inferred from package candidates.');
  requireValue(pack.source?.releaseManifestSha256 === null, 'No real release manifest checksum is available in this preparation pack.');
  requireValue(pack.source?.candidateReferencesAreNonBinding === true, 'Package PR references must be explicitly non-binding.');

  requireValue(Array.isArray(pack.candidatePullRequests) && pack.candidatePullRequests.length === expectedPackages.size, 'Candidate PR inventory must list M6.01 through M6.05 exactly once.');
  const candidates = new Map();
  for (const candidate of pack.candidatePullRequests) {
    const expected = expectedPackages.get(candidate.package);
    requireValue(expected && !candidates.has(candidate.package), 'Candidate PR inventory contains an unknown or duplicate package.');
    requireValue(candidate.issue === expected.issue && candidate.pr === expected.pr, `${candidate.package} PR/issue identity is invalid.`);
    requireValue(typeof candidate.branch === 'string' && candidate.branch === `desktop/${candidate.package.toLowerCase().replace('.', '-')}`, `${candidate.package} branch is invalid.`);
    requireValue(shaPattern.test(candidate.headSha), `${candidate.package} head must be a full Git SHA.`);
    requireValue(candidate.state === 'open', `${candidate.package} reference must remain labeled as an open, non-integrated PR.`);
    candidates.set(candidate.package, candidate);
  }
  requireValue([...expectedPackages.keys()].every((name) => candidates.has(name)), 'A required candidate package reference is missing.');

  requireValue(pack.targets && typeof pack.targets === 'object', 'Environment targets are missing.');
  for (const environment of ['staging', 'production']) {
    requireValue(pack.targets[environment]?.status === 'Not confirmed', `${environment} target must remain Not confirmed.`);
    requireValue(Array.isArray(pack.targets[environment]?.resourceReferences) && pack.targets[environment].resourceReferences.length === 0, `${environment} must not contain unverified resource references.`);
  }

  for (const imageName of ['web', 'api']) {
    const image = pack.images?.[imageName];
    requireValue(image && image.digest === null && image.sourceRevision === null, `${imageName} image publication evidence must remain absent.`);
    for (const field of ['sbomSha256', 'provenanceSha256', 'scanResultsSha256']) {
      requireValue(image[field] === null || hex256Pattern.test(image[field]), `${imageName}.${field} must be null or a SHA-256 digest.`);
    }
    requireValue(image.sbomSha256 === null && image.provenanceSha256 === null && image.scanResultsSha256 === null, `${imageName} must not claim unattested release evidence.`);
  }
  requireValue(pack.images?.worker?.mustUseApiDigest === true && pack.images.worker.digest === null, 'Worker digest must remain unassigned until it is bound to the API image digest.');

  requireValue(pack.databaseSchema?.targetVersion === null && pack.databaseSchema?.minCompatible === null && pack.databaseSchema?.maxCompatible === null, 'Schema compatibility must not be guessed.');
  requireValue(pack.databaseSchema?.migrationPreflight === 'Not confirmed', 'Migration preflight must remain Not confirmed.');

  requireValue(Array.isArray(pack.gates) && pack.gates.length === expectedGates.length, 'Required promotion gate inventory is incomplete.');
  const gates = new Map();
  for (const gate of pack.gates) {
    requireValue(expectedGates.includes(gate.id) && !gates.has(gate.id), 'Promotion gates contain an unknown or duplicate gate.');
    requireValue(gate.status === 'Not confirmed', `${gate.id} cannot be promoted by a static readiness descriptor.`);
    requireValue(Array.isArray(gate.evidence) && gate.evidence.length === 0, `${gate.id} contains evidence references not verified by this pack.`);
    gates.set(gate.id, gate);
  }
  requireValue(expectedGates.every((id) => gates.has(id)), 'One or more required promotion gates are missing.');

  requireValue(pack.rollback?.status === 'Not confirmed', 'Rollback status must remain Not confirmed.');
  for (const field of ['previousManifestSha256', 'backupReference', 'restoreEvidence', 'operatorReference', 'auditTrailReference']) {
    requireValue(pack.rollback[field] === null, `Rollback field ${field} must remain empty until evidenced in the authorized environment.`);
  }
  return { status: pack.status, deploymentReady: pack.deploymentReady, gateCount: pack.gates.length, candidateCount: pack.candidatePullRequests.length };
}

function expectReject(label, action) {
  try {
    action();
  } catch {
    return `${label}: rejected`;
  }
  throw new Error(`${label}: unsafe readiness mutation was accepted.`);
}

export async function runReadinessValidation(path = resolve('docs/delivery/M6/release-readiness.json')) {
  const pack = JSON.parse(await readFile(path, 'utf8'));
  const validated = validateReadiness(pack);
  const cases = ['readiness ledger remains blocked: pass'];

  const enabled = structuredClone(pack);
  enabled.deploymentReady = true;
  cases.push(expectReject('deployment readiness promotion', () => validateReadiness(enabled)));

  const verifiedGate = structuredClone(pack);
  verifiedGate.gates[0].status = 'Verified';
  cases.push(expectReject('unverified external gate promotion', () => validateReadiness(verifiedGate)));

  const inventedDigest = structuredClone(pack);
  inventedDigest.images.api.digest = `sha256:${'a'.repeat(64)}`;
  cases.push(expectReject('invented API image digest', () => validateReadiness(inventedDigest)));

  const rollbackClaim = structuredClone(pack);
  rollbackClaim.rollback.backupReference = 'backup-123';
  cases.push(expectReject('unverified rollback backup claim', () => validateReadiness(rollbackClaim)));

  return { ...validated, cases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runReadinessValidation(process.argv[2] ? resolve(process.argv[2]) : undefined);
    console.log(`M6.06 local readiness validation passed: ${result.cases.join('; ')}. ${result.gateCount} external gates remain Not confirmed; deploymentReady=false.`);
  } catch (error) {
    console.error(`M6.06 readiness validation rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
