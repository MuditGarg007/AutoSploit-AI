#!/usr/bin/env node
// Fake conductor for Component C CI tests (docs/control-plane.md §12 gate C).
// Mirrors the real `conductor run` contract (conductor/src/autosploit_conductor/cli.py):
//   - argv: run <repo> --engagement-id <id> --out <dir> --timeout-s <s>
//   - stdout: harness JSONL events + trailing `report=<path>` / `record=<path>`
//   - exit 0 = complete|partial (status lives in the record), 1 = failed
//   - writes conductor.json at <out>/<engagement-id>/conductor.json AFTER the run
// Scenario is selected by FAKE_CONDUCTOR_MODE (complete|partial|failed-provision|failed-harness).
// Prints the GITHUB_TOKEN presence marker (the worker must pass it in env) and
// honors --timeout-s for the timeout case by sleeping past it... the worker's
// abort is what kills us; we just sleep briefly for the abort/timeout cases.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const mode = process.env.FAKE_CONDUCTOR_MODE ?? 'complete';
const repo = args[0];
const engagementId = opt('--engagement-id') ?? 'eng';
const out = opt('--out') ?? '.';
const timeoutS = Number(opt('--timeout-s') ?? 3600);

const workdir = path.join(out, engagementId);
mkdirSync(workdir, { recursive: true });

const token = process.env.GITHUB_TOKEN ?? '';
// Marker the spec reads back to prove the token reached the conductor env.
writeFileSync(path.join(workdir, 'token-seen'), token ? 'present' : 'absent');

const ts = new Date().toISOString();
const emit = (type, data) => console.log(JSON.stringify({ ts, type, data }));

// Harness-style events (phase start, a couple of events) — matches the frozen
// harness.md §7 envelope shape the worker relays to ingest.
emit('phase', { stage: 'start' });
if (mode !== 'failed-provision') {
  emit('cost', { tokens: 100, usd: 0.01, tool_calls: 2, caps: {} });
  emit('finding', {
    id: 'F-001',
    title: 'fake finding',
    severity: 'low',
    evidence: 'x',
    repro: 'y',
  });
}

let status = 'failed';
let haltReason = null;
let exitCode = 1;
let provisionOk = true;
let provisionError = null;
const harness = { status: 'failed', report_path: null, halt_reason: null, exit_code: 1 };

if (mode === 'complete') {
  status = 'complete';
  exitCode = 0;
  harness.status = 'complete';
  harness.exit_code = 0;
  emit('phase', { stage: 'end', completed: true, turns: 2 });
} else if (mode === 'partial') {
  status = 'partial';
  exitCode = 0;
  harness.status = 'partial';
  harness.halt_reason = 'budget';
  harness.exit_code = 2;
  emit('halt', { cause: 'budget', reason: 'budget cap exceeded', tokens: 50, usd: 0.01 });
} else if (mode === 'failed-provision') {
  provisionOk = false;
  provisionError = 'fake provision failure';
  status = 'failed';
  exitCode = 1;
  harness.status = 'failed';
} else {
  // failed-harness (default)
  status = 'failed';
  exitCode = 1;
  harness.status = 'failed';
  harness.exit_code = 1;
}

const record = {
  engagement_id: engagementId,
  repo_ref: repo,
  started_at: ts,
  finished_at: new Date().toISOString(),
  provision: { ok: provisionOk, exit_code: provisionOk ? 0 : 1, error: provisionError },
  harness: provisionOk ? harness : null,
  status,
  report_path: null,
};

const recordPath = path.join(workdir, 'conductor.json');
writeFileSync(recordPath, JSON.stringify(record, null, 2));

console.log(`report=${path.join(workdir, 'report.json')}`);
console.log(`record=${recordPath}`);

// Brief pause so the abort/timeout tests have a window to signal us.
if (mode === 'timeout' || timeoutS <= 1) {
  await new Promise((r) => setTimeout(r, 500));
}
process.exit(exitCode);
