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
  ['M6.01', { issue: 69, pr: 170, headSha: '7b9930622369b6ee68a2903c3b1bf4ff80eb8e03', state: 'merged', milestoneSha: 'a856bf4319519d75c1c02907afbfb477a453bf08', runId: 44389497887, checkStatus: 'success' }],
  ['M6.02', { issue: 70, pr: 167, headSha: '9a67dff70e437c1bdf52445198493c30fd9886c8', state: 'blocked', milestoneSha: null, runId: 44398836758, checkStatus: 'failure' }],
  ['M6.03', { issue: 66, pr: 168, headSha: '251bc7c392b1d796d7365310a452792865d611b9', state: 'merged', milestoneSha: '5629ff9f81401f673ef91d2de5de5e1faadaf7eb', runId: 44398162113, checkStatus: 'success' }],
  ['M6.04', { issue: 67, pr: 169, headSha: 'faa0a8745b66742b5aaf8648fa53ecb530883901', state: 'merged', milestoneSha: '42f0a4d32edd33c6a47a32f1e260481adaa4afd6', runId: 44399644424, checkStatus: 'success' }],
  ['M6.05', { issue: 68, pr: 171, headSha: 'bcf9fc0314ec7480179aef3dc1209c1a4bcea62d', state: 'merged', milestoneSha: '3da17eff8fe2fdeb914013c895744716fec8fd6e', runId: 44400610909, checkStatus: 'success' }],
]);
const shaPattern = /^[0-9a-f]{40}$/;
const hex256Pattern = /^[0-9a-f]{64}$/;
const currentMilestoneBaseSha = '05ab14af8638e11e2dd99a39b06fe4fb0f50e0d8';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function validateReadiness(pack) {
  requireValue(pack && typeof pack === 'object' && !Array.isArray(pack), 'Readiness pack must be a JSON object.');
  requireValue(pack.formatVersion === 1 && pack.package === 'M6.06', 'Unsupported readiness pack version or package.');
  requireValue(pack.status === 'preparation-only', 'Readiness status must remain preparation-only.');
  requireValue(pack.deploymentReady === false, 'deploymentReady must remain false in a local preparation pack.');
  requireValue(pack.source?.milestoneBranch === 'desktop/milestone-m6', 'Milestone branch reference is missing.');
  requireValue(pack.source?.milestoneBaseSha === currentMilestoneBaseSha && shaPattern.test(pack.source.milestoneBaseSha), 'Milestone base must match the observed current package base SHA.');
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
    requireValue(candidate.headSha === expected.headSha && shaPattern.test(candidate.headSha), `${candidate.package} must identify the observed PR head SHA.`);
    requireValue(candidate.state === expected.state && candidate.milestoneSha === expected.milestoneSha, `${candidate.package} integration/blocker state is inaccurate.`);
    requireValue(candidate.requiredCheck?.runId === expected.runId && candidate.requiredCheck?.status === expected.checkStatus, `${candidate.package} required-check evidence is inaccurate.`);
    if (candidate.package === 'M6.02') {
      requireValue(typeof candidate.note === 'string' && candidate.note.includes('moderate dev-only'), 'M6.02 must state the current required-check blocker.');
    }
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

  const m602Claim = structuredClone(pack);
  const blockedCandidate = m602Claim.candidatePullRequests.find((candidate) => candidate.package === 'M6.02');
  blockedCandidate.state = 'merged';
  blockedCandidate.milestoneSha = 'a856bf4319519d75c1c02907afbfb477a453bf08';
  cases.push(expectReject('blocked M6.02 integration claim', () => validateReadiness(m602Claim)));

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
