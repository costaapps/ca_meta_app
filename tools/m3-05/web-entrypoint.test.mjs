import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const entrypoint = join(repositoryRoot, 'infra', 'docker', 'web-entrypoint.sh');

function toWslPath(path) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const result = spawnSync('bash.exe', ['-lc', `wslpath -a ${quote(path)}`], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not map a test path into WSL: ${result.stderr || result.error?.message || result.status}`);
  }
  return result.stdout.trim();
}

function runEntrypoint(scriptPath, overrides = {}) {
  const windowsHost = process.platform === 'win32';
  const shell = windowsHost ? 'bash.exe' : '/bin/sh';
  const posixScriptPath = windowsHost ? toWslPath(scriptPath) : scriptPath;
  const command = windowsHost ? `'${posixScriptPath.replaceAll("'", "'\\''")}' true` : undefined;
  const forwarded = ['WEB_PUBLIC_META_API_BASE_URL', 'WEB_SUITE4_EMBED_ORIGINS', 'WEB_PUBLIC_META_AUTHORIZATION_ORIGINS'];
  const environment = {
    PATH: process.env.PATH,
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    WEB_PUBLIC_META_API_BASE_URL: '/api',
    WEB_SUITE4_EMBED_ORIGINS: '',
    WEB_PUBLIC_META_AUTHORIZATION_ORIGINS: '',
    ...overrides,
    ...(windowsHost ? { WSLENV: forwarded.map((name) => `${name}/u`).join(':') } : {}),
  };
  return spawnSync(shell, windowsHost ? ['-lc', command] : [posixScriptPath, 'true'], {
    encoding: 'utf8',
    env: environment,
  });
}

test('web entrypoint accepts exact HTTPS origins and rejects invalid origins before writing runtime config', () => {
  const tempPath = mkdtempSync(join(tmpdir(), 'm3-05-web-entrypoint-'));
  try {
    // Git may check shell scripts out as CRLF on Windows; Linux image builds consume the LF blob.
    const posixEntrypoint = join(tempPath, 'web-entrypoint.sh');
    const posixTempDirectory = process.platform === 'win32' ? toWslPath(tempPath) : tempPath;
    const script = readFileSync(entrypoint, 'utf8').replace(/\r\n/g, '\n').replaceAll('/tmp', posixTempDirectory);
    writeFileSync(posixEntrypoint, script, { mode: 0o700 });
    const accepted = runEntrypoint(posixEntrypoint, {
      WEB_SUITE4_EMBED_ORIGINS: 'https://suite4.synthetic.invalid,https://suite4-alt.synthetic.invalid:8443',
      WEB_PUBLIC_META_AUTHORIZATION_ORIGINS: 'https://provider.synthetic.invalid',
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(readFileSync(join(tempPath, 'runtime-config.js'), 'utf8'),
      /"suite4EmbedOrigins":\["https:\/\/suite4\.synthetic\.invalid","https:\/\/suite4-alt\.synthetic\.invalid:8443"\]/);
    assert.match(readFileSync(join(tempPath, 'embed-policy.conf'), 'utf8'),
      /frame-ancestors https:\/\/suite4\.synthetic\.invalid https:\/\/suite4-alt\.synthetic\.invalid:8443/);

    for (const overrides of [
      { WEB_SUITE4_EMBED_ORIGINS: 'https://suite4.synthetic.invalid/path' },
      { WEB_SUITE4_EMBED_ORIGINS: 'http://suite4.synthetic.invalid' },
      { WEB_PUBLIC_META_AUTHORIZATION_ORIGINS: 'https://provider.synthetic.invalid?next=unsafe' },
    ]) {
      rmSync(join(tempPath, 'runtime-config.js'), { force: true });
      rmSync(join(tempPath, 'embed-policy.conf'), { force: true });
      const rejected = runEntrypoint(posixEntrypoint, overrides);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.equal(existsSync(join(tempPath, 'runtime-config.js')), false);
      assert.equal(existsSync(join(tempPath, 'embed-policy.conf')), false);
    }
  } finally {
    rmSync(tempPath, { recursive: true, force: true });
  }
});
