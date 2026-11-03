import assert from "node:assert/strict";
import test from "node:test";
import { MarkerGate, TextChannel, TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from "./stream-text.mjs";

/** Feed a list of frames and collect everything the gate published as text. */
function run(frames) {
  const channel = new TextChannel();
  const gate = new MarkerGate(channel);
  let shown = "";
  for (const frame of frames) shown += gate.push(frame);
  return { gate, channel, shown, flushed: gate.flush() };
}

test("plain deltas are published in full (the shape catpaw-cli actually sends)", () => {
  const pieces = ["你", "好", "，", "世界", "。", "这是一段", "被拆成", "很多帧的", "回答。"];
  const { shown, flushed } = run(pieces);
  assert.equal(shown + flushed, pieces.join(""));
});

test("a short answer below the hold-back window is not swallowed", () => {
  const { shown, flushed } = run(["你好"]);
  assert.equal(shown + flushed, "你好");
});

test("cumulative snapshots produce no duplication", () => {
  const frames = ["你", "你好", "你好，", "你好，世界"];
  const { shown, flushed } = run(frames);
  assert.equal(shown + flushed, "你好，世界");
});

test("a repeated frame is ignored instead of duplicated", () => {
  const { shown, flushed } = run(["回答", "回答", "继续"]);
  assert.equal(shown + flushed, "回答继续");
});

test("deltas followed by the authoritative model_end text emit only the tail", () => {
  const full = "第一段内容。第二段内容。第三段内容。";
  const frames = [full.slice(0, 7), full.slice(7, 20), full];
  const { shown, flushed } = run(frames);
  assert.equal(shown + flushed, full);
});

test("the model_end text also rescues a stream that ended mid-sentence", () => {
  const full = "前缀已经到达。";
  const { shown, flushed } = run([full.slice(0, 3), full]);
  assert.equal(shown + flushed, full);
});

test("a marker split across frames never leaks into the text channel", () => {
  const call = `${TOOL_CALL_OPEN}[{"name":"bash","arguments":{"command":"uuidgen"}}]${TOOL_CALL_CLOSE}`;
  const frames = ["先看一下。", ...call.match(/.{1,5}/gs)];
  const { gate, shown, flushed } = run(frames);
  assert.equal(shown + flushed, "先看一下。");
  assert.equal(gate.mode, "tool");
  const { body } = gate.payload();
  assert.deepEqual(JSON.parse(body), [{ name: "bash", arguments: { command: "uuidgen" } }]);
});

test("text after the closing marker is reported instead of dropped", () => {
  const frames = [`${TOOL_CALL_OPEN}[{"name":"bash","arguments":{"command":"ls"}}]${TOOL_CALL_CLOSE}`, "完成。"];
  const { gate } = run(frames);
  assert.equal(gate.payload().trailing, "完成。");
});

test("a long stream is reproduced byte for byte", () => {
  const full = Array.from({ length: 4000 }, (_, i) => `第${i}句。`).join("");
  const frames = full.match(/[\s\S]{1,3}/g);
  const { shown, flushed, channel } = run(frames);
  assert.equal(channel.text, full);
  assert.equal(shown + flushed, full);
});

test("snapshots and deltas mixed in one stream still add up", () => {
  const frames = ["甲", "乙", "甲乙丙", "丁", "甲乙丙丁戊"];
  const { channel, shown, flushed } = run(frames);
  assert.equal(channel.text, "甲乙丙丁戊");
  assert.equal(shown + flushed, "甲乙丙丁戊");
});
