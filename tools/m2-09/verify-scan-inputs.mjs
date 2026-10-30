import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

function reject(message) {
  throw new Error(message);
}

const directory = resolve(process.argv[2] ?? '');
const sourceRevision = process.env.SOURCE_REVISION;
if (process.argv.length < 3 || !/^[0-9a-f]{40}$/.test(sourceRevision ?? '')) {
  console.error('Usage: SOURCE_REVISION=<full-sha> node tools/m2-09/verify-scan-inputs.mjs <artifact-directory>');
  process.exit(2);
}

try {
  const input = JSON.parse(await readFile(join(directory, 'scan-inputs.json'), 'utf8'));
  if (input.sourceRevision !== sourceRevision || !input.images || typeof input.images !== 'object') {
    reject('Scan artifact source does not match the build job SHA.');
  }

  let namespace;
  for (const kind of ['web', 'api']) {
    const image = input.images[kind];
    const imageNamespace = image?.imageReference?.split('/')[1];
    const expectedName = `docker.io/${imageNamespace}/ca-meta-${kind}`;
    const referencePattern = new RegExp(`^docker\\.io\\/[a-z0-9][a-z0-9_-]*\\/ca-meta-${kind}@sha256:[0-9a-f]{64}$`);
    if (!image || !referencePattern.test(image.imageReference) || image.imageReference !== `${expectedName}@${image.digest}`) {
      reject(`${kind} scan artifact image reference is invalid.`);
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(image.digest) || image.sourceRevision !== sourceRevision) {
      reject(`${kind} scan artifact digest or source SHA is invalid.`);
    }
    if (image.archive !== `${kind}.tar` || basename(image.archive) !== image.archive || !/^[0-9a-f]{64}$/.test(image.sha256)) {
      reject(`${kind} scan archive metadata is invalid.`);
    }
    if (namespace && imageNamespace !== namespace) reject('Web and API scan images use different namespaces.');
    namespace = imageNamespace;
    const archive = await readFile(join(directory, 'scan-images', image.archive));
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== image.sha256) reject(`${kind} scan archive checksum does not match build metadata.`);
  }
  console.log(`Scan archives verified for source ${sourceRevision}.`);
} catch (error) {
  console.error(`Scan inputs rejected: ${error.message}`);
  process.exit(1);
}
