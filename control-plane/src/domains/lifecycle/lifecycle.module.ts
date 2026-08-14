import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { LifecycleController } from './lifecycle.controller.js';
import { LifecycleService } from './lifecycle.service.js';
import { EngagementStateMachine } from './state-machine/state-machine.js';
import { EngagementWorker } from './worker/engagement.worker.js';

// C · Lifecycle — the core write path. Collapses dispatcher + queue + worker +
// engagement-store into one slice because they all mutate ONE thing: engagement
// state (docs/control-plane.md §4.C). Imports A to decrypt the GitHub token at
// dispatch. The worker is Lifecycle's execution arm, not a separate service (§5 rule 2).
@Module({
  imports: [IdentityModule],
  controllers: [LifecycleController],
  providers: [LifecycleService, EngagementStateMachine, EngagementWorker],
  exports: [LifecycleService],
})
export class LifecycleModule {}
