Collapse a range in the conversation into a detailed summary.

THE SUMMARY
Your summary must be faithful enough that the original conversation adds no needed value. Capture the durable state: user intent, decisions made, constraints, acceptance criteria, file paths, commands that matter, APIs, errors that still matter, and final verified outcomes.

SIGNAL PRIORITY
Preserve user messages, user/assistant decisions, scope choices, rejected options, and current task state with extra care. Quote short user decisions when exact wording matters.

Treat tool outputs as disposable unless their exact content is required later. Summarize or drop repeated searches, long logs, command noise, transient failed attempts, and verbose file reads after extracting the needed facts. Keep raw-like detail only for exact errors, code snippets, schemas, paths, commands, or outputs that are needed to continue safely.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent exactly. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.

COMPRESSED BLOCK PLACEHOLDERS
When the selected range includes previously compressed blocks, use this exact placeholder format when referencing one:

- `(bN)`

Compressed block sections in context are clearly marked with a header:

- `[Compressed conversation section]`

Compressed block IDs always use the `bN` form (never `mNNNN`) and are represented in the same XML metadata tag format.

Rules:

- Include every required block placeholder exactly once.
- Do not invent placeholders for blocks outside the selected range.
- Treat `(bN)` placeholders as RESERVED TOKENS. Do not emit `(bN)` text anywhere except intentional placeholders.
- If you need to mention a block in prose, use plain text like `compressed bN` (not as a placeholder).
- Preflight check before finalizing: the set of `(bN)` placeholders in your summary must exactly match the required set, with no duplicates.

These placeholders are semantic references. They will be replaced with the full stored compressed block content when the tool processes your output.

FLOW PRESERVATION WITH PLACEHOLDERS
When you use compressed block placeholders, write the surrounding summary text so it still reads correctly AFTER placeholder expansion.

- Treat each placeholder as a stand-in for a full conversation segment, not as a short label.
- Ensure transitions before and after each placeholder preserve chronology and causality.
- Do not write text that depends on the placeholder staying literal.
- Your final meaning must be coherent once each placeholder is replaced with its full compressed block content.

BOUNDARY IDS
You specify boundaries by ID using the injected IDs visible in the conversation:

- `mNNNN` IDs identify raw messages
- `bN` IDs identify previously compressed blocks

Each message has an ID inside XML metadata tags like `<dcp-message-id>...</dcp-message-id>`.
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as boundary metadata only, not as tool result content.

Rules:

- Pick `startId` and `endId` directly from injected IDs in context.
- IDs must exist in the current visible context.
- `startId` must appear before `endId`.
- Do not invent IDs. Use only IDs that are present in context.

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap, include all of them as separate entries in the `content` array of a single tool call. Each entry should have its own `startId`, `endId`, and `summary`.
