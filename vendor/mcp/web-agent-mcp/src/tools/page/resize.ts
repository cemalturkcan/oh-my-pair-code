import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeServices } from "../../server.js";
import { createFailureResult } from "../../core/errors.js";
import { createToolSuccess, toToolInputSchema } from "../../schemas/common.js";
import { resizePageInputSchema, resizePageOutputSchema } from "../../schemas/page.js";

export function registerResizePageTool(server: McpServer, services: RuntimeServices) {
  server.registerTool(
    "page.resize",
    {
      title: "Resize Page Viewport",
      description: "Resize a managed browser tab viewport for responsive testing without recreating the session.",
      inputSchema: toToolInputSchema(resizePageInputSchema),
      outputSchema: resizePageOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: z.infer<typeof resizePageInputSchema>) => {
      try {
        const startedAt = Date.now();
        const action = await services.history.startAction("page.resize", input, {
          session_id: input.session_id,
          page_id: input.page_id,
        });
        const { session, page, result } = await services.sessions.resizePage(input.session_id, input.page_id, {
          width: input.width,
          height: input.height,
          deviceScaleFactor: input.device_scale_factor,
          isMobile: input.is_mobile,
        });
        const data = {
          page_id: page.pageId,
          tab_id: page.tabId,
          before: result.before,
          viewport: result.viewport,
          device_scale_factor: result.deviceScaleFactor,
          is_mobile: result.isMobile,
          elapsed_ms: Date.now() - startedAt,
        };
        await services.history.finishAction(action, "succeeded", data);
        return createToolSuccess({ ok: true, code: "OK", action_id: action.action_id, session_id: session.sessionId, page_id: page.pageId, data });
      } catch (error) {
        return createFailureResult(error, { session_id: input.session_id, page_id: input.page_id });
      }
    },
  );
}
