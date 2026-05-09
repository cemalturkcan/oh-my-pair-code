import path from "node:path";
import type { BrowserContext, Frame, Locator, Page } from "playwright-core";
import { launchContext, launchPersistentContext } from "cloakbrowser";
import type { WebAgentEnv } from "../../config/env.js";
import { createId } from "../../utils/ids.js";
import { elapsedMs, nowIso } from "../../utils/time.js";
import type {
  AdapterA11yResult,
  AdapterAuthStateResult,
  AdapterConsoleEntry,
  AdapterDomResult,
  AdapterElementBox,
  AdapterEvaluateResult,
  AdapterNetworkEntry,
  AdapterNavigationResult,
  AdapterPageIdentity,
  AdapterPageStateResult,
  AdapterScreenshotResult,
  AdapterSessionCreateInput,
  AdapterSessionHandle,
  AdapterTextResult,
  AdapterWaitForNetworkResult,
  CloakBrowserAdapter,
  WaitUntilState,
} from "./adapter.js";
import {
  classifyAuthStateSnapshot,
  normalizeAuthText,
  type AuthFrameInspection,
} from "./auth-heuristics.js";

function truncateText(text: string, maxChars = 12000) {
  if (text.length <= maxChars) {
    return { content: text, truncated: false };
  }

  return {
    content: text.slice(0, maxChars),
    truncated: true,
  };
}

function pushLimited<T>(items: T[], value: T, maxSize = 200) {
  items.push(value);
  if (items.length > maxSize) {
    items.splice(0, items.length - maxSize);
  }
}

function normalizeWhitespace(text: string) {
  return normalizeAuthText(text);
}

function consoleBridgeSource(bridgeName: string) {
  return String.raw`(() => {
  const globalWindow = window;
  const bridgeName = ${JSON.stringify(bridgeName)};
  globalWindow.__webAgentMcpConsoleBuffer ||= [];
  if (globalWindow.__webAgentMcpConsoleInstalled) return;
  globalWindow.__webAgentMcpConsoleInstalled = true;
  ["log", "info", "warn", "error", "debug"].forEach((type) => {
    const original = console[type]?.bind(console);
    if (!original) return;
    console[type] = (...args) => {
      try {
        const entry = {
          type,
          text: args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "),
        };
        globalWindow.__webAgentMcpConsoleBuffer.push(entry);
        globalWindow[bridgeName]?.({
          type: entry.type,
          text: entry.text,
        });
      } catch {
        // Preserve page behavior if the bridge cannot serialize a log.
      }
      original(...args);
    };
  });
})()`;
}

function consoleBridgeName(pageId: string) {
  return `__webAgentMcpConsole_${pageId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

async function installConsoleBridge(page: AdapterSessionHandle["page"], pageId: string) {
  await page.evaluate?.(consoleBridgeSource(consoleBridgeName(pageId))).catch(() => undefined);
}

async function drainConsoleBridgeBuffer(
  page: AdapterSessionHandle["page"],
  consoleEntries: AdapterConsoleEntry[],
) {
  const entries = await page.evaluate?.(String.raw`(() => {
    const buffered = window.__webAgentMcpConsoleBuffer ?? [];
    window.__webAgentMcpConsoleBuffer = [];
    return buffered;
  })()`).catch(() => []) ?? [];
  for (const entry of entries as Array<{ type?: string; text?: string }>) {
    if (entry?.text) {
      pushLimited(consoleEntries, {
        type: entry.type ?? "log",
        text: entry.text,
        timestamp: nowIso(),
      });
    }
  }
}

async function attachEventBuffers(
  page: AdapterSessionHandle["page"],
  pageId: string,
  consoleEntries: AdapterConsoleEntry[],
  networkEntries: AdapterNetworkEntry[],
) {
  page.on("console", (message) => {
    pushLimited(consoleEntries, {
      type: message.type(),
      text: message.text(),
      location: message.location(),
      timestamp: nowIso(),
    });
  });

  page.on("response", (response) => {
    const request = response.request();
    pushLimited(networkEntries, {
      url: response.url(),
      method: request.method(),
      status: response.status(),
      resourceType: request.resourceType(),
      outcome: "response",
      timestamp: nowIso(),
    });
  });

  page.on("requestfailed", (request) => {
    pushLimited(networkEntries, {
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      outcome: "failed",
      failureText: request.failure()?.errorText,
      timestamp: nowIso(),
    });
  });

  const bridgeName = consoleBridgeName(pageId);
  await page.exposeFunction?.(bridgeName, (entry: { type: string; text: string }) => {
    pushLimited(consoleEntries, {
      type: entry.type,
      text: entry.text,
      timestamp: nowIso(),
    });
  }).catch(() => undefined);
  await page.addInitScript?.({ content: consoleBridgeSource(bridgeName) }).catch(() => undefined);
  await installConsoleBridge(page, pageId);
}

class RunPageScriptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`runtime.run_page_script timed out after ${timeoutMs}ms; the page was replaced to stop the script`);
    this.name = "RunPageScriptTimeoutError";
  }
}

async function withCleanupTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`cleanup timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function createPage(context: BrowserContext) {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
}

type InspectableTarget = Page | Frame;

type DocumentInspection = {
  title?: string;
  text: string;
  truncated: boolean;
  dom: AdapterDomResult["summary"];
  inputs: AdapterPageStateResult["inputs"];
  buttons: AdapterPageStateResult["buttons"];
};

async function inspectDocument(
  target: InspectableTarget,
): Promise<DocumentInspection> {
  const snapshot = await target.evaluate(String.raw`(() => {
    const normalize = (value) =>
      value?.replace(/\s+/g, " ").trim() || undefined;
    const isVisible = (element) => {
      const html = element;
      return Boolean(
        html.offsetWidth || html.offsetHeight || html.getClientRects().length,
      );
    };
    const summarizeElement = (element) => ({
      tag: element.tagName.toLowerCase(),
      type: element.type || undefined,
      id: element.id || undefined,
      name: element.getAttribute("name") || undefined,
      placeholder: element.getAttribute("placeholder") || undefined,
      text: normalize(element.textContent),
      autocomplete: element.getAttribute("autocomplete") || undefined,
      visible: isVisible(element),
    });

    const text = (document.body?.innerText ?? "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((node) => normalize(node.textContent))
      .filter((value) => Boolean(value))
      .slice(0, 20);

    return {
      title: document.title || undefined,
      text,
      dom: {
        headings,
        links: document.querySelectorAll("a[href]").length,
        buttons: document.querySelectorAll("button").length,
        forms: document.querySelectorAll("form").length,
        inputs: document.querySelectorAll("input, textarea, select").length,
      },
      inputs: Array.from(document.querySelectorAll("input, textarea, select"))
        .slice(0, 20)
        .map(summarizeElement),
      buttons: Array.from(document.querySelectorAll("button, [role='button']"))
        .slice(0, 20)
        .map(summarizeElement),
    };
  })()`) as Omit<DocumentInspection, "truncated">;

  const truncated = truncateText(snapshot.text, 4000);

  return {
    title: snapshot.title,
    text: truncated.content,
    truncated: truncated.truncated,
    dom: snapshot.dom,
    inputs: snapshot.inputs,
    buttons: snapshot.buttons,
  };
}

async function inspectFrames(page: Page) {
  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  const summaries = await Promise.all(
    frames.map(async (frame: Frame, index) => {
      try {
        const snapshot = await inspectDocument(frame);
        return {
          index,
          name: frame.name() || undefined,
          url: frame.url(),
          title: snapshot.title,
          text_preview: snapshot.text,
          truncated: snapshot.truncated,
          input_count: snapshot.inputs.length,
          button_count: snapshot.buttons.length,
        };
      } catch {
        return {
          index,
          name: frame.name() || undefined,
          url: frame.url(),
          title: undefined,
          text_preview: "",
          truncated: false,
          input_count: 0,
          button_count: 0,
        };
      }
    }),
  );

  return summaries;
}

async function inspectAuthFrames(page: Page): Promise<AuthFrameInspection[]> {
  const frames = page.frames().filter((frame) => frame !== page.mainFrame());

  return Promise.all(
    frames.map(async (frame: Frame, index) => {
      try {
        const snapshot = await inspectDocument(frame);
        return {
          index,
          name: frame.name() || undefined,
          url: frame.url(),
          title: snapshot.title,
          text: snapshot.text,
          inputs: snapshot.inputs,
          buttons: snapshot.buttons,
        };
      } catch {
        return {
          index,
          name: frame.name() || undefined,
          url: frame.url(),
          title: undefined,
          text: "",
          inputs: [],
          buttons: [],
        };
      }
    }),
  );
}

function matchNetworkEntry(
  entry: AdapterNetworkEntry,
  input: {
    urlPattern: string;
    useRegex: boolean;
    status?: number;
    outcome?: AdapterNetworkEntry["outcome"];
  },
) {
  const urlMatches = input.useRegex
    ? new RegExp(input.urlPattern).test(entry.url)
    : entry.url.includes(input.urlPattern);

  return (
    urlMatches &&
    (input.status === undefined || entry.status === input.status) &&
    (input.outcome === undefined || entry.outcome === input.outcome)
  );
}

function resolveLocator(page: Page, selector: string, frameSelector?: string) {
  if (frameSelector) {
    return page.frameLocator(frameSelector).locator(selector);
  }
  return page.locator(selector);
}

async function getEditableMeta(locator: ReturnType<Page["locator"]>) {
  return locator.first().evaluate((element) => {
    const html = element as HTMLElement;
    const input = element as HTMLInputElement;
    return {
      tag: element.tagName.toLowerCase(),
      isEditable: html.isContentEditable || element.matches("input, textarea"),
      maxLength: typeof input.maxLength === "number" ? input.maxLength : -1,
      type: input.type || undefined,
    };
  });
}

function isFrameScopedSelector(selector: string) {
  return (
    selector.includes("internal:control=enter-frame") ||
    /(^|\s|>)iframe[.#\[:]/i.test(selector)
  );
}

async function readEditableValue(locator: Locator) {
  return locator.first().evaluate((element) => {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      return element.value;
    }

    if (element instanceof HTMLElement && element.isContentEditable) {
      return element.innerText ?? element.textContent ?? "";
    }

    return undefined;
  });
}

async function setEditableValueWithDomFallback(
  locator: Locator,
  value: string,
) {
  await locator.first().evaluate((element, nextValue) => {
    const dispatch = (target: HTMLElement) => {
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.dispatchEvent(new Event("blur", { bubbles: true }));
    };

    if (element instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(element, nextValue);
      dispatch(element);
      return;
    }

    if (element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(element, nextValue);
      dispatch(element);
      return;
    }

    if (element instanceof HTMLSelectElement) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )?.set;
      setter?.call(element, nextValue);
      dispatch(element);
      return;
    }

    if (element instanceof HTMLElement && element.isContentEditable) {
      element.textContent = nextValue;
      dispatch(element);
    }
  }, value);
}

function matchesFilledValue(
  actual: string | undefined,
  expected: string,
  appendedText?: string,
) {
  if (actual === expected) {
    return true;
  }

  if (actual && appendedText && actual.endsWith(appendedText)) {
    return true;
  }

  return normalizeWhitespace(actual ?? "") === normalizeWhitespace(expected);
}

type ClickStateSnapshot = {
  pageUrl: string;
  connected: boolean;
  tag?: string;
  type?: string;
  role?: string;
  disabled?: boolean;
  checked?: boolean;
  ariaPressed?: string;
  ariaExpanded?: string;
  text?: string;
  value?: string;
};

async function captureClickState(
  page: Page,
  locator: Locator,
): Promise<ClickStateSnapshot> {
  const elementState = await locator
    .first()
    .evaluate((element) => {
      const input = element as HTMLInputElement;
      return {
        connected: element.isConnected,
        tag: element.tagName.toLowerCase(),
        type: input.type || undefined,
        role: element.getAttribute("role") || undefined,
        disabled: "disabled" in input ? Boolean(input.disabled) : undefined,
        checked: "checked" in input ? Boolean(input.checked) : undefined,
        ariaPressed: element.getAttribute("aria-pressed") || undefined,
        ariaExpanded: element.getAttribute("aria-expanded") || undefined,
        text: normalizeAuthText(element.textContent ?? undefined) || undefined,
        value:
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
            ? element.value
            : undefined,
      };
    })
    .catch(() => ({ connected: false }));

  return {
    pageUrl: page.url(),
    ...elementState,
  };
}

function didClickCauseProgress(
  before: ClickStateSnapshot,
  after: ClickStateSnapshot,
) {
  return (
    before.pageUrl !== after.pageUrl ||
    before.connected !== after.connected ||
    before.disabled !== after.disabled ||
    before.checked !== after.checked ||
    before.ariaPressed !== after.ariaPressed ||
    before.ariaExpanded !== after.ariaExpanded ||
    before.text !== after.text ||
    before.value !== after.value
  );
}

function changedClickStateFields(
  before: ClickStateSnapshot,
  after: ClickStateSnapshot,
) {
  const fields: Array<keyof ClickStateSnapshot> = [
    "pageUrl",
    "connected",
    "disabled",
    "checked",
    "ariaPressed",
    "ariaExpanded",
    "text",
    "value",
  ];
  return fields.filter((field) => before[field] !== after[field]);
}

async function capturePageIdentity(page: Page) {
  return {
    url: page.url(),
    title: await page.title(),
  };
}

async function getInputType(locator: Locator) {
  return locator
    .first()
    .evaluate((element) => {
      if (element instanceof HTMLInputElement) {
        return element.type || undefined;
      }
      if (element instanceof HTMLTextAreaElement) {
        return "textarea";
      }
      if (element instanceof HTMLSelectElement) {
        return "select";
      }
      if (element instanceof HTMLElement && element.isContentEditable) {
        return "contenteditable";
      }
      return undefined;
    })
    .catch(() => undefined);
}

async function canUseDomClickFallback(locator: Locator) {
  return locator
    .first()
    .evaluate((element) => {
      const tag = element.tagName.toLowerCase();
      const type = (element as HTMLInputElement).type?.toLowerCase();
      const role = element.getAttribute("role")?.toLowerCase();

      return (
        tag === "button" ||
        tag === "a" ||
        role === "button" ||
        (tag === "input" &&
          ["button", "submit", "checkbox", "radio"].includes(type ?? ""))
      );
    })
    .catch(() => false);
}

async function triggerDomClick(locator: Locator) {
  await locator.first().evaluate((element) => {
    if (element instanceof HTMLElement) {
      element.click();
    }
  });
}

async function resolveCodeTargets(page: Page, selector: string) {
  const direct = page.locator(selector);
  const directCount = await direct.count().catch(() => 0);

  if (directCount > 1) {
    return direct;
  }

  if (directCount === 1) {
    const meta = await getEditableMeta(direct);
    if (meta.isEditable) {
      return direct;
    }
  }

  const nested = page.locator(
    `${selector} input, ${selector} textarea, ${selector} [contenteditable='true']`,
  );
  const nestedCount = await nested.count().catch(() => 0);
  if (nestedCount > 0) {
    return nested;
  }

  return direct;
}

async function getElementCenter(
  page: AdapterSessionHandle["page"],
  selector: string,
) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    throw new Error(
      `Unable to resolve visible bounding box for selector: ${selector}`,
    );
  }

  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

class PlaywrightCloakBrowserAdapter implements CloakBrowserAdapter {
  constructor(private readonly env: WebAgentEnv) {}

  async createSession(
    input: AdapterSessionCreateInput,
  ): Promise<AdapterSessionHandle> {
    if (input.profileMode === "persistent") {
      const context = await launchPersistentContext({
        userDataDir:
          input.userDataDir ?? path.join(this.env.profilesDir, input.sessionId),
        headless: this.env.headless,
        locale: input.locale,
        timezone: input.timezoneId,
        humanize: input.humanize,
        args: input.launchArgs,
        viewport: input.viewport,
      });
      const page = await createPage(context);
      const pageId = createId("page");
      const consoleEntries: AdapterConsoleEntry[] = [];
      const networkEntries: AdapterNetworkEntry[] = [];
      await attachEventBuffers(page, pageId, consoleEntries, networkEntries);
      return {
        contextId: createId("context"),
        pageId,
        context,
        page,
        profileMode: input.profileMode,
        locale: input.locale,
        viewport: input.viewport,
        consoleEntries,
        networkEntries,
      };
    }

    const context = await launchContext({
      headless: this.env.headless,
      locale: input.locale,
      timezone: input.timezoneId,
      humanize: input.humanize,
      args: input.launchArgs,
      viewport: input.viewport,
    });
    const page = await context.newPage();
    const pageId = createId("page");
    const consoleEntries: AdapterConsoleEntry[] = [];
    const networkEntries: AdapterNetworkEntry[] = [];
    await attachEventBuffers(page, pageId, consoleEntries, networkEntries);
    return {
      contextId: createId("context"),
      pageId,
      context,
      page,
      profileMode: input.profileMode,
      locale: input.locale,
      viewport: input.viewport,
      consoleEntries,
      networkEntries,
    };
  }

  async closeSession(session: AdapterSessionHandle) {
    await session.context.close();
  }

  async createPage(session: AdapterSessionHandle): Promise<AdapterSessionHandle> {
    const page = await session.context.newPage();
    const pageId = createId("page");
    const consoleEntries: AdapterConsoleEntry[] = [];
    const networkEntries: AdapterNetworkEntry[] = [];
    await attachEventBuffers(page, pageId, consoleEntries, networkEntries);
    return {
      ...session,
      pageId,
      page,
      consoleEntries,
      networkEntries,
    };
  }

  async closePage(session: AdapterSessionHandle) {
    await session.page.close();
  }

  async listPages(session: AdapterSessionHandle): Promise<AdapterPageIdentity[]> {
    return Promise.all(
      session.context.pages().map(async (page) => ({
        pageId: page === session.page ? session.pageId : createId("page"),
        url: page.url(),
        title: page.isClosed() ? undefined : await page.title().catch(() => undefined),
        closed: page.isClosed(),
        viewport: page.viewportSize() ?? session.viewport,
      })),
    );
  }

  async navigate(
    session: AdapterSessionHandle,
    url: string,
    waitUntil: WaitUntilState,
  ): Promise<AdapterNavigationResult> {
    const startedAt = Date.now();
    const before = await capturePageIdentity(session.page);
    await session.page.goto(url, { waitUntil });
    await installConsoleBridge(session.page, session.pageId);
    const waitDescriptions: Record<WaitUntilState, string> = {
      domcontentloaded: "Playwright page.goto waited for DOMContentLoaded.",
      load: "Playwright page.goto waited for the load event.",
      networkidle:
        "Playwright page.goto waited for networkidle: no network connections for at least 500ms. This is visible because it can be slower and is discouraged as a default readiness check; prefer explicit selector/text/network waits.",
    };
    return {
      pageId: session.pageId,
      requestedUrl: url,
      finalUrl: session.page.url(),
      title: await session.page.title(),
      elapsedMs: elapsedMs(startedAt),
      waitUntil,
      waitDescription: waitDescriptions[waitUntil],
      networkidleDiscouraged: waitUntil === "networkidle" ? true : undefined,
      before,
    };
  }

  async observeA11y(session: AdapterSessionHandle): Promise<AdapterA11yResult> {
    const tree = await session.page.evaluate(() => {
      const selector =
        "a, button, input, textarea, select, [role], [aria-label], [aria-labelledby], h1, h2, h3";
      const children = Array.from(document.querySelectorAll(selector))
        .slice(0, 200)
        .map((element) => ({
          role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
          name:
            element.getAttribute("aria-label") ??
            element.textContent?.replace(/\s+/g, " ").trim() ??
            undefined,
          tag: element.tagName.toLowerCase(),
          text: element.textContent?.replace(/\s+/g, " ").trim() ?? undefined,
        }));

      return {
        role: "document",
        name: document.title || undefined,
        children,
      };
    });
    return {
      url: session.page.url(),
      title: await session.page.title(),
      tree,
    };
  }

  async observeDom(session: AdapterSessionHandle): Promise<AdapterDomResult> {
    const summary = await session.page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
        .map((node) => node.textContent?.trim())
        .filter((value): value is string => Boolean(value))
        .slice(0, 20);

      return {
        headings,
        links: document.querySelectorAll("a[href]").length,
        buttons: document.querySelectorAll("button").length,
        forms: document.querySelectorAll("form").length,
        inputs: document.querySelectorAll("input, textarea, select").length,
      };
    });

    return {
      url: session.page.url(),
      title: await session.page.title(),
      summary,
    };
  }

  async observeText(
    session: AdapterSessionHandle,
    format: "text" | "markdown",
  ): Promise<AdapterTextResult> {
    const rawText = await session.page.evaluate(
      () => document.body?.innerText ?? "",
    );
    const normalizedText = rawText.replace(/\n{3,}/g, "\n\n").trim();
    const truncated = truncateText(normalizedText);

    return {
      url: session.page.url(),
      title: await session.page.title(),
      format,
      content: truncated.content,
      truncated: truncated.truncated,
    };
  }

  async inspectPageState(
    session: AdapterSessionHandle,
    recentNetworkLimit: number,
  ): Promise<AdapterPageStateResult> {
    const mainDocument = await inspectDocument(session.page);
    const frames = await inspectFrames(session.page);

    return {
      url: session.page.url(),
      title: await session.page.title(),
      text: mainDocument.text,
      truncated: mainDocument.truncated,
      dom: mainDocument.dom,
      inputs: mainDocument.inputs,
      buttons: mainDocument.buttons,
      frames,
      recentNetwork: session.networkEntries.slice(-recentNetworkLimit),
    };
  }

  async inspectAuthState(
    session: AdapterSessionHandle,
    recentNetworkLimit: number,
  ): Promise<AdapterAuthStateResult> {
    const mainDocument = await inspectDocument(session.page);
    const frameInspections = await inspectAuthFrames(session.page);
    const frames = frameInspections.map((frame) => ({
      index: frame.index,
      name: frame.name,
      url: frame.url,
      title: frame.title,
      text_preview: frame.text,
      truncated: false,
      input_count: frame.inputs.length,
      button_count: frame.buttons.length,
    }));
    const recentNetwork = session.networkEntries.slice(-recentNetworkLimit);
    const classified = classifyAuthStateSnapshot({
      pageUrl: session.page.url(),
      pageTitle: await session.page.title(),
      pageText: mainDocument.text,
      pageInputs: mainDocument.inputs,
      pageButtons: mainDocument.buttons,
      frames: frameInspections,
      recentNetwork,
    });

    return {
      url: session.page.url(),
      title: await session.page.title(),
      state: classified.state,
      confidence: classified.confidence,
      summary: classified.summary,
      evidence: classified.evidence,
      suggestedSelectors: classified.suggestedSelectors,
      frames,
      recentNetwork,
    };
  }

  async takeScreenshot(
    session: AdapterSessionHandle,
    mode: "viewport" | "full" | "element",
    format: "png" | "jpeg",
    quality?: number,
    selector?: string,
  ): Promise<AdapterScreenshotResult> {
    const screenshotOptions = {
      type: format,
      quality: format === "png" ? undefined : quality,
    } as const;

    if (mode === "element") {
      const locator = session.page.locator(selector ?? "").first();
      const box = await locator.boundingBox();
      const bytes = await locator.screenshot(screenshotOptions);
      return {
        url: session.page.url(),
        title: await session.page.title(),
        bytes,
        mimeType: format === "png" ? "image/png" : "image/jpeg",
        width: box?.width,
        height: box?.height,
      };
    }

    const bytes = await session.page.screenshot({
      fullPage: mode === "full",
      ...screenshotOptions,
    });
    const viewport = session.page.viewportSize() ?? session.viewport;
    return {
      url: session.page.url(),
      title: await session.page.title(),
      bytes,
      mimeType: format === "png" ? "image/png" : "image/jpeg",
      width: viewport.width,
      height: viewport.height,
    };
  }

  async resizePage(
    session: AdapterSessionHandle,
    input: { width: number; height: number; deviceScaleFactor?: number; isMobile?: boolean },
  ) {
    const before = session.page.viewportSize() ?? session.viewport;
    await session.page.setViewportSize({ width: input.width, height: input.height });
    session.viewport = { width: input.width, height: input.height };
    if (input.deviceScaleFactor !== undefined || input.isMobile !== undefined) {
      await session.page.addInitScript(({ deviceScaleFactor, isMobile }) => {
        Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: deviceScaleFactor ?? window.devicePixelRatio });
        Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: isMobile ? 1 : 0 });
      }, { deviceScaleFactor: input.deviceScaleFactor, isMobile: input.isMobile });
    }
    return {
      before,
      viewport: session.page.viewportSize() ?? session.viewport,
      deviceScaleFactor: input.deviceScaleFactor,
      isMobile: input.isMobile,
    };
  }

  async observeBoxes(
    session: AdapterSessionHandle,
    selectors: string[],
  ): Promise<AdapterElementBox[]> {
    const boxes = await Promise.all(
      selectors.map(async (selector) => {
        const locator = session.page.locator(selector).first();
        const box = await locator.boundingBox();
        return {
          selector,
          x: box?.x ?? 0,
          y: box?.y ?? 0,
          width: box?.width ?? 0,
          height: box?.height ?? 0,
          visible: Boolean(box),
        };
      }),
    );

    return boxes;
  }

  async observeConsole(
    session: AdapterSessionHandle,
    limit: number,
  ): Promise<AdapterConsoleEntry[]> {
    await installConsoleBridge(session.page, session.pageId);
    await session.page.waitForTimeout(50).catch(() => undefined);
    await drainConsoleBridgeBuffer(session.page, session.consoleEntries);
    return session.consoleEntries.slice(-limit);
  }

  async observeNetwork(
    session: AdapterSessionHandle,
    limit: number,
  ): Promise<AdapterNetworkEntry[]> {
    return session.networkEntries.slice(-limit);
  }

  async waitForNetwork(
    session: AdapterSessionHandle,
    input: {
      urlPattern: string;
      useRegex: boolean;
      status?: number;
      outcome?: AdapterNetworkEntry["outcome"];
      timeoutMs: number;
      pollIntervalMs: number;
    },
  ): Promise<AdapterWaitForNetworkResult> {
    const startedAt = Date.now();
    const existingMatch = [...session.networkEntries]
      .reverse()
      .find((entry) => matchNetworkEntry(entry, input));

    if (existingMatch) {
      return {
        url: session.page.url(),
        title: await session.page.title(),
        entry: existingMatch,
        elapsedMs: elapsedMs(startedAt),
      };
    }

    while (Date.now() - startedAt <= input.timeoutMs) {
      const match = [...session.networkEntries]
        .reverse()
        .find((entry) => matchNetworkEntry(entry, input));
      if (match) {
        return {
          url: session.page.url(),
          title: await session.page.title(),
          entry: match,
          elapsedMs: elapsedMs(startedAt),
        };
      }

      await session.page.waitForTimeout(input.pollIntervalMs);
    }

    throw new Error(
      `Timed out waiting for network entry matching ${input.urlPattern}`,
    );
  }

  async evaluateJs(
    session: AdapterSessionHandle,
    input: { expression: string; awaitPromise: boolean },
  ): Promise<AdapterEvaluateResult> {
    const value = await session.page.evaluate(String.raw`(async () => {
      const { expression, awaitPromise } = ${JSON.stringify(input)};
        const seen = new WeakSet();

        const normalize = (current) => {
          if (current === null || current === undefined) {
            return current;
          }

          const currentType = typeof current;

          if (
            currentType === "string" ||
            currentType === "number" ||
            currentType === "boolean"
          ) {
            return current;
          }

          if (currentType === "bigint") {
            return { __type: "bigint", value: String(current) };
          }

          if (currentType === "function") {
            return { __type: "function" };
          }

          if (Array.isArray(current)) {
            return current.map((item) => normalize(item));
          }

          if (current instanceof Date) {
            return { __type: "date", value: current.toISOString() };
          }

          if (current instanceof Error) {
            return {
              __type: "error",
              name: current.name,
              message: current.message,
            };
          }

          if (current instanceof Element) {
            return {
              __type: "element",
              tag: current.tagName.toLowerCase(),
              id: current.id || undefined,
              text:
                current.textContent
                  ?.replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 500) || undefined,
            };
          }

          if (currentType === "object") {
            const objectValue = current;
            if (seen.has(objectValue)) {
              return { __type: "circular" };
            }
            seen.add(objectValue);

            const normalizedEntries = Object.entries(objectValue).map(
              ([key, value]) => [key, normalize(value)],
            );
            return Object.fromEntries(normalizedEntries);
          }

          return { __type: currentType };
        };

        const executed = (0, eval)(expression);
        const resolved = awaitPromise ? await executed : executed;
        return normalize(resolved);
    })()`);

    return {
      url: session.page.url(),
      title: await session.page.title(),
      value,
    };
  }

  async runPageScript(
    session: AdapterSessionHandle,
    input: { script: string; timeoutMs: number },
  ) {
    const startedAt = Date.now();
    const before = await capturePageIdentity(session.page);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const evaluation = session.page.evaluate(String.raw`(async () => {
        const script = ${JSON.stringify(input.script)};
        const timeoutMs = ${JSON.stringify(input.timeoutMs)};
        const seen = new WeakSet();

        const normalize = (current) => {
          if (current === null || current === undefined) return current;
          const currentType = typeof current;
          if (currentType === "string" || currentType === "number" || currentType === "boolean") return current;
          if (currentType === "bigint") return { __type: "bigint", value: String(current) };
          if (currentType === "function") return { __type: "function" };
          if (Array.isArray(current)) return current.map((item) => normalize(item));
          if (current instanceof Date) return { __type: "date", value: current.toISOString() };
          if (current instanceof Error) return { __type: "error", name: current.name, message: current.message };
          if (current instanceof Element) {
            return {
              __type: "element",
              tag: current.tagName.toLowerCase(),
              id: current.id || undefined,
              text: current.textContent?.replace(/\s+/g, " ").trim().slice(0, 500) || undefined,
            };
          }
          if (currentType === "object") {
            const objectValue = current;
            if (seen.has(objectValue)) return { __type: "circular" };
            seen.add(objectValue);
            return Object.fromEntries(Object.entries(objectValue).map(([key, entry]) => [key, normalize(entry)]));
          }
          return { __type: currentType };
        };

        const query = (selector) => document.querySelector(selector);
        const waitFor = async (target, timeout = timeoutMs) => {
          const started = Date.now();
          while (Date.now() - started <= Math.min(timeout, timeoutMs)) {
            const matched = typeof target === "string" ? query(target) : await target();
            if (matched) return matched;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error("Timed out waiting for " + (typeof target === "string" ? target : "predicate"));
        };
        const setValue = (selector, value) => {
          const element = query(selector);
          if (!element) throw new Error("Selector not found: " + selector);
          element.value = value;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        };

        const helpers = Object.freeze({
          text: (selector) => query(selector)?.textContent?.trim() ?? null,
          value: (selector) => query(selector)?.value ?? null,
          setValue,
          click: (selector) => {
            const element = query(selector);
            if (!element) throw new Error("Selector not found: " + selector);
            element.click();
            return true;
          },
          exists: (selector) => Boolean(query(selector)),
          waitFor,
          assert: (condition, message = "Assertion failed") => {
            if (!condition) throw new Error(message);
            return true;
          },
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, timeoutMs))),
          json: (value) => value,
          page: () => ({ url: location.href, title: document.title }),
        });

        const blockedGlobal = undefined;
        const runner = new Function(
          "helpers",
          "Function",
          "require",
          "process",
          "fs",
          "child_process",
          "Deno",
          "Bun",
          "globalThis",
          "window",
          "self",
          "top",
          "frames",
          "\"use strict\"; return (async () => { " + script + "\n})()",
        );
        const execution = Promise.resolve(
          runner(
            helpers,
            blockedGlobal,
            blockedGlobal,
            blockedGlobal,
            blockedGlobal,
            blockedGlobal,
            blockedGlobal,
            blockedGlobal,
            blockedGlobal,
            blockedGlobal,
            blockedGlobal,
            blockedGlobal,
            blockedGlobal,
          ),
        );
        const timeout = new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("runtime.run_page_script timed out after " + timeoutMs + "ms")), timeoutMs),
        );
        return normalize(await Promise.race([execution, timeout]));
      })()`);
    const timeoutGuard = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new RunPageScriptTimeoutError(input.timeoutMs)), input.timeoutMs);
    });

    let value: unknown;
    try {
      value = await Promise.race([evaluation, timeoutGuard]);
    } catch (error) {
      if (error instanceof RunPageScriptTimeoutError) {
        evaluation.catch(() => undefined);
        try {
          await withCleanupTimeout(session.page.close({ runBeforeUnload: false }), Math.min(1000, input.timeoutMs));
        } finally {
          const page = await withCleanupTimeout(session.context.newPage(), Math.min(1000, input.timeoutMs));
          await attachEventBuffers(page, session.pageId, session.consoleEntries, session.networkEntries);
          session.page = page;
        }
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const after = await capturePageIdentity(session.page);

    return {
      before,
      after,
      elapsedMs: elapsedMs(startedAt),
      value,
    };
  }

  async injectCss(
    session: AdapterSessionHandle,
    input: { cssId: string; css: string },
  ) {
    const content = `/* web-agent-mcp css_id=${input.cssId} */\n${input.css}`;
    await session.page.addStyleTag({ content }).then(async (handle) => {
      await handle.evaluate((element, cssId) => {
        (element as HTMLElement).setAttribute("data-web-agent-css-id", cssId);
      }, input.cssId);
    });
    return { cssId: input.cssId, bytes: Buffer.byteLength(input.css, "utf8") };
  }

  async removeCss(
    session: AdapterSessionHandle,
    input: { cssId: string },
  ) {
    const removed = await session.page.evaluate((cssId) => {
      const nodes = document.querySelectorAll(`style[data-web-agent-css-id="${CSS.escape(cssId)}"]`);
      nodes.forEach((node) => node.remove());
      return nodes.length > 0;
    }, input.cssId);
    return { removed };
  }

  async click(
    session: AdapterSessionHandle,
    input: {
      selector: string;
      frameSelector?: string;
      button: "left" | "right" | "middle";
      clickCount: number;
      timeoutMs?: number;
    },
  ) {
    const startedAt = Date.now();
    const beforePage = await capturePageIdentity(session.page);
    const locator = resolveLocator(
      session.page,
      input.selector,
      input.frameSelector,
    ).first();
    const before = await captureClickState(session.page, locator);
    let usedDomFallback = false;

    try {
      await locator.click({
        button: input.button,
        clickCount: input.clickCount,
        timeout: input.timeoutMs,
      });
    } catch (error) {
      if (
        !isFrameScopedSelector(input.selector) ||
        !(await canUseDomClickFallback(locator))
      ) {
        throw error;
      }

      await triggerDomClick(locator);
      usedDomFallback = true;
    }

    const after = await captureClickState(session.page, locator);

    if (
      !usedDomFallback &&
      !didClickCauseProgress(before, after) &&
      isFrameScopedSelector(input.selector) &&
      (await canUseDomClickFallback(locator))
    ) {
      await triggerDomClick(locator);
      usedDomFallback = true;
    }

    const finalState = await captureClickState(session.page, locator);
    const changed = changedClickStateFields(before, finalState);
    const afterPage = await capturePageIdentity(session.page);
    const observableChange = changed.length > 0 || beforePage.title !== afterPage.title;

    return {
      url: session.page.url(),
      title: afterPage.title,
      verificationHint: usedDomFallback
        ? `Clicked selector ${input.selector} with DOM fallback verification`
        : `Clicked selector ${input.selector}`,
      elapsedMs: elapsedMs(startedAt),
      waitedFor: [
        "Playwright locator.click auto-waited for element actionability and any initiated navigation.",
        "Post-click state probe captured immediate URL/title/target state without an unconditional fixed delay.",
      ],
      before: beforePage,
      after: afterPage,
      postAction: {
        observableChange,
        usedDomFallback,
        changed,
        guidance: observableChange
          ? undefined
          : "No URL/title/target-state change was observed after the click. If an app effect was expected, follow with observe_text, observe_dom, observe_network, or an explicit wait_for selector/text.",
      },
    };
  }

  async fill(
    session: AdapterSessionHandle,
    input: {
      selector: string;
      frameSelector?: string;
      value: string;
      clearFirst: boolean;
      timeoutMs?: number;
    },
  ) {
    const startedAt = Date.now();
    const beforePage = await capturePageIdentity(session.page);
    const locator = resolveLocator(
      session.page,
      input.selector,
      input.frameSelector,
    ).first();
    const initialValue = await readEditableValue(locator).catch(
      () => undefined,
    );
    const inputType = await getInputType(locator);
    await locator.fill(
      input.clearFirst ? "" : await locator.inputValue().catch(() => ""),
      {
        timeout: input.timeoutMs,
      },
    );
    if (input.clearFirst) {
      await locator.fill(input.value, { timeout: input.timeoutMs });
    } else {
      await locator.pressSequentially(input.value, {
        timeout: input.timeoutMs,
      });
    }
    const expectedValue = input.clearFirst
      ? input.value
      : `${initialValue ?? ""}${input.value}`;
    let usedDomFallback = false;
    const currentValue = await readEditableValue(locator).catch(
      () => undefined,
    );

    if (
      !matchesFilledValue(
        currentValue,
        expectedValue,
        input.clearFirst ? undefined : input.value,
      )
    ) {
      await setEditableValueWithDomFallback(locator, expectedValue);
      const verifiedValue = await readEditableValue(locator).catch(
        () => undefined,
      );

      if (
        !matchesFilledValue(
          verifiedValue,
          expectedValue,
          input.clearFirst ? undefined : input.value,
        )
      ) {
        throw new Error(
          `Failed to persist value for selector ${input.selector}`,
        );
      }

      usedDomFallback = true;
    }

    const finalValue = await readEditableValue(locator).catch(() => undefined);
    const matchesRequestedValue = matchesFilledValue(
      finalValue,
      expectedValue,
      input.clearFirst ? undefined : input.value,
    );
    const afterPage = await capturePageIdentity(session.page);

    return {
      url: session.page.url(),
      title: afterPage.title,
      verificationHint: usedDomFallback
        ? `Filled selector ${input.selector} with DOM persistence fallback`
        : `Filled selector ${input.selector}`,
      elapsedMs: elapsedMs(startedAt),
      waitedFor: [
        "Playwright locator.fill/pressSequentially auto-waited for element actionability.",
        "Read back editable value after fill without returning the raw value.",
      ],
      before: beforePage,
      after: afterPage,
      formState: {
        input_type: inputType,
        value_present: Boolean(finalValue),
        value_length: finalValue?.length ?? 0,
        requested_value_length: expectedValue.length,
        matches_requested_value: matchesRequestedValue,
        used_dom_fallback: usedDomFallback,
      },
    };
  }

  async enterCode(
    session: AdapterSessionHandle,
    input: {
      code: string;
      selector?: string;
      frameSelector?: string;
      submit: boolean;
      timeoutMs?: number;
    },
  ) {
    const startedAt = Date.now();
    const beforePage = await capturePageIdentity(session.page);
    if (!input.selector) {
      await session.page.keyboard.type(input.code);
      if (input.submit) {
        await session.page.keyboard.press("Enter");
      }
      const afterPage = await capturePageIdentity(session.page);
      return {
        url: session.page.url(),
        title: afterPage.title,
        verificationHint: `Typed ${input.code.length}-character code with keyboard focus`,
        elapsedMs: elapsedMs(startedAt),
        waitedFor: [
          "Typed code into the currently focused element; no raw code value is returned.",
          input.submit ? "Pressed Enter after typing because submit=true." : "Did not submit because submit=false.",
        ],
        before: beforePage,
        after: afterPage,
      };
    }

    const targets = input.frameSelector
      ? resolveLocator(session.page, input.selector, input.frameSelector)
      : await resolveCodeTargets(session.page, input.selector);
    const count = await targets.count();

    if (count <= 1) {
      const locator = targets.first();
      const meta = await getEditableMeta(targets);
      await locator.click({ timeout: input.timeoutMs });
      if (meta.tag === "input" || meta.tag === "textarea") {
        await locator.fill(input.code, { timeout: input.timeoutMs });
      } else {
        await locator.pressSequentially(input.code, {
          timeout: input.timeoutMs,
        });
      }
      if (input.submit) {
        await locator.press("Enter", { timeout: input.timeoutMs });
      }
      const afterPage = await capturePageIdentity(session.page);
      return {
        url: session.page.url(),
        title: afterPage.title,
        verificationHint: `Entered ${input.code.length}-character code into ${input.selector}`,
        elapsedMs: elapsedMs(startedAt),
        waitedFor: [
          "Clicked/focused a single code target and filled or typed the code; no raw code value is returned.",
          input.submit ? "Pressed Enter after code entry because submit=true." : "Did not submit because submit=false.",
        ],
        before: beforePage,
        after: afterPage,
      };
    }

    const visibleIndexes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      if (
        await targets
          .nth(index)
          .isVisible()
          .catch(() => false)
      ) {
        visibleIndexes.push(index);
      }
    }

    const targetIndexes =
      visibleIndexes.length > 0
        ? visibleIndexes
        : Array.from({ length: count }, (_, index) => index);
    if (targetIndexes.length < input.code.length) {
      throw new Error(
        `Not enough editable targets to enter ${input.code.length} code characters`,
      );
    }

    const characters = [...input.code];
    for (const [charIndex, char] of characters.entries()) {
      const locator = targets.nth(targetIndexes[charIndex]!);
      await locator.click({ timeout: input.timeoutMs });
      await locator.fill(char, { timeout: input.timeoutMs });
    }

    if (input.submit) {
      const lastTargetIndex =
        targetIndexes[
          Math.min(characters.length - 1, targetIndexes.length - 1)
        ]!;
      await targets.nth(lastTargetIndex).press("Enter", {
        timeout: input.timeoutMs,
      });
    }

    const afterPage = await capturePageIdentity(session.page);
    return {
      url: session.page.url(),
      title: afterPage.title,
      verificationHint: `Entered segmented ${input.code.length}-character code into ${input.selector}`,
      elapsedMs: elapsedMs(startedAt),
      waitedFor: [
        `Filled ${input.code.length} visible segmented code targets; no raw code value is returned.`,
        input.submit ? "Pressed Enter on the last code target because submit=true." : "Did not submit because submit=false.",
      ],
      before: beforePage,
      after: afterPage,
    };
  }

  async press(
    session: AdapterSessionHandle,
    input: {
      key: string;
      selector?: string;
      frameSelector?: string;
      timeoutMs?: number;
    },
  ) {
    const startedAt = Date.now();
    const beforePage = await capturePageIdentity(session.page);
    let beforeTarget: ClickStateSnapshot | undefined;
    if (input.selector) {
      const locator = resolveLocator(
        session.page,
        input.selector,
        input.frameSelector,
      ).first();
      beforeTarget = await captureClickState(session.page, locator);
      await locator.press(input.key, { timeout: input.timeoutMs });
    } else {
      await session.page.keyboard.press(input.key);
    }
    const afterPage = await capturePageIdentity(session.page);
    let changed: string[] = [];
    if (input.selector) {
      const locator = resolveLocator(
        session.page,
        input.selector,
        input.frameSelector,
      ).first();
      const afterTarget = await captureClickState(session.page, locator);
      if (beforeTarget) {
        changed = changedClickStateFields(beforeTarget, afterTarget);
      }
    } else if (beforePage.url !== afterPage.url) {
      changed = ["pageUrl"];
    }
    if (beforePage.title !== afterPage.title) {
      changed.push("title");
    }
    const observableChange = changed.length > 0;
    return {
      url: session.page.url(),
      title: afterPage.title,
      verificationHint: input.selector
        ? `Pressed ${input.key} on ${input.selector}`
        : `Pressed ${input.key}`,
      elapsedMs: elapsedMs(startedAt),
      waitedFor: [
        input.selector
          ? "Playwright locator.press auto-waited for the target element before pressing the key."
          : "Playwright keyboard.press sent the key to the current focused element.",
        "Post-press state probe captured immediate URL/title/target state without an unconditional fixed delay.",
      ],
      before: beforePage,
      after: afterPage,
      postAction: {
        observableChange,
        changed,
        guidance: observableChange
          ? undefined
          : "No URL/title/target-state change was observed after the key press. If an app effect was expected, follow with observe_text, observe_dom, observe_network, or an explicit wait_for selector/text.",
      },
    };
  }

  async waitFor(
    session: AdapterSessionHandle,
    input: { selector?: string; text?: string; timeoutMs: number },
  ) {
    const startedAt = Date.now();
    const beforePage = await capturePageIdentity(session.page);
    if (input.selector) {
      await session.page.waitForSelector(input.selector, {
        timeout: input.timeoutMs,
      });
    } else if (input.text) {
      await session.page
        .getByText(input.text, { exact: false })
        .first()
        .waitFor({ timeout: input.timeoutMs });
    }
    const afterPage = await capturePageIdentity(session.page);
    return {
      url: session.page.url(),
      title: afterPage.title,
      verificationHint: input.selector
        ? `Observed selector ${input.selector}`
        : `Observed text ${input.text}`,
      elapsedMs: elapsedMs(startedAt),
      waitedFor: [
        input.selector
          ? `Waited up to ${input.timeoutMs}ms for selector ${input.selector}.`
          : `Waited up to ${input.timeoutMs}ms for text ${input.text}.`,
      ],
      before: beforePage,
      after: afterPage,
    };
  }

  async wheel(
    session: AdapterSessionHandle,
    input: {
      selector?: string;
      deltaX: number;
      deltaY: number;
      steps: number;
      stepDelayMs: number;
      timeoutMs?: number;
    },
  ) {
    const startedAt = Date.now();
    const beforePage = await capturePageIdentity(session.page);
    if (input.selector) {
      await session.page
        .locator(input.selector)
        .first()
        .hover({ timeout: input.timeoutMs });
    }

    const stepX = input.deltaX / input.steps;
    const stepY = input.deltaY / input.steps;

    for (let index = 0; index < input.steps; index += 1) {
      await session.page.mouse.wheel(stepX, stepY);
      if (input.stepDelayMs > 0 && index < input.steps - 1) {
        await session.page.waitForTimeout(input.stepDelayMs);
      }
    }

    const afterPage = await capturePageIdentity(session.page);
    return {
      url: session.page.url(),
      title: afterPage.title,
      verificationHint: input.selector
        ? `Scrolled on ${input.selector}`
        : `Scrolled viewport by (${input.deltaX}, ${input.deltaY})`,
      elapsedMs: elapsedMs(startedAt),
      waitedFor: [
        input.selector
          ? "Hovered the target before wheel input; wheel steps did not wait for page readiness."
          : "Sent wheel input to the viewport; wheel steps did not wait for page readiness.",
        input.stepDelayMs > 0
          ? `Applied ${input.stepDelayMs}ms delay between ${input.steps} wheel steps.`
          : "No delay was applied between wheel steps.",
      ],
      before: beforePage,
      after: afterPage,
    };
  }

  async drag(
    session: AdapterSessionHandle,
    input: {
      fromSelector: string;
      toSelector: string;
      steps: number;
      timeoutMs?: number;
    },
  ) {
    const startedAt = Date.now();
    const beforePage = await capturePageIdentity(session.page);
    const source = await getElementCenter(session.page, input.fromSelector);
    const target = await getElementCenter(session.page, input.toSelector);
    await session.page.mouse.move(source.x, source.y);
    await session.page.mouse.down({ button: "left" });
    await session.page.mouse.move(target.x, target.y, { steps: input.steps });
    await session.page.mouse.up({ button: "left" });

    const afterPage = await capturePageIdentity(session.page);
    return {
      url: session.page.url(),
      title: afterPage.title,
      verificationHint: `Dragged from ${input.fromSelector} to ${input.toSelector}`,
      elapsedMs: elapsedMs(startedAt),
      waitedFor: [
        `Resolved source and target element centers, then moved mouse in ${input.steps} steps.`,
      ],
      before: beforePage,
      after: afterPage,
    };
  }

  async swipe(
    session: AdapterSessionHandle,
    input: {
      selector?: string;
      startX?: number;
      startY?: number;
      deltaX: number;
      deltaY: number;
      speed: number;
    },
  ) {
    const startedAt = Date.now();
    const beforePage = await capturePageIdentity(session.page);
    const cdp = await session.page.context().newCDPSession(session.page);
    const start = input.selector
      ? await getElementCenter(session.page, input.selector)
      : {
          x: input.startX ?? 0,
          y: input.startY ?? 0,
        };

    await cdp.send("Input.synthesizeScrollGesture", {
      x: Math.round(start.x),
      y: Math.round(start.y),
      xDistance: input.deltaX,
      yDistance: input.deltaY,
      speed: input.speed,
      gestureSourceType: "touch",
    });

    const afterPage = await capturePageIdentity(session.page);
    return {
      url: session.page.url(),
      title: afterPage.title,
      verificationHint: input.selector
        ? `Swiped on ${input.selector}`
        : `Swiped from (${start.x}, ${start.y}) by (${input.deltaX}, ${input.deltaY})`,
      elapsedMs: elapsedMs(startedAt),
      waitedFor: [
        "Resolved swipe origin and sent a bounded CDP touch scroll gesture; no extra readiness wait was applied.",
      ],
      before: beforePage,
      after: afterPage,
    };
  }

  async pinch(
    session: AdapterSessionHandle,
    input: {
      selector?: string;
      centerX?: number;
      centerY?: number;
      scaleFactor: number;
      speed: number;
    },
  ) {
    const startedAt = Date.now();
    const beforePage = await capturePageIdentity(session.page);
    const cdp = await session.page.context().newCDPSession(session.page);
    const center = input.selector
      ? await getElementCenter(session.page, input.selector)
      : {
          x: input.centerX ?? 0,
          y: input.centerY ?? 0,
        };

    await cdp.send("Input.synthesizePinchGesture", {
      x: Math.round(center.x),
      y: Math.round(center.y),
      scaleFactor: input.scaleFactor,
      relativeSpeed: input.speed,
      gestureSourceType: "touch",
    });

    const afterPage = await capturePageIdentity(session.page);
    return {
      url: session.page.url(),
      title: afterPage.title,
      verificationHint: input.selector
        ? `Pinched on ${input.selector} with scale ${input.scaleFactor}`
        : `Pinched at (${center.x}, ${center.y}) with scale ${input.scaleFactor}`,
      elapsedMs: elapsedMs(startedAt),
      waitedFor: [
        "Resolved pinch center and sent a bounded CDP touch pinch gesture; no extra readiness wait was applied.",
      ],
      before: beforePage,
      after: afterPage,
    };
  }
}

export function createCloakBrowserAdapter(env: WebAgentEnv) {
  return new PlaywrightCloakBrowserAdapter(env);
}
