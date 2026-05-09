# Global web-agent MCP daemon

`opencode-pair` starts `web-agent-mcp` as a local-only daemon by default when the managed vendor package is installed. Normal OpenCode MCP routing connects to `http://127.0.0.1:29741/mcp` instead of spawning a browser-bound stdio child for each OpenCode process.

The daemon stores its durable state under `${XDG_DATA_HOME:-~/.local/share}/opencode-pair/web-agent` unless `WEB_AGENT_DAEMON_DATA_DIR` is set. The browser profile lives at `profile/` inside that directory and is used as `WEB_AGENT_CHROME_USER_DATA_DIR`, so cookies, history, localStorage, and profile data survive OpenCode terminal exits and daemon restarts. A `profile.lock` plus `daemon.json` pid registry prevents duplicate daemon ownership of the same profile; stale locks are removed only when the recorded pid is no longer alive.

Normal startup is idempotent: if the registry pid is alive, `opencode-pair` only connects and does not restart or kill the daemon. If no daemon is registered, it starts one detached from the OpenCode stdio lifetime. The service binds only to `127.0.0.1`; there is no token/auth layer and no network-exposed listener.

Agent usage expectations:

- Start browser work with `session.status`; read all visible tabs before acting. The daemon is global and local-only, so any local agent can see and control every live tab. Target tools by `page_id` or `tab_id` instead of assuming the current terminal owns an isolated browser.
- Use `page.create` when a new tab is required. Include `purpose` and `owner` metadata for traceability, but treat them as informational only; they are not access restrictions and do not hide or lock tabs.
- The persistent profile keeps cookies, history, localStorage, and profile data across OpenCode terminal exits and daemon/browser restarts. Live DOM, JS heap memory, pending timers, and in-flight page state may be gone after restart, so recover with `session.status` and page observations.
- For responsive and page mutation work, use `page.resize`, `observe_screenshot` with viewport/full/element mode, `runtime.inject_css`/`runtime.remove_css`, `runtime.evaluate_js`, `runtime.run_page_script`, and observe console/network/page-state tools before escalating to broader actions.
- On `BROWSER_DISCONNECTED` or stale ids, stop retrying the stale session/page/tab id. Call `session.status`, retarget an existing visible tab by `page_id`/`tab_id`, create a fresh tab with `page.create` if needed, or restart the daemon only when status/health indicates the daemon itself is bad.

Fallback and maintenance:

- Set `OPENCODE_PAIR_WEB_AGENT_DAEMON=false` to use the existing stdio MCP path.
- Run `bun run daemon:status` in `web-agent-mcp` to inspect registry and endpoint.
- Run `bun run daemon:stop` for an explicit safe stop. Install/update stops any existing daemon with `bun run daemon:stop`, then starts `bun run daemon` detached so the installer remains non-interactive; it does not delete the persistent profile or registry directory.
- Override the loopback port with `WEB_AGENT_DAEMON_PORT` if the default local port is already occupied.
