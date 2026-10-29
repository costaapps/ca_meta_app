import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

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
  const canonicalBefore = createHash('sha256').update(await readFile(canonicalOpenApi)).digest('hex');
  try {
    for (const output of [first, second]) {
      const result = spawnSync(process.execPath, [generator, `--out-dir=${output}`], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    assert.deepEqual(await digestTree(first), await digestTree(second));

    const canonicalDocument = YAML.parse(await readFile(canonicalOpenApi, 'utf8'));
    const generatedPublicOpenApi = await readFile(path.join(first, 'openapi.yaml'), 'utf8');
    const publicDocument = YAML.parse(generatedPublicOpenApi);
    const internalRoute = '/internal/v1/assets/{assetId}/operations';

    assert.ok(canonicalDocument.paths[internalRoute], 'canonical source retains the internal operation');
    assert.ok(canonicalDocument.components.schemas.InternalAssetOperationRequest,
      'canonical source retains the internal request schema');
    assert.ok(canonicalDocument.components.securitySchemes.internalServiceAuth,
      'canonical source retains the internal service security scheme');
    assert.ok(!Object.keys(publicDocument.paths).some((route) => route.startsWith('/internal/')),
      'published OpenAPI must exclude internal routes');
    assert.ok(!Object.keys(publicDocument.components.schemas).some((name) => /^Internal/.test(name)),
      'published OpenAPI must exclude internal schemas');
    assert.ok(!Object.hasOwn(publicDocument.components.securitySchemes, 'internalServiceAuth'),
      'published OpenAPI must exclude the internal service security scheme');
    assert.doesNotMatch(generatedPublicOpenApi, /InternalAssetOperationRequest|internalServiceAuth|\/internal\//,
      'the published artifact must not retain internal component references');
    assert.equal(generatedPublicOpenApi, await readFile(path.join(packageRoot, 'openapi.yaml'), 'utf8'),
      'the checked-in package artifact must match deterministic public generation');
    assert.equal(createHash('sha256').update(await readFile(canonicalOpenApi)).digest('hex'), canonicalBefore,
      'generation must leave the canonical OpenAPI source unchanged');
  } finally {
    const resolvedRoot = await realpath(tempRoot);
    assert.equal(path.dirname(resolvedRoot), tempBase, 'cleanup is limited to this test-owned temporary directory');
    assert.ok(path.basename(resolvedRoot).startsWith('ca-meta-contracts-'));
    await rm(resolvedRoot, { recursive: true, force: true });
  }
});
