import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateManifest } from '../m2-09/verify-release-manifest.mjs';

const lockFields = [
  'RELEASE_ID',
  'SOURCE_REVISION',
  'CA_META_WEB_IMAGE',
  'CA_META_API_IMAGE',
  'WEB_SOURCE_REVISION',
  'API_SOURCE_REVISION',
  'SCHEMA_VERSION',
  'SCHEMA_MIN_COMPATIBLE',
  'SCHEMA_MAX_COMPATIBLE',
];

const protectedResourceFields = [
  'databaseRef',
  'secretStoreRef',
  'tenantCatalogRef',
  'ingressRef',
];

const evidenceFields = [
  'hostAndIngress',
  'dns',
  'tls',
  'secretsManagement',
  'databaseIsolation',
  'metaAppConfigs',
  'authorizedTestAssets',
  'callbackRuntime',
  'webhookSignature',
  'deauthorizationAndDataDeletionRoutes',
  'externalSmoke',
];

const requiredJourneys = new Map([
  ['facebook', new Set(['FACEBOOK_LOGIN'])],
  ['instagram', new Set(['INSTAGRAM_VIA_FACEBOOK_LOGIN', 'INSTAGRAM_LOGIN'])],
  ['whatsapp-exclusive', new Set(['WHATSAPP_CLOUD_API'])],
  ['whatsapp-coexistence', new Set(['WHATSAPP_COEXISTENCE'])],
]);

const expectedRoutes = {
  providerCallback: '/api/v1/meta/{variant}/callback',
  webhookChallenge: '/api/v1/webhooks/meta/{appConfigRef}',
  webhookDelivery: '/api/v1/webhooks/meta/{appConfigRef}',
};

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function requireExactKeys(value, expectedKeys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), label + ' must be an object.');
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  requireValue(actual.length === expected.length && actual.every((key, index) => key === expected[index]), label + ' fields differ from the M2.10 inventory contract.');
}

function requireReference(value, label, environment, evidenceMode) {
  requireValue(typeof value === 'string' && value.trim().length > 0, label + ' is missing.');
  requireValue(value === value.trim() && !/\s/.test(value), label + ' must be an opaque reference without whitespace.');
  requireValue(!/(<|>|REPLACE_ME|CHANGEME|PLACEHOLDER)/i.test(value), label + ' still contains a placeholder.');
  if (evidenceMode === 'synthetic') {
    requireValue(value.startsWith('fixture://' + environment + '/'), label + ' must use this fixture environment namespace.');
  }
}

function parseReleaseLock(text) {
  const entries = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    requireValue(separator > 0, 'Release lock contains a malformed key/value line.');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    requireValue(!entries.has(key), 'Release lock contains a duplicate field.');
    entries.set(key, value);
  }
  requireValue(entries.size === lockFields.length, 'Release lock fields differ from the M2.07 contract.');
  requireValue(lockFields.every((field) => entries.has(field)), 'Release lock is missing an M2.07 contract field.');
  return entries;
}

function validateReleaseLock(lockText, manifest) {
  const lock = parseReleaseLock(lockText);
  const expected = new Map([
    ['RELEASE_ID', manifest.release.releaseId],
    ['SOURCE_REVISION', manifest.sourceRevision],
    ['CA_META_WEB_IMAGE', manifest.images.web.reference],
    ['CA_META_API_IMAGE', manifest.images.api.reference],
    ['WEB_SOURCE_REVISION', manifest.sourceRevision],
    ['API_SOURCE_REVISION', manifest.sourceRevision],
    ['SCHEMA_VERSION', String(manifest.databaseSchema.version)],
    ['SCHEMA_MIN_COMPATIBLE', String(manifest.databaseSchema.minCompatible)],
    ['SCHEMA_MAX_COMPATIBLE', String(manifest.databaseSchema.maxCompatible)],
  ]);
  for (const [field, value] of expected) {
    requireValue(lock.get(field) === value, 'Release lock does not match the verified manifest field ' + field + '.');
  }
}

function validateOrigin(value, label) {
  requireValue(typeof value === 'string' && value.length > 0, label + ' is missing.');
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error(label + ' must be a valid absolute URL.');
  }
  requireValue(origin.protocol === 'https:', label + ' must use HTTPS.');
  requireValue(!origin.username && !origin.password, label + ' must not contain credentials.');
  requireValue(origin.pathname === '/' && origin.search.length === 0 && origin.hash.length === 0, label + ' must be an origin without path, query or fragment.');
  return origin;
}

function validateResources(resources, evidenceMode) {
  requireExactKeys(resources, ['staging', 'production'], 'Environment resource inventory');
  for (const environment of ['staging', 'production']) {
    const refs = resources[environment];
    requireExactKeys(refs, ['databaseRef', 'secretStoreRef', 'tenantCatalogRef', 'ingressRef', 'metaAppConfigRefs'], 'Resource references for ' + environment);
    for (const field of protectedResourceFields) {
      requireReference(refs[field], environment + '.' + field, environment, evidenceMode);
    }
    requireValue(Array.isArray(refs.metaAppConfigRefs) && refs.metaAppConfigRefs.length > 0, environment + '.metaAppConfigRefs must list at least one opaque app-config reference.');
    for (const ref of refs.metaAppConfigRefs) {
      requireReference(ref, environment + '.metaAppConfigRefs entry', environment, evidenceMode);
    }
  }

  const staging = resources.staging;
  const production = resources.production;
  for (const field of protectedResourceFields) {
    requireValue(staging[field] !== production[field], 'Staging and production share ' + field + '; refusing to continue.');
  }
  const productionMetaRefs = new Set(production.metaAppConfigRefs);
  requireValue(staging.metaAppConfigRefs.every((ref) => !productionMetaRefs.has(ref)), 'A Meta app-config reference is shared with production; refusing to continue.');
  return resources;
}

function validateJourneys(journeys) {
  requireValue(Array.isArray(journeys) && journeys.length === requiredJourneys.size, 'Inventory must contain exactly four separate Meta journeys.');
  const seen = new Set();
  const seenVariants = new Set();
  for (const journey of journeys) {
    requireExactKeys(journey, ['id', 'contractVariants', 'appConfigRef', 'availability'], 'Meta journey');
    requireValue(journey && typeof journey === 'object' && requiredJourneys.has(journey.id), 'Inventory contains an unknown Meta journey.');
    requireValue(!seen.has(journey.id), 'A Meta journey is duplicated.');
    seen.add(journey.id);
    requireValue(Array.isArray(journey.contractVariants) && journey.contractVariants.length > 0, journey.id + ' has no explicit contract variant.');
    const allowed = requiredJourneys.get(journey.id);
    requireValue(journey.contractVariants.every((variant) => allowed.has(variant)), journey.id + ' uses a variant outside the OpenAPI contract.');
    requireValue(new Set(journey.contractVariants).size === journey.contractVariants.length, journey.id + ' repeats a contract variant.');
    for (const variant of journey.contractVariants) {
      requireValue(!seenVariants.has(variant), 'A Meta contract variant is assigned to more than one journey.');
      seenVariants.add(variant);
    }
    requireValue(journey.contractVariants.length === allowed.size && [...allowed].every((variant) => journey.contractVariants.includes(variant)), journey.id + ' must represent every contract variant assigned to this journey.');
    requireValue(typeof journey.availability === 'string' && journey.availability.trim().length > 0, journey.id + ' must state resource availability.');
    requireValue(['Not confirmed', 'Synthetic only', 'Authorized'].includes(journey.availability), journey.id + ' availability must be explicit.');
    requireValue(typeof journey.appConfigRef === 'string' && journey.appConfigRef.length > 0, journey.id + ' must identify an opaque app-config reference or synthetic reference.');
  }
  const expectedVariantCount = [...requiredJourneys.values()].reduce((count, variants) => count + variants.size, 0);
  requireValue(seenVariants.size === expectedVariantCount, 'Inventory does not cover every required OpenAPI flow variant.');
}

function validateRoutes(routes) {
  requireExactKeys(routes, [...Object.keys(expectedRoutes), 'deauthorization', 'dataDeletion'], 'Route inventory');
  for (const [routeName, expectedPath] of Object.entries(expectedRoutes)) {
    requireExactKeys(routes[routeName], ['path', 'runtimeStatus'], routeName + ' declaration');
    requireValue(routes[routeName]?.path === expectedPath, routeName + ' differs from the canonical OpenAPI path.');
    requireValue(routes[routeName]?.runtimeStatus === 'contract-only', routeName + ' must not be represented as a deployed runtime endpoint.');
  }
  for (const name of ['deauthorization', 'dataDeletion']) {
    requireExactKeys(routes[name], ['path', 'status'], name + ' declaration');
    requireValue(routes[name]?.path === null, name + ' has no agreed canonical route and must remain unset.');
    requireValue(routes[name]?.status === 'Not confirmed', name + ' route status must remain Not confirmed until contract and runtime exist.');
  }
}

function validateEvidence(evidence) {
  requireExactKeys(evidence, evidenceFields, 'External evidence status');
  // This static tool has no evidence-verification input. Do not let a descriptor
  // upgrade a real external gate to "Verified" without an independently reviewed record.
  const allowed = new Set(['Not confirmed', 'Synthetic only']);
  for (const [name, status] of Object.entries(evidence)) {
    requireValue(allowed.has(status), 'External evidence status for ' + name + ' must be explicit.');
  }
}

export function validateStagingConfiguration(environment, manifestInput, lockText) {
  requireValue(environment && typeof environment === 'object' && !Array.isArray(environment), 'Environment descriptor must be a JSON object.');
  requireExactKeys(environment, ['formatVersion', 'evidenceMode', 'targetEnvironment', 'displayLabel', 'stagingOrigin', 'productionOrigin', 'releaseId', 'sourceRevision', 'resources', 'routes', 'journeys', 'externalEvidence'], 'Environment descriptor');
  requireValue(environment.formatVersion === 1, 'Unsupported environment inventory version.');
  requireValue(environment.targetEnvironment === 'staging', 'Target environment is not staging; refusing production or unknown targets.');
  requireValue(environment.displayLabel === 'STAGING', 'Visible environment label must be exactly STAGING.');
  requireValue(['synthetic', 'operator-recorded'].includes(environment.evidenceMode), 'Environment evidence mode must be synthetic or operator-recorded.');

  const manifest = validateManifest(manifestInput);
  requireValue(environment.releaseId === manifest.release.releaseId, 'Environment releaseId differs from the release manifest.');
  requireValue(environment.sourceRevision === manifest.sourceRevision, 'Environment sourceRevision differs from the release manifest.');
  validateReleaseLock(lockText, manifest);

  const stagingOrigin = validateOrigin(environment.stagingOrigin, 'stagingOrigin');
  const productionOrigin = validateOrigin(environment.productionOrigin, 'productionOrigin');
  requireValue(stagingOrigin.host !== productionOrigin.host, 'Staging and production public origins must be distinct.');

  validateResources(environment.resources, environment.evidenceMode);
  validateJourneys(environment.journeys);
  for (const journey of environment.journeys) {
    requireValue(environment.resources.staging.metaAppConfigRefs.includes(journey.appConfigRef), journey.id + ' must reference a staging Meta app-config resource.');
    requireValue(!environment.resources.production.metaAppConfigRefs.includes(journey.appConfigRef), journey.id + ' references a production Meta app-config resource; refusing to continue.');
  }
  validateRoutes(environment.routes);
  validateEvidence(environment.externalEvidence);

  return {
    status: 'configuration-valid-only',
    targetEnvironment: 'staging',
    displayLabel: 'STAGING',
    releaseId: manifest.release.releaseId,
    sourceRevision: manifest.sourceRevision,
    webDigest: manifest.images.web.digest,
    apiDigest: manifest.images.api.digest,
    schemaVersion: manifest.databaseSchema.version,
    journeyCount: requiredJourneys.size,
    deploymentReady: false,
    readiness: 'Not confirmed; static preflight does not probe DNS, TLS, service availability, Meta or signature verification.',
    unverifiedEvidence: Object.keys(environment.externalEvidence),
  };
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!['--environment', '--manifest', '--release-lock'].includes(name) || index + 1 >= argv.length) {
      throw new Error('Usage: node tools/m2-10/preflight.mjs --environment <json> --manifest <json> --release-lock <env>');
    }
    requireValue(!(name in result), 'Command-line argument ' + name + ' was provided more than once.');
    result[name] = argv[index + 1];
    index += 1;
  }
  requireValue(result['--environment'] && result['--manifest'] && result['--release-lock'], 'All three input paths are required.');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const [environmentText, manifestText, lockText] = await Promise.all([
      readFile(resolve(args['--environment']), 'utf8'),
      readFile(resolve(args['--manifest']), 'utf8'),
      readFile(resolve(args['--release-lock']), 'utf8'),
    ]);
    const summary = validateStagingConfiguration(
      JSON.parse(environmentText),
      JSON.parse(manifestText),
      lockText,
    );
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('M2.10 preflight rejected: ' + error.message);
    process.exitCode = 1;
  }
}
