import { builtinModules, createRequire } from 'node:module';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webRoot = path.join(repositoryRoot, 'apps', 'web');
const sourceRoot = path.join(webRoot, 'src');
const requireFromWeb = createRequire(path.join(webRoot, 'package.json'));
const ts = requireFromWeb('typescript');
const forbiddenPackage = /^(?:@nestjs(?:\/|$)|typeorm(?:\/|$)|mysql2(?:\/|$)|mariadb(?:\/|$)|bcrypt(?:\/|$)|argon2(?:\/|$)|crypto(?:\/|$)|crypto-js(?:\/|$))/;
const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const issues = [];
let sourceFiles = 0;

function inspectSpecifier(specifier, relativePath) {
  const builtinName = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  if (forbiddenPackage.test(specifier) || /^@ca-meta\/api(?:\/|$)/.test(specifier) || nodeBuiltins.has(builtinName)) {
    issues.push(`${relativePath}: forbidden server/runtime import "${specifier}"`);
    return;
  }

  if (specifier.startsWith('.')) {
    const absoluteFilePath = path.resolve(repositoryRoot, relativePath);
    const resolvedPath = path.resolve(path.dirname(absoluteFilePath), specifier);
    const inWeb = resolvedPath === webRoot || resolvedPath.startsWith(`${webRoot}${path.sep}`);
    const inPublicContracts = resolvedPath.startsWith(`${path.join(repositoryRoot, 'packages', 'contracts')}${path.sep}`);
    if (!inWeb && !inPublicContracts) {
      issues.push(`${relativePath}: relative import escapes the web/public-contract boundary "${specifier}"`);
    }
  }
}

function isRequireReference(expression) {
  return (ts.isIdentifier(expression) && expression.text === 'require')
    || (ts.isPropertyAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && expression.expression.text === 'module'
      && expression.name.text === 'require');
}

function inspectCall(node, relativePath, requireAliases) {
  if (!ts.isCallExpression(node)) {
    return;
  }

  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
  const isModuleRequireCall = isRequireReference(node.expression) && !isRequireCall;
  const isAliasedRequireCall = ts.isIdentifier(node.expression) && requireAliases.has(node.expression.text);
  if (!isDynamicImport && !isRequireCall && !isModuleRequireCall && !isAliasedRequireCall) {
    return;
  }

  const argument = node.arguments[0];
  if (!argument || !ts.isStringLiteralLike(argument)) {
    const callName = isDynamicImport ? 'dynamic import'
      : isModuleRequireCall ? 'module.require'
        : isAliasedRequireCall ? 'aliased require'
          : 'require';
    issues.push(`${relativePath}: non-literal ${callName} cannot be checked against the web boundary`);
    return;
  }
  inspectSpecifier(argument.text, relativePath);
}

function inspectSource(content, filePath, relativePath) {
  const extension = path.extname(filePath);
  const scriptKind = extension === '.tsx' ? ts.ScriptKind.TSX
    : extension === '.jsx' ? ts.ScriptKind.JSX
      : extension === '.js' || extension === '.mjs' || extension === '.cjs' ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);
  const requireAliases = new Set();

  for (const diagnostic of sourceFile.parseDiagnostics) {
    issues.push(`${relativePath}: TypeScript parser could not inspect source (code ${diagnostic.code})`);
  }

  function collectRequireAliases(node) {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && isRequireReference(node.initializer)
      && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.Const) !== 0) {
      requireAliases.add(node.name.text);
    }
    ts.forEachChild(node, collectRequireAliases);
  }

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)) {
      inspectSpecifier(node.moduleSpecifier.text, relativePath);
    }
    if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)) {
      inspectSpecifier(node.moduleReference.expression.text, relativePath);
    }
    inspectCall(node, relativePath, requireAliases);
    ts.forEachChild(node, visit);
  }

  collectRequireAliases(sourceFile);
  visit(sourceFile);
}

function runSelfTest() {
  const relativePath = 'apps/web/src/__m2_boundary_self_test__.ts';
  const filePath = path.join(repositoryRoot, ...relativePath.split('/'));
  const checkpoint = issues.length;
  inspectSource(`
    import 'node:fs/promises';
    const fromRequire = require('crypto');
    const load = require;
    const fromAlias = load('node:path');
    const loadModule = module.require;
    const fromModuleAlias = loadModule('node:fs');
    const dynamic = import(runtimeSpecifier);
    import './app.routes';
  `, filePath, relativePath);
  const findings = issues.splice(checkpoint);
  const expectedFindings = [
    'forbidden server/runtime import "node:fs/promises"',
    'forbidden server/runtime import "crypto"',
    'forbidden server/runtime import "node:path"',
    'forbidden server/runtime import "node:fs"',
    'non-literal dynamic import',
  ];
  const missingFindings = expectedFindings.filter((expected) => !findings.some((finding) => finding.includes(expected)));
  const rejectedSameAppImport = findings.some((finding) => finding.includes('relative import escapes')
    && finding.includes('"./app.routes"'));
  const extensionChecks = [
    { extension: '.cjs', content: "require('node:tls');", expected: 'node:tls' },
    { extension: '.jsx', content: "import 'node:fs';", expected: 'node:fs' },
  ];
  const extensionFindings = extensionChecks.map(({ extension, content }) => {
    const extensionPath = `apps/web/src/__m2_boundary_self_test__${extension}`;
    const extensionCheckpoint = issues.length;
    inspectSource(content, path.join(repositoryRoot, ...extensionPath.split('/')), extensionPath);
    return issues.splice(extensionCheckpoint);
  }).flat();
  const missingExtensions = extensionChecks.filter(({ extension, expected }) =>
    !sourceExtensions.has(extension) || !extensionFindings.some((finding) => finding.includes(expected)));
  if (missingFindings.length > 0 || rejectedSameAppImport || missingExtensions.length > 0) {
    const problems = [
      ...missingFindings,
      ...(rejectedSameAppImport ? ['same-app relative import was rejected'] : []),
      ...missingExtensions.map(({ extension }) => `source extension ${extension} was not inspected`),
    ];
    issues.push(`Web boundary self-test failed: ${problems.join('; ')}`);
  }
}

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
    const relativePath = path.relative(repositoryRoot, filePath).replaceAll('\\', '/');
    inspectSource(content, filePath, relativePath);
  }
}

try {
  runSelfTest();
  await stat(sourceRoot);
  const manifest = JSON.parse(await readFile(path.join(webRoot, 'package.json'), 'utf8'));
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const name of Object.keys(dependencies)) {
    const builtinName = name.startsWith('node:') ? name.slice('node:'.length) : name;
    if (forbiddenPackage.test(name) || /^@ca-meta\/api(?:\/|$)/.test(name) || nodeBuiltins.has(builtinName)) {
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
