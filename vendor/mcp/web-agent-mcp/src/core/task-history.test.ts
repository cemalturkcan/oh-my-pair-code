import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TaskHistoryStore } from "./task-history.js";
import type { WebAgentEnv } from "../config/env.js";

async function makeHistoryStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "web-agent-history-"));
  const env: WebAgentEnv = {
    serverName: "web-agent-mcp",
    serverVersion: "0.1.0",
    dataDir,
    historyDir: path.join(dataDir, "history"),
    artifactsDir: path.join(dataDir, "artifacts"),
    profilesDir: path.join(dataDir, "profiles"),
    headless: true,
    defaultLocale: "en-US",
    defaultHumanize: false,
    defaultLaunchArgs: [],
    defaultViewport: { width: 1280, height: 720 },
    sessionMaxConsecutiveErrors: 3,
    sessionRestartCooldownMs: 30000,
    daemon: false,
  };

  return { store: new TaskHistoryStore(env), actionPath: path.join(env.historyDir, "actions.jsonl") };
}

describe("TaskHistoryStore", () => {
  it("redacts fill values in persisted action input summaries", async () => {
    const { store, actionPath } = await makeHistoryStore();

    await store.startAction("act.fill", {
      session_id: "session-1",
      page_id: "page-1",
      selector: "input[name='email']",
      value: "raw-fill-value",
      clear_first: true,
      timeout_ms: 5000,
    });

    const raw = await fs.readFile(actionPath, "utf8");
    const record = JSON.parse(raw.trim());

    expect(raw).not.toContain("raw-fill-value");
    expect(record.input_summary).toMatchObject({
      selector: "input[name='email']",
      value: {
        redacted: true,
        value_present: true,
        value_length: 14,
      },
    });
  });

  it("redacts password values and one-time codes in persisted action input summaries", async () => {
    const { store, actionPath } = await makeHistoryStore();

    await store.startAction("act.fill", {
      selector: "input[type='password']",
      type: "password",
      value: "raw-password-value",
    });
    await store.startAction("act.enter_code", {
      selector: "input[autocomplete='one-time-code']",
      code: "123456",
      submit: true,
    });

    const raw = await fs.readFile(actionPath, "utf8");
    const records = raw.trim().split("\n").map((line) => JSON.parse(line));

    expect(raw).not.toContain("raw-password-value");
    expect(raw).not.toContain("123456");
    expect(records[0].input_summary.value).toEqual({
      redacted: true,
      value_present: true,
      value_length: 18,
    });
    expect(records[0].input_summary.type).toBe("password");
    expect(records[1].input_summary.code).toEqual({
      redacted: true,
      value_present: true,
      value_length: 6,
    });
  });
});
