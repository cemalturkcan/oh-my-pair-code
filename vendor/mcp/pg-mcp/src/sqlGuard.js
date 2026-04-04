const BLOCKED_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "UPSERT",
  "MERGE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "COPY",
  "CALL",
  "DO",
  "VACUUM",
  "ANALYZE",
  "REINDEX",
  "COMMENT",
  "CLUSTER",
  "LOCK",
  "SET",
  "RESET",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "INTO",
];

const blockedKeywordRegex = new RegExp(`\\b(${BLOCKED_KEYWORDS.join("|")})\\b`, "i");

export function validateAndNormalizeSelect(rawQuery) {
  if (typeof rawQuery !== "string") {
    throw new Error("Query must be a string.");
  }

  let query = rawQuery.trim();
  if (!query) {
    throw new Error("Query cannot be empty.");
  }

  while (query.endsWith(";")) {
    query = query.slice(0, -1).trim();
  }

  if (query.includes(";")) {
    throw new Error("Only a single SQL statement can be executed at a time.");
  }

  if (!/^(SELECT|WITH)\b/i.test(query)) {
    throw new Error("Only SELECT queries are allowed.");
  }

  if (blockedKeywordRegex.test(query)) {
    throw new Error("Query contains write/DDL statements. Only read-only SELECT is allowed.");
  }

  return query;
}

export function resolveRowLimit(requestedRowLimit, connectionConfig) {
  const defaultLimit = connectionConfig.default_row_limit;
  const maxLimit = connectionConfig.max_row_limit;
  const chosen = requestedRowLimit == null ? defaultLimit : Number(requestedRowLimit);

  if (!Number.isFinite(chosen) || chosen <= 0) {
    throw new Error("row_limit must be a positive number.");
  }

  return Math.min(Math.floor(chosen), maxLimit);
}

export function buildLimitedQuery(query, rowLimit) {
  return `SELECT * FROM (${query}) AS mcp_readonly_query LIMIT ${rowLimit}`;
}
