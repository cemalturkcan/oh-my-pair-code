# opencode-pair-autonomy

A lean OpenCode harness plugin inspired by `oh-my-opencode`, but tuned for a simpler workflow:

- `pair` as the default collaborative agent
- `autonomous` as the checkpointed autonomous agent
- GPT for user-facing and implementation-critical agents
- Kimi for token-heavy scout/research/fast-verification paths
- skill-aware prompting
- curated MCP defaults (`context7`, `grep_app`, `websearch`)
- lightweight config loader with project and user overrides
- built-in hooks for intent routing, todo continuation, and anti-slop comment warnings

This project is intentionally much smaller than `oh-my-opencode`. Phase 1 focuses on config, prompts, and a clean installable package. Heavier hook systems and advanced tooling can be layered in later.

## Install without cloning

Run directly from GitHub:

```bash
bunx --bun github:Opencode-DCP/opencode-pair-autonomy install
```

This stores the same GitHub package source in `~/.config/opencode/package.json`, so future reinstalls keep working without a local checkout.

If you want to install from a fork or a different package source, override it explicitly:

```bash
OPENCODE_PAIR_AUTONOMY_PACKAGE_SPEC=github:your-org/opencode-pair-autonomy \
  bunx --bun github:your-org/opencode-pair-autonomy install
```

After the package is published to npm, the direct install becomes:

```bash
bunx --bun opencode-pair-autonomy install
```

## Install from a local checkout

```bash
git clone https://github.com/Opencode-DCP/opencode-pair-autonomy.git
cd opencode-pair-autonomy
bun install
bun run build
bun link
opencode-pair-autonomy install
```

For a clean rebuild of the OpenCode config directory while keeping root config files like `opencode.json`, `opencode.jsonc`, `opencode-pair-autonomy.jsonc`, and `tui.json`, run:

```bash
opencode-pair-autonomy fresh-install
```

You can also use:

```bash
opencode-pair-autonomy install --fresh
```

The installer patches the active OpenCode config, creates a backup, updates the config-directory `package.json`, vendors the background-agents plugin locally, and runs `bun install` there.
It also ships and installs bundled `pg-mcp`, `ssh-mcp`, and `sudo-mcp` implementations from this project, installs the shell strategy as an instruction file, and prompts for a Jina API key to store in `opencode-pair-autonomy.jsonc`.

On a normal install, existing MCP config files such as `vendor/mcp/ssh-mcp/config.json`, `vendor/mcp/pg-mcp/config.json`, and `vendor/mcp/sudo-mcp/config.json` are preserved.

If you want to inspect the resulting plugin snippet manually, it looks like this:

```json
{
  "plugin": [
    "file:///ABSOLUTE/PATH/TO/plugins/opencode-pair-autonomy.js",
    "file:///ABSOLUTE/PATH/TO/plugins/opencode-dcp.js",
    "file:///ABSOLUTE/PATH/TO/plugins/opencode-skillful.js",
    "file:///ABSOLUTE/PATH/TO/plugins/opencode-notificator.js",
    "file:///ABSOLUTE/PATH/TO/plugins/md-table-formatter.js",
    "file:///ABSOLUTE/PATH/TO/plugins/opencode-pty.js",
    "file:///ABSOLUTE/PATH/TO/opencode-background-agents-local"
  ],
  "instructions": [
    "~/.config/opencode/plugin/shell-strategy/shell_strategy.md"
  ],
  "default_agent": "pair"
}
```

For a correct path-aware setup, prefer `opencode-pair-autonomy install` instead of copying the snippet by hand.

You can also print the snippet with:

```bash
opencode-pair-autonomy print-config
```

## Project init

Create a project-local override file:

```bash
opencode-pair-autonomy init
```

This writes `.opencode/opencode-pair-autonomy.jsonc` in the current directory.

## Config sources

The plugin merges config from:

- `~/.config/opencode/opencode-pair-autonomy.jsonc`
- `<project>/.opencode/opencode-pair-autonomy.jsonc`

Project config wins over user config.

## What it injects

Agents:

- `pair`
- `autonomous`
- `repo-scout-fast`
- `repo-scout-deep`
- `researcher-fast`
- `researcher-deep`
- `builder`
- `builder-deep`
- `verifier-fast`
- `verifier`
- `repair-fast`
- `repair`
- `architect-fast`

Model strategy:

- `pair`, `autonomous`, `builder`, `builder-deep`, `verifier`, `repair`, `repair-fast`, `architect-fast` use `openai/gpt-5.4`
- `repo-scout-fast`, `repo-scout-deep`, `researcher-fast`, `researcher-deep`, `verifier-fast` use Kimi to absorb larger token-heavy discovery workloads

Commands:

- `/pair`
- `/autonomous`

MCPs:

- `context7`
- `grep_app`
- `websearch`
- `chrome-devtools`
- `pg-mcp`
- `ssh-mcp`
- `sudo-mcp`
- `jina`

The local MCPs are bundled inside this project and installed into the harness vendor directory, so installation no longer depends on pre-existing MCP folders in `~/.config/opencode`.

Hooks:

- `IntentGate`: classifies each user message and nudges the request toward `pair` or `autonomous`
- `TodoContinuation`: resumes idle sessions when unfinished todos still exist and no user answer is pending
- `CommentGuard`: appends warnings to tool output when suspicious AI-sloppy comments are detected in edited files

## Prompt design

The prompt style is based on the best parts of `oh-my-opencode` and your preferred workflow:

- inspect first
- default to execution instead of asking for permission
- keep strategic decisions with the user
- use skills directly when domain-specific work benefits from them
- separate collaborative and autonomous modes cleanly
- keep all internal agent communication in English
- respond to the user in the user's language without copying broken keyboard habits or degraded spelling

## Hook behavior

The first implementation wave includes real plugin hooks rather than prompt-only approximations:

- `chat.message` hook for intent classification and direction injection
- `event` hook for idle-session todo continuation
- `tool.execute.after` hook for comment quality warnings

## Next phases

Planned follow-up layers for this harness:

- PTY-aware execution helpers
- structured background research routing
- stronger mode-aware runtime injection
