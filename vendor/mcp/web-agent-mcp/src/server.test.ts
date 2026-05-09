import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate TCP port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function stopProcess(child: ChildProcess) {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 1500).unref();
  });
}

describe("web-agent daemon Streamable HTTP transport", () => {
  const children: ChildProcess[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(children.splice(0).map(stopProcess));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("accepts the official SDK StreamableHTTPClientTransport through initialize and tools/list", async () => {
    const port = await getFreePort();
    const dataHome = await mkdtemp(path.join(os.tmpdir(), "web-agent-daemon-sdk-"));
    tempDirs.push(dataHome);

    const child = spawn("bun", ["run", "src/server.ts", "--daemon"], {
      cwd: packageRoot,
      stdio: "ignore",
      env: {
        ...process.env,
        XDG_DATA_HOME: dataHome,
        WEB_AGENT_DAEMON_PORT: String(port),
        WEB_AGENT_HEADLESS: "true",
        WEB_AGENT_DEFAULT_LAUNCH_ARGS: "--disable-gpu,--disable-dev-shm-usage",
      },
    });
    children.push(child);

    await waitForHealth(`http://127.0.0.1:${port}/healthz`);

    const client = new Client({ name: "web-agent-daemon-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("session.status");
      const fillTool = tools.tools.find((tool) => tool.name === "act.fill");
      expect(fillTool?.inputSchema.properties).toHaveProperty("frame_selector");
      expect(fillTool?.inputSchema.required).not.toContain("frame_selector");
    } finally {
      await client.close();
    }
  });

  it("runs runtime JavaScript and captures console through the official SDK daemon transport", async () => {
    const port = await getFreePort();
    const dataHome = await mkdtemp(path.join(os.tmpdir(), "web-agent-daemon-runtime-"));
    tempDirs.push(dataHome);

    const child = spawn("bun", ["run", "src/server.ts", "--daemon"], {
      cwd: packageRoot,
      stdio: "ignore",
      env: {
        ...process.env,
        XDG_DATA_HOME: dataHome,
        WEB_AGENT_DAEMON_PORT: String(port),
        WEB_AGENT_HEADLESS: "true",
        WEB_AGENT_DEFAULT_LAUNCH_ARGS: "--no-sandbox,--disable-gpu,--disable-dev-shm-usage",
      },
    });
    children.push(child);

    await waitForHealth(`http://127.0.0.1:${port}/healthz`);

    const client = new Client({ name: "web-agent-daemon-runtime-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    try {
      await client.connect(transport);
      const created = await client.callTool({
        name: "session.create",
        arguments: {
          profile_mode: "ephemeral",
          viewport: { width: 800, height: 600 },
          launch_args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        },
      }) as any;
      const sessionId = created.structuredContent.session_id;

      const evaluated = await client.callTool({
        name: "runtime.evaluate_js",
        arguments: {
          session_id: sessionId,
          expression: "(() => { console.log('daemon-evaluate-log'); return { ok: true, width: innerWidth }; })()",
          await_promise: true,
        },
      }) as any;
      expect(evaluated.structuredContent.value).toMatchObject({ ok: true, width: 800 });

      const scripted = await client.callTool({
        name: "runtime.run_page_script",
        arguments: {
          session_id: sessionId,
          script: "document.body.innerHTML = '<h1>Daemon Fixture</h1><input id=\\\"name\\\" placeholder=\\\"Name\\\"><button>Save</button>'; console.log('daemon-script-log'); return helpers.json({ ok: helpers.page().url === 'about:blank' });",
          timeout_ms: 3000,
        },
      }) as any;
      expect(scripted.structuredContent.result).toEqual({ ok: true });

      const pageState = await client.callTool({
        name: "observe.page_state",
        arguments: { session_id: sessionId, recent_network_limit: 5 },
      }) as any;
      expect(pageState.structuredContent.dom_summary).toMatchObject({
        headings: ["Daemon Fixture"],
        inputs: 1,
        buttons: 1,
      });
      expect(pageState.structuredContent.inputs[0]).toMatchObject({ id: "name", placeholder: "Name", visible: true });

      const consoleResult = await client.callTool({
        name: "observe.console",
        arguments: { session_id: sessionId, limit: 20 },
      }) as any;
      const texts = consoleResult.structuredContent.entries.map((entry: { text: string }) => entry.text);
      expect(texts).toEqual(expect.arrayContaining(["daemon-evaluate-log", "daemon-script-log"]));

      const tab = await client.callTool({
        name: "page.create",
        arguments: { session_id: sessionId, purpose: "console-regression", owner: "test" },
      }) as any;
      const pageId = tab.structuredContent.page_id;
      const targetedNavigation = await client.callTool({
        name: "page.navigate",
        arguments: {
          session_id: sessionId,
          page_id: pageId,
          url: "data:text/html,%3Cbutton%20id%3D%22log%22%3ELog%3C%2Fbutton%3E",
          wait_until: "load",
        },
      }) as any;
      expect(targetedNavigation.structuredContent.page_id).toBe(pageId);
      const targetedEval = await client.callTool({
        name: "runtime.evaluate_js",
        arguments: {
          session_id: sessionId,
          page_id: pageId,
          expression: "(() => { console.log('targeted-navigation-evaluate-log'); document.querySelector('#log').addEventListener('click', () => console.log('targeted-navigation-click-log')); document.querySelector('#log').click(); return true; })()",
          await_promise: true,
        },
      }) as any;
      expect(targetedEval.structuredContent.page_id ?? pageId).toBe(pageId);
      expect(targetedEval.structuredContent.value).toBe(true);
      const targetedConsole = await client.callTool({
        name: "observe.console",
        arguments: { session_id: sessionId, page_id: pageId, limit: 20 },
      }) as any;
      const targetedTexts = targetedConsole.structuredContent.entries.map((entry: { text: string }) => entry.text);
      expect(targetedTexts).toEqual(expect.arrayContaining(["targeted-navigation-evaluate-log", "targeted-navigation-click-log"]));
    } finally {
      await client.close();
    }
  }, 20000);
});
