---
name: taste-skill
description: Stack-aware UI implementation and polish skill for shipping distinctive, usable interfaces inside the repo's existing patterns and technology.
---

## Purpose
Use this skill when the task is to build a new UI surface or raise the quality of an existing one without leaving the repo's stack.

## Start With Repo Reality
1. Inspect the project stack, styling system, shared components, tokens, navigation patterns, and state patterns before making design decisions.
2. Stay inside the current stack. Match the repo's framework, styling approach, component model, and platform conventions.
3. Reuse existing tokens, components, icons, spacing rules, and interaction patterns before inventing new ones.

## Stack-Aware Defaults
- If the repo is a Vue/Vite app, follow its existing routing, store, component, and styling conventions.
- If it is a generic web UI, use the established HTML/CSS/JS or framework patterns already present.
- If Expo or React Native is clearly in use, respect native mobile layout, touch targets, platform feedback, and the current component approach.
- If the repo clearly uses Android-native UI, follow its existing Material or app-specific patterns, resource structure, and screen architecture.
- Do not force React, Next, Tailwind, a font choice, or an icon package onto a repo that does not already use them.

## Design Stance
- Aim for clarity first, then personality.
- Build strong hierarchy: obvious primary action, readable grouping, clear section priority, and deliberate spacing rhythm.
- Prefer a few confident visual decisions over many weak decorative ones.
- Make the interface feel authored, not templated.

## Anti-Slop Rules
- Avoid generic card grids when the content needs stronger structure.
- Avoid purple-glow, neon-dark, glassy AI-demo aesthetics unless the product already uses them intentionally.
- Avoid empty placeholder copy that says nothing.
- Avoid weak hierarchy where everything has the same weight.
- Avoid shipping happy-path-only UI with missing loading, empty, error, disabled, or success states.

## Implementation Method
1. Identify the dominant repo pattern for the feature type.
2. Define the information hierarchy and the primary user action.
3. Implement the smallest complete UI that feels native to the product.
4. Add state coverage, feedback, and accessibility before decorative polish.
5. Refine spacing, copy, alignment, and motion until the result feels intentional.

## State, Feedback, Accessibility
- Cover loading, empty, error, success, disabled, hover, focus, and active states where relevant.
- Give users immediate interaction feedback for taps, clicks, validation, async work, and completion.
- Preserve keyboard access, screen-reader meaning, visible focus, contrast, and readable touch targets.
- Do not rely on color alone to communicate status.

## Guardrails
- Do not add dependencies, swap frameworks, or rewrite architecture unless the user explicitly asks.
- Do not bypass existing design tokens or shared primitives without a repo-based reason.
- Do not chase polish by adding noise, extra surfaces, or ornamental motion.
- Prefer improvements that can ship cleanly in the current codebase.
