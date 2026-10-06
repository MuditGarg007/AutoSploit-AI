import { Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { Worker } from 'bullmq';
import { EnvService } from '../../config/env.service.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ReposModule } from '../repos/repos.module.js';
import { LifecycleController } from './lifecycle.controller.js';
import { LifecycleService } from './lifecycle.service.js';
import { IngestTokenService } from './ingest-token.service.js';
import { EngagementStateMachine } from './state-machine/state-machine.js';
import { EngagementWorker } from './worker/engagement.worker.js';
import { IngestRelay } from './worker/ingest-relay.js';
import { engagementQueueProvider } from './queue/engagement-queue.js';

// Owns the BullMQ Worker lifecycle: created once per app, closed on shutdown
// (mirrors DrizzlePoolShutdown in db/drizzle.module.ts).
@Injectable()
export class EngagementWorkerLifecycle implements OnApplicationShutdown {
  // `Worker | null` is a union, so emitDecoratorMetadata reflects `Object` and
  // Nest cannot resolve the token by type; inject the Worker provider explicitly.
  constructor(@Inject(Worker) private readonly worker: Worker | null) {}

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}

// C · Lifecycle — the core write path. Collapses dispatcher + queue + worker +
// engagement-store into one slice because they all mutate ONE thing: engagement
// state (docs/control-plane.md §4.C). Imports A to decrypt the GitHub token at
// dispatch and B for the deployable gate. The worker is Lifecycle's execution
// arm, not a separate service (§5 rule 2).
@Module({
  imports: [IdentityModule, ReposModule],
  controllers: [LifecycleController],
  providers: [
    LifecycleService,
    EngagementStateMachine,
    EngagementWorker,
    IngestTokenService,
    IngestRelay,
    engagementQueueProvider,
    {
      provide: Worker,
      inject: [EnvService, EngagementWorker],
      useFactory: (env: EnvService, worker: EngagementWorker) =>
        new Worker(
          'engagements',
          (job) => worker.process(job),
          { connection: { url: env.redisUrl }, concurrency: 1 },
        ),
    },
    EngagementWorkerLifecycle,
  ],
  exports: [LifecycleService, IngestTokenService],
})
export class LifecycleModule {}
