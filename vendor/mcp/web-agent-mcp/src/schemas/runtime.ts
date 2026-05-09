import { z } from "zod";

export const evaluateJsInputSchema = z.object({
  session_id: z.string().min(1),
  page_id: z.string().min(1).optional(),
  expression: z.string().min(1),
  await_promise: z.boolean().default(true)
});

export const evaluateJsOutputSchema = z.object({
  artifact_id: z.string(),
  value: z.unknown().optional(),
  preview: z.string().optional(),
  truncated: z.boolean(),
  url: z.string(),
  title: z.string().optional(),
  bytes: z.number().optional(),
  storage_path: z.string().optional()
});

export type EvaluateJsInput = z.infer<typeof evaluateJsInputSchema>;

export const runPageScriptInputSchema = z.object({
  session_id: z.string().min(1),
  page_id: z.string().min(1).optional(),
  script: z.string().min(1).max(20_000),
  timeout_ms: z.number().int().min(100).max(10_000).default(3_000),
  max_result_bytes: z.number().int().min(256).max(32_000).default(8_000),
  redact: z.boolean().default(true)
});

export const runPageScriptOutputSchema = z.object({
  audit: z.object({
    action_id: z.string(),
    script_hash: z.string(),
    script_preview: z.string(),
    artifact_id: z.string().optional()
  }),
  before: z.object({
    url: z.string(),
    title: z.string().optional()
  }),
  after: z.object({
    url: z.string(),
    title: z.string().optional()
  }),
  elapsed_ms: z.number(),
  result: z.unknown().optional(),
  result_preview: z.string(),
  result_truncated: z.boolean(),
  bytes: z.number(),
  safety: z.object({
    timeout_ms: z.number(),
    max_result_bytes: z.number(),
    redacted: z.boolean(),
    page_context_only: z.boolean(),
    denied_tokens: z.array(z.string())
  })
});

export type RunPageScriptInput = z.infer<typeof runPageScriptInputSchema>;

export const injectCssInputSchema = z.object({
  session_id: z.string().min(1),
  page_id: z.string().min(1).optional(),
  css: z.string().min(1).max(50_000),
  css_id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional()
});

export const injectCssOutputSchema = z.object({
  css_id: z.string(),
  page_id: z.string(),
  tab_id: z.string().optional(),
  bytes: z.number().int().nonnegative(),
  elapsed_ms: z.number().int().nonnegative(),
  audit: z.object({ css_hash: z.string(), css_preview: z.string(), preview_truncated: z.boolean() }),
  safety: z.object({ max_css_bytes: z.number(), page_context_only: z.boolean(), raw_js_required: z.literal(false) })
});

export const removeCssInputSchema = z.object({
  session_id: z.string().min(1),
  page_id: z.string().min(1).optional(),
  css_id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
});

export const removeCssOutputSchema = z.object({
  css_id: z.string(),
  page_id: z.string(),
  tab_id: z.string().optional(),
  removed: z.boolean(),
  elapsed_ms: z.number().int().nonnegative(),
  safety: z.object({ known_injected_id: z.boolean(), page_context_only: z.boolean() })
});
