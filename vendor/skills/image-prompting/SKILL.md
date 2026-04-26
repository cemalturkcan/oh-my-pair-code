---
name: image-prompting
description: Build high-quality image generation and edit prompts from user intent using prompt structures proven across prompts.chat examples and OpenAI image prompting guidance.
---

## Purpose

Use this skill before calling image-generation tools. Turn vague requests into a strong, production-ready **JSON prompt object** without relying on downstream tool rewriting.

## Use When

- The task is to generate or edit an image
- The workflow uses `openai-image-gen-mcp`, OpenAI image APIs, or another image model
- The user gave a rough concept, moodboard, or partial art direction
- The request needs identity preservation, layout control, typography, or multi-image composition

## Core Rule

Build the final prompt **before** the MCP/tool call.

For `openai-image-gen-mcp`, output a **single JSON object** and pass it as `prompt_json`. Do not hand the MCP a loose prose prompt when this skill is available.

Call the Skill tool directly with name `image-prompting` for this workflow. Do not rely on `skill_find` for this path.

## Patterns Seen Across High-Performing Examples

Common winning ingredients from the prompts.chat IMAGE dataset and OpenAI image prompting docs:

1. **Subject clarity** — who/what is on screen
2. **Scene / environment** — where it happens
3. **Composition / framing** — crop, angle, panel layout, negative space
4. **Camera / lens / shot feel** — especially for photoreal work
5. **Lighting** — direction, softness, time of day, studio vs natural
6. **Style / realism target** — editorial, infographic, film still, clay, isometric, etc.
7. **Constraints** — preserve lists, no-text/no-logo/no-watermark, exact layout rules
8. **Negative prompt / avoid list** — artifacts, unwanted style drift, anatomy failures
9. **Output rules** — aspect ratio, grid size, number of panels, exact text handling

## Required Output Shape

Always return a JSON object with this shape:

```json
{
  "goal": "",
  "subject": "",
  "scene": "",
  "composition": "",
  "camera": "",
  "lighting": "",
  "style": "",
  "details": [],
  "constraints": [],
  "negative_prompt": []
}
```

Optional fields when needed:

```json
{
  "text_in_image": "",
  "preserve": [],
  "change": [],
  "output_rules": []
}
```

Rules:
- Keep every value concise and specific.
- Use arrays for lists, not long paragraphs.
- Omit optional fields when empty.
- Do not wrap the JSON in markdown fences unless explicitly asked.

## New Image Workflow

Fill the JSON in this order:

1. `goal`
2. `subject`
3. `scene`
4. `composition`
5. `camera`
6. `lighting`
7. `style`
8. `details`
9. `constraints`
10. `negative_prompt`
11. `output_rules` if needed

## Edit Workflow

For edits, you MUST separate **what changes** from **what stays locked**.

Use these JSON fields:

```json
{
  "change": ["what to transform"],
  "preserve": ["what must remain exact"],
  "constraints": ["change only X", "keep everything else the same"]
}
```

## Identity-Preserving Edits

When the prompt uses reference people or products:

- Say **preserve identity exactly** or **preserve core likeness**
- Name what must remain fixed: face, age range, skin tone, body shape, hairstyle, expression, pose, outfit geometry, label text, product silhouette
- If multiple subjects exist, anchor them explicitly: Person A, Person B, center tile, left-most subject, etc.

## Typography in Images

- Put exact text in quotes
- Say `EXACT`, `verbatim`, or `appears once`
- Specify placement, font feel, contrast, and readability requirements
- If text fidelity matters, keep wording short and constraints explicit

## Composition Rules Worth Calling Out Explicitly

- panel counts and grid shape
- subject placement
- negative space for UI overlays
- crop behavior on mobile
- what must remain centered / untouched / duplicated

## Negative Constraints

Use negative constraints whenever realism or polish matters. Typical items:

- no logos
- no watermark
- no extra text
- no duplicated faces
- no extra limbs
- no distorted hands
- no warped perspective
- no CGI look
- no cartoon style

## Output Discipline

- Do not invent brand requirements the user did not ask for
- Do not add style names, logos, or objects unless requested
- Keep prompts self-contained
- Prefer exactness over flourish when the user already gave strong art direction

## Fast Heuristics

- **Simple ask** → concise prose prompt
- **Portrait / selfie / editorial** → include camera, lighting, skin/detail realism, framing
- **Identity edit** → preserve list + change list + negatives
- **Infographic / board / grid** → structured spec with layout rules
- **Product / food** → material realism, lighting, background discipline, commercial cleanliness

## MCP Handoff Rule

When the target tool is `openai-image-gen-mcp`:

- Return only the final `prompt_json` object for the handoff.
- Do not also produce a second prose version unless explicitly requested.
- Assume the MCP bridge will serialize your JSON and forward it verbatim.
- Therefore your JSON must already be complete, self-contained, and ready to pass through.

## Final Check Before Tool Call

1. Is the subject unambiguous?
2. Is the scene clear?
3. Is the composition specified?
4. Are the constraints explicit?
5. If this is an edit, did I separate `change` vs `preserve`?
6. If text appears in the image, is it exact and quoted inside the relevant field?
7. Would this JSON still make sense if passed through with zero rewriting?
