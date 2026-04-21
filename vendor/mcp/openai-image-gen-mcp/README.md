# openai-image-gen-mcp

Local MCP server that generates or edits images through the OpenAI Responses API while reusing Codex authentication stored in `~/.codex/auth.json`.

## Tools

- `get_auth_status` — inspect whether the server can read usable Codex auth
- `generate_image` — generate an image from text
- `edit_image` — edit one or more input images with a text prompt

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
- `OPENAI_IMAGE_GEN_DEFAULT_OUTPUT_DIR` — legacy fallback default directory for generated files
- `CODEX_REFRESH_TOKEN_URL_OVERRIDE` — override token refresh endpoint for testing

## Config

The installer manages a preserved config file at `~/.config/openai-image-gen-mcp/config.json`.

Default values:

- `default_model`: `gpt-5.4`
- `default_reasoning_effort`: `xhigh`
- `default_output_dir`: `~/.codex/generated_images`

Output behavior:

- If the agent provides `output_path`, that path wins.
- If the agent provides `output_name`, the MCP writes into `base_dir` (or the configured default output directory) using that semantic file name.
- If `output_path` and `output_name` are both omitted but `base_dir` is provided, the MCP writes into `base_dir` using a prompt-derived filename with a prompt hash and timestamp.
- If neither is provided, the MCP falls back to `default_output_dir`.

For multiple concurrent generations, use unique `output_path` values when possible. If several images belong in the same folder and already have semantic names, pass distinct `output_name` values. If you rely on `base_dir` + default filenames, the MCP adds a prompt hash and timestamp to reduce collisions.
