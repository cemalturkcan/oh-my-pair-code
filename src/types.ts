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
    post_tool_use?: boolean;
    pre_compact?: boolean;
    stop?: boolean;
    session_end?: boolean;
    file_edited?: boolean;
  };
  memory?: {
    enabled?: boolean;
    directory?: string;
    lookback_days?: number;
    max_injected_chars?: number;
  };
  learning?: {
    enabled?: boolean;
    directory?: string;
    min_observations?: number;
    auto_promote?: boolean;
    max_patterns?: number;
    max_injected_patterns?: number;
  };
  mcps?: McpToggles;
  agents?: Record<string, AgentOverride>;
};

export type AgentLike = Record<string, unknown>;
