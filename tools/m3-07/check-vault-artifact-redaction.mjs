import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const markerSeed = process.env.M2_COMPOSE_PROJECT?.slice('m205-'.length) ?? '';
assert.match(markerSeed, /^[a-f0-9]{32}$/i, 'the disposable MariaDB profile provides a synthetic run identifier');
const markerSecrets = [0, 1].map((index) => `m3-07-synthetic-marker-${index}-${markerSeed}`);
const reportPaths = [
  'artifacts/test-results/m3-07-credential-vault.junit.xml',
  'artifacts/test-results/m3-07-credential-vault.lcov.info',
];

for (const reportPath of reportPaths) {
  const report = readFileSync(reportPath);
  for (const marker of markerSecrets) {
    const markerBytes = Buffer.from(marker, 'utf8');
    const representations = [markerBytes, Buffer.from(markerBytes.toString('hex')), Buffer.from(markerBytes.toString('base64'))];
    assert.equal(representations.some((representation) => report.includes(representation)), false,
      `${reportPath} does not expose a synthetic credential marker`);
  }
}

process.stdout.write('M3.07 test reports contain no synthetic credential marker.\n');
