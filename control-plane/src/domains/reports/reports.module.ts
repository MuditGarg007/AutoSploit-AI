import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

// E · Reports — assembles the final report from findings + object-store artifacts.
// Read-only over D; triggered by C reaching a terminal state (docs/control-plane.md §4.E).
@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
