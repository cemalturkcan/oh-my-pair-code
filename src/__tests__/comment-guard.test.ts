import { describe, it, expect } from "bun:test";

// Mirrors SUSPICIOUS_COMMENT_PATTERNS from src/hooks/comment-guard.ts.
// Recreated here because the constant is not exported from that module.
const SUSPICIOUS_COMMENT_PATTERNS: RegExp[] = [
  /^\s*(\/\/|#|\/\*+|\*)\s*(this|these)\s+(function|method|code|logic|component|block)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*(here|now)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*(simply|basically|just|obviously)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*we\s+(now|use|need|do|first|then)\b/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*note\s+(that|:)/i,
  /^\s*(\/\/|#|\/\*+|\*)\s*ensure\s+that\b/i,
];

function matches(line: string): boolean {
  return SUSPICIOUS_COMMENT_PATTERNS.some((re) => re.test(line));
}

// ── Pattern 0: this/these + noun ──────────────────────────────────────────────

describe("pattern: this/these <noun>", () => {
  it("matches '// this function'", () => {
    expect(matches("// this function handles routing")).toBe(true);
  });

  it("matches '// these method signatures'", () => {
    // plural 'methods' does not match — pattern requires singular noun with word boundary
    expect(matches("// these method signatures differ")).toBe(true);
  });

  it("matches '# this code'", () => {
    expect(matches("# this code runs at startup")).toBe(true);
  });

  it("matches '/* this logic'", () => {
    expect(matches("/* this logic normalises the input")).toBe(true);
  });

  it("matches '* this component' (JSDoc continuation)", () => {
    expect(matches(" * this component renders the list")).toBe(true);
  });

  it("matches with leading indentation", () => {
    expect(matches("  // this block should not throw")).toBe(true);
  });

  it("does not match when noun is absent", () => {
    expect(matches("// this is fine")).toBe(false);
  });

  it("does not match when 'this' is not the first word after prefix", () => {
    expect(matches("// check this function")).toBe(false);
  });
});

// ── Pattern 1: here | now ─────────────────────────────────────────────────────

describe("pattern: here | now immediately after prefix", () => {
  it("matches '// here we go'", () => {
    expect(matches("// here we go")).toBe(true);
  });

  it("matches '// now process'", () => {
    expect(matches("// now process the queue")).toBe(true);
  });

  it("matches '# now fetch'", () => {
    expect(matches("# now fetch the data")).toBe(true);
  });

  it("does not match when 'here' appears mid-sentence after prefix", () => {
    // 'right' comes before 'here', so the pattern cannot match from prefix
    expect(matches("// right here we should stop")).toBe(false);
  });

  it("does not match plain code with 'here' in a string", () => {
    expect(matches('const msg = "we are here";')).toBe(false);
  });
});

// ── Pattern 2: simply | basically | just | obviously ─────────────────────────

describe("pattern: hedging adverbs", () => {
  it("matches '// simply put'", () => {
    expect(matches("// simply put, we delegate")).toBe(true);
  });

  it("matches '// just return'", () => {
    expect(matches("// just return the value")).toBe(true);
  });

  it("matches '// basically the same'", () => {
    expect(matches("// basically the same as above")).toBe(true);
  });

  it("matches '// obviously we should'", () => {
    expect(matches("// obviously we should cache this")).toBe(true);
  });

  it("does not match when adverb is not the first word after prefix", () => {
    expect(matches("// it is just a helper")).toBe(false);
  });

  it("does not match non-comment code containing the word", () => {
    expect(matches('return "just kidding";')).toBe(false);
  });
});

// ── Pattern 3: we <verb> ──────────────────────────────────────────────────────

describe("pattern: we <continuation-verb>", () => {
  it("matches '// we now return'", () => {
    expect(matches("// we now return the result")).toBe(true);
  });

  it("matches '// we use the factory'", () => {
    expect(matches("// we use the factory pattern")).toBe(true);
  });

  it("matches '// we need to validate'", () => {
    expect(matches("// we need to validate input")).toBe(true);
  });

  it("matches '// we do this in two passes'", () => {
    expect(matches("// we do this in two passes")).toBe(true);
  });

  it("matches '// we first check'", () => {
    expect(matches("// we first check the flag")).toBe(true);
  });

  it("matches '// we then process'", () => {
    expect(matches("// we then process the response")).toBe(true);
  });

  it("does not match when verb is not one of the target set", () => {
    expect(matches("// we said this was ready")).toBe(false);
  });

  it("does not match when subject is not 'we'", () => {
    expect(matches("// they now use this")).toBe(false);
  });
});

// ── Pattern 4: note that | note : ────────────────────────────────────────────

describe("pattern: note that / note :", () => {
  it("matches '// note that this is important'", () => {
    expect(matches("// note that this is important")).toBe(true);
  });

  it("matches '// Note that' (case-insensitive)", () => {
    expect(matches("// Note that the order matters")).toBe(true);
  });

  it("matches '// note : with space before colon'", () => {
    expect(matches("// note : edge case")).toBe(true);
  });

  it("does not match '// note:' without whitespace before colon", () => {
    // Regex requires \\s+ before ':' — 'note:' has no whitespace
    expect(matches("// note: this is a note")).toBe(false);
  });

  it("does not match when 'note' is not the first word after prefix", () => {
    expect(matches("// important note that ...")).toBe(false);
  });
});

// ── Pattern 5: ensure that ───────────────────────────────────────────────────

describe("pattern: ensure that", () => {
  it("matches '// ensure that the value is set'", () => {
    expect(matches("// ensure that the value is set")).toBe(true);
  });

  it("matches '# ensure that' with hash prefix", () => {
    expect(matches("# ensure that we have a connection")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(matches("// Ensure That the flag is cleared")).toBe(true);
  });

  it("does not match '// ensure the' without 'that'", () => {
    expect(matches("// ensure the connection is open")).toBe(false);
  });

  it("does not match '// ensure' alone", () => {
    expect(matches("// ensure")).toBe(false);
  });
});

// ── Non-comment code and clean comments ──────────────────────────────────────

describe("non-comment and clean comment lines", () => {
  it("does not match empty lines", () => {
    expect(matches("")).toBe(false);
    expect(matches("   ")).toBe(false);
  });

  it("does not match plain assignment code", () => {
    expect(matches("const result = computeTotal(items);")).toBe(false);
  });

  it("does not match inline comment after code", () => {
    // Comment prefix is not at start — non-comment token precedes it
    expect(matches("return value; // just a fallback")).toBe(false);
  });

  it("does not match a legitimate single-word comment", () => {
    expect(matches("// TODO")).toBe(false);
    expect(matches("// deprecated")).toBe(false);
  });

  it("does not match a meaningful technical comment", () => {
    expect(matches("// compute the total including tax")).toBe(false);
    expect(matches("// trim trailing whitespace before comparison")).toBe(
      false,
    );
  });
});
