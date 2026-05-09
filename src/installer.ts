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
import { spawn, type StdioOptions } from "node:child_process";
import { SAMPLE_PROJECT_CONFIG } from "./config";
import { getManagedMcpRoot } from "./mcp";
import { DEFAULT_LEDGER_FILENAME, OrchestratorLedger, defaultUserStateDirectory } from "./orchestrator/ledger";
import { PRIMARY_AGENT } from "./orchestrator/constants";

type JsonRecord = Record<string, unknown>;
type ManagedEntriesManifest = {
  entries?: Record<string, string>;
};

type SyncPromptMode = "auto" | "never" | "always";

type InstallHarnessOptions = {
  fresh?: boolean;
  configureSync?: boolean;
  promptSync?: SyncPromptMode;
};

export type SyncCloneRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<{ ok: boolean; message?: string }>;

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; detached?: boolean },
) => Promise<{ ok: boolean; message?: string }>;

export type SyncCheckoutPrepareResult = {
  status: "not_applicable" | "ready" | "missing" | "warning";
  path?: string;
  message: string;
  nextCommand?: string;
};

export type SyncCheckoutPrepareOptions = {
  ask?: (question: string, defaultValue: boolean) => Promise<boolean>;
  cloneRunner?: SyncCloneRunner;
};

export type WebAgentDaemonRestartResult = {
  status: "restarted" | "skipped" | "warning";
  message: string;
  command?: string;
};

export type WebAgentDaemonStopResult = {
  status: "stopped" | "skipped" | "warning";
  message: string;
  commands: string[];
};

export type WebAgentDaemonStopOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  isProcessRunning?: (pid: number) => boolean;
};

export type WebAgentAutostartResult = {
  status: "enabled" | "fallback" | "skipped" | "warning";
  message: string;
  servicePath?: string;
  commands: string[];
};

function webAgentDaemonEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    WEB_AGENT_DAEMON: "true",
    WEB_AGENT_DAEMON_DATA_DIR:
      env.WEB_AGENT_DAEMON_DATA_DIR?.trim() || join(homedir(), ".local", "share", "opencode-pair", "web-agent"),
  };
}

const WEB_AGENT_STOP_WAIT_TIMEOUT_MS = 5000;
const WEB_AGENT_STOP_WAIT_POLL_MS = 100;

/**
 * npm package names used as plugin entries in opencode.json.
 * Each entry is written as `"<package>@latest"` in the config.
 */
const MANAGED_PLUGIN_ENTRIES = [
  "@zenobius/opencode-skillful",
  "@franlol/opencode-md-table-formatter",
  "opencode-pty",
  "@mohak34/opencode-notifier",
] as const;

const MANAGED_PACKAGE_NAMES = [
  "opencode-pair",
  "opencode-pty",
  "@mohak34/opencode-notifier",
  "@zenobius/opencode-skillful",
  "@franlol/opencode-md-table-formatter",
] as const;

const PACKAGE_SPECS: Record<string, string> = {
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
  const orphanedPaths = Object.keys(previousEntries)
    .filter((entry) => entry !== MANAGED_SOURCE_HASH_KEY)
    .filter((entry) => !(entry in nextEntries))
    .filter((entry) => !preservedEntries.has(entry))
    .sort((a, b) => b.length - a.length);

  for (const relativePath of orphanedPaths) {
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
  const selfEntry = `file://${join(packageRoot(), "dist", "index.js")}`;
  const desired = [selfEntry, ...MANAGED_PLUGIN_ENTRIES.map((pkg) => `${pkg}@latest`)];
  const current = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string")
    : [];
  const retained = current.filter(
    (item) =>
      !desired.includes(item) &&
      !MANAGED_PLUGIN_ENTRIES.some((pkg) => item === pkg || item.startsWith(`${pkg}@`)),
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
      !item.includes("opencode-pair"),
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
    workflow: {
      ...((next.workflow as JsonRecord | undefined) ?? {}),
      ...((current.workflow as JsonRecord | undefined) ?? {}),
    },
    orchestration: {
      ...((next.orchestration as JsonRecord | undefined) ?? {}),
      ...((current.orchestration as JsonRecord | undefined) ?? {}),
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

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function shouldPromptForSync(options?: InstallHarnessOptions): boolean {
  return shouldPromptForSyncConfig(options);
}

function getConfiguredSyncRepo(syncConfig?: JsonRecord): string {
  const candidates = [
    syncConfig?.repo,
    syncConfig?.path,
    syncConfig?.url,
    process.env.OPENCODE_PAIR_SYNC_REPO,
    process.env.OPENCODE_PAIR_SYNC_PATH,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "";
}

export function hasConfiguredSyncRepo(syncConfig?: JsonRecord): boolean {
  return Boolean(getConfiguredSyncRepo(syncConfig));
}

export function isGitRemoteUrl(input: string): boolean {
  const value = input.trim();
  return /^(?:https?|ssh|git):\/\//i.test(value) || /^git@[^\s:]+:[^\s]+$/i.test(value);
}

export function defaultLocalSyncPath(): string {
  return join(defaultUserStateDirectory(), "sync");
}

function classifySyncRepoInput(input: string): Partial<Pick<JsonRecord, "repo" | "path">> {
  if (isGitRemoteUrl(input)) return { repo: input, path: defaultLocalSyncPath() };
  return { path: input };
}

function quoteShell(value: string): string {
  return JSON.stringify(value);
}

function manualCloneCommand(repo: string, branch: string, path: string): string {
  return `GIT_TERMINAL_PROMPT=0 git clone ${quoteShell(repo)} ${quoteShell(path)} || (mkdir -p ${quoteShell(path)} && git -C ${quoteShell(path)} init && git -C ${quoteShell(path)} remote add origin ${quoteShell(repo)} && git -C ${quoteShell(path)} checkout -B ${quoteShell(branch)})`;
}

function isGitCheckout(path: string): boolean {
  return existsSync(join(path, ".git"));
}

function readGitCheckoutRemote(path: string): string {
  const configPath = join(path, ".git", "config");
  if (!existsSync(configPath)) return "";
  const raw = readFileSync(configPath, "utf8");
  const origin = raw.match(/\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*([^\n]+)/);
  return origin?.[1]?.trim() ?? "";
}

function readGitCheckoutBranch(path: string): string {
  const headPath = join(path, ".git", "HEAD");
  if (!existsSync(headPath)) return "main";
  const raw = readFileSync(headPath, "utf8").trim();
  const match = raw.match(/^ref:\s+refs\/heads\/(.+)$/);
  return match?.[1]?.trim() || "main";
}

export function recoverSyncConfigFromDurableCheckout(path = defaultLocalSyncPath()): JsonRecord {
  if (!isGitCheckout(path)) return {};
  const remote = readGitCheckoutRemote(path);
  if (!remote) return {};
  return {
    enabled: true,
    repo: remote,
    path,
    branch: readGitCheckoutBranch(path),
  };
}

function isDirectoryEmpty(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory() && readdirSync(path).length === 0;
}

function cleanupInstallerCreatedPath(path: string): void {
  if (isDirectoryEmpty(path)) rmSync(path, { recursive: true, force: true });
}

function isEmptyRemoteCloneFailure(message = ""): boolean {
  return /remote branch .* not found|remote HEAD refers to nonexistent ref|cloned an empty repository|repository is empty/i.test(message);
}

const INSTALLER_CHILD_STDIO: StdioOptions = ["ignore", "inherit", "inherit"];

async function defaultCommandRunner(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; detached?: boolean },
): Promise<{ ok: boolean; message?: string }> {
  return await new Promise((resolvePromise) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: options.detached,
      stdio: options.detached ? "ignore" : INSTALLER_CHILD_STDIO,
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolvePromise({ ok: false, message: error.message });
    });

    if (options.detached) {
      child.unref();
      resolvePromise({ ok: true });
      return;
    }

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        ok: code === 0,
        message: code === 0 ? undefined : `${command} ${args.join(" ")} exited with code ${code ?? -1}`,
      });
    });
  });
}

async function defaultSyncCloneRunner(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
): Promise<{ ok: boolean; message?: string }> {
  return await new Promise((resolvePromise) => {
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "ignore", "pipe"],
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolvePromise({ ok: false, message: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        ok: code === 0,
        message: stderr.trim() || (code === 0 ? undefined : `git clone exited with code ${code}`),
      });
    });
  });
}

async function runSyncGit(runner: SyncCloneRunner, args: string[]): Promise<{ ok: boolean; message?: string }> {
  return await runner("git", args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

function ensureLedgerCheckpointFile(checkoutPath: string): void {
  const target = join(checkoutPath, DEFAULT_LEDGER_FILENAME);
  if (existsSync(target)) return;
  const source = join(defaultUserStateDirectory(), DEFAULT_LEDGER_FILENAME);
  if (existsSync(source)) {
    copyFileSync(source, target);
    return;
  }
  new OrchestratorLedger(target);
}

async function commitAndPushInitialCheckpoint(checkoutPath: string, branch: string, runner: SyncCloneRunner): Promise<{ ok: boolean; warning?: string }> {
  const checkout = await runSyncGit(runner, ["-C", checkoutPath, "checkout", "-B", branch]);
  if (!checkout.ok) return { ok: false, warning: checkout.message ?? "git checkout failed" };
  const add = await runSyncGit(runner, ["-C", checkoutPath, "add", DEFAULT_LEDGER_FILENAME]);
  if (!add.ok) return { ok: false, warning: add.message ?? "git add failed" };
  const commit = await runSyncGit(runner, ["-C", checkoutPath, "commit", "-m", "checkpoint ledger"]);
  if (!commit.ok && !/nothing to commit|no changes added/i.test(commit.message ?? "")) {
    return { ok: false, warning: commit.message ?? "git commit failed" };
  }
  const push = await runSyncGit(runner, ["-C", checkoutPath, "push", "-u", "origin", branch]);
  if (!push.ok) return { ok: false, warning: push.message ?? "git push failed" };
  return { ok: true };
}

async function initializeFallbackCheckout(repo: string, branch: string, path: string, runner: SyncCloneRunner): Promise<{ ok: boolean; message?: string }> {
  ensureDir(path);
  for (const args of [["-C", path, "init"], ["-C", path, "remote", "add", "origin", repo], ["-C", path, "checkout", "-B", branch]]) {
    const result = await runSyncGit(runner, args);
    if (!result.ok) return result;
  }
  return { ok: true };
}

export async function prepareSyncCheckout(
  syncConfig: JsonRecord,
  options?: SyncCheckoutPrepareOptions,
): Promise<SyncCheckoutPrepareResult> {
  const repo = typeof syncConfig.repo === "string" ? syncConfig.repo.trim() : "";
  const configuredPath = typeof syncConfig.path === "string" ? syncConfig.path.trim() : "";
  const branch = typeof syncConfig.branch === "string" && syncConfig.branch.trim()
    ? syncConfig.branch.trim()
    : "main";

  if (!repo || !isGitRemoteUrl(repo)) {
    return {
      status: configuredPath && existsSync(configuredPath) ? "ready" : "not_applicable",
      path: configuredPath || undefined,
      message: configuredPath
        ? `Using configured local sync path: ${configuredPath}`
        : "No remote sync repo URL was configured for checkout preparation.",
    };
  }

  const path = configuredPath || defaultLocalSyncPath();
  const nextCommand = manualCloneCommand(repo, branch, path);
  if (existsSync(path)) {
    if (isGitCheckout(path)) {
      return { status: "ready", path, message: `Sync checkout already exists at ${path}; skipping clone.` };
    }
    return {
      status: "warning",
      path,
      message: `Sync path already exists but is not a git checkout: ${path}. Not overwriting it.`,
      nextCommand,
    };
  }

  ensureDir(dirname(path));
  const runner = options?.cloneRunner ?? defaultSyncCloneRunner;
  const clone = await runSyncGit(runner, ["clone", repo, path]);
  let prepared = clone.ok && existsSync(path);
  let fallbackMessage: string | undefined;

  if (!prepared && isEmptyRemoteCloneFailure(clone.message)) {
    cleanupInstallerCreatedPath(path);
    const fallback = await initializeFallbackCheckout(repo, branch, path, runner);
    prepared = fallback.ok;
    fallbackMessage = fallback.ok ? `Remote had no ${branch} branch; initialized local checkout on ${branch}.` : fallback.message;
  } else if (!prepared) {
    cleanupInstallerCreatedPath(path);
  }

  if (prepared) {
    ensureLedgerCheckpointFile(path);
    const checkpoint = await commitAndPushInitialCheckpoint(path, branch, runner);
    const suffix = fallbackMessage ? ` ${fallbackMessage}` : "";
    if (!checkpoint.ok) {
      return {
        status: "warning",
        path,
        message: `Prepared private sync checkout at ${path}, but initial checkpoint push failed: ${checkpoint.warning}.${suffix}`,
        nextCommand,
      };
    }
    return { status: "ready", path, message: `Prepared private sync checkout at ${path} and pushed initial checkpoint to origin ${branch}.${suffix}` };
  }

  return {
    status: "warning",
    path,
    message: `Could not prepare private sync checkout: ${clone.message ?? fallbackMessage ?? "unknown git failure"}`,
    nextCommand,
  };
}

export function shouldPromptForSyncConfig(
  options?: InstallHarnessOptions,
  syncConfig?: JsonRecord,
): boolean {
  const mode = options?.promptSync ?? (options?.configureSync ? "always" : "auto");
  if (mode === "never" || isTruthyEnv(process.env.CI) || !isInteractiveTerminal()) {
    return false;
  }
  if (hasConfiguredSyncRepo(syncConfig)) {
    return false;
  }
  if (mode === "always" || options?.configureSync === true) {
    return true;
  }
  return true;
}

async function promptLine(question: string, defaultValue = ""): Promise<string> {
  process.stdout.write(defaultValue ? `${question} (${defaultValue}): ` : `${question}: `);

  return await new Promise<string>((resolvePromise) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      value += chunk.toString();
      if (!value.includes("\n")) return;
      process.stdin.off("data", onData);
      resolvePromise(value.trim() || defaultValue);
    };
    process.stdin.on("data", onData);
  });
}

async function withPromptStdinCleanup<T>(callback: () => Promise<T>): Promise<T> {
  try {
    return await callback();
  } finally {
    if (typeof process.stdin.pause === "function") {
      process.stdin.pause();
    }
  }
}

async function promptYesNo(question: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? "Y/n" : "y/N";
  const answer = (await promptLine(`${question} [${suffix}]`)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}

function getExistingSyncConfig(filePath: string): JsonRecord {
  const config = readJsonLike(filePath);
  const orchestration = config.orchestration;
  if (!orchestration || typeof orchestration !== "object" || Array.isArray(orchestration)) {
    return {};
  }
  const sync = (orchestration as JsonRecord).sync;
  if (!sync || typeof sync !== "object" || Array.isArray(sync)) {
    return {};
  }
  return sync as JsonRecord;
}

function writeUserSyncConfig(filePath: string, syncConfig: JsonRecord): void {
  const config = readJsonLike(filePath);
  const orchestration =
    config.orchestration && typeof config.orchestration === "object" && !Array.isArray(config.orchestration)
      ? { ...(config.orchestration as JsonRecord) }
      : {};
  const previousSync =
    orchestration.sync && typeof orchestration.sync === "object" && !Array.isArray(orchestration.sync)
      ? (orchestration.sync as JsonRecord)
      : {};

  config.orchestration = {
    ...orchestration,
    sync: { ...previousSync, ...syncConfig },
  };
  writeJson(filePath, config);
}

function getRecoverableSyncConfig(existingSync: JsonRecord): JsonRecord {
  if (hasConfiguredSyncRepo(existingSync)) return existingSync;
  return recoverSyncConfigFromDurableCheckout();
}

export async function configureSyncRepoPrompt(
  harnessConfigPath: string,
  options?: SyncCheckoutPrepareOptions,
): Promise<boolean> {
  return await withPromptStdinCleanup(async () => {
    const shouldConfigure = await promptYesNo("Configure private ledger sync repo now?", false);
    if (!shouldConfigure) return false;

    const existingSync = getExistingSyncConfig(harnessConfigPath);
    const defaultRepo =
      typeof existingSync.repo === "string"
        ? existingSync.repo
        : typeof existingSync.path === "string"
          ? existingSync.path
          : typeof existingSync.url === "string"
            ? existingSync.url
            : "";
    const defaultBranch = typeof existingSync.branch === "string" ? existingSync.branch : "main";
    const repo = (await promptLine("Private ledger sync repo URL or path", defaultRepo)).trim();
    const branch = (await promptLine("Sync branch", defaultBranch)).trim() || "main";

    if (!repo) {
      console.log("[opencode-pair] Sync repo not configured; repo URL/path was empty.");
      return false;
    }

    const nextSyncConfig = {
      enabled: true,
      ...classifySyncRepoInput(repo),
      branch,
    };
    writeUserSyncConfig(harnessConfigPath, nextSyncConfig);
    console.log(`[opencode-pair] Saved private ledger sync repo settings to ${harnessConfigPath}`);
    const prep = await prepareSyncCheckout(nextSyncConfig, options);
    console.log(`[opencode-pair] ${prep.message}`);
    if (prep.nextCommand) {
      console.log(`[opencode-pair] Manual next command: ${prep.nextCommand}`);
    }
    return true;
  });
}

async function maybeConfigureSyncRepo(
  harnessConfigPath: string,
  options?: InstallHarnessOptions,
): Promise<boolean> {
  const existingSync = getExistingSyncConfig(harnessConfigPath);
  const recoverableSync = getRecoverableSyncConfig(existingSync);
  const recovered = !hasConfiguredSyncRepo(existingSync) && hasConfiguredSyncRepo(recoverableSync);
  if (recovered) {
    writeUserSyncConfig(harnessConfigPath, recoverableSync);
    console.log(`[opencode-pair] Recovered private ledger sync config from durable checkout at ${String(recoverableSync.path)}; skipping prompt.`);
  }

  if (!shouldPromptForSyncConfig(options, recoverableSync)) {
    const repo = typeof recoverableSync.repo === "string" ? recoverableSync.repo.trim() : "";
    const configuredPath = typeof recoverableSync.path === "string" ? recoverableSync.path.trim() : "";
    const localPath = configuredPath || (repo && isGitRemoteUrl(repo) ? defaultLocalSyncPath() : "");
    if (hasConfiguredSyncRepo(recoverableSync) && localPath && existsSync(localPath)) {
      console.log(`[opencode-pair] Existing private ledger sync path found at ${localPath}; skipping checkout preparation.`);
    } else if (hasConfiguredSyncRepo(recoverableSync)) {
      console.log("[opencode-pair] Private ledger sync config is present; checkout preparation was skipped because this install is non-interactive or already configured.");
      if (repo && isGitRemoteUrl(repo)) {
        const branch = typeof recoverableSync.branch === "string" && recoverableSync.branch.trim() ? recoverableSync.branch.trim() : "main";
        console.log(`[opencode-pair] Manual next command: ${manualCloneCommand(repo, branch, localPath || defaultLocalSyncPath())}`);
      }
    }
    return recovered;
  }
  return await configureSyncRepoPrompt(harnessConfigPath);
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

function writeNotifierConfig(filePath: string): void {
  if (existsSync(filePath)) {
    return;
  }
  writeJson(filePath, DEFAULT_NOTIFIER_CONFIG);
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

function isTextBusyError(error: unknown): boolean {
  return error instanceof Error && /ETXTBSY|text file busy/i.test(error.message);
}

export function webAgentTargetBusyMessage(targetRoot: string): string {
  return `Could not sync web-agent-mcp because a target binary is still busy. Stop the web-agent daemon/service, then rerun install: systemctl --user stop opencode-pair-web-agent.service; cd ${quoteShell(targetRoot)} && bun run daemon:stop`;
}

function webAgentDaemonRegistryPath(env: NodeJS.ProcessEnv): string {
  return join(String(env.WEB_AGENT_DAEMON_DATA_DIR), "daemon.json");
}

function readWebAgentDaemonPid(env: NodeJS.ProcessEnv): number | undefined {
  try {
    const registry = JSON.parse(readFileSync(webAgentDaemonRegistryPath(env), "utf8")) as { pid?: unknown };
    return typeof registry.pid === "number" ? registry.pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForWebAgentDaemonExit(
  env: NodeJS.ProcessEnv,
  options?: WebAgentDaemonStopOptions,
): Promise<boolean> {
  const pid = readWebAgentDaemonPid(env);
  if (!pid) return true;

  const isRunning = options?.isProcessRunning ?? isProcessRunning;
  const timeoutMs = options?.timeoutMs ?? WEB_AGENT_STOP_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? WEB_AGENT_STOP_WAIT_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  while (isRunning(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
  }

  return true;
}

export async function stopManagedWebAgentDaemonForSync(
  mcpDir = getManagedMcpRoot("web-agent-mcp"),
  runner: CommandRunner = defaultCommandRunner,
  options?: WebAgentDaemonStopOptions,
): Promise<WebAgentDaemonStopResult> {
  const commands = [
    "systemctl --user stop opencode-pair-web-agent.service",
    `cd ${quoteShell(mcpDir)} && bun run daemon:stop`,
  ];

  if (!existsSync(join(mcpDir, "package.json"))) {
    return {
      status: "skipped",
      message: `web-agent-mcp is not installed at ${mcpDir}; daemon stop before sync skipped.`,
      commands,
    };
  }

  const systemdAvailable = await runner("systemctl", ["--user", "--version"], { cwd: mcpDir, env: process.env });
  if (systemdAvailable.ok) {
    const serviceStop = await runner("systemctl", ["--user", "stop", "opencode-pair-web-agent.service"], {
      cwd: mcpDir,
      env: process.env,
    });
    if (!serviceStop.ok) {
      return {
        status: "warning",
        message: `Could not stop opencode-pair-web-agent.service before syncing web-agent-mcp: ${serviceStop.message ?? "unknown failure"}. Stop it manually with: systemctl --user stop opencode-pair-web-agent.service`,
        commands,
      };
    }
  }

  const env = webAgentDaemonEnv();
  const daemonStop = await runner("bun", ["run", "daemon:stop"], { cwd: mcpDir, env });
  if (!daemonStop.ok) {
    return {
      status: "warning",
      message: `Could not stop existing web-agent MCP daemon before syncing web-agent-mcp: ${daemonStop.message ?? "unknown failure"}. Stop it manually with: cd ${quoteShell(mcpDir)} && bun run daemon:stop`,
      commands,
    };
  }

  if (!(await waitForWebAgentDaemonExit(env, options))) {
    return {
      status: "warning",
      message: `Timed out waiting for existing web-agent MCP daemon to exit before syncing web-agent-mcp. Stop it manually with: systemctl --user stop opencode-pair-web-agent.service; cd ${quoteShell(mcpDir)} && bun run daemon:stop`,
      commands,
    };
  }

  return {
    status: "stopped",
    message: `Stopped existing web-agent MCP service/daemon before syncing ${mcpDir}.`,
    commands,
  };
}

function installSelfContainedMcps(): void {
  for (const name of MCP_NAMES) {
    const sourceRoot = bundledMcpSourceRoot(name);
    if (!existsSync(sourceRoot)) {
      throw new Error(`Missing MCP source directory: ${sourceRoot}`);
    }

    const targetRoot = getManagedMcpRoot(name);
    try {
      syncManagedMcp(name, sourceRoot, targetRoot);
    } catch (error) {
      if (name === "web-agent-mcp" && isTextBusyError(error)) {
        throw new Error(webAgentTargetBusyMessage(targetRoot), { cause: error });
      }
      throw error;
    }
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
      stdio: INSTALLER_CHILD_STDIO,
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

export async function restartManagedWebAgentDaemon(
  mcpDir = getManagedMcpRoot("web-agent-mcp"),
  runner: CommandRunner = defaultCommandRunner,
): Promise<WebAgentDaemonRestartResult> {
  if (!existsSync(join(mcpDir, "package.json"))) {
    return {
      status: "skipped",
      message: `web-agent-mcp is not installed at ${mcpDir}; daemon restart skipped.`,
    };
  }

  const env = webAgentDaemonEnv();
  const stop = await runner("bun", ["run", "daemon:stop"], { cwd: mcpDir, env });
  if (!stop.ok) {
    return {
      status: "warning",
      message: `Could not stop existing web-agent MCP daemon: ${stop.message ?? "unknown failure"}`,
      command: `cd ${quoteShell(mcpDir)} && bun run daemon:stop`,
    };
  }

  const start = await runner("bun", ["run", "daemon"], { cwd: mcpDir, env, detached: true });
  if (!start.ok) {
    return {
      status: "warning",
      message: `Could not restart web-agent MCP daemon: ${start.message ?? "unknown failure"}`,
      command: `cd ${quoteShell(mcpDir)} && bun run daemon`,
    };
  }

  return {
    status: "restarted",
    message: `Restarted web-agent MCP daemon from ${mcpDir}; durable profile and registry directories were not removed.`,
    command: `cd ${quoteShell(mcpDir)} && bun run daemon:stop && bun run daemon`,
  };
}

function systemdUserServicePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "systemd", "user", "opencode-pair-web-agent.service");
}

function webAgentAutostartServiceContent(mcpDir: string): string {
  return `[Unit]
Description=opencode-pair global web-agent MCP daemon
After=default.target

[Service]
Type=simple
WorkingDirectory=${mcpDir}
ExecStart=/usr/bin/env bun run daemon
Restart=on-failure
RestartSec=5
Environment=WEB_AGENT_MCP_HOST=127.0.0.1
Environment=WEB_AGENT_DAEMON=true
Environment=WEB_AGENT_DAEMON_DATA_DIR=%h/.local/share/opencode-pair/web-agent

[Install]
WantedBy=default.target
`;
}

export async function installWebAgentAutostart(
  mcpDir = getManagedMcpRoot("web-agent-mcp"),
  runner: CommandRunner = defaultCommandRunner,
): Promise<WebAgentAutostartResult> {
  if (!existsSync(join(mcpDir, "package.json"))) {
    return {
      status: "skipped",
      message: `web-agent-mcp is not installed at ${mcpDir}; autostart setup skipped.`,
      commands: [],
    };
  }

  const servicePath = systemdUserServicePath();
  const serviceName = "opencode-pair-web-agent.service";
  const statusCommand = `systemctl --user status ${serviceName}`;
  const commands = [
    "systemctl --user daemon-reload",
    `systemctl --user enable ${serviceName}`,
    `systemctl --user restart ${serviceName}`,
    statusCommand,
    `systemctl --user disable --now ${serviceName}`,
  ];

  ensureDir(dirname(servicePath));
  writeFileSync(servicePath, webAgentAutostartServiceContent(mcpDir), "utf8");

  const available = await runner("systemctl", ["--user", "--version"], { cwd: mcpDir, env: process.env });
  if (!available.ok) {
    return {
      status: "fallback",
      message: `Wrote web-agent systemd user service to ${servicePath}, but systemctl --user is unavailable: ${available.message ?? "unknown failure"}. Start manually with: cd ${quoteShell(mcpDir)} && bun run daemon`,
      servicePath,
      commands,
    };
  }

  for (const args of [["--user", "daemon-reload"], ["--user", "enable", serviceName], ["--user", "restart", serviceName]]) {
    const result = await runner("systemctl", args, { cwd: mcpDir, env: process.env });
    if (!result.ok) {
      return {
        status: "warning",
        message: `Wrote web-agent systemd user service to ${servicePath}, but systemctl ${args.join(" ")} failed: ${result.message ?? "unknown failure"}`,
        servicePath,
        commands,
      };
    }
  }

  return {
    status: "enabled",
    message: `Enabled web-agent MCP user autostart at ${servicePath} and restarted ${serviceName}; durable profile and registry directories were not removed.`,
    servicePath,
    commands,
  };
}

async function ensureWebAgentDaemonAutostart(): Promise<void> {
  const autostart = await installWebAgentAutostart();
  if (autostart.status === "enabled") {
    console.log(`[opencode-pair] ${autostart.message}`);
    return;
  }
  if (autostart.status === "fallback" || autostart.status === "warning") {
    console.warn(`[opencode-pair] ${autostart.message}`);
  }
  const daemonRestart = await restartManagedWebAgentDaemon();
  if (daemonRestart.status === "warning") {
    console.warn(`[opencode-pair] ${daemonRestart.message}`);
    console.warn(`[opencode-pair] Manual web-agent daemon command: ${daemonRestart.command}`);
  } else {
    console.log(`[opencode-pair] ${daemonRestart.message}`);
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
  config.default_agent = PRIMARY_AGENT;
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
      stdio: INSTALLER_CHILD_STDIO,
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
      stdio: INSTALLER_CHILD_STDIO,
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

export async function installHarness(options?: InstallHarnessOptions): Promise<{
  configPath: string;
  packageJsonPath: string;
  harnessConfigPath: string;
  syncConfigured: boolean;
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
  const webAgentStop = await stopManagedWebAgentDaemonForSync();
  if (webAgentStop.status === "warning") {
    throw new Error(webAgentStop.message);
  }
  installSelfContainedMcps();
  await ensureManagedMcpDependencies();
  await ensureWebAgentDaemonAutostart();
  installBundledSkills(paths.skillsDir);
  await ensureSearxngContainer();
  const configPath = updateConfig(paths);
  const packageJsonPath = updatePackageJson(paths);
  writeHarnessConfig(paths.harnessConfig);
  const syncConfigured = await maybeConfigureSyncRepo(paths.harnessConfig, options);
  writeNotifierConfig(paths.notifierConfig);
  await runBunInstall(configDir);
  await ensureInstalledHarnessBuild(configDir);
  return {
    configPath,
    packageJsonPath,
    harnessConfigPath: paths.harnessConfig,
    syncConfigured,
  };
}

export async function uninstallHarness(): Promise<{
  configPath: string;
  packageJsonPath: string;
  preservedPaths: string[];
}> {
  const configDir = getConfigDir();
  const paths = getConfigPaths(configDir);
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
      for (const packageName of MANAGED_PACKAGE_NAMES) {
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
