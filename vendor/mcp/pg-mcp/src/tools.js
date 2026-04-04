export function buildToolDefinitions(connectionNames) {
  return [
    {
      name: "list_connections",
      description: "Lists configured PostgreSQL connections.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_databases",
      description: "Lists accessible databases for the selected connection.",
      inputSchema: {
        type: "object",
        properties: {
          connection: { type: "string", enum: connectionNames },
        },
        required: ["connection"],
      },
    },
    {
      name: "list_schemas",
      description: "Lists schemas for the selected connection.",
      inputSchema: {
        type: "object",
        properties: {
          connection: { type: "string", enum: connectionNames },
          database: { type: "string" },
        },
        required: ["connection"],
      },
    },
    {
      name: "list_tables",
      description: "Lists tables for the selected connection. Optionally filter by schema.",
      inputSchema: {
        type: "object",
        properties: {
          connection: { type: "string", enum: connectionNames },
          database: { type: "string" },
          schema: { type: "string" },
        },
        required: ["connection"],
      },
    },
    {
      name: "describe_table",
      description: "Returns column information for a table.",
      inputSchema: {
        type: "object",
        properties: {
          connection: { type: "string", enum: connectionNames },
          database: { type: "string" },
          table: { type: "string" },
          schema: { type: "string" },
        },
        required: ["connection", "table"],
      },
    },
    {
      name: "execute_select",
      description: "Executes a read-only SELECT query. Row limit is enforced.",
      inputSchema: {
        type: "object",
        properties: {
          connection: { type: "string", enum: connectionNames },
          database: { type: "string" },
          query: { type: "string" },
          row_limit: { type: "number" },
        },
        required: ["connection", "query"],
      },
    },
  ];
}

export function ok(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function fail(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
