import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function reject(message) {
  throw new Error(message);
}

export function expectedScanImagesFromEnvironment(environment = process.env) {
  const sourceRevision = environment.SOURCE_REVISION;
  if (!/^[0-9a-f]{40}$/.test(sourceRevision ?? '')) reject('SOURCE_REVISION must be the full build SHA.');
  const images = {};
  for (const kind of ['web', 'api']) {
    const prefix = kind.toUpperCase();
    images[kind] = {
      subjectName: environment[`${prefix}_SUBJECT_NAME`],
      imageReference: environment[`${prefix}_IMAGE_REF`],
      digest: environment[`${prefix}_DIGEST`],
    };
  }
  return { sourceRevision, images };
}

export function validateScanInputs(input, expected) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.sourceRevision !== expected?.sourceRevision || !input.images || typeof input.images !== 'object') {
    reject('Scan artifact source does not match the build job SHA.');
  }

  let namespace;
  for (const kind of ['web', 'api']) {
    const actual = input.images[kind];
    const target = expected.images?.[kind];
    if (!target || !/^sha256:[0-9a-f]{64}$/.test(target.digest ?? '')) reject(`Build output ${kind} digest is invalid.`);
    const expectedName = target.subjectName;
    const expectedNamespace = typeof expectedName === 'string' ? expectedName.split('/')[1] : undefined;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(expectedNamespace ?? '') || expectedName !== `docker.io/${expectedNamespace}/ca-meta-${kind}` || target.imageReference !== `${expectedName}@${target.digest}`) {
      reject(`Build output ${kind} image identity is invalid.`);
    }
    const referencePattern = new RegExp(`^docker\\.io\\/${expectedNamespace}\\/ca-meta-${kind}@sha256:[0-9a-f]{64}$`);
    if (!actual || actual.subjectName !== expectedName || actual.imageReference !== target.imageReference || actual.digest !== target.digest || actual.sourceRevision !== expected.sourceRevision || !referencePattern.test(actual.imageReference)) {
      reject(`${kind} scan archive identity does not match the image name, reference and digest outputs from build-images.`);
    }
    if (actual.archive !== `${kind}.tar` || basename(actual.archive) !== actual.archive || !/^[0-9a-f]{64}$/.test(actual.sha256 ?? '')) {
      reject(`${kind} scan archive metadata is invalid.`);
    }
    if (namespace && expectedNamespace !== namespace) reject('Build outputs use different Docker Hub namespaces.');
    namespace = expectedNamespace;
  }
  return input;
}

async function main() {
  const directory = resolve(process.argv[2] ?? '');
  if (process.argv.length < 3) reject('Usage: node tools/m2-09/verify-scan-inputs.mjs <artifact-directory>');
  const expected = expectedScanImagesFromEnvironment();
  const input = validateScanInputs(JSON.parse(await readFile(join(directory, 'scan-inputs.json'), 'utf8')), expected);

  for (const kind of ['web', 'api']) {
    const archive = await readFile(join(directory, 'scan-images', input.images[kind].archive));
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== input.images[kind].sha256) reject(`${kind} scan archive checksum does not match build metadata.`);
  }
  console.log(`Scan archives verified against build outputs for source ${expected.sourceRevision}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(`Scan inputs rejected: ${error.message}`);
    process.exit(1);
  }
}
