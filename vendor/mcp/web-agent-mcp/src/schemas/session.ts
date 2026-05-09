import { z } from "zod";

export const profileModeSchema = z.enum(["ephemeral", "persistent"]);

export const viewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive()
});

export const createSessionInputSchema = z.object({
  profile_mode: profileModeSchema.optional(),
  locale: z.string().optional(),
  timezone_id: z.string().optional(),
  user_data_dir: z.string().optional(),
  profile_directory: z.string().optional(),
  humanize: z.boolean().optional(),
  launch_args: z.array(z.string().min(1)).max(20).optional(),
  viewport: viewportSchema.optional()
});

export const closeSessionInputSchema = z.object({
  session_id: z.string().min(1)
});

export const restartSessionInputSchema = z.object({
  session_id: z.string().min(1)
});

export const sessionStatusInputSchema = z.object({});

const recentPageEventSchema = z.object({
  kind: z.string().optional(),
  at: z.string()
});

export const sessionOutputSchema = z.object({
  session_id: z.string(),
  context_id: z.string(),
  page_id: z.string(),
  status: z.enum(["active", "closing", "closed", "error"]),
  profile_mode: profileModeSchema,
  locale: z.string().optional(),
  timezone_id: z.string().optional(),
  user_data_dir: z.string().optional(),
  profile_directory: z.string().optional(),
  humanize: z.boolean(),
  launch_args: z.array(z.string()),
  viewport: viewportSchema,
  created_at: z.string(),
  health: z.object({
    consecutive_errors: z.number().int().nonnegative(),
    last_error_at: z.string().optional(),
    restart_recommended: z.boolean()
  }),
  capabilities: z.object({
    observe: z.boolean(),
    screenshot: z.boolean(),
    evaluate: z.boolean()
  })
});

export const sessionCloseOutputSchema = z.object({
  session_id: z.string(),
  closed: z.boolean(),
  status: z.enum(["active", "closing", "closed", "error"])
});

export const sessionRestartOutputSchema = sessionOutputSchema;

export const sessionStatusOutputSchema = z.object({
  status: z.enum(["empty", "active", "inactive"]),
  session_count: z.number().int().nonnegative(),
  active_session_count: z.number().int().nonnegative(),
  sessions: z.array(
    z.object({
      session_id: z.string(),
      context_id: z.string(),
      status: z.enum(["active", "closing", "closed", "error"]),
      profile_mode: profileModeSchema,
      created_at: z.string(),
      primary_page_id: z.string(),
      registry_path: z.string().optional(),
      page_count: z.number().int().nonnegative(),
      pages: z.array(
        z.object({
          page_id: z.string(),
          tab_id: z.string(),
          is_primary: z.boolean(),
          status: z.enum(["active", "stale", "closed"]),
          purpose: z.string().optional(),
          owner: z.string().optional(),
          viewport: viewportSchema,
          created_at: z.string(),
          updated_at: z.string(),
          url: z.string().optional(),
          title: z.string().optional(),
          last_action: recentPageEventSchema.optional(),
          last_observation: recentPageEventSchema.optional()
        })
      ),
      health: z.object({
        consecutive_errors: z.number().int().nonnegative(),
        last_error_at: z.string().optional(),
        last_restart_at: z.string().optional(),
        restart_recommended: z.boolean()
      }),
      next_safe_action: z.string()
    })
  ),
  next_safe_action: z.string()
});

export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;
