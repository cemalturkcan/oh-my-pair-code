---
name: redesign-skill
description: Improve existing interfaces in place by strengthening hierarchy, flow, and states without rewriting the product or abandoning the current stack.
---

## Purpose
Use this skill when the UI already exists and the goal is to make it better, clearer, and more convincing without rebuilding it from scratch.

## Start With Inspection
1. Inspect the current stack, UI structure, shared components, tokens, copy patterns, and behavior before proposing changes.
2. Identify what already works and should be preserved.
3. Redesign in place: improve the screen's structure and feel while respecting the repo's implementation model.

## Stack-Aware Scope
- For Vue/Vite apps, redesign through the existing component, router, store, and styling patterns.
- For generic web UIs, improve the current markup, CSS, and interaction model instead of introducing a new frontend style.
- For Expo or React Native, keep mobile-native behavior, current navigation, and touch interaction patterns intact.
- For Android-native UI, work through the app's existing resources, layouts, components, and screen flow.
- Do not force a different framework, styling library, font stack, or icon system.

## Redesign Priorities
- Clarify what matters first: primary action, key information, and next step.
- Remove clutter before adding decoration.
- Strengthen grouping, alignment, and spacing so the screen reads in a clear order.
- Improve copy so labels, helper text, empty states, and errors are specific and useful.
- Keep recognizable product cues unless they are the problem.

## Anti-Slop Rules
- Do not replace one bland layout with another bland card grid.
- Do not lean on purple-glow AI aesthetics, empty marketing filler, or generic dashboard chrome.
- Do not flatten the interface into equal-weight blocks.
- Do not leave state gaps that make the redesign look polished only in screenshots.

## Redesign Method
1. Audit the current screen: keep, remove, simplify, merge, or emphasize.
2. Preserve working flows and architecture while improving hierarchy and comprehension.
3. Reuse repo components and tokens first; create only the minimum new styling or structure needed.
4. Fix state coverage, interaction feedback, and accessibility as part of the redesign.
5. Make targeted visual improvements that fit the product instead of performing a full stylistic reset.

## State, Feedback, Accessibility
- Verify loading, empty, error, success, disabled, focus, hover, and active states.
- Make validation, progress, completion, and failure legible at the moment users need them.
- Keep keyboard navigation, semantic structure, contrast, labels, and touch targets reliable.
- Prefer calm, informative motion over decorative transitions.

## Guardrails
- Do not add dependencies or rewrite architecture unless the user explicitly asks.
- Do not discard existing patterns that already serve users well.
- Do not redesign by replacing everything with trend-driven visuals.
- Ship the smallest coherent change set that materially improves the current experience.
