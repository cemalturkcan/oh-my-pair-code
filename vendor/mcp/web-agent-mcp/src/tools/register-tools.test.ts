import { describe, expect, it } from "vitest";
import { registerTools } from "./register-tools.js";

describe("registerTools", () => {
  it("registers runtime.run_page_script alongside granular browser tools", () => {
    const names: string[] = [];
    const server = {
      registerTool(name: string) {
        names.push(name);
      },
    };

    registerTools(server as never, {} as never);

    expect(names).toContain("runtime.evaluate_js");
    expect(names).toContain("runtime.run_page_script");
    expect(names).toContain("runtime.inject_css");
    expect(names).toContain("runtime.remove_css");
    expect(names).toContain("page.resize");
    expect(names).toContain("act.click");
  });
});
