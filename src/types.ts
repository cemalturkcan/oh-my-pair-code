export type HarnessMode = "pair" | "autonomous";

export type McpToggles = {
  context7?: boolean;
  grep_app?: boolean;
  websearch?: boolean;
  chrome_devtools?: boolean;
  pg_mcp?: boolean;
  ssh_mcp?: boolean;
  sudo_mcp?: boolean;
  jina?: boolean;
};

export type AgentOverride = {
  model?: string;
  variant?: string;
  description?: string;
  prompt_append?: string;
};

export type HarnessConfig = {
  default_mode?: HarnessMode;
  set_default_agent?: boolean;
  commands?: {
    enabled?: boolean;
  };
  credentials?: {
    jina_api_key?: string;
  };
  hooks?: {
    intent_gate?: boolean;
    todo_continuation?: boolean;
    comment_guard?: boolean;
    todo_continuation_cooldown_ms?: number;
  };
  mcps?: McpToggles;
  agents?: Record<string, AgentOverride>;
};

export type AgentLike = Record<string, unknown>;
