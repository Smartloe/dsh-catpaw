# 验证清单

这份文件回答一个问题：**怎么确认这个插件是好的**。它分成三层——不联网的单元测试、需要真实账号的命令行验证、以及必须在 GUI 里手动走一遍的清单。

每一层都能独立跑；越往下越接近用户真实路径，但也越依赖环境。

---

## 第 1 层：单元测试（离线，随时可跑）

```sh
node --test
```

覆盖 94 条，六个文件，全部离线：

| 文件 | 守住什么 |
|---|---|
| `stream-text.test.mjs` | 增量/快照归一、标记切分、首字延迟、跨帧标记 |
| `prompt.test.mjs` | 工具协议文本、别名、裁剪、prompt 预算、消息渲染 |
| `models.test.mjs` | 推理档位映射、`modelParams` 组装、失败码 |
| `adapter.test.mjs` | 适配器端到端（用 `fixtures/fake-cli.mjs` 假装 CLI） |
| `defaults.test.mjs` | README 配置表里的每个默认值、CLI 解析顺序、模型目录唯一来源 |
| `login.test.mjs` | 授权 URL 参数、凭据文件结构与权限 |

**通过标准**：全绿，退出码 0。

---

## 第 2 层：打包（离线，CI 每次都会跑）

```sh
./scripts/verify-package.sh
```

**通过标准**：

```
==> inspecting the tarball
  ok  package.json
  ok  index.js
  ok  stream-text.mjs
  ok  login.mjs
  ok  cordis.patch.yml
  ok  bin/catpaw-cli
  ok  no tests, fixtures, examples or credentials
==> loading it the way the harness does
loaded: N exports, 12 models
==> checking the vendored CLI is runnable
  ok  executable
  ok  catpaw-cli/1.2.0-beta.45 darwin-arm64 …      ← 宿主架构匹配时才会真跑
==> ok
```

它会拦住三类历史事故：`files` 漏文件、测试/夹具混进包、二进制丢可执行位（Linux 上安装后无法执行）。

---

## 第 3 层：安装形态（需要真实账号）

```sh
./scripts/verify-bundle.sh            # 加 --offline 只验组合，不调模型
```

它把仓库打包、装进一个临时 DSH profile（bundles 里加 `dsh-catpaw`），然后依次：

| 阶段 | 期望输出 |
|---|---|
| 组合配置 | `bundle row present` |
| 纯文本调用 | `answer: 你好` |
| 工具调用 | `tool call round-tripped: nonce-…` |
| 自检 | `catpaw-cli: …/node_modules/dsh-catpaw/bin/catpaw-cli` |
| 打包完整性 | `vendored CLI present and executable` |

**这条脚本覆盖了 `dsh plugin add` 之后的真实形态**，除了 GUI 界面本身。

---

## 第 4 层：GUI（重启 DSH 之后，5 分钟）

代码改动只有重启后才生效。按顺序走一遍：

| # | 操作 | 期望 |
|---|---|---|
| 1 | 打开模型选择器 | 出现 **CatPaw (妙手)**，12 个模型；除 **Auto** 外每个都有自己的推理档位行（LongCat 是「关闭思考/深度思考」，GLM 与 MiniMax-Flash 是「低/中/高」，DeepSeek 与 Kimi 是「关闭思考/低/中/高」） |
| 2 | 选 **DeepSeek-V4-Pro（`64`）**，档位「高」，问一个需要思考的问题 | 先出 reasoning 块再出正文；**首字立刻出现**，不空等 |
| 3 | 让它「用 bash 执行 `uuidgen`」 | 出现工具调用卡，执行结果回到对话。**是否弹出审批由 DSH 自己的权限设置决定**——插件的 `permissionMode` 管的是妙手内部那个已被禁用的工具循环，与 DSH 的审批无关 |
| 4 | 让它「调 catpaw_doctor」 | 六行报告：CLI / 凭据 / 网关 / 模型表一致性 / 本地服务 / 上一次调用 |
| 5 | 发一个长任务，点停止 | 立刻停住；后端也被 `agent.stop`（不再空烧额度） |
| 6 | 让 agent「扫码登录妙手」（token 过期时） | 返回授权链接，扫码后自动生效，无需重启 |

### 第 4 层没通过时查什么

| 现象 | 先看这里 |
|---|---|
| 选择器里**没有** CatPaw (妙手) | profile 的 `package.json` → `dsh.profile.bundles` 是否含 `dsh-catpaw`；`node_modules/dsh-catpaw` 是不是有效软链（`ls -l` 应指向仓库） |
| 有 CatPaw，但**一个模型都没有** | 行配置里是否写了 `models: []`；删掉该键走内置目录，或让 `catpaw_doctor` 看「模型表: 配置 0 个」 |
| 选中模型后报「找不到 catpaw-cli」 | `catpaw_doctor` 第一行给出的路径；用 `cliPath` 或 `CATPAW_CLI` 指过去 |
| 报「没有执行权限」 | 插件会自动 `chmod +x` 并重试一次；仍失败说明文件属主不同，手动 `chmod +x` |
| 正文能出，但**没有 reasoning 块** | 档位是否选了「高」；LongCat 只有 Off/高，Auto 没有档位 |
| 模型说「我将执行…」但**没有工具卡** | `catpaw_doctor` 的「上一次调用」应为 `tool-calls`；若不是，说明模型没遵守协议——重发一次；再不行确认行配置里 `excludeNativeTools` 没被改成 `false` |
| 工具卡出现但**一直转圈** | `permissionMode` 是否为 `dontAsk`；出现 `interaction_pending` 说明停在了需要人工确认的模式 |
| 点**停止**没反应 | 确认加载的是 1.4.0+；停止后 `catpaw_doctor` 的「上一次调用」应显示 `stopped — 用户中止`（不是 `error`） |
| **首字延迟**明显（半秒空白） | 1.4.0 起已改为按需保留标记前缀；若仍明显，确认 profile 的软链指向的是本仓库而不是旧的拷贝 |

上报问题时只要贴 `catpaw_doctor` 的输出即可——六行里已经包含路径、凭据、网关、模型表、服务状态与上一次调用的结局。

---

## 出问题时

先让 agent 调 `catpaw_doctor`，它的六行报告已经包含定位所需的全部信息：

```
catpaw-cli: <解析到的二进制，或「文件不存在 / 没有执行权限」>
凭据: <账号> / token 有效 | 已失效（→ 运行 catpaw_login）
网关: <地址> 可访问（<延迟>ms）| 失败 — <原因>
模型表: 配置 N 个 / 线上 M 个；线上新增: … / 一致
本地服务: http://127.0.0.1:<port>（已启动）| 未启动
上一次调用: <时间> · 模型 <id> · stop|tool-calls|stopped|timeout|error · <耗时>ms — <细节>
```

对照 `README.md` 的「常见问题」表处理。如果报告本身就跑不出来，说明插件没加载：检查 profile 的 `cordis.yml` 里是否还有 `- id: dsh-catpaw`。

---

## 各层分别证明了什么

```
单元测试    代码逻辑对
打包检查    发出去的包能装、能加载、二进制能跑
安装检查    装好之后能聊天、能动手、能自检
GUI 清单    用户实际看到的东西对
```

前两层在 CI 与本地都能跑；第三层需要账号；第四层只能人工确认。
