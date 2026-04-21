import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../vendor/mcp/openai-image-gen-mcp/src/config.js";
import { resolveAuthStateFromStore } from "../../vendor/mcp/openai-image-gen-mcp/src/auth.js";
import { resolveOutputPaths } from "../../vendor/mcp/openai-image-gen-mcp/src/files.js";
import { PROMPTS, getPromptResult } from "../../vendor/mcp/openai-image-gen-mcp/src/prompts.js";
import {
  prepareImageGenerationRequest,
  runImageGeneration,
} from "../../vendor/mcp/openai-image-gen-mcp/src/openai.js";

function toBase64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function makeJwt(payload) {
  return [
    toBase64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
    toBase64Url(JSON.stringify(payload)),
    toBase64Url("sig"),
  ].join(".");
}

function createChatgptState(overrides = {}) {
  const accessToken = overrides.accessToken
    ? overrides.accessToken
    : makeJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_from_jwt",
        },
        ...overrides.payload,
      });
  const idToken = overrides.idTokenPayload
    ? makeJwt(overrides.idTokenPayload)
    : undefined;

  const raw = {
    tokens: {
      access_token: accessToken,
      refresh_token: overrides.refreshToken ?? "refresh-token",
      ...(idToken ? { id_token: idToken } : {}),
      ...(overrides.accountId ? { account_id: overrides.accountId } : {}),
    },
  };

  return {
    raw,
    state: resolveAuthStateFromStore(raw, overrides.authFilePath || "/tmp/codex-auth.json"),
  };
}

function writeAuthStore(filePath, data) {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function makeResponse(outputFormat = "png") {
  return {
    id: "resp_123",
    output: [
      {
        type: "image_generation_call",
        id: "ig_123",
        status: "completed",
        output_format: outputFormat,
        result: Buffer.from("image-bytes", "utf8").toString("base64"),
      },
    ],
  };
}

describe("openai-image-gen-mcp auth resolution", () => {
  it("falls back to account id encoded in the access token", () => {
    const accessToken = makeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_from_jwt",
      },
    });

    const state = resolveAuthStateFromStore(
      {
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
        },
      },
      "/tmp/codex-auth.json",
    );

    expect(state.mode).toBe("chatgpt");
    expect(state.accountId).toBe("acct_from_jwt");
  });

  it("uses id_token metadata when the access token is opaque", () => {
    const { state } = createChatgptState({
      accessToken: "opaque-access-token",
      idTokenPayload: {
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_from_id_token",
          chatgpt_account_is_fedramp: true,
        },
      },
    });

    expect(state.accountId).toBe("acct_from_id_token");
    expect(state.isFedrampAccount).toBe(true);
  });
});

describe("openai-image-gen-mcp request preparation", () => {
  it("uses config defaults for model and reasoning effort", () => {
    const request = prepareImageGenerationRequest(
      {
        prompt: "Draw a kite",
      },
      "generate",
    );

    expect(request.model).toBe("gpt-5.4");
    expect(request.reasoning).toEqual({ effort: "xhigh" });
  });

  it("allows edit requests backed only by previous_response_id", () => {
    const request = prepareImageGenerationRequest(
      {
        prompt: "Make it look realistic",
        action: "edit",
        previous_response_id: "resp_123",
      },
      "edit",
    );

    expect(request.previous_response_id).toBe("resp_123");
    expect(request.tools[0]).toMatchObject({
      type: "image_generation",
      action: "edit",
    });
  });

  it("creates different default paths for long prompts with the same slug prefix", () => {
    const baseDir = join(tmpdir(), `openai-image-gen-mcp-${Date.now()}-paths`);
    const promptA =
      "Draw a cinematic neon fox silhouette with glowing trails and geometric stars for app art version alpha";
    const promptB =
      "Draw a cinematic neon fox silhouette with glowing trails and geometric stars for app art version beta";

    const [pathA] = resolveOutputPaths({
      outputPath: null,
      baseDir,
      prompt: promptA,
      outputFormat: "png",
      count: 1,
      defaultOutputDir: null,
    });
    const [pathB] = resolveOutputPaths({
      outputPath: null,
      baseDir,
      prompt: promptB,
      outputFormat: "png",
      count: 1,
      defaultOutputDir: null,
    });

    expect(pathA).not.toBe(pathB);
  });

  it("uses output_name for semantic filenames", () => {
    const baseDir = join(tmpdir(), `openai-image-gen-mcp-${Date.now()}-output-name`);
    const [singlePath] = resolveOutputPaths({
      outputPath: null,
      outputName: "asset",
      baseDir,
      prompt: "Draw a hero asset",
      outputFormat: "png",
      count: 1,
      defaultOutputDir: null,
    });
    const multiPaths = resolveOutputPaths({
      outputPath: null,
      outputName: "asset",
      baseDir,
      prompt: "Draw hero asset variants",
      outputFormat: "png",
      count: 2,
      defaultOutputDir: null,
    });

    expect(singlePath).toBe(join(baseDir, "asset.png"));
    expect(multiPaths).toEqual([
      join(baseDir, "asset-1.png"),
      join(baseDir, "asset-2.png"),
    ]);
  });

  it("prefers output_path over output_name", () => {
    const baseDir = join(tmpdir(), `openai-image-gen-mcp-${Date.now()}-precedence`);
    const explicitPath = join(baseDir, "explicit.png");

    const [resolvedPath] = resolveOutputPaths({
      outputPath: explicitPath,
      outputName: "asset",
      baseDir,
      prompt: "Draw a hero asset",
      outputFormat: "png",
      count: 1,
      defaultOutputDir: null,
    });

    expect(resolvedPath).toBe(explicitPath);
  });

  it("ignores invalid output_name when output_path is present", () => {
    const baseDir = join(tmpdir(), `openai-image-gen-mcp-${Date.now()}-precedence-invalid`);
    const explicitPath = join(baseDir, "explicit.png");

    const [resolvedPath] = resolveOutputPaths({
      outputPath: explicitPath,
      outputName: "nested/asset",
      baseDir,
      prompt: "Draw a hero asset",
      outputFormat: "png",
      count: 1,
      defaultOutputDir: null,
    });

    expect(resolvedPath).toBe(explicitPath);
  });
});

describe("openai-image-gen-mcp config", () => {
  it("loads defaults from config.json", () => {
    const config = loadConfig();

    expect(config.default_model).toBe("gpt-5.4");
    expect(config.default_reasoning_effort).toBe("xhigh");
    expect(config.default_output_dir.endsWith(".codex/generated_images")).toBe(true);
  });

  it("uses legacy output-dir env when config omits default_output_dir", () => {
    const root = join(tmpdir(), `openai-image-gen-mcp-${Date.now()}-config-env`);
    mkdirSync(root, { recursive: true });
    const configPath = join(root, "config.json");
    const previousConfigPath = process.env.OPENAI_IMAGE_GEN_CONFIG_PATH;
    const previousOutputDir = process.env.OPENAI_IMAGE_GEN_DEFAULT_OUTPUT_DIR;

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          default_model: "gpt-5.4",
          default_reasoning_effort: "xhigh",
        },
        null,
        2,
      ),
      "utf8",
    );

    process.env.OPENAI_IMAGE_GEN_CONFIG_PATH = configPath;
    process.env.OPENAI_IMAGE_GEN_DEFAULT_OUTPUT_DIR = join(root, "legacy-output");

    try {
      const config = loadConfig();
      expect(config.default_output_dir).toBe(join(root, "legacy-output"));
    } finally {
      if (previousConfigPath === undefined) {
        delete process.env.OPENAI_IMAGE_GEN_CONFIG_PATH;
      } else {
        process.env.OPENAI_IMAGE_GEN_CONFIG_PATH = previousConfigPath;
      }

      if (previousOutputDir === undefined) {
        delete process.env.OPENAI_IMAGE_GEN_DEFAULT_OUTPUT_DIR;
      } else {
        process.env.OPENAI_IMAGE_GEN_DEFAULT_OUTPUT_DIR = previousOutputDir;
      }
    }
  });

  it("uses legacy output-dir env when config file is missing or empty", () => {
    const root = join(tmpdir(), `openai-image-gen-mcp-${Date.now()}-config-empty`);
    mkdirSync(root, { recursive: true });
    const missingConfigPath = join(root, "missing.json");
    const emptyConfigPath = join(root, "empty.json");
    const previousConfigPath = process.env.OPENAI_IMAGE_GEN_CONFIG_PATH;
    const previousOutputDir = process.env.OPENAI_IMAGE_GEN_DEFAULT_OUTPUT_DIR;

    process.env.OPENAI_IMAGE_GEN_DEFAULT_OUTPUT_DIR = join(root, "legacy-output-2");

    try {
      process.env.OPENAI_IMAGE_GEN_CONFIG_PATH = missingConfigPath;
      expect(loadConfig().default_output_dir).toBe(join(root, "legacy-output-2"));

      writeFileSync(emptyConfigPath, "\n", "utf8");
      process.env.OPENAI_IMAGE_GEN_CONFIG_PATH = emptyConfigPath;
      expect(loadConfig().default_output_dir).toBe(join(root, "legacy-output-2"));
    } finally {
      if (previousConfigPath === undefined) {
        delete process.env.OPENAI_IMAGE_GEN_CONFIG_PATH;
      } else {
        process.env.OPENAI_IMAGE_GEN_CONFIG_PATH = previousConfigPath;
      }

      if (previousOutputDir === undefined) {
        delete process.env.OPENAI_IMAGE_GEN_DEFAULT_OUTPUT_DIR;
      } else {
        process.env.OPENAI_IMAGE_GEN_DEFAULT_OUTPUT_DIR = previousOutputDir;
      }
    }
  });
});

describe("openai-image-gen-mcp prompts", () => {
  it("returns the usage guide prompt", () => {
    const result = getPromptResult(PROMPTS.usage_guide.name);

    expect(result.description).toBe(PROMPTS.usage_guide.description);
    expect(result.messages[0].content.text).toContain("parallel");
    expect(result.messages[0].content.text).toContain("output_path");
    expect(result.messages[0].content.text).toContain("output_name");
    expect(result.messages[0].content.text).toContain("base_dir");
  });
});

describe("openai-image-gen-mcp execution", () => {
  it("sends ChatGPT-Account-Id and rewrites output extension to the actual format", async () => {
    const root = join(tmpdir(), `openai-image-gen-mcp-${Date.now()}-header`);
    mkdirSync(root, { recursive: true });

    const { state } = createChatgptState({
      authFilePath: join(root, "auth.json"),
      accessToken: "opaque-access-token",
      idTokenPayload: {
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_from_id_token",
          chatgpt_account_is_fedramp: true,
        },
      },
    });
    const calls = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(makeResponse("png")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const result = await runImageGeneration(
        {
          prompt: "Draw a fox",
          output_path: join(root, "fox.jpg"),
        },
        state,
        "generate",
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(calls[0].init.headers["ChatGPT-Account-Id"]).toBe("acct_from_id_token");
      expect(calls[0].init.headers["X-OpenAI-Fedramp"]).toBe("true");
      expect(result.images[0].saved_path.endsWith(".png")).toBe(true);
      expect(existsSync(result.images[0].saved_path)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses base_dir and a prompt-derived filename when output_path is omitted", async () => {
    const root = join(tmpdir(), `openai-image-gen-mcp-${Date.now()}-base-dir`);
    mkdirSync(root, { recursive: true });

    const { state } = createChatgptState({ authFilePath: join(root, "auth.json") });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () =>
      new Response(JSON.stringify(makeResponse("png")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    try {
      const result = await runImageGeneration(
        {
          prompt: "Draw a bright red kite",
          base_dir: root,
        },
        state,
        "generate",
      );

      expect(result.images[0].saved_path.startsWith(root)).toBe(true);
      expect(result.images[0].saved_path.includes("draw-a-bright-red-kite")).toBe(true);
      expect(result.images[0].saved_path.endsWith(".png")).toBe(true);
      expect(existsSync(result.images[0].saved_path)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refreshes ChatGPT auth and preserves ChatGPT-Account-Id on retry", async () => {
    const root = join(tmpdir(), `openai-image-gen-mcp-${Date.now()}-refresh`);
    mkdirSync(root, { recursive: true });

    const authFilePath = join(root, "auth.json");
    const { raw, state } = createChatgptState({ authFilePath });
    writeAuthStore(authFilePath, raw);

    const refreshedToken = makeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_from_refresh",
      },
    });
    const calls = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });

      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: { message: "expired" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (String(url).includes("auth.openai.com/oauth/token")) {
        expect(init.headers["Content-Type"]).toBe("application/json");
        const body = JSON.parse(String(init.body));
        expect(body.grant_type).toBe("refresh_token");
        expect(body.client_id).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
        expect(body.refresh_token).toBe("refresh-token");
        return new Response(
          JSON.stringify({
            access_token: refreshedToken,
            refresh_token: "refresh-token-2",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(JSON.stringify(makeResponse("png")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const result = await runImageGeneration(
        {
          prompt: "Draw a river",
          output_path: join(root, "river.png"),
        },
        state,
        "generate",
      );

      expect(calls).toHaveLength(3);
      expect(calls[0].init.headers["ChatGPT-Account-Id"]).toBe("acct_from_jwt");
      expect(calls[2].init.headers["ChatGPT-Account-Id"]).toBe(
        "acct_from_refresh",
      );
      expect(result.auth_mode).toBe("chatgpt");
      expect(result.images[0].saved_path.endsWith(".png")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reloads a newer auth snapshot before attempting refresh", async () => {
    const root = join(tmpdir(), `openai-image-gen-mcp-${Date.now()}-reload`);
    mkdirSync(root, { recursive: true });

    const authFilePath = join(root, "auth.json");
    const { raw, state } = createChatgptState({ authFilePath });
    writeAuthStore(authFilePath, raw);

    const reloadedToken = makeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_from_jwt",
      },
    });
    writeAuthStore(authFilePath, {
      tokens: {
        access_token: reloadedToken,
        refresh_token: "refresh-token-newer",
        account_id: "acct_from_jwt",
      },
    });

    const calls = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: { message: "expired" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify(makeResponse("png")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const result = await runImageGeneration(
        {
          prompt: "Draw a comet",
          output_path: join(root, "comet.png"),
        },
        state,
        "generate",
      );

      expect(calls).toHaveLength(2);
      expect(String(calls[1].init.headers.Authorization)).toBe(
        `Bearer ${reloadedToken}`,
      );
      expect(result.images[0].saved_path.endsWith(".png")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects guarded reloads when auth swaps from ChatGPT to API key", async () => {
    const root = join(tmpdir(), `openai-image-gen-mcp-${Date.now()}-swap`);
    mkdirSync(root, { recursive: true });

    const authFilePath = join(root, "auth.json");
    const { raw, state } = createChatgptState({ authFilePath });
    writeAuthStore(authFilePath, raw);
    writeAuthStore(authFilePath, { OPENAI_API_KEY: "sk-test-key" });

    const calls = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ error: { message: "expired" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      await expect(
        runImageGeneration(
          {
            prompt: "Draw a nebula",
            output_path: join(root, "nebula.png"),
          },
          state,
          "generate",
        ),
      ).rejects.toThrow(
        "Codex auth changed on disk and no longer matches the active ChatGPT workspace.",
      );
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
