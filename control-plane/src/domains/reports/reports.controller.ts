import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../../core/guards/session.guard.js';
import { CurrentUser } from '../../core/guards/current-user.decorator.js';
import type { AuthenticatedUser } from '../../core/guards/session.guard.js';
import { ReportsService } from './reports.service.js';
import type { AssembledReport } from './reports.service.js';

// GET /engagements/:id/report — serves the viewer + downloads (docs/control-plane.md
// §4.E). Session-protected; ownership + the terminal-state gate are enforced in the
// service (a read of C's row for authorization only, as D's SSE does — §5 rule 3).
@Controller('engagements/:id/report')
export class ReportsController {
  constructor(
    @Inject(ReportsService) private readonly reports: ReportsService,
  ) {}

  @Get()
  @UseGuards(SessionGuard)
  get(
    @CurrentUser() auth: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<AssembledReport> {
    return this.reports.report(id, auth.id);
  }
}
