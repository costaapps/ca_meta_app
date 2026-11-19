import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflowRoot = join(repositoryRoot, '.github', 'workflows');
const dockerRoot = join(repositoryRoot, 'infra', 'docker');
const failures = [];

for (const name of (await readdir(workflowRoot)).filter((entry) => /\.ya?ml$/i.test(entry))) {
  const path = join(workflowRoot, name);
  const source = await readFile(path, 'utf8');
  if (/\bpull_request_target\b/.test(source)) failures.push(`${name}: privileged pull_request_target trigger found`);
  if (/^\s*permissions:\s*write-all\s*$/m.test(source)) failures.push(`${name}: permissions: write-all found`);

  for (const [, reference] of source.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) {
    if (reference.startsWith('./')) continue;
    const action = reference.match(/^([^@]+)@([0-9a-f]{40})$/i);
    if (!action) failures.push(`${name}: action is not pinned to a 40-character commit SHA (${reference})`);
  }
}

for (const name of (await readdir(dockerRoot)).filter((entry) => /\.dockerfile$/i.test(entry))) {
  const source = await readFile(join(dockerRoot, name), 'utf8');
  const users = [...source.matchAll(/^\s*USER\s+(\S+)/gim)].map(([, user]) => user);
  const runtimeUser = users.at(-1);
  if (!runtimeUser || /^(?:root|0(?::0)?)$/i.test(runtimeUser)) {
    failures.push(`${name}: final image has no non-root USER directive`);
  }

  for (const [, portText] of source.matchAll(/^\s*EXPOSE\s+([^\r\n#]+)/gim)) {
    const ports = portText.trim().split(/\s+/).map((value) => Number(value.split('/')[0]));
    if (ports.some((port) => Number.isInteger(port) && port > 0 && port < 1024)) {
      failures.push(`${name}: privileged container port exposed (${portText.trim()})`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`M6.02 static boundary check failed (${failures.length} finding(s)):\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('M6.02 static boundary check passed: workflow actions are SHA-pinned, no pull_request_target/write-all, and Docker runtime images use non-root users/unprivileged ports.\n');
}
