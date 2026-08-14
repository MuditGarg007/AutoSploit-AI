// Aggregate barrel — every domain-owned schema re-exported so drizzle-kit and the
// Drizzle client see all tables. Ownership stays with the domain that defines the
// file (docs/control-plane.md §4 table map); this file imports, never defines.
export * from '../../domains/identity/identity.schema.js';
export * from '../../domains/repos/repos.schema.js';
export * from '../../domains/lifecycle/lifecycle.schema.js';
export * from '../../domains/telemetry/telemetry.schema.js';
export * from '../../domains/reports/reports.schema.js';
