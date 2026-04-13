---
name: caveman-review
description: Optional terse code review comment style. Produces short, actionable review comments with location, problem, and suggested fix direction. Use when the user asks for terse review feedback, one-line review comments, or /caveman-review.
---

## Purpose

Use this skill when the user wants code review comments shorter than the default review style.

## Rules

- Preserve any caller-provided output contract, schema, or review format exactly.
- When no output contract is provided and the user wants ad-hoc human review comments, prefer one line per finding: `file:L<line>: <problem>. Suggest <fix direction>.`
- Keep exact symbols, function names, and variables in backticks.
- Use optional severity prefixes only when useful: `bug`, `risk`, `nit`, `q`.
- Drop pleasantries, hedging, and explanations of code the author can already read.
- Include the why only when the fix is not obvious from the problem statement.
- Keep worker and coordinator reports in English.
- Keep durable repo artifacts in English unless another caller contract overrides the default.
- Keep user-facing replies in the user's language unless another caller contract applies.

## Auto-Clarity

Use normal paragraph form for security findings, irreversible or destructive changes, risky migrations, auth or data-loss risk, architectural disagreements, or onboarding-heavy feedback where the author needs more rationale. Keep warnings explicit. Resume terse comments after that.

## Boundaries

Reviews only. Do not write code patches, change reviewer verdict contracts, or run verification tools. For ad-hoc human review comments, output comments ready to paste in a human review thread. Use normal human comment style unless the caller specifies another format.
