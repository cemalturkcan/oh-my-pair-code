# Agent Matrix

## Topology

| Agent | Mode | Character | Model | Variant | Role |
| ----- | ---- | --------- | ----- | ------- | ---- |
| `mrrobot` | `primary` | Mr. Robot | `openai/gpt-5.4-fast` | `high` | Primary agent. Routes work, synthesizes, and gives the final answer. |
| `eliot` | `subagent` | Elliot | `openai/gpt-5.4-fast` | `high` | General subagent for implementation, refactors, repo exploration, and scoped execution. |
| `validator` | `subagent` | Validator | `openai/gpt-5.4-fast` | `high` | Validation-focused pass. Reviews diffs, runs checks, and returns approve/request-changes. |

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
| **validator** | yes | yes | yes | Validation-focused subagent. Review behavior comes from prompt/persona, not harness restrictions. |

The harness does not add per-agent MCP or tool restrictions. There is no delegate lane and no background-agent flow. All subagent work goes through OpenCode Task semantics.

## Workflow

1. Inspect the repo and shape the packet.
2. Route implementation to `eliot` when delegation is useful.
3. Run a `validator` pass after implementation for any non-trivial change.
4. If `validator` requests changes, send the fix back to `eliot`, then run `validator` again.
5. Stop after two repair cycles if risk remains unresolved.

There is no plan mode, `/go`, `/plan`, or `/execute` harness flow.

## Language Policy

- User-facing replies follow the user's language.
- Internal prompts and subagent reports stay in English.
- Code and other durable technical artifacts stay in English.
