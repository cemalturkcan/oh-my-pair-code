import { runLedgerSyncExitPush, type LedgerSyncRunner } from "../orchestrator/sync";
import type { HarnessConfig } from "../types";
import type { HookRuntime } from "./runtime";
import { resolveSessionOrEntityID } from "./runtime";

export function createSessionEndHook(runtime: HookRuntime, projectDirectory: string, config: HarnessConfig, syncRunner?: LedgerSyncRunner) {
  return {
    "session.deleted": async (input?: unknown): Promise<void> => {
      const sessionID = resolveSessionOrEntityID(input);
      if (!sessionID) {
        return;
      }

      runtime.clearSession(sessionID);
      const sync = await runLedgerSyncExitPush(projectDirectory, config, syncRunner);
      for (const warning of sync.warnings.filter((item) => item.includes("failed") || item.includes("skipped") || item.includes("does not exist"))) {
        console.warn(`[opencode-pair] ledger sync exit: ${warning}`);
      }
    },
  };
}
