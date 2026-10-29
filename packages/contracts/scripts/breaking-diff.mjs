import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(here, '..');
const executable = path.join(packageRoot, '../../node_modules/@pb33f/openapi-changes/bin/openapi-changes.js');

export function getBreakingChanges(before, after) {
  const output = execFileSync(process.execPath, [executable, 'report', '--reproducible', before, after], {
    cwd: packageRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  const report = JSON.parse(output);
  if (report.message === 'No changes found between specifications') return [];
  if (!Array.isArray(report.changes)) throw new Error(`Unexpected openapi-changes report: ${output}`);
  return report.changes.filter((change) => change.breaking === true);
}

export function assertNoBreakingChanges(before, after) {
  const breaking = getBreakingChanges(before, after);
  if (breaking.length > 0) {
    const details = breaking.map((change) => `${change.changeText} ${change.property ?? ''}`.trim()).join(', ');
    throw new Error(`Found ${breaking.length} breaking OpenAPI change(s): ${details}`);
  }
  return breaking;
}
