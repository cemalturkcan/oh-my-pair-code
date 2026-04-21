#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getCodexAuthState } from "./auth.js";
import { defaultOutputDir } from "./files.js";
import { loadConfig } from "./config.js";
import { runImageGeneration } from "./openai.js";
import { getPromptResult, PROMPTS } from "./prompts.js";

function ok(payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

const server = new Server(
  { name: "openai-image-gen-mcp", version: "0.1.0" },
  { capabilities: { tools: {}, prompts: {} } },
);

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: PROMPTS.usage_guide.name,
      description: PROMPTS.usage_guide.description,
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  return getPromptResult(request.params?.name);
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_auth_status",
      description: "Inspect Codex auth availability for image generation.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "generate_image",
      description:
        "Generate an image with the OpenAI Responses image_generation tool using Codex auth.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          model: { type: "string" },
          reasoning_effort: {
            type: "string",
            enum: ["none", "low", "medium", "high", "xhigh"],
          },
          instructions: { type: "string" },
          output_path: { type: "string" },
          output_name: { type: "string" },
          base_dir: { type: "string" },
          size: { type: "string" },
          quality: { type: "string" },
          output_format: { type: "string", enum: ["png", "jpeg", "webp"] },
          output_compression: { type: "integer", minimum: 0, maximum: 100 },
          background: { type: "string" },
          action: { type: "string", enum: ["auto", "generate", "edit"] },
          partial_images: { type: "integer", minimum: 0, maximum: 3 },
          previous_response_id: { type: "string" },
          previous_image_call_id: { type: "string" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "edit_image",
      description:
        "Edit one or more local images with the OpenAI Responses image_generation tool using Codex auth.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          input_images: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 16,
          },
          model: { type: "string" },
          reasoning_effort: {
            type: "string",
            enum: ["none", "low", "medium", "high", "xhigh"],
          },
          instructions: { type: "string" },
          output_path: { type: "string" },
          output_name: { type: "string" },
          base_dir: { type: "string" },
          size: { type: "string" },
          quality: { type: "string" },
          output_format: { type: "string", enum: ["png", "jpeg", "webp"] },
          output_compression: { type: "integer", minimum: 0, maximum: 100 },
          background: { type: "string" },
          action: { type: "string", enum: ["auto", "generate", "edit"] },
          partial_images: { type: "integer", minimum: 0, maximum: 3 },
          previous_response_id: { type: "string" },
          previous_image_call_id: { type: "string" },
        },
        required: ["prompt"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_auth_status": {
        const auth = getCodexAuthState();
        const config = loadConfig();
        return ok({
          mode: auth.mode,
          auth_file_path: auth.authFilePath,
          has_refresh_token: Boolean(auth.refreshToken),
          account_id: auth.accountId,
          config_path: config.config_path,
          default_model: config.default_model,
          default_reasoning_effort: config.default_reasoning_effort,
          last_refresh: auth.lastRefresh,
          default_output_dir: defaultOutputDir(config.default_output_dir),
        });
      }

      case "generate_image": {
        const auth = getCodexAuthState();
        return ok(await runImageGeneration(args || {}, auth, "generate"));
      }

      case "edit_image": {
        const auth = getCodexAuthState();
        return ok(await runImageGeneration(args || {}, auth, "edit"));
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start openai-image-gen-mcp: ${message}`);
  process.exit(1);
});
