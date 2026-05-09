import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WebAgentEnv } from "../config/env.js";
import { asWebAgentError, WebAgentError } from "./errors.js";
import { createId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import { shouldRecommendSessionRestart } from "./session-restart-policy.js";
import type {
  AdapterConsoleEntry,
  AdapterElementBox,
  AdapterNetworkEntry,
  AdapterProfileMode,
  AdapterSessionHandle,
  CloakBrowserAdapter,
  WaitUntilState,
} from "../adapters/cloakbrowser/adapter.js";

export type ManagedPage = {
  pageId: string;
  tabId: string;
  createdAt: string;
  updatedAt: string;
  url?: string;
  title?: string;
  purpose?: string;
  owner?: string;
  status: "active" | "stale" | "closed";
  viewport: { width: number; height: number };
  injectedCssIds: Set<string>;
  lastObservationAt?: string;
  lastObservationKind?: string;
  lastActionAt?: string;
  lastActionKind?: string;
  adapterSession: AdapterSessionHandle;
};

export type ManagedSession = {
  sessionId: string;
  contextId: string;
  createdAt: string;
  status: "active" | "closing" | "closed" | "error";
  profileMode: AdapterProfileMode;
  locale?: string;
  timezoneId?: string;
  userDataDir?: string;
  profileDirectory?: string;
  humanize: boolean;
  launchArgs: string[];
  viewport: {
    width: number;
    height: number;
  };
  consecutiveErrors: number;
  lastErrorAt?: string;
  lastRestartAt?: string;
  pages: Map<string, ManagedPage>;
  primaryPageId: string;
  adapterSession: AdapterSessionHandle;
};

type SessionManagerDeps = {
  env: WebAgentEnv;
  adapter: CloakBrowserAdapter;
};

type DurableTabRecord = {
  tab_id: string;
  page_id: string;
  purpose?: string;
  owner?: string;
  url?: string;
  title?: string;
  status: "active" | "stale" | "closed";
  viewport: { width: number; height: number };
  created_at: string;
  updated_at: string;
};

type DurableBrowserRegistry = {
  version: 1;
  global_session_id?: string;
  profile_path?: string;
  profile_mode: AdapterProfileMode;
  tabs: DurableTabRecord[];
  updated_at: string;
};

function recommendNextSafeAction(
  status: ManagedSession["status"],
  restartRecommended: boolean,
) {
  if (status === "active" && restartRecommended) {
    return "Prefer session.restart before continuing; repeated errors indicate stale browser state.";
  }
  if (status === "active") {
    return "Reuse this session_id and primary_page_id; observe page state before acting if context is stale.";
  }
  if (status === "closed") {
    return "Create a new session; this session is closed and cannot be reused.";
  }
  if (status === "closing") {
    return "Wait briefly, then check status again before creating or restarting a session.";
  }
  return "Restart this session if preserving state is useful; otherwise create a new session.";
}

function createTabId() {
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeFrameSelector(frameSelector?: string | null) {
  const trimmed = frameSelector?.trim();
  if (!trimmed) return undefined;

  const placeholderSelectors = new Set(["body", ":scope", "__none__"]);
  if (placeholderSelectors.has(trimmed.toLowerCase())) {
    throw new WebAgentError(
      "INPUT_VALIDATION_FAILED",
      `frame_selector must be omitted for main-page elements. Only provide frame_selector when you observed a real iframe selector; do not use placeholder value "${trimmed}".`,
      {
        frame_selector: trimmed,
        next_safe_action:
          "Retry the action without frame_selector for main-page elements, or first observe DOM/page_state and pass a real iframe selector such as iframe#auth when the target is inside an iframe.",
      },
    );
  }

  return trimmed;
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly activeUserDataDirs = new Map<string, string>(); // userDataDir → sessionId
  private readonly registryPath: string;
  private readonly durableRegistry?: DurableBrowserRegistry;

  constructor(private readonly deps: SessionManagerDeps) {
    this.registryPath = path.join(deps.env.dataDir, "browser-registry.json");
    this.durableRegistry = this.readRegistry();
  }

  private readRegistry(): DurableBrowserRegistry | undefined {
    if (!this.deps.env.daemon || !existsSync(this.registryPath)) return undefined;
    try {
      return JSON.parse(readFileSync(this.registryPath, "utf8")) as DurableBrowserRegistry;
    } catch {
      return undefined;
    }
  }

  private writeRegistry() {
    if (!this.deps.env.daemon) return;
    mkdirSync(path.dirname(this.registryPath), { recursive: true });
    const globalSession = [...this.sessions.values()].find((session) => session.status === "active") ?? [...this.sessions.values()][0];
    const tabs = globalSession
      ? [...globalSession.pages.values()].map((page) => ({
          tab_id: page.tabId,
          page_id: page.pageId,
          purpose: page.purpose,
          owner: page.owner,
          url: page.url,
          title: page.title,
          status: page.status,
          viewport: page.viewport,
          created_at: page.createdAt,
          updated_at: page.updatedAt,
        }))
      : (this.durableRegistry?.tabs ?? []);
    const registry: DurableBrowserRegistry = {
      version: 1,
      global_session_id: globalSession?.sessionId,
      profile_path: globalSession?.userDataDir ?? this.deps.env.chromeUserDataDir,
      profile_mode: "persistent",
      tabs,
      updated_at: nowIso(),
    };
    writeFileSync(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  }

  private activeSession() {
    return [...this.sessions.values()].find((session) => session.status === "active");
  }

  async createSession(input: {
    profileMode: AdapterProfileMode;
    locale?: string;
    timezoneId?: string;
    userDataDir?: string;
    profileDirectory?: string;
    humanize?: boolean;
    launchArgs?: string[];
    viewport?: { width: number; height: number };
  }) {
    if (this.deps.env.daemon) {
      const existing = this.activeSession();
      if (existing) return existing;
    }
    const sessionId = this.deps.env.daemon
      ? (this.durableRegistry?.global_session_id ?? createId("session"))
      : createId("session");
    const locale = input.locale ?? this.deps.env.defaultLocale;
    const timezoneId = input.timezoneId ?? this.deps.env.defaultTimezoneId;
    const profileMode = this.deps.env.daemon ? "persistent" : input.profileMode;
    const userDataDir = this.deps.env.daemon
      ? (this.deps.env.chromeUserDataDir ?? path.join(this.deps.env.dataDir, "profile"))
      : (input.userDataDir ?? this.deps.env.chromeUserDataDir);
    const profileDirectory =
      input.profileDirectory ?? this.deps.env.chromeProfileDirectory;
    const humanize = input.humanize ?? this.deps.env.defaultHumanize;
    const launchArgs = [
      ...(input.launchArgs ?? this.deps.env.defaultLaunchArgs),
      ...(profileDirectory ? [`--profile-directory=${profileDirectory}`] : []),
    ];
    const viewport = input.viewport ?? this.deps.env.defaultViewport;

    if (profileMode === "persistent" && userDataDir) {
      const conflictingSessionId = this.activeUserDataDirs.get(userDataDir);
      if (conflictingSessionId) {
        const conflicting = this.sessions.get(conflictingSessionId);
        if (conflicting && conflicting.status === "active") {
          throw new WebAgentError(
            "STATE_PAGE_NOT_FOUND",
            `Profile directory "${userDataDir}" is already in use by session ${conflictingSessionId}. Close that session first with session.close, or create a new session without a profile to use ephemeral mode.`,
            { userDataDir, conflictingSessionId },
          );
        }
      }
    }

    const adapterSession = await this.deps.adapter.createSession({
      sessionId,
      profileMode,
      locale,
      timezoneId,
      userDataDir,
      profileDirectory,
      humanize,
      launchArgs,
      viewport,
    });

    const page: ManagedPage = {
      pageId: adapterSession.pageId,
      tabId: this.durableRegistry?.tabs[0]?.tab_id ?? createTabId(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      purpose: this.durableRegistry?.tabs[0]?.purpose,
      owner: this.durableRegistry?.tabs[0]?.owner,
      url: this.durableRegistry?.tabs[0]?.url,
      title: this.durableRegistry?.tabs[0]?.title,
      status: this.durableRegistry?.tabs[0] ? "stale" : "active",
      viewport,
      injectedCssIds: new Set(),
      adapterSession,
    };

    const session: ManagedSession = {
      sessionId,
      contextId: adapterSession.contextId,
      createdAt: nowIso(),
      status: "active",
      profileMode,
      locale,
      timezoneId,
      userDataDir,
      profileDirectory,
      humanize,
      launchArgs,
      viewport,
      consecutiveErrors: 0,
      primaryPageId: page.pageId,
      pages: new Map([[page.pageId, page]]),
      adapterSession,
    };

    this.sessions.set(sessionId, session);
    if (profileMode === "persistent" && userDataDir) {
      this.activeUserDataDirs.set(userDataDir, sessionId);
    }
    this.writeRegistry();
    if (this.deps.env.daemon && this.durableRegistry?.tabs.length) {
      await this.restoreDurableTabs(session);
    }
    return session;
  }

  private async restoreDurableTabs(session: ManagedSession) {
    const records = this.durableRegistry?.tabs ?? [];
    for (const [index, record] of records.entries()) {
      const existing = index === 0 ? session.pages.get(session.primaryPageId) : undefined;
      const adapterSession = existing?.adapterSession ?? await this.deps.adapter.createPage(session.adapterSession);
      const page: ManagedPage = {
        pageId: adapterSession.pageId,
        tabId: record.tab_id,
        createdAt: record.created_at,
        updatedAt: nowIso(),
        purpose: record.purpose,
        owner: record.owner,
        url: record.url,
        title: record.title,
        status: "stale",
        viewport: record.viewport,
        injectedCssIds: new Set(),
        adapterSession,
      };
      session.pages.set(page.pageId, page);
      if (index === 0) session.primaryPageId = page.pageId;
      if (record.url && record.url !== "about:blank") {
        try {
          const result = await this.deps.adapter.navigate(adapterSession, record.url, "domcontentloaded");
          session.pages.set(page.pageId, {
            ...page,
            url: result.finalUrl,
            title: result.title,
            status: "active",
            updatedAt: nowIso(),
          });
        } catch {
          session.pages.set(page.pageId, page);
        }
      }
    }
    this.writeRegistry();
  }

  getSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new WebAgentError(
        "INPUT_MISSING_SESSION",
        `Session not found: ${sessionId}`,
        { sessionId },
      );
    }
    if (session.status === "closed") {
      throw new WebAgentError(
        "BROWSER_DISCONNECTED",
        `Session has been closed: ${sessionId}`,
        {
          reason: "browser_or_page_closed",
          sessionId,
          pageId: session.primaryPageId,
          retryable: false,
          retry_hint: "Create or restart the browser session before retrying the browser tool.",
          next_safe_action:
            "Do not retry this stale session_id/page_id. Check session.status, then restart the session or create a new browser session before continuing.",
        },
      );
    }
    return session;
  }

  getPage(sessionId: string, pageId?: string) {
    const session = this.getSession(sessionId);
    const resolvedPageId = pageId ?? session.primaryPageId;
    const page = session.pages.get(resolvedPageId) ?? [...session.pages.values()].find((candidate) => candidate.tabId === resolvedPageId);
    if (!page) {
      throw new WebAgentError(
        "STATE_PAGE_NOT_FOUND",
        `Page not found: ${resolvedPageId}`,
        {
          sessionId,
          pageId: resolvedPageId,
        },
      );
    }
    return { session, page };
  }

  updatePage(sessionId: string, pageId: string, patch: Partial<ManagedPage>) {
    const { session, page } = this.getPage(sessionId, pageId);
    session.pages.set(page.pageId, { ...page, ...patch, updatedAt: nowIso() });
    this.writeRegistry();
  }

  async createPage(sessionId: string, input: { purpose?: string; owner?: string } = {}) {
    const session = this.getSession(sessionId);
    const adapterSession = await this.deps.adapter.createPage(session.adapterSession);
    const page: ManagedPage = {
      pageId: adapterSession.pageId,
      tabId: createTabId(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      purpose: input.purpose,
      owner: input.owner,
      status: "active",
      viewport: session.viewport,
      injectedCssIds: new Set(),
      adapterSession,
    };
    session.pages.set(page.pageId, page);
    this.writeRegistry();
    return { session, page };
  }

  recordSuccess(sessionId: string) {
    const session = this.getSession(sessionId);
    session.consecutiveErrors = 0;
    session.lastErrorAt = undefined;
    this.sessions.set(sessionId, session);
  }

  recordFailure(sessionId: string) {
    const session = this.getSession(sessionId);
    session.consecutiveErrors += 1;
    session.lastErrorAt = nowIso();
    this.sessions.set(sessionId, session);
    return session;
  }

  private recordAdapterFailure(sessionId: string, error: unknown): never {
    const mapped = asWebAgentError(error);
    const session = this.recordFailure(sessionId);

    if (mapped.code === "BROWSER_DISCONNECTED") {
      session.status = "closed";
      this.sessions.set(sessionId, session);
      if (session.userDataDir) {
        this.activeUserDataDirs.delete(session.userDataDir);
      }
    }

    throw mapped;
  }

  getSessionHealth(sessionId: string) {
    const session = this.getSession(sessionId);
    return {
      consecutiveErrors: session.consecutiveErrors,
      lastErrorAt: session.lastErrorAt,
      lastRestartAt: session.lastRestartAt,
      restartRecommended: shouldRecommendSessionRestart({
        consecutiveErrors: session.consecutiveErrors,
        maxConsecutiveErrors: this.deps.env.sessionMaxConsecutiveErrors,
        cooldownMs: this.deps.env.sessionRestartCooldownMs,
        lastRestartAt: session.lastRestartAt,
        now: nowIso(),
        browserError: false,
      }).recommended,
    };
  }

  getSessionBrief() {
    const sessions = [...this.sessions.values()].map((session) => {
      const health = {
        consecutive_errors: session.consecutiveErrors,
        last_error_at: session.lastErrorAt,
        last_restart_at: session.lastRestartAt,
        restart_recommended: shouldRecommendSessionRestart({
          consecutiveErrors: session.consecutiveErrors,
          maxConsecutiveErrors: this.deps.env.sessionMaxConsecutiveErrors,
          cooldownMs: this.deps.env.sessionRestartCooldownMs,
          lastRestartAt: session.lastRestartAt,
          now: nowIso(),
          browserError: session.status === "error",
        }).recommended,
      };
      const pages = [...session.pages.values()].map((page) => ({
        page_id: page.pageId,
        tab_id: page.tabId,
        is_primary: page.pageId === session.primaryPageId,
        status: page.status,
        purpose: page.purpose,
        owner: page.owner,
        viewport: page.viewport,
        created_at: page.createdAt,
        updated_at: page.updatedAt,
        url: page.url,
        title: page.title,
        last_action: page.lastActionAt
          ? { kind: page.lastActionKind, at: page.lastActionAt }
          : undefined,
        last_observation: page.lastObservationAt
          ? { kind: page.lastObservationKind, at: page.lastObservationAt }
          : undefined,
      }));
      return {
        session_id: session.sessionId,
        context_id: session.contextId,
        status: session.status,
        profile_mode: session.profileMode,
        created_at: session.createdAt,
        primary_page_id: session.primaryPageId,
        registry_path: this.deps.env.daemon ? this.registryPath : undefined,
        page_count: pages.length,
        pages,
        health,
        next_safe_action: recommendNextSafeAction(session.status, health.restart_recommended),
      };
    });

    return {
      status: sessions.some((session) => session.status === "active")
        ? "active"
        : sessions.length > 0
          ? "inactive"
          : "empty",
      session_count: sessions.length,
      active_session_count: sessions.filter((session) => session.status === "active").length,
      sessions,
      next_safe_action:
        sessions.length === 0
          ? "No browser sessions are known. Create a session only if browser access is needed."
          : "Inspect tabs first, then target actions with the intended page_id or tab_id; owner/purpose are informational only.",
    };
  }

  async restartSession(sessionId: string) {
    const session = this.getSession(sessionId);
    const previous = {
      profileMode: session.profileMode,
      locale: session.locale,
      timezoneId: session.timezoneId,
      userDataDir: session.userDataDir,
      profileDirectory: session.profileDirectory,
      humanize: session.humanize,
      launchArgs: session.launchArgs,
      viewport: session.viewport,
    };
    await this.deps.adapter.closeSession(session.adapterSession);
    if (previous.userDataDir) {
      this.activeUserDataDirs.delete(previous.userDataDir);
    }
    const adapterSession = await this.deps.adapter.createSession({
      sessionId,
      profileMode: previous.profileMode,
      locale: previous.locale ?? this.deps.env.defaultLocale,
      timezoneId: previous.timezoneId,
      userDataDir: previous.userDataDir,
      profileDirectory: previous.profileDirectory,
      humanize: previous.humanize,
      launchArgs: previous.launchArgs,
      viewport: previous.viewport,
    });
    const oldPrimary = session.pages.get(session.primaryPageId);
    const page: ManagedPage = {
      pageId: adapterSession.pageId,
      tabId: oldPrimary?.tabId ?? createTabId(),
      createdAt: oldPrimary?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      purpose: oldPrimary?.purpose,
      owner: oldPrimary?.owner,
      url: oldPrimary?.url,
      title: oldPrimary?.title,
      status: "stale",
      viewport: previous.viewport,
      injectedCssIds: new Set(),
      adapterSession,
    };
    const restarted: ManagedSession = {
      ...session,
      contextId: adapterSession.contextId,
      status: "active",
      consecutiveErrors: 0,
      lastErrorAt: undefined,
      lastRestartAt: nowIso(),
      primaryPageId: page.pageId,
      pages: new Map([[page.pageId, page]]),
      adapterSession,
    };
    this.sessions.set(sessionId, restarted);
    if (previous.profileMode === "persistent" && previous.userDataDir) {
      this.activeUserDataDirs.set(previous.userDataDir, sessionId);
    }
    this.writeRegistry();
    return restarted;
  }

  async navigate(
    sessionId: string,
    pageId: string | undefined,
    url: string,
    waitUntil: WaitUntilState,
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.navigate(
      page.adapterSession,
      url,
      waitUntil,
    );
    this.updatePage(session.sessionId, page.pageId, {
      url: result.finalUrl,
      title: result.title,
      lastActionAt: nowIso(),
      lastActionKind: "page.navigate",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async observeA11y(sessionId: string, pageId?: string) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.observeA11y(page.adapterSession);
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastObservationAt: nowIso(),
      lastObservationKind: "observe.a11y",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async observeDom(sessionId: string, pageId?: string) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.observeDom(page.adapterSession);
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastObservationAt: nowIso(),
      lastObservationKind: "observe.dom",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async observeText(
    sessionId: string,
    pageId: string | undefined,
    format: "text" | "markdown",
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.observeText(
      page.adapterSession,
      format,
    ).catch((error: unknown) => this.recordAdapterFailure(session.sessionId, error));
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastObservationAt: nowIso(),
      lastObservationKind: "observe.text",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async observePageState(
    sessionId: string,
    pageId: string | undefined,
    recentNetworkLimit: number,
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.inspectPageState(
      page.adapterSession,
      recentNetworkLimit,
    );
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastObservationAt: nowIso(),
      lastObservationKind: "observe.page_state",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async observeAuthState(
    sessionId: string,
    pageId: string | undefined,
    recentNetworkLimit: number,
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.inspectAuthState(
      page.adapterSession,
      recentNetworkLimit,
    );
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastObservationAt: nowIso(),
      lastObservationKind: "observe.auth_state",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async takeScreenshot(
    sessionId: string,
    pageId: string | undefined,
    mode: "viewport" | "full" | "element",
    format: "png" | "jpeg",
    quality?: number,
    selector?: string,
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.takeScreenshot(
      page.adapterSession,
      mode,
      format,
      quality,
      selector,
    );
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastObservationAt: nowIso(),
      lastObservationKind: "observe.screenshot",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async resizePage(
    sessionId: string,
    pageId: string | undefined,
    input: { width: number; height: number; deviceScaleFactor?: number; isMobile?: boolean },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.resizePage(page.adapterSession, input);
    this.updatePage(session.sessionId, page.pageId, {
      viewport: result.viewport,
      lastActionAt: nowIso(),
      lastActionKind: "page.resize",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async observeBoxes(
    sessionId: string,
    pageId: string | undefined,
    selectors: string[],
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.observeBoxes(
      page.adapterSession,
      selectors,
    );
    this.updatePage(session.sessionId, page.pageId, {
      lastObservationAt: nowIso(),
      lastObservationKind: "observe.boxes",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async observeConsole(
    sessionId: string,
    pageId: string | undefined,
    limit: number,
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.observeConsole(
      page.adapterSession,
      limit,
    );
    this.updatePage(session.sessionId, page.pageId, {
      lastObservationAt: nowIso(),
      lastObservationKind: "observe.console",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async observeNetwork(
    sessionId: string,
    pageId: string | undefined,
    limit: number,
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.observeNetwork(
      page.adapterSession,
      limit,
    );
    this.updatePage(session.sessionId, page.pageId, {
      lastObservationAt: nowIso(),
      lastObservationKind: "observe.network",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async waitForNetwork(
    sessionId: string,
    pageId: string | undefined,
    input: {
      urlPattern: string;
      useRegex: boolean;
      status?: number;
      outcome?: "response" | "failed";
      timeoutMs: number;
      pollIntervalMs: number;
    },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.waitForNetwork(
      page.adapterSession,
      input,
    );
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastObservationAt: nowIso(),
      lastObservationKind: "observe.wait_for_network",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async evaluateJs(
    sessionId: string,
    pageId: string | undefined,
    input: { expression: string; awaitPromise: boolean },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.evaluateJs(
      page.adapterSession,
      input,
    );
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastActionAt: nowIso(),
      lastActionKind: "runtime.evaluate_js",
      lastObservationAt: nowIso(),
      lastObservationKind: "runtime.evaluate_js",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async runPageScript(
    sessionId: string,
    pageId: string | undefined,
    input: { script: string; timeoutMs: number },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.runPageScript(
      page.adapterSession,
      input,
    );
    this.updatePage(session.sessionId, page.pageId, {
      url: result.after.url,
      title: result.after.title,
      lastActionAt: nowIso(),
      lastActionKind: "runtime.run_page_script",
      lastObservationAt: nowIso(),
      lastObservationKind: "runtime.run_page_script",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async injectCss(
    sessionId: string,
    pageId: string | undefined,
    input: { cssId: string; css: string },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.injectCss(page.adapterSession, input);
    page.injectedCssIds.add(input.cssId);
    this.updatePage(session.sessionId, page.pageId, {
      lastActionAt: nowIso(),
      lastActionKind: "runtime.inject_css",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async removeCss(
    sessionId: string,
    pageId: string | undefined,
    input: { cssId: string },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    if (!page.injectedCssIds.has(input.cssId)) {
      return { session, page, result: { removed: false, knownInjectedId: false } };
    }
    const result = await this.deps.adapter.removeCss(page.adapterSession, input);
    page.injectedCssIds.delete(input.cssId);
    this.updatePage(session.sessionId, page.pageId, {
      lastActionAt: nowIso(),
      lastActionKind: "runtime.remove_css",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result: { ...result, knownInjectedId: true } };
  }

  async click(
    sessionId: string,
    pageId: string | undefined,
    input: {
      selector: string;
      frameSelector?: string;
      button: "left" | "right" | "middle";
      clickCount: number;
      timeoutMs?: number;
    },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.click(page.adapterSession, {
      ...input,
      frameSelector: normalizeFrameSelector(input.frameSelector),
    });
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastActionAt: nowIso(),
      lastActionKind: "act.click",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async fill(
    sessionId: string,
    pageId: string | undefined,
    input: {
      selector: string;
      frameSelector?: string;
      value: string;
      clearFirst: boolean;
      timeoutMs?: number;
    },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.fill(page.adapterSession, {
      ...input,
      frameSelector: normalizeFrameSelector(input.frameSelector),
    });
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastActionAt: nowIso(),
      lastActionKind: "act.fill",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async enterCode(
    sessionId: string,
    pageId: string | undefined,
    input: {
      code: string;
      selector?: string;
      frameSelector?: string;
      submit: boolean;
      timeoutMs?: number;
    },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.enterCode(
      page.adapterSession,
      {
        ...input,
        frameSelector: normalizeFrameSelector(input.frameSelector),
      },
    );
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastActionAt: nowIso(),
      lastActionKind: "act.enter_code",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async press(
    sessionId: string,
    pageId: string | undefined,
    input: {
      key: string;
      selector?: string;
      frameSelector?: string;
      timeoutMs?: number;
    },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.press(page.adapterSession, {
      ...input,
      frameSelector: normalizeFrameSelector(input.frameSelector),
    });
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastActionAt: nowIso(),
      lastActionKind: "act.press",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async waitFor(
    sessionId: string,
    pageId: string | undefined,
    input: { selector?: string; text?: string; timeoutMs: number },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.waitFor(
      page.adapterSession,
      input,
    );
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastObservationAt: nowIso(),
      lastObservationKind: "act.wait_for",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async wheel(
    sessionId: string,
    pageId: string | undefined,
    input: {
      selector?: string;
      deltaX: number;
      deltaY: number;
      steps: number;
      stepDelayMs: number;
      timeoutMs?: number;
    },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.wheel(page.adapterSession, input);
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastActionAt: nowIso(),
      lastActionKind: "act.wheel",
      lastObservationAt: nowIso(),
      lastObservationKind: "act.wheel",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async drag(
    sessionId: string,
    pageId: string | undefined,
    input: {
      fromSelector: string;
      toSelector: string;
      steps: number;
      timeoutMs?: number;
    },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.drag(page.adapterSession, input);
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastActionAt: nowIso(),
      lastActionKind: "act.drag",
      lastObservationAt: nowIso(),
      lastObservationKind: "act.drag",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async swipe(
    sessionId: string,
    pageId: string | undefined,
    input: {
      selector?: string;
      startX?: number;
      startY?: number;
      deltaX: number;
      deltaY: number;
      speed: number;
    },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.swipe(page.adapterSession, input);
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastActionAt: nowIso(),
      lastActionKind: "act.swipe",
      lastObservationAt: nowIso(),
      lastObservationKind: "act.swipe",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async pinch(
    sessionId: string,
    pageId: string | undefined,
    input: {
      selector?: string;
      centerX?: number;
      centerY?: number;
      scaleFactor: number;
      speed: number;
    },
  ) {
    const { session, page } = this.getPage(sessionId, pageId);
    const result = await this.deps.adapter.pinch(page.adapterSession, input);
    this.updatePage(session.sessionId, page.pageId, {
      url: result.url,
      title: result.title,
      lastActionAt: nowIso(),
      lastActionKind: "act.pinch",
      lastObservationAt: nowIso(),
      lastObservationKind: "act.pinch",
    });
    return { session, page: this.getPage(sessionId, page.pageId).page, result };
  }

  async closeSession(sessionId: string) {
    const session = this.getSession(sessionId);
    session.status = "closing";
    await this.deps.adapter.closeSession(session.adapterSession);
    session.status = "closed";
    for (const [pageId, page] of session.pages) {
      session.pages.set(pageId, { ...page, status: "closed", updatedAt: nowIso() });
    }
    this.sessions.set(sessionId, session);
    if (session.userDataDir) {
      this.activeUserDataDirs.delete(session.userDataDir);
    }
    this.writeRegistry();
    return session;
  }
}
