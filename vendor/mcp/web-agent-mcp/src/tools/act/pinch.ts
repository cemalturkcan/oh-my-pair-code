import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeServices } from "../../server.js";
import { toToolInputSchema } from "../../schemas/common.js";
import { actionResultSchema, pinchInputSchema } from "../../schemas/act.js";
import { createActionFailureResponse, createActionSuccessResult } from "./shared.js";

export function registerPinchTool(server: McpServer, services: RuntimeServices) {
  server.registerTool(
    "act.pinch",
    {
      title: "Pinch Gesture",
      description: "Perform a touch-style pinch gesture on a selector center or explicit coordinates.",
      inputSchema: toToolInputSchema(pinchInputSchema),
      outputSchema: actionResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (input: z.infer<typeof pinchInputSchema>) => {
      try {
        const action = await services.history.startAction("act.pinch", input, {
          session_id: input.session_id,
          page_id: input.page_id
        });
        const { session, page, result } = await services.sessions.pinch(input.session_id, input.page_id, {
          selector: input.selector,
          centerX: input.center_x,
          centerY: input.center_y,
          scaleFactor: input.scale_factor,
          speed: input.speed
        });
        const data = { verificationHint: result.verificationHint };
        services.sessions.recordSuccess(session.sessionId);
        await services.history.finishAction(action, "succeeded", data);
        return createActionSuccessResult({
          actionId: action.action_id,
          sessionId: session.sessionId,
          pageId: page.pageId,
          appliedMode: "physical",
          verificationHint: result.verificationHint,
          elapsedMs: result.elapsedMs,
          waitedFor: result.waitedFor,
          before: result.before,
          after: result.after,
          targetSelectorKnown: Boolean(input.selector)
        });
      } catch (error) {
        return createActionFailureResponse({
          services,
          error,
          sessionId: input.session_id,
          pageId: input.page_id,
          appliedMode: "physical",
          targetSelectorKnown: Boolean(input.selector)
        });
      }
    }
  );
}
