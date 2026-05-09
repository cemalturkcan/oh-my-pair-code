import { describe, expect, it } from "vitest";
import { createToolFailure, toToolInputSchema } from "./common.js";
import { clickInputSchema, enterCodeInputSchema, fillInputSchema, pressInputSchema, waitForInputSchema, wheelInputSchema } from "./act.js";
import { screenshotInputSchema } from "./observe.js";

describe("toToolInputSchema", () => {
  it("exposes object fields for refined action schemas", () => {
    expect(Object.keys(toToolInputSchema(waitForInputSchema))).toEqual(
      expect.arrayContaining(["session_id", "page_id", "selector", "text", "timeout_ms"]),
    );
    expect(Object.keys(toToolInputSchema(wheelInputSchema))).toEqual(
      expect.arrayContaining(["session_id", "page_id", "selector", "delta_x", "delta_y", "steps"]),
    );
  });

  it("exposes object fields for super-refined screenshot schema", () => {
    expect(Object.keys(toToolInputSchema(screenshotInputSchema))).toEqual(
      expect.arrayContaining(["session_id", "page_id", "mode", "selector", "format", "quality"]),
    );
  });

  it("keeps frame_selector optional and iframe-only for action schemas", () => {
    expect(Object.keys(toToolInputSchema(fillInputSchema))).toContain("frame_selector");
    expect(toToolInputSchema(fillInputSchema).frame_selector.isOptional()).toBe(true);
    expect(toToolInputSchema(clickInputSchema).frame_selector.isOptional()).toBe(true);
    expect(toToolInputSchema(pressInputSchema).frame_selector.isOptional()).toBe(true);
    expect(toToolInputSchema(enterCodeInputSchema).frame_selector.isOptional()).toBe(true);
    expect(fillInputSchema.parse({ session_id: "s", selector: "input", value: "x" }).frame_selector).toBeUndefined();
    expect(clickInputSchema.parse({ session_id: "s", selector: "button", frame_selector: "" }).frame_selector).toBeUndefined();
    expect(clickInputSchema.parse({ session_id: "s", selector: "button", frame_selector: null }).frame_selector).toBeUndefined();

    const description = toToolInputSchema(fillInputSchema).frame_selector.description;
    expect(description).toContain("Optional CSS selector for a real iframe");
    expect(description).toContain("Omit this field for main-page elements");
    expect(description).toContain("body, :scope, or __none__");
  });
});

describe("createToolFailure", () => {
  it("serializes the full safe failure envelope for browser errors", () => {
    const result = createToolFailure({
      ok: false,
      code: "BROWSER_DISCONNECTED",
      message: "Browser session, context, or page is closed/disconnected.",
      session_id: "session_123",
      page_id: "page_123",
      error: {
        type: "BROWSER",
        details: {
          reason: "browser_or_page_closed",
          next_safe_action: "Create or restart the browser session before retrying.",
          retryable: false,
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(result).not.toHaveProperty("structuredContent");
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      ok: false,
      code: "BROWSER_DISCONNECTED",
      message: "Browser session, context, or page is closed/disconnected.",
      session_id: "session_123",
      page_id: "page_123",
      error: {
        type: "BROWSER",
        details: {
          reason: "browser_or_page_closed",
          retryable: false,
        },
      },
    });
  });
});
