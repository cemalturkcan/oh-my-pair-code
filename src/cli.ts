import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SAMPLE_PROJECT_CONFIG } from "./config";
import { installHarness, uninstallHarness } from "./installer";
import { PRIMARY_AGENT } from "./orchestrator/constants";

type CliDeps = {
  installHarness: typeof installHarness;
  uninstallHarness: typeof uninstallHarness;
};

const DEFAULT_CLI_DEPS: CliDeps = {
  installHarness,
  uninstallHarness,
};

function printHelp(): void {
  console.log(`opencode-pair

Commands:
  init [directory]       Create .opencode/opencode-pair.jsonc
  install                Install plugin stack into the active OpenCode config
  install --configure-sync
                          Ask for private ledger sync setup when missing and TTY
  install --no-prompt    Disable installer prompts, including sync setup
  fresh-install          Delete non-config files, then reinstall the stack
  uninstall              Remove harness-managed wiring and keep user config files
  print-config           Print the snippet to add into opencode.json

Interactive installs ask for optional private ledger sync repo settings when
repo/path/url config is missing. CI, non-TTY, and piped installs never prompt.
If a private ledger sync repo/path/url is already configured, or a durable
state checkout exists at $XDG_STATE_HOME/opencode-pair/sync, install reuses it.
Linux installs write a user systemd service for global web-agent MCP autostart
when systemctl --user is available.
`);
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function initProject(directory?: string): void {
  const targetRoot = resolve(directory ?? process.cwd());
  const opencodeDir = join(targetRoot, ".opencode");
  const configPath = join(opencodeDir, "opencode-pair.jsonc");

  if (!existsSync(opencodeDir)) {
    mkdirSync(opencodeDir, { recursive: true });
  }

  if (existsSync(configPath)) {
    console.log(`Already exists: ${configPath}`);
    return;
  }

  writeFileSync(configPath, `${SAMPLE_PROJECT_CONFIG}\n`, "utf8");
  console.log(`Created ${configPath}`);
}

function printConfig(): void {
  console.log(`{
  "plugin": [
    "opencode-pair",
    "@zenobius/opencode-skillful@latest",
    "@franlol/opencode-md-table-formatter@latest",
    "opencode-pty@latest",
    "@mohak34/opencode-notifier@latest"
  ],
  "instructions": [
    "~/.config/opencode/plugin/shell-strategy/shell_strategy.md"
  ],
  "default_agent": "${PRIMARY_AGENT}"
}

Use \`opencode-pair install\` for the real path-aware install.`);
}

export async function main(argv: string[], deps = DEFAULT_CLI_DEPS): Promise<void> {
  const [command, arg] = argv;
  const fresh = hasFlag(argv, "--fresh");
  const configureSync = hasFlag(argv, "--configure-sync");
  const noPrompt = hasFlag(argv, "--no-prompt");

  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    printHelp();
    return;
  }

  if (command === "init") {
    initProject(arg);
    return;
  }

  if (command === "install") {
    try {
      const result = await deps.installHarness({ fresh, configureSync, promptSync: noPrompt ? "never" : undefined });
      console.log(`Installed into ${result.configPath}`);
      console.log(`Updated package manifest ${result.packageJsonPath}`);
      console.log(`Harness config ready at ${result.harnessConfigPath}`);
      if (result.syncConfigured) {
        console.log("Private ledger sync repo configured in user harness config");
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  if (command === "fresh-install") {
    try {
      const result = await deps.installHarness({ fresh: true, configureSync, promptSync: noPrompt ? "never" : undefined });
      console.log(`Fresh-installed into ${result.configPath}`);
      console.log(`Updated package manifest ${result.packageJsonPath}`);
      console.log(`Harness config ready at ${result.harnessConfigPath}`);
      if (result.syncConfigured) {
        console.log("Private ledger sync repo configured in user harness config");
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  if (command === "print-config") {
    printConfig();
    return;
  }

  if (command === "uninstall") {
    try {
      const result = await deps.uninstallHarness();
      console.log(`Uninstalled harness wiring from ${result.configPath}`);
      console.log(`Updated package manifest ${result.packageJsonPath}`);
      console.log(
        `Preserved user files: ${result.preservedPaths.join(", ")}`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  printHelp();
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }

  return resolve(entryPath) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  await main(process.argv.slice(2));
}
