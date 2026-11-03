import assert from "node:assert/strict";
import test from "node:test";
import { clipText, parseDsmlCalls, parseLongcatCalls, parseToolCalls, renderPrompt, renderToolSection } from "./index.js";

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

const TOOL = {
  name: "bash",
  description: "Run a command.",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};
const settingsFor = (maxPromptChars) => ({
  messageChars: 20000,
  toolResultChars: 4000,
  maxPromptChars,
  systemPrompt: "transcript",
});
const many = (count) =>
  Array.from({ length: count }, (_, i) => ({ role: "user", content: [{ type: "text", text: `第 ${i} 条：${"内容".repeat(60)}` }] }));

test("the prompt stays inside its budget even when it is tiny", () => {
  const prompt = renderPrompt(
    { system: "系统提示".repeat(2000), tools: [TOOL], messages: many(30) },
    settingsFor(3000),
  );
  assert.ok(prompt.length <= 3000, `prompt was ${prompt.length}`);
});

test("dropping history is announced instead of hidden", () => {
  const prompt = renderPrompt({ tools: [TOOL], messages: many(40) }, settingsFor(4000));
  assert.match(prompt, /<omitted messages="\d+">/);
});

test("a transcript that fits is left alone", () => {
  const messages = many(2);
  const prompt = renderPrompt({ tools: [TOOL], messages }, settingsFor(120000));
  assert.doesNotMatch(prompt, /omitted messages/);
  assert.match(prompt, /第 0 条/);
  assert.match(prompt, /第 1 条/);
});

test("the tool protocol is restated even when the budget is tight", () => {
  const prompt = renderPrompt({ tools: [TOOL], messages: many(30) }, settingsFor(2500));
  assert.match(prompt, /<tool_protocol>/);
  assert.match(prompt, /dsh_bash/);
});

test("an empty conversation still renders something usable", () => {
  assert.equal(renderPrompt({ messages: [] }, settingsFor(120000)), "（空对话）");
});

test("a tool call whose arguments arrived as an object is still readable", async () => {
  const { renderMessage } = await import("./index.js");
  const rendered = renderMessage(
    { role: "assistant", content: [{ type: "tool-call", name: "bash", arguments: { command: "ls" } }] },
    { messageChars: 20000, toolResultChars: 4000 },
  );
  assert.match(rendered, /\[tool call: dsh_bash \{"command":"ls"\}\]/);
  assert.doesNotMatch(rendered, /object Object/);
});

test("a tool result keeps its error flag and its call id", async () => {
  const { renderMessage } = await import("./index.js");
  const rendered = renderMessage(
    { role: "tool", toolCallId: "call-1", isError: true, content: [{ type: "text", text: "boom" }] },
    { messageChars: 20000, toolResultChars: 4000 },
  );
  assert.match(rendered, /^<tool_result call_id="call-1" error="true">/);
  assert.match(rendered, /boom/);
});

test("attachments and unknown blocks render as placeholders, not crashes", async () => {
  const { renderMessage } = await import("./index.js");
  const rendered = renderMessage(
    {
      role: "user",
      content: [
        { type: "image", attachment: { name: "shot.png" } },
        { type: "file", attachment: { name: "report.pdf" } },
        { type: "mystery" },
      ],
    },
    { messageChars: 20000, toolResultChars: 4000 },
  );
  assert.match(rendered, /\[image: shot\.png\]/);
  assert.match(rendered, /\[file: report\.pdf\]/);
});
