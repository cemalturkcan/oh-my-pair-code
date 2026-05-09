import { createFailureResult } from "../../core/errors.js";
import { buildActionFailurePayload, buildActionSuccessPayload } from "../../core/action-flow.js";
import { createToolSuccess } from "../../schemas/common.js";
import type { RuntimeServices } from "../../server.js";

export function createActionSuccessResult(input: {
  actionId: string;
  sessionId: string;
  pageId: string;
  appliedMode: "semantic" | "physical";
  verificationHint?: string;
  elapsedMs?: number;
  waitedFor?: string[];
  before?: { url: string; title?: string };
  after?: { url: string; title?: string };
  postAction?: {
    observableChange: boolean;
    guidance?: string;
    usedDomFallback?: boolean;
    changed?: string[];
  };
  formState?: {
    input_type?: string;
    value_present: boolean;
    value_length: number;
    requested_value_length: number;
    matches_requested_value: boolean;
    used_dom_fallback?: boolean;
  };
  targetSelectorKnown: boolean;
}) {
  return createToolSuccess({
    ok: true,
    code: "OK",
    action_id: input.actionId,
    session_id: input.sessionId,
    page_id: input.pageId,
    data: buildActionSuccessPayload({
      actionId: input.actionId,
      appliedMode: input.appliedMode,
      verificationHint: input.verificationHint,
      elapsedMs: input.elapsedMs,
      waitedFor: input.waitedFor,
      before: input.before,
      after: input.after,
      postAction: input.postAction,
      formState: input.formState,
      targetSelectorKnown: input.targetSelectorKnown
    })
  });
}

export function createActionFailureResponse(input: {
  services: RuntimeServices;
  error: unknown;
  actionId?: string;
  sessionId: string;
  pageId?: string;
  appliedMode: "semantic" | "physical";
  targetSelectorKnown: boolean;
}) {
  let sessionHealth:
    | {
        consecutiveErrors: number;
        maxConsecutiveErrors: number;
        cooldownMs: number;
        lastRestartAt?: string;
        now: string;
      }
    | undefined;

  try {
    const session = input.services.sessions.recordFailure(input.sessionId);
    sessionHealth = {
      consecutiveErrors: session.consecutiveErrors,
      maxConsecutiveErrors: input.services.env.sessionMaxConsecutiveErrors,
      cooldownMs: input.services.env.sessionRestartCooldownMs,
      lastRestartAt: session.lastRestartAt,
      now: new Date().toISOString()
    };
  } catch {
    sessionHealth = undefined;
  }

  return createFailureResult(input.error, {
    action_id: input.actionId,
    session_id: input.sessionId,
    page_id: input.pageId,
    data: buildActionFailurePayload({
      error: input.error,
      actionId: input.actionId,
      appliedMode: input.appliedMode,
      targetSelectorKnown: input.targetSelectorKnown,
      sessionHealth
    })
  });
}
