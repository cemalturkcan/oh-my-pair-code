import type { HookRuntime } from "./runtime";
import { resolveSessionOrEntityID } from "./runtime";

export function createSessionEndHook(runtime: HookRuntime) {
  return {
    "session.deleted": async (input?: unknown): Promise<void> => {
      // session.deleted input IS the session object, so bare .id is safe
      const sessionID = resolveSessionOrEntityID(input);
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
