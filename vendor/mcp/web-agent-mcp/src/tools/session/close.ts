import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeServices } from "../../server.js";
import { createFailureResult } from "../../core/errors.js";
import { createToolSuccess, toToolInputSchema } from "../../schemas/common.js";
import { closeSessionInputSchema, sessionCloseOutputSchema } from "../../schemas/session.js";

export function registerCloseSessionTool(server: McpServer, services: RuntimeServices) {
  server.registerTool(
    "session.close",
    {
      title: "Close Session",
      description: "Close a browser session and release its runtime resources.",
      inputSchema: toToolInputSchema(closeSessionInputSchema),
      outputSchema: sessionCloseOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input: z.infer<typeof closeSessionInputSchema>) => {
      try {
        const action = await services.history.startAction("session.close", input, {
          session_id: input.session_id
        });
        const session = await services.sessions.closeSession(input.session_id);
        const data = {
          session_id: session.sessionId,
          closed: true,
          status: session.status
        };
        await services.history.finishAction(action, "succeeded", data);
        return createToolSuccess({ ok: true, code: "OK", action_id: action.action_id, session_id: session.sessionId, data });
      } catch (error) {
        return createFailureResult(error);
      }
    }
  );
}
