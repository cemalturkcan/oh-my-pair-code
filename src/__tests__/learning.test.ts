import { describe, it, expect } from "bun:test";
import {
  promoteLearnedPatterns,
  renderInjectedPatterns,
} from "../learning/analyzer";
import type { LearnedPattern } from "../learning/types";
import type { Observation, PersistedSessionSummary } from "../hooks/runtime";
import type { ProjectFacts } from "../project-facts";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const emptySummary: PersistedSessionSummary = {
  sessionID: "test-session",
  savedAt: "2026-01-01T00:00:00.000Z",
  packageManager: "unknown",
  languages: [],
  frameworks: [],
  changedFiles: [],
  incompleteTodos: [],
  lastUserMessage: "",
  lastAssistantMessage: "",
  approxTokens: 0,
};

// packageManager "unknown" + empty languages/frameworks prevents repo-convention
// candidates from being produced, keeping tests focused on observations only.
const emptyFacts: ProjectFacts = {
  packageManager: "unknown",
  languages: [],
  frameworks: [],
};

function makeObs(note: string): Observation {
  return { timestamp: "2026-01-01T00:00:00.000Z", phase: "post", note };
}

function makePattern(
  id: string,
  confidence: number,
  occurrences = 1,
): LearnedPattern {
  return {
    id,
    kind: "failure_pattern",
    confidence,
    occurrences,
    firstSeen: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-01-01T01:00:00.000Z",
    evidence: [],
    source: "automatic",
  };
}

function callPromote(
  observations: Observation[],
  existing: LearnedPattern[] = [],
  maxPatterns = 24,
) {
  return promoteLearnedPatterns({
    existing,
    summary: emptySummary,
    facts: emptyFacts,
    observations,
    maxPatterns,
  });
}

// ── promoteLearnedPatterns ────────────────────────────────────────────────────

describe("promoteLearnedPatterns", () => {
  it("produces no patterns when observations, summary, and facts are empty", () => {
    expect(callPromote([])).toEqual([]);
  });

  it("ignores unrecognized observation notes", () => {
    const result = callPromote([
      makeObs("unknown_event"),
      makeObs("some_other_note"),
    ]);
    expect(result).toHaveLength(0);
  });

  it("promotes console_log_found to failure:console-log-regression", () => {
    const result = callPromote([makeObs("console_log_found")]);
    const pattern = result.find((p) => p.id === "failure:console-log-regression");
    expect(pattern).toBeDefined();
  });

  it("promotes build_or_test_failure_detected to workflow:verify-after-build-failure", () => {
    const result = callPromote([makeObs("build_or_test_failure_detected")]);
    const pattern = result.find(
      (p) => p.id === "workflow:verify-after-build-failure",
    );
    expect(pattern).toBeDefined();
  });

  it("promotes prefer_pty_for_long_running_command to tooling pattern", () => {
    const result = callPromote([makeObs("prefer_pty_for_long_running_command")]);
    const pattern = result.find(
      (p) => p.id === "tooling:prefer-pty-for-long-running-commands",
    );
    expect(pattern).toBeDefined();
  });

  it("boosts confidence and increments occurrences on repeat observation", () => {
    const first = callPromote([makeObs("console_log_found")]);
    const firstPattern = first.find(
      (p) => p.id === "failure:console-log-regression",
    )!;
    expect(firstPattern.occurrences).toBe(1);

    const second = callPromote([makeObs("console_log_found")], first);
    const secondPattern = second.find(
      (p) => p.id === "failure:console-log-regression",
    )!;
    expect(secondPattern.occurrences).toBe(2);
    expect(secondPattern.confidence).toBeGreaterThan(firstPattern.confidence);
  });

  it("clamps confidence to a maximum of 0.95", () => {
    // Force a high existing confidence so the boost pushes it past the ceiling.
    const existing = [makePattern("failure:console-log-regression", 0.9, 10)];
    const result = callPromote([makeObs("console_log_found")], existing);
    const pattern = result.find((p) => p.id === "failure:console-log-regression")!;
    expect(pattern.confidence).toBeLessThanOrEqual(0.95);
    expect(pattern.confidence).toBe(0.95);
  });

  it("all produced patterns have confidence >= 0.35", () => {
    const result = callPromote([
      makeObs("console_log_found"),
      makeObs("build_or_test_failure_detected"),
      makeObs("prefer_pty_for_long_running_command"),
    ]);
    for (const p of result) {
      expect(p.confidence).toBeGreaterThanOrEqual(0.35);
    }
  });

  it("respects maxPatterns limit", () => {
    const existing: LearnedPattern[] = Array.from({ length: 5 }, (_, i) =>
      makePattern(`pattern-${i}`, 0.6 + i * 0.01),
    );
    const result = callPromote([], existing, 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("returns the highest-confidence patterns when trimming to maxPatterns", () => {
    const existing: LearnedPattern[] = [
      makePattern("low", 0.5),
      makePattern("high", 0.9),
      makePattern("mid", 0.7),
    ];
    const result = callPromote([], existing, 2);
    expect(result.map((p) => p.id)).toEqual(["high", "mid"]);
  });

  it("does not create duplicate patterns for the same id", () => {
    const result = callPromote([
      makeObs("console_log_found"),
      makeObs("console_log_found"),
    ]);
    const matches = result.filter((p) => p.id === "failure:console-log-regression");
    expect(matches.length).toBe(1);
  });
});

// ── renderInjectedPatterns ────────────────────────────────────────────────────

describe("renderInjectedPatterns", () => {
  it("returns an empty array for empty patterns", () => {
    expect(renderInjectedPatterns([], 5)).toEqual([]);
  });

  it("returns patterns sorted by confidence descending", () => {
    const patterns = [
      makePattern("low", 0.5),
      makePattern("high", 0.9),
      makePattern("mid", 0.7),
    ];
    const rendered = renderInjectedPatterns(patterns, 10);
    expect(rendered[0]).toContain("0.90");
    expect(rendered[1]).toContain("0.70");
    expect(rendered[2]).toContain("0.50");
  });

  it("respects the limit parameter", () => {
    const patterns = Array.from({ length: 10 }, (_, i) =>
      makePattern(`p-${i}`, 0.5 + i * 0.01),
    );
    const rendered = renderInjectedPatterns(patterns, 3);
    expect(rendered).toHaveLength(3);
  });

  it("renders confidence as two decimal places", () => {
    const patterns = [makePattern("test-id", 0.75)];
    const [line] = renderInjectedPatterns(patterns, 10);
    expect(line).toContain("0.75");
  });

  it("does not mutate the original array order", () => {
    const patterns = [
      makePattern("low", 0.5),
      makePattern("high", 0.9),
    ];
    renderInjectedPatterns(patterns, 10);
    expect(patterns[0].id).toBe("low");
    expect(patterns[1].id).toBe("high");
  });
});
