# CatPaw (妙手) bridge for DeepSeek Harness

![test](https://github.com/Smartloe/dsh-catpaw/actions/workflows/test.yml/badge.svg)

把妙手（CatPaw）桌面端背后的模型接进 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的模型选择器：12 个真实模型、可调推理等级、可回传真实工具调用，并且扫码登录后不再依赖妙手 App 常驻。

> **先说适用范围。** 模型请求走 `ai.catpaw.meituan.com`，登录走 `catx.nocode.cn`，两者都是美团内网服务。**只有拥有美团账号（Passport 或 EPassport）并且能访问内网的人才能真正用起来。** 这个仓库公开的意义是分享实现，不是给外部用户提供一个可用的模型源。

## 它做了什么

妙手不是本地模型，也没有 OpenAI / Anthropic 兼容接口。它的模型只能通过本机的 `catpaw-cli` 访问，而该进程只绑 `127.0.0.1` 的随机端口，用 JSON-RPC 2.0 + SSE 通信。

本插件在 DSH 的 `llm` 服务上注册一个 `catpaw` provider，把 DSH 的一次模型调用翻译成一次 CatPaw agent run，再把流式结果翻译回 DSH 的 `StreamChunk`：

```
DSH agent loop
  → ctx.llm.stream({ provider:'catpaw', model, messages, system, tools })
  → CatPawAdapter.stream()
  → catpaw-cli server (POST /api, stream:true, text/event-stream)
  → CatPaw cloud
  → model_chunk { content, reasoningContent }
  → StreamChunk (reasoning-delta / text-delta / tool-call / finish)
```

三个关键点：

- **真实模型表**：来自妙手的 `POST /api/agent/maas/model-types`（`tenant=CatDesk`、`scene=CATX_APP`、`env=EXTERNAL`），不是 `product.json` 里那几个内部 ID。
- **推理等级**：每个模型按它支持的参数（`context` / `thinking` / `effort`）暴露不同的档位，经 `dynamicContext.requestContext.modelParams` 传给服务端。
- **工具调用**：CLI 只会流文本，所以工具调用走一个显式文本协议，插件解析成真的 `tool-call` 块，由 DSH 执行、DSH 掌握审批。

## 目录

```
.
├── package.json             dsh.bundle 清单 + 包入口（仓库根即插件包）
├── index.js                 provider、流解析、工具协议、登录工具
├── login.mjs                扫码登录（纯 HTTP，不依赖 Electron）
├── cordis.patch.yml         默认模型表
├── locale/                  中英文显示名
├── icon.svg                 插件图标
├── bin/catpaw-cli           妙手自带的 agent CLI（见版权说明）
├── examples/
│   └── headless-catpaw.yml  无头冒烟测试用的 patch
└── CLAUDE.md                仓库内的开发指引
```

## 快速开始

三步：装插件 → 扫码登录 → 选模型。装完就用，不需要额外准备二进制。

**1. 安装插件。** 仓库根就是插件包，包内自带 `bin/catpaw-cli`：

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:Smartloe/dsh-catpaw

# 本地已经 clone 时，也可以从 DSH 会话里装
plugin_manager install_bundle target=<repo>
```

启用 `dsh-catpaw`，模型选择器里就会出现 **CatPaw (妙手)**。

**2. 扫码登录。** 对 agent 说「扫码登录妙手」，它会调用 `catpaw_login` 返回授权链接；浏览器完成扫码后凭据自动写入 `~/.meituan-catpaw/auth.json`，下一次调用自动生效，不用重启。

**3. 确认状态。** 让 agent 调 `catpaw_doctor`，它会一次性报告：CLI 解析到哪份二进制、凭据是否还有效、网关是否可达、**线上模型表与配置是否一致**、本地服务是否在跑、**上一次调用耗时与结果**，以及当前生效的设置。

### 需要换用别的 CLI 副本时

包内那份是 **macOS arm64** 的。在别的平台、或想用妙手 App 自带的那份时，按下面任一方式指定：

```sh
# 方式一：拷到约定位置
mkdir -p ~/.catpaw-dsh/bin
cp "/Applications/妙手.app/Contents/Resources/app.asar.unpacked/node_modules/@catpaw/agent-sdk/bin/catpaw-cli" ~/.catpaw-dsh/bin/
chmod +x ~/.catpaw-dsh/bin/catpaw-cli

# 方式二：直接告诉插件
CATPAW_CLI=/path/to/catpaw-cli dsh web       # 环境变量
# 或在插件行的 config 里写 cliPath
```

解析顺序：`cliPath` → `CATPAW_CLI` → 包内 `bin/catpaw-cli` → `~/.catpaw-dsh/bin/catpaw-cli` → 妙手 App 包内。

## 模型

| modelType | 名称 | 推理等级 |
|---|---|---|
| 10002544 | LongCat-2.5 | 关闭思考 / 深度思考 |
| 77 | LongCat-2.0 | 关闭思考 / 深度思考 |
| 98 | GLM-5.3-FlashX | 低 / 中 / 高 |
| 91 | GLM-5.3-Flash | 低 / 中 / 高 |
| 89 | GLM-5.3 | 低 / 中 / 高 |
| 97 | DeepSeek-V4.1-Flash | 关闭思考 / 低 / 中 / 高 |
| 64 | DeepSeek-V4-Pro | 关闭思考 / 低 / 中 / 高 |
| 10002518 | MiniMax-M3.1-Flash | 低 / 中 / 高（默认低） |
| 70 | MiniMax-M3 | 关闭思考 / 深度思考 |
| 10002533 | Kimi-K3.1-Pro | 关闭思考 / 低 / 中 / 高 |
| 83 | Kimi-K3 | 关闭思考 / 低 / 中 / 高 |
| 0 | Auto | — |

上下文默认 1M（`context: "1024000"`）。等级映射：

- `off` → `thinking: { enabled: false }`
- `low` / `high` / `max` → `thinking: { enabled: true }` + `effort: "low"|"high"|"max"`

## 工具调用

1. prompt 里用 `<tools>` 段列出所有 Harness 工具（名称、描述、紧凑参数 schema）。
2. 模型要动手时必须输出：

```
<<<catpaw_tool_call>>>
[{"name":"dsh_bash","arguments":{"command":"uuidgen"}}]
<<<end_catpaw_tool_call>>>
```

3. 插件把这段解析成真实的 `tool-call` 块，**由 DSH 执行并掌管审批**，妙手不参与。
4. 结果作为 `tool_result` 在下一轮回到模型。

启动 catpaw-cli 时会把妙手自带的 19 个工具用 `excludeTools` 全部排除（`excludeNativeTools: true`，默认开），模型手里只剩标记块这一条路——这是工具调用成功率从约 1/3 提到 13/14 的关键。协议在 transcript 之后还会重申一次（recency）。没有原生工具可调时，模型会把自己训练时的格式当正文吐出来——LongCat 的 `<longcat_tool_call>`、DeepSeek 的 `<｜｜DSML｜｜ invoke>`——插件都能解析（`parseLongcatCalls` / `parseDsmlCalls`），所以三种写法都能落地；提示词里也明确禁止输出 XML 标签。

## 配置

写在插件条目的 `config` 里（见 `cordis.patch.yml`）：

| 键 | 默认 | 含义 |
|---|---|---|
| `models` | 上表 12 个（定义在 `index.js` 的 `DEFAULT_MODELS`） | 模型目录；每项含 `id`、`name`、`contextWindow`、`maxTokens`、`params`、可选 `defaultEffort`。行配置里写 `models` 会覆盖内置表 |
| `cliPath` | 自动解析 | CLI 二进制路径 |
| `authPath` | `~/.meituan-catpaw/auth.json` | 凭据文件 |
| `baseURL` | `https://ai.catpaw.meituan.com` | 模型端点 |
| `gateway` | `https://catx.nocode.cn` | 登录网关（模型调用仍用 `baseURL`） |
| `permissionMode` | `dontAsk` | 妙手自身工具循环的权限模式 |
| `excludeNativeTools` | `true` | 关掉妙手自带的工具（`bash`/`read_file`/… 共 19 个）。`true` 用内置名单，数组则按名单，`false` 保留 |
| `systemPrompt` | `transcript` | `transcript` 把 DSH 的 system prompt 放进 `<system>`；`none` 保留妙手原生提示 |
| `maxPromptChars` | `120000` | 单轮 prompt 字符预算，超出丢最旧的消息 |
| `toolResultChars` | `4000` | 单条工具结果上限，超出时保留首尾、省略中间 |
| `messageChars` | `20000` | 单条消息截断 |
| `timeoutMs` / `idleTimeoutMs` | `600000` / `300000` | 总超时 / 无**内容帧**超时（心跳帧不算进展） |
| `directory` | 会话 cwd | 覆盖妙手的工作目录 |
| `debug` | `false` | 打印 CLI 的 stdout/stderr |

## 登录是怎么工作的

妙手的扫码登录本身是纯 HTTP，不需要 Electron：

```
GET  https://catx.nocode.cn/api/gateway/passport/login-config   -> { loginEntryUrl }
open {loginEntryUrl}?state=<hex>&redirect=http://127.0.0.1:<port>/callback&sid=<hex>
race: 本地回调 (?token=&state=)  vs  GET /api/gateway/passport/poll-token?sid=<hex>
write ~/.meituan-catpaw/auth.json
```

个人（Passport）账号**不返回 refresh token**——妙手自己在该 provider 上标注 `canRefresh: false`——所以 token 过期只能重新扫码。企业（EPassport）账号走 `passport.catpaw.meituan.com` 的 device code 流程，会返回 refresh token。

## 验证

```sh
cd <repo>
node --test                        # 89 个用例，不联网
dsh headless --patch ./examples/headless-catpaw.yml "只回复两个字：你好"

# 安装形态（= 用户 `dsh plugin add` 之后的样子）：打包、装进一个临时 DSH profile、
# 组合配置、跑一句真模型调用，并确认用的是插件自带的那份 catpaw-cli
./scripts/verify-bundle.sh           # 加 --offline 只验组合不调模型
./scripts/verify-package.sh          # 只验打包本身：不依赖 DSH，CI 每次都会跑
```

期望 stdout 输出 `你好`、退出码 `0`。这条路径加载的就是 `index.js`，和 GUI 走同一份代码。

工具调用可以用一个模型猜不到的输入验证：

```sh
echo -n "nonce-$(date +%s)" > /tmp/probe.txt
dsh headless --patch ./examples/headless-catpaw.yml "用 bash 执行 cat /tmp/probe.txt，把内容原样告诉我"
```

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 回答只出来一半，或者同一段重复两次 | 1.0.x 的流式 bug（把增量当快照）。1.1.0 起已修；确认装的是新版本 |
| 模型说"我将执行…"但什么都没做 | 它调了妙手自带工具、被拒后开始解释。1.1.0 起默认 `excludeNativeTools: true` 会把这些工具从模型手里拿走；若你手动改过这行，改回 `true` |
| 报 `interaction_pending` | `permissionMode` 停在需要人工确认的模式。设成 `dontAsk` |
| 报 401 / 403，或提示"登录态可能已失效" | token 过期。让 agent 调 `catpaw_login` 重新扫码 |
| 说不清哪里不对 | 让 agent 调 `catpaw_doctor`，它会把 CLI 路径、凭据、网关、模型表一致性、本地服务与生效设置一次列出来 |
| 报"catpaw-cli 没有执行权限" | 二进制丢了 +x。插件会自己 `chmod +x` 并重试一次；仍失败再手动 `chmod +x` 那份文件 |
| 报"找不到 catpaw-cli" | 用 `cliPath` 指到你那份二进制；仓库自带的是 macOS arm64 |
| 一直转圈，最后超时 | 后端卡住或网络抖动。默认 5 分钟无内容帧就中止，并通知后端停止；可调 `idleTimeoutMs` / `timeoutMs` |
| 长会话后模型忘了前面说过什么 | 单轮 prompt 有字符上限（`maxPromptChars`，默认 12 万），超出会丢最旧的消息，并在 prompt 里注明省略了多少条 |
| 工具结果的中间部分不见了 | 单条结果超过 `toolResultChars`（默认 4000）时保留首尾、省略中间 |

## 已知限制

- 模型请求是本机 `catpaw-cli` 进程，只绑 `127.0.0.1`，只有本机能调。
- 工具调用依赖模型遵守文本协议。妙手自带的 19 个工具在启动 CLI 时就被排除了，所以模型只有标记块一条路；偶发情况下它仍会吐自己的原生 XML（插件照样解析），或干脆用纯文本回答——后者重发一次通常就成。LongCat-2.5 与 DeepSeek-V4.1-Flash 实测可用。
- 后端偶尔会卡住（不发内容帧）。默认 5 分钟没有任何内容帧就中止该轮，并向后端发 `agent.stop`，不会一直转圈。
- 个人账号 token 无法自动续期，到期需重新扫码。
- 每轮都把整段对话渲染进 prompt，长会话重复发送上下文；`maxPromptChars` 会丢弃最旧的消息。

## 版权与许可

源代码以 MIT 发布，见 [LICENSE](LICENSE)。

**`bin/catpaw-cli` 是美团（Meituan）所有的专有二进制，不随本仓库的 MIT 条款授权。** 它在这里只为方便取用；使用与再分发请遵循其所有者允许的范围。本项目引用的内网服务端点同样归美团所有，本许可证不授予你对它们的任何权利。
