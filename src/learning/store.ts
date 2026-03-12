import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getPatternSummary, renderPatternEvidence, renderPatternHeading } from "./analyzer";
import type { LearningArtifact, LearnedPattern } from "./types";

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function loadLearningArtifact(filePath: string): LearningArtifact {
  return readJson<LearningArtifact>(filePath, {
    updatedAt: new Date(0).toISOString(),
    patterns: [],
  });
}

export function saveLearningArtifact(filePath: string, patterns: LearnedPattern[]): void {
  writeJson(filePath, {
    updatedAt: new Date().toISOString(),
    patterns,
  });
}

export function saveLearningMarkdown(filePath: string, patterns: LearnedPattern[]): void {
  ensureDir(dirname(filePath));

  const grouped = new Map<string, LearnedPattern[]>();
  for (const pattern of patterns) {
    const bucket = grouped.get(pattern.kind) ?? [];
    bucket.push(pattern);
    grouped.set(pattern.kind, bucket);
  }

  const sections = [...grouped.entries()].map(([kind, items]) => {
    const title = renderPatternHeading(kind as LearnedPattern["kind"]);
    const body = items
      .sort((a, b) => b.confidence - a.confidence || b.lastSeen.localeCompare(a.lastSeen))
      .map((item) => {
        const evidence = item.evidence
          .slice(0, 3)
          .map((entry) => renderPatternEvidence(entry))
          .filter(Boolean)
          .map((entry) => `  - ${entry}`)
          .join("\n");
        return `- [${item.confidence.toFixed(2)}] ${getPatternSummary(item)}\n  - occurrences: ${item.occurrences}${evidence ? `\n${evidence}` : ""}`;
      })
      .join("\n");
    return `## ${title}\n${body}`;
  });

  const content = [
    "# Learned Project Patterns",
    "",
    `Updated: ${new Date().toISOString()}`,
    "",
    ...sections,
    "",
  ].join("\n");

  writeFileSync(filePath, content, "utf8");
}
