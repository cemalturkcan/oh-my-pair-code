# Raw SQLite private sync

opencode-pair stores the orchestrator ledger in a user-level SQLite database by default, such as `$XDG_STATE_HOME/opencode-pair/orchestrator.sqlite` or `~/.local/state/opencode-pair/orchestrator.sqlite` on Linux. Project repositories must not store raw project DBs; they should track only `.opencode/orch.txt` for identity.

## Rules

- Use a single writer. Do not keep OpenCode running against the same synced ledger on two machines.
- Pull before opening OpenCode on a machine.
- Close OpenCode before committing or syncing the ledger.
- SQLite WAL mode may create `orchestrator.sqlite-wal` and `orchestrator.sqlite-shm`. Close OpenCode so SQLite checkpoints WAL data before commit/sync.
- Do not hand-merge SQLite, WAL, or SHM files. They are binary state. If a conflict happens, preserve both DB snapshots, run a dry-run row reconcile, inspect conflicts, then write a merged output DB only to an explicit new path.
- When a private sync repo is configured, the lifecycle is automatic: OpenCode/session start pulls best-effort and clean session exit checkpoints, commits only when changed, and pushes best-effort. Status/reconcile helpers remain side-effect-free.

## Install and marker setup

`bunx opencode-pair install` wires the harness into OpenCode and uses the global user-level ledger path unless `orchestration.ledger_path` is explicitly overridden for tests or advanced local setups. It does not create or commit a project-local SQLite DB. In an interactive terminal, install asks whether to configure a private ledger sync repo when no sync repo/path/url is already configured in user config or `OPENCODE_PAIR_SYNC_REPO` / `OPENCODE_PAIR_SYNC_PATH`; the default answer is No. The prompt accepts either a Git remote URL (`https://`, `ssh://`, `git://`, or `git@host:owner/repo.git`) or a local filesystem path. URL answers are stored as `orchestration.sync.repo` and paired with a deterministic user-state local checkout path such as `$XDG_STATE_HOME/opencode-pair/sync`; filesystem answers are stored as `orchestration.sync.path`. After a URL answer, interactive install automatically prepares the local checkout on the configured branch or `main`; there is no second clone confirmation because the repo URL answer is the setup approval. Existing git checkouts are reused, existing non-git paths are not overwritten, and git failures continue install with warning plus manual fallback guidance. CI, non-TTY, and piped installs never prompt, clone, initialize, commit, push, or wait for input, and `--no-prompt` forces prompt-free behavior.

For stable project identity across clones and machines, add a git-tracked `.opencode/orch.txt` file:

```text
version=1
project_key=project:my-repo
name=My Repo
repo_fingerprint=git:https://example/repo#main
```

The marker is safe to track because it is plain line-oriented identity metadata. Keep it free of secrets, private sync repo URLs, tokens, machine-local absolute paths, and personal filesystem locations.

## Project mapping

Absolute paths are machine-local. The same repo can be `/home/alice/repo` on Linux and `/Users/alice/code/repo` on macOS.

Project resolution prefers stable identity in this order:

1. Explicit `project_key` passed to the orchestration tool.
2. Repo marker `.opencode/orch.txt`, for example:

   ```text
   version=1
   project_key=project:my-repo
   name=My Repo
   repo_fingerprint=optional-human-note
   ```

3. Git fingerprint read from local `.git/config` `origin` plus `HEAD`, without shelling out.
4. Raw `root_path` as the final fallback.

When a stable identity matches an existing project, the ledger records the current machine's root path as an alias instead of creating a duplicate project. `root_path` remains the current machine's last seen root, not a durable cross-machine identity.

## Runtime locality

Sessions include a local `machine_id`. Synced rows from another PC remain in the database, but project status and current-session lookup only treat rows for the current machine as live.

## Limitations

- This mode is private raw state sync, not sanitized export.
- Concurrent writers can still corrupt intent even if SQLite remains valid.
- Binary conflicts cannot be merged safely.
- Marker files are supported but not auto-created by runtime project resolution; add git-tracked `.opencode/orch.txt` deliberately when you want stable cross-path mapping without relying on git metadata.

## Config and status command

Sync is disabled unless explicitly configured. Use user-level config, the installer's default missing-config prompt, `install --configure-sync`, or environment variables so secrets and private repo locations do not enter the project marker or repository:

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

Environment alternatives: `OPENCODE_PAIR_SYNC_REPO` for a remote URL, `OPENCODE_PAIR_SYNC_PATH` for the local checkout/path, and `OPENCODE_PAIR_SYNC_BRANCH` for the branch. If only a remote URL is configured, the local checkout path defaults to the user state directory (`$XDG_STATE_HOME/opencode-pair/sync`, `~/.local/state/opencode-pair/sync` on Linux, or the platform equivalent) and is reported separately by `/orchestrator-sync`.

The installer prompt asks for the repo URL/path and branch, then writes only to the user-level harness config (`~/.config/opencode/opencode-pair.jsonc` or `OPENCODE_CONFIG_DIR/opencode-pair.jsonc`). For remote URL config in an interactive terminal, it prepares the configured local checkout with non-interactive git (`GIT_TERMINAL_PROMPT=0`): clone without `--branch`, or when the remote is empty/no-branch, initialize locally, add `origin`, switch/create `main`, create/copy `orchestrator.sqlite`, commit `checkpoint ledger`, and push `origin main`. It never writes private sync repo settings to `.opencode/orch.txt` or git-tracked project files. Non-interactive installs skip prompts and checkout preparation entirely and rely on existing user config or `OPENCODE_PAIR_SYNC_REPO` / `OPENCODE_PAIR_SYNC_PATH` if present.

Run `/orchestrator-sync` in OpenCode to call `orchestrator_sync_status`. The helper is status-only, side-effect-free, and never runs git or writes the DB. It reports the configured remote URL as `repo` and the local checkout as `path`, never resolving URL strings under the project directory. It reports `disabled`, `not_configured`, `missing_repo`, or `ready`, plus optional recovery/debug command templates like:

```bash
git -C "/path/to/private-ledger-sync" status --short --branch
git -C "/path/to/private-ledger-sync" pull --ff-only origin main
# close OpenCode so SQLite checkpoints WAL state
git -C "/path/to/private-ledger-sync" add orchestrator.sqlite
git -C "/path/to/private-ledger-sync" commit -m "checkpoint ledger"
git -C "/path/to/private-ledger-sync" push origin main
```

## Lifecycle and recovery

- Session start: the hook runs a bounded non-interactive `git pull --ff-only origin <branch>` best-effort before opening or resuming work, then Mission Control attaches/replays project/session context from the ledger.
- Local update: normal task, artifact, context, blocker, and verification writes go to the active global ledger on this machine.
- Mission/task checkpoint: normal writes stay in the active local ledger; `/orchestrator-sync` remains status/reconcile guidance and does not mutate git or the DB. Clean session exit handles checkpoint, commit, and push.
- Session end: clean session deletion checkpoints/copies `orchestrator.sqlite` into the sync checkout, commits only when changed, and pushes best-effort. Failures warn and do not block shutdown.
- Recovery/debug: run `/orchestrator-sync` to get status, lifecycle policy, optional command templates, setup actions, and reconcile guidance. The normal configured lifecycle is still automatic start pull and clean-exit push.
- Crash recovery: do not reset or delete the DB. Pull/status first, keep backups, then either reconcile exported local/remote row snapshots with `orchestrator_sync_reconcile_plan`, reconcile real SQLite snapshots with `orchestrator_sync_reconcile_files`, choose one SQLite DB intentionally, or restore from backup. Binary SQLite/WAL/SHM conflicts are not line-mergeable.

## Real SQLite snapshot reconcile flow

Use timestamped copies so the active DB is never overwritten by tooling:

- `local.<timestamp>.sqlite`: the current machine's preserved snapshot.
- `remote.<timestamp>.sqlite`: the pulled or conflict-side snapshot from the private sync repo.
- `merged.<timestamp>.sqlite`: a new explicit output path, created only after dry-run review.
- `conflicts.<timestamp>.json`: the conflict report returned by the helper for operator review.

Flow:

1. Close OpenCode so SQLite checkpoints WAL data.
2. Copy each side to `local.<timestamp>.sqlite` and `remote.<timestamp>.sqlite`; do not edit the active DB.
3. Run `/orchestrator-sync` with those paths, or call `orchestrator_sync_reconcile_files` directly with `dry_run=true`.
4. Inspect `conflicts`, `warnings`, `stats`, and the suggested filenames; decide whether to keep local, keep remote, reopen for verification, restore a backup, or produce a merged output.
5. If the plan is acceptable, call `orchestrator_sync_reconcile_files` again with `dry_run=false` and an explicit distinct `output_db_path`, such as `merged.<timestamp>.sqlite`.
6. Replace the active ledger DB or commit the merged DB only by deliberate manual action after conflict review. The helper never replaces the active DB for you.

`orchestrator_sync_reconcile_files` opens `local_db_path` and `remote_db_path` read-only, exports user tables into the reconcile engine, and never modifies either input. It refuses to write when `output_db_path` is missing or matches either input path. When writing is requested, it creates a fresh orchestrator schema at the explicit output path and imports the merged rows there.

## Row snapshot reconcile plan

`orchestrator_sync_reconcile_plan` is a deterministic, side-effect-free helper for conflict recovery tooling. It accepts `local_snapshot` and `remote_snapshot` objects shaped as `{ "table_name": [{ "id": "...", ... }] }` and returns:

- `merged`: the proposed merged row snapshot.
- `conflicts`: true field/content conflicts with local value, remote value, reason, and resolution options.
- `warnings`: safety notes for remote runtime state.
- `stats`: local/remote/merged row counts, dedupe count, auto-merge count, and forked collision count.

Merge policy summary:

- Non-conflicting rows are copied into the merged output. Inputs are cloned and never modified.
- Append-only tables such as `artifacts`, `context_bundles`, and `decisions` preserve both sides, dedupe exact matches, and fork sequential ID collisions with source metadata instead of overwriting.
- `tasks` prefer safer states when evidence conflicts: `reopened` or `needs_verification` beats `done`. `done` versus `cancelled` is reported as a true conflict.
- `missions` downgrade unsafe terminal disagreement to `active` or `blocked` so the gate can be rechecked.
- `blockers` stay `open` when either side is unresolved or user input is still required.
- `verification_results` prefer `request-changes`/`fail` over `approve`/`pass` while unsuperseded.
- Remote active sessions become ended in the merge plan.

The row snapshot helper intentionally does not run git, open live SQLite files, or write the merged output. Use the SQLite file helper above when the inputs are real `local.sqlite` and `remote.sqlite` snapshots.
