import { createHash } from "node:crypto";
import { WebAgentError } from "../../core/errors.js";

const SECRET_KEY_RE = /(password|passcode|token|secret|authorization|api[_-]?key|otp|code)/i;
const SECRET_ASSIGNMENT_RE = /(["'`]?)(password|passcode|token|secret|authorization|api[_-]?key|otp|code)\1\s*[:=]\s*(["'`])(?:(?!\3).){1,200}\3/gi;
const ESCAPED_SECRET_ASSIGNMENT_RE = /\\(["'`])(password|passcode|token|secret|authorization|api[_-]?key|otp|code)\\\1\s*[:=]\s*\\(["'`])(?:(?!\\\3).){1,200}\\\3/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const LONG_SECRET_RE = /\b[A-Za-z0-9_\-.]{24,}\b/g;
const DENIED_GLOBAL_RE = /\b(?:require|import|process|fs|child_process|Deno|Bun|__dirname|__filename|eval)\b|\bFunction\s*\(/;
const DENIED_GLOBAL_ALIAS_RE = /\b(?:(?:globalThis|window|self|top|frames)|document\s*(?:\.\s*defaultView|\[\s*(["'`])defaultView\1\s*\]))\s*\[\s*(["'`])(?:eval|Function|import|require|process|fs|child_process|Deno|Bun|__dirname|__filename)\2\s*\]/;
const DENIED_HELPER_SUBSET_RE = /(?:\.\s*|\[\s*(["'`]))(?:constructor|prototype|__proto__|defaultView)(?:\1\s*\])?|\b(?:getPrototypeOf|setPrototypeOf)\s*\(/;
const DENIED_TOKEN_RES = [DENIED_GLOBAL_RE, DENIED_GLOBAL_ALIAS_RE, DENIED_HELPER_SUBSET_RE];
const COMPUTED_STRING_CONCAT_RE = /\[\s*((?:(?:["'`])[^"'`\\]*(?:["'`])\s*\+\s*)+(?:["'`])[^"'`\\]*(?:["'`]))\s*\]/g;
const STRING_LITERAL_FRAGMENT_RE = /(["'`])([^"'`\\]*)\1/g;

export const PAGE_SCRIPT_DENIED_TOKENS = [
  "require",
  "import",
  "process",
  "fs",
  "child_process",
  "Deno",
  "Bun",
  "eval",
  "Function",
  "constructor",
  "prototype",
  "__proto__",
  "getPrototypeOf",
  "setPrototypeOf",
  "defaultView",
  "__dirname",
  "__filename",
];

export function hashScript(script: string) {
  return createHash("sha256").update(script).digest("hex");
}

function normalizeSimpleComputedStringAccess(script: string) {
  return script
    .replace(/\?\s*\.\s*\[/g, "[")
    .replace(/\?\s*\./g, ".")
    .replace(COMPUTED_STRING_CONCAT_RE, (match, expression: string) => {
      const fragments = Array.from(expression.matchAll(STRING_LITERAL_FRAGMENT_RE), (fragment) => fragment[2]);
      const operators = expression.replace(STRING_LITERAL_FRAGMENT_RE, "").trim();

      if (!fragments.length || !/^\+(?:\s*\+)*$/.test(operators.replace(/\s+/g, ""))) {
        return match;
      }

      return `["${fragments.join("")}"]`;
    });
}

export function assertSafePageScript(script: string) {
  const normalizedScript = normalizeSimpleComputedStringAccess(script);

  if (DENIED_TOKEN_RES.some((pattern) => pattern.test(normalizedScript))) {
    throw new WebAgentError(
      "INPUT_VALIDATION_FAILED",
      "runtime.run_page_script only runs bounded helper-oriented page scripts. Node/import/eval-style tokens and constructor/prototype access are not allowed.",
      { denied_tokens: PAGE_SCRIPT_DENIED_TOKENS },
    );
  }
}

export function redactSensitiveText(value: string) {
  return value
    .replace(ESCAPED_SECRET_ASSIGNMENT_RE, (_match, keyQuote: string, key: string, valueQuote: string) => {
      return `\\${keyQuote}${key}\\${keyQuote}:\\${valueQuote}[REDACTED]\\${valueQuote}`;
    })
    .replace(SECRET_ASSIGNMENT_RE, (_match, keyQuote: string, key: string, valueQuote: string) => {
      const renderedKey = keyQuote ? `${keyQuote}${key}${keyQuote}` : key;
      return `${renderedKey}: ${valueQuote}[REDACTED]${valueQuote}`;
    })
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(LONG_SECRET_RE, (match) => (SECRET_KEY_RE.test(match) ? "[REDACTED]" : match));
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_KEY_RE.test(key) ? "[REDACTED]" : redactSensitiveValue(entry),
    ]),
  );
}

export function createScriptPreview(script: string, redact: boolean, limit = 500) {
  const compact = script.replace(/\s+/g, " ").trim();
  const text = redact ? redactSensitiveText(compact) : compact;
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function serializeBoundedResult(value: unknown, maxBytes: number, redact: boolean) {
  const safeValue = redact ? redactSensitiveValue(value) : value;
  const serialized = JSON.stringify(safeValue, null, 2) ?? "null";
  const bytes = Buffer.byteLength(serialized, "utf8");
  const truncated = bytes > maxBytes;
  const preview = truncated
    ? `${Buffer.from(serialized).subarray(0, maxBytes).toString("utf8")}...`
    : serialized;

  return {
    value: truncated ? undefined : safeValue,
    preview,
    truncated,
    bytes,
  };
}
