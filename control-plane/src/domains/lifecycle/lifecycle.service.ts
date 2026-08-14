import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE, type Db } from '../../db/drizzle.module.js';
import { IdentityService } from '../identity/identity.service.js';
import { VaultService } from '../identity/vault/vault.service.js';
import { EngagementStateMachine } from './state-machine/state-machine.js';

// Dispatch half of C. Sole writer of engagements. Every state flip goes through
// the state machine; no other slice touches the table (docs/control-plane.md §5).
@Injectable()
export class LifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly identity: IdentityService,
    private readonly vault: VaultService,
    private readonly sm: EngagementStateMachine,
  ) {}

  // TODO(P3): dispatch(userId, repo) -> validate, quota, write queued, mint ingest
  // token, decrypt GitHub token, enqueue. abort(id). transition(id, event).
}
