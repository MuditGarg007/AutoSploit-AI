#!/usr/bin/env node
// Generator for the control-plane event contract types (§8.1 border).
// Reads harness/contracts/contract.schema.json (the frozen seam, harness.md §9
// step 5) and emits src/index.ts. Do NOT hand-edit the generated file — run
// `bun run generate` instead. test/drift.spec.ts fails on any drift, so a seam
// only moves when the Python side regenerates the schema on purpose.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve a schema type hint like "array<string>" or "string|null" to a TS type. */
function toTsType(hint, indent) {
  let t = hint.trim();
  let nullable = false;
  if (t.endsWith('|null')) {
    nullable = true;
    t = t.slice(0, -'|null'.length).trim();
  }
  let base;
  if (t === 'string') base = 'string';
  else if (t === 'integer' || t === 'number') base = 'number';
  else if (t === 'boolean') base = 'boolean';
  else if (t === 'object') base = 'Record<string, unknown>';
  else if (t.startsWith('array<')) {
    const inner = t.slice('array<'.length, -1);
    base = `${toTsType(inner, indent)}[]`;
  } else if (t === 'null') base = 'null';
  // Fallback: treat as an unknown-shaped blob (e.g. "Path", "tuple[Report, dict]").
  else base = 'unknown';
  return nullable ? `${base} | null` : base;
}

/**
 * Resolve a schema type hint to its JSON Schema type keyword (draft 2020-12).
 * "integer" maps to the integer keyword so ajv distinguishes it from "number";
 * every other primitive maps directly; array<string> narrows the item type.
 */
function toJsonSchemaType(hint) {
  let t = hint.trim();
  let nullable = false;
  if (t.endsWith('|null')) {
    nullable = true;
    t = t.slice(0, -'|null'.length).trim();
  }
  let type;
  if (t === 'string') type = 'string';
  else if (t === 'integer') type = 'integer';
  else if (t === 'number') type = 'number';
  else if (t === 'boolean') type = 'boolean';
  else if (t === 'null') type = 'null';
  else if (t === 'object') type = 'object';
  else if (t.startsWith('array<')) {
    const inner = t.slice('array<'.length, -1);
    return {
      type: 'array',
      items: inner === 'integer' ? { type: 'integer' } : { type: 'string' },
    };
  }
  // Fallback (unknown-shaped blob): no type constraint.
  else return {};
  return nullable ? { type: [type, 'null'] } : { type };
}

function payloadInterface(name, payload, indent) {
  const pad = ' '.repeat(indent);
  const fields = Object.entries(payload.fields ?? {});
  if (fields.length === 0) {
    return `${pad}export interface ${name} {}\n`;
  }
  const required = new Set(payload.required ?? []);
  const lines = fields.map(([key, hint]) => {
    const q = required.has(key) ? '' : '?';
    return `${pad}  ${key}${q}: ${toTsType(hint, indent + 2)};`;
  });
  return `${pad}export interface ${name} {\n${lines.join('\n')}\n${pad}}\n`;
}

/**
 * Generate the TypeScript module text for a contract schema JSON object.
 * Exported so the drift spec can regenerate and diff without touching disk.
 */
export function generateContractTypes(schema) {
  const out = [];

  out.push(`// Generated from harness/contracts/contract.schema.json — do not hand-edit.`);
  out.push(`// Regenerate via \`bun run generate\` (or \`bun run generate\` in packages/contracts).`);
  out.push(`// Source of truth: harness/src/autosploit_harness/contracts/ (harness.md §9 step 5).`);
  out.push('');
  out.push(`export const CONTRACT_VERSION = '${schema.contract_version}';`);
  out.push('');
  out.push(`export { eventSchema } from './event-schema.js';`);
  out.push('');

  const envelope = schema.events.envelope;
  const typeList = envelope.type;
  out.push(`export const EVENT_TYPES = [${typeList.map((t) => `'${t}'`).join(', ')}] as const;`);
  out.push(`export type EventType = (typeof EVENT_TYPES)[number];`);
  out.push('');

  // Per-type payloads.
  const payloads = schema.events.payloads;
  const payloadNames = Object.keys(payloads);
  const payloadMap = new Map(
    payloadNames.map((name) => [name, payloadInterface(name, payloads[name], 0)]),
  );
  for (const [name, text] of payloadMap) {
    out.push(text);
    out.push('');
  }

  // Discriminated union over the envelope + payloads.
  out.push(`export interface EventEnvelope {`);
  out.push(`  ts: string;`);
  out.push(`  type: EventType;`);
  out.push(`  data: object;`);
  out.push(`}`);
  out.push('');
  out.push(`export type HarnessEvent =`);
  for (const name of payloadNames) {
    out.push(`  | (Omit<EventEnvelope, 'type' | 'data'> & { type: '${name}'; data: ${name} })`);
  }
  out.push(';');
  out.push('');

  // Report shape.
  const report = schema.report;
  if (report && typeof report === 'object') {
    out.push(`export interface Report {`);
    for (const [key, hint] of Object.entries(report)) {
      out.push(`  ${key}: ${toTsType(hint, 2)};`);
    }
    out.push(`}`);
    out.push('');
  }

  return out.join('\n');
}

/**
 * Generate the JSON Schema module text (draft 2020-12) for a contract schema
 * JSON object. The Schema Registry subject and the ingest ajv validator both
 * derive from this single generated artifact, keeping the "generated, never
 * hand-mirrored" invariant (docs/control-plane.md §8.1).
 *
 * Shape: a required envelope ({ts, type, data}) plus one `allOf` branch per
 * event type — `if type === X then data requires the per-type required keys`.
 * `halt` gets no required data keys, matching events.py `__required_keys__`.
 */
export function generateEventSchema(schema) {
  const out = [];

  out.push(`// Generated from harness/contracts/contract.schema.json — do not hand-edit.`);
  out.push(`// Regenerate via \`bun run generate\` (or \`bun run generate\` in packages/contracts).`);
  out.push(`// Draft 2020-12 JSON Schema; the ingest ajv validator and the Schema Registry`);
  out.push(`// subject both derive from this artifact (docs/control-plane.md §8.1).`);
  out.push('');

  const payloads = schema.events.payloads;
  const typeList = schema.events.envelope.type;

  const branches = typeList.map((name) => {
    const payload = payloads[name] ?? {};
    const fields = payload.fields ?? {};
    const required = payload.required ?? [];
    const props = {};
    for (const [key, hint] of Object.entries(fields)) {
      props[key] = toJsonSchemaType(hint);
    }
    const dataSchema = { type: 'object', properties: props };
    if (required.length > 0) dataSchema.required = required;
    return {
      if: { properties: { type: { const: name } }, required: ['type'] },
      then: {
        properties: { data: dataSchema },
        required: ['data'],
      },
    };
  });

  const eventSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://autosploit.dev/schemas/events.json',
    title: 'autosploit harness event',
    type: 'object',
    properties: {
      ts: { type: 'string', format: 'date-time' },
      type: { enum: typeList },
      data: { type: 'object' },
    },
    required: ['ts', 'type', 'data'],
    additionalProperties: false,
    allOf: branches,
  };

  out.push(`export const eventSchema = ${JSON.stringify(eventSchema, null, 2)} as const;`);
  out.push('');

  return out.join('\n');
}

async function main() {
  const schemaPath = path.resolve(
    __dirname,
    '../../../harness/contracts/contract.schema.json',
  );
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const code = generateContractTypes(schema);
  const dest = path.resolve(__dirname, '../src/index.ts');
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, `${code}\n`, 'utf8');
  console.log(`Wrote ${path.relative(process.cwd(), dest)}`);

  const eventSchemaCode = generateEventSchema(schema);
  const eventSchemaDest = path.resolve(__dirname, '../src/event-schema.ts');
  await writeFile(eventSchemaDest, `${eventSchemaCode}\n`, 'utf8');
  console.log(`Wrote ${path.relative(process.cwd(), eventSchemaDest)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
