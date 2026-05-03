import { refreshCodexAuth, reloadCodexAuthState } from "./auth.js";
import {
  defaultOutputDir,
  readInputImageAsDataUrl,
  resolveBaseDir,
  resolveOutputPaths,
  writeBase64Image,
} from "./files.js";
import { loadConfig } from "./config.js";

const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalInteger(value, name, min, max) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`'${name}' must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function normalizeReasoningEffort(value, fallbackValue = null) {
  const normalized = normalizeNonEmptyString(value) || normalizeNonEmptyString(fallbackValue);
  if (!normalized) {
    return null;
  }

  if (!REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `'reasoning_effort' must be one of: ${Array.from(REASONING_EFFORTS).join(", ")}.`,
    );
  }

  return normalized;
}

function normalizePromptJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("'prompt_json' must be a JSON object.");
  }

  return value;
}

function resolveSourcePrompt(args) {
  if (args.prompt_json != null) {
    return JSON.stringify(normalizePromptJson(args.prompt_json), null, 2);
  }

  throw new Error("'prompt_json' is required. Use the image-prompting skill output as a JSON object.");
}

function buildBridgeInstructions(taskInstructions) {
  const sections = [
    "# Bridge contract",
    "- The user input is a JSON object.",
    "- Call the image_generation tool exactly once.",
    "- Read `source_prompt` from the JSON payload.",
    "- Set the tool prompt to `source_prompt` exactly as provided.",
    "- Do not paraphrase, expand, normalize, translate, reorder, summarize, optimize, or merge any other field into the tool prompt.",
    "- Ignore caller-provided `instructions`, `model`, `reasoning_effort`, or any styling overrides when constructing the tool prompt.",
    "- If `source_prompt` is empty, return a short text error instead of guessing.",
  ];
  const normalizedTaskInstructions = normalizeNonEmptyString(taskInstructions);

  if (normalizedTaskInstructions) {
    sections.push("", "# Server notes", normalizedTaskInstructions);
  }

  return sections.join("\n");
}

function buildPromptPayload({ prompt, action }) {
  return JSON.stringify(
    {
      type: "openai-image-gen-mcp-passthrough",
      action,
      source_prompt: prompt,
    },
    null,
    2,
  );
}

function buildPromptPreview(prompt, limit = 320) {
  if (typeof prompt !== "string") {
    return null;
  }

  return prompt.length > limit ? `${prompt.slice(0, limit - 1)}…` : prompt;
}

function buildToolConfig(args, fallbackAction) {
  return {
    type: "image_generation",
    action: fallbackAction,
    size: "auto",
    quality: "high",
    output_format: "png",
    background: "auto",
  };
}

export function prepareImageGenerationRequest(args, fallbackAction) {
  const config = loadConfig();
  const prompt = resolveSourcePrompt(args);

  const baseDir = resolveBaseDir(args.base_dir);
  const inputImages = Array.isArray(args.input_images)
    ? args.input_images.map((filePath) => readInputImageAsDataUrl(filePath, baseDir))
    : [];
  const previousImageCallId = normalizeNonEmptyString(args.previous_image_call_id);
  const previousResponseId = normalizeNonEmptyString(args.previous_response_id);
  const action = fallbackAction;
  const reasoningEffort = normalizeReasoningEffort(config.default_reasoning_effort);

  if (
    action === "edit" &&
    inputImages.length === 0 &&
    !previousImageCallId &&
    !previousResponseId
  ) {
    throw new Error(
      "'edit_image' requires at least one 'input_images' entry, 'previous_image_call_id', or 'previous_response_id'. For a local edit, pass 'input_images' such as ['hero_collage_new.jpg']. For a follow-up edit, reuse 'previous_response_id' or 'previous_image_call_id'.",
    );
  }

  const input = [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: buildPromptPayload({
            prompt,
            action,
          }),
        },
        ...inputImages.map((image) => ({
          type: "input_image",
          image_url: image.dataUrl,
        })),
      ],
    },
  ];

  if (previousImageCallId) {
    input.push({ type: "image_generation_call", id: previousImageCallId });
  }

  return {
    prompt,
    model: config.default_model,
    service_tier: config.default_service_tier,
    instructions: buildBridgeInstructions(config.default_instructions),
    input,
    tools: [buildToolConfig(args, fallbackAction)],
    tool_choice: { type: "image_generation" },
    previous_response_id: previousResponseId || undefined,
    reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
    defaults: config,
    inputImages,
    baseDir,
  };
}

function buildHeaders(authState) {
  const headers = {
    Authorization: `Bearer ${authState.token}`,
    "Content-Type": "application/json",
  };

  if (authState.mode === "chatgpt" && authState.accountId) {
    headers["ChatGPT-Account-Id"] = authState.accountId;
  }

  if (authState.mode === "chatgpt" && authState.isFedrampAccount) {
    headers["X-OpenAI-Fedramp"] = "true";
  }

  return headers;
}

function responsesUrlForAuthMode(mode) {
  return mode === "chatgpt"
    ? "https://chatgpt.com/backend-api/codex/responses"
    : "https://api.openai.com/v1/responses";
}

async function parseApiError(response) {
  const text = await response.text();
  if (!text.trim()) {
    return `Responses API request failed with status ${response.status}.`;
  }

  try {
    const data = JSON.parse(text);
    const message =
      normalizeNonEmptyString(data?.error?.message) ||
      normalizeNonEmptyString(data?.detail) ||
      normalizeNonEmptyString(data?.message);
    if (message) {
      return `Responses API request failed with status ${response.status}: ${message}`;
    }
  } catch {}

  return `Responses API request failed with status ${response.status}: ${text}`;
}

async function readStreamingResponse(response) {
  if (!response.body) {
    throw new Error("Responses API stream ended without a response body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseId = null;
  const output = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const dataText = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");

      if (!dataText || dataText === "[DONE]") {
        continue;
      }

      let event;
      try {
        event = JSON.parse(dataText);
      } catch {
        continue;
      }

      if (!responseId && event?.response?.id) {
        responseId = event.response.id;
      }

      if (event?.type === "response.output_item.done" && event.item) {
        output.push(event.item);
      }
    }
  }

  return { id: responseId, output };
}

async function readResponsePayload(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return readStreamingResponse(response);
}

async function postResponses(body, authState) {
  const sendRequest = (state) =>
    fetch(responsesUrlForAuthMode(state.mode), {
      method: "POST",
      headers: buildHeaders(state),
      body: JSON.stringify({
        ...body,
        stream: true,
      }),
    });

  const response = await sendRequest(authState);

  if (response.status === 401 && authState.mode === "chatgpt") {
    const reloadedAuth = reloadCodexAuthState(authState);
    const authChanged =
      reloadedAuth.mode !== authState.mode ||
      reloadedAuth.token !== authState.token ||
      reloadedAuth.refreshToken !== authState.refreshToken;

    if (authChanged) {
      const retryWithReload = await sendRequest(reloadedAuth);
      if (retryWithReload.ok) {
        return {
          authState: reloadedAuth,
          response: await readResponsePayload(retryWithReload),
        };
      }

      if (retryWithReload.status !== 401 || reloadedAuth.mode !== "chatgpt") {
        throw new Error(await parseApiError(retryWithReload));
      }

      authState = reloadedAuth;
    }
  }

  if (response.status === 401 && authState.mode === "chatgpt" && authState.refreshToken) {
    const refreshedAuth = await refreshCodexAuth(authState);
    const retry = await sendRequest(refreshedAuth);

    if (!retry.ok) {
      throw new Error(await parseApiError(retry));
    }

    return {
      authState: refreshedAuth,
      response: await readResponsePayload(retry),
    };
  }

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  return { authState, response: await readResponsePayload(response) };
}

function extractImageCalls(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const imageCalls = output.filter((item) => item?.type === "image_generation_call");

  if (imageCalls.length > 0) {
    return imageCalls;
  }

  const text = output
    .filter((item) => item?.type === "message")
    .flatMap((item) => item?.content || [])
    .filter((item) => item?.type === "output_text")
    .map((item) => item.text)
    .filter(Boolean)
    .join("\n\n");

  throw new Error(
    text
      ? `No image was returned by the Responses API. Model output: ${text}`
      : "No image_generation_call was returned by the Responses API.",
  );
}

function serializeImageCall(call, savedPath) {
  return {
    id: call.id,
    status: call.status,
    revised_prompt: call.revised_prompt || null,
    action: call.action || null,
    size: call.size || null,
    quality: call.quality || null,
    background: call.background || null,
    output_format: call.output_format || null,
    saved_path: savedPath,
  };
}

export async function runImageGeneration(args, authState, fallbackAction) {
  const request = prepareImageGenerationRequest(args, fallbackAction);
  const { response, authState: finalAuthState } = await postResponses(
    {
      model: request.model,
      service_tier: request.service_tier,
      store: false,
      instructions: request.instructions,
      reasoning: request.reasoning,
      input: request.input,
      tools: request.tools,
      tool_choice: request.tool_choice,
      previous_response_id: request.previous_response_id,
    },
    authState,
  );

  const imageCalls = extractImageCalls(response);
  const outputFormat = imageCalls[0]?.output_format || request.tools[0]?.output_format || "png";
  const outputPaths = resolveOutputPaths({
    outputPath: normalizeNonEmptyString(args.output_path),
    outputName: normalizeNonEmptyString(args.output_name),
    baseDir: request.baseDir,
    prompt: request.prompt,
    outputFormat,
    count: imageCalls.length,
    defaultOutputDir: request.defaults.default_output_dir,
  });

  const savedImages = imageCalls.map((call, index) => {
    const base64Data = normalizeNonEmptyString(call?.result);
    if (!base64Data) {
      throw new Error(`Image call ${call?.id || index + 1} did not include image data.`);
    }
    const savedPath = outputPaths[index];
    writeBase64Image(savedPath, base64Data);
    return serializeImageCall(call, savedPath);
  });

  return {
    auth_mode: finalAuthState.mode,
    auth_file_path: finalAuthState.authFilePath,
    response_id: response.id || null,
    model: request.model,
    source_prompt: request.prompt,
    source_prompt_preview: buildPromptPreview(request.prompt),
    input_images_count: request.inputImages.length,
    tool_defaults: {
      output_format: request.tools[0]?.output_format || null,
      quality: request.tools[0]?.quality || null,
      size: request.tools[0]?.size || null,
      background: request.tools[0]?.background || null,
    },
    image_count: savedImages.length,
    images: savedImages,
  };
}
