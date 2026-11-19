import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const expectedFlows = new Map([
  ['facebook_pages', ['FACEBOOK', 'FACEBOOK_LOGIN_FOR_BUSINESS']],
  ['instagram_facebook_login', ['INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN']],
  ['instagram_instagram_login', ['INSTAGRAM_LOGIN', 'INSTAGRAM_LOGIN']],
  ['whatsapp_exclusive', ['WHATSAPP_CLOUD_API', 'WHATSAPP_EMBEDDED_SIGNUP']],
  ['whatsapp_coexistence', ['WHATSAPP_COEXISTENCE', 'WHATSAPP_BUSINESS_APP_ONBOARDING']],
]);
const expectedApplicationGates = new Set([
  'app_identity_and_configuration',
  'permission_and_feature_map',
  'app_review',
  'developer_business_verification',
  'tech_provider_or_solution_partner',
  'data_handling_and_data_use_checkup',
]);
const expectedDependencies = new Set(['M4.01', 'M6.01', 'M6.02', 'M6.06']);
const expectedPreparedOn = '2026-11-19';
const expectedSourceAccessDate = '2026-11-18';
const expectedDependencyReferences = new Map([
  ['M4.01', {
    pullRequestUrl: 'https://github.com/costaapps/ca_meta_app/pull/128',
    integratedSha: '65233723351432d5f49306666f7fe777f7ead8b3',
    consolidatedPullRequestUrl: 'https://github.com/costaapps/ca_meta_app/pull/151',
    consolidatedIntegratedSha: 'c3e9baa75ea793d74292e62038e0d8d11bb61295',
  }],
  ['M6.01', {
    pullRequestUrl: 'https://github.com/costaapps/ca_meta_app/pull/170',
    integratedSha: 'a856bf4319519d75c1c02907afbfb477a453bf08',
    consolidatedPullRequestUrl: null,
    consolidatedIntegratedSha: null,
  }],
  ['M6.02', {
    pullRequestUrl: 'https://github.com/costaapps/ca_meta_app/pull/167',
    integratedSha: '83364168b0dfbe0404cf8dae100ae1d51a07ba84',
    consolidatedPullRequestUrl: null,
    consolidatedIntegratedSha: null,
  }],
  ['M6.06', {
    pullRequestUrl: 'https://github.com/costaapps/ca_meta_app/pull/176',
    integratedSha: 'da234f4ae7900a078a7973d79ee49ee3d074d32b',
    consolidatedPullRequestUrl: null,
    consolidatedIntegratedSha: null,
  }],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function collectStatuses(value, path = '$', statuses = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStatuses(item, `${path}[${index}]`, statuses));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'status') statuses.push({ path: `${path}.status`, value: child });
      collectStatuses(child, `${path}.${key}`, statuses);
    }
  }
  return statuses;
}

function validateEvidence(evidence) {
  assert(evidence?.schemaVersion === 1, 'Unsupported or missing evidence schemaVersion.');
  assert(evidence.package === 'M6.07' && evidence.issue === 72, 'Fixture must target M6.07 / issue #72.');
  assert(evidence.snapshot?.kind === 'SYNTHETIC_READINESS_SKELETON', 'Fixture must remain explicitly synthetic.');
  assert(evidence.snapshot?.preparedOn === expectedPreparedOn, 'Preparation date must match the current readiness snapshot.');
  assert(evidence.decision?.status === 'Not confirmed' && evidence.decision.activationAllowed === false, 'Unproven gates must block activation.');
  assert(evidence.decision.externalEvidenceWasCollected === false, 'This local package must not claim external evidence.');

  const appGateIds = new Set((evidence.applicationLevelGates ?? []).map((gate) => gate.id));
  assert(appGateIds.size === expectedApplicationGates.size && [...expectedApplicationGates].every((id) => appGateIds.has(id)), 'Application-level gates must separately cover permissions, App Review, business verification, Tech Provider and data handling.');

  const flows = evidence.flows ?? [];
  assert(flows.length === expectedFlows.size, `Expected ${expectedFlows.size} distinct Meta auth variants; found ${flows.length}.`);
  const observedFlows = new Set();
  for (const flow of flows) {
    const expected = expectedFlows.get(flow.id);
    assert(expected, `Unexpected flow id: ${flow.id}.`);
    assert(!observedFlows.has(flow.id), `Duplicate flow id: ${flow.id}.`);
    observedFlows.add(flow.id);
    assert(flow.flowVariant === expected[0] && flow.authVariant === expected[1], `${flow.id} mixes or changes its exact flow/auth variant.`);
    assert(flow.status === 'Not confirmed' && flow.releaseActivationAllowed === false, `${flow.id} must remain blocked as Not confirmed.`);
    for (const gate of ['permissionMapping', 'customerGrant', 'assetEligibility', 'walkthrough']) {
      assert(flow[gate]?.status === 'Not confirmed', `${flow.id}.${gate} must be Not confirmed.`);
      assert(Array.isArray(flow[gate].requiredEvidence) && flow[gate].requiredEvidence.length > 0, `${flow.id}.${gate} needs concrete proof requirements.`);
    }
  }

  const dependencyIds = new Set((evidence.dependencies ?? []).map((item) => item.key));
  assert(dependencyIds.size === expectedDependencies.size && [...expectedDependencies].every((id) => dependencyIds.has(id)), 'All declared issue dependencies must remain present.');
  for (const dependency of evidence.dependencies) {
    const expected = expectedDependencyReferences.get(dependency.key);
    assert(dependency.prReferenceStatus === 'VERIFIED', `${dependency.key} must reference a verified upstream integration.`);
    assert(dependency.pullRequestUrl === expected.pullRequestUrl && dependency.integratedSha === expected.integratedSha, `${dependency.key} package PR or integration SHA is inaccurate.`);
    assert(dependency.consolidatedPullRequestUrl === expected.consolidatedPullRequestUrl && dependency.consolidatedIntegratedSha === expected.consolidatedIntegratedSha, `${dependency.key} consolidated integration reference is inaccurate.`);
  }

  assert(evidence.suite4Msg4Gate?.status === 'Not confirmed', 'Real Suite4/Msg4 evidence is not confirmed.');
  assert(evidence.productDataPolicyGate?.status === 'Not confirmed', 'Product/privacy acceptance is not confirmed.');
  assert(evidence.operations?.status === 'Not confirmed', 'Operator/support readiness is not confirmed.');
  assert(evidence.operations.roleAssignments.every((role) => role.assignedTo === null && role.status === 'Not confirmed'), 'No named external operator has been confirmed.');

  const statuses = collectStatuses(evidence);
  assert(statuses.length > 0 && statuses.every((entry) => entry.value === 'Not confirmed'), 'Every readiness/evidence status must remain Not confirmed.');
  const references = evidence.sourceReferences ?? [];
  assert(references.length >= 10, 'Primary Meta source references are incomplete.');
  for (const reference of references) {
    const url = new URL(reference.url);
    assert(url.protocol === 'https:' && url.hostname === 'developers.facebook.com', `Source must be an official Meta developer URL: ${reference.url}`);
    assert(reference.accessedOn === expectedSourceAccessDate, `Source access date must be ${expectedSourceAccessDate}.`);
  }

  const serialized = JSON.stringify(evidence);
  assert(!/\b(?:EA[A-Za-z0-9]{20,}|IGQV[A-Za-z0-9._-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|dckr_pat_[A-Za-z0-9_]{20,})\b/.test(serialized), 'Synthetic fixture appears to contain a credential/token.');
  return { flowCount: flows.length, dependencyCount: evidence.dependencies.length, statusCount: statuses.length, sourceCount: references.length };
}

assert(process.argv.length === 2, 'This offline validator accepts no file paths; it reads only its tracked synthetic fixture.');
const fixturePath = resolve(fileURLToPath(new URL('./readiness-evidence.synthetic.json', import.meta.url)));
const evidence = JSON.parse(await readFile(fixturePath, 'utf8'));
const summary = validateEvidence(evidence);
process.stdout.write(`M6.07 synthetic checklist valid: ${summary.flowCount} distinct flow variants; ${summary.dependencyCount} upstream integrations verified; ${summary.sourceCount} primary Meta sources; ${summary.statusCount} gates remain Not confirmed. No external acceptance was certified.\n`);
