# opencode-pair

OpenCode Mission Control harness with a ledger-backed orchestration system: one primary orchestrator, scoped workers, durable task state, blockers, sync/recovery helpers, and acceptance gates.

## What it does

- **Mission Control** is the primary orchestrator. It decomposes missions, owns the ledger, delegates scoped work, aggregates blockers, and refuses final success until the gate passes.
- Mission Control can plan, inspect, edit, run commands, or delegate directly according to the user's request and task scope.
- **Implementation Engineer** handles backend, tooling, refactors, bug fixes, docs, and scoped repo implementation.
- **Frontend Engineer** handles pages, components, layout, styling, responsive behavior, and UI polish.
- **Repository Scout** performs read-only repo exploration and pattern finding.
- **Research Analyst** handles external docs, web, official sources, and source-backed research.
- **Verification Engineer** checks acceptance evidence, runs safe local/sandbox verification, and returns approve/request-changes gate reports.
- Durable mission state lives in a user-level SQLite store by default, such as `$XDG_STATE_HOME/opencode-pair/orchestrator.sqlite` or `~/.local/state/opencode-pair/orchestrator.sqlite` on Linux. Project repos do not store raw project DBs; they track only the plain-text `.opencode/orch.txt` identity marker.
- Mission Control uses orchestration tools and worker delegation for normal workflow, while harness permissions remain open enough for safe inspection and recovery.
- Workers can spawn other workers when delegation helps complete the assigned packet. They publish structured reports, artifacts, context bundles, blockers, and verification evidence to the ledger.
- Writer workers use task file scopes as guidance.
- Comment guard blocks suspicious AI-style comments before file writes and surfaces anything that still slips through.

## Agents

| Agent | Mode | Role | Model | Variant |
| ----- | ---- | ---- | ----- | ------- |
| **mission-control** | primary | Top-level orchestrator — mission decomposition, ledger state, delegation, blockers, acceptance gate, final synthesis | openai/gpt-5.5-fast | xhigh |
| **implementation-engineer** | subagent | Scoped implementation worker | openai/gpt-5.5-fast | low |
| **frontend-engineer** | subagent | Frontend/UI implementation worker | openai/gpt-5.5-fast | low |
| **repo-scout** | subagent | Read-only repository exploration worker | openai/gpt-5.5-fast | low |
| **research-analyst** | subagent | External research and documentation worker | openai/gpt-5.5-fast | low |
| **verification-engineer** | subagent | Acceptance gate and verification worker | openai/gpt-5.5-fast | xhigh |

All harness agents use fast model IDs. Mission Control and Verification Engineer use `openai/gpt-5.5-fast` `xhigh`; implementation, frontend, scout, and research workers use `openai/gpt-5.5-fast` `low`.

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

MCP availability is configured globally. Agent permission maps allow normal tool access, and project-level worker-spawn, secret-write, destructive git/output-write, guard-preflight, and dangerous external side-effect blocks are disabled.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) — required for SearXNG (auto-provisioned by installer)

## Quick start

```bash
bunx opencode-pair install
```

Interactive terminals ask whether to configure an optional private ledger sync repo when no sync repo/path/url is already configured in user config or `OPENCODE_PAIR_SYNC_REPO` / `OPENCODE_PAIR_SYNC_PATH`, and no durable checkout can be recovered from `$XDG_STATE_HOME/opencode-pair/sync`. The prompt defaults to No and accepts either a Git remote URL (`https://`, `ssh://`, `git://`, or `git@host:owner/repo.git`) or a local filesystem path. URL answers are saved as `orchestration.sync.repo` and use a deterministic user-state checkout path such as `$XDG_STATE_HOME/opencode-pair/sync`; local path answers are saved as `orchestration.sync.path`. If `~/.config/opencode` is deleted but that durable checkout remains, install reads the checkout's `origin` remote and current branch, rewrites `~/.config/opencode/opencode-pair.jsonc`, and skips the sync prompt. After a URL answer, interactive install automatically prepares that local checkout on the configured branch or `main` without a second confirmation. It first tries `GIT_TERMINAL_PROMPT=0 git clone <repo> <path>`; when the remote is empty or has no default/main branch, it initializes the local checkout, adds `origin`, switches to the branch, creates/copies `orchestrator.sqlite`, commits `checkpoint ledger`, and pushes `origin <branch>`. Git failures are warnings with manual fallback guidance, not fatal install errors. Existing sync paths are never overwritten; an existing git checkout is reused, and an existing non-git path is reported for manual cleanup. Existing or recovered sync config skips sync setup, including `--configure-sync`, so reinstall/update reuses the already configured ledger repo without asking again. CI, non-TTY, and piped installs never prompt, clone, initialize, commit, push, or wait for input; use `--no-prompt` to force prompt-free behavior. After managed `web-agent-mcp` code/dependency install, the installer writes a Linux user service at `~/.config/systemd/user/opencode-pair-web-agent.service` when `systemctl --user` is available, runs `daemon-reload`, `enable`, and `restart`, and does not delete the durable browser profile or daemon registry. If user systemd is unavailable, install continues and starts the daemon detached for the current session.

The installer will:
1. Wire Mission Control agents, orchestration tools, hooks, and MCPs into OpenCode config
2. Install shell strategy instructions
3. Vendor `pg-mcp`, `ssh-mcp`, `web-agent-mcp`, `openai-image-gen-mcp`, and bundled skills used by frontend/design-related tasks
4. Install dependencies inside each shared managed MCP root
5. Auto-provision SearXNG Docker container (`--restart unless-stopped`, `127.0.0.1:8099:8080`)
6. Enable JSON format in SearXNG settings

The install step does not put a SQLite ledger database in your project repository. Runtime ledger state defaults to the global user state path. For stable cross-machine project identity, add and commit `.opencode/orch.txt`; that marker is plain text and must not contain secrets, private sync repo URLs, or machine-local absolute paths.

From source:

```bash
git clone https://github.com/cemalturkcan/opencode-pair.git
cd opencode-pair
bun install && bun run build && bun link
opencode-pair install
```

## Commands

```bash
opencode-pair install                  # wire into OpenCode config; prompt for sync only if missing and interactive
opencode-pair install --configure-sync # ask for sync setup only when missing and interactive
opencode-pair install --no-prompt      # never prompt, safe for pipes/CI
opencode-pair fresh-install            # rebuild harness files, keep user config
opencode-pair uninstall                # remove harness wiring
opencode-pair init                     # create project-local config
opencode-pair print-config             # inspect generated config
```

Web-agent daemon autostart on Linux uses the user systemd unit `opencode-pair-web-agent.service` when available:

```bash
systemctl --user status opencode-pair-web-agent.service
systemctl --user restart opencode-pair-web-agent.service
systemctl --user disable --now opencode-pair-web-agent.service
```

The service runs `bun run daemon` from the managed `web-agent-mcp` root, binds locally, and preserves the managed browser profile and registry. On systems without a working user systemd session, start it manually with `cd ~/.config/web-agent-mcp && bun run daemon`.

Installed OpenCode slash commands are routed to `mission-control` and use the durable orchestration ledger:

| Command | Use |
| --- | --- |
| `/orchestrate <request>` | Create or resume a Mission Control mission, run planning when needed, delegate or execute scoped work, then gate final success. |
| `/mission-status` | Show active mission status, blockers, verification state, and gate state. |
| `/mission-blockers` | Show unresolved blockers or gate failures that need user action. |
| `/orchestrator-sync` | Show the configured private ledger sync status, manual command template, lifecycle policy, and conflict recovery guidance; status-only and side-effect-free. |
| `/project-status` | Resolve the current project/session and show active or recent sessions, tasks, blockers, and Mission Control next actions. |
| `/task-current` | Show the current durable OpenCode session and linked task context. |
| `/project-tasks <filter>` | List or search project backlog and mission tasks for resume planning. |
| `/resume-task <task_id>` | Attach the current OpenCode session to a durable project/task/mission, then verify current task context and continue the work. |
| `/context-search <query>` | Search ledger context for the current project/task and compact it when a handoff is needed. |

These commands are prompts/templates, not direct ledger mutations by the user. Mission Control remains the orchestrator and final gate owner: it resolves projects with `orchestrator_project_resolve`, attaches or reads sessions with `orchestrator_session_attach/current`, inspects tasks with `orchestrator_get_current_task` and `orchestrator_project_tasks`, searches or compacts context with `orchestrator_context_search/compact`, and runs `orchestrator_gate_check` before final success.

## Direct scoped execution

Mission Control may create/resume a mission, inspect the repo, run commands, edit files, or delegate to workers when that is the fastest way to complete the request. Writer work does not wait on a project-level approval-first gate when it is already in scope. Workers may also spawn workers when delegation helps finish their assigned packet.

## Project/session resume workflow

The ledger models work as projects, OpenCode sessions, missions, and tasks. On a new chat, Mission Control resolves the current repository project and attaches the OpenCode session. Worker sessions are linked to their assigned task and publish reports, artifacts, context, blockers, and verification evidence directly to the ledger.

Typical resume flow:

1. Run `/project-status` to identify the current project, active sessions, active mission, blockers, and recent tasks.
2. Run `/project-tasks <keyword or status>` when you need to choose a backlog or mission task.
3. Run `/resume-task <task_id>` to attach the current OpenCode session to the selected task.
4. Run `/task-current` to confirm the durable task/session context before continuing work.
5. Run `/context-search <topic>` when a compact handoff or prior decision/evidence summary is needed.

Raw SQLite ledger state lives in the user-level state directory. New projects should not commit `.opencode/state/orchestrator.sqlite`, WAL, or SHM files.

### Raw SQLite private sync mode

Power users may sync the raw global ledger database through a private Git repo or another private file-sync workflow. Treat this as single-writer state: close OpenCode before committing the ledger, pull before opening OpenCode on another PC, and never run two machines against the same synced ledger concurrently. SQLite WAL mode creates `orchestrator.sqlite-wal` and `orchestrator.sqlite-shm`; close OpenCode so WAL data is checkpointed before committing, and do not hand-edit or merge these binary files. If a binary conflict occurs, preserve both sides, dry-run reconcile, inspect conflicts, write a merged DB only to an explicit new output path, then deliberately replace the active DB or commit the merged DB.

Sync is opt-in and safe by default. Configure the private repo/path in user config, through the installer's default missing-config prompt, with `install --configure-sync`, or with environment variables, not in the tracked project marker and not with embedded secrets. Use `repo` for a Git remote URL and `path` for the local checkout. If `repo` is a URL and `path` is omitted, helpers use the user-state default local checkout path (`$XDG_STATE_HOME/opencode-pair/sync` or platform equivalent) instead of resolving the URL under the project directory. Interactive install prepares that checkout immediately after saving URL config and can bootstrap an empty remote by initializing `main`, adding an initial ledger checkpoint, and pushing it. Non-interactive installs only print recovery guidance and never clone/init/commit/push. The installer prompt writes sync repo settings only to the user-level harness config (`~/.config/opencode/opencode-pair.jsonc` or `OPENCODE_CONFIG_DIR/opencode-pair.jsonc`), never to `.opencode/orch.txt` or other tracked project files:

```jsonc
{
  "orchestration": {
    "sync": {
      "enabled": true,
      "repo": "https://example.com/private-ledger-sync.git",
      "path": "/path/to/private-ledger-sync",
      "branch": "main"
    }
  }
}
```

`OPENCODE_PAIR_SYNC_REPO` or `OPENCODE_PAIR_SYNC_PATH` can also point at the private sync repo, and `OPENCODE_PAIR_SYNC_BRANCH` can override the branch. `/orchestrator-sync` calls `orchestrator_sync_status`, which is side-effect-free: it reports disabled/not_configured/missing_repo/ready, prints optional recovery/debug status/pull/checkpoint/push templates, and never runs git or mutates the DB. When a sync repo is configured, OpenCode/session start performs a bounded, non-interactive best-effort `git pull --ff-only origin <branch>`, and clean session exit checkpoints/copies `orchestrator.sqlite`, commits only when changed, and pushes best-effort. Checkpoint phase in the status helper is status-only/no git mutation; exit handles the push. When local/remote row snapshots are available, `orchestrator_sync_reconcile_plan` can compare them and return a deterministic merged snapshot plus conflicts without modifying either input. For real SQLite snapshots, `orchestrator_sync_reconcile_files` opens `local_db_path` and `remote_db_path` read-only, exports ledger rows into the same reconcile engine, returns suggested names like `local.<timestamp>.sqlite`, `remote.<timestamp>.sqlite`, `merged.<timestamp>.sqlite`, and `conflicts.<timestamp>.json`, and writes merged output only when given `dry_run=false` plus an explicit distinct `output_db_path`. Non-conflicting rows auto-merge; append-only records are preserved with dedupe; unresolved blockers, reopened/needs-verification tasks, request-changes verification, and blocked/active missions win over unsafe done/approve defaults. True same-id/different-content conflicts report local and remote values with explicit resolution options instead of overwriting silently. Remote active sessions are ended in local merge plans. Lifecycle policy is explicit: pull/replay at session start before attaching/resuming, status-only checkpoint inspection after mission or task changes, best-effort session-end push only after OpenCode is closed or WAL has checkpointed, and crash recovery starts with pull/status plus backups, dry-run SQLite reconcile, conflict inspection, explicit merged output, then a deliberate manual active-DB replacement or commit.

Project identity is stable across PCs through git-tracked `.opencode/orch.txt` when present. It is plain line-oriented text, for example `version=1`, `project_key=project:my-repo`, `name=My Repo`, and `repo_fingerprint=git:https://example/repo#main`. When no marker exists, the ledger falls back to a local git fingerprint from `.git/config` `origin` plus `HEAD` without shelling out. Absolute `root_path` is machine-local: project resolution prefers `project_key` or git fingerprint, then records the current machine's root alias so `/home/alice/repo` and `/Users/alice/code/repo` map to the same synced project. Sessions include a local `machine_id`; synced sessions from another PC are not treated as live local runtime state.

## Config

Merges from two layers (project wins):

- `~/.config/opencode/opencode-pair.jsonc` — user-level
- `<project>/.opencode/opencode-pair.jsonc` — project-level

Create project config:

```bash
opencode-pair init
```

`workflow.compact_worker_context` defaults to `true`. It shortens the project-fact line injected into worker sessions; set it to `false` to keep the longer human-readable format.

`orchestration.ledger_path` is optional and defaults to the user-level state DB; set it only for tests or advanced overrides. `orchestration.project_marker_path` defaults to `.opencode/orch.txt`. `orchestration.sync` is optional and defaults to disabled; any configured private sync repo/path enables the automatic start-pull and clean-exit push lifecycle. Configure sync only in user config, through the interactive install prompt, with `install --configure-sync`, or with `OPENCODE_PAIR_SYNC_REPO` / `OPENCODE_PAIR_SYNC_PATH` plus optional `OPENCODE_PAIR_SYNC_BRANCH`, never in `.opencode/orch.txt`.

## Hooks

| Hook | What it does |
| ---- | ------------ |
| `chat.message` | Inject compact Mission Control ledger snapshots and task-scoped worker packets |
| `tool.execute.before` | Apply WSL Node command transforms |
| `tool.execute.after` | Surface suspicious comments that still remain after a write; link delegated worker sessions to ledger tasks |
| `experimental.session.compacting` | Preserve compact ledger mission state, blockers, decisions, verification state, and next actions across compaction |
| `session.deleted` | Clear ephemeral runtime state |

`hooks.task_tracking` defaults to `true` and controls delegated worker session-to-ledger task linking.

### Guard manifest and preflight

Project-level guard restrictions are disabled. `orchestrator_guard_manifest` and `orchestrator_guard_preflight` remain available as introspection helpers, but they do not block git writes, output writes, pathless edits, secret/env paths, worker spawning, or external side effects. `orchestrator_secret_env_write` writes the requested env file and returns redacted key/count/hash evidence.

## Architecture

```
src/
├── prompts/
│   ├── mcp-access.ts    # Enabled MCP list and prompt guidance
│   ├── shared.ts        # Shared prompt rules and response style
│   ├── workers.ts       # Worker prompt builders and structured report contracts
│   └── mission-control.ts # Mission Control prompt builder plus gate/delegation rules
├── orchestrator/        # SQLite ledger, orchestration tool schemas, agent constants
├── agents.ts            # Agent definitions (models and prompts)
├── mcp.ts               # MCP server registration
├── hooks/               # Runtime hooks (comment guard, WSL, cleanup)
├── config.ts            # Config schema + loading
├── installer.ts         # CLI installer
└── index.ts             # Plugin entry point
```
