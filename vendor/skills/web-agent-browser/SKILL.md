---
name: web-agent-browser
description: Browser automation with web-agent-mcp. Covers global daemon session recovery, tab targeting, auth flows, diagnostics, and reliable interaction patterns for complex web applications.
---

## Purpose
Use this skill for browser automation tasks using `web-agent-mcp`. The browser is a global, local-only daemon, not a fresh per-terminal ephemeral browser. Any local agent can see and control every live tab, so recover shared state before acting and target tools explicitly by `page_id` or `tab_id`.

## Use When
- The task involves web-agent-mcp tool usage (`session.status`, `page.create`, `act_fill`, `observe_screenshot`, etc.).
- The target page uses iframe-based auth (Apple Developer, Google, etc.).
- The task involves login, form submission, multi-step auth flows, diagnostics, or responsive/browser verification.
- 2FA / verification code input is needed.

---

## Global Daemon Workflow

```
1. session.status → inspect daemon/session health and all visible tabs
2. Choose an existing tab by page_id/tab_id, or page.create when a new tab is needed
3. page_navigate with wait_until="domcontentloaded" when navigation is needed
4. observe_text/observe_dom/page_state/console/network, or observe_screenshot when visual proof is needed
5. interact with act.* tools or bounded runtime tools, always passing the target page_id/tab_id and omitting frame_selector unless a real iframe selector was observed
6. Leave shared tabs intact unless the task explicitly requires closing them
```

Do not assume the current terminal owns an isolated browser. Read all visible tabs from `session.status` before acting. `page.create` accepts `purpose` and `owner` metadata for human traceability, but metadata is informational only; it is not access control and does not hide, lock, or reserve tabs.

The daemon uses a persistent global browser profile. Cookies, history, localStorage, and profile data survive OpenCode terminal exits and daemon/browser restarts. Live DOM state, JS heap memory, pending timers, and in-flight page state may not survive a daemon or browser restart, so recover with `session.status` and fresh observations.

Prefer cheap observations before screenshots: `observe_text`, `observe_dom`, `observe_page_state`, `observe_console`, and `observe_network`. Use `observe_screenshot` with `viewport`, `full`, or `element` mode only when visual evidence is needed. Avoid `networkidle` as a default readiness check; use `domcontentloaded`, explicit selector/text waits, or network response waits instead.

Useful tools include `page.resize` for responsive checks, `runtime.inject_css`/`runtime.remove_css` for bounded style experiments, `runtime.evaluate_js` for single-expression reads, and `runtime.run_page_script` for bounded same-page diagnostics or internal test flows. Use human-like `act.*` tools for interaction-sensitive flows.

For login and form flows, stay browser-first: recover with `session.status`, inspect `observe_page_state`/`observe_dom`/`observe_text`/`observe_a11y`, then act on selectors seen in those observations before trying guessed IDs. Do not start with repo Glob/Grep/Read unless credentials, route source, fixtures, or app internals are actually needed. Do not repeat blind fill/click retries after a timeout; observe current state, errors, frames, or network first.

### Recovery
- On `BROWSER_DISCONNECTED` or stale ids, stop retrying the stale `session_id`, `page_id`, or `tab_id`.
- Call `session.status`, retarget an existing visible tab, or create a fresh tab with `page.create`.
- Restart the daemon only when status/health indicates the daemon itself is bad.

### Managed daemon commands
From `vendor/mcp/web-agent-mcp`:

```
bun run daemon:status   # print registry, endpoint, and running state
bun run daemon:restart  # stop registered daemon, then start daemon in foreground
bun run daemon:stop     # explicit safe stop
bun run daemon          # start daemon in foreground
```

There is no dedicated `daemon:logs` script in the managed package. Use `observe_console` and `observe_network` for page logs/network activity, and inspect daemon stdout from the process manager or invoking terminal when needed.

---

## Iframe Handling

### Option A — frame_selector parameter (preferred for same-origin or Playwright-accessible iframes)
```
act_fill:
  page_id: "page_..."
  selector: "input#account_name_text_field"
  frame_selector: "iframe#aid-auth-widget-iFrame"
  value: "user@example.com"
```
Works for iframes Playwright can access via `frameLocator()`.

`frame_selector` is optional and iframe-only. For normal main-page inputs and buttons, omit `frame_selector` entirely. Never pass placeholders such as `body`, `:scope`, `__none__`, `iframe#__none__`, `none`, or an empty string to satisfy a schema; those are not observed iframe selectors and cause slow failed retries. If a frame-scoped action fails, re-observe DOM/page_state/a11y to confirm the iframe selector before retrying.

### Option B — JavaScript contentDocument injection (fallback for same-session cross-origin iframes)
Use when `frame_selector` times out. Apple Developer's login iframe (`idmsa.apple.com`) may be accessible via `contentDocument` in the same browser session:

```javascript
// Fill email in Apple iframe
const iframe = document.querySelector('iframe#aid-auth-widget-iFrame');
const emailInput = iframe.contentDocument.querySelector('#account_name_text_field');
emailInput.focus();
emailInput.value = 'user@example.com';
emailInput.dispatchEvent(new Event('input', { bubbles: true }));
emailInput.dispatchEvent(new Event('change', { bubbles: true }));
```

```javascript
// Click Continue / Sign In button
const iframe = document.querySelector('iframe#aid-auth-widget-iFrame');
const btn = iframe.contentDocument.querySelector('#sign-in');
btn.click();
```

```javascript
// Wait and check state
await new Promise(r => setTimeout(r, 3000));
const iframe = document.querySelector('iframe#aid-auth-widget-iFrame');
const passwordField = iframe.contentDocument.querySelector('#password_text_field');
JSON.stringify({
  passwordVisible: passwordField ? getComputedStyle(passwordField).display !== 'none' : false,
  bodyText: iframe.contentDocument.body.innerText.substring(0, 500)
});
```

---

## Apple Developer Portal Login

**URL:** `https://developer.apple.com/account`

**Login flow:**
1. `session.status` → choose or create the target tab.
2. `page_navigate` → `https://developer.apple.com/account` with `wait_until="domcontentloaded"`.
3. Observe text/DOM or screenshot to verify login form visible.
4. Fill email via `frame_selector` or JavaScript injection (Option B above) into `#account_name_text_field`.
5. Click `#sign-in` (Continue button).
6. Wait for password field, then observe page state.
7. Fill password into `#password_text_field`.
8. Click `#sign-in` (Sign In button).
9. Observe page state and check for 2FA prompt.

**Iframe selector:** `iframe#aid-auth-widget-iFrame`  
**Email field:** `#account_name_text_field`  
**Password field:** `#password_text_field`  
**Action button:** `#sign-in` (used for both Continue and Sign In)

### 2FA Handling
After sign-in, Apple may show phone number selection for SMS code:
1. Observe page state or screenshot to see the 2FA options.
2. Ask the user which phone number to use if multiple options are shown.
3. Click the desired phone option.
4. Wait for user to provide the 6-digit code.
5. Use `act_enter_code` or `runtime.evaluate_js` to fill the code fields.
6. Submit.

---

## General Patterns

### Detecting page state after navigation
```javascript
// Check current URL and key elements
JSON.stringify({
  url: window.location.href,
  title: document.title,
  hasError: !!document.querySelector('.error, [role="alert"], .alert-error'),
  errorText: document.querySelector('.error, [role="alert"]')?.textContent?.trim()
});
```

### React/Vue input filling (when plain value= doesn't work)
```javascript
const input = document.querySelector('input#myField');
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
nativeInputValueSetter.call(input, 'new value');
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));
```

### Checking for login success (Google pattern)
```javascript
document.querySelector('a[href*="SignOutOptions"], [aria-label*="Google Account"], [data-ogsr-up]')?.getAttribute('aria-label') || 'not logged in';
```

---

## Guardrails
- Start with `session.status`; inspect all visible tabs before acting.
- Target each action by `page_id` or `tab_id`; do not rely on implicit terminal ownership.
- Observe with text/DOM/page_state first; use screenshots for visual proof or layout uncertainty.
- Omit `frame_selector` for main-page form fields. Use it only after observing a real `iframe...` selector; never invent placeholder values like `body`, `:scope`, or `__none__`.
- For login retries, observe page state, DOM, console/network, or a specific wait result before retrying. Avoid repeated blind fills/clicks and avoid repo inspection unless browser evidence shows app internals are needed.
- After clicking Submit/Continue, wait for specific text, selector, network response, or page-state change before deciding the result.
- If `frame_selector` times out, switch to JavaScript `contentDocument` injection only when same-session access is available.
- Never store credentials in artifacts or history; use them directly in tool inputs and redact reports.
- If 2FA code is needed, ask the user and wait; do not attempt to bypass.
- Do not close shared daemon tabs unless the task explicitly requires it.
