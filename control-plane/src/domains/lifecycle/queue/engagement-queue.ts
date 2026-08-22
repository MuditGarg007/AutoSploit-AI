import { Queue } from 'bullmq';
import { EnvService } from '../../../config/env.service.js';

// BullMQ wiring for dispatch → worker. `bullmq` + `ioredis` are already in
// package.json but unused until P3; we wire the queue manually (no @nestjs/bullmq)
// so the token stays explicit. The BullMQ Worker itself is registered in
// LifecycleModule as a factory provider (it needs the EngagementWorker instance).
export interface EngagementJobData {
  engagementId: string;
  // Repo ref passed to `conductor run` — the GitHub repo full name (the
  // conductor accepts a repo ref; git URL/path also work).
  repoRef: string;
  // Decrypted at dispatch via A's boundary, passed to the conductor env as
  // GITHUB_TOKEN for the cloner. Lives only in the in-memory BullMQ job; never
  // persisted to Postgres or Redis, never logged.
  githubToken: string;
  ingestToken: string;
  timeoutS: number;
}

export const ENGAGEMENT_QUEUE = Symbol('ENGAGEMENT_QUEUE');

export const engagementQueueProvider = {
  provide: ENGAGEMENT_QUEUE,
  inject: [EnvService],
  useFactory: (env: EnvService): Queue<EngagementJobData> =>
    new Queue<EngagementJobData>('engagements', {
      connection: { url: env.redisUrl },
      defaultJobOptions: {
        attempts: 1, // one run per engagement; retries are a Lifecycle decision
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    }),
};
