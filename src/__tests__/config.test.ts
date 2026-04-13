import { describe, it, expect } from "bun:test";
import { deepMerge, isObject } from "../utils";

describe("isObject", () => {
  it("returns true for plain objects", () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
  });

  it("returns false for null", () => {
    expect(isObject(null)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isObject([])).toBe(false);
    expect(isObject([1, 2, 3])).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isObject(42)).toBe(false);
    expect(isObject("string")).toBe(false);
    expect(isObject(true)).toBe(false);
    expect(isObject(undefined)).toBe(false);
  });
});

describe("deepMerge", () => {
  it("merges flat objects, override wins on conflicts", () => {
    const result = deepMerge({ a: 1, b: 2 } as Record<string, number>, {
      b: 20,
      c: 30,
    });
    expect(result).toEqual({ a: 1, b: 20, c: 30 });
  });

  it("preserves base keys absent from override", () => {
    const base = { a: 1, b: 2 };
    const result = deepMerge(base, { b: 99 });
    expect(result.a).toBe(1);
    expect(result.b).toBe(99);
  });

  it("merges nested objects recursively, preserving sibling keys", () => {
    const base = { a: { b: 1, c: 2 }, d: 3 };
    const override = { a: { b: 10 } };
    expect(deepMerge(base, override)).toEqual({ a: { b: 10, c: 2 }, d: 3 });
  });

  it("replaces arrays rather than merging them", () => {
    const base = { arr: [1, 2, 3] };
    const override = { arr: [4, 5] };
    expect(deepMerge(base, override)).toEqual({ arr: [4, 5] });
  });

  it("returns base unchanged when override is undefined", () => {
    const base = { a: 1, b: { c: 2 } };
    expect(deepMerge(base, undefined)).toEqual(base);
  });

  it("returns override for primitive base when override is a value", () => {
    expect(deepMerge(1, 2)).toBe(2);
    expect(deepMerge("old", "new")).toBe("new");
  });

  it("returns base for primitive base when override is undefined", () => {
    expect(deepMerge(42, undefined)).toBe(42);
  });

  it("handles three-level deep merge (defaults → user → project)", () => {
    const defaults = {
      hooks: { profile: "standard", comment_guard: true, session_start: true },
      workflow: { compact_subagent_context: true },
    };
    const userConfig = {
      hooks: { comment_guard: false },
      workflow: { compact_subagent_context: false },
    };
    const projectConfig = {
      hooks: { session_start: false },
    };

    const withUser = deepMerge(defaults, userConfig);
    const final = deepMerge(withUser, projectConfig);

    expect(final).toEqual({
      hooks: { profile: "standard", comment_guard: false, session_start: false },
      workflow: { compact_subagent_context: false },
    });
  });

  it("project config overrides user config which overrides defaults", () => {
    const merged = deepMerge(
      deepMerge({ mode: "coordinator", limit: 7 }, { limit: 14 }),
      { limit: 30 },
    );
    expect(merged).toEqual({ mode: "coordinator", limit: 30 });
  });

  it("skips prototype-polluting keys", () => {
    // JSON.parse creates enumerable __proto__ as own property
    const malicious = JSON.parse('{"__proto__":{"polluted":true},"a":2}');
    const result = deepMerge({ a: 1 } as Record<string, unknown>, malicious);
    expect(result.a).toBe(2);
    expect((result as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does not mutate the base object", () => {
    const base = { a: { b: 1 } };
    deepMerge(base, { a: { b: 99 } });
    expect(base.a.b).toBe(1);
  });

  it("handles empty override object without changing base", () => {
    const base = { x: 1, y: { z: 2 } };
    expect(deepMerge(base, {})).toEqual(base);
  });
});
