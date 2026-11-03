import assert from "node:assert/strict";
import test from "node:test";
import { parseToolCalls, renderToolSection } from "./index.js";

const aliases = new Map([
  ["dsh_bash", "bash"],
  ["dsh_read", "read"],
]);

test("the tool section advertises the dsh_ alias and a worked example", () => {
  const section = renderToolSection([
    { name: "bash", description: "Run a shell command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  ]);
  assert.match(section, /- dsh_bash: Run a shell command\./);
  assert.match(section, /参数: \{command:string\}/);
  assert.match(section, /\[\{"name":"dsh_bash","arguments":\{"command":"ls"\}\}\]/);
  assert.match(section, /自带的工具[\s\S]*全部被禁用/);
  assert.match(section, /dsh_ 前缀/);
});

test("an aliased call is mapped back to the real harness name", () => {
  const calls = parseToolCalls('[{"name":"dsh_bash","arguments":{"command":"ls"}}]', aliases);
  assert.deepEqual(calls, [{ name: "bash", arguments: { command: "ls" } }]);
});

test("a call written with the plain harness name still works", () => {
  const calls = parseToolCalls('[{"name":"bash","arguments":{"command":"ls"}}]', aliases);
  assert.deepEqual(calls, [{ name: "bash", arguments: { command: "ls" } }]);
});

test("an unknown alias is passed through unchanged", () => {
  const calls = parseToolCalls('[{"name":"dsh_nope","arguments":{}}]', aliases);
  assert.deepEqual(calls, [{ name: "dsh_nope", arguments: {} }]);
});

test("calls survive a fenced block and a single object", () => {
  const fenced = parseToolCalls('```json\n[{"name":"dsh_read","arguments":{"file_path":"/tmp/a"}}]\n```', aliases);
  assert.deepEqual(fenced, [{ name: "read", arguments: { file_path: "/tmp/a" } }]);
  const single = parseToolCalls('{"name":"dsh_read","arguments":{"file_path":"/tmp/b"}}', aliases);
  assert.deepEqual(single, [{ name: "read", arguments: { file_path: "/tmp/b" } }]);
});

test("argument-bearing and argument-less entries both parse", () => {
  const calls = parseToolCalls(
    '[{"name":"dsh_bash","arguments":{"command":"cat /tmp/a.txt"}},{"name":"dsh_read","arguments":"{\\"file_path\\":\\"/tmp/b\\"}"}]',
    aliases,
  );
  assert.deepEqual(calls, [
    { name: "bash", arguments: { command: "cat /tmp/a.txt" } },
    { name: "read", arguments: { file_path: "/tmp/b" } },
  ]);
});

test("a truncated payload yields whatever complete calls it can", () => {
  const calls = parseToolCalls('[{"name":"dsh_bash","arguments":{"command":"ls"}},{"name":"dsh_re', aliases);
  assert.deepEqual(calls, [{ name: "bash", arguments: { command: "ls" } }]);
});

test("garbage yields no calls instead of throwing", () => {
  assert.deepEqual(parseToolCalls("我做不到。", aliases), []);
  assert.deepEqual(parseToolCalls("", aliases), []);
});
