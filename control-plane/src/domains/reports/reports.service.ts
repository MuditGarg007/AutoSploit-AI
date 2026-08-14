import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE, type Db } from '../../db/drizzle.module.js';

// Assembles from findings (read-only over D) + object-store artifacts. Sole writer
// of reports. Presigned download URLs via the S3 SDK (docs/control-plane.md §4.E, §9.1).
@Injectable()
export class ReportsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  // TODO(P5): assemble(engagementId) on C's terminal transition; presignedUrl(key).
}
