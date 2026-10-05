import { describe, expect, it } from "vitest";
import {
  cn,
  fmtCompact,
  fmtElapsed,
  fmtInt,
  fmtTime,
  fmtUsd,
} from "./format";

describe("fmtUsd", () => {
  it("renders two decimals", () => {
    expect(fmtUsd(0.4)).toBe("$0.40");
    expect(fmtUsd(1.185)).toBe("$1.19");
  });
  it("defaults undefined to $0.00", () => {
    expect(fmtUsd(undefined)).toBe("$0.00");
  });
});

describe("fmtInt", () => {
  it("groups thousands", () => {
    expect(fmtInt(48120)).toBe("48,120");
    expect(fmtInt(1324000)).toBe("1,324,000");
  });
  it("defaults undefined to 0", () => {
    expect(fmtInt(undefined)).toBe("0");
  });
});

describe("fmtCompact", () => {
  it("leaves sub-thousand values as-is", () => {
    expect(fmtCompact(0)).toBe("0");
    expect(fmtCompact(999)).toBe("999");
  });
  it("abbreviates thousands and millions", () => {
    expect(fmtCompact(48120)).toBe("48.1k");
    expect(fmtCompact(1324000)).toBe("1.32M");
  });
  it("defaults undefined to 0", () => {
    expect(fmtCompact(undefined)).toBe("0");
  });
});

describe("fmtTime", () => {
  it("renders 24h hh:mm:ss in UTC input", () => {
    // Value depends on the runner TZ; assert the shape, not the hour.
    expect(fmtTime("2026-09-30T12:34:56.000Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
  it("returns empty string on an invalid timestamp", () => {
    expect(fmtTime("not-a-date")).toBe("");
  });
});

describe("fmtElapsed", () => {
  it("renders m:ss under an hour", () => {
    expect(fmtElapsed("2026-09-30T12:00:00Z", "2026-09-30T12:03:07Z")).toBe(
      "3:07",
    );
  });
  it("renders h:mm:ss at or over an hour", () => {
    expect(fmtElapsed("2026-09-30T12:00:00Z", "2026-09-30T13:05:09Z")).toBe(
      "1:05:09",
    );
  });
  it("clamps negative or invalid spans to 0:00", () => {
    expect(fmtElapsed("2026-09-30T12:05:00Z", "2026-09-30T12:00:00Z")).toBe(
      "0:00",
    );
    expect(fmtElapsed("bad", "2026-09-30T12:00:00Z")).toBe("0:00");
  });
});

describe("cn", () => {
  it("joins truthy class names and drops falsy", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });
  it("returns an empty string when nothing is truthy", () => {
    expect(cn(false, null, undefined)).toBe("");
  });
});
