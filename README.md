# opencode-pair

OpenCode harness with a three-agent setup: one primary, one general subagent, one validation-focused subagent.

## What it does

- **MrRobot** is the primary agent. He routes work and answers plainly.
- **Eliot** is the general subagent. He handles implementation, refactors, repo exploration, and other scoped task work.
- **Validator** is the validation-focused subagent. It reviews changes again after implementation and can also execute work when routed.
- No plan/execute mode or harness slash-command flow.
- No session memory, pattern learning, observation logs, or cross-session state injection.
- Comment guard blocks suspicious AI-style comments before file writes and surfaces anything that still slips through.

## Agents

| Agent | Character | Role | Model |
| ----- | --------- | ---- | ----- |
| **mrrobot** | Mr. Robot | Primary agent — routes, synthesizes, answers | openai/gpt-5.4-fast |
| **eliot** | Elliot | General-purpose subagent | openai/gpt-5.4-fast |
| **validator** | Validator | Validation-focused review and verification | openai/gpt-5.4-fast |

All three use the `high` variant.

## MCP Servers

| MCP | What | API Key |
| --- | ---- | ------- |
| `context7` | Library and framework documentation | No |
| `grep_app` | GitHub code search across public repos | No |
| `searxng` | Web search via self-hosted SearXNG | No |
| `web-agent-mcp` | Browser testing and automation | No |
| `pg-mcp` | PostgreSQL read-only client | No |
| `ssh-mcp` | Remote command execution on configured SSH hosts | No |
| `mariadb` | MariaDB client | No |

Shared managed MCP roots stay under `~/.config/{mcp_name}`.

All three agents receive the same enabled MCP set and the same default full tool access. The harness does not add per-agent MCP or tool restrictions.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) — required for SearXNG (auto-provisioned by installer)

## Quick start

```bash
bunx opencode-pair install
```

The installer will:
1. Wire agents and MCPs into OpenCode config
2. Install shell strategy instructions
3. Vendor `pg-mcp`, `ssh-mcp`, `web-agent-mcp`, and bundled skills
4. Install dependencies inside each shared managed MCP root
5. Auto-provision SearXNG Docker container (`--restart unless-stopped`)
6. Enable JSON format in SearXNG settings

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
| `chat.message` | Inject project docs and WSL notes for MrRobot; inject compact project facts for subagents |
| `tool.execute.before` | Block suspicious AI-style comments before writes, enforce git-push build gate, auto-transform Node commands on WSL |
| `tool.execute.after` | Surface suspicious comments that still remain after a write |
| `session.deleted` | Clear ephemeral runtime state |

## Architecture

```
src/
├── prompts/
│   ├── mcp-access.ts    # Enabled MCP list and prompt guidance
│   ├── shared.ts        # Shared prompt rules and response style
│   ├── workers.ts       # Eliot + validator prompt builders
│   └── coordinator.ts   # MrRobot prompt and routing rules
├── agents.ts            # Agent definitions (models and prompts)
├── mcp.ts               # MCP server registration
├── hooks/               # Runtime hooks (comment guard, WSL, cleanup)
├── config.ts            # Config schema + loading
├── installer.ts         # CLI installer
└── index.ts             # Plugin entry point
```
