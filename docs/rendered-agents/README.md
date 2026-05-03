# Rendered agents

Rendered from `createHarnessAgents(loadHarnessConfig(projectRoot))` with the current project/user harness config and discovered installed skills.

| Agent | Mode | Model | Variant | Description |
| --- | --- | --- | --- | --- |
| [mrrobot](./mrrobot.md) | primary | openai/gpt-5.5-fast | medium | MrRobot — Primary agent. Routes work, keeps scope tight, and answers plainly. |
| [eliot](./eliot.md) | subagent | openai/gpt-5.5-fast | low | Eliot — General-purpose subagent for implementation and repo work. |
| [tyrell](./tyrell.md) | subagent | openai/gpt-5.5-fast | low | Tyrell — Ideation subagent for creative options, naming, UX direction, and product ideas. |
| [claude](./claude.md) | subagent | openai/gpt-5.5-fast | low | Claude — Frontend design subagent for UI layout, styling, and visual polish. |
| [turing](./turing.md) | subagent | openai/gpt-5.5-fast | xhigh | Turing — Validation-focused review and verification subagent. |
| [build](./build.md) | disabled | - | - | Disabled built-in |
| [plan](./plan.md) | disabled | - | - | Disabled built-in |
