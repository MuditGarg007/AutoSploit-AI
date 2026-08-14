import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { ReposController } from './repos.controller.js';
import { ReposService } from './repos.service.js';

// B · Repos — read-through proxy to the GitHub API. Depends on A for the token
// (imports IdentityModule); holds no authoritative state (docs/control-plane.md §4.B).
@Module({
  imports: [IdentityModule],
  controllers: [ReposController],
  providers: [ReposService],
  exports: [ReposService],
})
export class ReposModule {}
