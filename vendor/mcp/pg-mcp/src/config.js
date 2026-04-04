import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizeConnection(connection) {
  return {
    host: connection.host || "127.0.0.1",
    port: toPositiveInt(connection.port, 5432),
    user: connection.user || "postgres",
    password: connection.password || "",
    database: connection.database || "postgres",
    description: connection.description || "",
    statement_timeout_ms: toPositiveInt(connection.statement_timeout_ms, 10000),
    default_row_limit: toPositiveInt(connection.default_row_limit, 100),
    max_row_limit: toPositiveInt(connection.max_row_limit, 1000),
    ssl: Boolean(connection.ssl),
  };
}

export function loadConfig() {
  const candidates = [
    process.env.PG_MCP_CONFIG_PATH,
    join(__dirname, "../config.json"),
    join(process.cwd(), "config.json"),
  ].filter(Boolean);

  let rawConfig;
  for (const configPath of candidates) {
    if (existsSync(configPath)) {
      rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
      break;
    }
  }

  if (!rawConfig) {
    throw new Error("config.json not found. Set PG_MCP_CONFIG_PATH or place config.json in the project root.");
  }

  if (!rawConfig.connections || typeof rawConfig.connections !== "object") {
    throw new Error("config.json must contain a 'connections' object.");
  }

  const entries = Object.entries(rawConfig.connections);
  if (entries.length === 0) {
    throw new Error("You must define at least one connection in 'connections'.");
  }

  const connections = {};
  for (const [name, connection] of entries) {
    if (!connection || typeof connection !== "object") {
      throw new Error(`Connection '${name}' is invalid.`);
    }

    const normalized = normalizeConnection(connection);
    if (normalized.default_row_limit > normalized.max_row_limit) {
      throw new Error(`default_row_limit for '${name}' cannot exceed max_row_limit.`);
    }

    connections[name] = normalized;
  }

  return { connections };
}
