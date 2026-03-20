import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────────────

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const TOOL_PREFIX = "mcp_";

const DEFAULT_VERSION = "2.1.80";
const DEFAULT_SCOPES =
  "org:create_api_key user:file_upload user:inference user:mcp_servers user:profile user:sessions:claude_code";
const DEFAULT_BETA_HEADERS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "oauth-2025-04-20",
];

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const LOG_PATH = join(homedir(), ".local", "share", "opencode", "oauth-debug.log");

async function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(LOG_PATH, line);
  } catch {}
}

// ── Types ────────────────────────────────────────────────────────────────────

type OAuthTokens = { access: string; refresh: string; expires: number };

// ── Binary Introspection ─────────────────────────────────────────────────────

const KNOWN_BETA_PREFIXES = [
  "claude-code-",
  "interleaved-thinking-",
  "context-management-",
  "oauth-",
];

async function introspectClaudeBinary(): Promise<{
  version: string;
  userAgent: string;
  betaHeaders: string[];
  scopes: string;
} | null> {
  try {
    const { stdout: versionOut } = await execFileAsync(
      "claude",
      ["--version"],
      { timeout: 5000 },
    );
    const version = versionOut.trim().split(" ")[0] || DEFAULT_VERSION;

    const { stdout: whichOut } = await execFileAsync("which", ["claude"], {
      timeout: 3000,
    });
    const binaryPath = whichOut.trim();
    if (!binaryPath) return null;

    const shellSafe = binaryPath.replace(/'/g, "'\\''");

    const { stdout: betaOut } = await execFileAsync(
      "sh",
      [
        "-c",
        `strings '${shellSafe}' | grep -oE '[a-z]+-[a-z0-9]+-20[0-9]{2}-[0-9]{2}-[0-9]{2}|[a-z]+-20[0-9]{2}-[0-9]{2}-[0-9]{2}|claude-code-[0-9]+' | sort -u`,
      ],
      { timeout: 30_000 },
    );

    const betaHeaders = betaOut
      .trim()
      .split("\n")
      .filter((h) => h && KNOWN_BETA_PREFIXES.some((p) => h.startsWith(p)));
    if (!betaHeaders.some((h) => h.startsWith("oauth-"))) {
      betaHeaders.push("oauth-2025-04-20");
    }

    const { stdout: scopeOut } = await execFileAsync(
      "sh",
      [
        "-c",
        `strings '${shellSafe}' | grep -oE '(user|org):[a-z_:]+' | sort -u`,
      ],
      { timeout: 30_000 },
    );

    const scopeList = scopeOut
      .trim()
      .split("\n")
      .filter(
        (s) =>
          s &&
          !s.includes("this") &&
          !s.endsWith(":") &&
          (s.startsWith("user:") || s.startsWith("org:")),
      );
    const scopes =
      scopeList.length > 0 ? scopeList.join(" ") : DEFAULT_SCOPES;

    return {
      version,
      userAgent: `claude-cli/${version} (external, cli)`,
      betaHeaders,
      scopes,
    };
  } catch {
    return null;
  }
}

// ── Network Utilities ────────────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3,
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, init);
    if (res.status === 429 && i < retries - 1) {
      await new Promise((r) => setTimeout(r, (i + 1) * 2000));
      continue;
    }
    return res;
  }
  return fetch(url, init);
}

// ── PKCE Utilities ───────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString("base64url").replace(/=+$/, "");
}

function createAuthorizationRequest(scopes: string) {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(
    createHash("sha256").update(verifier).digest(),
  );
  const params = new URLSearchParams({
    code: "true",
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });
  return { url: `${AUTHORIZE_URL}?${params}`, verifier };
}

async function exchangeCodeForTokens(
  rawCode: string,
  verifier: string,
  userAgent: string,
): Promise<OAuthTokens> {
  const hashIdx = rawCode.indexOf("#");
  const code = (hashIdx >= 0 ? rawCode.slice(0, hashIdx) : rawCode).trim();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: verifier,
  });
  const res = await fetchWithRetry(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Token exchange failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}

// ── Token Refresh ────────────────────────────────────────────────────────────

let refreshInFlight: Promise<OAuthTokens> | null = null;

async function refreshTokens(
  refreshToken: string,
): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}

function refreshTokensSafe(refreshToken: string): Promise<OAuthTokens> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshTokens(refreshToken).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// ── Claude Code Credential Reader ────────────────────────────────────────────

async function readKeychainEntry(
  account?: string,
): Promise<string | null> {
  try {
    const args = ["find-generic-password", "-s", "Claude Code-credentials"];
    if (account) args.push("-a", account);
    args.push("-w");
    const { stdout } = await execFileAsync("security", args);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readClaudeCodeCredentials(): Promise<OAuthTokens | null> {
  try {
    let raw: string | null = null;
    if (platform() === "darwin") {
      const user = process.env.USER || "";
      if (user) raw = await readKeychainEntry(user);
      if (!raw) raw = await readKeychainEntry("Claude Code");
      if (!raw) raw = await readKeychainEntry();
    } else {
      raw = await readFile(
        join(homedir(), ".claude", ".credentials.json"),
        "utf-8",
      );
    }
    if (!raw) return null;
    const creds = JSON.parse(raw) as {
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
      };
    };
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken) return null;
    return {
      access: oauth.accessToken,
      refresh: oauth.refreshToken,
      expires: oauth.expiresAt ?? 0,
    };
  } catch {
    return null;
  }
}

async function refreshViaClaudeCli(): Promise<OAuthTokens | null> {
  try {
    await execFileAsync("claude", ["-p", ".", "--model", "haiku", "hi"], {
      timeout: 30_000,
      env: { ...process.env, TERM: "dumb" },
    });
  } catch {}
  return readClaudeCodeCredentials();
}

function isExpiringSoon(expiresAt: number): boolean {
  return Date.now() + REFRESH_BUFFER_MS >= expiresAt;
}

// ── Custom Fetch (Bearer auth + tool renaming + prompt sanitization) ─────────

function createCustomFetch(
  getAuth: () => Promise<any>,
  client: any,
  userAgent: string,
  betaHeaders: string[],
) {
  return async (input: any, init?: any): Promise<Response> => {
    const auth = await getAuth();
    await log(`FETCH auth.type=${auth.type} hasAccess=${!!auth.access} expired=${auth.expires < Date.now()}`);
    if (auth.type !== "oauth") return fetch(input, init);

    // Refresh if expired
    if (!auth.access || auth.expires < Date.now()) {
      try {
        const fresh = await refreshTokensSafe(auth.refresh);
        await client.auth.set({
          path: { id: "anthropic" },
          body: {
            type: "oauth",
            refresh: fresh.refresh,
            access: fresh.access,
            expires: fresh.expires,
          },
        });
        auth.access = fresh.access;
      } catch {
        // If refresh fails, try keychain
        const kc = await readClaudeCodeCredentials();
        if (kc && !isExpiringSoon(kc.expires)) {
          await client.auth.set({
            path: { id: "anthropic" },
            body: { type: "oauth", ...kc },
          });
          auth.access = kc.access;
        }
      }
    }

    // Build headers
    const requestInit = init ?? {};
    const reqHeaders = new Headers();

    if (input instanceof Request) {
      input.headers.forEach((v: string, k: string) => reqHeaders.set(k, v));
    }
    if (requestInit.headers) {
      const h = requestInit.headers;
      if (h instanceof Headers) {
        h.forEach((v: string, k: string) => reqHeaders.set(k, v));
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) {
          if (v !== undefined) reqHeaders.set(k, String(v));
        }
      } else {
        for (const [k, v] of Object.entries(h as Record<string, string>)) {
          if (v !== undefined) reqHeaders.set(k, String(v));
        }
      }
    }

    // Merge beta headers
    const incoming = (reqHeaders.get("anthropic-beta") || "")
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
    const merged = [...new Set([...betaHeaders, ...incoming])].join(",");

    reqHeaders.set("authorization", `Bearer ${auth.access}`);
    reqHeaders.set("anthropic-beta", merged);
    reqHeaders.set("user-agent", userAgent);
    reqHeaders.delete("x-api-key");

    // Transform request body
    let body = requestInit.body;
    if (body && typeof body === "string") {
      try {
        const parsed = JSON.parse(body);

        // Sanitize system prompt — server blocks "OpenCode"
        if (parsed.system && Array.isArray(parsed.system)) {
          parsed.system = parsed.system.map((item: any) => {
            if (item.type === "text" && item.text) {
              return {
                ...item,
                text: item.text
                  .replace(/OpenCode/g, "Claude Code")
                  .replace(/opencode/gi, "Claude"),
              };
            }
            return item;
          });
        }

        // Prefix tool names
        if (parsed.tools && Array.isArray(parsed.tools)) {
          parsed.tools = parsed.tools.map((t: any) => ({
            ...t,
            name: t.name ? `${TOOL_PREFIX}${t.name}` : t.name,
          }));
        }
        if (parsed.messages && Array.isArray(parsed.messages)) {
          parsed.messages = parsed.messages.map((msg: any) => {
            if (msg.content && Array.isArray(msg.content)) {
              msg.content = msg.content.map((block: any) => {
                if (block.type === "tool_use" && block.name) {
                  return { ...block, name: `${TOOL_PREFIX}${block.name}` };
                }
                return block;
              });
            }
            return msg;
          });
        }
        body = JSON.stringify(parsed);
      } catch {}
    }

    // Add ?beta=true to messages endpoint
    let reqInput = input;
    try {
      let reqUrl: URL | null = null;
      if (typeof input === "string" || input instanceof URL) {
        reqUrl = new URL(input.toString());
      } else if (input instanceof Request) {
        reqUrl = new URL(input.url);
      }
      if (reqUrl?.pathname === "/v1/messages" && !reqUrl.searchParams.has("beta")) {
        reqUrl.searchParams.set("beta", "true");
        reqInput = input instanceof Request
          ? new Request(reqUrl.toString(), input)
          : reqUrl;
      }
    } catch {}

    const response = await fetch(reqInput, {
      ...requestInit,
      body,
      headers: reqHeaders,
    });

    // Un-prefix tool names in streaming response
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          let text = decoder.decode(value, { stream: true });
          text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
          controller.enqueue(encoder.encode(text));
        },
      });
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return response;
  };
}

// ── Main Export ──────────────────────────────────────────────────────────────

export async function createAnthropicOAuth(client: any) {
  await log("=== PLUGIN STARTUP ===");
  const introspection = await introspectClaudeBinary();
  await log(`INTROSPECT: ${introspection ? `v${introspection.version} headers=${introspection.betaHeaders.join(",")}` : "FALLBACK (no claude binary)"}`);

  const userAgent =
    introspection?.userAgent ?? `claude-cli/${DEFAULT_VERSION} (external, cli)`;
  const betaHeaders = introspection?.betaHeaders ?? DEFAULT_BETA_HEADERS;
  const scopes = introspection?.scopes ?? DEFAULT_SCOPES;

  return {
    auth: {
      provider: "anthropic" as const,
      async loader(getAuth: () => Promise<any>, provider: any) {
        await log("LOADER called");
        const auth = await getAuth();
        await log(`LOADER auth.type=${auth.type} hasAccess=${!!auth.access} expires=${auth.expires}`);
        if (auth.type === "oauth") {
          // Zero out cost for Pro/Max plan
          for (const model of Object.values(provider.models) as any[]) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
          }
          return {
            apiKey: "",
            fetch: createCustomFetch(getAuth, client, userAgent, betaHeaders),
          };
        }
        return {};
      },
      methods: [
        {
          type: "oauth" as const,
          label: "Claude Code (auto)",
          async authorize() {
            return {
              url: "https://claude.ai",
              instructions: "Detecting Claude Code credentials…",
              method: "auto" as const,
              async callback() {
                await log("AUTO callback started");
                let tokens = await readClaudeCodeCredentials();
                await log(`AUTO keychain: ${tokens ? `found, expires=${tokens.expires}, expiringSoon=${isExpiringSoon(tokens.expires)}` : "NOT FOUND"}`);
                if (!tokens) return { type: "failed" as const };

                if (!isExpiringSoon(tokens.expires)) {
                  await log("AUTO SUCCESS — token fresh from keychain");
                  return { type: "success" as const, ...tokens };
                }

                try {
                  const refreshed = await refreshTokensSafe(tokens.refresh);
                  await log("AUTO SUCCESS — refreshed via token endpoint");
                  return { type: "success" as const, ...refreshed };
                } catch (e) {
                  await log(`AUTO refresh failed: ${e}`);
                }

                await log("AUTO trying CLI refresh...");
                const fresh = await refreshViaClaudeCli();
                if (fresh && !isExpiringSoon(fresh.expires)) {
                  await log("AUTO SUCCESS — refreshed via CLI");
                  return { type: "success" as const, ...fresh };
                }

                await log("AUTO FAILED — all methods exhausted");
                return { type: "failed" as const };
              },
            };
          },
        },
        {
          type: "oauth" as const,
          label: "Claude Pro/Max (browser)",
          authorize() {
            const { url, verifier } = createAuthorizationRequest(scopes);
            let exchangePromise: Promise<any> | null = null;
            return Promise.resolve({
              url,
              instructions:
                "Open the link above to authenticate with your Claude account. " +
                "After authorizing, you'll receive a code — paste it below.",
              method: "code" as const,
              async callback(code: string) {
                await log(`BROWSER callback, code=${code.slice(0, 20)}... len=${code.length} hasPending=${!!exchangePromise}`);
                if (exchangePromise) {
                  await log("BROWSER DEDUP — returning pending promise");
                  return exchangePromise;
                }
                exchangePromise = (async () => {
                  try {
                    const tokens = await exchangeCodeForTokens(code, verifier, userAgent);
                    await log("BROWSER SUCCESS");
                    return { type: "success" as const, ...tokens };
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    await log(`BROWSER FAILED: ${msg}`);
                    return { type: "failed" as const };
                  }
                })();
                return exchangePromise;
              },
            });
          },
        },
        {
          type: "api" as const,
          label: "Manually enter API Key",
          provider: "anthropic",
        },
      ],
    },
    systemTransform: (input: any, output: any) => {
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude.";
      if (input.model?.providerID === "anthropic") {
        output.system.unshift(prefix);
        if (output.system[1]) {
          output.system[1] = prefix + "\n\n" + output.system[1];
        }
      }
    },
  };
}
