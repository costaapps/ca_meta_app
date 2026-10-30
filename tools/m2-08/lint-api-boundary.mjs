import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/api/src');
const forbiddenPatterns = [
  { label: 'Angular frontend import', regex: /(?:from\s*|import\s*\()\s*['"]@angular\// },
  { label: 'web workspace import', regex: /(?:from\s*|import\s*\()\s*['"]@ca-meta\/web(?:\/[^'"]*)?['"]?/ },
  { label: 'browser global', regex: /\b(?:window|document|localStorage|sessionStorage|indexedDB|navigator)\b/ },
];

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(target);
  }
  return files;
}

async function main() {
  const violations = [];
  const files = await sourceFiles(API_SOURCE);
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of forbiddenPatterns) {
        if (rule.regex.test(line)) violations.push({ file: path.relative(API_SOURCE, file), line: index + 1, rule: rule.label });
      }
    });
  }
  if (violations.length) {
    for (const violation of violations) process.stderr.write(`${violation.file}:${violation.line}: ${violation.rule}\n`);
    process.stderr.write('API source must remain backend-only and cannot depend on browser globals or the web workspace.\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`API boundary lint passed for ${files.length} TypeScript source files.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
