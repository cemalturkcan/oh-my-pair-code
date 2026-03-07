# sudo-mcp

Two-step approval MCP server for running local `sudo` commands safely.

## Safety Model

- Every command must pass policy checks (`deny_patterns`, optional `allow_patterns`)
- Commands are requested first, then executed with a separate approval step
- Each request has an approval code and TTL
- Default policy enforces non-interactive sudo (`sudo -n`)
- Default mode is allow-all with a deny list for destructive operations

## Tools

- `get_sudo_policy`
- `request_sudo_execution`
- `run_approved_sudo`
- `list_pending_sudo_requests`
- `cancel_pending_sudo_request`

## Install

```bash
npm install
```

## Configure

```bash
cp config.example.json config.json
```

Tune:

- `allow_patterns` (optional when `require_allowlist` is `false`)
- `require_allowlist`
- `deny_patterns`
- `approval_ttl_seconds`
- timeout/output limits

## Approval Flow

1. Call `request_sudo_execution`
2. Show `expected_user_phrase` to the human
3. Run `run_approved_sudo` only after the user sends that phrase

Example expected phrase:

```text
APPROVE_SUDO <request_id> <approval_code>
```
