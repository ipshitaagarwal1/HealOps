import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/ratelimit.js';

function run(middleware, req) {
  const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('allows up to max requests per key within the window', () => {
  const limiter = createRateLimiter({ windowMs: 10_000, max: 3 });
  const req = { get: () => 'tok-a', ip: '1.1.1.1' };
  for (let i = 0; i < 3; i++) {
    const { nextCalled } = run(limiter, req);
    assert.equal(nextCalled, true);
  }
  const { nextCalled, res } = run(limiter, req);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.ok(res.headers['Retry-After']);
});

test('tracks separate keys independently', () => {
  const limiter = createRateLimiter({ windowMs: 10_000, max: 1 });
  const reqA = { get: () => 'tok-a', ip: '1.1.1.1' };
  const reqB = { get: () => 'tok-b', ip: '1.1.1.1' };
  assert.equal(run(limiter, reqA).nextCalled, true);
  assert.equal(run(limiter, reqA).nextCalled, false);
  assert.equal(run(limiter, reqB).nextCalled, true);
});

test('allows again once the window has passed', async () => {
  const limiter = createRateLimiter({ windowMs: 20, max: 1 });
  const req = { get: () => 'tok-a', ip: '1.1.1.1' };
  assert.equal(run(limiter, req).nextCalled, true);
  assert.equal(run(limiter, req).nextCalled, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(run(limiter, req).nextCalled, true);
});
