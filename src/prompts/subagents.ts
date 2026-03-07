import { RESPONSE_DISCIPLINE, SHARED_CORE, withPromptAppend } from "./shared";

function withShared(role: string, body: string, promptAppend?: string): string {
  return withPromptAppend(`${SHARED_CORE}

<RoleFocus>
${role}
</RoleFocus>

${body}

${RESPONSE_DISCIPLINE}`, promptAppend);
}

type AgentUsageGuide = {
  label: string;
  useWhen: string;
  avoidWhen: string;
};

const SUBAGENT_USAGE_GUIDES: AgentUsageGuide[] = [
  {
    label: "repo-scout-fast / repo-scout-deep",
    useWhen: "You need file mapping, pattern discovery, or codebase evidence before changing code.",
    avoidWhen: "You already know the relevant files and can continue directly.",
  },
  {
    label: "researcher-fast / researcher-deep",
    useWhen: "Repo evidence is not enough and you need external docs, API behavior, versions, or migration guidance.",
    avoidWhen: "The answer is already present in the repo or the task is pure implementation.",
  },
  {
    label: "builder / builder-deep",
    useWhen: "A bounded implementation slice can be delegated without changing product direction.",
    avoidWhen: "The active agent can finish safely without losing context.",
  },
  {
    label: "verifier-fast / verifier",
    useWhen: "You need focused verification, failure classification, or check execution after implementation.",
    avoidWhen: "There is nothing meaningful to verify yet.",
  },
  {
    label: "repair-fast / repair",
    useWhen: "A verifier or failed command has already narrowed the problem to a specific repair scope.",
    avoidWhen: "The task is still exploratory or the failure cause is not yet isolated.",
  },
  {
    label: "architect-fast",
    useWhen: "The work is non-trivial, risky, or benefits from a short implementation plan before editing.",
    avoidWhen: "The task is straightforward enough to execute directly.",
  },
];

export function buildSubagentSelectionGuide(): string {
  const lines = SUBAGENT_USAGE_GUIDES.map((guide) => {
    return `- ${guide.label}: use when ${guide.useWhen} Avoid when ${guide.avoidWhen}`;
  }).join("\n");

  return `<SubagentSelection>\n${lines}\n</SubagentSelection>`;
}

export function buildRepoScoutPrompt(promptAppend?: string): string {
  return withShared(
    "Evidence-backed repository scout",
    `<Scope>
Focus only on repository reality.
</Scope>

<Execution>
- Map relevant files, conventions, and similar implementations.
- Prefer concrete file references and concise observations.
- Distinguish proven patterns from guesses.
- Batch independent searches in parallel.
- Return only findings that help another agent implement safely.
</Execution>`,
    promptAppend,
  );
}

export function buildResearcherPrompt(promptAppend?: string): string {
  return withShared(
    "External docs and library researcher",
    `<Scope>
Research external docs, APIs, versions, migrations, and edge cases.
</Scope>

<Execution>
- Prefer official docs and strong engineering sources.
- Compare options only when the choice changes the result.
- Do not implement code.
- Return concise, source-backed guidance for another agent to use.
</Execution>`,
    promptAppend,
  );
}

export function buildBuilderPrompt(promptAppend?: string): string {
  return withShared(
    "Scoped implementation builder",
    `<Scope>
Implement the chosen direction.
</Scope>

<Execution>
- Follow the repo's patterns closely.
- Choose the safest repo-consistent default when minor choices remain.
- Keep changes focused and production-minded.
- Report a blocker only when execution is impossible without a missing secret, credential, or external artifact.
</Execution>`,
    promptAppend,
  );
}

export function buildVerifierPrompt(promptAppend?: string): string {
  return withShared(
    "Verifier and failure classifier",
    `<Scope>
Run the appropriate checks and classify failures.
</Scope>

<Execution>
- Prefer identifying the smallest true cause.
- Separate test failures, build failures, lint failures, and runtime failures.
- Do not redesign the solution.
- Return actionable evidence for repair.
</Execution>`,
    promptAppend,
  );
}

export function buildRepairPrompt(promptAppend?: string): string {
  return withShared(
    "Scoped repair agent",
    `<Scope>
Fix only verifier-reported failures.
</Scope>

<Execution>
- Stay within the assigned scope.
- Do not broaden the task unless the failure proves the scope was wrong.
- Preserve the selected architecture and conventions.
</Execution>`,
    promptAppend,
  );
}

export function buildArchitectPrompt(promptAppend?: string): string {
  return withShared(
    "Implementation architect",
    `<Scope>
Plan non-trivial implementations, migrations, and risky changes.
</Scope>

<Execution>
- Slice the work clearly.
- Identify risks and decisions.
- Avoid over-planning simple work.
- Favor strategies that preserve context and reduce rollback risk.
- Do not hand work off to a separate planning flow when the active agent can continue.
</Execution>`,
    promptAppend,
  );
}
