import { Inject, Injectable, Logger } from '@nestjs/common';
import { EnvService } from '../../../config/env.service.js';

// Phase-A relay: the worker forwards each parsed harness event to the ingest
// endpoint (POST /engagements/:id/events, slice D). The endpoint is identical
// across Phase A (worker relays) and Phase B (attacker pod POSTs directly) — §6.
// The relay is deliberately tolerant: ingest is a stub in P3, and an event drop
// must never backpressure the conductor subprocess. D-a hardens this (validation,
// retry, Kafka).
@Injectable()
export class IngestRelay {
  private readonly logger = new Logger(IngestRelay.name);

  constructor(@Inject(EnvService) private readonly env: EnvService) {}

  async relay(
    engagementId: string,
    event: unknown,
    ingestToken: string,
  ): Promise<void> {
    try {
      const res = await fetch(
        `${this.env.ingestRelayBaseUrl}/engagements/${engagementId}/events`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ingestToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(event),
        },
      );
      if (!res.ok) {
        this.logger.warn(
          `ingest relay ${engagementId}: HTTP ${res.status}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `ingest relay ${engagementId} failed: ${(err as Error).message}`,
      );
    }
  }
}
