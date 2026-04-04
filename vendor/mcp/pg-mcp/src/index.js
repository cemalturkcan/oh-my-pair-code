#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { DbManager } from "./db.js";
import { buildLimitedQuery, resolveRowLimit, validateAndNormalizeSelect } from "./sqlGuard.js";
import { buildToolDefinitions, fail, ok } from "./tools.js";

const config = loadConfig();
const db = new DbManager(config);
const connectionNames = db.getConnectionNames();

function normalizeDatabaseName(value) {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new Error("'database' field must be a string.");
  }

  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[a-zA-Z0-9_\-]+$/.test(trimmed)) {
    throw new Error("'database' field contains invalid characters.");
  }

  return trimmed;
}

const server = new Server(
  { name: "pg-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: buildToolDefinitions(connectionNames),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_connections": {
        const list = connectionNames.map((connectionName) => {
          const c = db.getConnectionConfig(connectionName);
          return {
            name: connectionName,
            description: c.description,
            host: c.host,
            port: c.port,
            database: c.database,
            statement_timeout_ms: c.statement_timeout_ms,
            default_row_limit: c.default_row_limit,
            max_row_limit: c.max_row_limit,
          };
        });
        return ok(list);
      }

      case "list_databases": {
        const connection = args?.connection;
        if (!connection) return fail("'connection' field is required.");

        const result = await db.runReadOnly(
          connection,
          `
            SELECT datname AS database_name
            FROM pg_database
            WHERE datallowconn = true
              AND NOT datistemplate
            ORDER BY datname
          `
        );

        return ok(result.rows);
      }

      case "list_schemas": {
        const connection = args?.connection;
        const database = normalizeDatabaseName(args?.database);
        if (!connection) return fail("'connection' field is required.");

        const result = await db.runReadOnly(
          connection,
          `
            SELECT schema_name
            FROM information_schema.schemata
            WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
            ORDER BY schema_name
          `,
          [],
          { database }
        );

        return ok(result.rows);
      }

      case "list_tables": {
        const connection = args?.connection;
        const database = normalizeDatabaseName(args?.database);
        const schema = args?.schema ?? null;
        if (!connection) return fail("'connection' field is required.");

        const result = await db.runReadOnly(
          connection,
          `
            SELECT table_schema, table_name, table_type
            FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
              AND ($1::text IS NULL OR table_schema = $1)
            ORDER BY table_schema, table_name
          `,
          [schema],
          { database }
        );

        return ok(result.rows);
      }

      case "describe_table": {
        const connection = args?.connection;
        const database = normalizeDatabaseName(args?.database);
        const table = args?.table;
        const schema = args?.schema ?? null;
        if (!connection) return fail("'connection' field is required.");
        if (!table) return fail("'table' field is required.");

        const result = await db.runReadOnly(
          connection,
          `
            SELECT
              table_schema,
              table_name,
              column_name,
              ordinal_position,
              data_type,
              is_nullable,
              column_default
            FROM information_schema.columns
            WHERE table_name = $1
              AND ($2::text IS NULL OR table_schema = $2)
            ORDER BY table_schema, table_name, ordinal_position
          `,
          [table, schema],
          { database }
        );

        if (result.rows.length === 0) {
          return fail("Table not found. Try specifying the 'schema' field.");
        }

        return ok(result.rows);
      }

      case "execute_select": {
        const connection = args?.connection;
        const database = normalizeDatabaseName(args?.database);
        const query = args?.query;
        const requestedRowLimit = args?.row_limit;

        if (!connection) return fail("'connection' field is required.");
        if (!query) return fail("'query' field is required.");

        const connectionConfig = db.getConnectionConfig(connection);
        const normalizedQuery = validateAndNormalizeSelect(query);
        const appliedRowLimit = resolveRowLimit(requestedRowLimit, connectionConfig);
        const limitedQuery = buildLimitedQuery(normalizedQuery, appliedRowLimit);
        const result = await db.runReadOnly(connection, limitedQuery, [], { database });

        return ok({
          row_count: result.rowCount,
          row_limit: appliedRowLimit,
          rows: result.rows,
        });
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Error: ${message}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Server failed to start: ${message}`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await db.closeAll();
    process.exit(0);
  });
}
