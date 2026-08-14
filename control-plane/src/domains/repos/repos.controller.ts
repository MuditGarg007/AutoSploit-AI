import { Controller, Get, Param } from '@nestjs/common';
import { ReposService } from './repos.service.js';

// GET /repos, GET /repos/:id/deployable  (feeds the picker — §2.1 ladder gate).
@Controller('repos')
export class ReposController {
  constructor(private readonly repos: ReposService) {}

  @Get()
  list(): void {
    // TODO(P2): list the user's repos via GitHub API (token from A).
  }

  @Get(':id/deployable')
  deployable(@Param('id') _id: string): void {
    // TODO(P2): probe for docker-compose.yml / Dockerfile -> boolean.
  }
}
