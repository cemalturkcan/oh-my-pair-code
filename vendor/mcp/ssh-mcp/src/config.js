import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

const hostSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  user: z.string().min(1).default("root"),
  description: z.string().default(""),
  keyPath: z.string().optional(),
  password: z.string().optional(),
  passwordEnv: z.string().optional(),
  connect_timeout_seconds: z.coerce.number().int().min(1).max(120).optional(),
  default_timeout_seconds: z.coerce.number().int().min(1).max(600).optional(),
  max_timeout_seconds: z.coerce.number().int().min(1).max(3600).optional(),
  max_output_bytes: z.coerce.number().int().min(1024).max(10_000_000).optional(),
  ready_command: z.string().min(1).default("echo SSH_OK"),
  strict_host_key_checking: z.enum(["yes", "accept-new", "no"]).default("accept-new"),
  command_allowlist: z.array(z.string().min(1)).optional(),
});

const configSchema = z.object({
  default_timeout_seconds: z.coerce.number().int().min(1).max(600).default(60),
  max_timeout_seconds: z.coerce.number().int().min(1).max(3600).default(600),
  max_output_bytes: z.coerce.number().int().min(1024).max(10_000_000).default(131072),
  hosts: z.record(hostSchema).default({}),
});

function expandHome(pathValue) {
  if (!pathValue || !pathValue.startsWith("~/")) return pathValue;
  return join(process.env.HOME || "", pathValue.slice(2));
}

function resolvePassword(host, hostName) {
  if (host.password) return host.password;
  if (!host.passwordEnv) return undefined;

  const value = process.env[host.passwordEnv];
  if (!value) {
    throw new Error(`Host '${hostName}' expects env var '${host.passwordEnv}' but it is not set.`);
  }

  return value;
}

function loadRawConfig() {
  const candidates = [
    process.env.SSH_MCP_CONFIG_PATH,
    join(__dirname, "../config.json"),
    join(process.cwd(), "config.json"),
  ].filter(Boolean);

  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue;
    try {
      return {
        configPath,
        raw: JSON.parse(readFileSync(configPath, "utf8")),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not read SSH MCP config '${configPath}': ${message}`);
    }
  }

  throw new Error(
    "SSH MCP config not found. Set SSH_MCP_CONFIG_PATH or create config.json next to this server."
  );
}

export function loadConfig() {
  const { configPath, raw } = loadRawConfig();
  const parsed = configSchema.parse(raw);

  const hosts = Object.fromEntries(
    Object.entries(parsed.hosts).map(([name, host]) => {
      const normalized = {
        ...host,
        keyPath: host.keyPath ? expandHome(host.keyPath) : undefined,
        password: resolvePassword(host, name),
        default_timeout_seconds: host.default_timeout_seconds ?? parsed.default_timeout_seconds,
        max_timeout_seconds: host.max_timeout_seconds ?? parsed.max_timeout_seconds,
        max_output_bytes: host.max_output_bytes ?? parsed.max_output_bytes,
      };

      if (normalized.default_timeout_seconds > normalized.max_timeout_seconds) {
        throw new Error(
          `Host '${name}' has default_timeout_seconds greater than max_timeout_seconds.`
        );
      }

      return [name, normalized];
    })
  );

  return {
    configPath,
    hosts,
    default_timeout_seconds: parsed.default_timeout_seconds,
    max_timeout_seconds: parsed.max_timeout_seconds,
    max_output_bytes: parsed.max_output_bytes,
  };
}

export function getHost(config, connection) {
  const host = config.hosts[connection];
  if (host) return host;

  const available = Object.keys(config.hosts);
  if (available.length === 0) {
    throw new Error("No SSH hosts configured. Update ssh-mcp/config.json first.");
  }

  throw new Error(`Unknown connection '${connection}'. Available: ${available.join(", ")}`);
}
