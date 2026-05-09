import { describe, expect, it } from "vitest";
import { asWebAgentError, createFailureResult } from "./errors.js";

describe("browser closed error mapping", () => {
  it("classifies closed Playwright targets as actionable browser disconnections", () => {
    const mapped = asWebAgentError(
      new Error("Target page, context or browser has been closed"),
    );

    expect(mapped.code).toBe("BROWSER_DISCONNECTED");
    expect(mapped.type).toBe("BROWSER");
    expect(mapped.details).toMatchObject({
      reason: "browser_or_page_closed",
      retryable: false,
    });
  });

  it("returns a safe structured browser failure envelope with ids", () => {
    const result = createFailureResult(
      new Error("Target closed\n    at secret stack frame"),
      {
        action_id: "action_123",
        session_id: "session_123",
        page_id: "page_123",
      },
    );

    expect(result.isError).toBe(true);
    expect(result).not.toHaveProperty("structuredContent");
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      ok: false,
      code: "BROWSER_DISCONNECTED",
      message: "Browser session, context, or page is closed/disconnected.",
      action_id: "action_123",
      session_id: "session_123",
      page_id: "page_123",
      error: {
        type: "BROWSER",
        details: {
          reason: "browser_or_page_closed",
          next_safe_action: expect.stringContaining("Do not retry"),
          retryable: false,
          action_id: "action_123",
          session_id: "session_123",
          page_id: "page_123",
        },
      },
    });
    expect(result.content[0]!.text).not.toContain("secret stack frame");
  });

  it("classifies session-closed messages as actionable browser disconnections", () => {
    const result = createFailureResult(new Error("Session has been closed"), {
      session_id: "session_closed",
    });

    expect(result).not.toHaveProperty("structuredContent");
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      ok: false,
      code: "BROWSER_DISCONNECTED",
      message: "Browser session, context, or page is closed/disconnected.",
      session_id: "session_closed",
      error: {
        type: "BROWSER",
        details: {
          reason: "browser_or_page_closed",
          retryable: false,
          retry_hint: "Create or restart the browser session before retrying the browser tool.",
          next_safe_action: expect.stringContaining("Do not retry"),
          session_id: "session_closed",
        },
      },
    });
  });
});
