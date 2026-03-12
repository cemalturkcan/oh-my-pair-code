import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { PluginInput } from "@opencode-ai/plugin";
import { detectLocaleFromTexts, type SupportedLocale } from "../i18n";
import type { HarnessConfig, HookProfile } from "../types";
import { promoteLearnedPatterns, renderInjectedPatterns } from "../learning/analyzer";
import { loadLearningArtifact, saveLearningArtifact, saveLearningMarkdown } from "../learning/store";
import type { LearnedPattern } from "../learning/types";
import { detectProjectFacts, joinProjectFactLabels, type ProjectFacts } from "../project-facts";

export type PersistedSessionSummary = {
  sessionID: string;
  savedAt: string;
  locale?: SupportedLocale;
  packageManager: string;
  languages: string[];
  frameworks: string[];
  changedFiles: string[];
  incompleteTodos: string[];
  lastUserMessage: string;
  lastAssistantMessage: string;
  approxTokens: number;
};

type PendingInjection = {
  injected: boolean;
};

export type Observation = {
  timestamp: string;
  phase: "pre" | "post" | "idle";
  sessionID?: string;
  agent?: string;
  tool?: string;
  note?: string;
};

function getStateRoot(config: HarnessConfig): string {
  if (config.memory?.directory) {
    return resolve(config.memory.directory);
  }

  const envDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  const configDir = envDir ? resolve(envDir) : join(homedir(), ".config", "opencode");
  return join(configDir, "pair-autonomy-state");
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

function projectKey(directory: string): string {
  return createHash("sha1").update(directory).digest("hex").slice(0, 12);
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readText(filePath: string): string | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function estimateTokens(chunks: string[]): number {
  const totalChars = chunks.join("\n").length;
  return Math.ceil(totalChars / 4);
}

export function resolveHookProfile(config: HarnessConfig): HookProfile {
  return config.hooks?.profile ?? "standard";
}

export function profileMatches(profile: HookProfile, allowed: HookProfile | HookProfile[]): boolean {
  return (Array.isArray(allowed) ? allowed : [allowed]).includes(profile);
}

export function resolveSessionID(value: unknown): string | undefined {
  const candidate = value as {
    sessionID?: string;
    id?: string;
    info?: { id?: string };
    session?: { id?: string };
  } | undefined;

  return candidate?.sessionID ?? candidate?.id ?? candidate?.info?.id ?? candidate?.session?.id;
}

export function resolveAgentName(value: unknown): string | undefined {
  const candidate = value as {
    agent?: string;
    message?: { agent?: string };
    info?: { agent?: string };
  } | undefined;

  return candidate?.agent ?? candidate?.message?.agent ?? candidate?.info?.agent;
}

export function resolveToolName(value: unknown): string | undefined {
  const candidate = value as { tool?: string } | undefined;
  return typeof candidate?.tool === "string" ? candidate.tool : undefined;
}

export function resolveToolArgs(value: unknown): Record<string, unknown> {
  const candidate = value as { args?: Record<string, unknown> } | undefined;
  return candidate?.args && typeof candidate.args === "object" && !Array.isArray(candidate.args) ? candidate.args : {};
}

export function resolveFilePathFromArgs(args: Record<string, unknown>): string | undefined {
  const value = args.filePath ?? args.path;
  return typeof value === "string" ? value : undefined;
}

export function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (typeof output === "number" || typeof output === "boolean") {
    return String(output);
  }
  if (!output || typeof output !== "object") {
    return "";
  }
  if ("text" in output && typeof (output as { text?: unknown }).text === "string") {
    return (output as { text: string }).text;
  }
  if ("stdout" in output && typeof (output as { stdout?: unknown }).stdout === "string") {
    return (output as { stdout: string }).stdout;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}

function renderSessionContext(params: {
  facts: ProjectFacts;
  latest: PersistedSessionSummary | undefined;
  learnedPatterns: LearnedPattern[];
  maxInjectedPatterns: number;
  maxChars: number;
}): string {
  const { facts, latest, learnedPatterns, maxInjectedPatterns, maxChars } = params;
  const parts = [
    "[SessionStart]",
    `Project package manager: ${facts.packageManager}`,
    `Project languages: ${facts.languages.length > 0 ? joinProjectFactLabels(facts.languages) : "unknown"}`,
    `Project frameworks: ${facts.frameworks.length > 0 ? joinProjectFactLabels(facts.frameworks) : "none detected"}`,
  ];

  if (latest) {
    parts.push(
      "Previous session summary:",
      `- Saved: ${latest.savedAt}`,
      `- Changed files: ${latest.changedFiles.length > 0 ? latest.changedFiles.join(", ") : "none recorded"}`,
      `- Incomplete todos: ${latest.incompleteTodos.length > 0 ? latest.incompleteTodos.join(" | ") : "none recorded"}`,
      `- Last user request: ${latest.lastUserMessage || "n/a"}`,
      `- Last assistant focus: ${latest.lastAssistantMessage || "n/a"}`,
    );
  }

  const injectedPatterns = renderInjectedPatterns(learnedPatterns, maxInjectedPatterns);
  if (injectedPatterns.length > 0) {
    parts.push("Learned project patterns:", ...injectedPatterns);
  }

  parts.push("Use this context only when it helps. Do not restate it unless relevant.");
  return truncate(parts.join("\n"), maxChars);
}

export function createHookRuntime(ctx: PluginInput, config: HarnessConfig) {
  const root = getStateRoot(config);
  const projectRoot = join(root, projectKey(ctx.directory));
  const sessionsDir = join(projectRoot, "sessions");
  const learningDir = config.learning?.directory
    ? resolve(config.learning.directory, projectKey(ctx.directory))
    : join(projectRoot, "learning");
  const observationsPath = join(learningDir, "observations.ndjson");
  const learnedPatternsPath = join(learningDir, "patterns.json");
  const learnedPatternsMarkdownPath = join(learningDir, "patterns.md");
  const pendingInjection = new Map<string, PendingInjection>();
  const sessionAgents = new Map<string, string>();
  const sessionLocales = new Map<string, SupportedLocale>();
  const editedFiles = new Map<string, Set<string>>();
  const toolCounts = new Map<string, number>();
  const compactHints = new Map<string, number>();

  ensureDir(sessionsDir);
  ensureDir(learningDir);

  function getLatestSummaryPath(): string {
    return join(sessionsDir, "latest.json");
  }

  function setSessionAgent(sessionID: string, agent: string | undefined): void {
    if (!agent) {
      return;
    }
    sessionAgents.set(sessionID, agent);
  }

  function getSessionAgent(sessionID: string): string | undefined {
    return sessionAgents.get(sessionID);
  }

  function setSessionLocale(sessionID: string, locale: SupportedLocale | undefined): void {
    if (!locale) {
      return;
    }
    sessionLocales.set(sessionID, locale);
  }

  function getSessionLocale(sessionID: string): SupportedLocale | undefined {
    return sessionLocales.get(sessionID);
  }

  function resolveLocale(sessionID?: string, ...texts: Array<string | undefined>): SupportedLocale {
    if (sessionID && sessionLocales.has(sessionID)) {
      return sessionLocales.get(sessionID) ?? "en";
    }

    const latest = loadLatestSummary();
    return detectLocaleFromTexts(...texts, latest?.locale, latest?.lastUserMessage, latest?.lastAssistantMessage);
  }

  function rememberEditedFile(sessionID: string, filePath: string): void {
    const next = editedFiles.get(sessionID) ?? new Set<string>();
    next.add(filePath);
    editedFiles.set(sessionID, next);
  }

  function getEditedFiles(sessionID: string): string[] {
    return [...(editedFiles.get(sessionID) ?? new Set<string>())].sort();
  }

  function incrementToolCount(sessionID: string): number {
    const next = (toolCounts.get(sessionID) ?? 0) + 1;
    toolCounts.set(sessionID, next);
    return next;
  }

  function shouldSuggestCompact(sessionID: string, threshold = 50, repeat = 25): boolean {
    const count = toolCounts.get(sessionID) ?? 0;
    if (count < threshold) {
      return false;
    }

    const lastHint = compactHints.get(sessionID) ?? 0;
    if (count === threshold || count - lastHint >= repeat) {
      compactHints.set(sessionID, count);
      return true;
    }
    return false;
  }

  function loadLatestSummary(): PersistedSessionSummary | undefined {
    return readJson<PersistedSessionSummary | undefined>(getLatestSummaryPath(), undefined);
  }

  function prepareSessionContext(sessionID: string): void {
    pendingInjection.set(sessionID, {
      injected: false,
    });
  }

  function consumePendingInjection(sessionID: string, locale?: SupportedLocale): string | undefined {
    const entry = pendingInjection.get(sessionID);
    if (!entry || entry.injected) {
      return undefined;
    }
    entry.injected = true;

    const latest = config.memory?.enabled === false ? undefined : loadLatestSummary();
    return renderSessionContext({
      facts: detectProjectFacts(ctx.directory),
      latest,
      learnedPatterns: loadLearnedPatterns(),
      maxInjectedPatterns: config.learning?.max_injected_patterns ?? 5,
      maxChars: config.memory?.max_injected_chars ?? 3500,
    });
  }

  function saveSessionSummary(summary: PersistedSessionSummary): void {
    writeJson(getLatestSummaryPath(), summary);
    writeJson(join(sessionsDir, `${summary.savedAt.replace(/[:.]/g, "-")}-${summary.sessionID}.json`), summary);
  }

  function appendObservation(observation: Observation): void {
    if (config.learning?.enabled === false) {
      return;
    }
    ensureDir(learningDir);
    appendFileSync(observationsPath, `${JSON.stringify(observation)}\n`, "utf8");
  }

  function loadObservations(limit = 200): Observation[] {
    const content = readText(observationsPath);
    if (!content) {
      return [];
    }

    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as Observation;
        } catch {
          return undefined;
        }
      })
      .filter((value): value is Observation => Boolean(value));
  }

  function loadLearnedPatterns(): LearnedPattern[] {
    return loadLearningArtifact(learnedPatternsPath).patterns;
  }

  function promoteLearning(summary: PersistedSessionSummary): LearnedPattern[] {
    if (config.learning?.enabled === false || config.learning?.auto_promote === false) {
      return loadLearnedPatterns();
    }

    const observations = loadObservations();
    if (observations.length < (config.learning?.min_observations ?? 6)) {
      return loadLearnedPatterns();
    }

    const nextPatterns = promoteLearnedPatterns({
      existing: loadLearnedPatterns(),
      summary,
      facts: detectProjectFacts(ctx.directory),
      observations,
      maxPatterns: config.learning?.max_patterns ?? 24,
    });

    saveLearningArtifact(learnedPatternsPath, nextPatterns);
    saveLearningMarkdown(learnedPatternsMarkdownPath, nextPatterns);
    return nextPatterns;
  }

  function clearSession(sessionID: string): void {
    pendingInjection.delete(sessionID);
    sessionAgents.delete(sessionID);
    sessionLocales.delete(sessionID);
    editedFiles.delete(sessionID);
    toolCounts.delete(sessionID);
    compactHints.delete(sessionID);
  }

  return {
    detectProjectFacts: () => detectProjectFacts(ctx.directory),
    estimateTokens,
    loadLatestSummary,
    loadLearnedPatterns,
    prepareSessionContext,
    consumePendingInjection,
    saveSessionSummary,
    appendObservation,
    promoteLearning,
    setSessionAgent,
    getSessionAgent,
    setSessionLocale,
    getSessionLocale,
    resolveLocale,
    rememberEditedFile,
    getEditedFiles,
    incrementToolCount,
    shouldSuggestCompact,
    clearSession,
    readText,
  };
}

export type HookRuntime = ReturnType<typeof createHookRuntime>;
