# openai-image-gen-mcp

Local MCP server that generates or edits images through the OpenAI Responses API while reusing Codex authentication stored in `~/.codex/auth.json`.

The server uses a thin JSON bridge: agents should build the final image prompt before calling this MCP. The tool expects `prompt_json`, serializes it, and forwards `source_prompt` verbatim to the hosted `image_generation` tool without rewriting it.

## Tools

- `get_auth_status` — inspect whether the server can read usable Codex auth
- `generate_image` — generate an image from text
- `edit_image` — edit one or more input images with a text prompt

Both tools expect:

- `prompt_json` — final JSON prompt object from the `image-prompting` skill

`edit_image` requires at least one of:

- `input_images`
- `previous_response_id`
- `previous_image_call_id`

## Prompts

- `usage_guide` — guidance for clients/agents on parallel image generation, unique output paths, and workspace-relative saving

## Auth resolution

The server reads auth in this order:

1. `OPENAI_API_KEY` entry inside Codex `auth.json`
2. `tokens.access_token` inside Codex `auth.json`

When ChatGPT auth is active, requests are sent to `https://chatgpt.com/backend-api/codex/responses`.
When API-key auth is active, requests are sent to `https://api.openai.com/v1/responses`.

If a ChatGPT access token is expired and a refresh token is available, the server refreshes it through `https://auth.openai.com/oauth/token` and writes the updated token back to `auth.json`.

## Environment

- `CODEX_HOME` — override the Codex home directory (default: `~/.codex`)
- `OPENAI_IMAGE_GEN_CONFIG_PATH` — override MCP config path (default: `~/.config/openai-image-gen-mcp/config.json` once installed)
- `CODEX_REFRESH_TOKEN_URL_OVERRIDE` — override token refresh endpoint for testing

## Config

The installer manages a preserved config file at `~/.config/openai-image-gen-mcp/config.json`.

Default values:

- `default_model`: `gpt-5.4`
- `default_reasoning_effort`: `xhigh`
- `default_service_tier`: `priority`
- `default_output_dir`: `~/.codex/generated_images`

Bridge behavior:

- The MCP serializes `prompt_json` into a JSON payload containing `source_prompt`.
- The bridge instructs the hosted model to call `image_generation` exactly once and to use `source_prompt` verbatim.
- Caller-provided `instructions`, `model`, `reasoning_effort`, and prompt-shaping knobs are ignored by the bridge.
- PNG output, high quality, auto size, and auto background are fixed by the server.
- Tool results include the full `source_prompt` plus a short `source_prompt_preview` so callers can verify what was sent.

Output behavior:

- If the agent provides `output_path`, that file path wins.
- If the agent provides `output_name`, the MCP writes into `base_dir` (or the configured default output directory) using that semantic file name.
- If `output_path` and `output_name` are both omitted but `base_dir` is provided, the MCP writes into `base_dir` using a prompt-derived filename with a prompt hash and timestamp.
- If neither is provided, the MCP falls back to `default_output_dir`.

For multiple concurrent generations, use unique `output_path` values when possible. If several images belong in the same folder and already have semantic names, pass distinct `output_name` values. If you rely on `base_dir` + default filenames, the MCP adds a prompt hash and timestamp to reduce collisions.
