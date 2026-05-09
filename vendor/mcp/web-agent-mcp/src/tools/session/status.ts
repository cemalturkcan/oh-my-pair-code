import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeServices } from "../../server.js";
import { createFailureResult } from "../../core/errors.js";
import { createToolSuccess, toToolInputSchema } from "../../schemas/common.js";
import {
  sessionStatusInputSchema,
  sessionStatusOutputSchema,
} from "../../schemas/session.js";

export function registerSessionStatusTool(
  server: McpServer,
  services: RuntimeServices,
) {
  server.registerTool(
    "session.status",
    {
      title: "Session Status",
      description:
        "Return a compact read-only browser session/page status brief for recovering session_id and page_id state.",
      inputSchema: toToolInputSchema(sessionStatusInputSchema),
      outputSchema: sessionStatusOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_input: z.infer<typeof sessionStatusInputSchema>) => {
      try {
        const data = services.sessions.getSessionBrief();
        return createToolSuccess({
          ok: true,
          code: "OK",
          data,
        });
      } catch (error) {
        return createFailureResult(error);
      }
    },
  );
}
