#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getHost, loadConfig } from "./config.js";
import { runSshCommand, testSshConnection } from "./ssh.js";

const config = loadConfig();
const hostNames = Object.keys(config.hosts);

const runCommandSchema = z.object({
  connection: z.string().min(1),
  command: z.string().min(1),
  timeout_seconds: z.coerce.number().int().min(1).max(3600).optional(),
});

const connectionSchema = z.object({
  connection: z.string().min(1),
});

function ok(payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

const server = new Server(
  { name: "ssh-mcp-server", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_hosts",
      description: "List configured SSH hosts",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "test_connection",
      description: "Test SSH connectivity with each host's ready command",
      inputSchema: {
        type: "object",
        properties: {
          connection: { type: "string", enum: hostNames.length > 0 ? hostNames : undefined },
        },
        required: ["connection"],
      },
    },
    {
      name: "run_command",
      description: "Run a command on a configured SSH host",
      inputSchema: {
        type: "object",
        properties: {
          connection: { type: "string", enum: hostNames.length > 0 ? hostNames : undefined },
          command: { type: "string" },
          timeout_seconds: { type: "number", minimum: 1, maximum: 3600 },
        },
        required: ["connection", "command"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_hosts": {
        const hosts = Object.entries(config.hosts).map(([connectionName, host]) => ({
          connection: connectionName,
          host: host.host,
          port: host.port,
          user: host.user,
          description: host.description,
          auth: host.password ? "password" : host.keyPath ? "key" : "agent/default",
          has_allowlist: Boolean(host.command_allowlist && host.command_allowlist.length > 0),
          default_timeout_seconds: host.default_timeout_seconds,
          max_timeout_seconds: host.max_timeout_seconds,
          max_output_bytes: host.max_output_bytes,
        }));

        return ok({
          config_path: config.configPath,
          host_count: hosts.length,
          hosts,
        });
      }

      case "test_connection": {
        const parsed = connectionSchema.parse(args || {});
        const host = getHost(config, parsed.connection);
        const result = await testSshConnection(host);
        return ok(result);
      }

      case "run_command": {
        const parsed = runCommandSchema.parse(args || {});
        const host = getHost(config, parsed.connection);
        const result = await runSshCommand(host, parsed.command, {
          timeout_seconds: parsed.timeout_seconds,
        });
        return ok(result);
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message);
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start ssh-mcp-server: ${message}`);
  process.exit(1);
});
