import { z } from "zod";
import { followUpByGoalSchema } from "./policy.js";

export const navigatePageInputSchema = z.object({
  session_id: z.string().min(1),
  page_id: z.string().min(1).optional().describe("Managed page_id or tab_id to target without visual tab switching."),
  url: z.string().url(),
  wait_until: z
    .enum(["domcontentloaded", "load", "networkidle"])
    .default("domcontentloaded")
    .describe(
      "Readiness state for page.goto. Prefer domcontentloaded plus explicit selector/text/network waits; networkidle can be slow and is discouraged as a default readiness check.",
    )
});

export const createPageInputSchema = z.object({
  session_id: z.string().min(1),
  purpose: z.string().min(1).optional(),
  owner: z.string().min(1).optional()
});

export const createPageOutputSchema = z.object({
  session_id: z.string(),
  page_id: z.string(),
  tab_id: z.string(),
  status: z.enum(["active", "stale", "closed"]),
  purpose: z.string().optional(),
  owner: z.string().optional(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  created_at: z.string(),
  updated_at: z.string()
});

export const resizePageInputSchema = z.object({
  session_id: z.string().min(1),
  page_id: z.string().min(1).optional().describe("Managed page_id or tab_id to target without visual tab switching."),
  width: z.number().int().min(100).max(10000),
  height: z.number().int().min(100).max(10000),
  device_scale_factor: z.number().min(0.1).max(10).optional(),
  is_mobile: z.boolean().optional()
});

export const resizePageOutputSchema = z.object({
  page_id: z.string(),
  tab_id: z.string().optional(),
  before: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  device_scale_factor: z.number().optional(),
  is_mobile: z.boolean().optional(),
  elapsed_ms: z.number().int().nonnegative()
});

export const navigatePageOutputSchema = z.object({
  page_id: z.string(),
  tab_id: z.string().optional(),
  requested_url: z.string(),
  final_url: z.string(),
  title: z.string().optional(),
  navigation_id: z.string(),
  waited_for: z.string(),
  wait_until: z.enum(["domcontentloaded", "load", "networkidle"]),
  networkidle_discouraged: z.boolean().optional(),
  before: z.object({ url: z.string(), title: z.string().optional() }).optional(),
  timings: z.object({
    elapsed_ms: z.number().nonnegative()
  }),
  follow_up_by_goal: followUpByGoalSchema
});
