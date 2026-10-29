import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import YAML from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const root = path.resolve(packageRoot, '../..');
const contractRoot = path.join(root, 'docs/meta-v2/contracts');
const contractPath = path.join(contractRoot, 'openapi.yaml');
const outputArgument = process.argv.find((argument) => argument.startsWith('--out-dir='));
const outputRoot = outputArgument
  ? path.resolve(process.cwd(), outputArgument.slice('--out-dir='.length))
  : packageRoot;
const checkOnly = process.argv.includes('--check');

const sources = new Map([
  ['openapi.yaml', 'openapi.yaml'],
  ['error-catalog.md', 'error-catalog.md'],
  ['events/inbox-event.schema.json', 'events/inbox-event.schema.json'],
  ['events/outbox-event.schema.json', 'events/outbox-event.schema.json'],
]);

const artifacts = new Map();
for (const [target, source] of sources) {
  artifacts.set(target, await readFile(path.join(contractRoot, source), 'utf8'));
}

const document = YAML.parse(artifacts.get('openapi.yaml'));
const publicDocument = structuredClone(document);
const httpMethods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
for (const [route, item] of Object.entries(publicDocument.paths ?? {})) {
  for (const method of Object.keys(item)) {
    if (httpMethods.has(method) && item[method].tags?.includes('Internal Operations')) delete item[method];
  }
  if (!Object.keys(item).some((key) => httpMethods.has(key))) delete publicDocument.paths[route];
}
delete publicDocument.components.securitySchemes.internalServiceAuth;
delete publicDocument.components.schemas.InternalAssetOperationRequest;

const generatedTypes = await openapiTS(publicDocument, { cwd: path.dirname(contractPath), immutable: true });
const generatedSource = typeof generatedTypes === 'string' ? generatedTypes : astToString(generatedTypes);
artifacts.set(
  'src/generated/openapi.d.ts',
  `/* Generated from docs/meta-v2/contracts/openapi.yaml. Do not edit by hand. */\n${generatedSource}`,
);

const schemas = document.components?.schemas ?? {};
const errorCodes = schemas.ErrorEnvelope?.properties?.code?.enum;
const errorActions = schemas.ErrorAction?.enum;
if (!Array.isArray(errorCodes) || !Array.isArray(errorActions)) {
  throw new Error('OpenAPI must declare ErrorEnvelope code and ErrorAction enums.');
}

artifacts.set(
  'src/generated/error-codes.mjs',
  `export const ERROR_CODES = Object.freeze(${JSON.stringify(errorCodes, null, 2)});\n`,
);
artifacts.set(
  'src/generated/error-codes.d.ts',
  `import type { components } from './openapi.js';\nexport declare const ERROR_CODES: readonly components['schemas']['ErrorEnvelope']['code'][];\n`,
);
artifacts.set(
  'src/generated/error-actions.mjs',
  `export const ERROR_ACTIONS = Object.freeze(${JSON.stringify(errorActions, null, 2)});\n`,
);
artifacts.set(
  'src/generated/error-actions.d.ts',
  `import type { components } from './openapi.js';\nexport declare const ERROR_ACTIONS: readonly components['schemas']['ErrorAction'][];\n`,
);
const errorPolicies = schemas.ErrorEnvelope?.['x-error-policy-by-code'] ?? {};
artifacts.set(
  'src/generated/error-policies.mjs',
  `export const ERROR_POLICIES = Object.freeze(${JSON.stringify(errorPolicies, null, 2)});\n`,
);
artifacts.set(
  'src/generated/error-policies.d.ts',
  `import type { ErrorAction, ErrorCode } from '../index.js';\nexport declare const ERROR_POLICIES: Readonly<Partial<Record<ErrorCode, { readonly retryable: boolean; readonly action: ErrorAction }>>>;\n`,
);

const runtimeSchemaNames = ['ErrorAction', 'ErrorEnvelope', 'HealthStatus'];
const runtimeSchemas = Object.fromEntries(runtimeSchemaNames.map((name) => {
  if (!schemas[name]) throw new Error(`Missing runtime OpenAPI schema ${name}.`);
  return [name, schemas[name]];
}));
artifacts.set('src/generated/runtime-schemas.json', `${JSON.stringify(runtimeSchemas, null, 2)}\n`);

for (const [relativePath, contents] of artifacts) {
  const outputPath = path.join(outputRoot, relativePath);
  if (checkOnly) {
    let current;
    try {
      current = await readFile(outputPath, 'utf8');
    } catch {
      throw new Error(`Generated contract artifact is missing: ${relativePath}. Run npm run generate.`);
    }
    if (current !== contents) {
      throw new Error(`Generated contract artifact is stale: ${relativePath}. Run npm run generate.`);
    }
  } else {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, contents, 'utf8');
  }
}

console.log(`${checkOnly ? 'Verified' : 'Generated'} ${artifacts.size} deterministic contract artifacts.`);
