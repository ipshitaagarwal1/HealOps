#!/usr/bin/env node
// Polls the agent's dashboard API for the outcome of one demo step. Used only by
// scripts/demo.sh, which needs to know when an async pipeline run (webhook -> retrieve
// -> diagnose -> guardrail -> act|ticket) has finished, not just that it started.
//
// Usage:
//   node scripts/demo-wait.js incident <service> <after-iso> <statuses-csv> <timeoutSec>
//   node scripts/demo-wait.js ticket   <service> <after-iso> <reason-substring|-> <timeoutSec>

import http from 'node:http';

const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3000';

function usage() {
  console.error('usage: demo-wait.js incident <service> <after-iso> <statuses-csv> <timeoutSec>');
  console.error('       demo-wait.js ticket   <service> <after-iso> <reason-substring|-> <timeoutSec>');
  process.exit(2);
}

// Plain node:http instead of fetch(): fetch's AbortController/AbortSignal.timeout path,
// torn down repeatedly in a tight poll loop, has hit a libuv assertion on some Node
// builds (observed on Node 24 / Windows). http.get with a plain `timeout` option avoids
// that code path entirely.
function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${AGENT_URL}${path}`, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`GET ${path} -> HTTP ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`GET ${path} -> invalid JSON: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${path} timed out`)));
    req.on('error', reject);
  });
}

// check() returns the matching row, or null/undefined while still waiting. It may
// also set lastSeen.value so a timeout can report the closest miss.
async function poll(timeoutSec, check) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const found = await check();
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const [mode, service, afterIso, arg, timeoutStr] = process.argv.slice(2);
if (!mode || !service || !afterIso || !arg || !timeoutStr) usage();
const after = new Date(afterIso).getTime();
const timeoutSec = Number(timeoutStr);
if (!Number.isFinite(after) || !Number.isFinite(timeoutSec)) usage();

let lastSeen = null;
let lastError = null;

if (mode === 'incident') {
  const statuses = new Set(arg.split(','));
  const found = await poll(timeoutSec, async () => {
    try {
      const rows = await getJson('/api/incidents?limit=20');
      const match = rows.find((r) => r.service === service && new Date(r.received_at).getTime() >= after);
      if (match) lastSeen = match;
      return match && statuses.has(match.status) ? match : null;
    } catch (err) {
      lastError = err.message;
      return null;
    }
  });
  if (!found) {
    console.error(`TIMEOUT waiting for ${service} incident status in [${arg}]; last seen: ${JSON.stringify(lastSeen)}; last error: ${lastError ?? 'none'}`);
    process.exit(1);
  }
  console.log(JSON.stringify(found));
  process.exit(0);
} else if (mode === 'ticket') {
  const reasonSubstring = arg === '-' ? null : arg;
  const found = await poll(timeoutSec, async () => {
    try {
      const rows = await getJson('/api/tickets?status=open');
      return rows.find((r) => r.service === service
        && new Date(r.created_at).getTime() >= after
        && (reasonSubstring === null || (r.reason_for_escalation || '').includes(reasonSubstring))) ?? null;
    } catch (err) {
      lastError = err.message;
      return null;
    }
  });
  if (!found) {
    console.error(`TIMEOUT waiting for open ${service} ticket${reasonSubstring ? ` with reason containing "${reasonSubstring}"` : ''}; last error: ${lastError ?? 'none'}`);
    process.exit(1);
  }
  console.log(JSON.stringify(found));
  process.exit(0);
} else {
  usage();
}
