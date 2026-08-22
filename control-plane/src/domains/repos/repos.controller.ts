import {
  Controller,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../../core/guards/session.guard.js';
import { CurrentUser } from '../../core/guards/current-user.decorator.js';
import type { AuthenticatedUser } from '../../core/guards/session.guard.js';
import { ReposService } from './repos.service.js';

// GET /repos, GET /repos/:id/deployable (feeds the picker — §2.1 ladder gate).
// Both routes are session-protected, same as GET /me; the user's identity comes
// from the access JWT, and the GitHub token is resolved from A inside the service.
@Controller('repos')
export class ReposController {
  constructor(@Inject(ReposService) private readonly repos: ReposService) {}

  @Get()
  @UseGuards(SessionGuard)
  list(@CurrentUser() auth: AuthenticatedUser) {
    return this.repos.listRepos(auth.id);
  }

  @Get(':id/deployable')
  @UseGuards(SessionGuard)
  deployable(
    @CurrentUser() auth: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.repos.probeDeployable(auth.id, id);
  }
}
