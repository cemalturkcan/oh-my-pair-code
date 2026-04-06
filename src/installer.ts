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

type JsonRecord = Record<string, unknown>;

/**
 * npm package names used as plugin entries in opencode.json.
 * Each entry is written as `"<package>@latest"` in the config.
 * The vendor background-agents-local plugin stays as a `file://` entry.
 */
const MANAGED_PLUGIN_ENTRIES = [
  "@zenobius/opencode-skillful",
  "@franlol/opencode-md-table-formatter",
  "opencode-pty",
  "@mohak34/opencode-notifier",
  "opencode-anthropic-login-via-cli",
] as const;

const MANAGED_PACKAGE_NAMES = [
  "opencode-pair",
  "opencode-pty",
  "@mohak34/opencode-notifier",
  "@zenobius/opencode-skillful",
  "@franlol/opencode-md-table-formatter",
  "opencode-anthropic-login-via-cli",
] as const;

const PACKAGE_SPECS: Record<string, string> = {
  "opencode-pty": "latest",
  "@mohak34/opencode-notifier": "latest",
  "@zenobius/opencode-skillful": "latest",
  "@franlol/opencode-md-table-formatter": "latest",
  "opencode-anthropic-login-via-cli": "latest",
  "unique-names-generator": "latest",
  "@modelcontextprotocol/sdk": "latest",
  pg: "latest",
  zod: "latest",
};

const MCP_NAMES = ["pg-mcp", "ssh-mcp", "web-agent-mcp"] as const;

const BACKGROUND_AGENT_FILES = [
  "background-agents.ts",
  "kdco-primitives/get-project-id.ts",
  "kdco-primitives/index.ts",
  "kdco-primitives/log-warn.ts",
  "kdco-primitives/mutex.ts",
  "kdco-primitives/shell.ts",
  "kdco-primitives/temp.ts",
  "kdco-primitives/terminal-detect.ts",
  "kdco-primitives/types.ts",
  "kdco-primitives/with-timeout.ts",
] as const;

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
    vendorDir: join(configDir, "vendor", "opencode-background-agents-local"),
    vendorMcpDir: join(configDir, "vendor", "mcp"),
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

function shouldPreserveFreshInstallEntry(
  configDir: string,
  entryName: string,
): boolean {
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

function mergePluginList(existing: unknown, vendorDir: string): string[] {
  const selfEntry = `file://${packageRoot()}`;
  const backgroundEntry = `file://${vendorDir}`;
  const desired = [
    selfEntry,
    ...MANAGED_PLUGIN_ENTRIES.map((pkg) => `${pkg}@latest`),
    backgroundEntry,
  ];
  const desiredBareNames = new Set<string>(MANAGED_PLUGIN_ENTRIES);
  const current = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string")
    : [];
  const retained = current.filter(
    (item) =>
      !desired.includes(item) &&
      !desiredBareNames.has(item) &&
      !desiredBareNames.has(item.replace(/@latest$/, "")) &&
      !item.includes("opencode-background-agents-local") &&
      !item.startsWith("file://"),
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
  vendorDir: string,
): string[] | undefined {
  const managedBareNames = new Set<string>(MANAGED_PLUGIN_ENTRIES);
  const managedEntries = new Set([
    ...MANAGED_PLUGIN_ENTRIES.map((pkg) => `${pkg}@latest`),
    `file://${vendorDir}`,
  ]);
  const current = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string")
    : [];
  const retained = current.filter(
    (item) =>
      !managedEntries.has(item) &&
      !managedBareNames.has(item) &&
      !managedBareNames.has(item.replace(/@latest$/, "")) &&
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

async function installBackgroundAgentsVendor(vendorDir: string): Promise<void> {
  ensureDir(join(vendorDir, "kdco-primitives"));

  for (const relativePath of BACKGROUND_AGENT_FILES) {
    const url = `https://raw.githubusercontent.com/kdcokenny/opencode-background-agents/main/src/plugin/${relativePath}`;
    const targetPath = join(vendorDir, relativePath);
    ensureDir(dirname(targetPath));
    const content = await fetchText(url);
    writeFileSync(targetPath, content, "utf8");
  }

  const packageJson: JsonRecord = {
    name: "opencode-background-agents-local",
    version: "0.1.0",
    private: true,
    type: "module",
    module: "background-agents.ts",
    main: "background-agents.ts",
    dependencies: {
      "@opencode-ai/plugin": "latest",
      "@opencode-ai/sdk": "latest",
      "unique-names-generator": "latest",
    },
  };

  writeJson(join(vendorDir, "package.json"), packageJson);
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

function shouldOverwriteBundledMcpFile(
  relativePath: string,
  targetPath: string,
  fresh = false,
): boolean {
  if (fresh) {
    return true;
  }

  return !(relativePath === "config.json" && existsSync(targetPath));
}

function installSelfContainedMcps(
  vendorMcpDir: string,
  options?: { fresh?: boolean },
): void {
  ensureDir(vendorMcpDir);

  for (const name of MCP_NAMES) {
    const sourceRoot = bundledMcpSourceRoot(name);
    if (!existsSync(sourceRoot)) {
      throw new Error(`Missing MCP source directory: ${sourceRoot}`);
    }

    const targetRoot = join(vendorMcpDir, name);
    ensureDir(targetRoot);
    copyDirectoryContents(sourceRoot, targetRoot, {
      overwrite: (relativePath, targetPath) =>
        shouldOverwriteBundledMcpFile(relativePath, targetPath, options?.fresh),
    });
  }
}

function isWebAgentMcpInstalled(mcpDir: string): boolean {
  const nodeModules = join(mcpDir, "node_modules");
  if (!existsSync(nodeModules)) {
    return false;
  }
  // Verify key dependencies actually exist inside node_modules
  const requiredPackages = ["@modelcontextprotocol/sdk", "zod"];
  return requiredPackages.every((pkg) =>
    existsSync(join(nodeModules, ...pkg.split("/"))),
  );
}

async function installWebAgentMcpDeps(vendorMcpDir: string): Promise<void> {
  const mcpDir = join(vendorMcpDir, "web-agent-mcp");
  if (!existsSync(mcpDir)) {
    return;
  }
  if (isWebAgentMcpInstalled(mcpDir)) {
    return;
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("bun", ["install"], {
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
          `bun install for web-agent-mcp failed with exit code ${code ?? -1}`,
        ),
      );
    });
  });
}

function bundledSkillsSourceRoot(): string {
  return join(packageRoot(), "vendor", "skills");
}

function installBundledSkills(skillsDir: string): void {
  const sourceRoot = bundledSkillsSourceRoot();
  if (!existsSync(sourceRoot)) {
    return;
  }

  ensureDir(skillsDir);
  copyDirectoryContents(sourceRoot, skillsDir);
}

function updateConfig(paths: ReturnType<typeof getConfigPaths>): string {
  const detected = detectMainConfigPath(paths);
  const config = readJsonLike(detected.path);
  backupFile(detected.path);
  config.$schema = config.$schema ?? "https://opencode.ai/config.json";
  config.plugin = mergePluginList(config.plugin, paths.vendorDir);
  config.instructions = mergeInstructionsList(
    config.instructions,
    paths.shellStrategyDir,
  );
  config.default_agent = "yang";
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
      ["ps", "-a", "--filter", "name=^searxng$", "--format", "{{.Names}}"],
      { captureStdout: true },
    );

    if (containerExists) {
      const containerRunning = await dockerExec(
        ["ps", "--filter", "name=^searxng$", "--format", "{{.Names}}"],
        { captureStdout: true },
      );

      if (!containerRunning) {
        await dockerExec(["start", "searxng"]);
      }
    } else {
      await dockerExec([
        "run",
        "-d",
        "--name",
        "searxng",
        "--restart",
        "unless-stopped",
        "-p",
        "8099:8080",
        "searxng/searxng:latest",
      ]);
    }
    await ensureSearxngJsonFormat();
  } catch (error) {
    console.warn(
      `[opencode-pair] Failed to set up SearXNG container: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function ensureSearxngJsonFormat(): Promise<void> {
  let hasJson = false;
  try {
    const output = await dockerExec(
      [
        "exec",
        "searxng",
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
    "searxng",
    "sed",
    "-i",
    "/^  formats:/{n;s/    - html/    - html\\n    - json/}",
    "/etc/searxng/settings.yml",
  ]);

  await dockerExec(["restart", "searxng"]);
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
  ensureDir(join(configDir, "vendor"));
  ensureTuiConfig(configDir);
  ensureSkillsDir(paths.skillsDir);

  await installShellStrategyInstruction(paths.shellStrategyDir);
  await installBackgroundAgentsVendor(paths.vendorDir);
  installSelfContainedMcps(paths.vendorMcpDir, { fresh: options?.fresh });
  installBundledSkills(paths.skillsDir);
  await ensureSearxngContainer();
  const configPath = updateConfig(paths);
  const packageJsonPath = updatePackageJson(paths);
  writeHarnessConfig(paths.harnessConfig);
  writeNotifierConfig(paths.notifierConfig);
  await runBunInstall(configDir);
  await ensureInstalledHarnessBuild(configDir);
  try {
    await installWebAgentMcpDeps(paths.vendorMcpDir);
  } catch (error) {
    console.warn(
      `[opencode-pair] Failed to install web-agent-mcp dependencies: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

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
  const detected = detectMainConfigPath(paths);

  if (existsSync(detected.path)) {
    const config = readJsonLike(detected.path);
    backupFile(detected.path);

    const nextPlugin = removeHarnessPluginList(config.plugin, paths.vendorDir);
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

  rmSync(paths.vendorDir, { recursive: true, force: true });
  rmSync(join(paths.shellStrategyDir, "shell_strategy.md"), { force: true });

  removeDirectoryIfEmpty(paths.binDir);
  removeDirectoryIfEmpty(paths.shellStrategyDir);
  removeDirectoryIfEmpty(join(configDir, "plugin"));

  return {
    configPath: detected.path,
    packageJsonPath: paths.packageJson,
    preservedPaths: [paths.harnessConfig, paths.vendorMcpDir, paths.skillsDir],
  };
}
