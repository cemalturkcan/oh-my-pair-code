import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { loadEnv } from "./config/env.js";
import {
  acquireProfileLock,
  getDaemonConfig,
  isDaemonRunning,
  readDaemonRegistry,
  releaseProfileLock,
  writeDaemonRegistry,
} from "./config/daemon.js";
import { createCloakBrowserAdapter } from "./adapters/cloakbrowser/launcher.js";
import { ArtifactStore } from "./core/artifact-store.js";
import { SessionManager } from "./core/session-manager.js";
import { TaskHistoryStore } from "./core/task-history.js";
import { registerTools } from "./tools/register-tools.js";

export type RuntimeServices = {
  env: ReturnType<typeof loadEnv>;
  artifacts: ArtifactStore;
  history: TaskHistoryStore;
  sessions: SessionManager;
};

export function createRuntimeServices() {
  const env = loadEnv();
  const artifacts = new ArtifactStore(env);
  const history = new TaskHistoryStore(env);
  const adapter = createCloakBrowserAdapter(env);
  const sessions = new SessionManager({ env, adapter });

  return { env, artifacts, history, sessions } satisfies RuntimeServices;
}

export function createServer(services = createRuntimeServices()) {
  const server = new McpServer(
    {
      name: services.env.serverName,
      version: services.env.serverVersion,
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  registerTools(server, services);
  return server;
}

export async function startStdioServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("web-agent-mcp running on stdio");
}

export async function startDaemonServer() {
  const config = getDaemonConfig();
  const lockFd = acquireProfileLock(config);
  process.env.WEB_AGENT_DAEMON = "true";
  process.env.WEB_AGENT_DATA_DIR ??= config.dataDir;
  process.env.WEB_AGENT_CHROME_USER_DATA_DIR ??= config.profileDir;

  const services = createRuntimeServices();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function createSessionTransport() {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        transports.set(sessionId, transport);
      },
      onsessionclosed: (sessionId) => {
        if (sessionId) transports.delete(sessionId);
      },
    });
    transport.onerror = (error) => {
      console.error(
        "web-agent-mcp daemon transport error:",
        error instanceof Error ? error.message : String(error),
      );
    };
    await createServer(services).connect(transport);
    return transport;
  }

  function isInitializeRequest(body: unknown) {
    if (Array.isArray(body)) {
      return body.some(isInitializeRequest);
    }
    return Boolean(
      body &&
        typeof body === "object" &&
        "method" in body &&
        (body as { method?: unknown }).method === "initialize",
    );
  }

  function writeJsonRpcError(
    response: ServerResponse,
    status: number,
    code: number,
    message: string,
  ) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
  }

  async function resolveTransport(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
  ) {
    const sessionId = request.headers["mcp-session-id"];
    const normalizedSessionId = Array.isArray(sessionId) ? sessionId[0] : sessionId;
    if (normalizedSessionId) {
      const transport = transports.get(normalizedSessionId);
      if (!transport) {
        writeJsonRpcError(response, 404, -32001, "Session not found");
        return undefined;
      }
      return transport;
    }

    if (request.method === "POST" && isInitializeRequest(body)) {
      return createSessionTransport();
    }

    writeJsonRpcError(response, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
    return undefined;
  }

  const httpServer = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", config.endpoint);
    if (requestUrl.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, endpoint: config.endpoint }));
      return;
    }
    if (requestUrl.pathname !== "/mcp") {
      response.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", async () => {
      try {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        const transport = await resolveTransport(request, response, body);
        if (!transport) return;
        await transport.handleRequest(request, response, body);
      } catch (error) {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
        }
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const registry = writeDaemonRegistry(config, { version: loadEnv().serverVersion });
  console.error(`web-agent-mcp daemon running at ${registry.endpoint}`);

  const shutdown = async () => {
    await Promise.allSettled([...transports.values()].map((transport) => transport.close()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    releaseProfileLock(lockFd, config);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export function printDaemonStatus() {
  const config = getDaemonConfig();
  const registry = readDaemonRegistry(config);
  const running = isDaemonRunning(config);
  console.log(JSON.stringify({ running, endpoint: registry?.endpoint ?? config.endpoint, registry }, null, 2));
}

export function stopDaemon() {
  const config = getDaemonConfig();
  const registry = readDaemonRegistry(config);
  if (!registry?.pid || !isDaemonRunning(config)) {
    console.log(JSON.stringify({ stopped: false, reason: "not_running" }));
    return;
  }
  process.kill(registry.pid, "SIGTERM");
  console.log(JSON.stringify({ stopped: true, pid: registry.pid }));
}

async function main() {
  if (process.argv.includes("--daemon")) {
    await startDaemonServer();
    return;
  }
  if (process.argv.includes("--daemon-status")) {
    printDaemonStatus();
    return;
  }
  if (process.argv.includes("--daemon-stop")) {
    stopDaemon();
    return;
  }
  await startStdioServer();
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  const argv1Url = pathToFileURL(process.argv[1]).href;
  if (import.meta.url === argv1Url) return true;
  try {
    return (
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}
