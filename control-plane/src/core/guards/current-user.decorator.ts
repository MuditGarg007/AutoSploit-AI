import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedUser } from './session.guard.js';

// Extracts the authenticated user that SessionGuard attached to the request.
// Safe only under @UseGuards(SessionGuard).
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const user = (req as FastifyRequest & { user?: AuthenticatedUser }).user;
    if (!user) {
      throw new UnauthorizedException('No authenticated user');
    }
    return user;
  },
);
