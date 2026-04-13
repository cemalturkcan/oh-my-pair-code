import { existsSync, readFileSync } from "node:fs";
import { BlockingHookError } from "./sdk";
import { resolveToolArgs, resolveToolName } from "./runtime";

type ToolInput = {
  tool: string;
  sessionID: string;
  callID: string;
  args: Record<string, unknown>;
};

type ToolOutput = {
  title: string;
  output: string;
  metadata: unknown;
};

export const SUSPICIOUS_COMMENT_PATTERNS: RegExp[] = [
  /^\s*(\/\/|#|\/\*+|\*)\s*(this|these)\s+(function|method|code|logic|component|block|class|section)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*(here|now)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*(simply|basically|just|obviously)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*we\s+(now|use|need|do|first|then|return)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*note\s+(that|:)/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*ensure\s+that\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*the\s+following\s+(code|function|section|block|method|class)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*this\s+(handles|processes|manages|implements|creates|initializes|sets up)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*(first|next|finally|then),?\s+(we|let's)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*as\s+(mentioned|described|noted|shown|explained)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*let'?s\s+(create|define|implement|add|set up|initialize|build)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*we'?ll\s+(use|need|create|define|implement|add)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*below\s+(is|are)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*todo:?\s*(implement|add|fix|update|replace)\s*(this|here|later)?\.?\s*$/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*import\s+(necessary|required|needed)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*helper\s+(function|method)\s+(to|for|that)\b/i,
];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveEffectiveToolArgs(
  input: unknown,
  output?: unknown,
): Record<string, unknown> {
  const inputArgs = resolveToolArgs(input);
  const outputArgs = resolveToolArgs(output);
  if (Object.keys(outputArgs).length === 0) {
    return inputArgs;
  }

  return { ...inputArgs, ...outputArgs };
}

export function isSuspiciousCommentLine(line: string): boolean {
  return SUSPICIOUS_COMMENT_PATTERNS.some((pattern) => pattern.test(line));
}

export function findSuspiciousCommentHitsInText(
  text: string,
  label: string,
): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line, index) =>
      isSuspiciousCommentLine(line) ? [`${label}:${index + 1}: ${line.trim()}`] : [],
    );
}

export function findSuspiciousCommentHitsInPatch(patchText: string): string[] {
  const hits: string[] = [];
  let currentFile = "<patch>";
  let addedLine = 0;

  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith("*** Update File: ")) {
      currentFile = line.slice("*** Update File: ".length).trim();
      addedLine = 0;
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      currentFile = line.slice("*** Add File: ".length).trim();
      addedLine = 0;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLine += 1;
      const candidate = line.slice(1);
      if (isSuspiciousCommentLine(candidate)) {
        hits.push(`${currentFile}:patch+${addedLine}: ${candidate.trim()}`);
      }
    }
  }

  return hits;
}

function collectPaths(input: ToolInput, output: ToolOutput): string[] {
  const args = resolveEffectiveToolArgs(input, output);
  const directPath = args.filePath ?? args.path;
  if (typeof directPath === "string") {
    return [directPath];
  }

  if (
    resolveToolName(input) === "apply_patch" &&
    typeof output.metadata === "object" &&
    output.metadata !== null &&
    "files" in output.metadata
  ) {
    const files =
      (
        output.metadata as {
          files?: Array<{
            filePath?: string;
            movePath?: string;
            type?: string;
          }>;
        }
      ).files ?? [];
    return files
      .filter((file) => file.type !== "delete")
      .map((file) => file.movePath ?? file.filePath)
      .filter((filePath): filePath is string => typeof filePath === "string");
  }

  return [];
}

function inspectFile(filePath: string): string[] {
  if (!existsSync(filePath)) {
    return [];
  }

  return findSuspiciousCommentHitsInText(readFileSync(filePath, "utf8"), filePath);
}

function inspectEditPayload(args: Record<string, unknown>): string[] {
  const fileLabel =
    typeof args.filePath === "string"
      ? args.filePath
      : typeof args.path === "string"
        ? args.path
        : "<inline>";

  const hits: string[] = [];
  const directKeys = [
    "content",
    "text",
    "newString",
    "newText",
    "replacement",
    "replaceWith",
  ];
  for (const key of directKeys) {
    const value = args[key];
    if (typeof value === "string") {
      hits.push(...findSuspiciousCommentHitsInText(value, `${fileLabel}:${key}`));
    }
  }

  if (Array.isArray(args.edits)) {
    args.edits.forEach((edit, index) => {
      if (!isObject(edit)) return;
      for (const key of ["newString", "newText", "replacement", "replaceWith"]) {
        const value = edit[key];
        if (typeof value === "string") {
          hits.push(
            ...findSuspiciousCommentHitsInText(
              value,
              `${fileLabel}:edit${index + 1}:${key}`,
            ),
          );
        }
      }
    });
  }

  return hits;
}

function inspectToolInput(input: ToolInput, output?: unknown): string[] {
  const tool = resolveToolName(input);
  if (!tool || !["write", "edit", "multiedit", "apply_patch"].includes(tool)) {
    return [];
  }

  const args = resolveEffectiveToolArgs(input, output);

  if (tool === "apply_patch") {
    const patchText = args.patchText;
    return typeof patchText === "string"
      ? findSuspiciousCommentHitsInPatch(patchText)
      : [];
  }

  return inspectEditPayload(args);
}

function formatBlockMessage(hits: string[]): string {
  return [
    "[CommentGuard] Blocked suspicious AI-style comments before the file edit.",
    "Remove the comment text and retry.",
    ...hits,
  ].join("\n");
}

export function createCommentGuardHook() {
  return {
    "tool.execute.before": async (
      input: ToolInput,
      output?: unknown,
    ): Promise<void> => {
      const suspiciousComments = inspectToolInput(input, output);
      if (suspiciousComments.length === 0) {
        return;
      }

      throw new BlockingHookError(formatBlockMessage(suspiciousComments));
    },
    "tool.execute.after": async (
      input: ToolInput,
      output: ToolOutput,
    ): Promise<void> => {
      const tool = resolveToolName(input);
      if (!tool || !["write", "edit", "multiedit", "apply_patch"].includes(tool)) {
        return;
      }

      const filePaths = [...new Set(collectPaths(input, output))];
      if (filePaths.length === 0) {
        return;
      }

      const suspiciousComments = filePaths.flatMap(inspectFile);
      if (suspiciousComments.length === 0) {
        return;
      }

      output.output = `${output.output}\n\n[CommentGuard]\nSuspicious AI-style comments remain in modified files. Remove them before continuing.\n${suspiciousComments.join("\n")}`;
    },
  };
}
