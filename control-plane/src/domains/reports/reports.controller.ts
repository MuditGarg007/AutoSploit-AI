import { Controller, Get, Param } from '@nestjs/common';
import { ReportsService } from './reports.service.js';

// GET /engagements/:id/report — serves the viewer + downloads (docs/control-plane.md §4.E).
@Controller('engagements/:id/report')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  get(@Param('id') _id: string): void {
    // TODO(P5): authorize ownership, return assembled report + presigned artifact URLs.
  }
}
