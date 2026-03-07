# Agent Matrix

## Primary agents

| Agent | Role | Model |
|---|---|---|
| `pair` | Default collaborative coding partner | `openai/gpt-5.4` `high` |
| `autonomous` | Checkpointed autonomous executor | `openai/gpt-5.4` `high` |

## Discovery and research agents

| Agent | Role | Model |
|---|---|---|
| `repo-scout-fast` | Quick repo scanning and pattern lookup | `kimi-for-coding/k2p5` |
| `repo-scout-deep` | Large repo and dependency tracing | `kimi-for-coding/kimi-k2-thinking` |
| `researcher-fast` | Quick external research | `kimi-for-coding/k2p5` |
| `researcher-deep` | Long-form docs and edge-case research | `kimi-for-coding/kimi-k2-thinking` |

## Execution agents

| Agent | Role | Model |
|---|---|---|
| `builder` | Scoped implementation | `openai/gpt-5.4` `medium` |
| `builder-deep` | Complex multi-file implementation | `openai/gpt-5.4` `high` |
| `verifier-fast` | Fast verification for large outputs | `kimi-for-coding/k2p5` |
| `verifier` | Full verification and failure classification | `openai/gpt-5.4` `high` |
| `repair-fast` | Narrow repair loop | `openai/gpt-5.4` `medium` |
| `repair` | Full scoped repair | `openai/gpt-5.4` `high` |
| `architect-fast` | Lightweight planning for risky work | `openai/gpt-5.4` `medium` |

## Language policy

- All internal prompts, delegation packets, and structured outputs are in English.
- User-facing replies follow the user's language.
- User-facing replies should be normalized and clean, not a copy of the user's broken keyboard style.
