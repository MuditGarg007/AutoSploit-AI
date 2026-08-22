import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { eventSchema } from '@autosploit/contracts';
import { EnvService } from '../../../config/env.service.js';

// Idempotent registration of the frozen event contract as a versioned subject in
// Redpanda's Schema Registry (docs/control-plane.md §8.1). Registration is one
// REST call: GET /subjects/<topic>-value/versions; if the subject is absent (or
// the latest version's schema differs) POST the current schema. This makes the
// registry the versioned source of truth — but it is NOT the enforcement gate:
// broker-side JSON produce validation is immature on Redpanda, so the ajv check
// in EventSchemaService is the gate (plan decision 2). Runs at bootstrap when
// configured; log-only on failure so a registry outage never blocks ingest.
@Injectable()
export class SchemaRegistryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchemaRegistryService.name);

  constructor(@Inject(EnvService) private readonly env: EnvService) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.schemaRegistryUrl) return;
    try {
      const subject = `${this.env.kafkaTopic}-value`;
      const current = await this.latest(subject);
      const fresh = JSON.stringify(eventSchema);
      if (current && this.normalize(current.schema) === this.normalize(fresh)) {
        this.logger.log(`Schema Registry subject ${subject} already current`);
        return;
      }
      const res = await fetch(
        `${this.env.schemaRegistryUrl}/subjects/${subject}/versions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/vnd.schemaregistry.v1+json' },
          body: JSON.stringify({ schemaType: 'JSON', schema: fresh }),
        },
      );
      if (!res.ok) {
        this.logger.warn(
          `Schema Registry register ${subject} failed: HTTP ${res.status} ${await res.text()}`,
        );
        return;
      }
      const registered = (await res.json()) as { id: number };
      this.logger.log(
        `Schema Registry registered ${subject} v${registered.id}`,
      );
    } catch (err) {
      // Registry is versioning, not the enforcement gate — never take ingest down.
      this.logger.warn(
        `Schema Registry registration skipped: ${(err as Error).message}`,
      );
    }
  }

  private async latest(subject: string): Promise<{ schema: string } | null> {
    const res = await fetch(
      `${this.env.schemaRegistryUrl}/subjects/${subject}/versions/latest`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`latest versions HTTP ${res.status}`);
    return (await res.json()) as { schema: string };
  }

  private normalize(schema: string): string {
    try {
      return JSON.stringify(JSON.parse(schema));
    } catch {
      return schema;
    }
  }
}
