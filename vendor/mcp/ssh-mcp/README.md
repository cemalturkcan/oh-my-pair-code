# SSH MCP Server (v2)

Modernized SSH MCP server with stricter validation, timeout controls, output limits, and optional command allowlists.

## Features

- Config validation with `zod`
- Per-host timeout and output limits
- Optional per-host command allowlist
- Password auth (`password` or `passwordEnv`) and key auth (`keyPath`)
- Structured JSON responses for `list_hosts`, `test_connection`, `run_command`

## Install

```bash
npm install
```

## Configuration

1. Copy the example file:

```bash
cp config.example.json config.json
```

2. Fill your host definitions.

By default, the server looks for config in this order:

1. `SSH_MCP_CONFIG_PATH`
2. `./config.json` (next to this package)
3. `config.json` in current working directory

## Tools

- `list_hosts`
- `test_connection`
- `run_command`

## Security Notes

- Prefer `keyPath` over plain password.
- Prefer `passwordEnv` over hardcoded passwords.
- Use `command_allowlist` for production hosts.
- Keep `StrictHostKeyChecking` at `accept-new` or `yes` unless you have a clear reason not to.
