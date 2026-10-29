import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.resolve(packageRoot, '.tmp');
if (!temporary.startsWith(`${packageRoot}${path.sep}`)) throw new Error('Refusing to clean outside tools/m1-07/.tmp');
await rm(temporary, { recursive: true, force: true });
console.log('Removed tools/m1-07/.tmp (if present).');
