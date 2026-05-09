import { describe, expect, it } from "vitest";
import { classifyAuthStateSnapshot } from "./auth-heuristics.js";

describe("classifyAuthStateSnapshot", () => {
  it("does not classify generic segmented inputs as a verification-code flow", () => {
    const result = classifyAuthStateSnapshot({
      pageUrl: "https://example.test/form",
      pageTitle: "Survey",
      pageText: "Enter four project tags",
      pageInputs: Array.from({ length: 4 }, (_, index) => ({
        tag: "input",
        type: "text",
        id: `tag-${index}`,
        visible: true,
      })),
      pageButtons: [],
      frames: [],
      recentNetwork: [],
    });

    expect(result.state).not.toBe("verification_code");
    expect(result.confidence).toBe("low");
  });

  it("does not classify a generic promo-code field as a verification-code flow", () => {
    const result = classifyAuthStateSnapshot({
      pageUrl: "https://example.test/checkout",
      pageTitle: "Checkout",
      pageText: "Apply your promo code before payment",
      pageInputs: [
        {
          tag: "input",
          type: "text",
          id: "promo-code",
          name: "code",
          placeholder: "Promo code",
          visible: true,
        },
      ],
      pageButtons: [{ tag: "button", text: "Apply", visible: true }],
      frames: [],
      recentNetwork: [],
    });

    expect(result.state).not.toBe("verification_code");
    expect(result.confidence).toBe("low");
  });

  it("does not classify a generic voucher redeem code page as a verification-code flow", () => {
    const result = classifyAuthStateSnapshot({
      pageUrl: "https://example.test/redeem",
      pageTitle: "Redeem voucher",
      pageText: "Enter the code from your voucher to redeem your reward",
      pageInputs: [
        {
          tag: "input",
          type: "text",
          id: "voucher-code",
          name: "code",
          placeholder: "Voucher code",
          visible: true,
        },
      ],
      pageButtons: [{ tag: "button", text: "Redeem", visible: true }],
      frames: [],
      recentNetwork: [],
    });

    expect(result.state).toBe("unknown");
    expect(result.confidence).toBe("low");
  });

  it("does not classify ordinary segmented project-code fields as a verification-code flow", () => {
    const result = classifyAuthStateSnapshot({
      pageUrl: "https://example.test/project",
      pageTitle: "Project setup",
      pageText: "Enter the project code from your worksheet",
      pageInputs: Array.from({ length: 4 }, (_, index) => ({
        tag: "input",
        type: "text",
        id: `code-${index + 1}`,
        name: `code-${index + 1}`,
        visible: true,
      })),
      pageButtons: [],
      frames: [],
      recentNetwork: [],
    });

    expect(result.state).not.toBe("verification_code");
    expect(result.confidence).toBe("low");
  });

  it("still classifies strong one-time-code fields as verification code", () => {
    const result = classifyAuthStateSnapshot({
      pageUrl: "https://example.test/login",
      pageTitle: "Sign in",
      pageText: "Enter the verification code we sent you",
      pageInputs: Array.from({ length: 6 }, (_, index) => ({
        tag: "input",
        type: "text",
        id: `otp-${index}`,
        autocomplete: "one-time-code",
        visible: true,
      })),
      pageButtons: [],
      frames: [],
      recentNetwork: [],
    });

    expect(result.state).toBe("verification_code");
    expect(result.confidence).toBe("high");
  });

  it("classifies security-code login copy as a verification-code flow", () => {
    const result = classifyAuthStateSnapshot({
      pageUrl: "https://example.test/login",
      pageTitle: "Two-factor authentication",
      pageText: "Enter the security code from your authenticator app",
      pageInputs: [
        {
          tag: "input",
          type: "text",
          id: "security-code",
          name: "securityCode",
          visible: true,
        },
      ],
      pageButtons: [],
      frames: [],
      recentNetwork: [],
    });

    expect(result.state).toBe("verification_code");
    expect(result.confidence).toBe("high");
  });
});
