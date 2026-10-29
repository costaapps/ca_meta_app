import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const browserOutput = path.join(repositoryRoot, 'apps', 'web', 'dist', 'meta-integration', 'browser');
const forbiddenPackage = /(?:@nestjs(?:\/|%2f)|\btypeorm\b|\bmysql2\b|\bmariadb\b|\bbcrypt\b|\bargon2\b|node:crypto|crypto-js|@aws-sdk(?:\/|%2f))/i;
const credentialValue = /\b(?:META_APP_SECRET|FACEBOOK_APP_SECRET|WHATSAPP_APP_SECRET|CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN|API_KEY|clientSecret|appSecret|accessToken|refreshToken|apiKey)\b\s*[:=]\s*['"`]([A-Za-z0-9._~+\/=\-]{12,})/i;
const privateKey = /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/;
const bundleExtensions = new Set(['.js', '.mjs', '.css', '.html']);
const findings = [];
let bundleFiles = 0;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(filePath);
    } else if (entry.isFile() && bundleExtensions.has(path.extname(entry.name))) {
      bundleFiles += 1;
      const content = await readFile(filePath, 'utf8');
      if (forbiddenPackage.test(content)) {
        findings.push(`${path.relative(repositoryRoot, filePath)}: server-only dependency marker`);
      }
      if (credentialValue.test(content)) {
        findings.push(`${path.relative(repositoryRoot, filePath)}: credential-like constant assignment`);
      }
      if (privateKey.test(content)) {
        findings.push(`${path.relative(repositoryRoot, filePath)}: private-key material`);
      }
    }
  }
}

try {
  await stat(browserOutput);
  await walk(browserOutput);
} catch (error) {
  console.error(`Expected Angular browser output at ${path.relative(repositoryRoot, browserOutput)}: ${error.message}`);
  process.exitCode = 2;
}

if (findings.length > 0) {
  console.error(`Server-only dependency markers found in browser output:\n${findings.join('\n')}`);
  process.exitCode = 1;
} else if (process.exitCode === undefined) {
  console.log(`Web bundle scan passed (${bundleFiles} browser files inspected).`);
}
