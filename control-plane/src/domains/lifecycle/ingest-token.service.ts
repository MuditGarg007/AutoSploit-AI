import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { EnvService } from '../../config/env.service.js';

export interface IngestTokenPayload {
  sub: string; // engagement id
  type: 'ingest';
  scope: 'events';
}

// Per-engagement ingest token minted by C at dispatch and validated by D at the
// ingest endpoint (§8.1: "C mints, D validates" — shared signing key, zero
// runtime call between them, fail-closed). The worker carries it in the queue
// job payload so the Phase-A relay (and later the Phase-B attacker pod) can POST
// events for exactly one engagement.
@Injectable()
export class IngestTokenService {
  // One engagement run is bounded by the conductor's wall-clock timeout; 6h is a
  // generous ceiling so a long job is never cut off mid-stream.
  private static readonly TTL_S = 6 * 60 * 60;

  constructor(@Inject(EnvService) private readonly env: EnvService) {}

  // Fail fast when a deployment actually uses the ingest path without the key —
  // the app may boot without it (pre-P3 slices), but minting must not silently
  // produce a garbage token.
  private key(): Uint8Array {
    if (!this.env.ingestTokenSigningKey) {
      throw new Error('INGEST_TOKEN_SIGNING_KEY is not set');
    }
    return new TextEncoder().encode(this.env.ingestTokenSigningKey);
  }

  async mint(engagementId: string): Promise<string> {
    return new SignJWT({ type: 'ingest', scope: 'events' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(engagementId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + IngestTokenService.TTL_S)
      .sign(this.key());
  }

  async verify(token: string): Promise<IngestTokenPayload> {
    const { payload } = await jwtVerify(token, this.key(), {
      algorithms: ['HS256'],
    });
    if (payload.type !== 'ingest' || payload.scope !== 'events' || !payload.sub) {
      throw new Error('Unexpected ingest token type');
    }
    return {
      sub: payload.sub,
      type: 'ingest',
      scope: 'events',
    };
  }
}
