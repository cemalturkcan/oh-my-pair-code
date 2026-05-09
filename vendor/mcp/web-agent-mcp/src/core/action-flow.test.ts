import { describe, expect, it } from "vitest";
import { buildActionSuccessPayload } from "./action-flow.js";

describe("buildActionSuccessPayload", () => {
  it("includes wait and post-action evidence for no-op visibility", () => {
    const payload = buildActionSuccessPayload({
      actionId: "action-1",
      appliedMode: "semantic",
      verificationHint: "Clicked selector #submit",
      targetSelectorKnown: true,
      elapsedMs: 217,
      waitedFor: [
        "Playwright locator.click auto-waited for element actionability and any initiated navigation.",
        "Post-click state probe captured immediate URL/title/target state without an unconditional fixed delay.",
      ],
      before: { url: "https://example.test/start", title: "Start" },
      after: { url: "https://example.test/start", title: "Start" },
      postAction: {
        observableChange: false,
        changed: [],
        guidance:
          "No URL/title/target-state change was observed after the click.",
      },
    });

    expect(payload).toMatchObject({
      timings: { elapsed_ms: 217 },
      before: { url: "https://example.test/start", title: "Start" },
      after: { url: "https://example.test/start", title: "Start" },
      post_action: {
        observable_change: false,
        changed: [],
      },
    });
    expect(payload.waited_for).toContain(
      "Post-click state probe captured immediate URL/title/target state without an unconditional fixed delay.",
    );
    expect(payload.post_action?.guidance).toContain("No URL/title/target-state change");
  });

  it("returns redacted form-state evidence without raw filled values", () => {
    const payload = buildActionSuccessPayload({
      actionId: "action-2",
      appliedMode: "semantic",
      verificationHint: "Filled selector input[type=password]",
      targetSelectorKnown: true,
      elapsedMs: 32,
      waitedFor: ["Read back editable value after fill without returning the raw value."],
      formState: {
        input_type: "password",
        value_present: true,
        value_length: 12,
        requested_value_length: 12,
        matches_requested_value: true,
        used_dom_fallback: false,
      },
    });

    expect(payload.form_state).toEqual({
      input_type: "password",
      value_present: true,
      value_length: 12,
      requested_value_length: 12,
      matches_requested_value: true,
      used_dom_fallback: false,
    });
    expect(JSON.stringify(payload)).not.toContain("super-secret");
  });
});
