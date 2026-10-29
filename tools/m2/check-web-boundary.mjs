import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webRoot = path.join(repositoryRoot, 'apps', 'web');
const sourceRoot = path.join(webRoot, 'src');
const forbiddenPackage = /^(?:@nestjs(?:\/|$)|typeorm(?:\/|$)|mysql2(?:\/|$)|mariadb(?:\/|$)|bcrypt(?:\/|$)|argon2(?:\/|$)|crypto(?:\/|$)|crypto-js(?:\/|$)|node:crypto$|node:(?:fs|path|child_process|net|tls)$)/;
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs']);
const importPattern = /(?:\bimport\s*(?:[^'";]*?\s+from\s*)?|\bexport\s+[^'";]*?\s+from\s*|\bimport\s*\()(['"])([^'"\r\n]+)\1/g;
const issues = [];
let sourceFiles = 0;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(filePath);
      continue;
    }
    if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name))) {
      continue;
    }

    sourceFiles += 1;
    const content = await readFile(filePath, 'utf8');
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[2];
      const relativePath = path.relative(repositoryRoot, filePath).replaceAll('\\', '/');
      if (forbiddenPackage.test(specifier) || /^@ca-meta\/api(?:\/|$)/.test(specifier)) {
        issues.push(`${relativePath}: forbidden server/runtime import "${specifier}"`);
        continue;
      }

      if (specifier.startsWith('.')) {
        const resolvedPath = path.resolve(path.dirname(filePath), specifier);
        const inWeb = resolvedPath === webRoot || resolvedPath.startsWith(`${webRoot}${path.sep}`);
        const inPublicContracts = resolvedPath.startsWith(`${path.join(repositoryRoot, 'packages', 'contracts')}${path.sep}`);
        if (!inWeb && !inPublicContracts) {
          issues.push(`${relativePath}: relative import escapes the web/public-contract boundary "${specifier}"`);
        }
      }
    }
  }
}

try {
  await stat(sourceRoot);
  const manifest = JSON.parse(await readFile(path.join(webRoot, 'package.json'), 'utf8'));
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const name of Object.keys(dependencies)) {
    if (forbiddenPackage.test(name) || /^@ca-meta\/api(?:\/|$)/.test(name)) {
      issues.push(`apps/web/package.json: forbidden server/runtime dependency "${name}"`);
    }
  }
  await walk(sourceRoot);
} catch (error) {
  console.error(`Web boundary check could not inspect the workspace: ${error.message}`);
  process.exitCode = 2;
}

if (issues.length > 0) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else if (process.exitCode === undefined) {
  console.log(`Web boundary check passed (${sourceFiles} source files inspected).`);
}
