export type LearnedPatternKind =
  | "user_preference"
  | "repo_convention"
  | "workflow_rule"
  | "failure_pattern"
  | "tooling_pattern";

export type LearningEvidence =
  | string
  | {
    text?: string;
    messageKey?: string;
    values?: Record<string, string | number>;
  };

export type LearnedPattern = {
  id: string;
  kind: LearnedPatternKind;
  summary?: string;
  summaryKey?: string;
  summaryValues?: Record<string, string | number>;
  confidence: number;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  evidence: LearningEvidence[];
  source: "automatic" | "manual";
};

export type LearningArtifact = {
  updatedAt: string;
  patterns: LearnedPattern[];
};

export type LearningCandidate = {
  id: string;
  kind: LearnedPatternKind;
  summary?: string;
  summaryKey?: string;
  summaryValues?: Record<string, string | number>;
  evidence: LearningEvidence;
  baseConfidence: number;
};
