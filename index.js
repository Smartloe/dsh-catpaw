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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runLogin, validateToken, whoami } from "./login.mjs";
import { MarkerGate, TextChannel, TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from "./stream-text.mjs";

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
function reasoningFor(entry) {
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
function modelParamsFor(entry, effort) {
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

function readSettings(config) {
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
    const config = {
      baseURL: settings.baseURL,
      cookie: `X-Passport-Token=${token}`,
      authTokens: { "x-passport-token": token },
      source: "CatX",
      mode: "CATX_APP",
    };
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
      proc.on("error", fail);
      proc.on("exit", (code, signal) => {
        this.url = null;
        this.proc = null;
        this.ready = null;
        if (!settled) fail(new Error(`catpaw-cli server 退出（code=${code}，signal=${signal}）`));
      });
    });
  }

  /**
   * A fresh QR login rewrites auth.json while the server keeps the old token in
   * its environment. Restart it so the next request uses the new credential.
   */
  async refreshIfTokenChanged() {
    const settings = this.getSettings();
    const auth = readAuth(settings.authPath, { required: false });
    if (!auth || !this.token) return;
    if (auth.token === this.token) return;
    debugLog(settings.debug, "auth token changed, restarting catpaw-cli server");
    await this.stop();
  }

  async request(method, params, { stream = false, signal } = {}) {
    await this.refreshIfTokenChanged();
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

function clipText(text, max) {
  if (typeof text !== "string") return "";
  if (max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字符）`;
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
function renderToolSection(tools) {
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
    "宿主工具在这里带 dsh_ 前缀呈现：需要 bash 就写 dsh_bash，需要读文件就写 dsh_read。"
      + "前缀之外的工具名一律无效，也不要抱怨名字不匹配——它们不是同一个工具。",
    "",
    `需要做事时，输出一个标记块：以 ${TOOL_CALL_OPEN} 开头，接一个 JSON 数组，以 ${TOOL_CALL_CLOSE} 结尾。`,
    '数组元素形如 {"name":"工具名","arguments":{...}}，arguments 需符合该工具的参数 schema。',
    "一次可以列出多个调用，按执行顺序排列；结果会作为工具结果返回，然后继续。",
    "不需要工具时直接回答，不要输出标记块。",
    "",
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

/** Pull `{name, arguments}` entries out of whatever the model wrapped them in. */
function parseToolCalls(payload, aliases = new Map()) {
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
    const cut = Math.max(body.lastIndexOf("]"), body.lastIndexOf("}"));
    if (cut < 0) return [];
    try {
      parsed = JSON.parse(body.slice(0, cut + 1));
    } catch {
      return [];
    }
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

function renderBlocks(content, limits) {
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
        const args = clipText(String(block.arguments ?? "{}"), Math.min(limits.messageChars, 2000));
        parts.push(`[tool call: ${block.name ?? "?"} ${args}]`);
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

function renderMessage(message, limits) {
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

function renderPrompt(options, settings) {
  const limits = { messageChars: settings.messageChars, toolResultChars: settings.toolResultChars };
  const system =
    options.system && settings.systemPrompt === "transcript"
      ? `<system>\n${clipText(String(options.system).trim(), Math.min(settings.messageChars, 40000))}\n</system>`
      : "";
  const tools = Array.isArray(options.tools) ? options.tools.filter((tool) => tool && typeof tool.name === "string") : [];
  const budget = Math.max(2000, settings.maxPromptChars);
  const toolSection =
    tools.length > 0 ? clipText(renderToolSection(tools), Math.floor(budget * 0.55)) : "";
  const prefix = [system, toolSection].filter(Boolean).join("\n\n");
  const rendered = [];
  for (const message of options.messages ?? []) {
    const piece = renderMessage(message, limits);
    if (piece) rendered.push(piece);
  }
  let used = prefix ? prefix.length + 2 : 0;
  const kept = [];
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const piece = rendered[index];
    if (kept.length > 0 && used + piece.length + 2 > budget) break;
    kept.unshift(piece);
    used += piece.length + 2;
  }
  let body = kept.join("\n\n");
  if (prefix.length + body.length > budget) {
    body = clipText(body, Math.max(0, budget - prefix.length - 2));
  }
  // Recency matters: restate the contract after the transcript so the model
  // does not fall back to its own built-in tools when the task needs action.
  const reminder =
    tools.length > 0
      ? [
          "",
          "<tool_protocol>",
          `工具调用格式：${TOOL_CALL_OPEN}`,
          '[{"name":"工具名","arguments":{...}}]',
          TOOL_CALL_CLOSE,
          "标记块之外的文本会作为普通回答展示给用户。",
          `工具名以 <tools> 列表为准（都带 ${TOOL_ALIAS_PREFIX} 前缀），不带前缀的同名工具是本会话禁用的内置工具。`,
          "CatPaw 自带的 bash / read_file / write / grep 等工具在此会话被禁用，"
            + "调用它们只会失败并浪费一轮；所有动作都必须通过上面的标记块表达。",
          "</tool_protocol>",
        ].join("\n")
      : "";
  return [prefix, body, reminder].filter(Boolean).join("\n\n") || "（空对话）";
}

function errorFinish(error) {
  return {
    type: "finish",
    reason: {
      kind: "error",
      failure: {
        message: error?.message ? String(error.message) : String(error),
        code: "CATPAW_ERROR",
      },
    },
  };
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
    return undefined;
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
              return workingDirectory.get(session);
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
    const directory = this.resolveDirectory(options, settings);
    const entry = settings.models.find((candidate) => String(candidate.id) === model);
    const modelParams = modelParamsFor(entry, options.reasoningEffort);
    const hasModelParams = Object.keys(modelParams).length > 0;

    const abort = new AbortController();
    const relay = () => abort.abort(options.signal?.reason ?? new Error("aborted"));
    if (options.signal?.aborted) relay();
    else options.signal?.addEventListener("abort", relay, { once: true });

    let idleTimer;
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abort.abort(new Error("CatPaw 响应空闲超时")), settings.idleTimeoutMs);
    };
    const totalTimer = setTimeout(() => abort.abort(new Error("CatPaw 响应总超时")), settings.timeoutMs);
    touch();

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      options.signal?.removeEventListener("abort", relay);
    };

    let response;
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
      yield errorFinish(error);
      return;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      cleanup();
      yield errorFinish(new Error(`CatPaw HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`));
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
        touch();
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
          const type = event?.type;
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
              errorMessage =
                typeof data.error === "string" ? data.error : (data.error?.message ?? "CatPaw agent 报错");
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
      if (!options.signal?.aborted) errorMessage = errorMessage ?? (error?.message ?? String(error));
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
    if (gate.mode === "tool") {
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
    if (errorMessage) {
      yield errorFinish(new Error(errorMessage));
      return;
    }
    if (sawAgentEnd && agentEndReason === "interaction_pending") {
      yield errorFinish(
        new Error("妙手停在一个工具权限确认上，而 DSH 桥接没有权限界面。请把 permissionMode 改成 dontAsk 或 bypassPermissions。"),
      );
      return;
    }
    if (!shown.text && !shown.reasoning && toolCalls.length === 0) {
      yield errorFinish(new Error("CatPaw 没有返回任何内容"));
      return;
    }
    yield { type: "finish", reason: { kind: toolCalls.length > 0 ? "tool-calls" : "stop" } };
  }
}

/**
 * Expose the QR login to the agent so a missing or expired credential can be
 * fixed without the 妙手 app and without restarting DSH.
 */
function registerCatPawTools(ctx, getSettings) {
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
  registerCatPawTools(ctx, getSettings);
}
