# 验证清单

这份文件回答一个问题：**怎么确认这个插件是好的**。它分成三层——不联网的单元测试、需要真实账号的命令行验证、以及必须在 GUI 里手动走一遍的清单。

每一层都能独立跑；越往下越接近用户真实路径，但也越依赖环境。

---

## 第 1 层：单元测试（离线，随时可跑）

```sh
node --test
```

覆盖 89 条，六个文件，全部离线：

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
| 1 | 打开模型选择器 | 出现 **CatPaw (妙手)**，12 个模型，每个带自己的推理档位行 |
| 2 | 选 DeepSeek-V4-Pro，档位「高」，问一个需要思考的问题 | 先出 reasoning 块再出正文；**首字立刻出现**，不空等 |
| 3 | 让它「用 bash 执行 `uuidgen`」 | 出现工具调用卡（可审批），执行结果回到对话 |
| 4 | 让它「调 catpaw_doctor」 | 六行报告：CLI / 凭据 / 网关 / 模型表一致性 / 本地服务 / 上一次调用 |
| 5 | 发一个长任务，点停止 | 立刻停住；后端也被 `agent.stop`（不再空烧额度） |
| 6 | 让 agent「扫码登录妙手」（token 过期时） | 返回授权链接，扫码后自动生效，无需重启 |

---

## 出问题时

先让 agent 调 `catpaw_doctor`，它的六行报告已经包含定位所需的全部信息：

```
catpaw-cli: <解析到的二进制，或「文件不存在 / 没有执行权限」>
凭据: <账号> / token 有效 | 已失效（→ 运行 catpaw_login）
网关: <地址> 可访问（<延迟>ms）| 失败 — <原因>
模型表: 配置 N 个 / 线上 M 个；线上新增: … / 一致
本地服务: http://127.0.0.1:<port>（已启动）| 未启动
上一次调用: <时间> · 模型 <id> · stop|tool-calls|error · <耗时>ms — <细节>
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
