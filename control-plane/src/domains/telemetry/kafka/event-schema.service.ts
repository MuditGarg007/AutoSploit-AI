import { Injectable } from '@nestjs/common';
import type { ValidateFunction } from 'ajv';
import Ajv2020Ns from 'ajv/dist/2020.js';
import formatsPlugin from 'ajv-formats';
import { eventSchema } from '@autosploit/contracts';

// ajv's draft-2020-12 entry (ajv/dist/2020) and ajv-formats are CJS; under
// NodeNext the default imports bind to the module namespace, so recover the
// actual callable/constructable values (the runtime shape is fine — the types
// are the problem).
const Ajv2020 = (Ajv2020Ns as unknown as { default: unknown }).default as new (
  opts?: Record<string, unknown>,
) => { compile: (s: unknown) => ValidateFunction };
const addFormats = formatsPlugin as unknown as (ajv: unknown) => void;

export interface EventValidation {
  ok: boolean;
  errors?: string[];
}

// Compiles the generated event JSON Schema (packages/contracts, draft 2020-12)
// once with ajv and validates every ingest envelope against it — the enforcement
// gate for the §8.1 border (plan decision 2: ajv is the gate, the registry is
// versioning). Uses the draft-2020-12 entry point so the `$schema` meta-schema
// resolves; `format: date-time` on `ts` needs ajv-formats. Fail-closed: any
// violation is a 422 at ingest, never a silent drop.
@Injectable()
export class EventSchemaService {
  private readonly validate: ValidateFunction;

  constructor() {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    this.validate = ajv.compile(eventSchema as Record<string, unknown>);
  }

  validateEvent(event: unknown): EventValidation {
    const ok = this.validate(event);
    if (ok) return { ok: true };
    return {
      ok: false,
      errors: (this.validate.errors ?? []).map(
        (e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
      ),
    };
  }
}
