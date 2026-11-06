import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

const SHA256_HEX = /^[a-f0-9]{64}$/i;

export function signatureDigest(rawBody: Buffer, signatureHeader: string | undefined): Buffer | undefined {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return undefined;
  const hex = signatureHeader.slice('sha256='.length);
  if (!SHA256_HEX.test(hex)) return undefined;
  return Buffer.from(hex, 'hex');
}

export function verifyMetaWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecretVersions: readonly Buffer[],
): boolean {
  const supplied = signatureDigest(rawBody, signatureHeader);
  if (!supplied || appSecretVersions.length === 0 || appSecretVersions.length > 3) return false;

  let matched = 0;
  for (const secret of appSecretVersions) {
    if (!Buffer.isBuffer(secret) || secret.length < 1 || secret.length > 512) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    // All active versions are checked; the boolean accumulator avoids a key-position timing leak.
    matched |= Number(timingSafeEqual(expected, supplied));
  }
  return matched === 1;
}

export function verifyChallengeToken(candidate: string | undefined, expected: string | undefined): boolean {
  if (candidate === undefined || expected === undefined || candidate.length < 1 || expected.length < 1 ||
      candidate.length > 512 || expected.length > 512) return false;
  const candidateHash = createHash('sha256').update(candidate, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(candidateHash, expectedHash);
}
