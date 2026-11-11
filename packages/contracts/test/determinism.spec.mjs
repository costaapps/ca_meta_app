import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import { generatedTextMatches } from '../../../tools/shared/generated-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const generator = path.join(root, 'packages/contracts/scripts/generate.mjs');
const packageRoot = path.join(root, 'packages/contracts');
const canonicalOpenApi = path.join(root, 'docs/meta-v2/contracts/openapi.yaml');

async function digestTree(directory) {
  const files = [];
  async function visit(relative = '') {
    for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else files.push([child.replaceAll('\\', '/'), createHash('sha256').update(await readFile(path.join(directory, child))).digest('hex')]);
    }
  }
  await visit();
  return files;
}

test('generation is deterministic in two isolated output directories', async () => {
  const tempBase = await realpath(os.tmpdir());
  const tempRoot = await mkdtemp(path.join(tempBase, 'ca-meta-contracts-'));
  const first = path.join(tempRoot, 'first');
  const second = path.join(tempRoot, 'second');
  const newlineProbe = path.join(tempRoot, 'newline-probe');
  const canonicalBefore = createHash('sha256').update(await readFile(canonicalOpenApi)).digest('hex');
  try {
    for (const output of [first, second, newlineProbe]) {
      const result = spawnSync(process.execPath, [generator, `--out-dir=${output}`], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    assert.deepEqual(await digestTree(first), await digestTree(second));

    const catalogProbe = path.join(newlineProbe, 'error-catalog.md');
    const generatedCatalogProbe = await readFile(catalogProbe, 'utf8');
    const crlfCatalogProbe = generatedCatalogProbe.replace(/\n/g, '\r\n');
    await writeFile(catalogProbe, crlfCatalogProbe, 'utf8');
    const crlfCheck = spawnSync(process.execPath, [generator, '--check', `--out-dir=${newlineProbe}`], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(crlfCheck.status, 0, crlfCheck.stderr || crlfCheck.stdout,
      'generated checks must accept an otherwise identical CRLF checkout');

    const semanticMutation = crlfCatalogProbe.replace('M1.07 — safe API error catalog', 'M1.07 — altered API error catalog');
    assert.notEqual(semanticMutation, crlfCatalogProbe, 'semantic-mutation probe must change generated content');
    await writeFile(catalogProbe, semanticMutation, 'utf8');
    const semanticCheck = spawnSync(process.execPath, [generator, '--check', `--out-dir=${newlineProbe}`], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(semanticCheck.status, 0, 'generated checks must still reject semantic changes');

    const canonicalDocument = YAML.parse(await readFile(canonicalOpenApi, 'utf8'));
    const canonicalErrorCodes = canonicalDocument.components.schemas.ErrorEnvelope.properties.code.enum;
    const generatedPublicOpenApi = await readFile(path.join(first, 'openapi.yaml'), 'utf8');
    const publicDocument = YAML.parse(generatedPublicOpenApi);
    const publicErrorCodes = publicDocument.components.schemas.ErrorEnvelope.properties.code.enum;
    const internalRoute = '/internal/v1/assets/{assetId}/operations';
    const internalV2Route = '/internal/v2/assets/{assetId}/operations';

    assert.ok(canonicalDocument.paths[internalRoute], 'canonical source retains the internal operation');
    assert.ok(canonicalDocument.paths[internalV2Route], 'canonical source retains the additive typed-proof operation');
    assert.ok(canonicalDocument.components.schemas.InternalAssetOperationRequest,
      'canonical source retains the internal request schema');
    assert.ok(canonicalDocument.components.securitySchemes.internalServiceAuth,
      'canonical source retains the internal service security scheme');
    assert.ok(canonicalDocument.components.schemas.InternalAssetOperationV2Request,
      'canonical source retains the v2 typed-operation request schema');
    assert.ok(canonicalDocument.components.securitySchemes.internalServiceProofV2,
      'canonical source retains the v2 service-proof security scheme');
    assert.ok(canonicalErrorCodes.includes('INTERNAL_SCOPE_DENIED'),
      'canonical source retains the internal-only error code');
    assert.ok(!Object.keys(publicDocument.paths).some((route) => route.startsWith('/internal/')),
      'published OpenAPI must exclude internal routes');
    assert.ok(!Object.keys(publicDocument.components.schemas).some((name) => /^Internal/.test(name)),
      'published OpenAPI must exclude internal schemas');
    assert.ok(!Object.hasOwn(publicDocument.components.securitySchemes, 'internalServiceAuth'),
      'published OpenAPI must exclude the internal service security scheme');
    assert.ok(!Object.hasOwn(publicDocument.components.securitySchemes, 'internalServiceProofV2'),
      'published OpenAPI must exclude the v2 internal service security scheme');
    assert.ok(!publicErrorCodes.includes('INTERNAL_SCOPE_DENIED'),
      'published OpenAPI must exclude the internal-only error code');
    assert.doesNotMatch(generatedPublicOpenApi, /InternalAssetOperation(?:V2)?(?:Request|Result)|internalService(?:Auth|ProofV2)|\/internal\//,
      'the published artifact must not retain internal component references');
    assert.doesNotMatch(generatedPublicOpenApi, /INTERNAL_SCOPE_DENIED/,
      'the published OpenAPI must not retain the internal-only error code');
    const canonicalCatalog = await readFile(path.join(root, 'docs/meta-v2/contracts/error-catalog.md'), 'utf8');
    const generatedCatalog = await readFile(path.join(first, 'error-catalog.md'), 'utf8');
    const generatedTypes = await readFile(path.join(first, 'src/generated/openapi.d.ts'), 'utf8');
    const generatedErrorCodes = await readFile(path.join(first, 'src/generated/error-codes.mjs'), 'utf8');
    const generatedErrorPolicies = await readFile(path.join(first, 'src/generated/error-policies.mjs'), 'utf8');
    const generatedRuntimeSchemas = JSON.parse(await readFile(path.join(first, 'src/generated/runtime-schemas.json'), 'utf8'));
    assert.match(canonicalCatalog, /`INTERNAL_SCOPE_DENIED`/,
      'canonical catalog retains the internal-only error row');
    assert.doesNotMatch(generatedCatalog, /INTERNAL_SCOPE_DENIED/,
      'published error catalog excludes the internal-only error');
    assert.doesNotMatch(generatedTypes, /INTERNAL_SCOPE_DENIED/,
      'published TypeScript types exclude the internal-only error');
    assert.doesNotMatch(generatedErrorCodes, /INTERNAL_SCOPE_DENIED/,
      'published error constants exclude the internal-only error');
    assert.doesNotMatch(generatedErrorPolicies, /INTERNAL_SCOPE_DENIED/,
      'published error policies exclude the internal-only error');
    assert.ok(!generatedRuntimeSchemas.ErrorEnvelope.properties.code.enum.includes('INTERNAL_SCOPE_DENIED'),
      'published runtime validation excludes the internal-only error');
    assert.ok(generatedTextMatches(generatedPublicOpenApi, await readFile(path.join(packageRoot, 'openapi.yaml'), 'utf8')),
      'the checked-in package artifact must match deterministic public generation');
    assert.ok(generatedTextMatches(generatedCatalog, await readFile(path.join(packageRoot, 'error-catalog.md'), 'utf8')),
      'the checked-in error catalog must match deterministic public generation');
    assert.equal(createHash('sha256').update(await readFile(canonicalOpenApi)).digest('hex'), canonicalBefore,
      'generation must leave the canonical OpenAPI source unchanged');
  } finally {
    const resolvedRoot = await realpath(tempRoot);
    assert.equal(path.dirname(resolvedRoot), tempBase, 'cleanup is limited to this test-owned temporary directory');
    assert.ok(path.basename(resolvedRoot).startsWith('ca-meta-contracts-'));
    await rm(resolvedRoot, { recursive: true, force: true });
  }
});
