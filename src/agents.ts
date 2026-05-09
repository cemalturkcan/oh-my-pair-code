import type { AgentLike, HarnessConfig } from "./types";
import { deepMerge } from "./utils";
import { discoverInstalledSkills } from "./skills";
import { buildMissionControlPrompt } from "./prompts/mission-control";
import {
  buildCreativeStrategistPrompt,
  buildFrontendEngineerPrompt,
  buildImplementationEngineerPrompt,
  buildQuickOperatorPrompt,
  buildRepoScoutPrompt,
  buildResearchAnalystPrompt,
  buildVerificationEngineerPrompt,
} from "./prompts/workers";
import { PRIMARY_AGENT, WORKER_AGENTS } from "./orchestrator/constants";

const DEFAULT_MODEL = "openai/gpt-5.5-fast";
const QUICK_OPERATOR_AGENT = "quick-operator";

function withOverride(
  base: AgentLike,
  override?: Record<string, unknown>,
): AgentLike {
  if (!override) return base;
  return deepMerge(base, override);
}

export function createHarnessAgents(
  config: HarnessConfig,
): Record<string, AgentLike> {
  const overrides = config.agents ?? {};
  const installedSkills = discoverInstalledSkills();

  return {
    [PRIMARY_AGENT]: withOverride(
      {
        mode: "primary",
        description:
          "Mission Control — Top-level orchestrator for ledger-backed task decomposition, delegation, blockers, and acceptance gating.",
        model: DEFAULT_MODEL,
        variant: "xhigh",
        prompt: buildMissionControlPrompt(
          overrides[PRIMARY_AGENT]?.prompt_append,
          config.mcps,
          installedSkills,
        ),
        permission: missionControlPermissions(),
        color: "#3B82F6",
      },
      overrides[PRIMARY_AGENT],
    ),

    [QUICK_OPERATOR_AGENT]: withOverride(
      {
        mode: "primary",
        description:
          "quick-operator — Direct-by-default operator for answers, quick repo lookup, small scoped edits, checks, and explicit git workflows.",
        model: DEFAULT_MODEL,
        variant: "medium",
        prompt: buildQuickOperatorPrompt(
          overrides[QUICK_OPERATOR_AGENT]?.prompt_append,
          config.mcps,
          installedSkills,
        ),
        temperature: 0.2,
        permission: quickOperatorPermissions(),
        color: "#64748B",
      },
      overrides[QUICK_OPERATOR_AGENT],
    ),

    [WORKER_AGENTS[0]]: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Implementation Engineer — Scoped implementation worker for backend, tooling, refactors, bug fixes, and repo work.",
        model: DEFAULT_MODEL,
        variant: "low",
        prompt: buildImplementationEngineerPrompt(
          overrides[WORKER_AGENTS[0]]?.prompt_append,
          config.mcps,
          installedSkills,
        ),
        temperature: 0.2,
        permission: implementationEngineerPermissions(),
        color: "#2ECC71",
      },
      overrides[WORKER_AGENTS[0]],
    ),

    [WORKER_AGENTS[1]]: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Frontend Engineer — Scoped frontend/UI worker for pages, components, layout, styling, responsive behavior, and polish.",
        model: DEFAULT_MODEL,
        variant: "low",
        prompt: buildFrontendEngineerPrompt(
          overrides[WORKER_AGENTS[1]]?.prompt_append,
          config.mcps,
          installedSkills,
        ),
        temperature: 0.4,
        permission: frontendEngineerPermissions(),
        color: "#D35400",
      },
      overrides[WORKER_AGENTS[1]],
    ),

    [WORKER_AGENTS[2]]: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Repository Scout — Read-only repository exploration worker for codebase mapping, file discovery, and pattern finding.",
        model: DEFAULT_MODEL,
        variant: "low",
        prompt: buildRepoScoutPrompt(
          overrides[WORKER_AGENTS[2]]?.prompt_append,
          config.mcps,
          installedSkills,
        ),
        temperature: 0.1,
        permission: repoScoutPermissions(),
        color: "#14B8A6",
      },
      overrides[WORKER_AGENTS[2]],
    ),

    [WORKER_AGENTS[3]]: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Research Analyst — External research worker for docs, web, official sources, and source-backed findings.",
        model: DEFAULT_MODEL,
        variant: "low",
        prompt: buildResearchAnalystPrompt(
          overrides[WORKER_AGENTS[3]]?.prompt_append,
          config.mcps,
          installedSkills,
        ),
        temperature: 0.2,
        permission: researchAnalystPermissions(),
        color: "#9B59B6",
      },
      overrides[WORKER_AGENTS[3]],
    ),

    [WORKER_AGENTS[4]]: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Creative Strategist — High-creativity read-only ideation worker for naming, alternate perspectives, workarounds, quick hacks, and non-obvious routes.",
        model: DEFAULT_MODEL,
        variant: "low",
        prompt: buildCreativeStrategistPrompt(
          overrides[WORKER_AGENTS[4]]?.prompt_append,
          config.mcps,
          installedSkills,
        ),
        temperature: 0.9,
        permission: creativeStrategistPermissions(),
        color: "#F59E0B",
      },
      overrides[WORKER_AGENTS[4]],
    ),

    [WORKER_AGENTS[5]]: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Verification Engineer — Acceptance gate worker for evidence review, real/local checks, diff review, and approve/request-changes decisions.",
        model: DEFAULT_MODEL,
        variant: "xhigh",
        prompt: buildVerificationEngineerPrompt(
          overrides[WORKER_AGENTS[5]]?.prompt_append,
          config.mcps,
          installedSkills,
        ),
        temperature: 0.0,
        permission: verificationEngineerPermissions(),
        color: "#E67E22",
      },
      overrides[WORKER_AGENTS[5]],
    ),

    build: { disable: true },
    plan: { disable: true },
  };
}

function missionControlPermissions(): Record<string, unknown> {
  return {
    ...normalToolPermissions(),
    task: {
      "*": "deny",
      "implementation-engineer": "allow",
      "frontend-engineer": "allow",
      "repo-scout": "allow",
      "research-analyst": "allow",
      "creative-strategist": "allow",
      "verification-engineer": "allow",
    },
    ...orchestratorToolPermissions(),
  };
}

function quickOperatorPermissions(): Record<string, unknown> {
  return {
    ...normalToolPermissions(),
    task: {
      "*": "deny",
      "implementation-engineer": "allow",
      "frontend-engineer": "allow",
      "repo-scout": "allow",
      "research-analyst": "allow",
      "creative-strategist": "allow",
      "verification-engineer": "allow",
    },
    orchestrator_session_current: "allow",
    orchestrator_get_current_task: "allow",
    orchestrator_artifact_query: "allow",
    orchestrator_context_query: "allow",
    orchestrator_context_search: "allow",
    orchestrator_tool_preflight: "allow",
    orchestrator_research_route: "allow",
  };
}

function normalToolPermissions(): Record<string, unknown> {
  return {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    edit: "allow",
    bash: "allow",
    question: "allow",
    skill: "allow",
    webfetch: "allow",
    websearch: "allow",
    codesearch: "allow",
  };
}

function orchestratorToolPermissions(): Record<string, unknown> {
  return {
    orchestrator_mission_create: "allow",
    orchestrator_mission_status: "allow",
    orchestrator_task_create: "allow",
    orchestrator_task_update: "allow",
    orchestrator_task_reopen: "allow",
    orchestrator_artifact_publish: "allow",
    orchestrator_artifact_query: "allow",
    orchestrator_context_publish: "allow",
    orchestrator_context_query: "allow",
    orchestrator_decision_record: "allow",
    orchestrator_blocker_create: "allow",
    orchestrator_blocker_resolve: "allow",
    orchestrator_verification_record: "allow",
    orchestrator_gate_check: "allow",
    orchestrator_project_resolve: "allow",
    orchestrator_project_sensitivity_profile: "allow",
    orchestrator_project_status: "allow",
    orchestrator_flight_deck_report: "allow",
    orchestrator_session_attach: "allow",
    orchestrator_session_current: "allow",
    orchestrator_get_current_task: "allow",
    orchestrator_project_tasks: "allow",
    orchestrator_context_search: "allow",
    orchestrator_research_route: "allow",
    orchestrator_tool_preflight: "allow",
    orchestrator_guard_manifest: "allow",
    orchestrator_guard_preflight: "allow",
    orchestrator_secret_env_write: "allow",
    orchestrator_context_compact: "allow",
  };
}

function workerBasePermissions(): Record<string, unknown> {
  return {
    ...normalToolPermissions(),
    task: {
      "*": "allow",
      "implementation-engineer": "allow",
      "frontend-engineer": "allow",
      "repo-scout": "allow",
      "research-analyst": "allow",
      "creative-strategist": "allow",
      "verification-engineer": "allow",
    },
    ...orchestratorToolPermissions(),
  };
}

function implementationEngineerPermissions(): Record<string, unknown> {
  return {
    ...workerBasePermissions(),
  };
}

function frontendEngineerPermissions(): Record<string, unknown> {
  return implementationEngineerPermissions();
}

function repoScoutPermissions(): Record<string, unknown> {
  return {
    ...workerBasePermissions(),
  };
}

function researchAnalystPermissions(): Record<string, unknown> {
  return {
    ...workerBasePermissions(),
  };
}

function creativeStrategistPermissions(): Record<string, unknown> {
  return researchAnalystPermissions();
}

function verificationEngineerPermissions(): Record<string, unknown> {
  return {
    ...workerBasePermissions(),
  };
}
