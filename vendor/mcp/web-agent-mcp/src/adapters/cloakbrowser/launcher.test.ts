import { describe, expect, it } from "vitest";
import type { WebAgentEnv } from "../../config/env.js";
import { createCloakBrowserAdapter } from "./launcher.js";

const env = {
  headless: true,
} as WebAgentEnv;

describe("PlaywrightCloakBrowserAdapter.runPageScript", () => {
  it("executes a helper-oriented script through the launcher path", async () => {
    const originalDocument = globalThis.document;
    const originalElement = globalThis.Element;
    const originalEvent = globalThis.Event;
    const originalLocation = globalThis.location;

    class TestElement {
      textContent: string;
      value = "";
      tagName = "DIV";
      id = "result";

      constructor(text: string) {
        this.textContent = text;
      }

      dispatchEvent() {
        return true;
      }

      click() {
        return undefined;
      }
    }

    const resultElement = new TestElement(" Ready text ");
    const documentStub = {
      title: "Helper Test",
      querySelector: (selector: string) => selector === "#result" ? resultElement : null,
    };

    Object.assign(globalThis, {
      document: documentStub,
      Element: TestElement,
      Event: class TestEvent {
        constructor(_type: string, _options?: Record<string, unknown>) {}
      },
      location: { href: "https://example.test/helper" },
    });

    try {
      const session = {
        contextId: "context-test",
        pageId: "page-test",
        context: { newPage: async () => undefined },
        page: {
          url: () => "https://example.test/helper",
          title: async () => "Helper Test",
          evaluate: async (source: string) => (0, eval)(source),
        },
        consoleEntries: [],
        networkEntries: [],
        profileMode: "ephemeral",
        viewport: { width: 1280, height: 720 },
      };

      const adapter = createCloakBrowserAdapter(env);
      const result = await adapter.runPageScript(session as never, {
        script: `
          await helpers.waitFor('#result');
          helpers.assert(helpers.exists('#result'), 'result should exist');
          return helpers.json({ text: helpers.text('#result'), page: helpers.page() });
        `,
        timeoutMs: 250,
      });

      expect(result.value).toEqual({
        text: "Ready text",
        page: { url: "https://example.test/helper", title: "Helper Test" },
      });
    } finally {
      Object.assign(globalThis, {
        document: originalDocument,
        Element: originalElement,
        Event: originalEvent,
        location: originalLocation,
      });
    }
  });

  it("replaces the page when page evaluation exceeds timeout", async () => {
    let closed = false;
    let replaced = false;
    const replacementPage = {
      url: () => "about:blank",
      title: async () => "",
      on: () => undefined,
    };
    const hungPage = {
      url: () => "https://example.com/",
      title: async () => "Example Page",
      evaluate: () => new Promise(() => undefined),
      close: async () => {
        closed = true;
      },
    };
    const session = {
      contextId: "context-test",
      pageId: "page-test",
      context: {
        newPage: async () => {
          replaced = true;
          return replacementPage;
        },
      },
      page: hungPage,
      consoleEntries: [],
      networkEntries: [],
      profileMode: "ephemeral",
      viewport: { width: 1280, height: 720 },
    };

    const adapter = createCloakBrowserAdapter(env);

    await expect(
      adapter.runPageScript(session as never, { script: "while (true) {}", timeoutMs: 100 }),
    ).rejects.toThrow("timed out after 100ms; the page was replaced");
    expect(closed).toBe(true);
    expect(replaced).toBe(true);
    expect(session.page).toBe(replacementPage);
  });
});
