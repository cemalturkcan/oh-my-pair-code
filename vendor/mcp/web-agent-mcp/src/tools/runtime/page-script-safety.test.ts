import { describe, expect, it } from "vitest";
import { WebAgentError } from "../../core/errors.js";
import {
  assertSafePageScript,
  createScriptPreview,
  hashScript,
  redactSensitiveValue,
  serializeBoundedResult,
} from "./page-script-safety.js";

describe("page script safety", () => {
  it("blocks Node/import/eval-style tokens before browser execution", () => {
    expect(() => assertSafePageScript("return process.env.SECRET")).toThrow(WebAgentError);
    expect(() => assertSafePageScript("const fs = require('fs')")).toThrow(WebAgentError);
    expect(() => assertSafePageScript("return eval('1 + 1')")).toThrow(WebAgentError);
    expect(() => assertSafePageScript("return (0, eval)('1 + 1')")).toThrow(WebAgentError);
    expect(() => assertSafePageScript("return eval?.('1 + 1')")).toThrow(WebAgentError);
    expect(() => assertSafePageScript("return window.eval('1 + 1')")).toThrow(WebAgentError);
    expect(() => assertSafePageScript("return globalThis['eval']('1 + 1')")).toThrow(WebAgentError);
    expect(() => assertSafePageScript('return globalThis["ev"+"al"]("1 + 1")')).toThrow(WebAgentError);
    expect(() => assertSafePageScript("return window[`Function`]('return 1')()")).toThrow(WebAgentError);
    expect(() => assertSafePageScript("return document.defaultView['eval']('1 + 1')")).toThrow(WebAgentError);
    expect(() => assertSafePageScript('return document.defaultView["Function"]("return 1")()')).toThrow(WebAgentError);
    expect(() => assertSafePageScript('return document["defaultView"]["eval"]("1 + 1")')).toThrow(WebAgentError);
    expect(() => assertSafePageScript('return document["defaultView"]["Function"]("return 1")()')).toThrow(WebAgentError);
    expect(() => assertSafePageScript('return document?.["defaultView"]?.["eval"]("1 + 1")')).toThrow(WebAgentError);
    expect(() => assertSafePageScript('return document?.["defaultView"]?.["Function"]("return 1")()')).toThrow(WebAgentError);
    expect(() => assertSafePageScript("return helpers.text('#ok')")).not.toThrow();
  });

  it("blocks constructor and prototype escape hatches outside the helper-script subset", () => {
    expect(() => assertSafePageScript("return helpers.constructor.constructor('return 1')()")).toThrow(WebAgentError);
    expect(() => assertSafePageScript("return ({}).constructor.constructor('return 1')()")).toThrow(WebAgentError);
    expect(() => assertSafePageScript("return helpers['constructor']['constructor']('return 1')()")).toThrow(WebAgentError);
    expect(() => assertSafePageScript('return ({})["con"+"structor"]["con"+"structor"]("return 1")()')).toThrow(WebAgentError);
    expect(() => assertSafePageScript('return helpers["proto"+"type"]')).toThrow(WebAgentError);
    expect(() => assertSafePageScript("return helpers.__proto__.constructor('return 1')()")).toThrow(WebAgentError);
    expect(() => assertSafePageScript("return Object.getPrototypeOf(helpers)")).toThrow(WebAgentError);
  });

  it("allows normal helper-oriented DOM scripts without constructor or prototype access", () => {
    expect(() =>
      assertSafePageScript(`
        await helpers.waitFor('#result');
        helpers.assert(helpers.exists('#result'), 'result should exist');
        return helpers.json({ text: helpers.text('#result'), page: helpers.page() });
      `),
    ).not.toThrow();
  });

  it("uses hashes and redacted previews instead of raw secret-bearing scripts", () => {
    const script = "const data = '{\"token\":\"super-secret-value\"}'; const password = 'other-secret-value'; return helpers.text('#result')";

    expect(hashScript(script)).toHaveLength(64);
    expect(createScriptPreview(script, true)).toContain("[REDACTED]");
    expect(createScriptPreview(script, true)).not.toContain("super-secret-value");
    expect(createScriptPreview(script, true)).not.toContain("other-secret-value");
  });

  it("redacts escaped JSON secret assignments in script previews", () => {
    const script = 'const data = "{\\"password\\":\\"escaped-secret-value\\",\\"safe\\":\\"visible\\"}"; return helpers.text("#result")';

    const preview = createScriptPreview(script, true);

    expect(preview).toContain("[REDACTED]");
    expect(preview).not.toContain("escaped-secret-value");
    expect(preview).toContain("visible");
  });

  it("redacts secret-shaped result fields and enforces max result bytes", () => {
    const value = redactSensitiveValue({ token: "abc123", nested: { text: "safe" } });

    expect(value).toEqual({ token: "[REDACTED]", nested: { text: "safe" } });

    expect(redactSensitiveValue('{"api_key":"json-secret-value"}')).not.toContain("json-secret-value");

    const bounded = serializeBoundedResult({ text: "x".repeat(100) }, 30, true);
    expect(bounded.truncated).toBe(true);
    expect(bounded.value).toBeUndefined();
    expect(bounded.preview.length).toBeLessThanOrEqual(33);
  });
});
