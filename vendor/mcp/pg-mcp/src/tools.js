export function buildToolDefinitions(connectionNames) {
  return [
    {
      name: "list_connections",
      description: "Tanimli PostgreSQL baglantilarini listeler.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_databases",
      description: "Secilen baglantidaki erisilebilir veritabanlarini listeler.",
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
      description: "Secilen baglantidaki semalari listeler.",
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
      description: "Secilen baglantida tablolari listeler. Isterseniz schema verebilirsiniz.",
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
      description: "Bir tablonun kolon bilgilerini dondurur.",
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
      description: "Salt-okunur SELECT sorgusu calistirir. Satir limiti uygulanir.",
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
