import type { PluginInput } from "@opencode-ai/plugin";
import type { HarnessConfig } from "../types";
import { createCommentGuardHook } from "./comment-guard";
import { createIntentGateHook } from "./intent-gate";
import { safeCreateHook, safeHook } from "./sdk";
import { createTodoContinuationHook } from "./todo-continuation";

type HookRecord = {
  "chat.message"?: (input: any, output: any) => Promise<void>;
  event?: (input: { event: { type: string; properties?: unknown } }) => Promise<void>;
  "tool.execute.after"?: (input: any, output: any) => Promise<void>;
};

function wrapHookRecord(name: string, hook: HookRecord | undefined): HookRecord | undefined {
  if (!hook) {
    return undefined;
  }

  return {
    "chat.message": safeHook(`${name}.chat.message`, hook["chat.message"]),
    event: safeHook(`${name}.event`, hook.event),
    "tool.execute.after": safeHook(`${name}.tool.execute.after`, hook["tool.execute.after"]),
  };
}

function composeChatMessage(hooks: HookRecord[]) {
  const active = hooks.map((hook) => hook["chat.message"]).filter(Boolean);
  if (active.length === 0) {
    return undefined;
  }

  return async (input: any, output: any) => {
    for (const hook of active) {
      await hook?.(input, output);
    }
  };
}

function composeEvent(hooks: HookRecord[]) {
  const active = hooks.map((hook) => hook.event).filter(Boolean);
  if (active.length === 0) {
    return undefined;
  }

  return async (input: { event: { type: string; properties?: unknown } }) => {
    for (const hook of active) {
      await hook?.(input);
    }
  };
}

function composeToolAfter(hooks: HookRecord[]) {
  const active = hooks.map((hook) => hook["tool.execute.after"]).filter(Boolean);
  if (active.length === 0) {
    return undefined;
  }

  return async (input: any, output: any) => {
    for (const hook of active) {
      await hook?.(input, output);
    }
  };
}

export function createHarnessHooks(ctx: PluginInput, config: HarnessConfig) {
  const hooks: HookRecord[] = [];

  const registerHook = (name: string, enabled: boolean, factory: () => HookRecord) => {
    if (!enabled) {
      return;
    }

    const hook = wrapHookRecord(name, safeCreateHook(name, factory));
    if (hook) {
      hooks.push(hook);
    }
  };

  registerHook("intent_gate", config.hooks?.intent_gate !== false, () => createIntentGateHook(ctx));
  registerHook(
    "todo_continuation",
    config.hooks?.todo_continuation !== false,
    () => createTodoContinuationHook(ctx, config.hooks?.todo_continuation_cooldown_ms ?? 30000),
  );
  registerHook("comment_guard", config.hooks?.comment_guard !== false, () => createCommentGuardHook());

  return {
    "chat.message": composeChatMessage(hooks),
    event: composeEvent(hooks),
    "tool.execute.after": composeToolAfter(hooks),
  };
}
