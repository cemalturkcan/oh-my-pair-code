import type { HookRuntime } from "./runtime";
import { resolveSessionID } from "./runtime";

export function createPreCompactHook(
  runtime: HookRuntime,
) {
  return {
    "experimental.session.compacting": async (input?: unknown): Promise<void> => {
      const sessionID = resolveSessionID(input);
      if (!sessionID) {
        return;
      }

      runtime.appendObservation({
        timestamp: new Date().toISOString(),
        phase: "idle",
        sessionID,
        agent: runtime.getSessionAgent(sessionID),
        note: "pre-compact snapshot requested",
      });
    },
  };
}
