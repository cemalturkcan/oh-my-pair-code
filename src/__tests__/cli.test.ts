import { describe, expect, it } from "bun:test";
import { main } from "../cli";

describe("cli install command", () => {
  it("awaits the full pipe install path before returning final output", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    let installCompleted = false;

    console.log = ((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    }) as typeof console.log;

    try {
      await main(["install"], {
        installHarness: async () => {
          installCompleted = true;
          return {
            configPath: "/tmp/safe-opencode/opencode.json",
            packageJsonPath: "/tmp/safe-opencode/package.json",
            harnessConfigPath: "/tmp/safe-opencode/opencode-pair.jsonc",
            syncConfigured: true,
          };
        },
        uninstallHarness: async () => {
          throw new Error("uninstall should not run");
        },
      });
    } finally {
      console.log = originalLog;
    }

    expect(installCompleted).toBe(true);
    expect(logs).toEqual([
      "Installed into /tmp/safe-opencode/opencode.json",
      "Updated package manifest /tmp/safe-opencode/package.json",
      "Harness config ready at /tmp/safe-opencode/opencode-pair.jsonc",
      "Private ledger sync repo configured in user harness config",
    ]);
  });
});
