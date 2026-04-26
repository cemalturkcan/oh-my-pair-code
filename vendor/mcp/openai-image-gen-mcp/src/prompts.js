export const PROMPTS = {
  usage_guide: {
    name: "usage_guide",
    description:
      "Guidance for using openai-image-gen-mcp with parallel generation and workspace-relative output paths.",
  },
};

export function getPromptResult(name) {
  if (name !== PROMPTS.usage_guide.name) {
    throw new Error(`Unknown prompt: ${name || "<empty>"}`);
  }

  return {
    description: PROMPTS.usage_guide.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Use `generate_image` for new images and `edit_image` for edits. Call the Skill tool directly with name `image-prompting` first, then pass its final JSON object as `prompt_json`. Do not rely on `skill_find` for this path. The bridge serializes `prompt_json` and forwards `source_prompt` verbatim to the hosted image_generation tool without rewriting it. PNG output, high quality, auto size, and auto background are fixed by the server, so do not try to choose model, reasoning, size, compression, or format in tool arguments. `edit_image` needs at least one of `input_images`, `previous_response_id`, or `previous_image_call_id`; if you are editing a local file, pass it in `input_images`. If you need multiple independent images, you may call the MCP tools in parallel, but each call should use a unique `output_path`, or at least a distinct `output_name` when targeting the same folder. `output_path` is a file path, not a directory. Prefer setting `output_path` explicitly when you know the exact destination file. If you know the intended asset name but not the full path, pass `output_name` plus `base_dir`. If you omit both `output_path` and `output_name`, pass `base_dir` for the current task directory and the MCP will generate a prompt-based filename there. Only fall back to the MCP default output directory when no task-relative location is available. After a successful image call, mention the returned `source_prompt_preview` in your reply so the user can see what was sent; include `source_prompt` when they ask for the exact prompt text.",
        },
      },
    ],
  };
}
