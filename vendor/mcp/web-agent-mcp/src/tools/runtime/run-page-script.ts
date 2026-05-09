import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeServices } from "../../server.js";
import { createFailureResult } from "../../core/errors.js";
import { createToolSuccess, toToolInputSchema } from "../../schemas/common.js";
import { runPageScriptInputSchema, runPageScriptOutputSchema } from "../../schemas/runtime.js";
import {
  assertSafePageScript,
  createScriptPreview,
  hashScript,
  PAGE_SCRIPT_DENIED_TOKENS,
  serializeBoundedResult,
} from "./page-script-safety.js";

export function registerRunPageScriptTool(server: McpServer, services: RuntimeServices) {
  server.registerTool(
    "runtime.run_page_script",
    {
      title: "Run Runtime Page Script",
      description:
        "Run a bounded same-session/same-page script in the current page context for fast internal test or diagnostic flows. Use human-like act.* tools for interaction-sensitive flows.",
      inputSchema: toToolInputSchema(runPageScriptInputSchema),
      outputSchema: runPageScriptOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (input: z.infer<typeof runPageScriptInputSchema>) => {
      try {
        const parsed = runPageScriptInputSchema.parse(input);
        const scriptHash = hashScript(parsed.script);
        const scriptPreview = createScriptPreview(parsed.script, parsed.redact);
        assertSafePageScript(parsed.script);
        const action = await services.history.startAction("runtime.run_page_script", {
          session_id: parsed.session_id,
          page_id: parsed.page_id,
          script_hash: scriptHash,
          script_preview: scriptPreview,
          timeout_ms: parsed.timeout_ms,
          max_result_bytes: parsed.max_result_bytes,
          redact: parsed.redact
        }, {
          session_id: parsed.session_id,
          page_id: parsed.page_id
        });

        const { session, page, result } = await services.sessions.runPageScript(
          parsed.session_id,
          parsed.page_id,
          {
            script: parsed.script,
            timeoutMs: parsed.timeout_ms
          }
        );

        const bounded = serializeBoundedResult(result.value, parsed.max_result_bytes, parsed.redact);
        const artifact = await services.artifacts.writeText("eval", bounded.preview, {
          session_id: session.sessionId,
          page_id: page.pageId,
          action_id: action.action_id,
          url: result.after.url,
          title: result.after.title,
          meta: {
            script_hash: scriptHash,
            result_truncated: bounded.truncated,
            max_result_bytes: parsed.max_result_bytes,
            redacted: parsed.redact
          }
        });

        const data = {
          audit: {
            action_id: action.action_id,
            script_hash: scriptHash,
            script_preview: scriptPreview,
            artifact_id: artifact.artifact_id
          },
          before: result.before,
          after: result.after,
          elapsed_ms: result.elapsedMs,
          result: bounded.value,
          result_preview: bounded.preview,
          result_truncated: bounded.truncated,
          bytes: bounded.bytes,
          safety: {
            timeout_ms: parsed.timeout_ms,
            max_result_bytes: parsed.max_result_bytes,
            redacted: parsed.redact,
            page_context_only: true,
            denied_tokens: PAGE_SCRIPT_DENIED_TOKENS
          }
        };

        await services.history.finishAction(action, "succeeded", {
          artifact_id: artifact.artifact_id,
          script_hash: scriptHash,
          result_truncated: bounded.truncated,
          elapsed_ms: result.elapsedMs
        });

        return createToolSuccess({
          ok: true,
          code: "OK",
          action_id: action.action_id,
          session_id: session.sessionId,
          page_id: page.pageId,
          artifact_ids: [artifact.artifact_id],
          data
        });
      } catch (error) {
        return createFailureResult(error);
      }
    }
  );
}
