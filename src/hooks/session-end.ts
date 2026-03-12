import type { HookRuntime } from "./runtime";
import { resolveSessionID } from "./runtime";

export function createSessionEndHook(
  runtime: HookRuntime,
) {
  return {
    "session.deleted": async (input?: unknown): Promise<void> => {
      const sessionID = resolveSessionID(input);
      if (!sessionID) {
        return;
      }

      runtime.appendObservation({
        timestamp: new Date().toISOString(),
        phase: "idle",
        sessionID,
        note: "session deleted",
      });
      runtime.clearSession(sessionID);
    },
  };
}
