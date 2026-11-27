import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_MS = 5 * 60 * 1000;

export function verifyPigeonSignature(
  signature: string | undefined,
  rawBody: Buffer,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (!signature) return false;
  const match = /^t=(\d+),v1=([a-f\d]{64})$/i.exec(signature);
  if (!match) return false;

  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || nowMs - timestamp * 1000 > MAX_AGE_MS) return false;

  const actual = Buffer.from(match[2], 'hex');
  const expected = createHmac('sha256', secret)
    .update(`${match[1]}.`)
    .update(rawBody)
    .digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
