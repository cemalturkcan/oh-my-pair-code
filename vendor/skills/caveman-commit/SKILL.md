---
name: caveman-commit
description: Optional terse commit message generator. Produces compact commit messages that preserve the why and follow the repo's usual style unless the user or repo convention says otherwise. Use when the user asks for terse, compact, or short commit wording, or /caveman-commit.
---

## Purpose

Use this skill when the user wants a tighter commit message than the default writing style, not for ordinary commit message requests.

## Rules

- Preserve any caller-provided output contract, schema, and exact fence or no-fence requirement.
- Preserve the repository's existing commit message style by default.
- Use Conventional Commits only when the repository already uses them or the user explicitly asks for them.
- Keep scope optional; add it only when it improves clarity.
- Keep the subject within 50 characters when possible; never exceed 72.
- Prefer the why over the what.
- Add a body only for non-obvious rationale, breaking changes, security fixes, migrations, or reverts.
- Wrap the body at 72 characters.
- Keep the message terse; do not add a style prefix or format the repo does not already use.
- No filler, AI attribution, emoji, or repeated file names unless repo convention requires them.

## Auto-Clarity

Always include a body for breaking changes, security fixes, risky migrations, data migrations, irreversible changes, destructive changes, and reverts. Keep warnings explicit. Do not over-compress the context in those cases.

## Boundaries

Generate the message only. Do not stage files, amend commits, or run `git commit`. When no caller-specified exact output format is provided, output a paste-ready message in a code block. Normal English only.
