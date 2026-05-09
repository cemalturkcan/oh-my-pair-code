import { describe, expect, it } from "vitest";
import { registerClickTool } from "./act/click.js";
import { registerObserveTextTool } from "./observe/text.js";
import { registerNavigatePageTool } from "./page/navigate.js";

function createServer() {
  let handler: ((input: any) => Promise<any>) | undefined;
  return {
    server: {
      registerTool(_name: string, _config: unknown, registeredHandler: typeof handler) {
        handler = registeredHandler;
      },
    },
    async call(input: unknown) {
      if (!handler) {
        throw new Error("Tool was not registered.");
      }
      return handler(input);
    },
  };
}

function expectActionableBrowserFailure(result: any, input: { session_id: string; page_id?: string }) {
  expect(result.isError).toBe(true);
  expect(result).not.toHaveProperty("structuredContent");
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({
    ok: false,
    code: "BROWSER_DISCONNECTED",
    message: "Browser session, context, or page is closed/disconnected.",
    session_id: input.session_id,
    page_id: input.page_id,
    error: {
      type: "BROWSER",
      details: {
        reason: "browser_or_page_closed",
        next_safe_action: expect.stringContaining("Do not retry"),
        retryable: false,
        session_id: input.session_id,
        page_id: input.page_id,
      },
    },
  });
  return JSON.parse(result.content[0]!.text);
}

describe("browser tool closed-target failures", () => {
  it("returns actionable page.navigate browser failure details with input ids", async () => {
    const registered = createServer();
    registerNavigatePageTool(registered.server as never, {
      history: {
        async startAction() {
          return { action_id: "action_nav" };
        },
      },
      sessions: {
        async navigate() {
          throw new Error("Target page, context or browser has been closed");
        },
      },
    } as never);

    const result = await registered.call({
      session_id: "session_nav",
      page_id: "page_nav",
      url: "https://example.com/",
      wait_until: "load",
    });

    const payload = expectActionableBrowserFailure(result, {
      session_id: "session_nav",
      page_id: "page_nav",
    });
    expect(payload.action_id).toBe("action_nav");
  });

  it("returns actionable observe.text browser failure details with input ids", async () => {
    const registered = createServer();
    registerObserveTextTool(registered.server as never, {
      history: {
        async startAction() {
          return { action_id: "action_observe" };
        },
      },
      sessions: {
        async observeText() {
          throw new Error("Browser has been closed");
        },
      },
    } as never);

    const result = await registered.call({
      session_id: "session_observe",
      page_id: "page_observe",
      format: "text",
    });

    const payload = expectActionableBrowserFailure(result, {
      session_id: "session_observe",
      page_id: "page_observe",
    });
    expect(payload.action_id).toBe("action_observe");
  });

  it("returns actionable act.click browser failure details with input ids", async () => {
    const registered = createServer();
    registerClickTool(registered.server as never, {
      env: { sessionMaxConsecutiveErrors: 2, sessionRestartCooldownMs: 0 },
      history: {
        async startAction() {
          return { action_id: "action_click" };
        },
      },
      sessions: {
        async click() {
          throw new Error("Page has been closed");
        },
        recordFailure() {
          return { consecutiveErrors: 1, lastRestartAt: undefined };
        },
      },
    } as never);

    const result = await registered.call({
      session_id: "session_click",
      page_id: "page_click",
      selector: "#button",
      button: "left",
      click_count: 1,
      timeout_ms: 1000,
    });

    const payload = expectActionableBrowserFailure(result, {
      session_id: "session_click",
      page_id: "page_click",
    });
    expect(payload.action_id).toBe("action_click");
  });
});
