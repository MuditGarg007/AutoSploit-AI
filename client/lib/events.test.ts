import { describe, expect, it } from "vitest";
import {
  emptyView,
  isTerminal,
  reduceEvent,
  severityRank,
  type EngagementEvent,
  type EngagementView,
} from "./events";

// Build an event with a monotonically derived id/ts so the reducer sees the
// shape the SSE gateway delivers.
let n = 0;
function ev<T extends EngagementEvent["type"]>(
  type: T,
  data: Extract<EngagementEvent, { type: T }>["data"],
): EngagementEvent {
  n += 1;
  return { type, id: `${n}-0`, ts: `2026-09-30T12:00:0${n}.000Z`, data } as EngagementEvent;
}

function fold(events: EngagementEvent[]): EngagementView {
  return events.reduce(reduceEvent, emptyView());
}

describe("reduceEvent", () => {
  it("tracks phases and the current stage, carrying host/ports forward", () => {
    const v = fold([
      ev("phase", { stage: "provisioning" }),
      ev("phase", { stage: "deploying", host: "10.0.0.1", ports: [80, 443] }),
      ev("phase", { stage: "attacking" }),
    ]);
    expect(v.phases).toHaveLength(3);
    expect(v.currentStage).toBe("attacking");
    expect(v.host).toBe("10.0.0.1");
    expect(v.ports).toEqual([80, 443]);
  });

  it("pairs a tool_result onto its matching pending call", () => {
    const v = fold([
      ev("tool_call", { id: "c1", name: "http_request" }),
      ev("tool_result", { id: "c1", name: "http_request", is_error: false }),
    ]);
    expect(v.tools).toHaveLength(1);
    expect(v.tools[0].result).toBeDefined();
    expect(v.tools[0].result?.is_error).toBe(false);
  });

  it("only resolves the first unresolved call sharing an id", () => {
    const v = fold([
      ev("tool_call", { id: "dup", name: "probe" }),
      ev("tool_call", { id: "dup", name: "probe" }),
      ev("tool_result", { id: "dup", name: "probe", is_error: false }),
    ]);
    expect(v.tools).toHaveLength(2);
    expect(v.tools[0].result).toBeDefined();
    expect(v.tools[1].result).toBeUndefined();
  });

  it("surfaces an orphan result as its own exchange", () => {
    const v = fold([
      ev("tool_result", { id: "ghost", name: "http_request", is_error: true }),
    ]);
    expect(v.tools).toHaveLength(1);
    expect(v.tools[0].key).toContain("orphan-");
    expect(v.tools[0].result?.is_error).toBe(true);
  });

  it("falls back to name when an orphan result has no name", () => {
    const v = fold([ev("tool_result", { id: null, is_error: false })]);
    expect(v.tools[0].name).toBe("unknown");
  });

  it("de-dupes findings by id across replay", () => {
    const v = fold([
      ev("finding", { id: "F-1", title: "a", severity: "high" }),
      ev("finding", { id: "F-1", title: "a", severity: "high" }),
      ev("finding", { id: "F-2", title: "b", severity: "low" }),
    ]);
    expect(v.findings).toHaveLength(2);
    expect(v.findings.map((f) => f.id)).toEqual(["F-1", "F-2"]);
  });

  it("keeps the latest cost snapshot", () => {
    const v = fold([
      ev("cost", { usd: 0.4, tokens: 100 }),
      ev("cost", { usd: 1.2, tokens: 300 }),
    ]);
    expect(v.cost?.usd).toBe(1.2);
    expect(v.cost?.tokens).toBe(300);
  });

  it("records refusal and halt with timestamps", () => {
    const v = fold([
      ev("refusal", { reason: "out of scope" }),
      ev("halt", { reason: "cap hit", cause: "usd" }),
    ]);
    expect(v.refusal?.reason).toBe("out of scope");
    expect(v.refusal?.ts).toBeDefined();
    expect(v.halt?.cause).toBe("usd");
    expect(v.halt?.ts).toBeDefined();
  });

  it("advances lastEventId and eventCount on every event", () => {
    const v = fold([
      ev("phase", { stage: "queued" }),
      ev("cost", { usd: 0.1 }),
    ]);
    expect(v.eventCount).toBe(2);
    expect(v.lastEventId).toBeDefined();
  });

  it("does not mutate the input view", () => {
    const base = emptyView();
    reduceEvent(base, ev("phase", { stage: "attacking" }));
    expect(base.phases).toHaveLength(0);
    expect(base.eventCount).toBe(0);
  });
});

describe("isTerminal", () => {
  it("is true for terminal lifecycle states", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("halted")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("archived")).toBe(true);
  });

  it("is false while the engagement is still running", () => {
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("attacking")).toBe(false);
    expect(isTerminal("tearing_down")).toBe(false);
  });
});

describe("severityRank", () => {
  it("orders known severities critical-first", () => {
    expect(severityRank("critical")).toBeLessThan(severityRank("high"));
    expect(severityRank("high")).toBeLessThan(severityRank("medium"));
    expect(severityRank("medium")).toBeLessThan(severityRank("low"));
    expect(severityRank("low")).toBeLessThan(severityRank("info"));
  });

  it("is case-insensitive", () => {
    expect(severityRank("CRITICAL")).toBe(severityRank("critical"));
  });

  it("sorts unknown severities last", () => {
    expect(severityRank("bogus")).toBe(99);
  });
});
