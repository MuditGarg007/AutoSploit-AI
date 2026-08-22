import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { IngestTokenService } from '../../lifecycle/ingest-token.service.js';

// Reusable guard for the ingest endpoint (docs/control-plane.md §8.1: "C mints,
// D validates"). Reads Authorization: Bearer, verifies the per-engagement ingest
// token signature via IngestTokenService (shared signing key with C, zero runtime
// call, fail-closed), and checks the token's `sub` equals the route :id.
//   - missing/invalid/expired signature → 401
//   - valid signature but wrong :id scope → 403
// Fail-closed on a missing header (no anonymous ingest).
@Injectable()
export class IngestTokenGuard implements CanActivate {
  constructor(@Inject(IngestTokenService) private readonly ingestTokens: IngestTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length);
    const { id } = req.params as { id: string };
    let payload;
    try {
      payload = await this.ingestTokens.verify(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired ingest token');
    }
    if (payload.sub !== id) {
      throw new ForbiddenException('Ingest token not scoped to this engagement');
    }
    return true;
  }
}
