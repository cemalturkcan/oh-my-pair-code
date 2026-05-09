import path from "node:path";
import { z } from "zod";
import { getDaemonConfig } from "./daemon.js";

const envSchema = z.object({
  WEB_AGENT_SERVER_NAME: z.string().default("web-agent-mcp"),
  WEB_AGENT_SERVER_VERSION: z.string().default("0.1.0"),
  WEB_AGENT_DATA_DIR: z.string().default(path.resolve(process.cwd(), ".data")),
  WEB_AGENT_HEADLESS: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  WEB_AGENT_DEFAULT_LOCALE: z.string().default("en-US"),
  WEB_AGENT_DEFAULT_TIMEZONE_ID: z.string().optional(),
  WEB_AGENT_CHROME_USER_DATA_DIR: z.string().optional(),
  WEB_AGENT_CHROME_PROFILE_DIRECTORY: z.string().optional(),
  WEB_AGENT_DEFAULT_HUMANIZE: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  WEB_AGENT_DEFAULT_VIEWPORT_WIDTH: z.coerce
    .number()
    .int()
    .positive()
    .default(1440),
  WEB_AGENT_DEFAULT_VIEWPORT_HEIGHT: z.coerce
    .number()
    .int()
    .positive()
    .default(960),
  WEB_AGENT_DEFAULT_LAUNCH_ARGS: z.string().optional(),
  WEB_AGENT_SESSION_MAX_CONSECUTIVE_ERRORS: z.coerce
    .number()
    .int()
    .positive()
    .default(3),
  WEB_AGENT_SESSION_RESTART_COOLDOWN_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30000),
  WEB_AGENT_HISTORY_DIR: z.string().optional(),
  WEB_AGENT_ARTIFACTS_DIR: z.string().optional(),
  WEB_AGENT_PROFILES_DIR: z.string().optional(),
  WEB_AGENT_DAEMON: z.enum(["true", "false"]).optional(),
});

export type WebAgentEnv = {
  serverName: string;
  serverVersion: string;
  dataDir: string;
  historyDir: string;
  artifactsDir: string;
  profilesDir: string;
  headless: boolean;
  defaultLocale: string;
  defaultTimezoneId?: string;
  chromeUserDataDir?: string;
  chromeProfileDirectory?: string;
  defaultHumanize: boolean;
  defaultLaunchArgs: string[];
  defaultViewport: {
    width: number;
    height: number;
  };
  sessionMaxConsecutiveErrors: number;
  sessionRestartCooldownMs: number;
  daemon: boolean;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WebAgentEnv {
  const parsed = envSchema.parse(source);
  const daemonConfig = getDaemonConfig(source);
  const daemon = parsed.WEB_AGENT_DAEMON === "true";
  const dataDir = daemon ? daemonConfig.dataDir : parsed.WEB_AGENT_DATA_DIR;
  const historyDir =
    parsed.WEB_AGENT_HISTORY_DIR ??
    path.join(dataDir, "history");
  const artifactsDir =
    parsed.WEB_AGENT_ARTIFACTS_DIR ??
    path.join(dataDir, "artifacts");
  const profilesDir =
    parsed.WEB_AGENT_PROFILES_DIR ??
    path.join(dataDir, "profiles");
  const defaultLaunchArgs = parsed.WEB_AGENT_DEFAULT_LAUNCH_ARGS
    ? parsed.WEB_AGENT_DEFAULT_LAUNCH_ARGS.split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];

  return {
    serverName: parsed.WEB_AGENT_SERVER_NAME,
    serverVersion: parsed.WEB_AGENT_SERVER_VERSION,
    dataDir,
    historyDir,
    artifactsDir,
    profilesDir,
    headless: parsed.WEB_AGENT_HEADLESS,
    defaultLocale: parsed.WEB_AGENT_DEFAULT_LOCALE,
    defaultTimezoneId: parsed.WEB_AGENT_DEFAULT_TIMEZONE_ID,
    chromeUserDataDir: daemon
      ? (parsed.WEB_AGENT_CHROME_USER_DATA_DIR ?? daemonConfig.profileDir)
      : parsed.WEB_AGENT_CHROME_USER_DATA_DIR,
    chromeProfileDirectory: parsed.WEB_AGENT_CHROME_PROFILE_DIRECTORY,
    defaultHumanize: parsed.WEB_AGENT_DEFAULT_HUMANIZE,
    defaultLaunchArgs,
    defaultViewport: {
      width: parsed.WEB_AGENT_DEFAULT_VIEWPORT_WIDTH,
      height: parsed.WEB_AGENT_DEFAULT_VIEWPORT_HEIGHT,
    },
    sessionMaxConsecutiveErrors:
      parsed.WEB_AGENT_SESSION_MAX_CONSECUTIVE_ERRORS,
    sessionRestartCooldownMs: parsed.WEB_AGENT_SESSION_RESTART_COOLDOWN_MS,
    daemon,
  };
}
