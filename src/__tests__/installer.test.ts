import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  configureSyncRepoPrompt,
  defaultLocalSyncPath,
  hasConfiguredSyncRepo,
  installBundledSkills,
  isGitRemoteUrl,
  mergePluginList,
  prepareSyncCheckout,
  recoverSyncConfigFromDurableCheckout,
  installWebAgentAutostart,
  restartManagedWebAgentDaemon,
  shouldPromptForSync,
  shouldPromptForSyncConfig,
  shouldPreserveFreshInstallEntry,
  stopManagedWebAgentDaemonForSync,
  syncManagedMcp,
  uninstallHarness,
  webAgentTargetBusyMessage,
} from "../installer";

function withTty<T>(stdinIsTty: boolean, stdoutIsTty: boolean, callback: () => T): T {
  const originalStdinIsTty = process.stdin.isTTY;
  const originalStdoutIsTty = process.stdout.isTTY;

  Object.defineProperty(process.stdin, "isTTY", { value: stdinIsTty, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: stdoutIsTty, configurable: true });

  try {
    return callback();
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTty, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTty, configurable: true });
  }
}

function withCi<T>(value: string | undefined, callback: () => T): T {
  const previousCi = process.env.CI;
  if (value === undefined) delete process.env.CI;
  else process.env.CI = value;

  try {
    return callback();
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
  }
}

describe("shouldPreserveFreshInstallEntry", () => {
  it("preserves the shared skills directory during fresh install cleanup", () => {
    const configDir = join(
      tmpdir(),
      `opencode-pair-installer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    mkdirSync(join(configDir, "skills"), { recursive: true });

    expect(shouldPreserveFreshInstallEntry(configDir, "skills")).toBe(true);

    rmSync(configDir, { recursive: true, force: true });
  });
});

describe("configureSyncRepoPrompt", () => {
  async function withMockedPromptInput<T>(answers: string[], callback: () => Promise<T>, stdinStartsPaused = true) {
    const originalWrite = process.stdout.write;
    const originalOn = process.stdin.on;
    const originalOff = process.stdin.off;
    const originalPause = process.stdin.pause;
    const originalIsPaused = process.stdin.isPaused;
    const state = {
      onDataCount: 0,
      offDataCount: 0,
      pauseCount: 0,
      activeDataListeners: 0,
    };
    const activeDataListeners = new Set<(chunk: Buffer) => void>();

    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stdin.on = ((event: string, listener: (chunk: Buffer) => void) => {
      if (event === "data") {
        state.onDataCount += 1;
        activeDataListeners.add(listener);
        state.activeDataListeners = activeDataListeners.size;
        queueMicrotask(() => listener(Buffer.from(answers.shift() ?? "\n")));
      }
      return process.stdin;
    }) as typeof process.stdin.on;
    process.stdin.off = ((event: string, listener: (chunk: Buffer) => void) => {
      if (event === "data") {
        state.offDataCount += 1;
        activeDataListeners.delete(listener);
        state.activeDataListeners = activeDataListeners.size;
      }
      return process.stdin;
    }) as typeof process.stdin.off;
    process.stdin.pause = (() => {
      state.pauseCount += 1;
      return process.stdin;
    }) as typeof process.stdin.pause;
    process.stdin.isPaused = (() => stdinStartsPaused) as typeof process.stdin.isPaused;

    try {
      return { result: await callback(), state };
    } finally {
      process.stdout.write = originalWrite;
      process.stdin.on = originalOn;
      process.stdin.off = originalOff;
      process.stdin.pause = originalPause;
      process.stdin.isPaused = originalIsPaused;
    }
  }

  async function runSyncPrompt(repoAnswer: string, branchAnswer = "sync-main") {
    const root = join(
      tmpdir(),
      `opencode-pair-sync-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const configPath = join(root, "opencode-pair.jsonc");
    const previousStateHome = process.env.XDG_STATE_HOME;

    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, "{}\n", "utf8");
    process.env.XDG_STATE_HOME = join(root, "state");

    try {
      const { result: config, state } = await withMockedPromptInput(
        ["y\n", `${repoAnswer}\n`, `${branchAnswer}\n`],
        async () => {
          await expect(configureSyncRepoPrompt(configPath, {
            cloneRunner: async (_command, args) => {
              if (args[0] === "clone") mkdirSync(join(defaultLocalSyncPath(), ".git"), { recursive: true });
              return { ok: true };
            },
          })).resolves.toBe(true);
          return JSON.parse(readFileSync(configPath, "utf8")) as {
            orchestration?: { sync?: Record<string, unknown> };
          };
        },
      );
      expect(state.onDataCount).toBe(3);
      expect(state.offDataCount).toBe(3);
      expect(state.pauseCount).toBe(1);
      expect(state.activeDataListeners).toBe(0);
      return config;
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("writes prompted HTTPS sync URL as repo with default local path", async () => {
    const previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(tmpdir(), `opencode-pair-state-${Date.now()}`);
    try {
      const config = await runSyncPrompt("https://github.com/cemalturkcan/opencode-pair-state.git");
      expect(config.orchestration?.sync).toMatchObject({
        enabled: true,
        repo: "https://github.com/cemalturkcan/opencode-pair-state.git",
        branch: "sync-main",
      });
      expect(config.orchestration?.sync?.manual_only).toBeUndefined();
      expect(String(config.orchestration?.sync?.path)).toContain("opencode-pair/sync");
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
    }
  });

  it("writes prompted SSH sync URL as repo and keeps local paths as path", async () => {
    expect(isGitRemoteUrl("git@example.com:private/ledger.git")).toBe(true);
    const sshConfig = await runSyncPrompt("git@example.com:private/ledger.git");
    expect(sshConfig.orchestration?.sync?.repo).toBe("git@example.com:private/ledger.git");
    expect(String(sshConfig.orchestration?.sync?.path)).toContain("opencode-pair");

    const localConfig = await runSyncPrompt("/private/sync");
    expect(localConfig.orchestration?.sync?.repo).toBeUndefined();
    expect(localConfig.orchestration?.sync?.path).toBe("/private/sync");
  });

  it("uses the default branch answer and cleans up stdin", async () => {
    const config = await runSyncPrompt("/private/sync", "");
    expect(config.orchestration?.sync?.branch).toBe("main");
  });

  it("pauses stdin cleanup even when prompt input was already flowing", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-sync-flowing-stdin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const configPath = join(root, "opencode-pair.jsonc");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, "{}\n", "utf8");

    try {
      const { result, state } = await withMockedPromptInput(
        ["\n"],
        () => configureSyncRepoPrompt(configPath),
        false,
      );
      expect(result).toBe(false);
      expect(state.onDataCount).toBe(1);
      expect(state.offDataCount).toBe(1);
      expect(state.pauseCount).toBe(1);
      expect(state.activeDataListeners).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleans up stdin when the prompt is declined", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-sync-declined-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const configPath = join(root, "opencode-pair.jsonc");
    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, "{}\n", "utf8");

    try {
      const { result, state } = await withMockedPromptInput(["\n"], () => configureSyncRepoPrompt(configPath));
      expect(result).toBe(false);
      expect(state.onDataCount).toBe(1);
      expect(state.offDataCount).toBe(1);
      expect(state.pauseCount).toBe(1);
      expect(state.activeDataListeners).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleans up stdin when saving sync config fails", async () => {
    const missingConfigPath = join(
      tmpdir(),
      `opencode-pair-sync-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      "opencode-pair.jsonc",
    );

    const state = await withMockedPromptInput(["y\n", "/private/sync\n", "main\n"], async () => {
      await expect(configureSyncRepoPrompt(missingConfigPath)).rejects.toThrow();
    }).then(({ state }) => state);

    expect(state.onDataCount).toBe(3);
    expect(state.offDataCount).toBe(3);
    expect(state.pauseCount).toBe(1);
    expect(state.activeDataListeners).toBe(0);
  });

  it("returns after configuring a remote when the default sync checkout already exists", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-sync-existing-install-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const configPath = join(root, "opencode-pair.jsonc");
    const previousStateHome = process.env.XDG_STATE_HOME;
    const logs: string[] = [];
    const originalLog = console.log;
    let cloneCalls = 0;

    mkdirSync(root, { recursive: true });
    writeFileSync(configPath, "{}\n", "utf8");
    process.env.XDG_STATE_HOME = join(root, "state");
    mkdirSync(join(defaultLocalSyncPath(), ".git"), { recursive: true });
    console.log = ((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    }) as typeof console.log;

    try {
      const { result, state } = await withMockedPromptInput(
        ["y\n", "https://example.com/private-ledger-sync.git\n", "\n"],
        () => configureSyncRepoPrompt(configPath, {
          cloneRunner: async () => {
            cloneCalls += 1;
            return { ok: true };
          },
        }),
      );

      expect(result).toBe(true);
      expect(cloneCalls).toBe(0);
      expect(logs.join("\n")).toContain("Sync checkout already exists");
      expect(state.onDataCount).toBe(3);
      expect(state.offDataCount).toBe(3);
      expect(state.pauseCount).toBe(1);
      expect(state.activeDataListeners).toBe(0);

      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        orchestration?: { sync?: Record<string, unknown> };
      };
      expect(config.orchestration?.sync?.branch).toBe("main");
    } finally {
      console.log = originalLog;
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prepares a missing remote checkout without an extra prompt and pushes the initial checkpoint", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-sync-clone-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const checkoutPath = join(root, "sync");
    const calls: Array<{ command: string; args: string[] }> = [];

    try {
      const result = await prepareSyncCheckout(
        {
          repo: "https://example.com/private-ledger-sync.git",
          path: checkoutPath,
          branch: "ledger",
        },
        {
          ask: async () => {
            throw new Error("prepareSyncCheckout should not ask for a second confirmation");
          },
          cloneRunner: async (command, args, options) => {
            calls.push({ command, args });
            expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
            if (args[0] === "clone") mkdirSync(join(checkoutPath, ".git"), { recursive: true });
            return { ok: true };
          },
        },
      );

      expect(result.status).toBe("ready");
      expect(result.path).toBe(checkoutPath);
      expect(calls[0].args).toEqual([
        "clone",
        "https://example.com/private-ledger-sync.git",
        checkoutPath,
      ]);
      expect(calls.map((call) => call.args)).toContainEqual(["-C", checkoutPath, "checkout", "-B", "ledger"]);
      expect(calls.map((call) => call.args)).toContainEqual(["-C", checkoutPath, "add", "orchestrator.sqlite"]);
      expect(calls.map((call) => call.args)).toContainEqual(["-C", checkoutPath, "commit", "-m", "checkpoint ledger"]);
      expect(calls.map((call) => call.args)).toContainEqual(["-C", checkoutPath, "push", "-u", "origin", "ledger"]);
      expect(existsSync(join(checkoutPath, "orchestrator.sqlite"))).toBe(true);
      expect(existsSync(checkoutPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing sync checkout or non-git path", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-sync-existing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const gitPath = join(root, "git-sync");
    const nonGitPath = join(root, "non-git-sync");
    let cloneCalls = 0;

    try {
      mkdirSync(join(gitPath, ".git"), { recursive: true });
      mkdirSync(nonGitPath, { recursive: true });
      writeFileSync(join(nonGitPath, "keep.txt"), "keep", "utf8");

      const ready = await prepareSyncCheckout(
        { repo: "git@example.com:private/ledger.git", path: gitPath, branch: "main" },
        { ask: async () => true, cloneRunner: async () => { cloneCalls += 1; return { ok: true }; } },
      );
      const warning = await prepareSyncCheckout(
        { repo: "git@example.com:private/ledger.git", path: nonGitPath, branch: "main" },
        { ask: async () => true, cloneRunner: async () => { cloneCalls += 1; return { ok: true }; } },
      );

      expect(ready.status).toBe("ready");
      expect(warning.status).toBe("warning");
      expect(warning.message).toContain("Not overwriting");
      expect(readFileSync(join(nonGitPath, "keep.txt"), "utf8")).toBe("keep");
      expect(cloneCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports clone failures with a manual command and does not throw", async () => {
    const checkoutPath = join(
      tmpdir(),
      `opencode-pair-sync-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    const result = await prepareSyncCheckout(
      { repo: "https://example.com/private-ledger-sync.git", path: checkoutPath, branch: "main" },
      {
        ask: async () => { throw new Error("unexpected prompt"); },
        cloneRunner: async () => ({ ok: false, message: "mock clone failed" }),
      },
    );

    expect(result.status).toBe("warning");
    expect(result.message).toContain("mock clone failed");
    expect(result.nextCommand).toContain("GIT_TERMINAL_PROMPT=0 git clone");
    expect(existsSync(checkoutPath)).toBe(false);
  });

  it("falls back to init when the remote has no main branch", async () => {
    const checkoutPath = join(
      tmpdir(),
      `opencode-pair-sync-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const calls: string[][] = [];

    const result = await prepareSyncCheckout(
      { repo: "https://example.com/private-ledger-sync.git", path: checkoutPath, branch: "main" },
      {
        ask: async () => { throw new Error("unexpected prompt"); },
        cloneRunner: async (_command, args, options) => {
          calls.push(args);
          expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
          if (args[0] === "clone") return { ok: false, message: "fatal: Remote branch main not found in upstream origin" };
          if (args.includes("init")) mkdirSync(join(checkoutPath, ".git"), { recursive: true });
          return { ok: true };
        },
      },
    );

    expect(result.status).toBe("ready");
    expect(result.message).toContain("initialized local checkout on main");
    expect(calls).toContainEqual(["-C", checkoutPath, "init"]);
    expect(calls).toContainEqual(["-C", checkoutPath, "remote", "add", "origin", "https://example.com/private-ledger-sync.git"]);
    expect(calls).toContainEqual(["-C", checkoutPath, "checkout", "-B", "main"]);
    expect(calls).toContainEqual(["-C", checkoutPath, "push", "-u", "origin", "main"]);
  });

  it("checks out the branch when clone succeeds with an empty remote warning", async () => {
    const checkoutPath = join(
      tmpdir(),
      `opencode-pair-sync-empty-warning-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const calls: string[][] = [];

    try {
      const result = await prepareSyncCheckout(
        { repo: "https://example.com/private-ledger-sync.git", path: checkoutPath, branch: "main" },
        {
          ask: async () => { throw new Error("unexpected prompt"); },
          cloneRunner: async (_command, args, options) => {
            calls.push(args);
            expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
            if (args[0] === "clone") {
              mkdirSync(join(checkoutPath, ".git"), { recursive: true });
              return { ok: true, message: "warning: You appear to have cloned an empty repository." };
            }
            return { ok: true };
          },
        },
      );

      expect(result.status).toBe("ready");
      expect(calls).toContainEqual(["-C", checkoutPath, "checkout", "-B", "main"]);
      expect(calls).toContainEqual(["-C", checkoutPath, "push", "-u", "origin", "main"]);
    } finally {
      rmSync(checkoutPath, { recursive: true, force: true });
    }
  });

  it("warns when initial checkpoint push fails but leaves the checkout prepared", async () => {
    const checkoutPath = join(
      tmpdir(),
      `opencode-pair-sync-push-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    try {
      const result = await prepareSyncCheckout(
        { repo: "https://example.com/private-ledger-sync.git", path: checkoutPath, branch: "main" },
        {
          ask: async () => { throw new Error("unexpected prompt"); },
          cloneRunner: async (_command, args) => {
            if (args[0] === "clone") mkdirSync(join(checkoutPath, ".git"), { recursive: true });
            if (args.includes("push")) return { ok: false, message: "auth failed" };
            return { ok: true };
          },
        },
      );

      expect(result.status).toBe("warning");
      expect(result.message).toContain("initial checkpoint push failed");
      expect(result.message).toContain("auth failed");
      expect(existsSync(join(checkoutPath, ".git"))).toBe(true);
    } finally {
      rmSync(checkoutPath, { recursive: true, force: true });
    }
  });
});

describe("installHarness sync prompt gating", () => {
  it("prompts in interactive installs when sync config is missing", () => {
    withCi(undefined, () => {
      withTty(true, true, () => {
        expect(shouldPromptForSyncConfig()).toBe(true);
      });
    });
  });

  it("skips the default prompt when existing sync config is present", () => {
    withCi(undefined, () => {
      withTty(true, true, () => {
        expect(shouldPromptForSyncConfig(undefined, { repo: " /private/sync.git " })).toBe(false);
      });
    });
  });

  it("treats repo, path, url, and env sync values as configured when non-empty", () => {
    const previousRepo = process.env.OPENCODE_PAIR_SYNC_REPO;
    process.env.OPENCODE_PAIR_SYNC_REPO = " git@example.com:private/ledger.git ";

    try {
      expect(hasConfiguredSyncRepo({ repo: "   " })).toBe(true);
      expect(hasConfiguredSyncRepo({ path: "/private/sync" })).toBe(true);
      expect(hasConfiguredSyncRepo({ url: "file:///private/sync" })).toBe(true);
      expect(hasConfiguredSyncRepo({ repo: "", path: "", url: "" })).toBe(true);
    } finally {
      if (previousRepo === undefined) delete process.env.OPENCODE_PAIR_SYNC_REPO;
      else process.env.OPENCODE_PAIR_SYNC_REPO = previousRepo;
    }
  });

  it("does not re-prompt during install when sync config exists even with --configure-sync", () => {
    withCi(undefined, () => {
      withTty(true, true, () => {
        expect(shouldPromptForSyncConfig({ configureSync: true }, { repo: "/private/sync" })).toBe(false);
      });
    });
  });

  it("does not prompt when --no-prompt disables prompts", () => {
    withCi(undefined, () => {
      withTty(true, true, () => {
        expect(shouldPromptForSyncConfig({ promptSync: "never" })).toBe(false);
      });
    });
  });

  it("does not prompt during CI/non-interactive install even with --configure-sync", () => {
    withCi("true", () => {
      withTty(false, false, () => {
      expect(shouldPromptForSync({
        configureSync: true,
      })).toBe(false);
      });
    });
  });

  it("does not prompt or need input listeners for piped installs", () => {
    withCi(undefined, () => {
      withTty(false, true, () => {
        expect(shouldPromptForSyncConfig()).toBe(false);
      });
      withTty(true, false, () => {
        expect(shouldPromptForSyncConfig()).toBe(false);
      });
    });
  });
});

describe("durable sync checkout recovery", () => {
  it("reconstructs sync config from the durable checkout remote and branch after config deletion", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-sync-recover-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");

    try {
      const checkout = defaultLocalSyncPath();
      mkdirSync(join(checkout, ".git"), { recursive: true });
      writeFileSync(join(checkout, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/cemalturkcan/opencode-pair-state.git\n`, "utf8");
      writeFileSync(join(checkout, ".git", "HEAD"), "ref: refs/heads/ledger\n", "utf8");

      const recovered = recoverSyncConfigFromDurableCheckout();

      expect(recovered).toMatchObject({
        enabled: true,
        repo: "https://github.com/cemalturkcan/opencode-pair-state.git",
        path: checkout,
        branch: "ledger",
      });
      expect(shouldPromptForSyncConfig(undefined, recovered)).toBe(false);
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps first-time setup prompt behavior when config and durable checkout are missing", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-sync-first-time-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");

    try {
      expect(recoverSyncConfigFromDurableCheckout()).toEqual({});
      withCi(undefined, () => {
        withTty(true, true, () => {
          expect(shouldPromptForSyncConfig(undefined, recoverSyncConfigFromDurableCheckout())).toBe(true);
        });
      });
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("installBundledSkills", () => {
  it("deploys the bundled web-agent-browser skill with form frame guidance", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-web-agent-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const skillsDir = join(root, "skills");

    try {
      installBundledSkills(skillsDir);

      const installedSkill = readFileSync(
        join(skillsDir, "web-agent-browser", "SKILL.md"),
        "utf8",
      );
      expect(installedSkill).toContain("For login and form flows, stay browser-first");
      expect(installedSkill).toContain("`frame_selector` is optional and iframe-only");
      expect(installedSkill).toContain("never invent placeholder values like `body`, `:scope`, or `__none__`");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes managed bundled skills without overwriting unrelated user skills", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const sourceRoot = join(root, "source-skills");
    const skillsDir = join(root, "skills");

    mkdirSync(join(sourceRoot, "caveman"), { recursive: true });
    writeFileSync(join(sourceRoot, "caveman", "SKILL.md"), "version-1", "utf8");

    installBundledSkills(skillsDir, sourceRoot);
    expect(readFileSync(join(skillsDir, "caveman", "SKILL.md"), "utf8")).toBe("version-1");

    mkdirSync(join(skillsDir, "custom-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "custom-skill", "SKILL.md"), "custom", "utf8");
    writeFileSync(join(sourceRoot, "caveman", "SKILL.md"), "version-2", "utf8");

    installBundledSkills(skillsDir, sourceRoot);

    expect(readFileSync(join(skillsDir, "caveman", "SKILL.md"), "utf8")).toBe("version-2");
    expect(readFileSync(join(skillsDir, "custom-skill", "SKILL.md"), "utf8")).toBe("custom");

    rmSync(root, { recursive: true, force: true });
  });

  it("does not overwrite a pre-existing user skill that was never managed", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-user-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const sourceRoot = join(root, "source-skills");
    const skillsDir = join(root, "skills");

    mkdirSync(join(sourceRoot, "caveman"), { recursive: true });
    mkdirSync(join(skillsDir, "caveman"), { recursive: true });
    writeFileSync(join(sourceRoot, "caveman", "SKILL.md"), "managed", "utf8");
    writeFileSync(join(skillsDir, "caveman", "SKILL.md"), "user-owned", "utf8");

    installBundledSkills(skillsDir, sourceRoot);

    expect(readFileSync(join(skillsDir, "caveman", "SKILL.md"), "utf8")).toBe("user-owned");

    rmSync(root, { recursive: true, force: true });
  });

  it("removes formerly managed skills that are no longer bundled", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-prune-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const sourceRoot = join(root, "source-skills");
    const skillsDir = join(root, "skills");

    mkdirSync(join(sourceRoot, "caveman"), { recursive: true });
    writeFileSync(join(sourceRoot, "caveman", "SKILL.md"), "managed", "utf8");
    installBundledSkills(skillsDir, sourceRoot);

    rmSync(join(sourceRoot, "caveman"), { recursive: true, force: true });
    installBundledSkills(skillsDir, sourceRoot);

    expect(existsSync(join(skillsDir, "caveman"))).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("mergePluginList", () => {
  it("adds the managed plugin entries and keeps unrelated custom plugins", () => {
    const merged = mergePluginList([
      "custom-plugin",
    ]);

    expect(merged).toContain("opencode-pty@latest");
    expect(merged).toContain("custom-plugin");
  });

  it("normalizes managed plugin specs before writing the current managed set", () => {
    const merged = mergePluginList([
      "opencode-pty@1.2.3",
      "@zenobius/opencode-skillful@2.0.0",
      "custom-plugin",
    ]);

    expect(merged.filter((item) => item.startsWith("opencode-pty")).sort()).toEqual([
      "opencode-pty@latest",
    ]);
    expect(
      merged.filter((item) => item.startsWith("@zenobius/opencode-skillful")).sort(),
    ).toEqual(["@zenobius/opencode-skillful@latest"]);
    expect(merged).toContain("custom-plugin");
  });

  it("keeps unrelated local file plugins during install merging", () => {
    const merged = mergePluginList([
      "file:///tmp/custom-local-plugin",
      "opencode-pty@1.2.3",
    ]);

    expect(merged).toContain("file:///tmp/custom-local-plugin");
    expect(merged.filter((item) => item.startsWith("opencode-pty")).sort()).toEqual([
      "opencode-pty@latest",
    ]);
  });
});

describe("uninstallHarness", () => {
  it("removes harness plugin wiring during uninstall", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-uninstall-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;

    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "opencode.json"),
      JSON.stringify(
        {
          plugin: [
            "file:///tmp/opencode-pair",
            "opencode-pty@latest",
            "custom-plugin",
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    process.env.OPENCODE_CONFIG_DIR = root;

    try {
      await uninstallHarness();
      const config = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8")) as {
        plugin?: string[];
      };

      expect(config.plugin).toEqual(["custom-plugin"]);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
      } else {
        process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("syncManagedMcp", () => {
  it("refreshes managed web-agent-mcp deps on source changes and preserves config", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const sourceRoot = join(root, "source-mcp");
    const targetRoot = join(root, "target-mcp");

    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    writeFileSync(join(sourceRoot, "src", "server.ts"), "v1", "utf8");
    writeFileSync(join(sourceRoot, "package.json"), "{}", "utf8");
    mkdirSync(join(targetRoot, "node_modules", "leftpad"), { recursive: true });
    writeFileSync(join(targetRoot, "node_modules", "leftpad", "index.js"), "orphaned", "utf8");
    writeFileSync(join(targetRoot, "config.json"), '{"keep":true}', "utf8");

    syncManagedMcp("web-agent-mcp", sourceRoot, targetRoot);
    expect(readFileSync(join(targetRoot, "config.json"), "utf8")).toBe('{"keep":true}');
    expect(() => readFileSync(join(targetRoot, "node_modules", "leftpad", "index.js"), "utf8")).toThrow();

    mkdirSync(join(targetRoot, "node_modules", "leftpad"), { recursive: true });
    writeFileSync(join(targetRoot, "node_modules", "leftpad", "index.js"), "fresh", "utf8");
    syncManagedMcp("web-agent-mcp", sourceRoot, targetRoot);
    expect(readFileSync(join(targetRoot, "node_modules", "leftpad", "index.js"), "utf8")).toBe("fresh");

    writeFileSync(join(sourceRoot, "src", "server.ts"), "v2", "utf8");
    syncManagedMcp("web-agent-mcp", sourceRoot, targetRoot);
    expect(() => readFileSync(join(targetRoot, "node_modules", "leftpad", "index.js"), "utf8")).toThrow();
    expect(readFileSync(join(targetRoot, "config.json"), "utf8")).toBe('{"keep":true}');

    rmSync(root, { recursive: true, force: true });
  });

  it("prunes formerly managed MCP paths that disappear from the bundled source", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-mcp-prune-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const sourceRoot = join(root, "source-mcp");
    const targetRoot = join(root, "target-mcp");

    mkdirSync(join(sourceRoot, "src", "lib"), { recursive: true });
    writeFileSync(join(sourceRoot, "src", "server.ts"), "server", "utf8");
    writeFileSync(join(sourceRoot, "src", "lib", "old.ts"), "old", "utf8");
    writeFileSync(join(sourceRoot, "config.json"), '{"source":true}', "utf8");

    syncManagedMcp("pg-mcp", sourceRoot, targetRoot);
    writeFileSync(join(targetRoot, "config.json"), '{"keep":true}', "utf8");

    rmSync(join(sourceRoot, "src", "lib", "old.ts"), { force: true });
    syncManagedMcp("pg-mcp", sourceRoot, targetRoot);

    expect(existsSync(join(targetRoot, "src", "lib", "old.ts"))).toBe(false);
    expect(readFileSync(join(targetRoot, "config.json"), "utf8")).toBe('{"keep":true}');

    rmSync(root, { recursive: true, force: true });
  });
});

describe("stopManagedWebAgentDaemonForSync", () => {
  it("stops the user service and daemon before managed web-agent sync", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-web-agent-stop-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const mcpDir = join(root, "web-agent-mcp");
    const previousDataDir = process.env.WEB_AGENT_DAEMON_DATA_DIR;
    const calls: Array<{ command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];

    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(join(mcpDir, "package.json"), "{}", "utf8");
    process.env.WEB_AGENT_DAEMON_DATA_DIR = join(root, "data");

    try {
      const result = await stopManagedWebAgentDaemonForSync(mcpDir, async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd, env: options.env });
        return { ok: true };
      });

      expect(result.status).toBe("stopped");
      expect(calls.map((call) => [call.command, ...call.args])).toEqual([
        ["systemctl", "--user", "--version"],
        ["systemctl", "--user", "stop", "opencode-pair-web-agent.service"],
        ["bun", "run", "daemon:stop"],
      ]);
      expect(calls.every((call) => call.cwd === mcpDir)).toBe(true);
      expect(calls[2]?.env).toMatchObject({ WEB_AGENT_DAEMON: "true" });
    } finally {
      if (previousDataDir === undefined) delete process.env.WEB_AGENT_DAEMON_DATA_DIR;
      else process.env.WEB_AGENT_DAEMON_DATA_DIR = previousDataDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still stops the daemon directly when systemd user is unavailable", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-web-agent-stop-sync-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const mcpDir = join(root, "web-agent-mcp");
    const previousDataDir = process.env.WEB_AGENT_DAEMON_DATA_DIR;
    const calls: Array<{ command: string; args: string[] }> = [];

    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(join(mcpDir, "package.json"), "{}", "utf8");
    process.env.WEB_AGENT_DAEMON_DATA_DIR = join(root, "data");

    try {
      const result = await stopManagedWebAgentDaemonForSync(mcpDir, async (command, args) => {
        calls.push({ command, args });
        return command === "systemctl" ? { ok: false, message: "no user bus" } : { ok: true };
      });

      expect(result.status).toBe("stopped");
      expect(calls.map((call) => [call.command, ...call.args])).toEqual([
        ["systemctl", "--user", "--version"],
        ["bun", "run", "daemon:stop"],
      ]);
    } finally {
      if (previousDataDir === undefined) delete process.env.WEB_AGENT_DAEMON_DATA_DIR;
      else process.env.WEB_AGENT_DAEMON_DATA_DIR = previousDataDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for the direct daemon stop to finish before sync can continue", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-web-agent-stop-sync-wait-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const mcpDir = join(root, "web-agent-mcp");
    const dataDir = join(root, "data");
    const previousDataDir = process.env.WEB_AGENT_DAEMON_DATA_DIR;
    const events: string[] = [];
    let pollCount = 0;

    mkdirSync(mcpDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(mcpDir, "package.json"), "{}", "utf8");
    writeFileSync(join(dataDir, "daemon.json"), '{"pid":12345}', "utf8");
    process.env.WEB_AGENT_DAEMON_DATA_DIR = dataDir;

    try {
      const result = await stopManagedWebAgentDaemonForSync(
        mcpDir,
        async (command, args) => {
          events.push([command, ...args].join(" "));
          return command === "systemctl" ? { ok: false, message: "no user bus" } : { ok: true };
        },
        {
          pollIntervalMs: 1,
          timeoutMs: 50,
          isProcessRunning: () => {
            events.push("poll daemon pid");
            pollCount += 1;
            return pollCount < 2;
          },
        },
      );

      events.push("sync would start");
      expect(result.status).toBe("stopped");
      expect(events).toEqual([
        "systemctl --user --version",
        "bun run daemon:stop",
        "poll daemon pid",
        "poll daemon pid",
        "sync would start",
      ]);
    } finally {
      if (previousDataDir === undefined) delete process.env.WEB_AGENT_DAEMON_DATA_DIR;
      else process.env.WEB_AGENT_DAEMON_DATA_DIR = previousDataDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports both service and daemon stop guidance when daemon exit times out", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-web-agent-stop-sync-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const mcpDir = join(root, "web-agent-mcp");
    const dataDir = join(root, "data");
    const previousDataDir = process.env.WEB_AGENT_DAEMON_DATA_DIR;

    mkdirSync(mcpDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(mcpDir, "package.json"), "{}", "utf8");
    writeFileSync(join(dataDir, "daemon.json"), '{"pid":12345}', "utf8");
    process.env.WEB_AGENT_DAEMON_DATA_DIR = dataDir;

    try {
      const result = await stopManagedWebAgentDaemonForSync(
        mcpDir,
        async (command) => command === "systemctl" ? { ok: false, message: "no user bus" } : { ok: true },
        { pollIntervalMs: 1, timeoutMs: 1, isProcessRunning: () => true },
      );

      expect(result.status).toBe("warning");
      expect(result.message).toContain("systemctl --user stop opencode-pair-web-agent.service");
      expect(result.message).toContain("bun run daemon:stop");
    } finally {
      if (previousDataDir === undefined) delete process.env.WEB_AGENT_DAEMON_DATA_DIR;
      else process.env.WEB_AGENT_DAEMON_DATA_DIR = previousDataDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes service and daemon stop commands in target-busy guidance", () => {
    const message = webAgentTargetBusyMessage("/tmp/web-agent-mcp");

    expect(message).toContain("systemctl --user stop opencode-pair-web-agent.service");
    expect(message).toContain("bun run daemon:stop");
  });

  it("fails clearly before sync when the service cannot be stopped", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-web-agent-stop-sync-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const mcpDir = join(root, "web-agent-mcp");

    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(join(mcpDir, "package.json"), "{}", "utf8");

    try {
      const result = await stopManagedWebAgentDaemonForSync(mcpDir, async (_command, args) => {
        if (args[1] === "--version") return { ok: true };
        return { ok: false, message: "unit stop failed" };
      });

      expect(result.status).toBe("warning");
      expect(result.message).toContain("Could not stop opencode-pair-web-agent.service before syncing web-agent-mcp");
      expect(result.message).toContain("unit stop failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("restartManagedWebAgentDaemon", () => {
  it("stops the existing daemon and starts web-agent detached without deleting profile data", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-web-agent-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const mcpDir = join(root, "web-agent-mcp");
    const profileDir = join(root, "data", "profile");
    const registryPath = join(root, "data", "daemon.json");
    const calls: Array<{ command: string; args: string[]; cwd: string; detached?: boolean; env?: NodeJS.ProcessEnv }> = [];

    mkdirSync(mcpDir, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(mcpDir, "package.json"), '{"scripts":{"daemon":"tsx src/server.ts --daemon"}}', "utf8");
    writeFileSync(join(profileDir, "Cookies"), "keep", "utf8");
    writeFileSync(registryPath, '{"pid":123}', "utf8");

    try {
      const result = await restartManagedWebAgentDaemon(mcpDir, async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd, detached: options.detached, env: options.env });
        return { ok: true };
      });

      expect(result.status).toBe("restarted");
      expect(calls.map(({ command, args, cwd, detached }) => ({ command, args, cwd, detached }))).toEqual([
        { command: "bun", args: ["run", "daemon:stop"], cwd: mcpDir, detached: undefined },
        { command: "bun", args: ["run", "daemon"], cwd: mcpDir, detached: true },
      ]);
      expect(calls[0]?.env).toMatchObject({ WEB_AGENT_DAEMON: "true" });
      expect(calls[1]?.env).toMatchObject({ WEB_AGENT_DAEMON: "true" });
      expect(calls[1]?.env?.WEB_AGENT_DAEMON_DATA_DIR).toContain("opencode-pair/web-agent");
      expect(readFileSync(join(profileDir, "Cookies"), "utf8")).toBe("keep");
      expect(readFileSync(registryPath, "utf8")).toContain("123");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a manual restart command when daemon stop fails", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-web-agent-restart-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const mcpDir = join(root, "web-agent-mcp");

    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(join(mcpDir, "package.json"), "{}", "utf8");

    try {
      const result = await restartManagedWebAgentDaemon(mcpDir, async () => ({ ok: false, message: "mock stop failed" }));

      expect(result.status).toBe("warning");
      expect(result.message).toContain("mock stop failed");
      expect(result.command).toContain("bun run daemon:stop");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("installWebAgentAutostart", () => {
  it("writes and enables a user systemd service for the managed web-agent daemon", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-web-agent-autostart-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const mcpDir = join(root, "web-agent-mcp");
    const home = join(root, "home");
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

    mkdirSync(mcpDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(mcpDir, "package.json"), "{}", "utf8");
    process.env.XDG_CONFIG_HOME = join(home, ".config");

    try {
      const result = await installWebAgentAutostart(mcpDir, async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        return { ok: true };
      });

      const servicePath = join(home, ".config", "systemd", "user", "opencode-pair-web-agent.service");
      const service = readFileSync(servicePath, "utf8");
      expect(result.status).toBe("enabled");
      expect(result.servicePath).toBe(servicePath);
      expect(service).toContain(`WorkingDirectory=${mcpDir}`);
      expect(service).toContain("ExecStart=/usr/bin/env bun run daemon");
      expect(service).toContain("Environment=WEB_AGENT_MCP_HOST=127.0.0.1");
      expect(service).toContain("Environment=WEB_AGENT_DAEMON=true");
      expect(service).toContain("Environment=WEB_AGENT_DAEMON_DATA_DIR=%h/.local/share/opencode-pair/web-agent");
      expect(calls.map((call) => [call.command, ...call.args])).toEqual([
        ["systemctl", "--user", "--version"],
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "opencode-pair-web-agent.service"],
        ["systemctl", "--user", "restart", "opencode-pair-web-agent.service"],
      ]);
      expect(result.commands).toContain("systemctl --user status opencode-pair-web-agent.service");
      expect(result.commands).toContain("systemctl --user disable --now opencode-pair-web-agent.service");
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back safely when systemd user is unavailable without deleting profile data", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-web-agent-autostart-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const mcpDir = join(root, "web-agent-mcp");
    const profileDir = join(root, "profile");
    const previousConfigHome = process.env.XDG_CONFIG_HOME;

    mkdirSync(mcpDir, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(mcpDir, "package.json"), "{}", "utf8");
    writeFileSync(join(profileDir, "Cookies"), "keep", "utf8");
    process.env.XDG_CONFIG_HOME = join(root, "home", ".config");

    try {
      const result = await installWebAgentAutostart(mcpDir, async () => ({ ok: false, message: "no user bus" }));
      expect(result.status).toBe("fallback");
      expect(result.message).toContain("systemctl --user is unavailable");
      expect(readFileSync(join(profileDir, "Cookies"), "utf8")).toBe("keep");
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
