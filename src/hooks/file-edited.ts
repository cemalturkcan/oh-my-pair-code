import type { HookRuntime } from "./runtime";

export function createFileEditedHook(
  runtime: HookRuntime,
) {
  return {
    "file.edited": async (event: { path: string; sessionID?: string }): Promise<void> => {
      if (!event.path || !event.sessionID) {
        return;
      }
      runtime.rememberEditedFile(event.sessionID, event.path);
    },
  };
}
