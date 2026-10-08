import { Inject, Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { context, trace, Span, SpanStatusCode } from '@opentelemetry/api';
import { EnvService } from '../../../config/env.service.js';
import { LifecycleService, activeTraceparent } from '../lifecycle.service.js';
import type { EngagementState } from '../lifecycle.service.js';
import { IngestRelay } from './ingest-relay.js';
import type { EngagementJobData } from '../queue/engagement-queue.js';
import { traceparentToContext } from '../../../core/observability/trace-context.js';

// Shape of the surviving conductor.json record (conductor/src/autosploit_conductor/record.py).
interface ConductorRecord {
  engagement_id: string;
  repo_ref: string;
  started_at: string;
  finished_at: string;
  provision: { ok: boolean; exit_code: number | null; error: string | null };
  harness:
    | null
    | {
        status: 'complete' | 'partial' | 'failed';
        report_path: string | null;
        halt_reason: string | null;
        exit_code: number | null;
      };
  status: 'complete' | 'partial' | 'failed';
  report_path: string | null;
}

// Lifecycle's execution arm (NOT a separate service, docs/control-plane.md §5
// rule 2). Dequeues from BullMQ, shells `conductor run <repo> --engagement-id
// <id> --out <dir> --timeout-s <s>` (Phase A), relays each parsed harness event
// to ingest, and derives the terminal state from the conductor EXIT CODE + the
// surviving conductor.json record — never from the event stream (§5 rule 3,
// §7). The ingest endpoint it relays to is identical across both phases (§6).
@Injectable()
export class EngagementWorker {
  private readonly logger = new Logger(EngagementWorker.name);
  // engagementId -> abort controller for running engagements (abort API).
  private readonly runners = new Map<string, AbortController>();

  constructor(
    @Inject(EnvService) private readonly env: EnvService,
    @Inject(LifecycleService) private readonly lifecycle: LifecycleService,
    @Inject(IngestRelay) private readonly relay: IngestRelay,
  ) {}

  // Entry point from the BullMQ Worker. Runs one engagement to a terminal state.
  async process(job: { data: EngagementJobData }): Promise<void> {
    const { engagementId } = job.data;
    const abort = new AbortController();
    this.runners.set(engagementId, abort);

    try {
      await this.runUnderSpan(job.data, abort.signal);
    } catch (err) {
      this.logger.error(
        `engagement ${engagementId} worker error: ${(err as Error).message}`,
      );
      // Genuinely internal failure (spawn ENOENT, record unreadable) → failed[internal].
      await this.safeTransition(engagementId, 'failed', { fail: 'internal' });
    } finally {
      this.runners.delete(engagementId);
    }
  }

  // Open the worker span under the dispatch trace via the job's traceparent
  // (§6.2). When the job has none (pre-H or a standalone enqueue) we run over the
  // ambient context — the engine stays fail-open to tracing (a missing collector
  // must never change engagement behaviour).
  private async runUnderSpan(
    jobData: EngagementJobData,
    signal: AbortSignal,
  ): Promise<void> {
    const tracer = trace.getTracer('autosploit-control-plane');
    const parent = traceparentToContext(jobData.traceparent);
    await context.with(parent ?? context.active(), async () => {
      const span: Span = tracer.startSpan('engagement.worker');
      try {
        await this.runConductor(jobData, signal);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error).message,
        });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  // Signal a running engagement to halt. The controller calls this after the
  // ownership check. No-op if the engagement is not currently running.
  abort(engagementId: string): void {
    this.runners.get(engagementId)?.abort();
  }

  private async runConductor(
    job: EngagementJobData,
    signal: AbortSignal,
  ): Promise<void> {
    const { engagementId, repoRef, githubToken, ingestToken, timeoutS } = job;
    // Phase B (prod): drive the cluster. --k8s requires a scope port; use the
    // per-engagement targetPort, else the configured fallback. Phase A (dev/tests,
    // conductorK8s=false) keeps the original local-subprocess argv.
    const k8sArgs = this.env.conductorK8s
      ? [
          '--k8s',
          '--target-port',
          String(job.targetPort ?? this.env.conductorDefaultTargetPort),
        ]
      : [];
    // The conductor creates <out>/<engagement-id>/; the surviving conductor.json
    // record lives at <out>/<engagement-id>/conductor.json (§ record.py).
    const outBase = this.env.conductorOutDir;

    // The worker can dequeue before dispatch's queued → dispatched commit. Wait
    // for it so the first flip here (dispatched → attacking) is always legal.
    await this.waitForState(engagementId, 'dispatched');

    this.logger.log(`engagement ${engagementId}: spawning conductor for ${repoRef}`);

    // Terminal state is derived from the conductor exit code + record, so the
    // intermediate flips (provisioning/deploying/attacking) are best-effort
    // cosmetics driven by the process outcome, not the event stream. Walk them
    // in order — the state machine requires the full chain (§7).
    await this.safeTransition(engagementId, 'provisioning');
    await this.safeTransition(engagementId, 'deploying');
    await this.safeTransition(engagementId, 'attacking');

    const [cmd, ...cmdArgs] = splitCommand(this.env.conductorCmd);
    // The current W3C traceparent, stamped from the active worker span so the
    // conductor (a Python subprocess, Phase A) can continue the same trace (§6.3).
    // The harness stamps it onto emitted events; ingest extracts it as the parent.
    const traceparent = activeTraceparent();
    const child = spawn(
      cmd,
      [
        ...cmdArgs,
        'run',
        repoRef,
        '--engagement-id',
        engagementId,
        '--out',
        outBase,
        '--timeout-s',
        String(timeoutS),
        ...k8sArgs,
        ...(traceparent ? ['--traceparent', traceparent] : []),
      ],
      {
        // GITHUB_TOKEN goes to the conductor env for the cloner (provisioner
        // reads it from env only). The conductor never passes it to the harness.
        // OPENROUTER_API_KEY is deliberately absent — the conductor resolves it
        // from its own env (§6 secret split).
        env: {
          ...process.env,
          GITHUB_TOKEN: githubToken,
          ...(traceparent ? { TRACEPARENT: traceparent } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      },
    );

    let recordPath: string | null = null;
    const stdout = createInterface({ input: child.stdout });
    stdout.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('record=')) {
        recordPath = trimmed.slice('record='.length);
        return;
      }
      const event = this.tryParseEvent(trimmed);
      if (event) {
        // Fire-and-forget; ingest is tolerant (stub in P3, hardened in D-a).
        void this.relay.relay(engagementId, event, ingestToken);
      }
    });

    // Redact the GitHub token from any conductor stderr so it never lands in
    // logs (§6 secret split). Bounded to the last 4KB for diagnostics.
    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const text = redactSecret(chunk.toString('utf8'), githubToken);
      stderrTail = (stderrTail + text).slice(-4000);
    });

    const exit = await this.waitForExit(child, signal, engagementId);
    stdout.close();

    const record = recordPath ? await this.readRecord(recordPath) : null;
    if (!record && exit.killed) {
      // Aborted/timeout kill before the record was written.
      await this.safeTransition(engagementId, 'halted', { halt: 'timeout' });
      return;
    }
    if (!record) {
      this.logger.warn(`engagement ${engagementId}: no record; exit=${exit.code}`);
      await this.safeTransition(engagementId, 'failed', { fail: 'internal' });
      return;
    }

    const terminal = this.mapTerminal(record, exit);
    await this.safeTransition(engagementId, terminal.state, terminal.reason);
  }

  private async waitForExit(
    child: ReturnType<typeof spawn>,
    signal: AbortSignal,
    engagementId: string,
  ): Promise<{ code: number | null; killed: boolean }> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        // Spawn already killed the child (abort fired before/at spawn).
        resolve({ code: null, killed: true });
        return;
      }
      const onAbort = () => {
        this.logger.log(`engagement ${engagementId}: abort signal, killing conductor`);
        child.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      child.once('error', () => resolve({ code: null, killed: signal.aborted }));
      child.once('exit', (code, _signal) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ code, killed: signal.aborted });
      });
    });
  }

  private async readRecord(recordPath: string): Promise<ConductorRecord | null> {
    try {
      const raw = await readFile(recordPath, 'utf8');
      return JSON.parse(raw) as ConductorRecord;
    } catch {
      return null;
    }
  }

  // Map the conductor exit code + record to the authoritative terminal state
  // (docs/control-plane.md §7, §5 rule 3).
  private mapTerminal(
    record: ConductorRecord,
    exit: { code: number | null; killed: boolean },
  ): { state: EngagementState; reason?: { halt?: string; fail?: string } } {
    if (exit.killed) {
      return { state: 'halted', reason: { halt: 'timeout' } };
    }
    if (!record.provision.ok) {
      return { state: 'failed', reason: { fail: 'provision' } };
    }
    if (record.harness?.status === 'complete') {
      return { state: 'completed' };
    }
    if (record.harness?.status === 'partial') {
      return { state: 'halted', reason: { halt: this.normalizeHalt(record.harness.halt_reason) } };
    }
    // failed(harness) — or a missing harness block after provision "ok" (impossible
    // in practice, but fail-closed to harness failure rather than internal).
    return { state: 'failed', reason: { fail: 'harness' } };
  }

  // The record's halt_reason is free text from the harness; the state machine's
  // halted[] is budget | scope | timeout. Normalize known values, default scope.
  private normalizeHalt(reason: string | null): string {
    const r = reason?.toLowerCase() ?? '';
    if (r.includes('timeout')) return 'timeout';
    if (r.includes('budget')) return 'budget';
    if (r.includes('scope')) return 'scope';
    return 'scope';
  }

  private tryParseEvent(line: string): unknown {
    if (!line.startsWith('{')) return null;
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return null;
    }
  }

  // Poll until the engagement reaches the expected state (dispatch's commit).
  // Throws on timeout: a job that never leaves `queued` means dispatch half-
  // failed (enqueue ok, transition lost) — running the conductor would just
  // produce illegal transitions and a stuck row, so fail closed instead.
  private async waitForState(
    engagementId: string,
    expected: string,
  ): Promise<void> {
    for (let i = 0; i < 100; i++) {
      try {
        const state = await this.lifecycle.getState(engagementId);
        if (state === expected) return;
        if (state !== 'queued') return; // moved past it already — proceed
      } catch {
        // Row not visible yet — keep polling.
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`engagement ${engagementId} never reached ${expected}`);
  }

  // Transition that swallows NotFound/Conflict — the worker must never crash a
  // BullMQ job retry loop over a state it already resolved.
  private async safeTransition(
    engagementId: string,
    to: EngagementState,
    reason?: { halt?: string; fail?: string },
  ): Promise<void> {
    try {
      await this.lifecycle.transition(engagementId, to, reason);
    } catch (err) {
      this.logger.warn(
        `engagement ${engagementId}: transition ${to} skipped: ${(err as Error).message}`,
      );
    }
  }
}

// Split a CONDUCTOR_CMD into argv tokens, honoring double quotes so a command
// like `node "C:\Program Files\app\conductor.mjs"` survives spaces in paths.
// CONDUCTOR_CMD is operator-controlled config, never untrusted input, so this
// is not a command-injection surface (the tokens go to spawn, not a shell).
export function splitCommand(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    tokens.push(m[1] ?? m[2]);
  }
  return tokens;
}

// Replace every occurrence of a secret in a stream chunk with the neutral
// placeholder (docs/component-h-hardening.md §5.2). Exported for the hardening
// proof: "conductor writes the token to stderr → logs contain `<redacted>` and
// never the token bytes". The guard is applied to the worker's conductor stderr
// capture so a leaked token can never reach a persisted log.
export function redactSecret(chunk: string, secret: string): string {
  if (!secret) return chunk;
  return chunk.replaceAll(secret, '<redacted>');
}
