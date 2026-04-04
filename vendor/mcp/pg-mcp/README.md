# PostgreSQL MCP Server (stdio)

A simple MCP server for PostgreSQL. Communicates over `stdio` and runs all queries in read-only mode.

## Features

- Multiple connection definitions via `config.json`
- MCP tools:
  - `list_connections`
  - `list_databases`
  - `list_schemas`
  - `list_tables`
  - `describe_table`
  - `execute_select`
- Optional `database` parameter to browse different databases through a single connection
- Security rules:
  - SELECT queries only
  - Multi-statement rejection
  - Write/DDL keyword rejection
  - Read-only transactions
  - `statement_timeout` enforcement
  - Per-connection row limits (`default_row_limit` / `max_row_limit`)

## Setup

```bash
npm install
```

## Configuration

1. Copy the example file:

```bash
cp config.example.json config.json
```

2. Update the connection details in `config.json`.

Notes:
- The actual `config.json` is excluded via `.gitignore`.
- Set `PG_MCP_CONFIG_PATH` to use a custom path.

## Running

```bash
npm start
```

## Example MCP client config

Add this server to your MCP client configuration:

```json
{
  "mcpServers": {
    "pg": {
      "command": "node",
      "args": ["/absolute/path/to/pg-mcp/src/index.js"],
      "env": {
        "PG_MCP_CONFIG_PATH": "/absolute/path/to/pg-mcp/config.json"
      }
    }
  }
}
```

## Connection config example

```json
{
  "connections": {
    "local": {
      "host": "127.0.0.1",
      "port": 5432,
      "user": "readonly_user",
      "password": "readonly_password",
      "database": "postgres",
      "description": "Root connection (for listing databases)",
      "statement_timeout_ms": 10000,
      "default_row_limit": 100,
      "max_row_limit": 1000
    }
  }
}
```

## Database browsing flow

1. Use `list_databases` to get accessible databases.
2. Pass the `database` parameter to `list_schemas` / `list_tables` / `describe_table` / `execute_select`.
