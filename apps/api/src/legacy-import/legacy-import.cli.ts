import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createLegacyImportReferenceHasher, planLegacyImport } from './legacy-import.planner.js';
import { LEGACY_IMPORT_MAX_ROWS } from './legacy-import.types.js';

export function parseLegacyImportCliArguments(args: readonly string[]): { readonly dryRun: true; readonly fixtureName: string } {
  let dryRun = true;
  let fixtureName = 'synthetic-inventory.json';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--fixture') {
      fixtureName = args[index + 1] ?? '';
      index += 1;
    } else if (argument === '--apply') {
      throw new Error('Apply mode is not available in M3.11.');
    } else {
      throw new Error('Only the synthetic dry-run command is available.');
    }
  }
  if (!dryRun || fixtureName !== 'synthetic-inventory.json') {
    throw new Error('Only the checked-in synthetic fixture may be used.');
  }
  return { dryRun: true, fixtureName };
}

function fixturePath(name: string): string {
  const fixtureRoot = resolve(process.cwd(), '../../tools/m3-11/fixtures');
  const candidate = resolve(fixtureRoot, name);
  const pathFromRoot = relative(fixtureRoot, candidate);
  if (!name || isAbsolute(name) || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot.includes(sep)) {
    throw new Error('Fixture path is outside the synthetic fixture allowlist.');
  }
  return candidate;
}

export async function runLegacyImportDryRun(args: readonly string[]): Promise<string> {
  const options = parseLegacyImportCliArguments(args);
  const source = await readFile(fixturePath(options.fixtureName), 'utf8');
  const input: unknown = JSON.parse(source);
  const plan = planLegacyImport(input, {
    allowedCatalogRefs: new Set(['synthetic-m3-11']),
    hasher: createLegacyImportReferenceHasher(Buffer.from('m3.11-synthetic-fixture-reference-key-only')),
  });
  if (plan.items.length > LEGACY_IMPORT_MAX_ROWS) throw new Error('Synthetic fixture exceeds the configured row limit.');
  return JSON.stringify(plan.report, null, 2);
}

if (process.argv[1] && /(?:^|[/\\])legacy-import\.cli\.(?:js|cjs)$/i.test(process.argv[1])) {
  runLegacyImportDryRun(process.argv.slice(2)).then((report) => {
    process.stdout.write(`${report}\n`);
  }).catch(() => {
    process.stderr.write('M3.11 synthetic dry-run failed closed. No source row or secret was written.\n');
    process.exitCode = 1;
  });
}
