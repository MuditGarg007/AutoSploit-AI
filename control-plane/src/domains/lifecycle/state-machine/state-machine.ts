import { Injectable } from '@nestjs/common';

// The authoritative lifecycle (docs/control-plane.md §7), maps 1:1 to the
// conductor's RunResult / ProvisionOutcome. Guards legal transitions so an
// out-of-order event cannot corrupt state. Sole caller = LifecycleService.
//
//   queued → dispatched → provisioning → deploying → attacking
//      → { completed | halted[budget|scope|timeout] | failed[provision|harness|internal] }
//      → tearing_down → archived
const LEGAL: Record<string, readonly string[]> = {
  queued: ['dispatched', 'failed'],
  dispatched: ['provisioning', 'failed'],
  provisioning: ['deploying', 'failed'],
  deploying: ['attacking', 'failed'],
  attacking: ['completed', 'halted', 'failed'],
  completed: ['tearing_down'],
  halted: ['tearing_down'],
  failed: ['tearing_down'],
  tearing_down: ['archived'],
  archived: [],
};

@Injectable()
export class EngagementStateMachine {
  canTransition(from: string, to: string): boolean {
    return LEGAL[from]?.includes(to) ?? false;
  }
}
