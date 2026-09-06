import { Module } from '@nestjs/common';
import { LifecycleModule } from '../lifecycle/lifecycle.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { objectStoreProvider } from './object-store.js';

// E · Reports — assembles the final report from findings + object-store artifacts.
// Read-only over D; authorizes ownership + the terminal-state gate through C
// (LifecycleModule, exported LifecycleService — the same seam D's SSE uses).
// Imports C, never the reverse: E stays strictly downstream (docs/control-plane.md
// §4.E, §8 seam 3).
@Module({
  imports: [LifecycleModule],
  controllers: [ReportsController],
  providers: [ReportsService, objectStoreProvider],
  exports: [ReportsService],
})
export class ReportsModule {}
