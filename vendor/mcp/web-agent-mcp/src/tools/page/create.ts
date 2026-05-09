import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeServices } from "../../server.js";
import { createFailureResult } from "../../core/errors.js";
import { createToolSuccess, toToolInputSchema } from "../../schemas/common.js";
import { createPageInputSchema, createPageOutputSchema } from "../../schemas/page.js";

export function registerCreatePageTool(server: McpServer, services: RuntimeServices) {
  server.registerTool(
    "page.create",
    {
      title: "Create Page",
      description: "Create a new managed browser tab with informational purpose/owner metadata.",
      inputSchema: toToolInputSchema(createPageInputSchema),
      outputSchema: createPageOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: z.infer<typeof createPageInputSchema>) => {
      try {
        const action = await services.history.startAction("page.create", input, {
          session_id: input.session_id,
        });
        const { session, page } = await services.sessions.createPage(input.session_id, {
          purpose: input.purpose,
          owner: input.owner,
        });
        const data = {
          session_id: session.sessionId,
          page_id: page.pageId,
          tab_id: page.tabId,
          status: page.status,
          purpose: page.purpose,
          owner: page.owner,
          viewport: page.viewport,
          created_at: page.createdAt,
          updated_at: page.updatedAt,
        };
        await services.history.finishAction(action, "succeeded", data);
        return createToolSuccess({ ok: true, code: "OK", action_id: action.action_id, session_id: session.sessionId, page_id: page.pageId, data });
      } catch (error) {
        return createFailureResult(error, { session_id: input.session_id });
      }
    },
  );
}
