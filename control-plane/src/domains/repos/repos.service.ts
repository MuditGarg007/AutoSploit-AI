import { Injectable } from '@nestjs/common';
import { IdentityService } from '../identity/identity.service.js';

// Read-through proxy. Uses A's token; writes only repo_cache. Deployable probe =
// presence of docker-compose.yml / Dockerfile (docs/control-plane.md §4.B).
@Injectable()
export class ReposService {
  constructor(private readonly identity: IdentityService) {}

  // TODO(P2): listRepos(userId), probeDeployable(userId, repoId).
}
