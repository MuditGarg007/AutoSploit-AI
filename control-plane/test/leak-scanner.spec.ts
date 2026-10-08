import { describe, expect, it } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');
const planeRoot = path.join(repoRoot, 'control-plane');
const planeChart = path.join(repoRoot, 'deploy/helm/control-plane');

// Secret-split guard (docs/component-h-hardening.md §5.2), updated for the
// engagement-pipeline fat-image path (handoff #2, architecture A).
//
// ORIGINAL invariant: the model key must NEVER enter the plane at all. That held
// while the conductor ran as a separate pod with its own Secret (SEAM-2).
//
// ARCHITECTURE A relaxation (owner decision): the conductor now runs in-process
// inside the plane pod, so the plane pod's env MUST carry OPENROUTER_API_KEY for
// the spawned `conductor` subprocess to inherit. The chart therefore references
// the key — by `secretKeyRef` NAME only — on purpose. What must still hold, and
// what this scanner now guards:
//
//   A. No key VALUE (sk-or-v1-...) is ever committed to plane source, config, or
//      the chart. The value only ever lives in the k8s Secret at deploy time.
//   B. The plane APPLICATION code never reads or uses the key itself
//      (`process.env.OPENROUTER_API_KEY`): the plane forwards it to the conductor
//      child via inherited pod env, it does not consume it. EnvService has no
//      field for it.
//   C. The chart wires the key ONLY through a `secretKeyRef` (by name). An inline
//      literal value in the chart is a leak.
//
// Static scan of the checked-in tree (mirrored by the CI image value-scan in the
// release workflow), so it needs no containers or app.

// The key's value shape — a real secret can only match this. Forbidden everywhere.
const MODEL_KEY_VALUE = /sk-or-v1-[A-Za-z0-9]{8,}/i;
// The plane app reading the key from its own env = the plane consuming it. Only
// the conductor subprocess may do that (in conductor source, not plane source).
const PLANE_READS_KEY = /process\.env\.OPENROUTER_API_KEY/i;
// An inline value assignment: `OPENROUTER_API_KEY: "sk-..."` or `=sk-...`. A bare
// `secretKeyRef` wiring (key: OPENROUTER_API_KEY under secretKeyRef) is NOT this —
// there the name is a reference, with no value to the right.
const INLINE_VALUE = /OPENROUTER_API_KEY['"]?\s*[:=]\s*['"]?sk-/i;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = path.join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const isScannable = (f: string) =>
  /\.(ts|js|json|yml|yaml|env|dockerfile)$/i.test(f) && !f.endsWith('.spec.ts');

describe('Secret split (SEAM 2, architecture A) — no model-key leak into the plane', () => {
  it('EnvService declares no OPENROUTER_API_KEY field (plane never consumes the key)', async () => {
    const src = await readFile(
      path.join(planeRoot, 'src/config/env.service.ts'),
      'utf8',
    );
    // Documentation comments mentioning the name are fine; a field/assignment is not.
    expect(src.match(/OPENROUTER_API_KEY\s*[:=]/)).toBeNull();
  });

  it('plane application source never reads the key from env', async () => {
    const hits: string[] = [];
    for (const file of (await walk(path.join(planeRoot, 'src'))).filter((f) =>
      /\.(ts|js)$/i.test(f),
    )) {
      if (PLANE_READS_KEY.test(await readFile(file, 'utf8'))) hits.push(file);
    }
    expect(hits).toEqual([]);
  });

  it('no model-key VALUE anywhere in plane source, config, or the chart', async () => {
    const targets = [
      ...(await walk(planeRoot)).filter(isScannable),
      ...(await walk(planeChart)).filter(isScannable),
    ];
    const hits: string[] = [];
    for (const file of targets) {
      const text = await readFile(file, 'utf8');
      if (MODEL_KEY_VALUE.test(text)) hits.push(`${file} matched ${MODEL_KEY_VALUE}`);
      if (INLINE_VALUE.test(text)) hits.push(`${file} matched ${INLINE_VALUE}`);
    }
    expect(hits).toEqual([]);
  });

  it('the chart references the key only via secretKeyRef, never an inline value', async () => {
    const deployment = await readFile(
      path.join(planeChart, 'templates/app-deployment.yaml'),
      'utf8',
    );
    // If the deployment mentions the key at all (arch A: it does), the mention must
    // sit in a secretKeyRef block — the name used as a reference, not given a value.
    if (/OPENROUTER_API_KEY/.test(deployment)) {
      expect(deployment).toMatch(/secretKeyRef/);
      expect(INLINE_VALUE.test(deployment)).toBe(false);
    }
  });
});
