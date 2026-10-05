import {
  BadRequestException,
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
import type { Engagement } from './lifecycle.service.js';
import { EngagementWorker } from './worker/engagement.worker.js';

export interface CreateEngagementDto {
  // The repo is chosen from the user's own list (slice B, GET /repos), so the id
  // is the whole contract: the service resolves the authoritative fullName from it
  // via probeDeployable. A client-supplied fullName was dead (never read) and a
  // mismatch risk, so it is gone. Scope and caps are NOT per-engagement fields —
  // caps are per-user operator config enforced by the quota layer
  // (docs/component-q-quota.md §2), not client input.
  repoId: number;
}

// POST /engagements, GET /engagements, GET /engagements/:id,
// POST /engagements/:id/abort (docs/control-plane.md §4). Dashboard controls go
// over ordinary REST, not SSE.
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
    // No ValidationPipe in this app, so guard the one field by hand: a bad repoId
    // must be a 400, not a confusing downstream 404 from the repo probe.
    if (typeof body?.repoId !== 'number' || !Number.isInteger(body.repoId)) {
      throw new BadRequestException('repoId must be an integer');
    }
    return this.lifecycle.dispatch({
      userId: auth.id,
      repoId: body.repoId,
    });
  }

  @Get()
  @UseGuards(SessionGuard)
  list(@CurrentUser() auth: AuthenticatedUser) {
    return this.lifecycle.list(auth.id);
  }

  @Get(':id')
  @UseGuards(SessionGuard)
  get(
    @CurrentUser() auth: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<Engagement> {
    // Single engagement for the detail view / header label. assertOwned is the
    // ownership gate: 404 if the row does not exist OR belongs to another user
    // (ownership, not existence — §4.B). D's SSE + report routes already read
    // through the same gate.
    return this.lifecycle.assertOwned(id, auth.id);
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
