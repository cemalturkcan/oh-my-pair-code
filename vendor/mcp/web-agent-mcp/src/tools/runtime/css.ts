import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeServices } from "../../server.js";
import { createFailureResult } from "../../core/errors.js";
import { createToolSuccess, toToolInputSchema } from "../../schemas/common.js";
import { injectCssInputSchema, injectCssOutputSchema, removeCssInputSchema, removeCssOutputSchema } from "../../schemas/runtime.js";

const MAX_CSS_BYTES = 50_000;
const PREVIEW_LIMIT = 1000;

function hashCss(css: string) {
  return createHash("sha256").update(css).digest("hex");
}

function previewCss(css: string) {
  const preview = css.replace(/\s+/g, " ").trim();
  return preview.length > PREVIEW_LIMIT ? `${preview.slice(0, PREVIEW_LIMIT)}...` : preview;
}

function createCssId() {
  return `css_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function registerInjectCssTool(server: McpServer, services: RuntimeServices) {
  server.registerTool(
    "runtime.inject_css",
    {
      title: "Inject CSS",
      description: "Inject bounded CSS into a targeted page for auditable style experiments without raw JavaScript.",
      inputSchema: toToolInputSchema(injectCssInputSchema),
      outputSchema: injectCssOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: z.infer<typeof injectCssInputSchema>) => {
      try {
        const startedAt = Date.now();
        const cssId = input.css_id ?? createCssId();
        const cssHash = hashCss(input.css);
        const cssPreview = previewCss(input.css);
        const previewTruncated = input.css.replace(/\s+/g, " ").trim().length > PREVIEW_LIMIT;
        const action = await services.history.startAction("runtime.inject_css", {
          session_id: input.session_id,
          page_id: input.page_id,
          css_id: cssId,
          css_hash: cssHash,
          css_preview: cssPreview,
          bytes: Buffer.byteLength(input.css, "utf8"),
        }, { session_id: input.session_id, page_id: input.page_id });
        const { session, page, result } = await services.sessions.injectCss(input.session_id, input.page_id, { cssId, css: input.css });
        const data = {
          css_id: result.cssId,
          page_id: page.pageId,
          tab_id: page.tabId,
          bytes: result.bytes,
          elapsed_ms: Date.now() - startedAt,
          audit: { css_hash: cssHash, css_preview: cssPreview, preview_truncated: previewTruncated },
          safety: { max_css_bytes: MAX_CSS_BYTES, page_context_only: true, raw_js_required: false as const },
        };
        await services.history.finishAction(action, "succeeded", { css_id: cssId, bytes: result.bytes });
        return createToolSuccess({ ok: true, code: "OK", action_id: action.action_id, session_id: session.sessionId, page_id: page.pageId, data });
      } catch (error) {
        return createFailureResult(error, { session_id: input.session_id, page_id: input.page_id });
      }
    },
  );
}

export function registerRemoveCssTool(server: McpServer, services: RuntimeServices) {
  server.registerTool(
    "runtime.remove_css",
    {
      title: "Remove CSS",
      description: "Remove CSS previously injected by runtime.inject_css from a targeted page.",
      inputSchema: toToolInputSchema(removeCssInputSchema),
      outputSchema: removeCssOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input: z.infer<typeof removeCssInputSchema>) => {
      try {
        const startedAt = Date.now();
        const action = await services.history.startAction("runtime.remove_css", input, { session_id: input.session_id, page_id: input.page_id });
        const { session, page, result } = await services.sessions.removeCss(input.session_id, input.page_id, { cssId: input.css_id });
        const data = {
          css_id: input.css_id,
          page_id: page.pageId,
          tab_id: page.tabId,
          removed: result.removed,
          elapsed_ms: Date.now() - startedAt,
          safety: { known_injected_id: result.knownInjectedId, page_context_only: true },
        };
        await services.history.finishAction(action, "succeeded", data);
        return createToolSuccess({ ok: true, code: "OK", action_id: action.action_id, session_id: session.sessionId, page_id: page.pageId, data });
      } catch (error) {
        return createFailureResult(error, { session_id: input.session_id, page_id: input.page_id });
      }
    },
  );
}
