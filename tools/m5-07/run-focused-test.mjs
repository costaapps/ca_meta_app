import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const api = join(root, 'apps', 'api');
const apiDist = resolve(api, 'dist');
if (!apiDist.startsWith(`${root}${sep}`)) throw new Error('Refusing to build outside the repository API directory.');
if (existsSync(apiDist)) {
  process.stderr.write('Focused harness requires apps/api/dist to be absent; it will not overwrite existing build output.\n');
  process.exitCode = 2;
} else {
  let built = false;
  try {
    const nestCli = join(api, 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js');
    const build = spawnSync(process.execPath, [nestCli, 'build'], { cwd: api, stdio: 'inherit' });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(`Nest API build failed with exit ${build.status ?? 'signal'}.`);
    built = existsSync(apiDist);
    if (!built) throw new Error('Nest API build completed without creating apps/api/dist.');
    const run = spawnSync(process.execPath, ['--test', join(root, 'tools', 'm5-07', 'internal-operations.test.mjs')], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, M5_07_API_DIST: apiDist },
    });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`M5.07 focused tests failed with exit ${run.status ?? 'signal'}.`);
    if (process.argv.includes('--database')) {
      const database = spawnSync(process.execPath, [join(root, 'tools', 'm5-07', 'migration-db.test.mjs')], {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, M5_07_API_DIST: apiDist },
      });
      if (database.error) throw database.error;
      if (database.status !== 0) throw new Error(`M5.07 isolated migration check failed with exit ${database.status ?? 'signal'}.`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'M5.07 focused harness failed.'}\n`);
    process.exitCode = 1;
  } finally {
    if (built && apiDist.startsWith(`${root}${sep}`)) rmSync(apiDist, { recursive: true, force: true });
  }
}
