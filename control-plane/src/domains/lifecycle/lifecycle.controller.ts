import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../../core/guards/session.guard.js';
import { CurrentUser } from '../../core/guards/current-user.decorator.js';
import type { AuthenticatedUser } from '../../core/guards/session.guard.js';
import { EnforceQuota } from '../../core/quota/enforce-quota.decorator.js';
import { LifecycleService } from './lifecycle.service.js';
import { EngagementWorker } from './worker/engagement.worker.js';

export interface CreateEngagementDto {
  repoId: number;
  repoFullName: string;
}

// POST /engagements, GET /engagements, POST /engagements/:id/abort
// (docs/control-plane.md §4). Dashboard controls go over ordinary REST, not SSE.
// All routes are session-protected; ownership is enforced inside the service.
@Controller('engagements')
export class LifecycleController {
  constructor(
    @Inject(LifecycleService) private readonly lifecycle: LifecycleService,
    @Inject(EngagementWorker) private readonly worker: EngagementWorker,
  ) {}

  @Post()
  @UseGuards(SessionGuard)
  @EnforceQuota()
  create(@CurrentUser() auth: AuthenticatedUser, @Body() body: CreateEngagementDto) {
    return this.lifecycle.dispatch({
      userId: auth.id,
      repoId: body.repoId,
      repoFullName: body.repoFullName,
    });
  }

  @Get()
  @UseGuards(SessionGuard)
  list(@CurrentUser() auth: AuthenticatedUser) {
    return this.lifecycle.list(auth.id);
  }

  @Post(':id/abort')
  @UseGuards(SessionGuard)
  async abort(
    @CurrentUser() auth: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    // Ownership check, then signal the worker to halt. The row reaches a terminal
    // state via the worker's process outcome (the worker drives terminal flips).
    await this.lifecycle.assertOwned(id, auth.id);
    this.worker.abort(id);
    return { ok: true };
  }
}
