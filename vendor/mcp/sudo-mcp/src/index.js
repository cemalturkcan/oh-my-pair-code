#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { evaluateCommandPolicy, runSudoCommand } from "./runner.js";

const config = loadConfig();
const pendingApprovals = new Map();

const requestSchema = z.object({
  command: z.string().min(1),
  timeout_seconds: z.coerce.number().int().min(1).max(3600).optional(),
  reason: z.string().max(300).optional(),
});

const approveSchema = z.object({
  request_id: z.string().uuid(),
  approval_code: z.string().regex(/^[A-Z0-9]{8}$/),
  approval_text: z.string().min(1),
});

const idSchema = z.object({
  request_id: z.string().uuid(),
});

function ok(payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function makeApprovalCode() {
  return randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

function nowIso() {
  return new Date().toISOString();
}

function expiresAtIso(ttlSeconds) {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function cleanupExpiredRequests() {
  const now = Date.now();
  for (const [requestId, value] of pendingApprovals.entries()) {
    if (value.expiresAtMs <= now) {
      pendingApprovals.delete(requestId);
    }
  }
}

function getPendingRequest(requestId) {
  cleanupExpiredRequests();
  return pendingApprovals.get(requestId);
}

function buildExpectedApprovalPhrase(requestId, approvalCode) {
  return `APPROVE_SUDO ${requestId} ${approvalCode}`;
}

const server = new Server(
  { name: "sudo-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_sudo_policy",
      description: "Show sudo policy and execution limits",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "request_sudo_execution",
      description: "Create a pending sudo execution request and approval code",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_seconds: { type: "number", minimum: 1, maximum: 3600 },
          reason: { type: "string" },
        },
        required: ["command"],
      },
    },
    {
      name: "run_approved_sudo",
      description: "Execute a previously requested sudo command with user approval",
      inputSchema: {
        type: "object",
        properties: {
          request_id: { type: "string" },
          approval_code: { type: "string" },
          approval_text: { type: "string" },
        },
        required: ["request_id", "approval_code", "approval_text"],
      },
    },
    {
      name: "list_pending_sudo_requests",
      description: "List all not-yet-executed sudo requests",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "cancel_pending_sudo_request",
      description: "Cancel one pending sudo execution request",
      inputSchema: {
        type: "object",
        properties: {
          request_id: { type: "string" },
        },
        required: ["request_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_sudo_policy": {
        return ok({
          config_path: config.configPath,
          approval_ttl_seconds: config.approval_ttl_seconds,
          default_timeout_seconds: config.default_timeout_seconds,
          max_timeout_seconds: config.max_timeout_seconds,
          max_output_bytes: config.max_output_bytes,
          require_non_interactive_sudo: config.require_non_interactive_sudo,
          require_allowlist: config.require_allowlist,
          allow_patterns: config.allow_patterns,
          deny_patterns: config.deny_patterns,
          pending_request_count: pendingApprovals.size,
        });
      }

      case "request_sudo_execution": {
        const parsed = requestSchema.parse(args || {});
        const policy = evaluateCommandPolicy(parsed.command, config);
        if (!policy.allowed) {
          return fail(policy.reason);
        }

        const requestId = randomUUID();
        const approvalCode = makeApprovalCode();
        const createdAt = nowIso();
        const expiresAt = expiresAtIso(config.approval_ttl_seconds);
        const expiresAtMs = Date.parse(expiresAt);

        pendingApprovals.set(requestId, {
          requestId,
          command: parsed.command.trim(),
          timeoutSeconds: parsed.timeout_seconds ?? config.default_timeout_seconds,
          reason: parsed.reason || "",
          createdAt,
          expiresAt,
          expiresAtMs,
          approvalCode,
        });

        const expectedApprovalPhrase = buildExpectedApprovalPhrase(requestId, approvalCode);

        return ok({
          status: "pending_approval",
          request_id: requestId,
          command: parsed.command.trim(),
          reason: parsed.reason || "",
          policy_result: policy.reason,
          created_at: createdAt,
          expires_at: expiresAt,
          approval_code: approvalCode,
          expected_user_phrase: expectedApprovalPhrase,
        });
      }

      case "run_approved_sudo": {
        const parsed = approveSchema.parse(args || {});
        const requestEntry = getPendingRequest(parsed.request_id);
        if (!requestEntry) {
          return fail("Request not found or already expired/cancelled.");
        }

        if (requestEntry.approvalCode !== parsed.approval_code) {
          return fail("Invalid approval_code for this request.");
        }

        const expectedPhrase = buildExpectedApprovalPhrase(
          requestEntry.requestId,
          requestEntry.approvalCode
        );

        if (!parsed.approval_text.toUpperCase().includes(expectedPhrase.toUpperCase())) {
          return fail(
            `approval_text must include exact phrase: ${expectedPhrase}`
          );
        }

        pendingApprovals.delete(parsed.request_id);
        const result = await runSudoCommand(requestEntry.command, requestEntry.timeoutSeconds, config);

        return ok({
          approval: {
            request_id: requestEntry.requestId,
            approved_at: nowIso(),
          },
          execution: result,
        });
      }

      case "list_pending_sudo_requests": {
        cleanupExpiredRequests();
        const list = [...pendingApprovals.values()].map((entry) => ({
          request_id: entry.requestId,
          command: entry.command,
          reason: entry.reason,
          created_at: entry.createdAt,
          expires_at: entry.expiresAt,
        }));
        return ok({
          pending_count: list.length,
          requests: list,
        });
      }

      case "cancel_pending_sudo_request": {
        const parsed = idSchema.parse(args || {});
        const deleted = pendingApprovals.delete(parsed.request_id);
        if (!deleted) return fail("Request not found.");
        return ok({
          status: "cancelled",
          request_id: parsed.request_id,
        });
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
  console.error(`Failed to start sudo-mcp-server: ${message}`);
  process.exit(1);
});
