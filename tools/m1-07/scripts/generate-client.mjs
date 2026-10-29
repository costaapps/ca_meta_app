import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import YAML from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const contractPath = path.join(root, 'docs/meta-v2/contracts/openapi.yaml');
const outputPath = path.resolve(here, '../src/generated/openapi.d.ts');
const checkOnly = process.argv.includes('--check');
const document = YAML.parse(await readFile(contractPath, 'utf8'));

for (const [route, item] of Object.entries(document.paths ?? {})) {
  for (const method of Object.keys(item)) {
    if (!['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(method)) continue;
    const operation = item[method];
    if (operation.tags?.includes('Internal Operations')) delete item[method];
  }
  if (!Object.keys(item).some((key) => ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(key))) {
    delete document.paths[route];
  }
}
delete document.components.securitySchemes.internalServiceAuth;
delete document.components.schemas.InternalAssetOperationRequest;

const generated = await openapiTS(document, { cwd: path.dirname(contractPath), immutable: true });
const source = typeof generated === 'string' ? generated : astToString(generated);
const output = `/* Generated from docs/meta-v2/contracts/openapi.yaml. Do not edit by hand. */\n${source}`;
if (checkOnly) {
  const current = await readFile(outputPath, 'utf8');
  if (current !== output) throw new Error(`Generated client is stale: run npm run generate (${path.relative(root, outputPath)}).`);
  console.log(`Verified ${path.relative(root, outputPath)} is current.`);
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output, 'utf8');
  console.log(`Wrote ${path.relative(root, outputPath)} without internal-only operations.`);
}
