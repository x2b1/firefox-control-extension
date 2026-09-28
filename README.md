# firefox-control-extension

A Firefox extension plus a loopback control server that lets an agent drive a
browser: read and click the DOM, run JavaScript in the page, capture every
`fetch`/XHR/WebSocket, and read or set cookies and storage.

Built for authorised security testing and QA automation. It is the same
capability set as Playwright or Puppeteer, wired so an agent can use it in real
time.

```
agent/CLI  ──POST /rpc──▶  server :9104  ──SSE──▶  extension  ──▶  page
          ◀──result────                    ◀─report──             │
                                                          (MAIN world)
```

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [Command reference](#command-reference)
- [Security model](#security-model)
- [Architecture](#architecture)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [License](#license)

---

## What it does

| Area | Actions |
|---|---|
| **Navigation** | `navigate` `reload` `back` `forward` `title` `set.title` |
| **Tabs** | `tab.list` `tab.create` `tab.close` `tab.activate` `tab.info` |
| **DOM** | `dom.snapshot` `dom.query` `dom.html` `dom.text` `dom.click` `dom.type` `dom.select` `dom.check` `dom.scroll` `dom.forms` `dom.inputs` |
| **Script** | `main.eval` (runs in the page's own realm) `main.fetch` (page-origin, carries cookies) |
| **Network** | `net.log` (all requests since load, with headers and bodies) `net.clear` `ws.connect` |
| **State** | `cookies.get` `cookies.set` `cookies.clear` `storage.local` `storage.session` `flag.get` `flag.set` |
| **Dialogs** | `dialog.policy` `dialog.list` `dialog.clear` |
| **Capture** | `screenshot` |
| **Control** | `allow` `deny` `allow-all` `lock` `status` `clients` `events` `tail` |

Two details worth knowing up front:

- **`main.eval` runs in the page's realm, not the extension's.** Same-origin
  rules, `document`, app globals and cookies all behave exactly as the page
  itself would, which is the point — it is how you test a SPA's real state.
- **`dom.forms` and `dom.inputs` include pre-filled values.** Checking whether
  an app pre-fills a token, a role or an internal id is usually the whole
  question. `cookies.get` returns cookie values in full for the same reason.

---

## Requirements

- **Firefox 128+** (uses `world: "ISOLATED"` content scripts and MV2)
- **Node 18+** (uses the built-in `fetch`, no dependencies at all)
- Nothing else. There is no `npm install` step.

---

## Install

### 1. Start the server

```bash
node server/index.js
```

It binds to `127.0.0.1:9104` — loopback only, never `0.0.0.0` — and prints a
64-hex token:

```
================================================================
  Pentest Bridge — agent control server
================================================================
  listening   http://127.0.0.1:9104
  token file  .../pentest-bridge/.data/token
  policy      lock [no domains]
================================================================
  Paste this token into the extension popup:
  b78752dcb9d1fcbdad2af6552daff464c95dbd5cbd81188793c2a42a2bbd7902
================================================================
```

The token is 256 bits of entropy, stored `0600` inside a `0700` directory, and
compared in constant time. It is reused across restarts, so you only paste it
once.

### 2. Load the extension

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → select `extension/manifest.json`
3. Click the Pentest Bridge toolbar icon
4. Paste the token, press **Connect** (badge turns green)

Temporary add-ons are removed when Firefox closes. For a permanent install,
build the XPI and sign it, or submit it to addons.mozilla.org.

### 3. Enable a domain

The bridge is **inert until you name a host** — see
[Security model](#security-model).

```bash
node cli/bridge.mjs allow example.com
```

Or use the popup's domain box. To hand the bridge your whole browser:

```bash
node cli/bridge.mjs allow-all
```

### 4. Drive it

```bash
node cli/bridge.mjs navigate url=https://example.com/login
node cli/bridge.mjs dom.forms
node cli/bridge.mjs main.eval expression="document.cookie"
```

---

## Usage

The CLI takes `<action> key=value`. Values are parsed as JSON when they look
like JSON, so numbers, booleans, arrays and objects all work:

```bash
node cli/bridge.mjs dom.query selector="input[type=password]" all=true
node cli/bridge.mjs flag.set name=featureFlags value='{"beta":true}'
node cli/bridge.mjs main.fetch url=/api/me credentials=include --raw
```

Common shorthands:

| Shorthand | Action |
|---|---|
| `eval <expr>` | `main.eval expression=<expr>` |
| `fetch <url> [method] [body]` | `main.fetch` |
| `shot` | `screenshot` (pipe `--raw` to a file) |
| `status` / `clients` / `events` / `tail` | server introspection |
| `allow` / `deny` / `lock` / `allow-all` / `policy` | policy control |

Flags: `--raw` (print just the value), `--timeout <ms>` / `-t`.

### A realistic session

```bash
# scope it
node cli/bridge.mjs allow example.com

# open it
node cli/bridge.mjs navigate url=https://example.com/login

# what am I looking at?
node cli/bridge.mjs dom.snapshot
node cli/bridge.mjs dom.forms

# log in
node cli/bridge.mjs dom.type selector='#user' text=alice
node cli/bridge.mjs dom.type selector='#pass' text=hunter2
node cli/bridge.mjs dom.click selector='button[type=submit]' expectUrlChange

# what did the app call in the background?
node cli/bridge.mjs net.log

# poke at app state as the page sees it
node cli/bridge.mjs main.eval expression="window.__store.getState()"

# re-check auth from the page's own origin
node cli/bridge.mjs main.fetch url=/api/session credentials=include --raw

# clean up
node cli/bridge.mjs lock
```

### Watching it in real time

```bash
node cli/bridge.mjs tail
```

Streams every network request, console error and dialog the page raises, as it
happens.

---

## Command reference

<details>
<summary><b>Full action list</b></summary>

### Navigation / tabs
```
navigate      url=<url> [tabId] [expectHost] [timeout] [waitMs]
reload        [tabId] [bypassCache]
back          [tabId]              forward     [tabId]
title         [tabId]              set.title   title=<t> [tabId]
tab.list      [reveal]             tab.create  url=<url> [active] [index]
tab.close     [tabId]              tab.activate [tabId]    tab.info [tabId]
screenshot    [tabId] [windowId] [format]
```

### DOM
```
page.info     [tabId]
dom.snapshot  [selector] [maxChars]
dom.query     selector=<css> [all] [index] [textChars] [attrs] [limit]
dom.html      [selector] [outer] [maxChars]
dom.text      [selector] [maxChars]
dom.click     selector=<css> [index] [expectUrlChange] [settleMs]
dom.type      selector=<css> [text] [clear] [typing] [delay] [check] [submit]
dom.select    selector=<css> [value | label | index]
dom.check     selector=<css> checked
dom.scroll    [y] [x] [selector] [behavior] [block] [settleMs]
dom.forms     [tabId]              # every form + field: action, method, names
dom.inputs    [tabId]              # every input, incl. pre-filled values
frame.list    [tabId]
```

Any page action accepts `frameUrl=<substr>` to target an iframe instead of the
top document.

### Script / network
```
main.eval     expression=<js> [await] [timeout]
main.fetch    url=<url> [method] [body] [headers] [credentials] [mode] [timeout]
ws.connect    url=<ws://…> [protocols] [send] [expect] [timeout]
net.log       [clear] [tabId]      # every fetch/XHR/WS/beacon since load
net.clear     [tabId]
hook.status   [tabId]              # is the MAIN-world hook alive?
```

### State
```
cookies.get   [domain] [includeValues]
cookies.set   url=<u> name=<n> value=<v> [path] [secure] [httpOnly] [sameSite] [expiration]
cookies.clear [domain]
storage.local   [key] [value] [remove] [clear]
storage.session [key] [value] [remove]
flag.get      name=<flag>          # JSON-decoded — the useful one for SPA flags
flag.set      name=<flag> value=<json> | remove
dialog.policy  [accept] [promptText] [suppressBeforeUnload]
dialog.list                          dialog.clear
```

### Control
```
bridge.status   policy.get
allow <host>    deny <host>    allow-all    lock
status   clients   events [n]   tail
```

</details>

---

## Security model

**This tool gives remote code execution and full session-cookie access in a
browser profile. Use it only against systems you are authorised to test.**

It is deliberately designed so that installing it does not expose you to other
websites, which is the risk a naive implementation of this idea carries.

### The threat this is built against

Any page you visit runs JavaScript in your browser and can freely call
`fetch('http://127.0.0.1:9104/rpc', { method: 'POST' })`. A server that trusts
loopback requests is a **remote-control channel for every site you browse**,
executed with your live cookies. That is the same class of bug as
`localhost` dev-server CSRF, and it is the reason this project has an auth layer
at all.

### Controls

| Control | What it stops |
|---|---|
| **Binds `127.0.0.1` only** | Any other machine on the network. Never change this to `0.0.0.0`. |
| **256-bit token, constant-time compare** | Unauthenticated callers. The token is required on every route except `/health`. |
| **Origin allow-list** | A token *alone* is not enough from a web page. Only `moz-extension://` is accepted, so no web origin can ever satisfy it. |
| **Deny-by-default domains** | The bridge is inert on every host you have not named. `lock` is the default state. |
| **Header-based auth for mutating routes** | Cross-origin JS cannot set `Authorization` or `X-Bridge-Token` without a preflight the server refuses. |
| **`/health` leaks nothing** | A page must be able to see the server exists without learning the token or the allow-list. |

The Origin check is defence in depth, not the primary gate — it is what makes
the tool safe to leave installed while browsing normally.

### Verify it yourself

```bash
TOKEN=$(cat .data/token)

# 1. a page you visit, with no token
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:9104/rpc \
  -H 'Origin: https://evil.example' -H 'content-type: application/json' \
  -d '{"action":"dom.inputs"}'
# -> 401

# 2. same, but with the token — a stolen token is still not enough
curl -s -X POST http://127.0.0.1:9104/rpc \
  -H "x-bridge-token: $TOKEN" -H 'Origin: https://evil.example' \
  -H 'content-type: application/json' -d '{"action":"dom.inputs"}'
# -> {"error":"origin not allowed: https://evil.example"}
```

Both are covered by tests in `test/server.test.js`.

### What the controls do *not* cover

- **Anything running as you on this machine** can read `.data/token`. That
  includes other local processes, and anything that can read your home
  directory. Loopback is not a sandbox.
- **Once the token is pasted in, the agent can read any site you have enabled.**
  That is the feature.
- **The extension holds `<all_urls>`, `tabs` and `cookies`.** Use a dedicated
  Firefox profile. Installing it in your daily driver means a bug in this tool
  has access to everything you do in that browser.
- `main.eval` executes arbitrary JS in page context. On a page you are
  authorised to test, that is the point — but it also means the page's own
  scripts can observe what you do.

---

## Architecture

```
pentest-bridge/
├── extension/
│   ├── manifest.json        MV2, persistent background
│   ├── background.js        SSE client, command routing, tabs, cookies
│   ├── bridge.js            ISOLATED world: DOM ops + MAIN-world relay
│   ├── hook.js              MAIN world: eval, fetch, network capture
│   ├── lib/policy.js        shared domain matching (unit-tested)
│   ├── lib/util.js          shared helpers
│   └── popup/               status, token, domain allow-list
├── server/
│   ├── index.js             HTTP routes, auth, Origin gate
│   ├── hub.js               client registry, command queue, event ring
│   ├── token.js             token generation + constant-time compare
│   └── policy.js            server-side domain policy
├── cli/bridge.mjs           agent-side client
├── test/                    86 tests
└── tools/                   icon + XPI generators
```

### Why two worlds

Firefox gives a content script an isolated JS realm with a clean view of the
DOM, which is what you want for reliable element handling. But an isolated
world cannot reach the page's own globals, and `eval` or a same-origin
`fetch` running from the extension would be subject to different CORS and
cookie rules than the page itself.

So `hook.js` is injected into the page's realm and instruments `fetch`, XHR,
WebSocket, `sendBeacon`, `EventSource` and the dialog functions there. The two
halves talk over `window.postMessage`.

`hook.js` is injected by `bridge.js` at runtime as a `<script src=moz-extension://…>`
tag rather than declared with `content_scripts[].world: "MAIN"`, because
**Firefox does not honour `world: "MAIN"` on MV2** — the manifest form parses
fine and silently never runs.

### Why SSE and not WebSocket

Server→extension is a long-lived `EventSource`; extension→server is a plain
`POST`. This needs no dependencies, no framing code to get wrong, and survives
arbitrarily long idle periods. `EventSource` cannot set headers, so that one
request carries the token in its query string — a same-machine loopback
request, so the exposure is limited to the extension's own devtools log.

---

## Development

```bash
npm test              # 86 tests, no dependencies
npm start             # run the server
npm run icons         # regenerate icons
npm run xpi           # build out/pentest-bridge.xpi
```

### Test layout

| File | Covers |
|---|---|
| `test/server.test.js` | Routes, auth, the Origin gate, end-to-end command round trip |
| `test/policy.test.js` | Server-side domain matching, including suffix-confusion cases |
| `test/extpolicy.test.js` | The extension's policy module, plus parity with the server's copy |
| `test/hub.test.js` | Command lifecycle: timeouts, disconnects, duplicate/late reports |
| `test/token.test.js` | Token generation, file permissions, constant-time compare |
| `test/contract.test.js` | The three action tables agree; manifest matches the code |
| `test/relay.test.js` | The `hook.js` ↔ `bridge.js` wire format |

`contract.test.js` exists because the action list is written down in three
places (server allow-list, background router, content-script implementation)
and drift between them is silent — a typo just becomes "unknown action" at
runtime.

### After editing the extension

Press **Reload** in `about:debugging`. Temporary add-ons do not hot-reload.

---

## Troubleshooting

**`no extension attached`** — the extension is not connected. Check the badge is
green and the token matches `cat .data/token`.

**`domain "x" is not enabled`** — working as intended. Run
`node cli/bridge.mjs allow x`, or `allow-all`.

**`main-world "…" timed out`** — the page-world hook did not answer. Run
`node cli/bridge.mjs hook.status` for a live round-trip check. It also fails
against a cross-origin iframe you have not targeted; use `frameUrl=`.

**`unknown action: …`** — the server was not restarted after the action was
added. `server/index.js` reads its allow-list at boot.

**Badge stays grey** — the server is not running, or a different port. Check
`curl http://127.0.0.1:9104/health`.

---

## Limitations

- **Firefox only.** MV2 and a persistent background page. The MAIN-world
  injection would need rework for MV3's service-worker model.
- **`beforeunload` dialogs are suppressed, not solved.** `dialog.policy` answers
  `alert`/`confirm`/`prompt` from a policy you set in advance, because
  `confirm()` must return synchronously and a round trip cannot block it.
- **Response bodies are capped** (2 MB for `main.fetch`, 512 KB for captured
  XHR) and binary responses are skipped rather than stored.
- **No multi-profile routing.** One active extension at a time is the target;
  several may attach, but commands go to the most recent unless you pin a
  `clientId`.
- **`screenshot` captures the visible tab only.** There is no full-page capture.
- **Not verified against:** Firefox for Android, multi-process edge cases under
  heavy load, and pages that aggressively fight instrumentation.

---

## License

MIT — see [LICENSE](LICENSE). Use it, modify it, ship it.

The one thing the license cannot do is grant you permission to test a system
you do not own. That permission comes from the program's owner and its bug
bounty or disclosure policy.
