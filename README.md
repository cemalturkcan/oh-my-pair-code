# opencode-pair

OpenCode harness with opinionated agent orchestration. One coordinator, eight specialized workers, automatic verification, and risk-based review.

## What it does

- **Yang Wenli** as coordinator — plans, delegates, synthesizes, never asks for routine permission
- Automatic workflow: scout/packetize → implement → verify → repair/re-verify as needed → risk-based review
- Plan/Execute mode switching via `/go` and `/plan` commands
- Session memory with cross-session continuity
- Observation logging and pattern learning
- Comment guard that catches AI-slop in generated code
- Emotion-informed prompt design based on [Anthropic's research](https://www.anthropic.com/research/emotion-concepts-function)

## Agents

| Agent        | Character            | Role                           | Model             |
| ------------ | -------------------- | ------------------------------ | ----------------- |
| **yang**     | Yang Wenli           | Coordinator — plans, delegates | gpt-5.4           |
| **thorfinn** | Thorfinn             | Backend and refactor implementation | gpt-5.3-codex |
| **ginko**    | Ginko                | Web and doc research           | gpt-5.4           |
| **rust**     | Rust Cohle           | Default senior review, faster lane (read-only) | gpt-5.4 |
| **rust_deep**| Rust Deep            | Escalation review, slower/deeper lane (read-only) | gpt-5.4 |
| **spock**    | Spock                | Build, test, lint verification | gpt-5.4           |
| **geralt**   | Geralt of Rivia      | Scoped failure repair          | gpt-5.3-codex |
| **edward**   | Edward Elric         | Frontend, browser testing      | gpt-5.4           |
| **killua**   | Killua Zoldyck       | Fast codebase exploration      | gpt-5.4           |

## MCP Servers

| MCP           | What                                                  | API Key |
| ------------- | ----------------------------------------------------- | ------- |
| `context7`    | Library and framework documentation                   | No      |
| `grep_app`    | GitHub code search across public repos                | No      |
| `searxng`     | Web search (Google/Bing/DDG via self-hosted SearXNG)  | No      |
| `web-agent-mcp` | CloakBrowser — browser testing, screenshots        | No      |
| `pg-mcp`      | PostgreSQL read-only client                           | No      |
| `ssh-mcp`     | Remote command execution on configured SSH hosts      | No      |
| `mariadb`     | MariaDB client                                        | No      |

MCP access is controlled per-agent via `src/prompts/mcp-access.ts` — single source of truth.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) — required for SearXNG (auto-provisioned by installer)

## Quick start

```bash
bunx opencode-pair install
```

The installer will:
1. Wire agents, MCPs, and commands into OpenCode config
2. Install shell strategy instructions
3. Vendor `pg-mcp`, `ssh-mcp`, bundled skills
4. Auto-provision SearXNG Docker container (`--restart unless-stopped`)
5. Enable JSON format in SearXNG settings

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

Workflow defaults are quality-balanced: complex tasks scout first, broad work is packetized into focused changes, verification starts targeted when possible, Rust is the default faster review lane, and Rust Deep is escalation-only for deeper high-risk review.

`workflow.compact_subagent_context` defaults to `true`. It shortens the project-fact line injected into subagent sessions; set it to `false` to keep the longer human-readable format.

## Hooks

| Hook                  | What it does                                                                       |
| --------------------- | ---------------------------------------------------------------------------------- |
| `session.created`     | Prepare session context injection                                                  |
| `chat.message`        | Inject mode, project docs, session memory (coordinator) or project facts (workers) |
| `tool.execute.before` | Plan mode gate, git push build gate, WSL auto-transform                            |
| `tool.execute.after`  | Comment guard, file tracking, compact suggestions                                  |
| `session.idle`        | Save session summary, promote learned patterns, cleanup old sessions               |
| `session.compacting`  | Pre-compact observation snapshot                                                   |

## Architecture

```
src/
├── prompts/
│   ├── mcp-access.ts    # Single source of truth for agent MCP access
│   ├── shared.ts        # Coordinator core, worker cores, response discipline
│   ├── workers.ts       # Per-worker character prompts + MCP guidance
│   └── coordinator.ts   # Worker catalog, delegation, plan mode, workflows
├── agents.ts            # Agent definitions (models, tools, permissions)
├── mcp.ts               # MCP server registration
├── hooks/               # Runtime hooks (plan gate, comment guard, etc.)
├── config.ts            # Config schema + loading
├── installer.ts         # CLI installer
└── index.ts             # Plugin entry point
```
