# CatPaw (妙手) model bridge

`dsh-catpaw` registers a `catpaw` LLM provider on DeepSeek Harness's `llm` service, so 妙手's 12 real models (LongCat, GLM, DeepSeek, MiniMax, Kimi, Auto) are selectable in the model picker as **CatPaw (妙手)**.

## What it does

妙手 ships no local model and no OpenAI/Anthropic-compatible endpoint. Its model is only reachable through the local `catpaw-cli server`, which speaks JSON-RPC 2.0 over HTTP and streams SSE from `agent.start`. This plugin translates a harness model call into one CatPaw agent run and streams the model's reasoning/text back as harness `StreamChunk`s:

```
DSH agent loop
  -> ctx.llm.stream({ provider: 'catpaw', model: '77', messages, system, tools })
  -> CatPawAdapter.stream()
  -> catpaw-cli server (POST /api, stream: true, text/event-stream)
  -> CatPaw cloud
  -> model_chunk { content, reasoningContent }
  -> StreamChunk (reasoning-delta / text-delta / block-start / block-end / finish)
```

The plugin also passes the same per-launch config the desktop app injects (`baseURL` + passport token from `~/.meituan-catpaw/auth.json`), because the CLI's built-in default endpoint (`catpaw-agent.sankuai.com`) is not reachable on a normal network.

## Requirements

- The `catpaw-cli` binary — either the copy bundled with 妙手, or a standalone copy at `~/.catpaw-dsh/bin/catpaw-cli` (see [Login without 妙手](#login-without-妙手))
- A CatPaw account. Run `catpaw_login` once and scan the QR code; the credential is written to `~/.meituan-catpaw/auth.json`
- Calls consume the signed-in account's CatPaw quota

## Install

The repository root is the plugin package, so it installs straight from GitHub:

```sh
dsh plugin --profile web add github:Smartloe/dsh-catpaw
```

From a checked-out clone, a DSH session can also install it locally:

```
plugin_manager install_bundle target=<repo>
```

## Login without 妙手

The bridge no longer needs the desktop app to stay installed or signed in.

**1. The CLI binary.** Copy it once, then the plugin prefers that copy:

```sh
mkdir -p ~/.catpaw-dsh/bin
cp "/Applications/妙手.app/Contents/Resources/app.asar.unpacked/node_modules/@catpaw/agent-sdk/bin/catpaw-cli" ~/.catpaw-dsh/bin/
chmod +x ~/.catpaw-dsh/bin/catpaw-cli
```

Resolution order: config `cliPath` → `CATPAW_CLI` → the copy in this repository → `~/.catpaw-dsh/bin/catpaw-cli` → the 妙手 bundle.

The bundled copy is a **macOS arm64** binary; on other platforms point `cliPath` at your own.

**2. The credential.** Ask the agent to call `catpaw_login`; open the returned URL and scan. `catpaw_auth_status` reports the account and whether the token is still accepted; when something is unclear, ask the agent for `catpaw_doctor` — one report covering the resolved CLI binary, the credential, the gateway, whether the configured catalogue still matches 妙手's live one, the local server, how the previous call went, and the effective settings.

Under the hood it is the same pure-HTTP flow the app uses — no Electron:

```
GET  https://catx.nocode.cn/api/gateway/passport/login-config   -> { loginEntryUrl }
open {loginEntryUrl}?state=<hex>&redirect=http://127.0.0.1:<port>/callback&sid=<hex>
race: loopback callback (?token=&state=)  vs  GET /api/gateway/passport/poll-token?sid=<hex>
write ~/.meituan-catpaw/auth.json  (same shape the app writes)
```

Personal (Passport) accounts get **no refresh token** — the app itself reports `canRefresh: false` for this provider — so an expired token always means a fresh scan. Enterprise (EPassport) accounts go through the device-code flow at `passport.catpaw.meituan.com` and do return one.

## Use

Open the model picker in the DSH Web GUI and choose **CatPaw (妙手) → one of the 12 models**. Each model exposes its own reasoning-effort row (Off/Low/High/Max, or Off/深度思考 for thinking-only models).

To make it the profile default, add this to `~/.dsh/profiles/desktop/cordis.patch.yml` (or edit it in the GUI):

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: catpaw
    model: "77"
```

## Tool calling

`catpaw-cli` is an agent runtime, not a chat-completion endpoint: it only streams text. The bridge therefore carries tool calls over a small text protocol.

1. The prompt lists every harness tool (name, description, compact argument schema) inside `<tools>`.
2. To act, the model emits one marked block:

```
<<<catpaw_tool_call>>>
[{"name":"dsh_bash","arguments":{"command":"uuidgen"}}]
<<<end_catpaw_tool_call>>>
```

3. The adapter parses that payload into real harness `tool-call` blocks, so **DeepSeek Harness** executes the tool and owns the approval decision — CatPaw never runs it.
4. Results return as `tool_result` messages on the next turn.

CatPaw's own 19 tools are excluded at CLI spawn (`excludeTools`, on by default via `excludeNativeTools`), so the marked block is the only way the model can act — that is what took tool-call success from roughly one run in three to 13 of 14. The contract is also restated after the transcript. LongCat sometimes writes its own `<longcat_tool_call>` XML instead; that is parsed too (`parseLongcatCalls`), so either shape lands as a real tool call. A turn that emits no marker streams as ordinary text.

## Configuration

The row config (see `cordis.patch.yml`) accepts:

| Field | Default | Meaning |
|---|---|---|
| `cliPath` | auto-resolved | CLI binary to spawn; resolution: config → `CATPAW_CLI` → the copy in this package → `~/.catpaw-dsh/bin/catpaw-cli` → 妙手 bundle |
| `authPath` | `~/.meituan-catpaw/auth.json` | 妙手 login state |
| `baseURL` | `https://ai.catpaw.meituan.com` | CatPaw cloud endpoint (the app's endpoint) |
| `gateway` | `https://catx.nocode.cn` | Login gateway used by `catpaw_login`; model calls still use `baseURL` |
| `permissionMode` | `dontAsk` | `dontAsk`, `acceptEdits`, `default`, `plan`, `bypassPermissions`, `unsafeBypassPermissions` |
| `excludeNativeTools` | `true` | Hide CatPaw's built-in tools (`bash`, `read_file`, … 19 names) from the model. `true` uses the built-in list, an array hides exactly those names, `false` keeps them |
| `models` | the 12 models listed by 妙手's `/api/agent/maas/model-types` | Catalogue shown in the picker. Each entry: `id` (modelType), `name`, `contextWindow` (default `1024000` = 1M), `maxTokens`, `params` (`context`/`thinking`/`effort`), optional `defaultEffort` |
| `timeoutMs` | `600000` | Whole-call timeout |
| `idleTimeoutMs` | `300000` | Timeout with no *content* frame; keep-alives do not count as progress |
| `systemPrompt` | `transcript` | `transcript` puts DSH's system prompt in a `<system>` block; `none` keeps CatPaw's native prompt |
| `maxPromptChars` | `120000` | Total prompt budget; oldest messages are dropped and oversized ones clipped to stay under CatPaw's request limit (HTTP 413) |
| `toolResultChars` | `4000` | Per-tool-result limit; head and tail are kept, the middle is elided |
| `messageChars` | `20000` | Per-message clip |
| `directory` | session cwd | Override CatPaw's working directory |
| `debug` | `false` | Log the CLI server's stdout/stderr to the host console |

`permissionMode` controls CatPaw's own tool loop. `dontAsk` works for read-only file tools; `bypassPermissions` lets CatPaw edit files and run commands without an approval UI. Use the latter only if you intend CatPaw to act on this machine.

### Reasoning effort

Each catalogue entry declares which backend parameters it supports (`params`). The plugin turns those into the harness `reasoning.efforts` ladder and maps the selected effort into CatPaw's `dynamicContext.requestContext.modelParams`:

| Backend params | Harness efforts | Mapping |
|---|---|---|
| `context` + `thinking` | Off, 深度思考 (`high`) | `thinking: { enabled: effort !== 'off' }` |
| `context` + `effort` | Low, High, Max | `effort: 'low' \| 'high' \| 'max'` |
| `context` + `thinking` + `effort` | Off, Low, High, Max | `off` disables thinking; the rest set `effort` |
| none (Auto) | — | no Effort row |

`context` is sent as `"1024000"` by default, so every model runs with a 1M-token window unless its catalogue entry overrides `contextWindow`. Verified with DeepSeek-V4.1-Flash: `off` → 0 reasoning chunks; `max` → ~470 chars of reasoning.

## Verify

Headless (a real DSH host, no GUI):

```sh
cd <repo>
node --test                        # 64 cases, offline
dsh headless --patch ./examples/headless-catpaw.yml "只回复两个字：你好"

# the installed shape (what `dsh plugin add` produces): pack, install into a
# throwaway DSH profile, compose it, answer one prompt, and confirm the vendored
# catpaw-cli is the binary in use
./scripts/verify-bundle.sh          # --offline skips the model call
# stdout: 你好！有什么可以帮你的吗？
```

GUI: select **CatPaw 77**, send a message, and confirm the reply. The Plugins panel shows the bundle as **妙手模型桥接** with the paw icon.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Answers stop halfway, or a paragraph repeats | The 1.0.x streaming bug (deltas read as snapshots). Fixed in 1.1.0 — check which version is installed |
| The model says it will run something and then does nothing | It called one of CatPaw's own tools, was denied, and narrated that. Since 1.1.0 `excludeNativeTools` (default true) removes those tools from the model's list; put it back to `true` if you changed it |
| `interaction_pending` | `permissionMode` is a mode that needs a human. Use `dontAsk` |
| 401 / 403, or "the login may have expired" | The token expired. Ask the agent for `catpaw_login` |
| Something is wrong but unclear | Ask the agent for `catpaw_doctor`: CLI path, credential, gateway, catalogue drift, local server, effective settings |
| "catpaw-cli 没有执行权限" | The binary lost its executable bit. `chmod +x` it; `catpaw_doctor` names this too |
| "找不到 catpaw-cli" | Point `cliPath` at your binary; the bundled one is macOS arm64 |
| It spins and then times out | The backend stalled. Five minutes without a content frame aborts the turn and stops the backend run; tune `idleTimeoutMs` / `timeoutMs` |
| Long sessions lose earlier context | The prompt has a character budget (`maxPromptChars`, 120k by default); the oldest messages are dropped and the prompt says how many |
| A tool result is missing its middle | Results over `toolResultChars` (4000) keep their head and tail with the middle elided |

## Limitations

- Tool calling is prompt-driven: the model must emit the marker block. CatPaw's own 19 tools are excluded at spawn, so that block is its only path; occasionally it still writes its native XML (parsed too) or answers in prose (nothing executes — resend, it usually lands). Verified working with LongCat-2.5 (`10002544`) and DeepSeek-V4.1-Flash (`97`).
- The backend occasionally stalls without sending a content frame. Five minutes of silence aborts the turn and sends `agent.stop`, so it does not spin forever.
- CatPaw's own tools are excluded (`excludeNativeTools`), and anything it tries anyway stays denied under `permissionMode: dontAsk`, so the harness tools are the only execution path. Setting `excludeNativeTools: false` plus `permissionMode: bypassPermissions` lets CatPaw act on its own instead, bypassing harness approvals.

- Each harness model call is a fresh CatPaw agent run; the whole DSH transcript is rendered into the prompt. Long sessions re-send context every turn.
- CatPaw's tool loop runs server-side. Its tool calls are **not** forwarded as DSH tool calls, and DSH's tools are reachable only through the marker block.
- The token is re-read on every call; once `catpaw_login` writes a new credential the CLI server restarts automatically. Personal accounts cannot refresh, so expiry needs a new scan.
- `agent.getAvailableModels` only returns `auto` (modelType 0). The real catalogue comes from 妙手's `POST /api/agent/maas/model-types` (`tenant=CatDesk`, `scene=CATX_APP`, `env=EXTERNAL`); all 12 modelTypes it returns were verified to answer. If the account's catalogue changes, refresh `models` from that endpoint.
- The client module does not declare a `Config` schema, so its row is configured through `cordis.patch.yml` rather than a settings form.
