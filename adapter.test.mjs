import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { apply } from "./index.js";

// fileURLToPath, not `.pathname`: this repository lives under a path with CJK
// characters, which URL-encodes into something the filesystem cannot find — and
// a cliPath that does not exist silently falls through to the real binary.
const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));

/** A credential file the adapter will accept, and a temp dir for test artefacts. */
function fixtures() {
  // A checkout does not always carry the executable bit (this repository's
  // volume reports everything as 0755, so git records 0644). The adapter spawns
  // the path directly, so make it runnable before any test uses it.
  chmodSync(FAKE_CLI, 0o755);
  const dir = mkdtempSync(join(tmpdir(), "dsh-catpaw-test-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({ auth: { accessToken: "test-token", loginType: "passport" }, account: { uid: "1" }, updatedAt: Date.now() }),
  );
  const logPath = join(dir, "requests.jsonl");
  // the child inherits the environment, so this is how it learns where to log
  process.env.FAKE_CLI_LOG = logPath;
  return { dir, authPath, logPath };
}

/**
 * Mount the plugin the way the harness does and hand back the provider adapter
 * it registered, plus the tools it added.
 */
function mount({ authPath, logPath }, overrides = {}) {
  let adapter = null;
  const tools = [];
  const disposers = [];
  const ctx = {
    llm: { registerAdapter: (_providers, instance) => (adapter = instance) },
    tools: { register: (tool) => tools.push(tool) },
    effect: (factory) => disposers.push(factory()),
    get: () => undefined,
  };
  apply(ctx, {
    cliPath: FAKE_CLI,
    authPath,
    debug: false,
    ...overrides,
  });
  return { adapter, tools, ctx, dispose: () => disposers.forEach((fn) => fn?.()) };
}

/** Run one model call and collect every chunk it yields. */
async function run(adapter, overrides = {}) {
  const chunks = [];
  for await (const chunk of adapter.stream({
    provider: "catpaw",
    model: "10002544",
    messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
    system: "",
    tools: [{ name: "bash", description: "Run a command.", parameters: { type: "object", properties: { command: { type: "string" } } } }],
    ...overrides,
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

const textOf = (chunks) =>
  chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text).join("");
const finishOf = (chunks) => chunks.find((chunk) => chunk.type === "finish");

test("a streamed answer arrives whole, as one text block plus a stop", async (t) => {
  const fx = fixtures();
  const { adapter, dispose } = mount(fx);
  t.after(dispose);
  process.env.FAKE_SCENARIO = "text";
  const chunks = await run(adapter);

  assert.equal(textOf(chunks), "先说明一下，这是一段用于测试的连续文本，会被拆成很多帧送出去。");
  const [start] = chunks;
  assert.equal(start.type, "block-start");
  assert.equal(start.blockType, "text");
  const end = chunks.find((chunk) => chunk.type === "block-end");
  assert.equal(end.block.text, textOf(chunks));
  assert.deepEqual(finishOf(chunks).reason, { kind: "stop" });
});

test("a marker block split across frames becomes a real tool call", async (t) => {
  const fx = fixtures();
  const { adapter, dispose } = mount(fx);
  t.after(dispose);
  process.env.FAKE_SCENARIO = "tool";
  const chunks = await run(adapter);

  assert.equal(textOf(chunks), "我来看一下。");
  const call = chunks.find((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call");
  assert.equal(call.block.name, "bash");
  assert.deepEqual(JSON.parse(call.block.arguments), { command: "cat /tmp/probe.txt" });
  assert.deepEqual(finishOf(chunks).reason, { kind: "tool-calls" });
});

test("LongCat's own XML also becomes a tool call", async (t) => {
  const fx = fixtures();
  const { adapter, dispose } = mount(fx);
  t.after(dispose);
  process.env.FAKE_SCENARIO = "longcat";
  const chunks = await run(adapter);

  assert.equal(textOf(chunks), "我先确认一下。");
  const call = chunks.find((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call");
  assert.equal(call.block.name, "bash");
  assert.deepEqual(JSON.parse(call.block.arguments), { command: "ls" });
});

test("an empty turn is reported as an empty response, not a blank answer", async (t) => {
  const fx = fixtures();
  const { adapter, dispose } = mount(fx);
  t.after(dispose);
  process.env.FAKE_SCENARIO = "empty";
  const chunks = await run(adapter);

  const finish = finishOf(chunks);
  assert.equal(finish.reason.kind, "error");
  assert.equal(finish.reason.failure.code, "EMPTY_RESPONSE");
});

test("a stalled stream hits the idle timeout and stops the backend run", async (t) => {
  const fx = fixtures();
  const { adapter, dispose } = mount(fx, { idleTimeoutMs: 400 });
  t.after(dispose);
  process.env.FAKE_SCENARIO = "stalled";
  const chunks = await run(adapter);

  const finish = finishOf(chunks);
  assert.equal(finish.reason.kind, "error");
  assert.equal(finish.reason.failure.code, "TIMEOUT");
});

test("the spawned CLI receives the exclusion list and the token", async (t) => {
  const fx = fixtures();
  const { adapter, dispose } = mount(fx);
  t.after(dispose);
  process.env.FAKE_SCENARIO = "text";
  await run(adapter);

  const requests = readFileSync(fx.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const started = requests.find((request) => request.method === "agent.start");
  assert.ok(started, "the adapter should have called agent.start");
  assert.equal(started.params.config.model, 10002544);
  assert.equal(started.params.permissionMode, "dontAsk");
  // the prompt carries the tool protocol and the aliased tool name
  assert.match(started.params.content[0].text, /dsh_bash/);
  assert.match(started.params.content[0].text, /catpaw_tool_call/);
});

test("tools are registered under the names the documentation promises", async (t) => {
  const fx = fixtures();
  const { tools, dispose } = mount(fx);
  t.after(dispose);
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["catpaw_auth_status", "catpaw_doctor", "catpaw_login"]);
});

test("a run that ends badly is not reported as a normal stop", async (t) => {
  const fx = fixtures();
  const { adapter, dispose } = mount(fx);
  t.after(dispose);
  process.env.FAKE_SCENARIO = "text";
  process.env.FAKE_END_REASON = "error";
  t.after(() => delete process.env.FAKE_END_REASON);
  const chunks = await run(adapter);

  const finish = finishOf(chunks);
  assert.equal(finish.reason.kind, "error");
  assert.match(finish.reason.failure.message, /提前结束/);
  assert.match(finish.reason.failure.message, /error/);
});

test("a completed run still stops cleanly", async (t) => {
  const fx = fixtures();
  const { adapter, dispose } = mount(fx);
  t.after(dispose);
  process.env.FAKE_SCENARIO = "text";
  delete process.env.FAKE_END_REASON;
  const chunks = await run(adapter);
  assert.deepEqual(finishOf(chunks).reason, { kind: "stop" });
});

test("a binary without the executable bit explains itself", async (t) => {
  const fx = fixtures();
  const copy = join(fx.dir, "catpaw-cli");
  writeFileSync(copy, readFileSync(FAKE_CLI), { mode: 0o644 });
  const { adapter, dispose } = mount(fx, { cliPath: copy });
  t.after(dispose);
  process.env.FAKE_SCENARIO = "text";
  const chunks = await run(adapter);

  const finish = finishOf(chunks);
  assert.equal(finish.reason.kind, "error");
  assert.match(finish.reason.failure.message, /执行权限/);
  assert.equal(finish.reason.failure.code, "TRANSPORT");
});

test("the last call is remembered for the doctor", async (t) => {
  const fx = fixtures();
  // point the gateway at a closed port: the doctor's network probes should fail
  // instantly instead of waiting out their timeouts on a machine without the
  // vendor network
  const { adapter, tools, dispose } = mount(fx, { gateway: "http://127.0.0.1:9", baseURL: "http://127.0.0.1:9" });
  t.after(dispose);
  process.env.FAKE_SCENARIO = "text";
  await run(adapter);

  const doctor = tools.find((tool) => tool.name === "catpaw_doctor");
  const { report } = await doctor.execute({});
  assert.match(report, /上一次调用: .*模型 10002544 · stop · \d+ms — \d+ 字/);
});

test("a failed call leaves the failure in the doctor's report too", async (t) => {
  const fx = fixtures();
  const { adapter, tools, dispose } = mount(fx, {
    idleTimeoutMs: 300,
    gateway: "http://127.0.0.1:9",
    baseURL: "http://127.0.0.1:9",
  });
  t.after(dispose);
  process.env.FAKE_SCENARIO = "stalled";
  await run(adapter);

  const doctor = tools.find((tool) => tool.name === "catpaw_doctor");
  const { report } = await doctor.execute({});
  assert.match(report, /上一次调用: .*error · \d+ms — CatPaw 响应空闲超时/);
});

test("a run stopped for a permission prompt says what to change", async (t) => {
  const fx = fixtures();
  const { adapter, dispose } = mount(fx);
  t.after(dispose);
  process.env.FAKE_SCENARIO = "text";
  process.env.FAKE_END_REASON = "interaction_pending";
  t.after(() => delete process.env.FAKE_END_REASON);
  const chunks = await run(adapter);

  const finish = finishOf(chunks);
  assert.equal(finish.reason.kind, "error");
  assert.match(finish.reason.failure.message, /permissionMode/);
});
