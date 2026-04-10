# Agent Matrix

## Coordinator

| Agent  | Character  | Model                       | Variant | Role                                              |
| ------ | ---------- | --------------------------- | ------- | ------------------------------------------------- |
| `yang` | Yang Wenli | `openai/gpt-5.4`           | `high`  | Plans, argues, delegates, synthesizes. Never asks for routine permission. |

## Workers

| Agent      | Character       | Model                         | Variant | Role                                          |
| ---------- | --------------- | ----------------------------- | ------- | --------------------------------------------- |
| `thorfinn` | Thorfinn        | `openai/gpt-5.3-codex` | `high`  | Main implementation — backend changes, refactoring, migrations, server ops. |
| `ginko`    | Ginko           | `openai/gpt-5.4`             | `medium`| Web and doc research. Search, synthesize, report. |
| `rust`     | Rust Cohle      | `openai/gpt-5.4`             | `high`  | Default senior reviewer. Read-only. Faster lane for medium/high-risk review. |
| `rust_deep`| Rust Deep       | `openai/gpt-5.4`             | `xhigh` | Escalation reviewer. Read-only. Slower/deeper analysis for subtle or high-risk cases. |
| `spock`    | Spock           | `openai/gpt-5.4`             | `medium`| Build, test, typecheck, lint verification. Pass or fail, nothing more. |
| `geralt`   | Geralt of Rivia | `openai/gpt-5.3-codex` | `medium`| Scoped failure repair. One problem in, one fix out. |
| `edward`   | Edward Elric    | `openai/gpt-5.4`             | `high`  | Frontend specialist. Design-aware implementation and visual validation. |
| `killua`   | Killua Zoldyck  | `openai/gpt-5.4`             | `medium`| Fast codebase exploration. Scans structure, reports locations and patterns. |

## MCP Access Matrix

Defined in `src/prompts/mcp-access.ts` — single source of truth.

| Agent        | context7 | grep_app | searxng | web-agent-mcp | pg-mcp | ssh-mcp | mariadb |
| ------------ | -------- | -------- | ------- | ------------- | ------ | ------- | ------- |
| **yang**     | yes      | yes      | —       | —             | yes    | yes     | yes     |
| **thorfinn** | yes      | yes      | —       | —             | yes    | yes     | yes     |
| **ginko**    | yes      | yes      | yes     | —             | —      | —       | —       |
| **rust**     | yes      | yes      | —       | —             | —      | —       | —       |
| **rust_deep**| yes      | yes      | —       | —             | —      | —       | —       |
| **spock**    | —        | —        | —       | —             | —      | —       | —       |
| **geralt**   | yes      | —        | —       | —             | yes    | yes     | yes     |
| **edward**   | yes      | yes      | yes     | yes           | —      | —       | —       |
| **killua**   | —        | —        | —       | —             | —      | —       | —       |

`—` = denied at OpenCode runtime level (tool calls blocked).

## Automatic Workflow

The coordinator uses a quality-balanced workflow:

Low risk means narrow single-path changes with no public behavior change and no auth, billing, queue, or DB-write impact.

1. Scout first for complex tasks (`killua`, `ginko` only when external research is needed).
2. Packetize broad work into focused implementation scopes.
3. Implement with `thorfinn` or `edward`.
4. Low-risk packets may start with targeted `spock` checks, but completion still requires the relevant full `spock` pass.
5. Medium/high-risk changes run full `spock`, then `rust` (default faster lane).
6. Spock failures go to `geralt`, then back to `spock`. Max 2 cycles.
7. Rust request-changes go to `geralt`, then `spock`, then `rust`. Max 2 cycles; unresolved cases escalate to `rust_deep`.
8. `rust_deep` is escalation-only for subtle/high-risk edge cases or unresolved reviewer concerns.
9. Rust Deep request-changes go to `geralt`, then `spock`, then `rust_deep`. Max 2 cycles; if still unresolved, stop and escalate to user as blocker.
10. Verification and review are automatic by workflow; do not ask the user whether to run them.

## Delegation Tools

| Tool         | For                                                  | Session Continuation     |
| ------------ | ---------------------------------------------------- | ------------------------ |
| **Task**     | Write-capable workers only (thorfinn, spock, geralt, edward) | Pass task_id to continue |
| **Delegate** | Fresh async lane for read-only workers (ginko, rust, rust_deep, killua) | Always fresh, runs async |

`rust_deep` is escalation-only (after Rust escalation or unresolved subtle/high-risk concerns), not a default planning scout.
Task continuation is explicit: call Task with an existing task_id to continue; omit task_id to spawn fresh.
Delegate IDs are for async result retrieval only; they do not support session continuation.
Read-only workers remain in the coordinator task allowlist only for internal Delegate plumbing; continuation remains Task-only for write-capable workers.

## Model Tier Policy

- **Coordinator**: GPT 5.4 `high`
- **Default senior reviewer**: GPT 5.4 `high`
- **Escalation reviewer**: GPT 5.4 `xhigh`
- **UI worker**: GPT 5.4 `high`
- **Implementation workers**: GPT 5.3 Codex (`high` / `medium`)
- **Read-only scout/research workers**: GPT 5.4 `medium`

## Language Policy

- All internal prompts, delegation packets, and structured outputs are in English.
- User-facing replies follow the user's language.
