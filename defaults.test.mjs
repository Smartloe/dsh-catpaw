import assert from "node:assert/strict";
import test from "node:test";
import { readSettings } from "./index.js";

/**
 * The configuration table in both READMEs is a promise to the user. This test
 * is the other half of that promise: if a default changes in code, the tables
 * are wrong until someone updates them, and this fails first.
 */
const defaults = readSettings({});

test("the documented timeouts and budgets", () => {
  assert.equal(defaults.timeoutMs, 600000);
  assert.equal(defaults.idleTimeoutMs, 300000);
  assert.equal(defaults.maxPromptChars, 120000);
  assert.equal(defaults.toolResultChars, 4000);
  assert.equal(defaults.messageChars, 20000);
});

test("the documented modes", () => {
  assert.equal(defaults.permissionMode, "dontAsk");
  assert.equal(defaults.systemPrompt, "transcript");
  assert.equal(defaults.debug, false);
  assert.equal(defaults.directory, "");
});

test("the documented endpoints and credential path", () => {
  assert.equal(defaults.baseURL, "https://ai.catpaw.meituan.com");
  assert.equal(defaults.gateway, "https://catx.nocode.cn");
  assert.match(defaults.authPath, /\.meituan-catpaw\/auth\.json$/);
});

test("19 built-in tools are hidden from the model by default", () => {
  assert.equal(defaults.excludeNativeTools.length, 19);
  for (const name of ["bash", "read_file", "write", "grep", "web_fetch", "todo_write"]) {
    assert.ok(defaults.excludeNativeTools.includes(name), `${name} should be excluded`);
  }
});

test("the catalogue matches the twelve models the list documents", () => {
  assert.equal(defaults.models.length, 12);
  assert.deepEqual(
    defaults.models.map((model) => model.id),
    ["10002544", "77", "98", "91", "89", "97", "64", "10002518", "70", "10002533", "83", "0"],
  );
  for (const model of defaults.models) {
    assert.ok(Number(model.contextWindow) > 0, `${model.id} needs a context window`);
    assert.ok(Number(model.maxTokens) > 0, `${model.id} needs a max token count`);
    assert.ok(Array.isArray(model.params), `${model.id} needs a params list`);
  }
});

test("a bad permission mode falls back instead of being passed through", () => {
  assert.equal(readSettings({ permissionMode: "yolo" }).permissionMode, "dontAsk");
  assert.equal(readSettings({ systemPrompt: "everything" }).systemPrompt, "transcript");
});

test("an explicit empty exclusion list keeps the built-in tools", () => {
  assert.deepEqual(readSettings({ excludeNativeTools: false }).excludeNativeTools, []);
  assert.deepEqual(readSettings({ excludeNativeTools: ["bash"] }).excludeNativeTools, ["bash"]);
});

test("the shipped row does not redeclare the catalogue", async () => {
  const { readFileSync } = await import("node:fs");
  const row = readFileSync(new URL("./cordis.patch.yml", import.meta.url), "utf8");
  // Two copies of the model table is how an edit to one of them does nothing:
  // the row would win over DEFAULT_MODELS forever after installation.
  assert.doesNotMatch(row, /^\s+models:/m, "keep the catalogue in index.js only");
});
