import { existsSync, readFileSync } from "node:fs";

type ToolAfterInput = {
  tool: string;
  sessionID: string;
  callID: string;
  args: Record<string, unknown>;
};

type ToolAfterOutput = {
  title: string;
  output: string;
  metadata: unknown;
};

const SUSPICIOUS_COMMENT_PATTERNS: RegExp[] = [
  /^\s*(\/\/|#|\/\*+|\*)\s*(this|these)\s+(function|method|code|logic|component|block)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*(here|now)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*(simply|basically|just|obviously)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*we\s+(now|use|need|do|first|then)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*note\s+(that|:)/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*ensure\s+that\b/i,
];

function collectPaths(input: ToolAfterInput, output: ToolAfterOutput): string[] {
  const directPath = input.args.filePath;
  if (typeof directPath === "string") {
    return [directPath];
  }

  if (input.tool === "apply_patch" && typeof output.metadata === "object" && output.metadata !== null && "files" in output.metadata) {
    const files = (output.metadata as { files?: Array<{ filePath?: string; movePath?: string; type?: string }> }).files ?? [];
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

  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const hits: string[] = [];

  lines.forEach((line, index) => {
    if (SUSPICIOUS_COMMENT_PATTERNS.some((pattern) => pattern.test(line))) {
      hits.push(`${filePath}:${index + 1}: ${line.trim()}`);
    }
  });

  return hits;
}

export function createCommentGuardHook() {
  return {
    "tool.execute.after": async (input: ToolAfterInput, output: ToolAfterOutput): Promise<void> => {
      if (!["write", "edit", "multiedit", "apply_patch"].includes(input.tool)) {
        return;
      }

      const filePaths = collectPaths(input, output);
      if (filePaths.length === 0) {
        return;
      }

      const suspiciousComments = filePaths.flatMap(inspectFile);
      if (suspiciousComments.length === 0) {
        return;
      }

      output.output = `${output.output}\n\n[CommentGuard]\nPotentially AI-sloppy comments detected. Prefer concise, senior-level comments only when truly needed.\n${suspiciousComments.join("\n")}`;
    },
  };
}
