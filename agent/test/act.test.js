import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActor } from '../src/act.js';

const config = {
  adminToken: 'admin-token-123456', actionTimeoutMs: 1000,
  actionTargets: { 'service-a': 'http://service-a:8080' },
};
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

function setup(...responses) {
  const calls = [];
  const recorded = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body && JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const pool = { query: async (sql, params) => { recorded.push(params); return { rows: [] }; } };
  return { execute: createActor({ config, pool, fetchImpl }), calls, recorded };
}

test('restart_pod posts /admin/restart with the admin token and records the action', async () => {
  const { execute, calls, recorded } = setup(ok({ restarted: true }));
  const r = await execute({ action: 'restart_pod', service: 'service-a', approvedBy: 'agent' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.response, { restarted: true });
  assert.equal(calls[0].url, 'http://service-a:8080/admin/restart');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['x-admin-token'], 'admin-token-123456');
  assert.deepEqual(recorded, [['service-a', 'restart_pod', 'agent']]);
});

test('scale_up reads current replicas and asks for one more', async () => {
  const { execute, calls } = setup(ok({ replicas: 2 }), ok({ scaled: true, replicas: 3 }));
  const r = await execute({ action: 'scale_up', service: 'service-a', approvedBy: 'agent' });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, 'http://service-a:8080/admin/state');
  assert.deepEqual(calls[1].body, { replicas: 3 });
});

test('a service outside ACTION_TARGETS is refused without any call or record', async () => {
  const { execute, calls, recorded } = setup();
  const r = await execute({ action: 'restart_pod', service: 'evil.example.com', approvedBy: 'agent' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not in ACTION_TARGETS/);
  assert.equal(calls.length + recorded.length, 0);
});

test('rollback is refused for the agent and simulated for a human', async () => {
  const { execute, calls, recorded } = setup();
  const agent = await execute({ action: 'rollback_deploy', service: 'service-a', approvedBy: 'agent' });
  assert.equal(agent.ok, false);
  const human = await execute({ action: 'rollback_deploy', service: 'service-a', approvedBy: 'human' });
  assert.equal(human.ok, true);
  assert.equal(human.response.simulated, true);
  assert.equal(calls.length, 0);
  assert.deepEqual(recorded, [['service-a', 'rollback_deploy', 'human']]);
});

test('unsupported action is refused', async () => {
  const { execute } = setup();
  assert.match((await execute({ action: 'escalate', service: 'service-a', approvedBy: 'human' })).error, /unsupported/);
});

test('timeout and HTTP errors return ok:false; the attempt is still recorded', async () => {
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  const t = setup(timeout);
  const r = await t.execute({ action: 'restart_pod', service: 'service-a', approvedBy: 'agent' });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out after 1000ms/);
  assert.equal(t.recorded.length, 1);
  const h = setup(new Response('{}', { status: 401 }));
  assert.match((await h.execute({ action: 'restart_pod', service: 'service-a', approvedBy: 'agent' })).error, /HTTP 401/);
});
