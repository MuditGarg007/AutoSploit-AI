import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import { EnvService } from '../../config/env.service.js';

export interface AuthenticatedUser {
  id: string;
  sessionId: string;
}

// Stateless session guard: validates the Bearer JWT access token issued by
// Identity (A) and attaches the authenticated user to the request. Reads nothing
// from the sessions table — the DB write path belongs to A alone (§4.A, §5).
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(EnvService) private readonly env: EnvService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const header = req.headers.authorization;
    // Prefer the Authorization header. Fall back to an `access_token` query
    // param for the SSE stream only: EventSource cannot set request headers, so
    // the live-stream route carries the access token in the URL instead. The
    // fallback is scoped to the stream route so the token is never accepted in
    // the URL on ordinary routes, where it would leak into access logs, proxy
    // logs, and the Referer header.
    let token: string | undefined;
    if (header?.startsWith('Bearer ')) {
      token = header.slice('Bearer '.length);
    } else if (this.isStreamRoute(req)) {
      const q = (req.query as { access_token?: unknown } | undefined)
        ?.access_token;
      if (typeof q === 'string' && q.length > 0) token = q;
    }
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }
    try {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(this.env.jwtAccessSecret),
        { algorithms: ['HS256'] },
      );
      if (payload.type !== 'access' || !payload.sub || !payload.sid) {
        throw new Error('Unexpected token type');
      }
      (req as FastifyRequest & { user: AuthenticatedUser }).user = {
        id: payload.sub,
        sessionId: payload.sid as string,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  // The access-token-in-query fallback is allowed only on the SSE stream route
  // (GET /engagements/:id/stream). Match on the request path (query string
  // stripped) so the engagement id — which never contains a slash — cannot
  // widen the match.
  private isStreamRoute(req: FastifyRequest): boolean {
    const pathname = (req.url ?? '').split('?', 1)[0];
    return pathname.endsWith('/stream');
  }
}
