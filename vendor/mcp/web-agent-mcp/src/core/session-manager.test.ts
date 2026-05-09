import { pathToFileURL } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCloakBrowserAdapter } from "../adapters/cloakbrowser/launcher.js";
import type { WebAgentEnv } from "../config/env.js";
import { SessionManager } from "./session-manager.js";

const env = {
  serverName: "web-agent-mcp",
  serverVersion: "test",
  dataDir: "/tmp/web-agent-test",
  historyDir: "/tmp/web-agent-test/history",
  artifactDir: "/tmp/web-agent-test/artifacts",
  defaultLocale: "en-US",
  defaultTimezoneId: "UTC",
  defaultHumanize: false,
  defaultLaunchArgs: [],
  defaultViewport: { width: 1280, height: 720 },
  sessionMaxConsecutiveErrors: 2,
  sessionRestartCooldownMs: 0,
  daemon: false,
} as unknown as WebAgentEnv;

function createFakeAdapter(): any {
  const handles = new Map<string, any>();
  return {
    async createSession(input: { sessionId: string; profileMode: "ephemeral" | "persistent"; locale: string; viewport: { width: number; height: number } }) {
      const handle = {
        contextId: `context-${input.sessionId}`,
        pageId: `page-${input.sessionId}`,
        context: {},
        page: {},
        consoleEntries: [],
        networkEntries: [],
        profileMode: input.profileMode,
        locale: input.locale,
        viewport: input.viewport,
      };
      handles.set(handle.pageId, handle);
      return handle;
    },
    async createPage(session: any) {
      const handle = { ...session, pageId: `page-${handles.size + 1}`, consoleEntries: [], networkEntries: [] };
      handles.set(handle.pageId, handle);
      return handle;
    },
    async closePage() {},
    async listPages() { return [...handles.values()].map((handle) => ({ pageId: handle.pageId, url: "about:blank", closed: false, viewport: handle.viewport })); },
    async closeSession() {},
    async navigate(_session: unknown, url: string) {
      const pageId = (_session as { pageId?: string })?.pageId ?? "page";
      return {
        pageId,
        requestedUrl: url,
        finalUrl: url,
        title: "Example Page",
        elapsedMs: 1,
        waitUntil: "load",
        waitDescription: "Playwright page.goto waited for the load event.",
        before: { url: "about:blank", title: undefined },
      };
    },
    async observeText() {
      return {
        url: "https://example.com/",
        title: "Example Page",
        format: "text",
        content: "Example",
        truncated: false,
      };
    },
    async runPageScript() {
      return {
        before: { url: "https://example.com/", title: "Example Page" },
        after: { url: "https://example.com/changed", title: "Changed Page" },
        elapsedMs: 7,
        value: { ok: true },
      };
    },
    async resizePage(session: any, input: { width: number; height: number }) {
      const before = session.viewport;
      session.viewport = { width: input.width, height: input.height };
      return { before, viewport: session.viewport };
    },
    async takeScreenshot(session: any) {
      return {
        url: "https://example.com/",
        title: "Example Page",
        bytes: Buffer.from("fake"),
        mimeType: "image/png",
        width: session.viewport.width,
        height: session.viewport.height,
      };
    },
    async injectCss(_session: any, input: { cssId: string; css: string }) {
      return { cssId: input.cssId, bytes: Buffer.byteLength(input.css, "utf8") };
    },
    async removeCss() {
      return { removed: true };
    },
  } as never;
}

describe("SessionManager.getSessionBrief", () => {
  it("returns an empty brief when no sessions exist", () => {
    const manager = new SessionManager({ env, adapter: createFakeAdapter() });

    expect(manager.getSessionBrief()).toMatchObject({
      status: "empty",
      session_count: 0,
      active_session_count: 0,
      sessions: [],
    });
  });

  it("returns active session and page recovery details", async () => {
    const manager = new SessionManager({ env, adapter: createFakeAdapter() });
    const session = await manager.createSession({ profileMode: "ephemeral" });
    await manager.navigate(session.sessionId, undefined, "https://example.com/", "load");
    await manager.observeText(session.sessionId, undefined, "text");

    const brief = manager.getSessionBrief();

    expect(brief.status).toBe("active");
    expect(brief.sessions[0]).toMatchObject({
      session_id: session.sessionId,
      status: "active",
      primary_page_id: session.primaryPageId,
      health: { restart_recommended: false },
    });
    expect(brief.sessions[0]?.pages[0]).toMatchObject({
      page_id: session.primaryPageId,
      is_primary: true,
      url: "https://example.com/",
      title: "Example Page",
      last_action: { kind: "page.navigate" },
      last_observation: { kind: "observe.text" },
    });
  });

  it("reports closed and restart-recommended stale sessions", async () => {
    const closedManager = new SessionManager({ env, adapter: createFakeAdapter() });
    const closed = await closedManager.createSession({ profileMode: "ephemeral" });
    await closedManager.closeSession(closed.sessionId);

    expect(closedManager.getSessionBrief().sessions[0]).toMatchObject({
      status: "closed",
      next_safe_action: "Create a new session; this session is closed and cannot be reused.",
    });

    const staleManager = new SessionManager({ env, adapter: createFakeAdapter() });
    const stale = await staleManager.createSession({ profileMode: "ephemeral" });
    staleManager.recordFailure(stale.sessionId);
    staleManager.recordFailure(stale.sessionId);

    expect(staleManager.getSessionBrief().sessions[0]).toMatchObject({
      status: "active",
      health: { consecutive_errors: 2, restart_recommended: true },
      next_safe_action: "Prefer session.restart before continuing; repeated errors indicate stale browser state.",
    });
  });

  it("throws BROWSER_DISCONNECTED for tracked closed sessions", async () => {
    const manager = new SessionManager({ env, adapter: createFakeAdapter() });
    const closed = await manager.createSession({ profileMode: "ephemeral" });
    await manager.closeSession(closed.sessionId);

    expect(() => manager.getSession(closed.sessionId)).toThrowError(
      expect.objectContaining({
        code: "BROWSER_DISCONNECTED",
        type: "BROWSER",
        message: `Session has been closed: ${closed.sessionId}`,
        details: expect.objectContaining({
          reason: "browser_or_page_closed",
          sessionId: closed.sessionId,
          pageId: closed.primaryPageId,
          retryable: false,
          retry_hint: "Create or restart the browser session before retrying the browser tool.",
          next_safe_action: expect.stringContaining("Do not retry"),
        }),
      }),
    );
  });

  it.each([
    ["browser", "Browser has been closed"],
    ["context", "Context has been closed"],
    ["page", "Target page, context or browser has been closed"],
  ])(
    "marks the session closed after an externally closed %s failure",
    async (_kind, message) => {
      const adapter = {
        ...createFakeAdapter(),
        async observeText() {
          throw new Error(message);
        },
      } as never;
      const manager = new SessionManager({ env, adapter });
      const session = await manager.createSession({ profileMode: "ephemeral" });

      await expect(
        manager.observeText(session.sessionId, session.primaryPageId, "text"),
      ).rejects.toMatchObject({
        code: "BROWSER_DISCONNECTED",
        type: "BROWSER",
      });

      expect(manager.getSessionBrief()).toMatchObject({
        status: "inactive",
        active_session_count: 0,
        sessions: [
          {
            session_id: session.sessionId,
            status: "closed",
            primary_page_id: session.primaryPageId,
            health: { consecutive_errors: 1 },
            next_safe_action:
              "Create a new session; this session is closed and cannot be reused.",
          },
        ],
      });
      expect(() => manager.getSession(session.sessionId)).toThrowError(
        expect.objectContaining({ code: "BROWSER_DISCONNECTED" }),
      );
    },
  );

  it("records runtime.run_page_script as same-page action and observation", async () => {
    const manager = new SessionManager({ env, adapter: createFakeAdapter() });
    const session = await manager.createSession({ profileMode: "ephemeral" });

    const response = await manager.runPageScript(session.sessionId, undefined, {
      script: "return helpers.page()",
      timeoutMs: 1000,
    });

    expect(response.result).toMatchObject({
      after: { url: "https://example.com/changed", title: "Changed Page" },
      value: { ok: true },
    });
    expect(manager.getSessionBrief().sessions[0]?.pages[0]).toMatchObject({
      url: "https://example.com/changed",
      title: "Changed Page",
      last_action: { kind: "runtime.run_page_script" },
      last_observation: { kind: "runtime.run_page_script" },
    });
  });

  it("creates tabs with informational owner/purpose and targets each page handle independently", async () => {
    const calls: Array<{ pageId: string; url: string }> = [];
    const adapter = {
      ...createFakeAdapter(),
      async navigate(session: { pageId: string }, url: string) {
        calls.push({ pageId: session.pageId, url });
        return {
          pageId: session.pageId,
          requestedUrl: url,
          finalUrl: url,
          title: `Title ${session.pageId}`,
          elapsedMs: 1,
          waitUntil: "load",
          waitDescription: "Playwright page.goto waited for the load event.",
          before: { url: "about:blank", title: undefined },
        };
      },
    } as never;
    const manager = new SessionManager({ env, adapter });
    const session = await manager.createSession({ profileMode: "persistent" });
    const agentA = await manager.createPage(session.sessionId, { purpose: "research", owner: "agent-a" });
    const agentB = await manager.createPage(session.sessionId, { purpose: "verify", owner: "agent-b" });

    await Promise.all([
      manager.navigate(session.sessionId, agentA.page.pageId, "https://example.com/a", "load"),
      manager.navigate(session.sessionId, agentB.page.tabId, "https://example.com/b", "load"),
    ]);

    expect(calls).toEqual(expect.arrayContaining([
      { pageId: agentA.page.pageId, url: "https://example.com/a" },
      { pageId: agentB.page.pageId, url: "https://example.com/b" },
    ]));
    expect(manager.getSessionBrief().sessions[0]?.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ page_id: agentA.page.pageId, purpose: "research", owner: "agent-a", status: "active" }),
      expect.objectContaining({ page_id: agentB.page.pageId, purpose: "verify", owner: "agent-b", status: "active" }),
    ]));
  });

  it("resizes and screenshots targeted tabs without changing sibling tab metadata", async () => {
    const manager = new SessionManager({ env, adapter: createFakeAdapter() });
    const session = await manager.createSession({ profileMode: "ephemeral", viewport: { width: 1280, height: 720 } });
    const agentA = await manager.createPage(session.sessionId, { owner: "agent-a" });
    const agentB = await manager.createPage(session.sessionId, { owner: "agent-b" });

    const resized = await manager.resizePage(session.sessionId, agentB.page.tabId, { width: 390, height: 844 });
    const screenshot = await manager.takeScreenshot(session.sessionId, agentB.page.pageId, "viewport", "png");

    expect(resized.page).toMatchObject({ pageId: agentB.page.pageId, viewport: { width: 390, height: 844 }, lastActionKind: "page.resize" });
    expect(screenshot.result).toMatchObject({ width: 390, height: 844 });
    expect(manager.getPage(session.sessionId, agentA.page.pageId).page.viewport).toEqual({ width: 1280, height: 720 });
  });

  it("injects and removes CSS only for known targeted page ids", async () => {
    const calls: Array<{ kind: string; pageId: string; cssId: string }> = [];
    const adapter = {
      ...createFakeAdapter(),
      async injectCss(session: { pageId: string }, input: { cssId: string; css: string }) {
        calls.push({ kind: "inject", pageId: session.pageId, cssId: input.cssId });
        return { cssId: input.cssId, bytes: Buffer.byteLength(input.css, "utf8") };
      },
      async removeCss(session: { pageId: string }, input: { cssId: string }) {
        calls.push({ kind: "remove", pageId: session.pageId, cssId: input.cssId });
        return { removed: true };
      },
    } as never;
    const manager = new SessionManager({ env, adapter });
    const session = await manager.createSession({ profileMode: "ephemeral" });
    const tab = await manager.createPage(session.sessionId, { owner: "agent-css" });

    await manager.injectCss(session.sessionId, tab.page.tabId, { cssId: "probe", css: "body { outline: 3px solid red; }" });
    const removed = await manager.removeCss(session.sessionId, tab.page.pageId, { cssId: "probe" });
    const unknown = await manager.removeCss(session.sessionId, tab.page.pageId, { cssId: "missing" });

    expect(calls).toEqual([
      { kind: "inject", pageId: tab.page.pageId, cssId: "probe" },
      { kind: "remove", pageId: tab.page.pageId, cssId: "probe" },
    ]);
    expect(removed.result).toMatchObject({ removed: true, knownInjectedId: true });
    expect(unknown.result).toMatchObject({ removed: false, knownInjectedId: false });
  });

  it("targets main-frame fill and click when frameSelector is absent or empty", async () => {
    const calls: Array<{ kind: string; frameSelector?: string }> = [];
    const adapter = {
      ...createFakeAdapter(),
      async fill(_session: unknown, input: { frameSelector?: string }) {
        calls.push({ kind: "fill", frameSelector: input.frameSelector });
        return {
          url: "https://example.com/login",
          title: "Login",
          verificationHint: "Filled selector input[name=email]",
          elapsedMs: 1,
          waitedFor: [],
          before: { url: "https://example.com/login", title: "Login" },
          after: { url: "https://example.com/login", title: "Login" },
          formState: { value_present: true, value_length: 4, requested_value_length: 4, matches_requested_value: true },
        };
      },
      async click(_session: unknown, input: { frameSelector?: string }) {
        calls.push({ kind: "click", frameSelector: input.frameSelector });
        return {
          url: "https://example.com/login",
          title: "Login",
          verificationHint: "Clicked selector button[type=submit]",
          elapsedMs: 1,
          waitedFor: [],
          before: { url: "https://example.com/login", title: "Login" },
          after: { url: "https://example.com/login", title: "Login" },
          postAction: { observableChange: false, changed: [] },
        };
      },
    } as never;
    const manager = new SessionManager({ env, adapter });
    const session = await manager.createSession({ profileMode: "ephemeral" });

    await manager.fill(session.sessionId, undefined, { selector: "input[name=email]", value: "user", clearFirst: true });
    await manager.click(session.sessionId, undefined, { selector: "button[type=submit]", frameSelector: "   ", button: "left", clickCount: 1 });

    expect(calls).toEqual([
      { kind: "fill", frameSelector: undefined },
      { kind: "click", frameSelector: undefined },
    ]);
  });

  it("preserves real iframe selectors for frame-scoped actions", async () => {
    const calls: string[] = [];
    const adapter = {
      ...createFakeAdapter(),
      async fill(_session: unknown, input: { frameSelector?: string }) {
        calls.push(input.frameSelector ?? "");
        return {
          url: "https://example.com/login",
          title: "Login",
          verificationHint: "Filled selector input#otp",
          elapsedMs: 1,
          waitedFor: [],
          before: { url: "https://example.com/login", title: "Login" },
          after: { url: "https://example.com/login", title: "Login" },
          formState: { value_present: true, value_length: 6, requested_value_length: 6, matches_requested_value: true },
        };
      },
    } as never;
    const manager = new SessionManager({ env, adapter });
    const session = await manager.createSession({ profileMode: "ephemeral" });

    await manager.fill(session.sessionId, undefined, { selector: "input#otp", frameSelector: " iframe#auth ", value: "123456", clearFirst: true });

    expect(calls).toEqual(["iframe#auth"]);
  });

  it("rejects fake frame selectors with actionable guidance", async () => {
    const manager = new SessionManager({ env, adapter: createFakeAdapter() });
    const session = await manager.createSession({ profileMode: "ephemeral" });

    await expect(manager.fill(session.sessionId, undefined, { selector: "input", frameSelector: "__none__", value: "x", clearFirst: true })).rejects.toMatchObject({
      code: "INPUT_VALIDATION_FAILED",
      type: "INPUT",
      message: expect.stringContaining("frame_selector must be omitted for main-page elements"),
      details: expect.objectContaining({
        frame_selector: "__none__",
        next_safe_action: expect.stringContaining("Retry the action without frame_selector"),
      }),
    });
  });

  it("persists daemon tab registry and restores metadata with a stable persistent profile", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "web-agent-registry-"));
    try {
      const daemonEnv = {
        ...env,
        daemon: true,
        dataDir,
        chromeUserDataDir: path.join(dataDir, "profile"),
      } as WebAgentEnv;
      const manager = new SessionManager({ env: daemonEnv, adapter: createFakeAdapter() });
      const session = await manager.createSession({ profileMode: "ephemeral" });
      const tab = await manager.createPage(session.sessionId, { purpose: "handoff", owner: "agent-a" });
      await manager.navigate(session.sessionId, tab.page.pageId, "https://example.com/restore", "load");

      const registry = JSON.parse(readFileSync(path.join(dataDir, "browser-registry.json"), "utf8"));
      expect(registry).toMatchObject({ profile_mode: "persistent", profile_path: daemonEnv.chromeUserDataDir });
      expect(registry.tabs).toEqual(expect.arrayContaining([
        expect.objectContaining({ tab_id: tab.page.tabId, purpose: "handoff", owner: "agent-a", url: "https://example.com/restore" }),
      ]));

      const restored = new SessionManager({ env: daemonEnv, adapter: createFakeAdapter() });
      const restoredSession = await restored.createSession({ profileMode: "ephemeral" });
      const brief = restored.getSessionBrief();
      expect(restoredSession.profileMode).toBe("persistent");
      expect(restoredSession.userDataDir).toBe(daemonEnv.chromeUserDataDir);
      expect(brief.sessions[0]?.pages).toEqual(expect.arrayContaining([
        expect.objectContaining({ tab_id: tab.page.tabId, purpose: "handoff", owner: "agent-a" }),
      ]));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("SessionManager runtime.run_page_script browser integration", () => {
  it("runs helper scripts against the real tool matrix fixture", async () => {
    const fixtureUrl = pathToFileURL(
      new URL("../__fixtures__/tool-matrix.html", import.meta.url).pathname,
    ).href;
    const realBrowserEnv = {
      ...env,
      headless: true,
      defaultLaunchArgs: ["--no-sandbox"],
      profilesDir: "/tmp/web-agent-test/profiles",
    } as WebAgentEnv;
    const adapter = createCloakBrowserAdapter(realBrowserEnv);
    const manager = new SessionManager({ env: realBrowserEnv, adapter });
    let session: Awaited<ReturnType<SessionManager["createSession"]>> | undefined;

    try {
      session = await manager.createSession({
        profileMode: "ephemeral",
        viewport: { width: 1024, height: 768 },
      });
      await manager.navigate(session.sessionId, undefined, fixtureUrl, "load");

      const response = await manager.runPageScript(session.sessionId, undefined, {
        timeoutMs: 3000,
        script: `
          await helpers.waitFor('#delayed:not([hidden])');
          helpers.assert(helpers.text('#delayed') === 'Delayed text ready', 'delayed text should be visible');
          helpers.setValue('#name', 'Ada Lovelace');
          helpers.click('#clicker');
          helpers.click('#clicker');

          return helpers.json({
            page: helpers.page(),
            delayedText: helpers.text('#delayed'),
            clickText: helpers.text('#click-result'),
            nameValue: helpers.value('#name'),
          });
        `,
      });

      expect(response.result.before).toMatchObject({
        url: fixtureUrl,
        title: "Web Agent MCP Tool Matrix Fixture",
      });
      expect(response.result.after).toMatchObject({
        url: fixtureUrl,
        title: "Web Agent MCP Tool Matrix Fixture",
      });
      expect(response.result.value).toEqual({
        page: {
          url: fixtureUrl,
          title: "Web Agent MCP Tool Matrix Fixture",
        },
        delayedText: "Delayed text ready",
        clickText: "Clicks: 2",
        nameValue: "Ada Lovelace",
      });
      expect(manager.getSessionBrief().sessions[0]?.pages[0]).toMatchObject({
        url: fixtureUrl,
        title: "Web Agent MCP Tool Matrix Fixture",
        last_action: { kind: "runtime.run_page_script" },
        last_observation: { kind: "runtime.run_page_script" },
      });
    } finally {
      if (session?.status === "active") {
        await manager.closeSession(session.sessionId);
      }
    }
  }, 15000);
});
