# Agent Matrix

## Primary agents (tab-switchable)

All primary agents run Claude Opus 4.6 with max thinking and full task permissions.

| Agent          | Role                                                                          | Model                       | Variant |
| -------------- | ----------------------------------------------------------------------------- | --------------------------- | ------- |
| `pair`         | Collaborative pair programmer. Plans first, confirms, executes, auto-reviews. | `anthropic/claude-opus-4-6` | `max`   |
| `autonomous`   | Checkpointed autonomous executor. Runs independently until done or blocked.   | `anthropic/claude-opus-4-6` | `max`   |
| `reviewer`     | Primary code reviewer. Launches cross-model review automatically.             | `anthropic/claude-opus-4-6` | `max`   |
| `web-search`   | Web research agent. Starts researching immediately on activation.             | `anthropic/claude-opus-4-6` | `max`   |
| `ui-developer` | UI craftsman. Figma extraction, creative design, live UX review.              | `anthropic/claude-opus-4-6` | `max`   |

## Subagents

| Agent                  | Role                                            | Model                                | Variant |
| ---------------------- | ----------------------------------------------- | ------------------------------------ | ------- |
| `repo-scout`           | Repository pattern scout and file discovery.    | `anthropic/claude-sonnet-4-6-latest` | `max`   |
| `researcher`           | External docs, APIs, and library research.      | `anthropic/claude-sonnet-4-6-latest` | `max`   |
| `builder`              | Scoped implementation within assigned boundary. | `anthropic/claude-sonnet-4-6-latest` | `max`   |
| `builder-deep`         | Complex multi-file implementation.              | `anthropic/claude-opus-4-6`          | `max`   |
| `verifier`             | Verification and failure classification.        | `anthropic/claude-opus-4-6`          | `max`   |
| `repair`               | Scoped repair for verifier-reported failures.   | `anthropic/claude-opus-4-6`          | `max`   |
| `yet-another-reviewer` | Cross-model independent reviewer (GPT).         | `openai/gpt-5.4`                     | `max`   |

## Automatic delegation rules

These fire automatically from `pair` and `autonomous` — no user action needed:

| Trigger                                                  | Action                                          |
| -------------------------------------------------------- | ----------------------------------------------- |
| After significant work (multi-file, features, refactors) | `reviewer` + `yet-another-reviewer` in parallel |
| After writing/modifying code                             | `verifier`                                      |
| On verifier failure                                      | `repair` → re-verify                            |

| UI/frontend tasks (pages, components, layouts, styling) | `ui-developer` |

Trivial changes (typos, single-line fixes) skip the review cycle.

## Model tier policy

- **Primary agents**: Claude Opus 4.6 `max` — no exceptions.
- **Subagents (minimum)**: Claude Sonnet 4.6 `max` — no haiku tier.
- **Cross-model**: GPT 5.4 `max` for review diversity.

## Language policy

- All internal prompts, delegation packets, and structured outputs are in English.
- User-facing replies follow the user's language.
