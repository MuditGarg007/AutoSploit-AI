import { Injectable } from '@nestjs/common';

// Lifecycle's execution arm (NOT a separate service, docs/control-plane.md §5 rule 2).
// Dequeues from BullMQ and runs the engagement, driving every state flip from the
// process / Job outcome:
//   Phase A: shells `conductor run <repo> --engagement-id <id>` (subprocess).
//   Phase B: creates a k8s Job.
// The ingest endpoint the sandbox pushes to is identical across both phases (§6).
@Injectable()
export class EngagementWorker {
  // TODO(P3): consume queue, spawn conductor, relay stdout -> D ingest, map exit
  // code / RunResult -> terminal state via LifecycleService.transition().
}
