# Agent Matrix

## Coordinator

| Agent  | Character  | Model                       | Variant | Role                                              |
| ------ | ---------- | --------------------------- | ------- | ------------------------------------------------- |
| `yang` | Yang Wenli | `openai/gpt-5.4`           | `xhigh` | Plans, argues, delegates, synthesizes. Never asks for routine permission. |

## Workers

| Agent      | Character       | Model                         | Variant | Role                                          |
| ---------- | --------------- | ----------------------------- | ------- | --------------------------------------------- |
| `thorfinn` | Thorfinn        | `openai/gpt-5.3-codex-spark` | `high`  | General implementation — features, refactoring, migrations, server ops. |
| `ginko`    | Ginko           | `openai/gpt-5.4`             | `medium`| Web and doc research. Search, synthesize, report. |
| `rust`     | Rust Cohle      | `openai/gpt-5.4`             | `xhigh` | Senior code reviewer. Read-only. Finds subtle bugs and security issues. |
| `spock`    | Spock           | `openai/gpt-5.4`             | `medium`| Build, test, typecheck, lint verification. Pass or fail, nothing more. |
| `geralt`   | Geralt of Rivia | `openai/gpt-5.3-codex-spark` | `medium`| Scoped failure repair. One problem in, one fix out. |
| `edward`   | Edward Elric    | `openai/gpt-5.4`             | `xhigh` | Frontend specialist. Design-aware implementation and visual validation. |
| `killua`   | Killua Zoldyck  | `openai/gpt-5.4`             | `medium`| Fast codebase exploration. Scans structure, reports locations and patterns. |

## MCP Access Matrix

Defined in `src/prompts/mcp-access.ts` — single source of truth.

| Agent        | context7 | grep_app | searxng | web-agent-mcp | pg-mcp | ssh-mcp | mariadb |
| ------------ | -------- | -------- | ------- | ------------- | ------ | ------- | ------- |
| **yang**     | yes      | yes      | —       | —             | yes    | yes     | yes     |
| **thorfinn** | yes      | yes      | —       | —             | yes    | yes     | yes     |
| **ginko**    | yes      | yes      | yes     | —             | —      | —       | —       |
| **rust**     | yes      | yes      | —       | —             | —      | —       | —       |
| **spock**    | —        | —        | —       | —             | —      | —       | —       |
| **geralt**   | yes      | —        | —       | —             | yes    | yes     | yes     |
| **edward**   | yes      | yes      | yes     | yes           | —      | —       | —       |
| **killua**   | —        | —        | —       | —             | —      | —       | —       |

`—` = denied at OpenCode runtime level (tool calls blocked).

## Automatic Workflow

After implementation, the coordinator chooses verification level:

**Trivial** (config change, typo, single-line fix):
1. Spawn spock (build + test + typecheck). Done if pass.

**Standard** (multi-file changes, new features, refactoring):
1. Spawn spock (build + test + typecheck).
2. Spock pass → spawn rust.
3. Spock fail → spawn geralt, then re-verify. Max 2 cycles.
4. Rust request-changes → spawn geralt, then re-verify + re-review. Max 2 cycles.
5. UI tasks → spawn edward for visual verification.

## Delegation Tools

| Tool         | For                                                  | Session Continuation     |
| ------------ | ---------------------------------------------------- | ------------------------ |
| **Task**     | Write workers (thorfinn, spock, geralt, edward)      | Pass task_id to continue |
| **Delegate** | Read-only workers (ginko, rust, killua)              | Always fresh, runs async |

## Model Tier Policy

- **Coordinator**: GPT 5.4 `xhigh`
- **Senior reviewer**: GPT 5.4 `xhigh`
- **UI worker**: GPT 5.4 `xhigh`
- **Implementation workers**: GPT 5.3 Codex Spark (`high` / `medium`)
- **Read-only workers**: GPT 5.4 `medium`

## Language Policy

- All internal prompts, delegation packets, and structured outputs are in English.
- User-facing replies follow the user's language.
