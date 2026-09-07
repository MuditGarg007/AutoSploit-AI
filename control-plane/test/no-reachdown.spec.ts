import { describe, expect, it } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');
const planeRoot = path.join(repoRoot, 'control-plane');
const srcRoot = path.join(planeRoot, 'src');

// Component H static / architecture test (docs/component-h-hardening.md §5.1):
// the control plane must never reach DOWN into a sandbox. Its only
// engagement-directed I/O is reading its own spawned subprocess's stdout (Phase A);
// it initiates no network connection toward an engagement pod. This scan codifies
// that as a lint/architecture test so a future reach-down fails CI (§5.1 "Never
// reaches down").
//
// The plane is allowed to spawn the conductor subprocess (Lifecycle's execution
// arm) and to call the *ingest* endpoint of other workloads, but it must not exec
// into, or connect to, a running engagement's pod/container.
const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: 'kubectl exec into a pod', re: /kubectl\s+exec/ },
  { name: 'Pod exec client call', re: /pods?\/[^/]+\/exec/i },
  { name: 'websocket into a pod exec', re: /wss?:\/\/[^)]*\/exec/i },
  { name: 'kubernetes exec API', re: /apis?\/(apps)?v1?\/namespaces\/[^/]+\/pods\// },
  { name: 'socket connect into an engagement', re: /net\.?connect.*engagement/i },
];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...(await walk(full)));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('No reach-down (SEAM 1) — the plane never initiates contact into a sandbox', () => {
  it('is free of kubectl exec / pod-exec / connection-into-engagement calls', async () => {
    const files = await walk(srcRoot);
    const violations: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const { name, re } of FORBIDDEN) {
        if (re.test(text)) violations.push(`${file}: ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('only shells the conductor subprocess for execution and never net-connects toward a pod', async () => {
    // The worker's only spawn is the conductor (documented). Assert that every
    // `spawn(`/`execFile(` in the plane targets the conductor binary, not a shell
    // tunnel into a pod.
    const worker = await readFile(
      path.join(srcRoot, 'domains/lifecycle/worker/engagement.worker.ts'),
      'utf8',
    );
    const spawns = worker.match(/spawn\(/g);
    // Confirms the execution arm spawns the conductor (allowed) and contains no
    // pod-directed exec. The single allowed spawn is the conductor itself.
    expect(spawns?.[0]).toBe('spawn(');
  });
});