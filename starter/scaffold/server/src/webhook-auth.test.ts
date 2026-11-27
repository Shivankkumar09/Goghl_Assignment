import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { verifyPigeonSignature } from './webhook-auth.js';

const secret = 'test-secret';
const now = 1_800_000_000_000;
const body = Buffer.from('{"type":"message.inbound"}');

function signature(timestamp: number, rawBody = body): string {
  const t = String(timestamp);
  const digest = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  return `t=${t},v1=${digest}`;
}

test('accepts a matching raw-body signature within the five-minute window', () => {
  assert.equal(verifyPigeonSignature(signature(now / 1000), body, secret, now), true);
});

test('rejects missing, malformed, altered, and stale signatures', () => {
  assert.equal(verifyPigeonSignature(undefined, body, secret, now), false);
  assert.equal(verifyPigeonSignature('not-a-signature', body, secret, now), false);
  assert.equal(verifyPigeonSignature(signature(now / 1000), Buffer.from('altered'), secret, now), false);
  assert.equal(verifyPigeonSignature(signature(now / 1000 - 301), body, secret, now), false);
});
