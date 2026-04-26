import { createHash } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { spawn } from "node:child_process";
import { SAMPLE_PROJECT_CONFIG } from "./config";
import { getManagedMcpRoot } from "./mcp";

type JsonRecord = Record<string, unknown>;
type ManagedEntriesManifest = {
  entries?: Record<string, string>;
};

/**
 * npm package names used as plugin entries in opencode.json.
 * Each entry is written as `"<package>@latest"` in the config.
 */
const MANAGED_PLUGIN_ENTRIES = [
  "@tarquinen/opencode-dcp",
  "@zenobius/opencode-skillful",
  "@franlol/opencode-md-table-formatter",
  "opencode-pty",
  "@mohak34/opencode-notifier",
] as const;

const MANAGED_PACKAGE_NAMES = [
  "opencode-pair",
  "@tarquinen/opencode-dcp",
  "opencode-pty",
  "@mohak34/opencode-notifier",
  "@zenobius/opencode-skillful",
  "@franlol/opencode-md-table-formatter",
] as const;

const PACKAGE_SPECS: Record<string, string> = {
  "@tarquinen/opencode-dcp": "latest",
  "opencode-pty": "latest",
  "@mohak34/opencode-notifier": "latest",
  "@zenobius/opencode-skillful": "latest",
  "@franlol/opencode-md-table-formatter": "latest",
  "unique-names-generator": "latest",
  "@modelcontextprotocol/sdk": "latest",
  pg: "latest",
  zod: "latest",
};

const MCP_NAMES = [
  "pg-mcp",
  "ssh-mcp",
  "web-agent-mcp",
  "openai-image-gen-mcp",
] as const;
const STALE_HARNESS_PLUGIN_FRAGMENTS = ["opencode-background-agents-local"] as const;
const STALE_MANAGED_PLUGIN_ENTRIES = ["opencode-google-login"] as const;
const STALE_MANAGED_PACKAGE_NAMES = ["opencode-google-login"] as const;
const MANAGED_SKILLS_MANIFEST = ".opencode-pair-managed-skills.json";
const MANAGED_MCP_STAMP = ".opencode-pair-managed-mcp.json";
const MANAGED_SOURCE_HASH_KEY = "__sourceHash";
const MCP_REQUIRED_PACKAGES: Record<(typeof MCP_NAMES)[number], string[]> = {
  "pg-mcp": ["@modelcontextprotocol/sdk", "pg"],
  "ssh-mcp": ["@modelcontextprotocol/sdk", "zod"],
  "web-agent-mcp": [
    "@modelcontextprotocol/sdk",
    "zod",
    "cloakbrowser",
    "playwright-core",
  ],
  "openai-image-gen-mcp": ["@modelcontextprotocol/sdk"],
};
const SEARXNG_CONTAINER_NAME = "searxng";
const SEARXNG_HOST = "127.0.0.1";
const SEARXNG_PORT = "8099";
const SEARXNG_URL = `http://${SEARXNG_HOST}:${SEARXNG_PORT}`;

function getConfigDir(): string {
  const envDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (envDir) {
    return resolve(envDir);
  }
  return join(homedir(), ".config", "opencode");
}

function getConfigPaths(configDir: string) {
  return {
    configDir,
    binDir: join(configDir, "bin"),
    skillsDir: join(configDir, "skills"),
    configJson: join(configDir, "opencode.json"),
    configJsonc: join(configDir, "opencode.jsonc"),
    packageJson: join(configDir, "package.json"),
    harnessConfig: join(configDir, "opencode-pair.jsonc"),
    dcpConfig: join(configDir, "dcp.jsonc"),
    dcpPromptOverridesDir: join(configDir, "dcp-prompts", "overrides"),
    shellStrategyDir: join(configDir, "plugin", "shell-strategy"),
    notifierConfig: join(configDir, "opencode-notifier.json"),
  };
}

function bundledMcpSourceRoot(name: string): string {
  return join(packageRoot(), "vendor", "mcp", name);
}

function detectMainConfigPath(paths: ReturnType<typeof getConfigPaths>): {
  path: string;
  format: "json" | "jsonc";
} {
  if (existsSync(paths.configJson)) {
    return { path: paths.configJson, format: "json" };
  }
  if (existsSync(paths.configJsonc)) {
    return { path: paths.configJsonc, format: "jsonc" };
  }
  return { path: paths.configJson, format: "json" };
}

function readJsonLike(filePath: string): JsonRecord {
  if (!existsSync(filePath)) {
    return {};
  }

  const raw = readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return {};
  }

  const parsed = parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  return parsed as JsonRecord;
}

function backupFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  const backupPath = `${filePath}.bak.${Date.now()}`;
  copyFileSync(filePath, backupPath);
}

function writeJson(filePath: string, value: JsonRecord): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

export function shouldPreserveFreshInstallEntry(
  configDir: string,
  entryName: string,
): boolean {
  if (entryName === "skills") {
    return true;
  }

  const entryPath = join(configDir, entryName);
  if (!existsSync(entryPath)) {
    return false;
  }

  const stat = statSync(entryPath);
  if (!stat.isFile()) {
    return false;
  }

  if (entryName === "package.json") {
    return false;
  }

  return entryName.endsWith(".json") || entryName.endsWith(".jsonc");
}

function hashDirectoryContents(rootDir: string): string {
  const hash = createHash("sha1");

  function visit(dirPath: string, relativePath = ""): void {
    for (const entry of readdirSync(dirPath).sort()) {
      const entryPath = join(dirPath, entry);
      const nextRelativePath = relativePath ? join(relativePath, entry) : entry;
      const stat = statSync(entryPath);

      if (stat.isDirectory()) {
        hash.update(`dir:${nextRelativePath}`);
        visit(entryPath, nextRelativePath);
        continue;
      }

      hash.update(`file:${nextRelativePath}`);
      hash.update(readFileSync(entryPath));
    }
  }

  visit(rootDir);
  return hash.digest("hex");
}

function hashFileContents(filePath: string): string {
  return createHash("sha1").update(readFileSync(filePath)).digest("hex");
}

function collectManagedEntries(rootDir: string): Record<string, string> {
  const entries: Record<string, string> = {};

  function visit(dirPath: string, relativePath = ""): void {
    for (const entry of readdirSync(dirPath).sort()) {
      const entryPath = join(dirPath, entry);
      const nextRelativePath = relativePath ? join(relativePath, entry) : entry;
      const stat = statSync(entryPath);

      if (stat.isDirectory()) {
        entries[nextRelativePath] = "dir";
        visit(entryPath, nextRelativePath);
        continue;
      }

      entries[nextRelativePath] = hashFileContents(entryPath);
    }
  }

  visit(rootDir);
  return entries;
}

function readManagedEntriesManifest(filePath: string): ManagedEntriesManifest {
  return readJsonLike(filePath) as ManagedEntriesManifest;
}

function writeManagedEntriesManifest(
  filePath: string,
  entries: Record<string, string>,
): void {
  writeJson(filePath, { entries });
}

function managedSkillsManifestPath(skillsDir: string): string {
  return join(skillsDir, MANAGED_SKILLS_MANIFEST);
}

function managedMcpStampPath(mcpDir: string): string {
  return join(mcpDir, MANAGED_MCP_STAMP);
}

function pruneManagedEntries(
  targetRoot: string,
  previousEntries: Record<string, string>,
  nextEntries: Record<string, string>,
  preservedEntries: Set<string>,
): void {
  const stalePaths = Object.keys(previousEntries)
    .filter((entry) => entry !== MANAGED_SOURCE_HASH_KEY)
    .filter((entry) => !(entry in nextEntries))
    .filter((entry) => !preservedEntries.has(entry))
    .sort((a, b) => b.length - a.length);

  for (const relativePath of stalePaths) {
    rmSync(join(targetRoot, relativePath), { recursive: true, force: true });
  }
}

function freshInstallCleanup(configDir: string): void {
  if (!existsSync(configDir)) {
    return;
  }

  for (const entry of readdirSync(configDir)) {
    if (shouldPreserveFreshInstallEntry(configDir, entry)) {
      continue;
    }

    rmSync(join(configDir, entry), { recursive: true, force: true });
  }
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function repositoryToPackageSpec(repository: unknown): string | undefined {
  const source =
    typeof repository === "string"
      ? repository
      : repository &&
          typeof repository === "object" &&
          !Array.isArray(repository) &&
          typeof (repository as JsonRecord).url === "string"
        ? String((repository as JsonRecord).url)
        : undefined;

  if (!source) {
    return undefined;
  }

  const trimmed = source.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("github:")) {
    return trimmed;
  }

  const match = trimmed.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/i);
  if (!match) {
    return undefined;
  }

  return `github:${match[1]}/${match[2]}`;
}

function resolveSelfPackageSpec(): string {
  const override = process.env.OPENCODE_PAIR_AUTONOMY_PACKAGE_SPEC?.trim();
  if (override) {
    return override;
  }

  const root = packageRoot();
  if (existsSync(join(root, ".git"))) {
    return `file:${root}`;
  }

  const metadata = readJsonLike(join(root, "package.json"));
  const repositorySpec = repositoryToPackageSpec(metadata.repository);
  if (repositorySpec) {
    return repositorySpec;
  }

  const version =
    typeof metadata.version === "string" ? metadata.version.trim() : "";
  return version || "latest";
}

export function mergePluginList(existing: unknown): string[] {
  const selfEntry = `file://${packageRoot()}`;
  const desired = [selfEntry, ...MANAGED_PLUGIN_ENTRIES.map((pkg) => `${pkg}@latest`)];
  const current = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string")
    : [];
  const retained = current.filter(
    (item) =>
      !desired.includes(item) &&
      !MANAGED_PLUGIN_ENTRIES.some((pkg) => item === pkg || item.startsWith(`${pkg}@`)) &&
      !STALE_MANAGED_PLUGIN_ENTRIES.some((pkg) => item === pkg || item.startsWith(`${pkg}@`)),
  );
  return [...desired, ...retained];
}

function mergeInstructionsList(
  existing: unknown,
  shellStrategyDir: string,
): string[] {
  const shellInstruction = join(shellStrategyDir, "shell_strategy.md");
  const current = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string")
    : [];
  const retained = current.filter(
    (item) => !item.endsWith("/shell-strategy/shell_strategy.md"),
  );
  return [shellInstruction, ...retained];
}

function removeHarnessPluginList(
  existing: unknown,
): string[] | undefined {
  const managedEntries = new Set([
    ...MANAGED_PLUGIN_ENTRIES.map((pkg) => `${pkg}@latest`),
  ]);
  const current = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string")
    : [];
  const retained = current.filter(
    (item) =>
      !managedEntries.has(item) &&
      !MANAGED_PLUGIN_ENTRIES.some((pkg) => item === pkg || item.startsWith(`${pkg}@`)) &&
      !STALE_MANAGED_PLUGIN_ENTRIES.some((pkg) => item === pkg || item.startsWith(`${pkg}@`)) &&
      !item.includes("opencode-pair") &&
      !STALE_HARNESS_PLUGIN_FRAGMENTS.some((fragment) => item.includes(fragment)),
  );
  return retained.length > 0 ? retained : undefined;
}

function removeHarnessInstructionsList(
  existing: unknown,
): string[] | undefined {
  const current = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string")
    : [];
  const retained = current.filter(
    (item) => !item.endsWith("/shell-strategy/shell_strategy.md"),
  );
  return retained.length > 0 ? retained : undefined;
}

function forceAllowPermissions(config: JsonRecord): void {
  config.permission = "allow";
}

function writeHarnessConfig(filePath: string): void {
  const current = existsSync(filePath) ? readJsonLike(filePath) : {};
  const next = parse(SAMPLE_PROJECT_CONFIG) as JsonRecord;
  const merged: JsonRecord = {
    ...next,
    ...current,
    hooks: {
      ...((next.hooks as JsonRecord | undefined) ?? {}),
      ...((current.hooks as JsonRecord | undefined) ?? {}),
    },
    mcps: {
      ...((next.mcps as JsonRecord | undefined) ?? {}),
      ...((current.mcps as JsonRecord | undefined) ?? {}),
    },
    agents: {
      ...((next.agents as JsonRecord | undefined) ?? {}),
      ...((current.agents as JsonRecord | undefined) ?? {}),
    },
  };

  writeJson(filePath, merged);
}

const DEFAULT_NOTIFIER_CONFIG: JsonRecord = {
  sound: true,
  notification: true,
  timeout: 3,
  suppressWhenFocused: false,
  sounds: {
    permission: "/usr/share/sounds/freedesktop/stereo/message.oga",
    complete: "/usr/share/sounds/freedesktop/stereo/message.oga",
    subagent_complete: "/usr/share/sounds/freedesktop/stereo/message.oga",
    error: "/usr/share/sounds/freedesktop/stereo/message.oga",
    question: "/usr/share/sounds/freedesktop/stereo/message.oga",
    user_cancelled: "/usr/share/sounds/freedesktop/stereo/message.oga",
  },
  volumes: {
    permission: 0.35,
    complete: 0.35,
    subagent_complete: 0.25,
    error: 0.45,
    question: 0.35,
    user_cancelled: 0.2,
  },
};

const DEFAULT_DCP_CONFIG: JsonRecord = {
  $schema:
    "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
  enabled: true,
  debug: false,
  pruneNotification: "detailed",
  pruneNotificationType: "chat",
  manualMode: {
    enabled: false,
    automaticStrategies: true,
  },
  turnProtection: {
    enabled: true,
    turns: 6,
  },
  experimental: {
    allowSubAgents: false,
    customPrompts: true,
  },
  compress: {
    mode: "range",
    permission: "allow",
    showCompression: false,
    summaryBuffer: true,
    maxContextLimit: 258000,
    minContextLimit: 170000,
    modelMaxLimits: {
      "openai/gpt-5.5-fast": 258000,
    },
    modelMinLimits: {
      "openai/gpt-5.5-fast": 170000,
    },
    nudgeFrequency: 1,
    iterationNudgeThreshold: 24,
    nudgeForce: "soft",
    protectedTools: ["task", "skill", "todowrite", "todoread"],
    protectUserMessages: true,
  },
  strategies: {
    deduplication: {
      enabled: true,
      protectedTools: [],
    },
    purgeErrors: {
      enabled: true,
      turns: 6,
      protectedTools: [],
    },
  },
};

const DCP_SYSTEM_PROMPT_OVERRIDE = `You operate in a context-constrained environment. Manage context continuously to avoid buildup and preserve retrieval quality. Efficient context management is paramount for your agentic performance.

The ONLY tool you have for context management is \`compress\`. It replaces older conversation content with technical summaries you produce.

\`<dcp-message-id>\` and \`<dcp-system-reminder>\` tags are environment-injected metadata. Do not output them.

THE PHILOSOPHY OF COMPRESS
\`compress\` transforms conversation content into dense, high-fidelity summaries. This is not cleanup - it is crystallization. Your summary becomes the authoritative record of what transpired.

CONTEXT PRESERVATION PRIORITY
Preserve user intent, explicit decisions, constraints, accepted trade-offs, current task state, and final conclusions with extra care. Treat the user's requests and the assistant/user decisions between turns as high-signal memory.

Tool outputs, repeated searches, logs, verbose command output, dead ends, and transient exploration are low-signal by default. Compress or omit their raw detail unless an exact path, command, error, API contract, file content, or result is needed to continue safely.

COMPRESS WHEN
A section is genuinely closed and the raw conversation has served its purpose:

- Research concluded and findings are clear
- Implementation finished and verified
- Exploration exhausted and patterns understood
- Tool-heavy output is stale, repeated, or no longer needed verbatim
- Dead-end noise can be discarded without waiting for a whole chapter to close

DO NOT COMPRESS IF

- Raw context is still relevant and needed for edits or precise references
- The target content is still actively in progress
- You may need exact code, error messages, or file contents in the immediate next steps
- The only record of a user decision or acceptance criterion would be lost or weakened

Before compressing, ask: "Is this section closed enough to become summary-only right now, while preserving user decisions exactly?"

Evaluate conversation signal-to-noise REGULARLY. Use \`compress\` deliberately with quality-first summaries. Prioritize stale tool noise first, preserve user intent and decisions, and maintain a high-signal context window that supports your agency.
`;

const DCP_COMPRESS_RANGE_PROMPT_OVERRIDE = `Collapse a range in the conversation into a detailed summary.

THE SUMMARY
Your summary must be faithful enough that the original conversation adds no needed value. Capture the durable state: user intent, decisions made, constraints, acceptance criteria, file paths, commands that matter, APIs, errors that still matter, and final verified outcomes.

SIGNAL PRIORITY
Preserve user messages, user/assistant decisions, scope choices, rejected options, and current task state with extra care. Quote short user decisions when exact wording matters.

Treat tool outputs as disposable unless their exact content is required later. Summarize or drop repeated searches, long logs, command noise, transient failed attempts, and verbose file reads after extracting the needed facts. Keep raw-like detail only for exact errors, code snippets, schemas, paths, commands, or outputs that are needed to continue safely.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent exactly. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.

COMPRESSED BLOCK PLACEHOLDERS
When the selected range includes previously compressed blocks, use this exact placeholder format when referencing one:

- \`(bN)\`

Compressed block sections in context are clearly marked with a header:

- \`[Compressed conversation section]\`

Compressed block IDs always use the \`bN\` form (never \`mNNNN\`) and are represented in the same XML metadata tag format.

Rules:

- Include every required block placeholder exactly once.
- Do not invent placeholders for blocks outside the selected range.
- Treat \`(bN)\` placeholders as RESERVED TOKENS. Do not emit \`(bN)\` text anywhere except intentional placeholders.
- If you need to mention a block in prose, use plain text like \`compressed bN\` (not as a placeholder).
- Preflight check before finalizing: the set of \`(bN)\` placeholders in your summary must exactly match the required set, with no duplicates.

These placeholders are semantic references. They will be replaced with the full stored compressed block content when the tool processes your output.

FLOW PRESERVATION WITH PLACEHOLDERS
When you use compressed block placeholders, write the surrounding summary text so it still reads correctly AFTER placeholder expansion.

- Treat each placeholder as a stand-in for a full conversation segment, not as a short label.
- Ensure transitions before and after each placeholder preserve chronology and causality.
- Do not write text that depends on the placeholder staying literal.
- Your final meaning must be coherent once each placeholder is replaced with its full compressed block content.

BOUNDARY IDS
You specify boundaries by ID using the injected IDs visible in the conversation:

- \`mNNNN\` IDs identify raw messages
- \`bN\` IDs identify previously compressed blocks

Each message has an ID inside XML metadata tags like \`<dcp-message-id>...</dcp-message-id>\`.
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as boundary metadata only, not as tool result content.

Rules:

- Pick \`startId\` and \`endId\` directly from injected IDs in context.
- IDs must exist in the current visible context.
- \`startId\` must appear before \`endId\`.
- Do not invent IDs. Use only IDs that are present in context.

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap, include all of them as separate entries in the \`content\` array of a single tool call. Each entry should have its own \`startId\`, \`endId\`, and \`summary\`.
`;

function writeNotifierConfig(filePath: string): void {
  if (existsSync(filePath)) {
    return;
  }
  writeJson(filePath, DEFAULT_NOTIFIER_CONFIG);
}

function writeDcpConfig(filePath: string): void {
  if (existsSync(filePath)) {
    return;
  }
  writeJson(filePath, DEFAULT_DCP_CONFIG);
}

function writeDcpPromptOverrides(overridesDir: string): void {
  ensureDir(overridesDir);
  const files: Record<string, string> = {
    "system.md": DCP_SYSTEM_PROMPT_OVERRIDE,
    "compress-range.md": DCP_COMPRESS_RANGE_PROMPT_OVERRIDE,
  };

  for (const [fileName, content] of Object.entries(files)) {
    const filePath = join(overridesDir, fileName);
    if (existsSync(filePath)) {
      continue;
    }
    writeFileSync(filePath, content, "utf8");
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return await response.text();
}

async function installShellStrategyInstruction(
  shellStrategyDir: string,
): Promise<void> {
  ensureDir(shellStrategyDir);
  const content = await fetchText(
    "https://raw.githubusercontent.com/JRedeker/opencode-shell-strategy/trunk/shell_strategy.md",
  );
  writeFileSync(join(shellStrategyDir, "shell_strategy.md"), content, "utf8");
}

function copyDirectoryContents(
  sourceDir: string,
  targetDir: string,
  options?: {
    overwrite?: (relativePath: string, targetPath: string) => boolean;
  },
  relativePath = "",
): void {
  ensureDir(targetDir);

  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);
    const nextRelativePath = relativePath ? join(relativePath, entry) : entry;
    const stat = statSync(sourcePath);
    if (stat.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath, options, nextRelativePath);
      continue;
    }

    if (
      options?.overwrite &&
      !options.overwrite(nextRelativePath, targetPath)
    ) {
      continue;
    }

    copyFileSync(sourcePath, targetPath);
  }
}

function copyPath(sourcePath: string, targetPath: string): void {
  const stat = statSync(sourcePath);
  if (stat.isDirectory()) {
    copyDirectoryContents(sourcePath, targetPath);
    return;
  }

  ensureDir(dirname(targetPath));
  copyFileSync(sourcePath, targetPath);
}

function hashPathContents(path: string): string {
  return statSync(path).isDirectory() ? hashDirectoryContents(path) : hashFileContents(path);
}

function shouldOverwriteBundledMcpFile(
  relativePath: string,
  targetPath: string,
): boolean {
  return !(relativePath === "config.json" && existsSync(targetPath));
}

function migrateManagedMcpConfig(name: (typeof MCP_NAMES)[number], targetRoot: string): void {
  if (name !== "openai-image-gen-mcp") {
    return;
  }

  const configPath = join(targetRoot, "config.json");
  if (!existsSync(configPath)) {
    return;
  }

  const config = readJsonLike(configPath);
  let changed = false;
  if (config.default_model === "gpt-5.5" || config.default_model === "gpt-5.4") {
    config.default_model = "gpt-5.5-fast";
    changed = true;
  }

  if (config.default_reasoning_effort === "high") {
    config.default_reasoning_effort = "xhigh";
    changed = true;
  }

  if (changed) {
    writeJson(configPath, config);
  }
}

export function syncManagedMcp(
  name: (typeof MCP_NAMES)[number],
  sourceRoot: string,
  targetRoot: string,
): void {
  const sourceHash = hashDirectoryContents(sourceRoot);
  const previousEntries = readManagedEntriesManifest(
    managedMcpStampPath(targetRoot),
  ).entries;
  const nextEntries = collectManagedEntries(sourceRoot);
  ensureDir(targetRoot);
  pruneManagedEntries(
    targetRoot,
    previousEntries ?? {},
    nextEntries,
    new Set(["config.json"]),
  );
  copyDirectoryContents(sourceRoot, targetRoot, {
    overwrite: (relativePath, targetPath) =>
      shouldOverwriteBundledMcpFile(relativePath, targetPath),
  });
  migrateManagedMcpConfig(name, targetRoot);

  if (
    name === "web-agent-mcp" &&
    previousEntries?.[MANAGED_SOURCE_HASH_KEY] !== sourceHash
  ) {
    rmSync(join(targetRoot, "node_modules"), { recursive: true, force: true });
  }

  writeManagedEntriesManifest(managedMcpStampPath(targetRoot), {
    ...nextEntries,
    [MANAGED_SOURCE_HASH_KEY]: sourceHash,
  });
}

function installSelfContainedMcps(): void {
  for (const name of MCP_NAMES) {
    const sourceRoot = bundledMcpSourceRoot(name);
    if (!existsSync(sourceRoot)) {
      throw new Error(`Missing MCP source directory: ${sourceRoot}`);
    }

    const targetRoot = getManagedMcpRoot(name);
    syncManagedMcp(name, sourceRoot, targetRoot);
  }
}

function isManagedMcpInstalled(
  name: (typeof MCP_NAMES)[number],
  mcpDir: string,
): boolean {
  const nodeModules = join(mcpDir, "node_modules");
  if (!existsSync(nodeModules)) {
    return false;
  }

  return MCP_REQUIRED_PACKAGES[name].every((pkg) =>
    existsSync(join(nodeModules, ...pkg.split("/"))),
  );
}

function getManagedMcpInstallCommand(name: (typeof MCP_NAMES)[number]): string[] {
  if (name === "web-agent-mcp") {
    return ["bun", "install"];
  }

  return ["npm", "install", "--omit=dev"];
}

async function installManagedMcpDeps(
  name: (typeof MCP_NAMES)[number],
): Promise<void> {
  const mcpDir = getManagedMcpRoot(name);
  if (!existsSync(mcpDir)) {
    return;
  }
  if (isManagedMcpInstalled(name, mcpDir)) {
    return;
  }

  const [command, ...args] = getManagedMcpInstallCommand(name);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: mcpDir,
      stdio: "inherit",
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} failed for ${name} with exit code ${code ?? -1}`,
        ),
      );
    });
  });
}

async function ensureManagedMcpDependencies(): Promise<void> {
  for (const name of MCP_NAMES) {
    try {
      await installManagedMcpDeps(name);
    } catch (error) {
      console.warn(
        `[opencode-pair] Failed to install ${name} dependencies: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function bundledSkillsSourceRoot(): string {
  return join(packageRoot(), "vendor", "skills");
}

export function installBundledSkills(
  skillsDir: string,
  sourceRoot = bundledSkillsSourceRoot(),
): void {
  if (!existsSync(sourceRoot)) {
    return;
  }

  ensureDir(skillsDir);
  const manifestPath = managedSkillsManifestPath(skillsDir);
  const previousEntries = readManagedEntriesManifest(manifestPath).entries ?? {};
  const nextEntries: Record<string, string> = {};
  const sourceEntries = readdirSync(sourceRoot).sort();

  pruneManagedEntries(skillsDir, previousEntries, {}, new Set(sourceEntries));

  for (const entry of sourceEntries) {
    const sourcePath = join(sourceRoot, entry);
    const targetPath = join(skillsDir, entry);
    const sourceHash = hashPathContents(sourcePath);
    const wasManaged = previousEntries[entry] !== undefined;

    if (existsSync(targetPath) && !wasManaged) {
      continue;
    }

    rmSync(targetPath, { recursive: true, force: true });
    copyPath(sourcePath, targetPath);
    nextEntries[entry] = sourceHash;
  }

  writeManagedEntriesManifest(manifestPath, nextEntries);
}

function updateConfig(paths: ReturnType<typeof getConfigPaths>): string {
  const detected = detectMainConfigPath(paths);
  const config = readJsonLike(detected.path);
  backupFile(detected.path);
  config.$schema = config.$schema ?? "https://opencode.ai/config.json";
  config.plugin = mergePluginList(config.plugin);
  config.instructions = mergeInstructionsList(
    config.instructions,
    paths.shellStrategyDir,
  );
  config.default_agent = "mrrobot";
  forceAllowPermissions(config);
  writeJson(detected.path, config);
  return detected.path;
}

function updatePackageJson(paths: ReturnType<typeof getConfigPaths>): string {
  const pkg = readJsonLike(paths.packageJson);
  backupFile(paths.packageJson);

  const dependencies =
    pkg.dependencies &&
    typeof pkg.dependencies === "object" &&
    !Array.isArray(pkg.dependencies)
      ? { ...(pkg.dependencies as Record<string, string>) }
      : {};

  for (const [name, spec] of Object.entries(PACKAGE_SPECS)) {
    dependencies[name] = spec;
  }
  for (const name of STALE_MANAGED_PACKAGE_NAMES) {
    delete dependencies[name];
  }

  dependencies["opencode-pair"] = resolveSelfPackageSpec();

  pkg.dependencies = dependencies;
  writeJson(paths.packageJson, pkg);
  return paths.packageJson;
}

function ensureTuiConfig(configDir: string): void {
  const tuiPath = join(configDir, "tui.json");
  if (existsSync(tuiPath)) {
    return;
  }

  writeJson(tuiPath, {
    $schema: "https://opencode.ai/tui.json",
    theme: "system",
  });
}

function ensureSkillsDir(skillsDir: string): void {
  ensureDir(skillsDir);
}

function removeDirectoryIfEmpty(dirPath: string): void {
  if (!existsSync(dirPath)) {
    return;
  }

  const stat = statSync(dirPath);
  if (!stat.isDirectory()) {
    return;
  }

  if (readdirSync(dirPath).length > 0) {
    return;
  }

  rmSync(dirPath, { recursive: true, force: true });
}

async function runBunInstall(configDir: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("bun", ["install"], {
      cwd: configDir,
      stdio: "inherit",
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`bun install failed with exit code ${code ?? -1}`),
      );
    });
  });
}

async function ensureInstalledHarnessBuild(configDir: string): Promise<void> {
  const packageDir = join(configDir, "node_modules", "opencode-pair");
  const builtEntry = join(packageDir, "dist", "index.js");
  const sourceEntry = join(packageDir, "src", "index.ts");

  if (existsSync(builtEntry) || !existsSync(sourceEntry)) {
    return;
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("bun", ["run", "build"], {
      cwd: packageDir,
      stdio: "inherit",
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `bun run build failed for opencode-pair with exit code ${code ?? -1}`,
        ),
      );
    });
  });
}

function dockerExec(
  args: string[],
  options?: { captureStdout?: boolean },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("docker", args, {
      stdio: ["ignore", options?.captureStdout ? "pipe" : "inherit", "pipe"],
    });
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
    }
    // stderr is always "pipe" per the stdio config above
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) =>
      reject(new Error(`Failed to spawn docker: ${err.message}`)),
    );
    // Use "close" instead of "exit" — streams may not be fully flushed at "exit"
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const detail =
          stderr.trim() ||
          (signal ? `killed by ${signal}` : `exit code ${code ?? -1}`);
        reject(new Error(`docker ${args[0]} failed: ${detail}`));
      }
    });
  });
}

async function ensureSearxngContainer(): Promise<void> {
  if (process.env.SEARXNG_URL?.trim()) {
    console.log(
      "[opencode-pair] Using external SearXNG at",
      process.env.SEARXNG_URL.trim(),
    );
    return;
  }

  const pathValue = process.env.PATH;
  const dockerInPath = pathValue
    ? pathValue.split(":").some((dir) => existsSync(join(dir, "docker")))
    : false;

  if (!dockerInPath) {
    console.warn(
      "[opencode-pair] Docker not found in PATH. Skipping SearXNG container setup.",
    );
    return;
  }

  try {
    await dockerExec(["info", "--format", "{{.ServerVersion}}"], {
      captureStdout: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const isWSL = Boolean(process.env.WSL_DISTRO_NAME);
    const hint = isWSL
      ? `\n  Hint: Enable WSL Integration for "${process.env.WSL_DISTRO_NAME}" in Docker Desktop → Settings → Resources → WSL Integration.`
      : "";
    console.warn(
      `[opencode-pair] Docker daemon is not reachable. Skipping SearXNG container setup.\n` +
        `  ${detail}${hint}`,
    );
    return;
  }

  try {
    const containerExists = await dockerExec(
      ["ps", "-a", "--filter", `name=^${SEARXNG_CONTAINER_NAME}$`, "--format", "{{.Names}}"],
      { captureStdout: true },
    );

    if (containerExists) {
      if (await shouldRecreateSearxngContainer()) {
        await dockerExec(["rm", "-f", SEARXNG_CONTAINER_NAME]);
        await createSearxngContainer();
      } else {
        const containerRunning = await dockerExec(
          ["ps", "--filter", `name=^${SEARXNG_CONTAINER_NAME}$`, "--format", "{{.Names}}"],
          { captureStdout: true },
        );

        if (!containerRunning) {
          await dockerExec(["start", SEARXNG_CONTAINER_NAME]);
        }
      }
    } else {
      await createSearxngContainer();
    }

    await ensureSearxngJsonFormat();
    if (!(await waitForSearxngHealth(20_000))) {
      console.warn(
        `[opencode-pair] SearXNG is not reachable at ${SEARXNG_URL}. Check Docker port publishing for ${SEARXNG_PORT}:8080.`,
      );
    }
  } catch (error) {
    console.warn(
      `[opencode-pair] Failed to set up SearXNG container: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function shouldRecreateSearxngContainer(): Promise<boolean> {
  try {
    const networkMode = await dockerExec(
      ["inspect", SEARXNG_CONTAINER_NAME, "--format", "{{.HostConfig.NetworkMode}}"],
      { captureStdout: true },
    );
    const ports = await dockerExec(
      ["inspect", SEARXNG_CONTAINER_NAME, "--format", "{{json .HostConfig.PortBindings}}"],
      { captureStdout: true },
    );

    return (
      networkMode !== "bridge" ||
      !ports.includes(`\"HostPort\":\"${SEARXNG_PORT}\"`) ||
      !ports.includes(`\"HostIp\":\"${SEARXNG_HOST}\"`)
    );
  } catch {
    return true;
  }
}

async function createSearxngContainer(): Promise<void> {
  await dockerExec([
    "run",
    "-d",
    "--name",
    SEARXNG_CONTAINER_NAME,
    "--restart",
    "unless-stopped",
    "-p",
    `${SEARXNG_HOST}:${SEARXNG_PORT}:8080`,
    "searxng/searxng:latest",
  ]);
}

async function waitForSearxngHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);

    try {
      const response = await fetch(`${SEARXNG_URL}/healthz`, {
        signal: controller.signal,
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // SearXNG may still be starting.
    } finally {
      clearTimeout(timeout);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

async function ensureSearxngJsonFormat(): Promise<void> {
  let hasJson = false;
  try {
    const output = await dockerExec(
      [
        "exec",
        SEARXNG_CONTAINER_NAME,
        "grep",
        "-c",
        "    - json",
        "/etc/searxng/settings.yml",
      ],
      { captureStdout: true },
    );
    hasJson = parseInt(output, 10) > 0;
  } catch {
    hasJson = false;
  }

  if (hasJson) {
    return;
  }

  await dockerExec([
    "exec",
    SEARXNG_CONTAINER_NAME,
    "sed",
    "-i",
    "/^  formats:/{n;s/    - html/    - html\\n    - json/}",
    "/etc/searxng/settings.yml",
  ]);

  await dockerExec(["restart", SEARXNG_CONTAINER_NAME]);
}

export async function installHarness(options?: { fresh?: boolean }): Promise<{
  configPath: string;
  packageJsonPath: string;
  harnessConfigPath: string;
}> {
  const configDir = getConfigDir();
  const paths = getConfigPaths(configDir);

  if (options?.fresh) {
    freshInstallCleanup(configDir);
  }

  ensureDir(configDir);
  ensureDir(paths.binDir);
  ensureTuiConfig(configDir);
  ensureSkillsDir(paths.skillsDir);

  await installShellStrategyInstruction(paths.shellStrategyDir);
  installSelfContainedMcps();
  await ensureManagedMcpDependencies();
  installBundledSkills(paths.skillsDir);
  await ensureSearxngContainer();
  const configPath = updateConfig(paths);
  const packageJsonPath = updatePackageJson(paths);
  writeHarnessConfig(paths.harnessConfig);
  writeNotifierConfig(paths.notifierConfig);
  writeDcpConfig(paths.dcpConfig);
  writeDcpPromptOverrides(paths.dcpPromptOverridesDir);
  await runBunInstall(configDir);
  await ensureInstalledHarnessBuild(configDir);
  return {
    configPath,
    packageJsonPath,
    harnessConfigPath: paths.harnessConfig,
  };
}

export async function uninstallHarness(): Promise<{
  configPath: string;
  packageJsonPath: string;
  preservedPaths: string[];
}> {
  const configDir = getConfigDir();
  const paths = getConfigPaths(configDir);
  const staleVendorDir = join(configDir, "vendor", "opencode-background-agents-local");
  const detected = detectMainConfigPath(paths);

  if (existsSync(detected.path)) {
    const config = readJsonLike(detected.path);
    backupFile(detected.path);

    const nextPlugin = removeHarnessPluginList(config.plugin);
    if (nextPlugin) {
      config.plugin = nextPlugin;
    } else {
      delete config.plugin;
    }

    const nextInstructions = removeHarnessInstructionsList(config.instructions);
    if (nextInstructions) {
      config.instructions = nextInstructions;
    } else {
      delete config.instructions;
    }

    writeJson(detected.path, config);
  }

  if (existsSync(paths.packageJson)) {
    const pkg = readJsonLike(paths.packageJson);
    const currentDependencies =
      pkg.dependencies &&
      typeof pkg.dependencies === "object" &&
      !Array.isArray(pkg.dependencies)
        ? { ...(pkg.dependencies as Record<string, string>) }
        : undefined;

    if (currentDependencies) {
      backupFile(paths.packageJson);
      for (const packageName of [
        ...MANAGED_PACKAGE_NAMES,
        ...STALE_MANAGED_PACKAGE_NAMES,
      ]) {
        delete currentDependencies[packageName];
      }

      if (Object.keys(currentDependencies).length > 0) {
        pkg.dependencies = currentDependencies;
      } else {
        delete pkg.dependencies;
      }

      writeJson(paths.packageJson, pkg);
      await runBunInstall(configDir);
    }
  }

  rmSync(staleVendorDir, { recursive: true, force: true });
  rmSync(join(paths.shellStrategyDir, "shell_strategy.md"), { force: true });

  removeDirectoryIfEmpty(paths.binDir);
  removeDirectoryIfEmpty(paths.shellStrategyDir);
  removeDirectoryIfEmpty(join(configDir, "plugin"));

  return {
    configPath: detected.path,
    packageJsonPath: paths.packageJson,
    preservedPaths: [
      paths.harnessConfig,
      paths.skillsDir,
      ...MCP_NAMES.map((name) => getManagedMcpRoot(name)),
    ],
  };
}
