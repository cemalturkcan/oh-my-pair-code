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
            "Use `generate_image` for new images and `edit_image` for edits. If you need multiple independent images, you may call the MCP tools in parallel, but each call should use a unique `output_path`, or at least a distinct `output_name` when targeting the same folder. Prefer setting `output_path` explicitly in the active workspace or task folder when you know the exact destination. If you know the intended asset name but not the full path, pass `output_name` plus `base_dir`. If you omit both `output_path` and `output_name`, pass `base_dir` for the current task directory and the MCP will generate a prompt-based filename there. Only fall back to the MCP default output directory when no task-relative location is available.",
        },
      },
    ],
  };
}
