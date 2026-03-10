# oh-my-pair-code

`opencode-pair-autonomy` is a lean OpenCode harness for people who want a strong default pair-programming setup without turning their config into a science project.

It gives you a cleaner day-to-day OpenCode workflow:

- `pair` as the default mode for normal collaboration
- `autonomous` when you want the agent to drive a bounded task harder
- a curated agent pack for scouting, research, verification, repair, and architecture work
- bundled MCP defaults and skill-aware prompting out of the box
- install, fresh-install, and uninstall flows that manage the harness without trashing user config

This project is intentionally smaller and easier to reason about than heavier OpenCode setups. The goal is simple: better defaults, less fiddling, faster useful work.

## Why use it

- Pair-first by default: the assistant behaves like a strong coding partner before it behaves like a runaway automator.
- Sensible agent routing: pair, autonomous, scout, research, verify, repair, and architect roles are prewired.
- Good tooling defaults: `context7`, `grep_app`, `websearch`, `chrome-devtools`, `jina`, and bundled local MCPs are ready to go.
- Safe config layering: user config and project config overrides stay supported.
- Easy rollback: uninstall removes harness-managed wiring while preserving user-owned config files.

## Quick start

Install directly from GitHub:

```bash
bunx --bun github:cemalturkcan/oh-my-pair-code install
```

If you want the package source pinned to a fork or alternate repo:

```bash
OPENCODE_PAIR_AUTONOMY_PACKAGE_SPEC=github:your-org/oh-my-pair-code \
  bunx --bun github:your-org/oh-my-pair-code install
```

Install from a local checkout:

```bash
git clone https://github.com/cemalturkcan/oh-my-pair-code.git
cd oh-my-pair-code
bun install
bun run build
bun link
opencode-pair-autonomy install
```

## Commands

```bash
opencode-pair-autonomy install
opencode-pair-autonomy fresh-install
opencode-pair-autonomy uninstall
opencode-pair-autonomy init
opencode-pair-autonomy print-config
```

- `install`: wires the harness into the active OpenCode config.
- `fresh-install`: rebuilds harness-managed files while keeping root config files like `opencode.json`, `opencode.jsonc`, `opencode-pair-autonomy.jsonc`, and `tui.json`.
- `uninstall`: removes harness-managed plugin wiring and package entries, but keeps user-facing config files.
- `init`: creates `.opencode/opencode-pair-autonomy.jsonc` in the current project.
- `print-config`: prints the generated config snippet for inspection.

## What install changes

The installer:

- patches the active OpenCode config and creates backups before writing
- updates the config-dir `package.json` and runs `bun install`
- installs the shell strategy instruction file
- vendors the background-agents plugin locally
- installs bundled `pg-mcp`, `ssh-mcp`, and `sudo-mcp`
- installs bundled skills from this repo
- stores harness settings in `opencode-pair-autonomy.jsonc`

On a normal install, existing MCP config files are preserved.

## What uninstall removes

```bash
opencode-pair-autonomy uninstall
```

Uninstall removes only harness-managed pieces:

- plugin wrapper files
- harness-added plugin entries in `opencode.json`
- the shell strategy instruction entry
- `vendor/opencode-background-agents-local`
- harness-managed package entries from the config-dir `package.json`

It deliberately preserves:

- `opencode-pair-autonomy.jsonc`
- bundled MCP folders under `vendor/mcp`
- `skills/`
- unrelated user config and package entries

## Config files

The harness merges config from:

- `~/.config/opencode/opencode-pair-autonomy.jsonc`
- `<project>/.opencode/opencode-pair-autonomy.jsonc`

Project config wins over user config.

Create a project-local override file with:

```bash
opencode-pair-autonomy init
```

## What you get

Agents:

- `pair`
- `autonomous`
- `repo-scout-fast`, `repo-scout-deep`
- `researcher-fast`, `researcher-deep`
- `builder`, `builder-deep`
- `verifier-fast`, `verifier`
- `repair-fast`, `repair`
- `architect-fast`

Default MCP set:

- `context7`
- `grep_app`
- `websearch`
- `chrome-devtools`
- `pg-mcp`
- `ssh-mcp`
- `sudo-mcp`
- `jina`

Built-in harness behavior:

- intent routing between `pair` and `autonomous`
- todo continuation for unfinished sessions
- comment-quality warnings for suspicious AI-slop edits

## Philosophy

This harness pushes OpenCode toward a more useful default operating mode:

- inspect the repo before deciding
- prefer execution over permission theater
- keep important product choices with the user
- use skills when they improve quality
- keep prompts direct, concrete, and action-oriented
- stay lightweight enough to install, understand, and remove easily
