import assert from "node:assert/strict";
import test from "node:test";
import { clipText, parseDsmlCalls, parseLongcatCalls, parseToolCalls, renderToolSection } from "./index.js";

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

test("long tool output keeps both ends and stays inside the limit", () => {
  const text = `${"头".repeat(3000)}${"中".repeat(3000)}${"尾".repeat(3000)}`;
  const clipped = clipText(text, 4000);
  assert.ok(clipped.length <= 4000, `got ${clipped.length}`);
  assert.ok(clipped.startsWith("头头头"));
  assert.ok(clipped.endsWith("尾尾尾"));
  assert.match(clipped, /中间省略 \d+ 字符/);
});

test("short text passes through untouched", () => {
  assert.equal(clipText("abc", 10), "abc");
  assert.equal(clipText("abc", 0), "abc");
  assert.equal(clipText(undefined, 10), "");
});

test("LongCat's XML calls parse, including several blocks and aliases", () => {
  const text = [
    "<longcat_tool_call>bash",
    "<longcat_arg_key>command</longcat_arg_key>",
    "<longcat_arg_value>cat /tmp/a.txt</longcat_arg_value>",
    "</longcat_tool_call>",
    "<longcat_tool_call>dsh_read",
    "<longcat_arg_key>file_path</longcat_arg_key>",
    "<longcat_arg_value>/tmp/b.txt</longcat_arg_value>",
    "</longcat_tool_call>",
  ].join("\n");
  assert.deepEqual(parseLongcatCalls(text, new Map([["dsh_read", "read"]])), [
    { name: "bash", arguments: { command: "cat /tmp/a.txt" } },
    { name: "read", arguments: { file_path: "/tmp/b.txt" } },
  ]);
});

test("a named-tool variant and a nameless block are handled", () => {
  const text = [
    "<longcat_tool_call><longcat_tool_name>bash</longcat_tool_name>",
    "<longcat_arg_key>command</longcat_arg_key><longcat_arg_value>ls</longcat_arg_value>",
    "</longcat_tool_call>",
    "<longcat_tool_call></longcat_tool_call>",
  ].join("\n");
  assert.deepEqual(parseLongcatCalls(text), [{ name: "bash", arguments: { command: "ls" } }]);
});

test("DeepSeek's DSML markup parses, with aliases and several parameters", () => {
  const text = [
    "<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>",
    '<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="dsh_bash">',
    '<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="command" string="true">cat /tmp/x</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>',
    '<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="description" string="true">读取</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>',
    "</\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>",
    "</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>",
  ].join("\n");
  assert.deepEqual(parseDsmlCalls(text, new Map([["dsh_bash", "bash"]])), [
    { name: "bash", arguments: { command: "cat /tmp/x", description: "读取" } },
  ]);
});

test("DSML without a closing tag yields nothing instead of throwing", () => {
  assert.deepEqual(parseDsmlCalls("<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name=\"dsh_bash\">"), []);
});
