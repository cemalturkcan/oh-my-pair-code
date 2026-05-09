import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createFailureResult } from "../../core/errors.js";
import {
  waitForNetworkInputSchema,
  waitForNetworkOutputSchema
} from "../../schemas/observe.js";
import { createToolSuccess, toToolInputSchema } from "../../schemas/common.js";
import type { RuntimeServices } from "../../server.js";

export function registerWaitForNetworkTool(server: McpServer, services: RuntimeServices) {
  server.registerTool(
    "observe.wait_for_network",
    {
      title: "Wait For Network",
      description: "Wait for a matching network response or failure in the active page session.",
      inputSchema: toToolInputSchema(waitForNetworkInputSchema),
      outputSchema: waitForNetworkOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (input: z.infer<typeof waitForNetworkInputSchema>) => {
      try {
        const action = await services.history.startAction("observe.wait_for_network", input, {
          session_id: input.session_id,
          page_id: input.page_id
        });
        const { session, page, result } = await services.sessions.waitForNetwork(
          input.session_id,
          input.page_id,
          {
            urlPattern: input.url_pattern,
            useRegex: input.use_regex,
            status: input.status,
            outcome: input.outcome,
            timeoutMs: input.timeout_ms,
            pollIntervalMs: input.poll_interval_ms
          }
        );

        const data = {
          entry: result.entry,
          elapsed_ms: result.elapsedMs,
          waited_for: [
            `Polled recent network entries every ${input.poll_interval_ms}ms for up to ${input.timeout_ms}ms.`,
            `Matched ${input.use_regex ? "regex" : "substring"} URL pattern ${input.url_pattern}${input.status ? ` with status ${input.status}` : ""}${input.outcome ? ` and outcome ${input.outcome}` : ""}.`
          ]
        };

        await services.history.finishAction(action, "succeeded", {
          elapsed_ms: result.elapsedMs,
          matched_url: result.entry.url,
          status: result.entry.status,
          outcome: result.entry.outcome
        });

        return createToolSuccess({
          ok: true,
          code: "OK",
          action_id: action.action_id,
          session_id: session.sessionId,
          page_id: page.pageId,
          data
        });
      } catch (error) {
        return createFailureResult(error);
      }
    }
  );
}
