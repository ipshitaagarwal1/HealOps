// One test group per rule in docs/SPEC.md section 6.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGuardrail } from '../src/guardrail.js';

const NOW = new Date('2026-10-06T12:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000);

const CONFIG = Object.freeze({
  confRestart: 0.8,
  confScale: 0.75,
  cooldownMin: 10,
  maxActionsPerHour: 3,
  noContextPenalty: 0.15,
  ragMinSimilarity: 0.72,
  dryRun: false,
});
const CONTEXT = [{ id: 1, title: 'Memory leak: restart the service', similarity: 0.8 }];

// A passing restart by default; each test changes one thing.
function evaluate({ action = 'restart_pod', confidence = 0.9, retrieved = CONTEXT, history = [],
  config = {}, service = 'service-a' } = {}) {
  return evaluateGuardrail({
    diagnosis: { root_cause: 'x', evidence: 'y', action, confidence, reasoning: 'z' },
    service,
    retrieved,
    history,
    config: { ...CONFIG, ...config },
    now: NOW,
  });
}
const codes = (result) => result.reasons.map((r) => r.split(':')[0]);
const action = (min, extra = {}) => ({ service: 'service-a', action: 'restart_pod', approved_by: 'agent', at: minutesAgo(min), ...extra });

describe('baseline', () => {
  test('confident restart with context and no history executes with no reasons', () => {
    const r = evaluate();
    assert.equal(r.decision, 'execute');
    assert.deepEqual(r.reasons, []);
    assert.equal(r.effective_confidence, 0.9);
  });
});

describe('rule: escalate -> ticket', () => {
  test('escalate becomes a ticket even at full confidence', () => {
    const r = evaluate({ action: 'escalate', confidence: 1 });
    assert.equal(r.decision, 'ticket');
    assert.deepEqual(codes(r), ['escalate']);
  });
});

describe('rule: rollback_deploy -> ticket always', () => {
  test('rollback at confidence 1.0 with context still becomes a ticket', () => {
    const r = evaluate({ action: 'rollback_deploy', confidence: 1 });
    assert.equal(r.decision, 'ticket');
    assert.deepEqual(codes(r), ['high_risk_action']);
  });

  test('rollback stays a ticket even with DRY_RUN off and no history', () => {
    assert.equal(evaluate({ action: 'rollback_deploy', confidence: 0.99, config: { dryRun: false } }).decision, 'ticket');
  });
});

describe('rule: unknown action -> ticket', () => {
  // null, not undefined: undefined would trigger the helper's default action.
  for (const bad of ['delete_pod', 'RESTART_POD', '', null, 'toString']) {
    test(`action ${JSON.stringify(bad)} becomes a ticket`, () => {
      const r = evaluate({ action: bad, confidence: 1 });
      assert.equal(r.decision, 'ticket');
      assert.deepEqual(codes(r), ['unknown_action']);
    });
  }
});

describe('rule: no RAG context -> subtract NO_CONTEXT_PENALTY first', () => {
  test('penalty pushes 0.90 restart below 0.80 -> ticket with both reasons', () => {
    const r = evaluate({ confidence: 0.9, retrieved: [] });
    assert.equal(r.effective_confidence, 0.75);
    assert.equal(r.decision, 'ticket');
    assert.deepEqual(codes(r), ['no_context', 'low_confidence']);
  });

  test('penalty is subtracted, not a veto: 0.99 - 0.15 = 0.84 still executes', () => {
    const r = evaluate({ confidence: 0.99, retrieved: [] });
    assert.equal(r.effective_confidence, 0.84);
    assert.equal(r.decision, 'execute');
    assert.deepEqual(codes(r), ['no_context']);
  });

  test('results below RAG_MIN_SIMILARITY count as no context', () => {
    const r = evaluate({ confidence: 0.9, retrieved: [{ id: 1, title: 't', similarity: 0.71 }] });
    assert.equal(r.effective_confidence, 0.75);
    assert.deepEqual(codes(r), ['no_context', 'low_confidence']);
  });

  test('no floating point drift: 0.95 - 0.15 meets a 0.80 threshold', () => {
    const r = evaluate({ confidence: 0.95, retrieved: [] });
    assert.equal(r.effective_confidence, 0.8);
    assert.equal(r.decision, 'execute');
  });

  test('effective confidence never goes below 0', () => {
    assert.equal(evaluate({ confidence: 0.05, retrieved: [] }).effective_confidence, 0);
  });
});

describe('rule: restart_pod needs confidence >= CONF_RESTART', () => {
  test('0.79 -> ticket', () => {
    const r = evaluate({ confidence: 0.79 });
    assert.equal(r.decision, 'ticket');
    assert.deepEqual(codes(r), ['low_confidence']);
  });

  test('exactly 0.80 -> execute', () => {
    assert.equal(evaluate({ confidence: 0.8 }).decision, 'execute');
  });
});

describe('rule: scale_up needs confidence >= CONF_SCALE', () => {
  test('0.74 -> ticket', () => {
    const r = evaluate({ action: 'scale_up', confidence: 0.74 });
    assert.equal(r.decision, 'ticket');
    assert.deepEqual(codes(r), ['low_confidence']);
  });

  test('0.76 -> execute (would fail the restart threshold, so thresholds are per action)', () => {
    assert.equal(evaluate({ action: 'scale_up', confidence: 0.76 }).decision, 'execute');
  });
});

describe('rule: cooldown', () => {
  test('automated action on the same service 5 min ago -> ticket cooldown_active', () => {
    const r = evaluate({ history: [action(5)] });
    assert.equal(r.decision, 'ticket');
    assert.deepEqual(codes(r), ['cooldown_active']);
  });

  test('any automated action counts, not just the same action type', () => {
    assert.deepEqual(codes(evaluate({ action: 'scale_up', history: [action(5)] })), ['cooldown_active']);
  });

  test('action exactly COOLDOWN_MIN ago is outside the cooldown', () => {
    assert.equal(evaluate({ history: [action(10)] }).decision, 'execute');
  });

  test('action on a different service does not count', () => {
    assert.equal(evaluate({ history: [action(5, { service: 'service-b' })] }).decision, 'execute');
  });

  test('a human-approved action is not an automated action', () => {
    assert.equal(evaluate({ history: [action(5, { approved_by: 'human' })] }).decision, 'execute');
  });

  test('history timestamps may be ISO strings (as read from JSON)', () => {
    assert.deepEqual(codes(evaluate({ history: [action(5, { at: minutesAgo(5).toISOString() })] })), ['cooldown_active']);
  });
});

describe('rule: circuit breaker', () => {
  test('MAX_ACTIONS_PER_HOUR actions in the last 60 min -> ticket too_many_actions', () => {
    const r = evaluate({ history: [action(15), action(30), action(45)] });
    assert.equal(r.decision, 'ticket');
    assert.deepEqual(codes(r), ['too_many_actions']);
  });

  test('one fewer than the limit -> execute', () => {
    assert.equal(evaluate({ history: [action(15), action(30)] }).decision, 'execute');
  });

  test('actions older than 60 minutes do not count', () => {
    assert.equal(evaluate({ history: [action(15), action(30), action(61)] }).decision, 'execute');
  });

  test('human-approved actions count towards the limit', () => {
    const r = evaluate({ history: [action(15, { approved_by: 'human' }), action(30), action(45)] });
    assert.deepEqual(codes(r), ['too_many_actions']);
  });

  test('other services do not count', () => {
    const other = { service: 'service-b' };
    assert.equal(evaluate({ history: [action(15, other), action(30, other), action(45, other)] }).decision, 'execute');
  });
});

describe('rule: DRY_RUN downgrades execute to ticket', () => {
  test('an action that would execute becomes a ticket with reason dry_run', () => {
    const r = evaluate({ config: { dryRun: true } });
    assert.equal(r.decision, 'ticket');
    assert.deepEqual(codes(r), ['dry_run']);
  });

  test('dry_run is not added when another rule already blocked the action', () => {
    assert.deepEqual(codes(evaluate({ confidence: 0.5, config: { dryRun: true } })), ['low_confidence']);
  });
});

describe('combined rules and purity', () => {
  test('every triggered rule adds its own human-readable reason', () => {
    const r = evaluate({ confidence: 0.85, retrieved: [], history: [action(5), action(20), action(40)] });
    assert.equal(r.decision, 'ticket');
    assert.deepEqual(codes(r), ['no_context', 'low_confidence', 'cooldown_active', 'too_many_actions']);
    assert.ok(r.reasons.every((s) => s.length > 20), 'reasons should explain, not just name a code');
  });

  test('reasons include the numbers a human needs', () => {
    const [reason] = evaluate({ history: [action(4)] }).reasons;
    assert.match(reason, /service-a/);
    assert.match(reason, /4\.0 min ago/);
    assert.match(reason, /10 min/);
  });

  test('invalid confidence -> ticket', () => {
    for (const c of [NaN, -0.1, 1.5, '0.9']) {
      assert.deepEqual(codes(evaluate({ confidence: c })), ['invalid_confidence'], String(c));
    }
  });

  test('deterministic and does not mutate its inputs', () => {
    const history = Object.freeze([Object.freeze(action(20))]);
    const retrieved = Object.freeze([Object.freeze({ ...CONTEXT[0] })]);
    const input = {
      diagnosis: Object.freeze({ action: 'restart_pod', confidence: 0.9 }),
      service: 'service-a', retrieved, history, config: CONFIG, now: NOW,
    };
    assert.deepEqual(evaluateGuardrail(input), evaluateGuardrail(input));
  });
});
