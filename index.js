/**
 * CatPaw (妙手) model bridge for DeepSeek Harness.
 *
 * The 妙手 desktop app ships no local model weights and exposes no
 * OpenAI/Anthropic-compatible endpoint. Its model is only reachable through
 * the local `catpaw-cli server`, which speaks JSON-RPC 2.0 over HTTP and
 * streams SSE from `agent.start`. This plugin registers a `catpaw` LLM
 * provider on the harness `llm` seam and translates harness model calls into
 * one CatPaw agent run, streaming the model's reasoning/text back as harness
 * `StreamChunk`s.
 *
 * The bridge is intentionally stateless per harness call: the whole harness
 * conversation is rendered into the CatPaw prompt, so every turn sees the
 * complete history. CatPaw's own tool loop runs server-side; its tool calls
 * are not forwarded as harness tool calls (the two tool sets are unrelated).
 *
 * Only works on this machine, while 妙手 is signed in. Calls consume the
 * signed-in account's CatPaw quota.
 */
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { fetchModelTypes, runLogin, validateToken, whoami } from "./login.mjs";
import { DSML_CLOSE, DSML_OPEN, LONGCAT_CLOSE, LONGCAT_OPEN, MarkerGate, TextChannel, TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from "./stream-text.mjs";

const PROVIDER = "catpaw";
const APP_CLI =
  "/Applications/妙手.app/Contents/Resources/app.asar.unpacked/node_modules/@catpaw/agent-sdk/bin/catpaw-cli";
const REPO_CLI = join(dirname(fileURLToPath(import.meta.url)), "bin", "catpaw-cli");
const STANDALONE_CLI = join(homedir(), ".catpaw-dsh", "bin", "catpaw-cli");
const DEFAULT_AUTH = join(homedir(), ".meituan-catpaw", "auth.json");
const DEFAULT_BASE_URL = "https://ai.catpaw.meituan.com";
const DEFAULT_GATEWAY = "https://catx.nocode.cn";
const START_TIMEOUT_MS = 60000;

/**
 * Pick the first CLI that exists: explicit config, `CATPAW_CLI`, the copy
 * bundled in this repository, the standalone copy, then the copy inside 妙手.
 */
function resolveCliPath(configured) {
  const explicit = String(configured ?? "").trim();
  const candidates = [
    ...(explicit ? [explicit] : []),
    ...(process.env.CATPAW_CLI ? [process.env.CATPAW_CLI] : []),
    REPO_CLI,
    STANDALONE_CLI,
    APP_CLI,
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

const DEFAULT_CONTEXT_WINDOW = 1024000;

/**
 * Model catalogue mirrored from 妙手's `POST /api/agent/maas/model-types`
 * (tenant=CatDesk, scene=CATX_APP, env=EXTERNAL). `params` lists the
 * per-model parameters the backend accepts; `defaultEffort` is the
 * reasoning effort 妙手 itself defaults to.
 */
const DEFAULT_MODELS = [
  { id: "10002544", name: "LongCat-2.5", contextWindow: 1024000, maxTokens: 32768, params: ["context", "thinking"] },
  { id: "77", name: "LongCat-2.0", contextWindow: 1024000, maxTokens: 32768, params: ["context", "thinking"] },
  { id: "98", name: "GLM-5.3-FlashX", contextWindow: 1024000, maxTokens: 32768, params: ["context", "effort"] },
  { id: "91", name: "GLM-5.3-Flash", contextWindow: 1024000, maxTokens: 32768, params: ["context", "effort"] },
  { id: "89", name: "GLM-5.3", contextWindow: 1024000, maxTokens: 32768, params: ["context", "effort"] },
  { id: "97", name: "DeepSeek-V4.1-Flash", contextWindow: 1024000, maxTokens: 32768, params: ["context", "thinking", "effort"] },
  { id: "64", name: "DeepSeek-V4-Pro", contextWindow: 1024000, maxTokens: 32768, params: ["context", "thinking", "effort"] },
  { id: "10002518", name: "MiniMax-M3.1-Flash", contextWindow: 1024000, maxTokens: 32768, params: ["context", "effort"], defaultEffort: "low" },
  { id: "70", name: "MiniMax-M3", contextWindow: 1024000, maxTokens: 32768, params: ["context", "thinking"] },
  { id: "10002533", name: "Kimi-K3.1-Pro", contextWindow: 1024000, maxTokens: 32768, params: ["context", "thinking", "effort"] },
  { id: "83", name: "Kimi-K3", contextWindow: 1024000, maxTokens: 32768, params: ["context", "thinking", "effort"] },
  { id: "0", name: "Auto", contextWindow: 1024000, maxTokens: 32768, params: [] },
];

const REASONING_EFFORTS = {
  off: { id: "off", name: "关闭思考", description: "不输出推理过程，响应更快" },
  low: { id: "low", name: "低", description: "精简推理，优先速度" },
  high: { id: "high", name: "中", description: "均衡推理，默认档位" },
  max: { id: "max", name: "高", description: "最大推理强度，适合难题" },
  thinking: { id: "high", name: "深度思考", description: "输出推理过程后再作答" },
};

/**
 * Build the harness `reasoning` metadata from a catalogue entry's `params`.
 * Models that only expose the boolean `thinking` switch advertise Off plus a
 * single Deep-thinking row; models with the `effort` enum advertise the full
 * Low/High/Max ladder (and Off too when they also support `thinking`).
 */
export function reasoningFor(entry) {
  const params = Array.isArray(entry?.params) ? entry.params : [];
  const hasThinking = params.includes("thinking");
  const hasEffort = params.includes("effort");
  if (!hasThinking && !hasEffort) return undefined;
  const efforts = [];
  if (hasThinking) efforts.push(REASONING_EFFORTS.off);
  if (hasEffort) {
    efforts.push(REASONING_EFFORTS.low, REASONING_EFFORTS.high, REASONING_EFFORTS.max);
  } else {
    efforts.push(REASONING_EFFORTS.thinking);
  }
  const fallback = String(entry?.defaultEffort ?? "high");
  const defaultEffort = efforts.some((effort) => effort.id === fallback) ? fallback : efforts[0].id;
  return { efforts, defaultEffort };
}

/** Translate a harness reasoning effort into CatPaw `modelParams`. */
export function modelParamsFor(entry, effort) {
  const params = Array.isArray(entry?.params) ? entry.params : [];
  const selected = String(effort ?? entry?.defaultEffort ?? "high");
  const modelParams = {};
  if (params.includes("context")) {
    const contextWindow = Number(entry?.contextWindow) || DEFAULT_CONTEXT_WINDOW;
    modelParams.context = String(contextWindow);
  }
  if (params.includes("thinking")) modelParams.thinking = { enabled: selected !== "off" };
  if (params.includes("effort")) modelParams.effort = selected === "off" ? "low" : selected;
  return modelParams;
}

/**
 * Tools CatPaw's own agent runtime hands the model. Under `dontAsk` every one of
 * them is denied, and a model that calls one gets a refusal and then narrates it
 * instead of using the marked tool block — the single largest source of "the
 * bridge looks dumb" reports. The CLI config accepts `excludeTools` by exact
 * name (a `*` wildcard is ignored), so the list is spelled out; excluding all of
 * them leaves the model with no tool but ours. Measured 2026-11-04 on
 * catpaw-cli 1.2.0-beta.45.
 */
/** `agent_end` reasons that mean "the run finished normally". */
const AGENT_END_OK = new Set(["completed", "end_turn", "stop"]);

const NATIVE_TOOLS = [
  "bash",
  "read_file",
  "write",
  "edit",
  "grep",
  "glob_file_search",
  "list_dir",
  "multi_edit",
  "string_replace",
  "delete_file",
  "read_lints",
  "fetch_rules",
  "web_fetch",
  "web_search",
  "todo_write",
  "get_goal",
  "create_goal",
  "update_goal",
  "task_stop",
];

const PERMISSION_MODES = new Set([
  "dontAsk",
  "acceptEdits",
  "default",
  "plan",
  "bypassPermissions",
  "unsafeBypassPermissions",
]);

const SYSTEM_PROMPT_MODES = new Set(["none", "transcript"]);

const DEFAULT_MAX_PROMPT_CHARS = 120000;
const DEFAULT_TOOL_RESULT_CHARS = 4000;
const DEFAULT_MESSAGE_CHARS = 20000;

export const name = "dsh-catpaw";
export const inject = ["llm", "tools"];

function debugLog(enabled, ...args) {
  if (enabled) console.error("[dsh-catpaw]", ...args);
}

function readValue(value, fallback) {
  if (value && typeof value.get === "function") {
    try {
      value = value.get();
    } catch {
      value = undefined;
    }
  }
  return value === undefined || value === null ? fallback : value;
}

/**
 * `excludeNativeTools`: `true` (default) hides CatPaw's built-in tools, an array
 * hides exactly those names, `false` leaves them visible.
 */
function readExclusions(value) {
  if (value === false) return [];
  if (Array.isArray(value)) return value.filter((name) => typeof name === "string" && name.length > 0);
  return NATIVE_TOOLS;
}

export function readSettings(config) {
  const rawModels = readValue(config?.models, DEFAULT_MODELS);
  const models = Array.isArray(rawModels) && rawModels.length > 0 ? rawModels : DEFAULT_MODELS;
  const permission = readValue(config?.permissionMode, "dontAsk");
  const systemPrompt = readValue(config?.systemPrompt, "transcript");
  return {
    cliPath: resolveCliPath(readValue(config?.cliPath, "")),
    authPath: String(readValue(config?.authPath, DEFAULT_AUTH)),
    baseURL: String(readValue(config?.baseURL, DEFAULT_BASE_URL)),
    gateway: String(readValue(config?.gateway, DEFAULT_GATEWAY)),
    permissionMode: PERMISSION_MODES.has(permission) ? permission : "dontAsk",
    excludeNativeTools: readExclusions(readValue(config?.excludeNativeTools, true)),
    systemPrompt: SYSTEM_PROMPT_MODES.has(systemPrompt) ? systemPrompt : "transcript",
    models,
    timeoutMs: Number(readValue(config?.timeoutMs, 600000)) || 600000,
    idleTimeoutMs: Number(readValue(config?.idleTimeoutMs, 300000)) || 300000,
    maxPromptChars: Number(readValue(config?.maxPromptChars, DEFAULT_MAX_PROMPT_CHARS)) || DEFAULT_MAX_PROMPT_CHARS,
    toolResultChars: Number(readValue(config?.toolResultChars, DEFAULT_TOOL_RESULT_CHARS)) || DEFAULT_TOOL_RESULT_CHARS,
    messageChars: Number(readValue(config?.messageChars, DEFAULT_MESSAGE_CHARS)) || DEFAULT_MESSAGE_CHARS,
    directory: String(readValue(config?.directory, "") || ""),
    debug: Boolean(readValue(config?.debug, false)),
  };
}

function readAuth(authPath, { required = true } = {}) {
  if (!existsSync(authPath)) {
    if (!required) return null;
    throw new Error(
      `找不到妙手登录态：${authPath}。调用 catpaw_login 工具扫码登录，或先打开并登录妙手。`,
    );
  }
  let data;
  try {
    data = JSON.parse(readFileSync(authPath, "utf8"));
  } catch (error) {
    if (!required) return null;
    throw new Error(`妙手登录态无法解析：${authPath}（${error.message}）。调用 catpaw_login 重新登录。`);
  }
  const token = data?.auth?.accessToken;
  if (typeof token !== "string" || token.length === 0) {
    if (!required) return null;
    throw new Error(`妙手登录态里没有 accessToken：${authPath}。调用 catpaw_login 重新登录。`);
  }
  return {
    token,
    updatedAt: Number(data.updatedAt) || 0,
    account: data.account ?? {},
    loginType: data.auth?.loginType ?? "passport",
  };
}

/** Everything the spawned CLI caches from its environment, in comparable form. */
function launchSignature(settings, token) {
  return JSON.stringify([
    settings.baseURL,
    settings.cliPath,
    token,
    settings.excludeNativeTools,
  ]);
}

/**
 * Owns one `catpaw-cli server` child process.
 *
 * The CLI defaults its cloud endpoint to an address that is unreachable from a
 * normal network, and it reads no harness settings. We therefore pass the same
 * per-launch config the desktop app injects: the reachable endpoint plus the
 * passport token from `~/.meituan-catpaw/auth.json`.
 */
class CatPawServer {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.url = null;
    this.proc = null;
    this.ready = null;
    this.token = null;
    this.signature = "";
    // Calls currently streaming through this process. A config change must not
    // kill one of them; it is applied between calls instead.
    this.inflight = 0;
    this.restartPending = false;
  }

  begin() {
    this.inflight += 1;
  }

  end() {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  async ensure() {
    if (this.url) return this.url;
    if (!this.ready) {
      this.ready = this.start().catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  async start() {
    const settings = this.getSettings();
    if (!settings.cliPath) {
      throw new Error(
        `找不到 catpaw-cli。它应该在 ${REPO_CLI}，或拷到 ${STANDALONE_CLI}（妙手自带：${APP_CLI}），或用 CATPAW_CLI 环境变量 / 配置项 cliPath 指定路径。`,
      );
    }
    const auth = readAuth(settings.authPath);
    const token = auth.token;
    this.token = token;
    this.signature = launchSignature(settings, token);
    const config = {
      baseURL: settings.baseURL,
      cookie: `X-Passport-Token=${token}`,
      authTokens: { "x-passport-token": token },
      source: "CatX",
      mode: "CATX_APP",
      // Leave the model with exactly one way to act: the marked tool block.
      ...(settings.excludeNativeTools.length > 0 ? { excludeTools: settings.excludeNativeTools } : {}),
    };
    try {
      return await this.spawnServer(settings, config);
    } catch (error) {
      // A checkout or a tarball can lose the executable bit, and some installers
      // do not restore it. The file is ours to fix, so fix it and try once more
      // instead of failing the first call a user ever makes.
      if (error?.code !== "EACCES") throw error;
      try {
        chmodSync(settings.cliPath, 0o755);
      } catch {
        throw error;
      }
      debugLog(settings.debug, "chmod +x applied to", settings.cliPath);
      return await this.spawnServer(settings, config);
    }
  }

  async spawnServer(settings, config) {
    debugLog(settings.debug, "starting", settings.cliPath);
    const proc = spawn(settings.cliPath, ["server", "--host", "127.0.0.1"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CATPAW_CONFIG_CONTENT: JSON.stringify(config) },
    });
    this.proc = proc;

    return await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => fail(new Error(`catpaw-cli server 在 ${START_TIMEOUT_MS / 1000} 秒内没有启动`)),
        START_TIMEOUT_MS,
      );
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.url = null;
        this.proc = null;
        try {
          proc.kill();
        } catch {}
        reject(error);
      };
      const onData = (buf) => {
        const text = String(buf);
        debugLog(settings.debug, text.trim());
        if (settled) return;
        const match = text.match(/https?:\/\/127\.0\.0\.1:(\d+)/);
        if (!match) return;
        settled = true;
        clearTimeout(timer);
        this.url = `http://127.0.0.1:${match[1]}`;
        resolve(this.url);
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", (buf) => debugLog(settings.debug, String(buf).trim()));
      proc.on("error", (error) => {
        fail(
          error?.code === "EACCES"
            ? Object.assign(new Error(`catpaw-cli 没有执行权限：${settings.cliPath}（运行 chmod +x 修好）`), {
                code: "EACCES",
              })
            : error,
        );
      });
      proc.on("exit", (code, signal) => {
        this.url = null;
        this.proc = null;
        this.ready = null;
        if (!settled) fail(new Error(`catpaw-cli server 退出（code=${code}，signal=${signal}）`));
      });
    });
  }

  /**
   * The CLI only reads its config at spawn: a fresh QR login rewrites auth.json,
   * and the plugin row's `baseURL` / `excludeNativeTools` can change on a config
   * reload. Restart the server when any of them moved, so the next call uses the
   * new values without restarting DSH.
   */
  async refreshIfStale() {
    const settings = this.getSettings();
    const auth = readAuth(settings.authPath, { required: false });
    if (!auth || !this.token) return;
    const signature = launchSignature(settings, auth.token);
    if (signature === this.signature) return;
    if (this.inflight > 0) {
      debugLog(settings.debug, "launch config changed; restarting once the current calls finish");
      this.restartPending = true;
      return;
    }
    debugLog(settings.debug, "catpaw-cli launch config changed, restarting server");
    this.restartPending = false;
    await this.stop();
  }

  async request(method, params, { stream = false, signal } = {}) {
    if (this.restartPending && this.inflight === 0) {
      this.restartPending = false;
      await this.stop();
    }
    await this.refreshIfStale();
    const base = await this.ensure();
    const body = { jsonrpc: "2.0", method, params, id: randomUUID() };
    if (stream) body.stream = true;
    return fetch(`${base}/api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  async stop() {
    const proc = this.proc;
    this.proc = null;
    this.url = null;
    this.ready = null;
    this.token = null;
    if (!proc || proc.killed) return;
    try {
      proc.kill();
    } catch {}
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export function clipText(text, max) {
  if (typeof text !== "string") return "";
  if (max <= 0 || text.length <= max) return text;
  // Keep both ends: a file listing or a diff loses its point when only the head
  // survives, and the tail is usually where the answer is.
  const tail = Math.min(800, Math.floor(max * 0.3));
  const note = (dropped) => `\n…（中间省略 ${dropped} 字符，原文 ${text.length} 字符）…\n`;
  const head = Math.max(0, max - tail - note(text.length).length);
  return text.slice(0, head) + note(text.length - head - tail) + text.slice(-tail);
}

/**
 * CatPaw's own agent runtime ships tools that collide with ours by name
 * (`bash`, `grep`, `write`, `web_fetch`, …) and it keeps them in the model's
 * native tool list, where a name in a prompt reads as "call that tool". Prefix
 * every harness tool so the model can only see one `bash`: `dsh_bash`, which
 * exists nowhere except in the marker block. The prefix is stripped when the
 * call is turned back into a real harness tool call.
 */
const TOOL_ALIAS_PREFIX = "dsh_";
const aliasTool = (name) => `${TOOL_ALIAS_PREFIX}${name}`;

/** Compact one JSON Schema into `name:type[enum]*` pairs so 100+ tools fit. */
function compactSchema(schema) {
  const properties = schema?.properties ?? {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const parts = [];
  for (const [key, value] of Object.entries(properties)) {
    const type = value?.type ?? (value?.enum ? "enum" : value?.oneOf ? "oneof" : "any");
    const values = Array.isArray(value?.enum) ? `[${value.enum.slice(0, 6).join("|")}]` : "";
    const optional = required.has(key) ? "" : "?";
    parts.push(`${key}${optional}:${type}${values}`);
  }
  return `{${parts.join(",")}}`;
}

/** Render the tool catalogue and the call protocol the model must follow. */
export function renderToolSection(tools) {
  const example = tools.find((tool) => tool && typeof tool.name === "string");
  const exampleName = example?.name ? aliasTool(example.name) : aliasTool("bash");
  const exampleArgs = example?.name === "bash" ? '{"command":"ls"}' : "{}";
  const lines = [
    "<tools>",
    "本会话提供下列工具，由宿主程序负责执行。",
    "",
    "重要：CatPaw 自带的工具（bash、read_file、write、grep、glob_file_search、"
      + "list_dir、web_fetch 等）在本会话中全部被禁用。调用它们只会收到一条拒绝消息、"
      + "浪费一轮，而且不会产生任何效果。唯一的动作出口是下面的标记块。",
    "宿主工具在 <tools> 里带 dsh_ 前缀呈现：需要 bash 就写 dsh_bash，需要读文件就写 dsh_read。",
    "不要输出任何 XML 形式的工具标签（<longcat_tool_call>、<｜｜DSML｜｜ …>、<tool_call> 之类），只认上面这一种标记块。",
    "",
    `需要做事时，输出一个标记块：以 ${TOOL_CALL_OPEN} 开头，接一个 JSON 数组，以 ${TOOL_CALL_CLOSE} 结尾。`,
    '数组元素形如 {"name":"工具名","arguments":{...}}，arguments 需符合该工具的参数 schema。',
    "一次可以列出多个调用，按执行顺序排列；结果会作为工具结果返回，然后继续。",
    "不需要工具时直接回答，不要输出标记块。",
    "决定使用工具时，就在同一条回复里直接输出标记块；不要只说“我来调用”“我将读取”这类计划。",
    "工具结果的 <tool_result error=\"true\"> 表示参数错了或执行失败：直接改正参数重试，不要反问用户要不要重试。",
    "",
    "一次要做多件事时，把多个对象放进同一个数组，一条消息给全。",
    "示例（要执行 ls 时，输出且只输出这一块）：",
    TOOL_CALL_OPEN,
    `[{"name":"${exampleName}","arguments":${exampleArgs}}]`,
    TOOL_CALL_CLOSE,
    "",
    "可用工具（参数名后带 ? 的是可选参数）：",
  ];
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string") continue;
    const description = String(tool.description ?? "").replace(/\s+/g, " ").slice(0, 180);
    lines.push(`- ${aliasTool(tool.name)}: ${description}`);
    lines.push(`  参数: ${compactSchema(tool.parameters)}`);
  }
  lines.push("</tools>");
  return lines.join("\n");
}

/**
 * LongCat writes its own tool-call XML when it has no native tool to call:
 *
 *   <longcat_tool_call>bash
 *   <longcat_arg_key>command</longcat_arg_key>
 *   <longcat_arg_value>ls -la</longcat_arg_value>
 *   </longcat_tool_call>
 *
 * One message can carry several blocks. Parsed rather than shown to the user.
 */
export function parseLongcatCalls(text, aliases = new Map()) {
  const calls = [];
  const blocks = String(text ?? "").match(/<longcat_tool_call>([\s\S]*?)<\/longcat_tool_call>/g) ?? [];
  for (const block of blocks) {
    const inner = block.slice(LONGCAT_OPEN.length, block.length - LONGCAT_CLOSE.length);
    const named = inner.match(/<longcat_tool_name>([\s\S]*?)<\/longcat_tool_name>/);
    let name = (named ? named[1] : (inner.match(/^\s*([A-Za-z0-9_.:$-]+)/)?.[1] ?? "")).trim();
    if (name.length === 0) continue;
    const args = {};
    const pairs = inner.matchAll(
      /<longcat_arg_key>([\s\S]*?)<\/longcat_arg_key>\s*<longcat_arg_value>([\s\S]*?)<\/longcat_arg_value>/g,
    );
    for (const pair of pairs) args[pair[1].trim()] = pair[2].trim();
    if (name.startsWith(TOOL_ALIAS_PREFIX) && aliases.has(name)) name = aliases.get(name);
    calls.push({ name, arguments: args });
  }
  return calls;
}

/**
 * DeepSeek writes its own markup when it has no native tool to call:
 *
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="dsh_bash">
 *   <｜｜DSML｜｜ parameter name="command" string="true">cat /tmp/x</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 *
 * The full-width bars are part of the tag, not decoration.
 */
const DSML_OPEN_INVOKE = "<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke ";
const DSML_CLOSE_INVOKE = "</\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>";
const DSML_OPEN_PARAM = "<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter ";
const DSML_CLOSE_PARAM = "</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>";

export function parseDsmlCalls(text, aliases = new Map()) {
  const source = String(text ?? "");
  const calls = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(DSML_OPEN_INVOKE, from);
    if (start < 0) break;
    const end = source.indexOf(DSML_CLOSE_INVOKE, start);
    if (end < 0) break;
    const block = source.slice(start, end);
    from = end + DSML_CLOSE_INVOKE.length;
    let name = (block.match(/name\s*=\s*["']([^"']+)["']/)?.[1] ?? "").trim();
    if (name.length === 0) continue;
    if (name.startsWith(TOOL_ALIAS_PREFIX) && aliases.has(name)) name = aliases.get(name);
    const args = {};
    let pFrom = 0;
    for (;;) {
      const pStart = block.indexOf(DSML_OPEN_PARAM, pFrom);
      if (pStart < 0) break;
      const pEnd = block.indexOf(DSML_CLOSE_PARAM, pStart);
      if (pEnd < 0) break;
      const head = block.slice(pStart, block.indexOf(">", pStart) + 1);
      const key = head.match(/name\s*=\s*["']([^"']+)["']/)?.[1] ?? "";
      const value = block.slice(block.indexOf(">", pStart) + 1, pEnd);
      if (key) args[key.trim()] = value.trim();
      pFrom = pEnd + DSML_CLOSE_PARAM.length;
    }
    calls.push({ name, arguments: args });
  }
  return calls;
}

/** Pull `{name, arguments}` entries out of whatever the model wrapped them in. */
export function parseToolCalls(payload, aliases = new Map()) {
  let body = String(payload ?? "").trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  const start = body.search(/[[{]/);
  if (start < 0) return [];
  body = body.slice(start);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A cut-off payload is common when the model runs into its output limit:
    // keep the calls that arrived complete instead of dropping the whole block.
    const cut = Math.max(body.lastIndexOf("]"), body.lastIndexOf("}"));
    if (cut < 0) return [];
    const head = body.slice(0, cut + 1);
    parsed = undefined;
    for (const tail of ["", "]", "}]", "}"]) {
      try {
        parsed = JSON.parse(head + tail);
        break;
      } catch {}
    }
    if (parsed === undefined) return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const calls = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    let name = item.name ?? item.tool ?? item.toolName;
    if (typeof name !== "string" || name.length === 0) continue;
    if (name.startsWith(TOOL_ALIAS_PREFIX) && aliases.has(name)) name = aliases.get(name);
    let args = item.arguments ?? item.args ?? item.parameters ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    calls.push({ name, arguments: args && typeof args === "object" ? args : {} });
  }
  return calls;
}

export function renderBlocks(content, limits) {
  const parts = [];
  for (const block of content ?? []) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        if (block.text) parts.push(clipText(block.text, limits.messageChars));
        break;
      case "reasoning":
        if (block.text) parts.push(`<reasoning>\n${clipText(block.text, limits.messageChars)}\n</reasoning>`);
        break;
      case "image":
        parts.push(`[image: ${block.attachment?.name ?? block.attachment?.attachmentId ?? "image"}]`);
        break;
      case "file":
        parts.push(`[file: ${block.attachment?.name ?? "file"}]`);
        break;
      case "tool-call": {
        // `arguments` is a JSON string in this adapter's own blocks, but a
        // history imported from another provider can hold the parsed object;
        // String({}) would render "[object Object]" and lose the call.
        const raw = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {});
        const args = clipText(raw, Math.min(limits.messageChars, 2000));
        // Same names the <tools> section advertises, so the model's own history
        // does not contradict the protocol it is being asked to follow.
        parts.push(`[tool call: ${block.name ? aliasTool(String(block.name)) : "?"} ${args}]`);
        break;
      }
      case "tool-addition":
        parts.push(`[tool available: ${block.toolName}]`);
        break;
      case "tool-removal":
        parts.push(`[tool removed: ${block.toolName}]`);
        break;
      default:
        break;
    }
  }
  return parts.join("\n");
}

export function renderMessage(message, limits) {
  if (!message || typeof message !== "object") return "";
  const content = renderBlocks(message.content, limits);
  if (message.role === "tool") {
    const call = message.toolCallId ? ` call_id="${message.toolCallId}"` : "";
    const error = message.isError ? ' error="true"' : "";
    return `<tool_result${call}${error}>\n${clipText(content, limits.toolResultChars)}\n</tool_result>`;
  }
  if (!content) return "";
  return `<${message.role}>\n${clipText(content, limits.messageChars)}\n</${message.role}>`;
}

export function renderPrompt(options, settings) {
  const limits = { messageChars: settings.messageChars, toolResultChars: settings.toolResultChars };
  const budget = Math.max(2000, settings.maxPromptChars);
  const tools = Array.isArray(options.tools) ? options.tools.filter((tool) => tool && typeof tool.name === "string") : [];

  // Recency matters: restate the contract after the transcript so the model
  // does not fall back to its own built-in tools when the task needs action.
  // It is built first because it has to be paid for out of the same budget.
  const reminder =
    tools.length > 0
      ? [
          "",
          "<tool_protocol>",
          `工具调用格式：${TOOL_CALL_OPEN}`,
          '[{"name":"工具名","arguments":{...}}]',
          TOOL_CALL_CLOSE,
          "标记块之外的文本会作为普通回答展示给用户。",
          `工具名以上面的 <tools> 列表为准（都带 ${TOOL_ALIAS_PREFIX} 前缀）。`,
          "CatPaw 自带的 bash / read_file / write / grep 等工具在此会话被禁用，"
            + "调用它们只会失败并浪费一轮；所有动作都必须通过上面的标记块表达。",
          "</tool_protocol>",
        ].join("\n")
      : "";
  const reserved = reminder ? reminder.length + 2 : 0;
  const available = Math.max(0, budget - reserved);

  // Every part is a share of what is left for it, so a small budget cannot be
  // blown by a long system prompt or a large tool catalogue.
  const system =
    options.system && settings.systemPrompt === "transcript"
      ? `<system>\n${clipText(String(options.system).trim(), Math.min(settings.messageChars, 40000, Math.floor(available * 0.35)))}</system>`
      : "";
  const toolSection =
    tools.length > 0 ? clipText(renderToolSection(tools), Math.max(600, Math.floor(available * 0.45))) : "";
  const prefix = [system, toolSection].filter(Boolean).join("\n\n");

  const rendered = [];
  for (const message of options.messages ?? []) {
    const piece = renderMessage(message, limits);
    if (piece) rendered.push(piece);
  }
  let used = prefix ? prefix.length + 2 : 0;
  const kept = [];
  let dropped = 0;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const piece = rendered[index];
    if (kept.length > 0 && used + piece.length + 2 > available) {
      dropped = index + 1;
      break;
    }
    kept.unshift(piece);
    used += piece.length + 2;
  }
  let body = kept.join("\n\n");
  // Say so rather than letting the model believe the conversation started here.
  if (dropped > 0) {
    body = `<omitted messages="${dropped}">更早的 ${dropped} 条消息因长度上限被省略。</omitted>\n\n${body}`;
  }
  if (prefix.length + body.length > available) {
    const room = available - prefix.length - 2;
    // `clipText(text, 0)` returns the text untouched, which is the opposite of
    // what a budget is for: drop it instead of exceeding the limit.
    body = room > 80 ? clipText(body, room) : "";
  }
  return [prefix, body, reminder].filter(Boolean).join("\n\n") || "（空对话）";
}

/**
 * Failure codes the harness's retry policy understands. Anything else is
 * treated as permanent, which is what an auth or protocol error is.
 */
export const FAILURE_CODES = {
  timeout: "TIMEOUT",
  transport: "TRANSPORT",
  rateLimit: "RATE_LIMIT",
  server: "SERVER",
  empty: "EMPTY_RESPONSE",
  permanent: "CATPAW_ERROR",
};

const KNOWN_FAILURE_CODES = new Set(Object.values(FAILURE_CODES));

export function errorFinish(error, code = FAILURE_CODES.permanent) {
  return {
    type: "finish",
    reason: {
      kind: "error",
      failure: {
        message: error?.message ? String(error.message) : String(error),
        // Node errors carry their own `code` (EACCES, ECONNREFUSED); only a
        // value the retry policy knows about may override the caller's code.
        code: typeof error?.code === "string" && KNOWN_FAILURE_CODES.has(error.code) ? error.code : code,
      },
    },
  };
}

/** An Error carrying the failure code its finish should report. */
export function failure(message, code) {
  return Object.assign(new Error(message), { code });
}

class CatPawAdapter {
  constructor(ctx, getSettings, server) {
    this.ctx = ctx;
    this.getSettings = getSettings;
    this.server = server;
  }

  providerInfo(provider) {
    return { id: provider, name: "CatPaw (妙手)" };
  }

  providerRetryPolicy() {
    return {
      mode: "normal",
      // A stalled backend or a 429 is worth another go; two attempts keep the
      // worst case inside a coffee break instead of the harness default of five.
      maxRetries: 2,
      retryableCodes: [
        FAILURE_CODES.timeout,
        FAILURE_CODES.rateLimit,
        FAILURE_CODES.server,
        FAILURE_CODES.transport,
        FAILURE_CODES.empty,
      ],
      backoff: { initialDelayMs: 800, maxDelayMs: 8000, jitterRatio: 0.2 },
    };
  }

  imageRequestPricing() {
    return undefined;
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes };
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    };
  }

  async listModels(provider) {
    const settings = this.getSettings();
    return settings.models.map((model) => ({
      provider,
      id: String(model.id),
      name: String(model.name ?? `CatPaw ${model.id}`),
      ...(model.description ? { description: String(model.description) } : {}),
      inputModalities: ["text"],
    }));
  }

  async resolveModel(provider, model) {
    const settings = this.getSettings();
    const entry = settings.models.find((candidate) => String(candidate.id) === model);
    const reasoning = reasoningFor(entry);
    return {
      provider,
      id: model,
      name: String(entry?.name ?? `CatPaw ${model}`),
      ...(entry?.description ? { description: String(entry.description) } : {}),
      inputModalities: ["text"],
      context: { contextWindow: Number(entry?.contextWindow) || DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: Number(entry?.maxTokens) || 32768,
      ...(reasoning ? { reasoning } : {}),
    };
  }

  resolveDirectory(options, settings) {
    if (settings.directory) return settings.directory;
    let sessions;
    let workingDirectory;
    try {
      sessions = this.ctx.get("sessions");
    } catch {}
    try {
      workingDirectory = this.ctx.get("workingDirectory");
    } catch {}
    if (options.sessionId && sessions) {
      try {
        const session = sessions.get(options.sessionId);
        if (session) {
          if (workingDirectory) {
            try {
              // A lookup that answers with nothing is not an answer: fall through
              // to the session's own header instead of handing `undefined` to
              // the CLI, which silently runs in its own cwd.
              const resolved = workingDirectory.get(session);
              if (typeof resolved === "string" && resolved.length > 0) return resolved;
            } catch {}
          }
          if (session.header?.cwd) return session.header.cwd;
        }
      } catch {}
    }
    return workingDirectory?.defaultDirectory ?? process.cwd();
  }

  async *stream(options) {
    const settings = this.getSettings();
    const model = String(options.model ?? "");
    const modelValue = /^\d+$/.test(model) ? Number(model) : model;
    const prompt = renderPrompt(options, settings);
    const aliases = new Map();
    for (const tool of Array.isArray(options.tools) ? options.tools : []) {
      if (tool && typeof tool.name === "string" && tool.name.length > 0) {
        aliases.set(aliasTool(tool.name), tool.name);
      }
    }
    debugLog(settings.debug, `prompt ${prompt.length} chars, ${(options.tools ?? []).length} tools, model ${model}`);
    const directory = this.resolveDirectory(options, settings);
    const entry = settings.models.find((candidate) => String(candidate.id) === model);
    const modelParams = modelParamsFor(entry, options.reasoningEffort);
    const hasModelParams = Object.keys(modelParams).length > 0;

    // One small record of the last finished call, so `catpaw_doctor` can answer
    // "was it slow? did it fail?" without the user digging through logs.
    const startedAt = Date.now();
    const record = (outcome, detail = "") => {
      this.server.lastCall = { at: startedAt, model, ms: Date.now() - startedAt, outcome, detail };
    };
    const finishError = function* (error, code) {
      record("error", error?.message ? String(error.message) : String(error));
      yield errorFinish(error, code);
    };

    const abort = new AbortController();
    // CatPaw keeps running server-side after we drop the SSE stream, so a stop
    // has to reach the CLI too — otherwise the turn keeps burning quota in the
    // background. The id arrives on the first frame that carries it.
    let conversationId = null;
    let stopped = false;
    const stopBackend = () => {
      if (stopped || !conversationId) return;
      stopped = true;
      void this.server.request("agent.stop", { conversationId }).catch(() => {});
    };
    const relay = () => {
      abort.abort(options.signal?.reason ?? new Error("aborted"));
      stopBackend();
    };
    if (options.signal?.aborted) relay();
    else options.signal?.addEventListener("abort", relay, { once: true });

    let idleTimer;
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abort.abort(failure("CatPaw 响应空闲超时", FAILURE_CODES.timeout));
        stopBackend();
      }, settings.idleTimeoutMs);
    };
    const totalTimer = setTimeout(() => {
      abort.abort(failure("CatPaw 响应总超时", FAILURE_CODES.timeout));
      stopBackend();
    }, settings.timeoutMs);
    touch();

    let released = false;
    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      options.signal?.removeEventListener("abort", relay);
      if (!released) {
        released = true;
        this.server.end();
      }
    };

    let response;
    this.server.begin();
    try {
      response = await this.server.request(
        "agent.start",
        {
          content: [{ type: "text", text: prompt }],
          directory,
          permissionMode: settings.permissionMode,
          config: { model: modelValue },
          ...(hasModelParams ? { dynamicContext: { requestContext: { modelParams } } } : {}),
        },
        { stream: true, signal: abort.signal },
      );
    } catch (error) {
      cleanup();
      if (options.signal?.aborted) return;
      // A refusal to connect is worth another attempt; a bad response is not.
      const code = error?.code === FAILURE_CODES.timeout ? FAILURE_CODES.timeout : FAILURE_CODES.transport;
      yield* finishError(error, code);
      return;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      cleanup();
      const auth = response.status === 401 || response.status === 403 ? "（登录态可能已失效，运行 catpaw_login 重新扫码）" : "";
      const code =
        response.status === 429
          ? FAILURE_CODES.rateLimit
          : response.status >= 500
            ? FAILURE_CODES.server
            : FAILURE_CODES.permanent;
      yield* finishError(
        new Error(`CatPaw HTTP ${response.status}${auth}${detail ? `: ${detail.slice(0, 300)}` : ""}`),
        code,
      );
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let nextIndex = 0;
    // `model_chunk.content` arrives as a delta (1-4 characters per frame on this
    // CLI); TextChannel also accepts cumulative snapshots, because the two
    // shapes are indistinguishable per frame and other builds stream snapshots.
    const reasoningChannel = new TextChannel();
    const textChannel = new TextChannel();
    const gate = new MarkerGate(textChannel);
    const blocks = { reasoning: null, text: null };
    const shown = { reasoning: "", text: "" };
    let errorMessage = null;
    // The object, not just its text: it carries the failure code the harness's
    // retry policy reads, and rebuilding an Error from the message lost it.
    let errorCause = null;
    let agentEndReason = null;
    let sawAgentEnd = false;

    const publish = function* (kind, piece) {
      if (!piece) return;
      if (!blocks[kind]) {
        blocks[kind] = { index: nextIndex++ };
        yield { type: "block-start", index: blocks[kind].index, blockType: kind };
      }
      shown[kind] += piece;
      yield { type: kind === "text" ? "text-delta" : "reasoning-delta", index: blocks[kind].index, text: piece };
    };

    // One CatPaw run can contain several turns (its own tool loop, denied or
    // not), and `model_end` reports only the CURRENT turn's message. Each turn
    // is measured against what the channel already holds since the turn began —
    // not against what has been published, because the marker hold-back keeps a
    // tail unpublished and comparing with it re-appended that tail.
    let textMark = 0;
    let reasoningMark = 0;

    const feedReasoning = function* (part) {
      const added = reasoningChannel.push(part);
      if (added) yield* publish("reasoning", added);
    };

    const feedText = function* (part) {
      const piece = gate.push(part);
      if (piece) yield* publish("text", piece);
    };

    /**
     * `model_end` is authoritative for the turn it closes: publish only the
     * part this turn's deltas did not already deliver. A message that is not an
     * extension of the turn's text is ignored rather than appended, because
     * appending it would print the turn twice.
     */
    const settle = function* (channel, mark, message, feed) {
      if (typeof message !== "string" || message.length === 0) return;
      const current = channel.text.slice(mark);
      if (current.length > 0 && !message.startsWith(current)) return;
      const missing = message.slice(current.length);
      if (missing) yield* feed(missing);
    };

    const settleText = function* (message) {
      yield* settle(textChannel, textMark, message, feedText);
    };

    const settleReasoning = function* (message) {
      yield* settle(reasoningChannel, reasoningMark, message, feedReasoning);
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Deliberately not `touch()` here: the CLI emits keep-alive frames while
        // the backend is stalled, and counting those as progress is how a hung
        // run sits for the whole 10-minute budget instead of the idle timeout.
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const json = trimmed.slice(5).trim();
          if (!json) continue;
          let frame;
          try {
            frame = JSON.parse(json);
          } catch {
            continue;
          }
          const event =
            frame && typeof frame === "object" && frame.event && typeof frame.event === "object"
              ? frame.event
              : frame;
          const data =
            event && typeof event === "object" && event.data && typeof event.data === "object" && !Array.isArray(event.data)
              ? event.data
              : event;
          if (typeof data?.conversationId === "string" && data.conversationId.length > 0) {
            conversationId = data.conversationId;
          }
          const type = event?.type;
          if (type === "model_chunk" || type === "model_end" || type === "turn_end" || type === "agent_end" ||
              type === "agent_error" || type === "interaction_pending") {
            touch();
          }
          if (!type) {
            const result = frame?.result;
            if (result && result.status === "error") {
              errorMessage = String(result.error ?? "CatPaw 请求失败");
            } else if (result && result.status === "interaction_pending") {
              errorMessage = "妙手停在一个工具权限确认上。";
            }
            continue;
          }
          switch (type) {
            case "model_chunk": {
              yield* feedReasoning(typeof data.reasoningContent === "string" ? data.reasoningContent : "");
              yield* feedText(typeof data.content === "string" ? data.content : "");
              break;
            }
            case "model_end": {
              const message = data.message;
              if (message && Array.isArray(message.content)) {
                for (const block of message.content) {
                  if (!block || typeof block !== "object") continue;
                  // `model_end` carries the authoritative message; feeding it
                  // through the same channel publishes only what the stream had
                  // not delivered yet (normally the held-back tail).
                  if (block.type === "text") {
                    yield* settleReasoning(
                      typeof block.reasoningContent === "string" ? block.reasoningContent : "",
                    );
                    yield* settleText(typeof block.text === "string" ? block.text : "");
                  } else if (block.type === "reasoning") {
                    yield* settleReasoning(typeof block.text === "string" ? block.text : "");
                  }
                }
              }
              break;
            }
            case "turn_end": {
              textMark = textChannel.text.length;
              reasoningMark = reasoningChannel.text.length;
              break;
            }
            case "agent_end": {
              sawAgentEnd = true;
              agentEndReason = data.reason ?? "completed";
              break;
            }
            case "agent_error": {
              const raw =
                typeof data.error === "string" ? data.error : (data.error?.message ?? "CatPaw agent 报错");
              errorMessage = /unauthor|forbidden|token|401|403/i.test(raw)
                ? `${raw}（登录态可能已失效，运行 catpaw_login 重新扫码）`
                : raw;
              break;
            }
            case "interaction_pending": {
              errorMessage = "妙手停在一个工具权限确认上，而 DSH 桥接没有权限界面。";
              break;
            }
            default:
              break;
          }
        }
      }
    } catch (error) {
      if (!options.signal?.aborted) {
        errorCause = errorCause ?? error;
        errorMessage = errorMessage ?? (error?.message ?? String(error));
      }
    } finally {
      cleanup();
      try {
        await reader.cancel();
      } catch {}
    }

    // Publish whatever the hold-back window kept out of the stream.
    yield* publish("text", gate.flush());

    let toolCalls = [];
    const payload = gate.payload();
    if (gate.mode === "tool" && payload.open === DSML_OPEN) {
      const remainder = DSML_OPEN + gate.remainder();
      toolCalls = parseDsmlCalls(remainder, aliases);
      if (toolCalls.length === 0) {
        const fallback = remainder.replace(/<\/?\uFF5C\uFF5CDSML\uFF5C\uFF5C[^>]*>/g, "").trim();
        if (fallback) yield* publish("text", fallback);
      }
    } else if (gate.mode === "tool" && payload.open === LONGCAT_OPEN) {
      // LongCat's own format: several blocks may follow the first, so the parser
      // sees everything after the opening tag rather than one block.
      const remainder = LONGCAT_OPEN + gate.remainder();
      toolCalls = parseLongcatCalls(remainder, aliases);
      if (toolCalls.length === 0) {
        const fallback = remainder.replace(/<\/?longcat_[^>]*>/g, "").trim();
        if (fallback) yield* publish("text", fallback);
      }
    } else if (gate.mode === "tool") {
      toolCalls = parseToolCalls(payload.body, aliases);
      if (toolCalls.length === 0) {
        const fallback = payload.body.trim();
        if (fallback) yield* publish("text", fallback);
      }
    }

    for (const kind of ["reasoning", "text"]) {
      if (!blocks[kind]) continue;
      yield {
        type: "block-end",
        index: blocks[kind].index,
        block: kind === "text" ? { type: "text", text: shown.text } : { type: "reasoning", text: shown.reasoning },
      };
    }

    for (const call of toolCalls) {
      const id = `catpaw-call-${randomUUID()}`;
      const args = JSON.stringify(call.arguments ?? {});
      const index = nextIndex++;
      yield { type: "block-start", index, blockType: "tool-call" };
      yield { type: "tool-call-delta", index, id, name: call.name, argumentsDelta: args };
      yield { type: "block-end", index, block: { type: "tool-call", id, name: call.name, arguments: args } };
    }

    // Prose the model wrote after the closing marker used to be dropped. It is
    // kept, as its own block, so the order matches what the model produced.
    if (toolCalls.length > 0 && payload.trailing) {
      const index = nextIndex++;
      yield { type: "block-start", index, blockType: "text" };
      yield { type: "text-delta", index, text: payload.trailing };
      yield { type: "block-end", index, block: { type: "text", text: payload.trailing } };
    }

    if (options.signal?.aborted) return;
    if (errorCause) {
      yield* finishError(errorCause);
      return;
    }
    if (errorMessage) {
      yield* finishError(new Error(errorMessage));
      return;
    }
    if (sawAgentEnd && agentEndReason === "interaction_pending") {
      yield* finishError(
        new Error("妙手停在一个工具权限确认上，而 DSH 桥接没有权限界面。请把 permissionMode 改成 dontAsk 或 bypassPermissions。"),
      );
      return;
    }
    // `agent_end` can also mean the run died: an agent error, a terminated
    // session, or the turn budget. Reporting that as a normal stop handed the
    // harness half an answer with no indication anything went wrong.
    if (sawAgentEnd && !AGENT_END_OK.has(agentEndReason)) {
      yield* finishError(
        new Error(`CatPaw 提前结束（${agentEndReason}）${shown.text || shown.reasoning ? "，回答可能不完整" : ""}`),
      );
      return;
    }
    if (!shown.text && !shown.reasoning && toolCalls.length === 0) {
      yield* finishError(new Error("CatPaw 没有返回任何内容"), FAILURE_CODES.empty);
      return;
    }
    record(
      toolCalls.length > 0 ? "tool-calls" : "stop",
      toolCalls.length > 0 ? `${toolCalls.length} 个工具调用` : `${shown.text.length} 字`,
    );
    yield { type: "finish", reason: { kind: toolCalls.length > 0 ? "tool-calls" : "stop" } };
  }
}

/**
 * Compare the configured catalogue with the one 妙手 currently offers, so a
 * stale row config is a one-line answer instead of a support thread.
 */
export function catalogueDiff(configured, live) {
  const want = new Set((Array.isArray(configured) ? configured : []).map((model) => String(model?.id ?? "")));
  const have = new Set((Array.isArray(live) ? live : []).map((model) => String(model?.id ?? "")));
  return {
    missing: [...want].filter((id) => id.length > 0 && !have.has(id)),
    added: [...have].filter((id) => id.length > 0 && !want.has(id)),
  };
}

/**
 * Expose the QR login to the agent so a missing or expired credential can be
 * fixed without the 妙手 app and without restarting DSH.
 */
function registerCatPawTools(ctx, getSettings, server) {
  const state = { pending: null };
  const LOGIN_TTL_MS = 270000;

  ctx.tools.register({
    name: "catpaw_login",
    description:
      "Start a 妙手 (CatPaw) Passport QR login and return an authorization URL for the user to open and confirm. The credential is written to ~/.meituan-catpaw/auth.json automatically after approval, and the running catpaw-cli server restarts on the next call, so nothing needs a manual restart. Call again for a fresh link when the previous one expired.",
    parameters: {
      type: "object",
      properties: {
        restart: {
          type: "boolean",
          description: "Start a brand new login even when one is already pending.",
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string" },
          url: { type: "string" },
          expiresInSeconds: { type: "number" },
          hint: { type: "string" },
        },
      },
      render: (_args, value) =>
        value.url
          ? [{ type: "text", text: `${value.status}\n${value.url}` }]
          : [{ type: "text", text: value.status }],
    },
    async execute(args) {
      const settings = getSettings();
      const pending = state.pending;
      if (!args?.restart && pending?.url && Date.now() - pending.startedAt < LOGIN_TTL_MS) {
        return {
          status: "pending",
          url: pending.url,
          expiresInSeconds: Math.max(0, Math.round((LOGIN_TTL_MS - (Date.now() - pending.startedAt)) / 1000)),
          hint: "已有一次登录在等待扫码，直接在浏览器完成授权即可。",
        };
      }

      let settle;
      const ready = new Promise((resolve) => {
        settle = resolve;
      });
      const login = runLogin({
        baseURL: settings.gateway,
        authPath: settings.authPath,
        onUrl: (url) => settle({ url }),
      }).then(
        (result) => {
          settle({ result });
          return result;
        },
        (error) => {
          settle({ error });
          throw error;
        },
      );
      login.catch(() => {});
      state.pending = { startedAt: Date.now(), url: "", promise: login };

      const outcome = await Promise.race([
        ready,
        new Promise((resolve) =>
          setTimeout(() => resolve({ error: new Error("登录服务 20 秒内没有返回授权链接") }), 20000),
        ),
      ]);
      if (outcome.error) throw outcome.error;
      state.pending.url = outcome.url;
      return {
        status: "waiting_for_scan",
        url: outcome.url,
        expiresInSeconds: 300,
        hint: "在浏览器完成扫码授权（或把链接发到手机）。授权后凭据自动写入，无需重启。",
      };
    },
  });

  ctx.tools.register({
    name: "catpaw_doctor",
    description:
      "One-shot health check for the CatPaw bridge: which catpaw-cli binary resolves, whether the credential file exists and the token is still accepted, whether the gateway answers, whether the configured model catalogue still matches 妙手's live one, whether the local server is running, how the previous call went, and the effective settings. Use it when a call fails for an unclear reason.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { report: { type: "string" } },
      },
      render: (_args, value) => [{ type: "text", text: value.report }],
    },
    async execute() {
      const settings = getSettings();
      const lines = [];
      const step = async (label, probe) => {
        try {
          lines.push(`${label}: ${await probe()}`);
        } catch (error) {
          lines.push(`${label}: 失败 — ${error?.message ?? String(error)}`);
        }
      };

      await step("catpaw-cli", async () => {
        if (!settings.cliPath) return "未找到（用 cliPath / CATPAW_CLI 指定）";
        if (!existsSync(settings.cliPath)) return `${settings.cliPath}（文件不存在！）`;
        try {
          accessSync(settings.cliPath, fsConstants.X_OK);
        } catch {
          return `${settings.cliPath}（存在但没有执行权限，运行 chmod +x 修好）`;
        }
        return settings.cliPath;
      });

      const auth = readAuth(settings.authPath, { required: false });
      await step("凭据", async () => {
        if (!auth) return `未登录（${settings.authPath} 不存在或没有 accessToken）→ 运行 catpaw_login`;
        const identity = await whoami(auth.token, { baseURL: settings.gateway }).catch(() => null);
        const check = await validateToken(auth.token, { baseURL: settings.gateway });
        return `${identity?.name || auth.account?.name || auth.account?.uid || "未知账号"} / token ${check.valid ? "有效" : `已失效（${check.message}）→ 运行 catpaw_login`}`;
      });

      await step("网关", async () => {
        const started = Date.now();
        await whoami(auth?.token ?? "", { baseURL: settings.gateway });
        return `${settings.gateway} 可访问（${Date.now() - started}ms）`;
      });

      await step("模型表", async () => {
        if (!auth) return "跳过（未登录）";
        const live = await fetchModelTypes(auth.token, { baseURL: settings.baseURL });
        const diff = catalogueDiff(settings.models, live);
        const parts = [`配置 ${settings.models.length} 个 / 线上 ${live.length} 个`];
        if (diff.added.length) parts.push(`线上新增: ${diff.added.join(", ")}（可加进 models）`);
        if (diff.missing.length) parts.push(`配置里有但线上没有: ${diff.missing.join(", ")}`);
        if (!diff.added.length && !diff.missing.length) parts.push("一致");
        return parts.join("；");
      });

      await step("本地服务", async () => (server.url ? `${server.url}（已启动）` : "未启动（首次调用时自动拉起）"));

      lines.push(
        `配置: permissionMode=${settings.permissionMode}, excludeNativeTools=${settings.excludeNativeTools.length ? `${settings.excludeNativeTools.length} 个工具` : "关"}, systemPrompt=${settings.systemPrompt}, maxPromptChars=${settings.maxPromptChars}, idleTimeoutMs=${settings.idleTimeoutMs}`,
      );
      await step("上一次调用", async () => {
        const last = server.lastCall;
        if (!last) return "本进程内还没有调用过";
        const when = new Date(last.at).toLocaleTimeString();
        const detail = last.detail ? ` — ${last.detail}` : "";
        return `${when} · 模型 ${last.model} · ${last.outcome} · ${last.ms}ms${detail}`;
      });

      return { report: lines.join("\n") };
    },
  });

  ctx.tools.register({
    name: "catpaw_auth_status",
    description:
      "Report the 妙手 (CatPaw) login state: whether the credential file exists, which account is signed in, and whether the gateway still accepts the token.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          loggedIn: { type: "boolean" },
          uid: { type: "string" },
          name: { type: "string" },
          valid: { type: "boolean" },
          updatedAt: { type: "number" },
          message: { type: "string" },
        },
      },
      render: (_args, value) =>
        [
          {
            type: "text",
            text: value.loggedIn
              ? `${value.name || value.uid}: ${value.valid ? "token 有效" : "token 已失效"}`
              : value.message || "未登录",
          },
        ],
    },
    async execute() {
      const settings = getSettings();
      const auth = readAuth(settings.authPath, { required: false });
      if (!auth) {
        return {
          loggedIn: false,
          uid: "",
          name: "",
          valid: false,
          updatedAt: 0,
          message: "未登录：调用 catpaw_login 扫码登录。",
        };
      }
      let identity = null;
      try {
        identity = await whoami(auth.token, { baseURL: settings.gateway });
      } catch {}
      const check = await validateToken(auth.token, { baseURL: settings.gateway });
      return {
        loggedIn: true,
        uid: identity?.uid || String(auth.account?.uid ?? ""),
        name: identity?.name || String(auth.account?.name ?? ""),
        valid: check.valid,
        updatedAt: auth.updatedAt,
        message: check.valid ? "" : check.message || "token 已失效，请重新扫码。",
      };
    },
  });
}

export function apply(ctx, config) {
  const getSettings = () => readSettings(config);
  getSettings();
  const server = new CatPawServer(getSettings);
  ctx.effect(() => () => {
    void server.stop();
  }, "dsh-catpaw: catpaw-cli server");
  const adapter = new CatPawAdapter(ctx, getSettings, server);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  registerCatPawTools(ctx, getSettings, server);
}
