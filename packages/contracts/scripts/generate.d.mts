// Types for scripts/generate.mjs so test/drift.spec.ts can import the generator
// in a typechecked workspace. The script itself is plain JS (no build step).
export interface HarnessContractSchema {
  contract_version: string;
  events: {
    envelope: { ts: string; type: string[]; data: string };
    payloads: Record<
      string,
      { fields: Record<string, string>; required?: string[] }
    >;
  };
  report: Record<string, string>;
}

export function generateContractTypes(schema: HarnessContractSchema): string;
