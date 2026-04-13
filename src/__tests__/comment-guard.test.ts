import { describe, expect, it } from "bun:test";
import {
  createCommentGuardHook,
  findSuspiciousCommentHitsInPatch,
  findSuspiciousCommentHitsInText,
  isSuspiciousCommentLine,
} from "../hooks/comment-guard";

describe("isSuspiciousCommentLine", () => {
  it("matches suspicious AI-style comments", () => {
    expect(isSuspiciousCommentLine("// this function handles routing")).toBe(true);
    expect(isSuspiciousCommentLine("// we now return the result")).toBe(true);
    expect(isSuspiciousCommentLine("// helper function to build the payload")).toBe(
      true,
    );
  });

  it("ignores normal technical comments and inline code comments", () => {
    expect(isSuspiciousCommentLine("// trim trailing whitespace before compare")).toBe(
      false,
    );
    expect(isSuspiciousCommentLine("return value; // just a fallback")).toBe(false);
  });
});

describe("findSuspiciousCommentHitsInText", () => {
  it("returns labelled line hits", () => {
    expect(
      findSuspiciousCommentHitsInText(
        ["const value = 1;", "// this function handles setup"].join("\n"),
        "src/example.ts",
      ),
    ).toEqual([
      "src/example.ts:2: // this function handles setup",
    ]);
  });
});

describe("findSuspiciousCommentHitsInPatch", () => {
  it("finds suspicious added comment lines in apply_patch input", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "+// this function handles setup",
      "+const value = 1;",
      "*** End Patch",
    ].join("\n");

    expect(findSuspiciousCommentHitsInPatch(patch)).toEqual([
      "src/example.ts:patch+1: // this function handles setup",
    ]);
  });
});

describe("createCommentGuardHook", () => {
  it("does not crash when tool args are missing", async () => {
    const hook = createCommentGuardHook();

    await expect(
      hook["tool.execute.before"](
        { tool: "apply_patch", sessionID: "s1", callID: "c1" } as any,
        undefined,
      ),
    ).resolves.toBeUndefined();
  });

  it("blocks suspicious patch comments when patchText arrives in the second hook payload", async () => {
    const hook = createCommentGuardHook();
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "+// this function handles setup",
      "*** End Patch",
    ].join("\n");

    await expect(
      hook["tool.execute.before"](
        { tool: "apply_patch", sessionID: "s1", callID: "c1" } as any,
        { args: { patchText } } as any,
      ),
    ).rejects.toThrow("Blocked suspicious AI-style comments before the file edit");
  });

  it("blocks suspicious edit comments when file args arrive in the second hook payload", async () => {
    const hook = createCommentGuardHook();

    await expect(
      hook["tool.execute.before"](
        { tool: "edit", sessionID: "s1", callID: "c1" } as any,
        {
          args: {
            filePath: "src/example.ts",
            newString: "// this function handles setup",
          },
        } as any,
      ),
    ).rejects.toThrow("Blocked suspicious AI-style comments before the file edit");
  });
});
