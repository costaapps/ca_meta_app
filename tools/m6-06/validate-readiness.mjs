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
  ['M6.02', { issue: 70, pr: 167, headSha: 'd782276361424aa63fdfc3e8802494ff6b4fdb0a', state: 'merged', milestoneSha: '83364168b0dfbe0404cf8dae100ae1d51a07ba84', runId: 44584757470, checkStatus: 'success' }],
  ['M6.03', { issue: 66, pr: 168, headSha: '251bc7c392b1d796d7365310a452792865d611b9', state: 'merged', milestoneSha: '5629ff9f81401f673ef91d2de5de5e1faadaf7eb', runId: 44398162113, checkStatus: 'success' }],
  ['M6.04', { issue: 67, pr: 169, headSha: 'faa0a8745b66742b5aaf8648fa53ecb530883901', state: 'merged', milestoneSha: '42f0a4d32edd33c6a47a32f1e260481adaa4afd6', runId: 44399644424, checkStatus: 'success' }],
  ['M6.05', { issue: 68, pr: 171, headSha: 'bcf9fc0314ec7480179aef3dc1209c1a4bcea62d', state: 'merged', milestoneSha: '3da17eff8fe2fdeb914013c895744716fec8fd6e', runId: 44400610909, checkStatus: 'success' }],
]);
const expectedSubsequentPreparations = new Map([
  ['M6.08', { issue: 73, pr: 173, headSha: 'acf2cf53fc55743d30d9217bc72e4f50ee3faaa7', milestoneSha: '81e22140086167209d8b1d2bf6908b399794defa', runId: 44549470024, operationStatus: 'not-executed' }],
  ['M6.09', { issue: 74, pr: 174, headSha: '40dd4aec38386746d249cfa8d8794a0b1bd4671a', milestoneSha: 'e3ad62659097c9b7611fe4b176bbd7d4a8a14f23', runId: 44550933360, operationStatus: 'not-started' }],
  ['M6.10', { issue: 75, pr: 175, headSha: 'c2a9badb2e49b2dc95268233225b0ad1c7c451de', milestoneSha: 'd4cb4f84c8a1f39d34befcda2329cc590d9a6d90', runId: 44551732552, operationStatus: 'not-executed' }],
]);
const shaPattern = /^[0-9a-f]{40}$/;
const hex256Pattern = /^[0-9a-f]{64}$/;
const currentMilestoneBaseSha = '8fc1b3e82d19e7785638ec715ea3490e63aa962d';

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
      requireValue(typeof candidate.note === 'string' && candidate.note.includes('zero new advisory/package/path/scope tuples'), 'M6.02 must record the passing dependency comparison.');
    }
    candidates.set(candidate.package, candidate);
  }
  requireValue([...expectedPackages.keys()].every((name) => candidates.has(name)), 'A required candidate package reference is missing.');

  requireValue(Array.isArray(pack.subsequentPreparationPackages) && pack.subsequentPreparationPackages.length === expectedSubsequentPreparations.size, 'Subsequent M6.08-M6.10 preparation references must be present exactly once.');
  const subsequentPreparations = new Map();
  for (const preparation of pack.subsequentPreparationPackages) {
    const expected = expectedSubsequentPreparations.get(preparation.package);
    requireValue(expected && !subsequentPreparations.has(preparation.package), 'Subsequent preparation references contain an unknown or duplicate package.');
    requireValue(preparation.issue === expected.issue && preparation.pr === expected.pr, `${preparation.package} PR/issue identity is invalid.`);
    requireValue(preparation.branch === `desktop/${preparation.package.toLowerCase().replace('.', '-')}`, `${preparation.package} branch is invalid.`);
    requireValue(preparation.headSha === expected.headSha && shaPattern.test(preparation.headSha), `${preparation.package} must identify the observed PR head SHA.`);
    requireValue(preparation.state === 'merged' && preparation.milestoneSha === expected.milestoneSha, `${preparation.package} integration reference is inaccurate.`);
    requireValue(preparation.requiredCheck?.runId === expected.runId && preparation.requiredCheck?.status === 'success', `${preparation.package} required-check evidence is inaccurate.`);
    requireValue(preparation.operationStatus === expected.operationStatus, `${preparation.package} must not claim operational activity.`);
    subsequentPreparations.set(preparation.package, preparation);
  }
  requireValue([...expectedSubsequentPreparations.keys()].every((name) => subsequentPreparations.has(name)), 'A required subsequent preparation reference is missing.');

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
  return { status: pack.status, deploymentReady: pack.deploymentReady, gateCount: pack.gates.length, candidateCount: pack.candidatePullRequests.length, subsequentPreparationCount: pack.subsequentPreparationPackages.length };
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
  const cases = ['readiness ledger remains preparation-only: pass'];

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
  const alteredM602Candidate = m602Claim.candidatePullRequests.find((candidate) => candidate.package === 'M6.02');
  alteredM602Candidate.milestoneSha = 'a856bf4319519d75c1c02907afbfb477a453bf08';
  cases.push(expectReject('incorrect M6.02 squash SHA', () => validateReadiness(m602Claim)));

  const alteredPreparationReference = structuredClone(pack);
  alteredPreparationReference.subsequentPreparationPackages[0].milestoneSha = 'a856bf4319519d75c1c02907afbfb477a453bf08';
  cases.push(expectReject('altered M6.08 milestone reference', () => validateReadiness(alteredPreparationReference)));

  const executedCanaryClaim = structuredClone(pack);
  executedCanaryClaim.subsequentPreparationPackages[0].operationStatus = 'executed';
  cases.push(expectReject('unverified M6.08 canary execution claim', () => validateReadiness(executedCanaryClaim)));

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
