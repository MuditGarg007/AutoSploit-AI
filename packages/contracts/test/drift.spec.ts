import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { generateContractTypes, generateEventSchema } from '../scripts/generate.mjs';

// The §8.1 border: the control plane's event types are GENERATED from the frozen
// harness schema, never hand-mirrored. This spec re-runs the generator against
// harness/contracts/contract.schema.json and fails if the committed src/index.ts
// has drifted — run `bun run generate` to refresh (harness.md §9 step 5, mirror
// of the Python side's tests/test_contracts.py drift gate).
describe('contract types drift', () => {
  it('src/index.ts matches a fresh generation from the harness schema', async () => {
    const schemaPath = new URL('../../../harness/contracts/contract.schema.json', import.meta.url);
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
    const fresh = `${generateContractTypes(schema)}\n`;

    const committedPath = new URL('../src/index.ts', import.meta.url);
    const committed = await readFile(committedPath, 'utf8');

    expect(committed, 'Drift in generated contract types — run `bun run generate`').toBe(fresh);
  });

  it('src/event-schema.ts matches a fresh generation from the harness schema', async () => {
    const schemaPath = new URL('../../../harness/contracts/contract.schema.json', import.meta.url);
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
    const fresh = `${generateEventSchema(schema)}\n`;

    const committedPath = new URL('../src/event-schema.ts', import.meta.url);
    const committed = await readFile(committedPath, 'utf8');

    expect(committed, 'Drift in generated event JSON Schema — run `bun run generate`').toBe(fresh);
  });
});
