# Agent Matrix

## Topology

| Agent | Mode | Model | Variant | Role |
| ----- | ---- | ----- | ------- | ---- |
| `mission-control` | `primary` | `openai/gpt-5.5-fast` | `xhigh` | Top-level orchestrator. Owns mission decomposition, durable ledger state, worker delegation, blocker batching, acceptance gate checks, and final synthesis. It may also inspect, edit, and run commands directly when in scope. |
| `implementation-engineer` | `subagent` | `openai/gpt-5.5-fast` | `low` | Scoped implementation worker for backend, tooling, refactors, bug fixes, docs, and repo changes. |
| `frontend-engineer` | `subagent` | `openai/gpt-5.5-fast` | `low` | Scoped frontend/UI worker for pages, components, layout, styling, responsive behavior, and polish. |
| `repo-scout` | `subagent` | `openai/gpt-5.5-fast` | `low` | Read-only repository exploration worker for file discovery, codebase mapping, and pattern finding. |
| `research-analyst` | `subagent` | `openai/gpt-5.5-fast` | `low` | External research worker for official docs, web sources, library guidance, and source-backed findings. |
| `creative-strategist` | `subagent` | `openai/gpt-5.5-fast` | `low` | High-creativity read-only ideation worker for naming, alternate perspectives, quick workarounds, hack-style approaches, weird-but-safe routes, and non-obvious options. Uses temperature `0.9`; Mission Control owns final decisions. |
| `verification-engineer` | `subagent` | `openai/gpt-5.5-fast` | `xhigh` | Acceptance gate worker for evidence review, safe local/sandbox verification, diff review, and approve/request-changes decisions. |

## Durable Ledger

Mission state is persisted in a user-level SQLite DB by default, not in the project repo. Projects may track `.opencode/orch.txt` as a plain text identity marker. The ledger stores missions, tasks, dependencies, acceptance criteria, artifacts, curated context bundles, decisions, blockers, and verification results. Runtime maps may help with session linking, but the ledger is the source of truth.

## Prompt Character Mapping

The current direct-ledger agents preserve the richer character prompt architecture without restoring the old coordinator hierarchy:

| Previous prompt | Current agent(s) | Adapted emphasis |
| --------------- | ---------------- | ---------------- |
| `mrrobot` | `mission-control` | Mission-command persona, task routing, orchestration rhythm, parallel safety, action safety, and final gate ownership. |
| `eliot` | `implementation-engineer`, `repo-scout` | Evidence-first repo pattern matching, scoped implementation, forensic codebase mapping, and verifier-ready reports. |
| `claude` | `frontend-engineer` | Tasteful UI engineering, hierarchy, accessibility, responsiveness, and production polish inside the existing stack. |
| `tyrell` | `creative-strategist` | High-temperature ideation, naming, non-obvious options, quick experiments, and safe workaround framing. |
| `turing` | `verification-engineer` | Rigorous acceptance review, adversarial evidence checks, safe real/local verification, and approve/request-changes gates. |

## Task and Permission Model

| Agent | Can spawn workers? | Harness tool access | Role discipline | Notes |
| ----- | ------------------ | ------------------- | --------------- | ----- |
| `mission-control` | yes, approved workers only | normal read/edit/bash/research/orchestrator access | Delegates implementation instead of doing it directly in normal workflow. | Final gate owner. |
| `implementation-engineer` | yes | normal read/edit/bash/research/orchestrator access | Writes inside task scope. | Returns structured reports. |
| `frontend-engineer` | yes | normal read/edit/bash/research/orchestrator access | Writes inside task scope. | Frontend-focused writer. |
| `repo-scout` | yes | normal read/edit/bash/research/orchestrator access | Prompted for evidence gathering. | Publishes findings as context bundles or artifacts. |
| `research-analyst` | yes | normal read/edit/bash/research/orchestrator access | Research-focused. | Uses web/docs/research tooling. |
| `creative-strategist` | yes | normal read/edit/bash/research/orchestrator access | Ideation-focused. | Mission Control owns final decisions. |
| `verification-engineer` | yes | normal read/edit/bash/research/orchestrator access | Verification-focused. | Records gate reports. |

## Workflow

1. Mission Control creates or resumes a ledger mission.
2. It decomposes work into dependency-aware tasks with acceptance criteria, evidence requirements, scopes, and assigned workers.
3. Writer tasks use assigned scope as guidance.
4. Workers return structured JSON reports and publish compact artifacts/context bundles.
5. Mission Control updates or reopens tasks based on evidence.
6. Non-trivial changes go through `verification-engineer`.
7. Mission Control calls `orchestrator_gate_check` before final success and refuses completion unless `can_final_success` is true.
8. External actions are handled according to task scope and evidence requirements.

## Language Policy

- User-facing replies follow the user's language.
- Worker prompts and reports stay in English.
- Code, branch names, commits, and durable technical artifacts stay in English.
