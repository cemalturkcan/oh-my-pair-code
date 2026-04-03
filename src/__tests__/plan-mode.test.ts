import { describe, it, expect } from "bun:test";

// Mirrors the detection logic in src/hooks/session-start.ts (chat.message handler).
// Kept as a pure function here so it can be exercised without instantiating the
// full HookRuntime or PluginInput context.
function detectModeFromText(text: string): "executing" | "planning" | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.includes("[harness:mode:executing]")) return "executing";
  if (trimmed.includes("[harness:mode:planning]")) return "planning";
  return null;
}

describe("detectModeFromText", () => {
  it("returns 'executing' for the executing marker", () => {
    expect(detectModeFromText("[harness:mode:executing]")).toBe("executing");
  });

  it("returns 'planning' for the planning marker", () => {
    expect(detectModeFromText("[harness:mode:planning]")).toBe("planning");
  });

  it("returns null for normal text without markers", () => {
    expect(detectModeFromText("hello world")).toBeNull();
    expect(detectModeFromText("please start executing the plan")).toBeNull();
    expect(detectModeFromText("let's plan this out")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(detectModeFromText("")).toBeNull();
  });

  it("is case-insensitive — uppercase marker triggers executing", () => {
    expect(detectModeFromText("[HARNESS:MODE:EXECUTING]")).toBe("executing");
  });

  it("is case-insensitive — uppercase marker triggers planning", () => {
    expect(detectModeFromText("[HARNESS:MODE:PLANNING]")).toBe("planning");
  });

  it("is case-insensitive — mixed-case marker triggers executing", () => {
    expect(detectModeFromText("[Harness:Mode:Executing]")).toBe("executing");
  });

  it("detects marker embedded within surrounding text", () => {
    expect(
      detectModeFromText("please /go [harness:mode:executing] to start"),
    ).toBe("executing");
    expect(
      detectModeFromText("switching back [harness:mode:planning] now"),
    ).toBe("planning");
  });

  it("strips leading/trailing whitespace before matching", () => {
    expect(detectModeFromText("  [harness:mode:executing]  ")).toBe("executing");
    expect(detectModeFromText("\t[harness:mode:planning]\n")).toBe("planning");
  });

  it("executing marker wins when both appear in the same text", () => {
    // Mirrors the if/else-if priority in session-start.ts
    const text =
      "[harness:mode:executing] earlier [harness:mode:planning] later";
    expect(detectModeFromText(text)).toBe("executing");
  });
});
