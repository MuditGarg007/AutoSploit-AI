import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/drizzle.module.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  // Liveness + real DB round-trip. The P0 gate is this returning 200 against a
  // real Postgres in CI (Testcontainers), not a mock.
  @Get()
  async check(): Promise<{ status: string; db: string }> {
    await this.db.execute(sql`SELECT 1`);
    return { status: 'ok', db: 'up' };
  }
}
