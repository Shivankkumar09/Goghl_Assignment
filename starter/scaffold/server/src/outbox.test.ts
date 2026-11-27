import assert from 'node:assert/strict';
import test from 'node:test';
import { retryDelay } from './outbox.js';

test('Retry-After seconds are honored without exponential adjustment', () => {
  assert.equal(retryDelay(6, '2', 10_000), 2_000);
  assert.equal(retryDelay(1, '0', 10_000), 0);
});

test('transient failures use capped exponential backoff when Retry-After is absent', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => retryDelay(attempt, null, 0)),
    [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
  );
});
