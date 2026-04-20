export type HookProfile = "minimal" | "standard" | "strict";

export type McpToggles = {
  context7?: boolean;
  grep_app?: boolean;
  web_agent_mcp?: boolean;
  pg_mcp?: boolean;
  ssh_mcp?: boolean;
  searxng?: boolean;
  mariadb?: boolean;
};

export type AgentOverride = {
  model?: string;
  variant?: string;
  description?: string;
  prompt_append?: string;
};

export type WorkflowConfig = {
  compact_subagent_context?: boolean;
};

export type HarnessConfig = {
  set_default_agent?: boolean;
  commands?: {
    enabled?: boolean;
  };
  hooks?: {
    profile?: HookProfile;
    comment_guard?: boolean;
    session_start?: boolean;
    pre_tool_use?: boolean;
    task_tracking?: boolean;
    session_end?: boolean;
  };
  workflow?: WorkflowConfig;
  mcps?: McpToggles;
  agents?: Record<string, AgentOverride>;
};

export type AgentLike = Record<string, unknown>;
