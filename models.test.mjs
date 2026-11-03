import assert from "node:assert/strict";
import test from "node:test";
import { FAILURE_CODES, errorFinish, failure, modelParamsFor, reasoningFor } from "./index.js";

/** The four shapes the catalogue actually contains. */
const THINKING_ONLY = { id: "10002544", name: "LongCat-2.5", contextWindow: 1024000, params: ["context", "thinking"] };
const EFFORT_ONLY = { id: "89", name: "GLM-5.3", contextWindow: 1024000, params: ["context", "effort"] };
const BOTH = { id: "97", name: "DeepSeek-V4.1-Flash", contextWindow: 1024000, params: ["context", "thinking", "effort"] };
const NONE = { id: "0", name: "Auto", contextWindow: 1024000, params: [] };

test("a thinking-only model advertises Off plus one deep-thinking row", () => {
  const reasoning = reasoningFor(THINKING_ONLY);
  assert.deepEqual(reasoning.efforts.map((effort) => effort.id), ["off", "high"]);
  assert.equal(reasoning.defaultEffort, "high");
});

test("an effort-only model advertises the three-step ladder", () => {
  const reasoning = reasoningFor(EFFORT_ONLY);
  assert.deepEqual(reasoning.efforts.map((effort) => effort.id), ["low", "high", "max"]);
  assert.equal(reasoning.defaultEffort, "high");
});

test("a model with both parameters offers Off and the ladder", () => {
  const reasoning = reasoningFor(BOTH);
  assert.deepEqual(reasoning.efforts.map((effort) => effort.id), ["off", "low", "high", "max"]);
});

test("a model without parameters has no reasoning row at all", () => {
  assert.equal(reasoningFor(NONE), undefined);
});

test("the catalogue's own default is honoured when it names a real row", () => {
  const minimax = { id: "10002518", name: "MiniMax-M3.1-Flash", params: ["context", "effort"], defaultEffort: "low" };
  assert.equal(reasoningFor(minimax).defaultEffort, "low");
});

test("a default the model cannot express falls back to its first row", () => {
  const odd = { id: "x", params: ["context", "thinking"], defaultEffort: "low" };
  assert.equal(reasoningFor(odd).defaultEffort, "off");
});

test("Off disables thinking and never sends effort=off", () => {
  assert.deepEqual(modelParamsFor(BOTH, "off"), {
    context: "1024000",
    thinking: { enabled: false },
    effort: "low",
  });
});

test("the higher tiers keep thinking on and pass the effort through", () => {
  assert.deepEqual(modelParamsFor(BOTH, "max"), {
    context: "1024000",
    thinking: { enabled: true },
    effort: "max",
  });
});

test("a thinking-only model sends no effort field", () => {
  assert.deepEqual(modelParamsFor(THINKING_ONLY, "high"), {
    context: "1024000",
    thinking: { enabled: true },
  });
});

test("an effort-only model sends no thinking field", () => {
  assert.deepEqual(modelParamsFor(EFFORT_ONLY, "low"), { context: "1024000", effort: "low" });
});

test("no parameters means no modelParams at all", () => {
  assert.deepEqual(modelParamsFor(NONE, "high"), {});
});

test("context follows the catalogue's window", () => {
  assert.equal(modelParamsFor({ params: ["context"], contextWindow: 200000 }, "off").context, "200000");
  assert.equal(modelParamsFor({ params: ["context"] }, "off").context, "1024000");
});

test("a missing effort falls back to the catalogue default", () => {
  const minimax = { params: ["context", "effort"], defaultEffort: "low" };
  assert.deepEqual(modelParamsFor(minimax, undefined), { context: "1024000", effort: "low" });
});

test("a tagged error reports its own code, so the retry policy can act on it", () => {
  const finished = errorFinish(failure("idle", FAILURE_CODES.timeout));
  assert.equal(finished.reason.kind, "error");
  assert.equal(finished.reason.failure.code, "TIMEOUT");
  assert.equal(finished.reason.failure.message, "idle");
});

test("an untagged error is permanent, never retried", () => {
  assert.equal(errorFinish(new Error("boom")).reason.failure.code, "CATPAW_ERROR");
  assert.equal(errorFinish(new Error("boom"), FAILURE_CODES.server).reason.failure.code, "SERVER");
});

test("catalogue drift reports both directions", async () => {
  const { catalogueDiff } = await import("./index.js");
  const configured = [{ id: "10002544" }, { id: "77" }, { id: "0" }];
  const live = [{ id: "10002544" }, { id: "77" }, { id: "999" }];
  assert.deepEqual(catalogueDiff(configured, live), { missing: ["0"], added: ["999"] });
});

test("an unchanged catalogue reports no drift", async () => {
  const { catalogueDiff } = await import("./index.js");
  const models = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(catalogueDiff(models, [{ id: "b" }, { id: "a" }]), { missing: [], added: [] });
});
