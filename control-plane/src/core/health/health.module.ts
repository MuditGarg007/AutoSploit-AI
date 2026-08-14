import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

// P0 exit gate: GET /health returns liveness + DB connectivity
// (docs/control-plane.md §12, Component 0).
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
