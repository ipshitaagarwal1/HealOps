import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';

function capture(level) {
  const lines = [];
  const logger = createLogger({}, { level, write: (s) => lines.push(s) });
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
}

test('every line is one JSON object with incident_id', () => {
  const { logger, lines, parsed } = capture('info');
  logger.info('hello', { a: 1 });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('\n'));
  const [line] = parsed();
  assert.equal(line.msg, 'hello');
  assert.equal(line.incident_id, null);
  assert.equal(line.a, 1);
});

test('child binds incident_id', () => {
  const { logger, parsed } = capture('info');
  logger.child({ incident_id: 'abc' }).warn('x');
  assert.equal(parsed()[0].incident_id, 'abc');
});

test('level filter drops lower levels', () => {
  const { logger, lines } = capture('warn');
  logger.info('dropped');
  logger.error('kept');
  assert.equal(lines.length, 1);
});

test('errors are serialised with their message', () => {
  const { logger, parsed } = capture('info');
  logger.error('boom', { err: new Error('bad thing') });
  assert.equal(parsed()[0].err.message, 'bad thing');
});
