import { describe, expect, it, vi } from 'vitest';
import { EngagementWorker } from '../src/domains/lifecycle/worker/engagement.worker.js';
import type { EngagementJobData } from '../src/domains/lifecycle/queue/engagement-queue.js';
import type { EngagementState } from '../src/domains/lifecycle/lifecycle.service.js';

// Hermetic unit coverage for the worker's stalled-job guard (no containers, no
// subprocess). BullMQ re-delivers a job whose lock expired (a worker pod restart
// mid-run); `attempts: 1` does not cover a stall. A redelivery must NOT re-walk
// the cosmetic state chain (which would spam `Illegal state transition`) or
// re-spawn the conductor for an already-advanced / torn-down engagement.
describe('EngagementWorker — stalled-job guard', () => {
  const baseJob: EngagementJobData = {
    engagementId: 'eng-1',
    repoRef: 'github.com/alice/app',
    githubToken: 'ghp_x',
    ingestToken: 'ingest_x',
    timeoutS: 60,
  };

  // env is read (k8sArgs/outDir) before the guard, so provide the fields touched.
  const fakeEnv = {
    conductorK8s: false,
    conductorDefaultTargetPort: 5000,
    conductorOutDir: '/tmp/autosploit-runs',
    conductorCmd: 'node /nonexistent/conductor.mjs',
  };

  function makeWorker(state: EngagementState) {
    const transition = vi.fn().mockResolvedValue(undefined);
    const getState = vi.fn().mockResolvedValue(state);
    const relay = vi.fn().mockResolvedValue(undefined);
    const lifecycle = { getState, transition };
    const worker = new EngagementWorker(
      fakeEnv as never,
      lifecycle as never,
      { relay } as never,
    );
    return { worker, transition, getState, relay };
  }

  for (const state of ['attacking', 'completed', 'failed', 'halted'] as const) {
    it(`skips a redelivered job already at ${state} without walking or spawning`, async () => {
      const { worker, transition, relay } = makeWorker(state);

      await worker.process({ data: baseJob });

      // The guard returned before the provisioning/deploying/attacking walk, so
      // the authoritative row was never touched and no event was relayed. If the
      // conductor had been re-spawned, the fake CONDUCTOR_CMD path would also
      // have driven a terminal transition — none happened.
      expect(transition).not.toHaveBeenCalled();
      expect(relay).not.toHaveBeenCalled();
    });
  }

  it('does NOT skip a first delivery still at dispatched', async () => {
    // getState returns `dispatched` (waitForState succeeds, guard passes), so the
    // worker proceeds into the walk and flips to provisioning. The spawned
    // CONDUCTOR_CMD is bogus, so the run then fails — but crucially the guard did
    // NOT short-circuit: at least one transition was attempted.
    const { worker, transition } = makeWorker('dispatched');

    await worker.process({ data: baseJob });

    expect(transition).toHaveBeenCalled();
    expect(transition.mock.calls[0]?.[1]).toBe('provisioning');
  });
});
