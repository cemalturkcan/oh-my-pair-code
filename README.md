# opencode-pair

OpenCode harness with a six-agent setup: two primaries, one general subagent, one ideation subagent, one frontend design subagent, and one validation-focused subagent.

## What it does

- **MrRobot** is the primary agent. He routes work and answers plainly.
- **Wick** is the hidden primary executor. Prefix a prompt with `wick!` to route narrow, concrete tasks to him.
- **Eliot** is the general subagent. He handles implementation, refactors, repo exploration, and other scoped task work.
- **Tyrell** is the ideation subagent. It handles brainstorming, naming, UX direction, product ideas, and open-ended exploratory packets.
- **Claude** is the frontend design subagent. He is the default implementation lane for pages, components, styling, layout, and visual polish unless the user explicitly asks for review-only output or no file edits, now on `openai/gpt-5.5-fast` `xhigh` with bundled Impeccable plus stack-aware taste/redesign skills.
- Implementation packets should be edited directly in the repo by the assigned subagent; research, review, and ideation packets should return findings without edits unless edits are explicitly requested.
- Ongoing subagent work should continue with the same `task_id` by default when the lane and workstream still match.
- **Turing** is the validation-focused subagent.
- No plan/execute mode or harness slash-command flow.
- No cross-session memory, pattern learning, or observation logs. Workflow-local task tracking only keeps recent `task_id` hints for continuation inside related sessions.
- Comment guard blocks suspicious AI-style comments before file writes and surfaces anything that still slips through.

## Agents

| Agent | Character | Role | Model |
| ----- | --------- | ---- | ----- |
| **mrrobot** | MrRobot | Primary agent — routes, synthesizes, answers | openai/gpt-5.5-fast |
| **wick** | Wick | Hidden executor — invoke with `wick!` | openai/gpt-5.5-fast |
| **eliot** | Eliot | General-purpose subagent | openai/gpt-5.5-fast |
| **tyrell** | Tyrell | Ideation-focused subagent | openai/gpt-5.5-fast |
| **claude** | Claude | Frontend design subagent | openai/gpt-5.5-fast |
| **turing** | Turing | Validation-focused review and verification | openai/gpt-5.5-fast |

All harness agents use `openai/gpt-5.5-fast` `xhigh`. Wick stays hidden from the visible agent cycle.

## MCP Servers

| MCP | What | API Key |
| --- | ---- | ------- |
| `context7` | Library and framework documentation | No |
| `grep_app` | GitHub code search across public repos | No |
| `searxng` | Web search via self-hosted SearXNG | No |
| `web-agent-mcp` | Browser testing and automation | No |
| `pg-mcp` | PostgreSQL read-only client | No |
| `ssh-mcp` | Remote command execution on configured SSH hosts | No |
| `openai-image-gen-mcp` | Image generation via Codex auth store | No |
| `mariadb` | MariaDB client | No |

Shared managed MCP roots stay under `~/.config/{mcp_name}`.

All six agents receive the same enabled MCP set and the same default full tool access. The harness does not add per-agent MCP or tool restrictions.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) — required for SearXNG (auto-provisioned by installer)

## Quick start

```bash
bunx opencode-pair install
```

The installer will:
1. Wire agents, DCP, and MCPs into OpenCode config
2. Install shell strategy instructions
3. Vendor `pg-mcp`, `ssh-mcp`, `web-agent-mcp`, `openai-image-gen-mcp`, and bundled skills (including Impeccable plus taste/redesign skills for Claude)
4. Install dependencies inside each shared managed MCP root
5. Auto-provision SearXNG Docker container (`--restart unless-stopped`, `127.0.0.1:8099:8080`)
6. Enable JSON format in SearXNG settings

DCP is installed with a GPT-5.5-fast-aware config: 400k total budget means 272k input + 128k output; soft reminders start at 170k, hard compression nudges start at 258k to leave input/output headroom and avoid native compaction pressure. DCP prompt overrides preserve user decisions and task intent while treating stale tool output as low-signal disposable context.

From source:

```bash
git clone https://github.com/cemalturkcan/opencode-pair.git
cd opencode-pair
bun install && bun run build && bun link
opencode-pair install
```

## Commands

```bash
opencode-pair install        # wire into OpenCode config
opencode-pair fresh-install  # rebuild harness files, keep user config
opencode-pair uninstall      # remove harness wiring
opencode-pair init           # create project-local config
opencode-pair print-config   # inspect generated config
```

## Config

Merges from two layers (project wins):

- `~/.config/opencode/opencode-pair.jsonc` — user-level
- `<project>/.opencode/opencode-pair.jsonc` — project-level

Create project config:

```bash
opencode-pair init
```

`workflow.compact_subagent_context` defaults to `true`. It shortens the project-fact line injected into subagent sessions; set it to `false` to keep the longer human-readable format.

## Hooks

| Hook | What it does |
| ---- | ------------ |
| `chat.message` | Route `wick!` prompts to hidden Wick on `openai/gpt-5.5-fast` `xhigh`; inject project docs, WSL notes, and active subagent task IDs for primaries; inject compact project facts for Eliot, Tyrell, Claude, and Turing |
| `tool.execute.before` | Block suspicious AI-style comments before writes, enforce git-push build gate, auto-transform Node commands on WSL |
| `tool.execute.after` | Surface suspicious comments that still remain after a write; capture subagent task IDs for continuation hints |
| `session.deleted` | Clear ephemeral runtime state |

`hooks.task_tracking` defaults to `true` and controls task-id capture plus primary-session continuation hints.

## Architecture

```
src/
├── prompts/
│   ├── mcp-access.ts    # Enabled MCP list and prompt guidance
│   ├── shared.ts        # Shared prompt rules and response style
│   ├── workers.ts       # Eliot, Tyrell, Claude, and Turing prompt builders
│   └── coordinator.ts   # MrRobot and Wick prompt builders plus routing rules
├── agents.ts            # Agent definitions (models and prompts)
├── mcp.ts               # MCP server registration
├── hooks/               # Runtime hooks (comment guard, WSL, cleanup)
├── config.ts            # Config schema + loading
├── installer.ts         # CLI installer
└── index.ts             # Plugin entry point
```
