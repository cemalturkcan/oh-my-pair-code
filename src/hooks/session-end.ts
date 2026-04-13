import type { HookRuntime } from "./runtime";
import { resolveSessionOrEntityID } from "./runtime";

export function createSessionEndHook(runtime: HookRuntime) {
  return {
    "session.deleted": async (input?: unknown): Promise<void> => {
      const sessionID = resolveSessionOrEntityID(input);
      if (!sessionID) {
        return;
      }

      runtime.clearSession(sessionID);
    },
  };
}
