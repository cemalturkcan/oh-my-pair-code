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

function buildToolConfig(args, fallbackAction) {
  const tool = {
    type: "image_generation",
    action: normalizeNonEmptyString(args.action) || fallbackAction,
  };

  for (const key of [
    "size",
    "quality",
    "output_format",
    "output_compression",
    "background",
  ]) {
    if (args[key] != null) {
      tool[key] = args[key];
    }
  }

  const partialImages = normalizeOptionalInteger(
    args.partial_images,
    "partial_images",
    0,
    3,
  );
  if (partialImages != null) {
    tool.partial_images = partialImages;
  }

  const outputCompression = normalizeOptionalInteger(
    args.output_compression,
    "output_compression",
    0,
    100,
  );
  if (outputCompression != null) {
    tool.output_compression = outputCompression;
  }

  return tool;
}

export function prepareImageGenerationRequest(args, fallbackAction) {
  const config = loadConfig();
  const prompt = normalizeNonEmptyString(args.prompt);
  if (!prompt) {
    throw new Error("'prompt' is required.");
  }

  const baseDir = resolveBaseDir(args.base_dir);
  const inputImages = Array.isArray(args.input_images)
    ? args.input_images.map((filePath) => readInputImageAsDataUrl(filePath, baseDir))
    : [];
  const previousImageCallId = normalizeNonEmptyString(args.previous_image_call_id);
  const previousResponseId = normalizeNonEmptyString(args.previous_response_id);
  const action = normalizeNonEmptyString(args.action) || fallbackAction;
  const reasoningEffort = normalizeReasoningEffort(
    args.reasoning_effort,
    config.default_reasoning_effort,
  );

  if (
    action === "edit" &&
    inputImages.length === 0 &&
    !previousImageCallId &&
    !previousResponseId
  ) {
    throw new Error(
      "'edit_image' requires at least one 'input_images' entry, 'previous_image_call_id', or 'previous_response_id'.",
    );
  }

  const input = [
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
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
    model: normalizeNonEmptyString(args.model) || config.default_model,
    instructions:
      normalizeNonEmptyString(args.instructions) || config.default_instructions,
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
    image_count: savedImages.length,
    images: savedImages,
  };
}
