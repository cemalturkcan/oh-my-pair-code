# Agent Matrix

## Topology

| Agent | Mode | Character | Model | Variant | Role |
| ----- | ---- | --------- | ----- | ------- | ---- |
| `mrrobot` | `primary` | MrRobot | `openai/gpt-5.5-fast` | `medium` | Primary agent. Routes work, synthesizes, and gives the final answer. |
| `eliot` | `subagent` | Eliot | `openai/gpt-5.5-fast` | `low` | General subagent for implementation, refactors, repo exploration, and scoped execution. |
| `tyrell` | `subagent` | Tyrell | `openai/gpt-5.5-fast` | `low` | Ideation-focused subagent for brainstorming, naming, UX direction, and exploratory packets. |
| `claude` | `subagent` | Claude | `openai/gpt-5.5-fast` | `low` | Frontend design subagent. Owns layout, styling, visual hierarchy, responsive UX, and UI polish, and defaults to bundled Impeccable plus stack-aware taste/redesign skills. |
| `turing` | `subagent` | Turing | `openai/gpt-5.5-fast` | `xhigh` | Validation-focused pass. Reviews diffs, runs checks, and returns approve/request-changes. |

## MCP Model

Defined in `src/prompts/mcp-access.ts`.

- MCP availability is configured globally through harness config toggles.
- All agents receive the same enabled MCP set.
- Managed local MCPs run from shared roots under `~/.config/{mcp_name}` with their own dependencies installed there.

## Task and Permission Model

| Agent | Can spawn subagents? | Can edit files? | Can use bash? | Notes |
| ----- | -------------------- | --------------- | -------------- | ----- |
| **mrrobot** | yes | yes | yes | Primary agent. Uses real OpenCode `primary` mode. |
| **eliot** | yes | yes | yes | General-purpose subagent. Uses real OpenCode `subagent` mode. |
| **tyrell** | yes | yes | yes | Ideation-focused subagent. Uses real OpenCode `subagent` mode. |
| **claude** | yes | yes | yes | Frontend design subagent. Frontend-only behavior comes from prompt/persona, not harness restrictions. |
| **turing** | yes | yes | yes | Validation-focused subagent with the Turing persona. Review behavior comes from prompt/persona, not harness restrictions. |

The harness does not add per-agent MCP or tool restrictions. There is no delegate lane and no background-agent flow. All subagent work goes through OpenCode Task semantics.

## Workflow

1. Inspect the repo and shape the packet.
2. Mark delegated packets as implementation, research, review, or ideation.
3. Route implementation to `eliot` when delegation is useful, and have Eliot edit the repo directly unless the packet is explicitly review-only or no-file-edit.
4. Route frontend design, layout, styling, and UI polish work to `claude` by default unless the user explicitly asks for review-only output or no file edits.
5. Reuse the same subagent `task_id` by default when the lane and workstream are continuing.
6. Run a `turing` pass after implementation for any non-trivial change.
7. If `turing` requests changes, send the fix back to the implementation lane, then run `turing` again.
8. Stop after two repair cycles if risk remains unresolved.

There is no plan mode, `/go`, `/plan`, or `/execute` harness flow.

## Language Policy

- User-facing replies follow the user's language.
- Internal prompts and subagent reports stay in English.
- Code and other durable technical artifacts stay in English.
