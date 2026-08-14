import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { LifecycleService } from './lifecycle.service.js';

// POST /engagements, GET /engagements, POST /engagements/:id/abort
// (docs/control-plane.md §4). Dashboard controls go over ordinary REST, not SSE.
@Controller('engagements')
export class LifecycleController {
  constructor(private readonly lifecycle: LifecycleService) {}

  @Post()
  create(@Body() _body: unknown): void {
    // TODO(P3): validate ownership + deployable, enforce quota, write row `queued`,
    // mint per-engagement ingest token, decrypt GitHub token, enqueue on BullMQ.
  }

  @Get()
  list(): void {
    // TODO(P3): list the caller's engagements.
  }

  @Post(':id/abort')
  abort(@Param('id') _id: string): void {
    // TODO(P3): signal the worker to halt a running engagement.
  }
}
