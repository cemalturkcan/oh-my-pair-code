import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const REFRESH_TOKEN_URL =
  process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE?.trim() ||
  "https://auth.openai.com/oauth/token";
const REFRESH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

function defaultCodexHome() {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

export function getAuthFilePath() {
  return join(defaultCodexHome(), "auth.json");
}

function loadAuthStore(filePath = getAuthFilePath()) {
  if (!existsSync(filePath)) {
    throw new Error(
      `Codex auth file not found at ${filePath}. Log in with Codex first or set CODEX_HOME.`,
    );
  }

  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) {
    throw new Error(`Codex auth file is empty: ${filePath}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse Codex auth file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Codex auth file at ${filePath} is not a JSON object.`);
  }

  return { filePath, data };
}

function saveAuthStore(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function extractChatgptAccountId(token) {
  const normalized = normalizeNonEmptyString(token);
  if (!normalized) return null;

  const parts = normalized.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return normalizeNonEmptyString(
      payload?.["https://api.openai.com/auth"]?.chatgpt_account_id,
    );
  } catch {
    return null;
  }
}

function extractChatgptJwtMetadata(token) {
  const normalized = normalizeNonEmptyString(token);
  if (!normalized) {
    return {
      accountId: null,
      isFedrampAccount: false,
    };
  }

  const parts = normalized.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    return {
      accountId: null,
      isFedrampAccount: false,
    };
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const auth = payload?.["https://api.openai.com/auth"];
    return {
      accountId: normalizeNonEmptyString(auth?.chatgpt_account_id),
      isFedrampAccount: auth?.chatgpt_account_is_fedramp === true,
    };
  } catch {
    return {
      accountId: null,
      isFedrampAccount: false,
    };
  }
}

export function resolveAuthStateFromStore(data, filePath) {
  const apiKey = normalizeNonEmptyString(
    data.OPENAI_API_KEY ?? data.openai_api_key,
  );
  if (apiKey) {
    return {
      mode: "api_key",
      token: apiKey,
      refreshToken: null,
      accountId: null,
      isFedrampAccount: false,
      lastRefresh: normalizeNonEmptyString(data.last_refresh),
      authFilePath: filePath,
      raw: data,
    };
  }

  const tokens = data.tokens && typeof data.tokens === "object" ? data.tokens : null;
  const accessToken = normalizeNonEmptyString(tokens?.access_token);
  if (accessToken) {
    const idTokenMetadata = extractChatgptJwtMetadata(tokens?.id_token);
    const accessTokenMetadata = extractChatgptJwtMetadata(accessToken);
    return {
      mode: "chatgpt",
      token: accessToken,
      refreshToken: normalizeNonEmptyString(tokens?.refresh_token),
      accountId:
        normalizeNonEmptyString(tokens?.account_id) ||
        normalizeNonEmptyString(data.chatgpt_account_id) ||
        idTokenMetadata.accountId ||
        accessTokenMetadata.accountId ||
        extractChatgptAccountId(accessToken),
      isFedrampAccount:
        idTokenMetadata.isFedrampAccount || accessTokenMetadata.isFedrampAccount,
      lastRefresh: normalizeNonEmptyString(data.last_refresh),
      authFilePath: filePath,
      raw: data,
    };
  }

  throw new Error(
    `No usable Codex auth token found in ${filePath}. Expected OPENAI_API_KEY or tokens.access_token.`,
  );
}

export function getCodexAuthState() {
  const { filePath, data } = loadAuthStore();
  return resolveAuthStateFromStore(data, filePath);
}

function buildRefreshRequestBody(refreshToken) {
  return {
    client_id: REFRESH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };
}

function assertCompatibleChatgptAccount(expectedState, actualState) {
  if (expectedState?.mode !== "chatgpt" || !expectedState.accountId) {
    throw new Error(
      "Cannot safely reload Codex auth because the active ChatGPT workspace id is unavailable.",
    );
  }

  if (
    actualState?.mode !== "chatgpt" ||
    !actualState.accountId ||
    actualState.accountId !== expectedState.accountId
  ) {
    throw new Error(
      "Codex auth changed on disk and no longer matches the active ChatGPT workspace. Log in again before retrying image generation.",
    );
  }
}

export function reloadCodexAuthState(expectedState) {
  const { filePath, data } = loadAuthStore(expectedState?.authFilePath);
  const actualState = resolveAuthStateFromStore(data, filePath);
  assertCompatibleChatgptAccount(expectedState, actualState);
  return actualState;
}

async function parseRefreshError(response) {
  const text = await response.text();
  if (!text.trim()) {
    return `Token refresh failed with status ${response.status}.`;
  }

  try {
    const data = JSON.parse(text);
    const message =
      normalizeNonEmptyString(data?.error?.message) ||
      normalizeNonEmptyString(data?.error_description) ||
      normalizeNonEmptyString(data?.detail) ||
      normalizeNonEmptyString(data?.error?.code) ||
      normalizeNonEmptyString(data?.error);
    if (message) {
      return `Token refresh failed with status ${response.status}: ${message}`;
    }
  } catch {}

  return `Token refresh failed with status ${response.status}: ${text}`;
}

export async function refreshCodexAuth(state) {
  if (state.mode !== "chatgpt") {
    return state;
  }

  const currentState = reloadCodexAuthState(state);

  if (currentState.mode !== "chatgpt" || !currentState.refreshToken) {
    throw new Error(
      `Codex access token expired and no refresh token is available in ${state.authFilePath}.`,
    );
  }

  const response = await fetch(REFRESH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildRefreshRequestBody(currentState.refreshToken)),
  });

  if (!response.ok) {
    throw new Error(await parseRefreshError(response));
  }

  const refreshed = await response.json();
  const nextAccessToken = normalizeNonEmptyString(refreshed?.access_token);
  if (!nextAccessToken) {
    throw new Error("Token refresh succeeded but returned no access_token.");
  }

  const { filePath, data } = loadAuthStore(currentState.authFilePath);
  const currentTokens =
    data.tokens && typeof data.tokens === "object" ? data.tokens : {};

  const nextStore = {
    ...data,
    tokens: {
      ...currentTokens,
      access_token: nextAccessToken,
      refresh_token:
        normalizeNonEmptyString(refreshed?.refresh_token) || currentState.refreshToken,
      id_token: normalizeNonEmptyString(refreshed?.id_token) || currentTokens.id_token,
    },
    last_refresh: new Date().toISOString(),
  };

  saveAuthStore(filePath, nextStore);
  return resolveAuthStateFromStore(nextStore, filePath);
}
