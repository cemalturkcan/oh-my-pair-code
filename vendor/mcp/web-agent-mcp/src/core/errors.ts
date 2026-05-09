import type { ErrorType, ToolEnvelope } from "../schemas/common.js";
import { createToolFailure } from "../schemas/common.js";

export type WebAgentErrorCode =
  | "INPUT_INVALID_URL"
  | "INPUT_VALIDATION_FAILED"
  | "INPUT_MISSING_SESSION"
  | "STATE_PAGE_NOT_FOUND"
  | "STATE_NAVIGATION_NOT_OBSERVED"
  | "STATE_ELEMENT_NOT_FOUND"
  | "STATE_TARGET_NOT_INTERACTABLE"
  | "BROWSER_LAUNCH_FAILED"
  | "BROWSER_DISCONNECTED"
  | "NETWORK_TIMEOUT"
  | "STORAGE_WRITE_FAILED"
  | "INTERNAL_NOT_IMPLEMENTED"
  | "INTERNAL_UNREACHABLE";

const errorTypeByCode: Record<WebAgentErrorCode, ErrorType> = {
  INPUT_INVALID_URL: "INPUT",
  INPUT_VALIDATION_FAILED: "INPUT",
  INPUT_MISSING_SESSION: "INPUT",
  STATE_PAGE_NOT_FOUND: "STATE",
  STATE_NAVIGATION_NOT_OBSERVED: "STATE",
  STATE_ELEMENT_NOT_FOUND: "STATE",
  STATE_TARGET_NOT_INTERACTABLE: "STATE",
  BROWSER_LAUNCH_FAILED: "BROWSER",
  BROWSER_DISCONNECTED: "BROWSER",
  NETWORK_TIMEOUT: "NETWORK",
  STORAGE_WRITE_FAILED: "STORAGE",
  INTERNAL_NOT_IMPLEMENTED: "INTERNAL",
  INTERNAL_UNREACHABLE: "INTERNAL",
};

export class WebAgentError extends Error {
  readonly code: WebAgentErrorCode;
  readonly type: ErrorType;
  readonly details?: Record<string, unknown>;

  constructor(
    code: WebAgentErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WebAgentError";
    this.code = code;
    this.type = errorTypeByCode[code];
    this.details = details;
  }
}

const browserDisconnectedDetails = {
  reason: "browser_or_page_closed",
  next_safe_action:
    "Do not retry this stale session_id/page_id. Check session.status, then restart the session or create a new browser session before continuing.",
  retryable: false,
  retry_hint: "Create or restart the browser session before retrying the browser tool.",
};

function isClosedBrowserMessage(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("target page, context or browser has been closed") ||
    normalized.includes("browser has been closed") ||
    normalized.includes("browser is closed") ||
    normalized.includes("page has been closed") ||
    normalized.includes("context has been closed") ||
    normalized.includes("session has been closed") ||
    normalized.includes("session is closed") ||
    normalized.includes("session disconnected") ||
    normalized.includes("browser disconnected") ||
    normalized.includes("target closed")
  );
}

function sanitizeMessage(error: WebAgentError) {
  if (error.code === "BROWSER_DISCONNECTED") {
    return "Browser session, context, or page is closed/disconnected.";
  }

  return error.message.split("\n")[0] ?? error.message;
}

function buildErrorDetails(
  mapped: WebAgentError,
  envelope: Partial<ToolEnvelope>,
) {
  const details = { ...(mapped.details ?? {}) };

  if (mapped.code === "BROWSER_DISCONNECTED") {
    Object.assign(details, browserDisconnectedDetails);
  }

  if (envelope.session_id && details.session_id === undefined) {
    details.session_id = envelope.session_id;
  }

  if (envelope.page_id && details.page_id === undefined) {
    details.page_id = envelope.page_id;
  }

  if (envelope.action_id && details.action_id === undefined) {
    details.action_id = envelope.action_id;
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

export function asWebAgentError(error: unknown) {
  if (error instanceof WebAgentError) {
    return error;
  }

  const message =
    error instanceof Error ? error.message : "Unexpected internal error.";

  if (
    message.includes("locator(") ||
    message.includes("waitForSelector") ||
    message.includes("bounding box")
  ) {
    if (message.toLowerCase().includes("timeout")) {
      return new WebAgentError("STATE_ELEMENT_NOT_FOUND", message);
    }

    if (
      message.toLowerCase().includes("not visible") ||
      message.toLowerCase().includes("not enabled")
    ) {
      return new WebAgentError("STATE_TARGET_NOT_INTERACTABLE", message);
    }

    return new WebAgentError("STATE_ELEMENT_NOT_FOUND", message);
  }

  if (isClosedBrowserMessage(message)) {
    return new WebAgentError(
      "BROWSER_DISCONNECTED",
      message,
      browserDisconnectedDetails,
    );
  }

  if (message.toLowerCase().includes("timeout")) {
    return new WebAgentError("NETWORK_TIMEOUT", message);
  }

  return new WebAgentError("INTERNAL_UNREACHABLE", message);
}

export function createFailureResult(
  error: unknown,
  envelope: Partial<ToolEnvelope> = {},
) {
  const mapped = asWebAgentError(error);
  const message = sanitizeMessage(mapped);
  return createToolFailure({
    ok: false,
    code: mapped.code,
    message,
    ...envelope,
    error: {
      type: mapped.type,
      details: buildErrorDetails(mapped, envelope),
    },
  });
}
