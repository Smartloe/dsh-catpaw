# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这个仓库

把妙手（CatPaw）桌面端的模型桥接进 DeepSeek Harness 的插件。仓库根就是插件包本身（`package.json` 声明 `dsh.bundle`），没有构建步骤，改完直接用。

```
index.js                provider 注册、SSE 解析、工具协议、登录工具
stream-text.mjs         增量/快照归一 + 标记块切分（可单测）
stream-text.test.mjs    流式与标记块的用例
prompt.test.mjs         工具协议/裁剪的用例
models.test.mjs         推理档位映射的用例
login.mjs               扫码登录（纯 HTTP）
cordis.patch.yml        默认模型表
bin/catpaw-cli          妙手自带的 agent CLI（专有二进制）
examples/               无头冒烟测试 patch
scripts/verify-bundle.sh 按安装形态（tarball + profile bundle）验一遍
```

修改后先跑 `node --check index.js` 和 `node --test`（三个用例文件，40 条），再用 `examples/headless-catpaw.yml` 做一次无头验证。改了 package.json / files / bundle 相关的东西，再跑 `./scripts/verify-bundle.sh`：它按用户安装后的形态（tarball + profile bundle + 自带 CLI）走一遍。

## 妙手应用在哪

- 应用：`/Applications/妙手.app`，bundle id `com.catx.catpaw`
- 主包：`Contents/Resources/app.asar`（数百 MB，源码在其中，未压缩，可用 asar 索引直接读）
- CLI：`Contents/Resources/app.asar.unpacked/node_modules/@catpaw/agent-sdk/bin/catpaw-cli`（Bun 编译的单文件可执行）
- 登录态：`~/.meituan-catpaw/auth.json`
- 桌面 CLI：`Contents/Resources/bin/paw`（管设置、会话、MCP，不发模型请求）

## catpaw-cli 协议

应用启动后拉起 `catpaw-cli server`，只绑 `127.0.0.1` 随机端口。JSON-RPC 2.0，`POST /api`，流式加 `"stream": true` 返回 SSE。`/v1/messages`、`/v1/chat/completions`、`/v1/models` 都是 404。

已确认的行为：

- `agent.getAvailableModels` 只返回 `auto`，不是完整模型表
- 真正的模型是数字 `modelType`，经 `agent.start` 的 `config.model` 传入
- 模型参数走 `dynamicContext.requestContext.modelParams`：`context`（字符串枚举）、`thinking`（`{enabled: boolean}`）、`effort`（`low|high|max`）。`thinking` 必须是对象，传字符串会被后端 Jackson 拒掉
- 权限模式：`dontAsk`、`acceptEdits`、`default`、`plan`、`bypassPermissions`、`unsafeBypassPermissions`。没有界面时 `default` 会停在 `interaction_pending`
- SSE 帧双层：`event.type` 是类型，字段在 `event.data`。`model_chunk.content` 是**增量**（实测每帧 1–4 字符，整轮拼接与 `model_end` 全文逐字节相同）；`model_end` 只带**本轮**文本，一次 run 可以有多轮，所以按轮对齐，不能整段再追加一次
- CLI 云端默认地址不可达，必须在启动时注入 `CATPAW_CONFIG_CONTENT`：`{ baseURL, cookie, authTokens, source:"CatX", mode:"CATX_APP" }`

## 模型表从哪来

`POST /api/agent/maas/model-types`，body `{tenant:"CatDesk", scene:"CATX_APP", env:"EXTERNAL"}`，带 `Access-Token` / `x-passport-token`。返回 12 个模型，每项含 `modelTypeId`、`modelTypeName`、`parameterDefinitions`。模型表的 `params` 字段就是从 `parameterDefinitions` 的 `id` 抄下来的，改表时以该接口为准。

## 登录

纯 HTTP，见 `login.mjs`：`login-config` 拿 `loginEntryUrl`，拼 `state` / `redirect` / `sid`，然后本地回调和 `poll-token` 双通道抢 token，写入 `auth.json`（格式与妙手一致）。个人 Passport 账号没有 refresh token，过期只能重扫；企业 EPassport 走 device code，有 refresh token。

## 工具协议

DSH 通过 `options.tools` 传工具定义，但 CLI 只会流文本，所以用文本协议承载：

- prompt 里的 `<tools>` 段列工具与紧凑 schema
- 模型输出 `<<<catpaw_tool_call>>>` + JSON 数组 + `<<<end_catpaw_tool_call>>>`；工具名带 `dsh_` 前缀（`dsh_bash`、`dsh_read`），解析时映射回宿主真名
- `stream-text.mjs` 的 `TextChannel` 同时吃增量和快照，`MarkerGate` 在累积文本上扫标记（尾部预留 `MARKER_HOLD` 字符防止被帧切断）；`stream()` 把结果组装成 `block-start` / `tool-call-delta` / `block-end`，`finish` 用 `{kind:"tool-calls"}`
- 妙手自带的 19 个工具在启动 CLI 时用 `CATPAW_CONFIG_CONTENT.excludeTools` 排除（通配符 `*` 无效，必须逐个列名）；排除后模型只剩标记块一条路（实测单文件 6/6、双文件 5/6；未排除时约 1/3）。模型仍会偶发原生 XML——`<longcat_tool_call>`、DeepSeek 的 `<｜｜DSML｜｜ invoke>`——`MarkerGate` 把这两种也当标记，分别由 `parseLongcatCalls` / `parseDsmlCalls` 解析；transcript 里的历史工具调用按 `dsh_` 别名渲染，避免和协议自相矛盾
- 协议在 transcript 之后重申一次（recency），否则模型会退回自带工具

改动这块时注意：`tool-call-delta` 的 `id` 不能为空、`name` 不能是空串，否则不会被装配成块。

## 不要做的事

- 不要把妙手配进 CC Switch。CC Switch 写 `ANTHROPIC_BASE_URL`，Claude Code 发的是 Anthropic Messages API，妙手接不住。
- 不要在仓库里提交 `auth.json` 或任何 token（`.gitignore` 已覆盖）。
- 不要把 `bin/catpaw-cli` 当成 MIT 覆盖的内容——它是美团的专有二进制。
