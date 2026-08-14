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
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = header.slice('Bearer '.length);
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
}
