#!/usr/bin/env node
/**
 * A stand-in for `catpaw-cli server`, for tests that need the adapter's real
 * code path without a network or an account.
 *
 * It speaks just enough of the contract the plugin relies on:
 *   - prints one line containing `http://127.0.0.1:<port>` on stdout
 *   - answers `POST /api` with JSON-RPC, and streams SSE when `stream: true`
 *   - records every request it received into $FAKE_CLI_LOG for assertions
 *
 * The scripted answer comes from $FAKE_SCENARIO:
 *   text        — a few deltas, a `model_end`, `agent_end`, then the result
 *   tool        — prose, then a marker block split across frames
 *   longcat     — prose, then LongCat's own XML block
 *   empty       — no content at all
 *   stalled     — keeps the socket open with comments and never sends content
 */
import { createServer } from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

// Read per request: one long-lived fake server has to serve several scripted
// calls in a row, and a test may want to change what the next one does.
const currentScenario = () =>
  process.env.FAKE_SCENARIO_FILE
    ? readFileSync(process.env.FAKE_SCENARIO_FILE, "utf8").trim() || "text"
    : process.env.FAKE_SCENARIO ?? "text";
const scenario = currentScenario();
const logPath = process.env.FAKE_CLI_LOG ?? "";

// One line per process, so a test can tell a restart from a reused server.
if (logPath) appendFileSync(logPath, `${JSON.stringify({ event: "server-start", pid: process.pid })}\n`);

const corpus = {
  text: "先说明一下，这是一段用于测试的连续文本，会被拆成很多帧送出去。",
  tool: "我来看一下。",
  longcat: "我先确认一下。",
  reasoning: "先想清楚再回答。",
  bracket: "我来读一下文件。",
  empty: "",
  stalled: "",
};

const REASONING = "第一步，理解问题。第二步，给出结论。";

function frames(answer) {
  const out = [];
  if (scenario === "stalled") {
    out.push(null); // no frames at all: the caller keeps the socket open
    return out;
  }
  if (scenario === "bracket") {
    // exactly what a real session produced when the model copied the old
    // transcript rendering instead of emitting the protocol
    const line = '[tool call: dsh_read {"file_path":"/tmp/a.js","todos":[1,2]}]';
    for (let i = 0; i < answer.length; i += 3) out.push({ type: "model_chunk", data: { content: answer.slice(i, i + 3) } });
    for (let i = 0; i < line.length; i += 5) out.push({ type: "model_chunk", data: { content: line.slice(i, i + 5) } });
    out.push({ type: "turn_end", data: { turn: 1, conversationId: "fake-conversation" } });
    out.push({ type: "agent_end", data: { reason: "completed", conversationId: "fake-conversation" } });
    return out;
  }
  if (scenario === "reasoning") {
    for (let i = 0; i < REASONING.length; i += 3) {
      out.push({ type: "model_chunk", data: { reasoningContent: REASONING.slice(i, i + 3) } });
    }
    for (let i = 0; i < answer.length; i += 3) {
      out.push({ type: "model_chunk", data: { content: answer.slice(i, i + 3) } });
    }
    out.push({
      type: "model_end",
      data: {
        message: {
          content: [
            { type: "reasoning", text: REASONING },
            { type: "text", text: answer },
          ],
        },
      },
    });
    out.push({ type: "turn_end", data: { turn: 1, conversationId: "fake-conversation" } });
    out.push({ type: "agent_end", data: { reason: "completed", conversationId: "fake-conversation" } });
    return out;
  }
  if (scenario === "tool") {
    for (let i = 0; i < answer.length; i += 2) {
      out.push({ type: "model_chunk", data: { content: answer.slice(i, i + 2) } });
    }
    const block =
      "<<<catpaw_tool_call>>>[{\"name\":\"dsh_bash\",\"arguments\":{\"command\":\"cat /tmp/probe.txt\"}}]<<<end_catpaw_tool_call>>>";
    // split so the marker straddles several frames, which is the hard case
    for (let i = 0; i < block.length; i += 7) {
      out.push({ type: "model_chunk", data: { content: block.slice(i, i + 7) } });
    }
  } else if (scenario === "longcat") {
    for (let i = 0; i < answer.length; i += 2) {
      out.push({ type: "model_chunk", data: { content: answer.slice(i, i + 2) } });
    }
    const block =
      "<longcat_tool_call>bash\n<longcat_arg_key>command</longcat_arg_key>\n<longcat_arg_value>ls</longcat_arg_value>\n</longcat_tool_call>";
    for (let i = 0; i < block.length; i += 5) {
      out.push({ type: "model_chunk", data: { content: block.slice(i, i + 5) } });
    }
  } else {
    for (let i = 0; i < answer.length; i += 3) {
      out.push({ type: "model_chunk", data: { content: answer.slice(i, i + 3) } });
    }
  }
  out.push({ type: "model_end", data: { message: { content: [{ type: "text", text: scenario === "tool" ? "" : answer }] } } });
  out.push({ type: "turn_end", data: { turn: 1, conversationId: "fake-conversation" } });
  out.push({
    type: "agent_end",
    data: {
      reason: process.env.FAKE_END_REASON ?? "completed",
      conversationId: "fake-conversation",
    },
  });
  return out;
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let message = {};
    try {
      message = JSON.parse(body || "{}");
    } catch {}
    if (logPath) appendFileSync(logPath, `${JSON.stringify(message)}\n`);

    if (message.method === "agent.stop") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { status: "stopped" } }),
      );
      return;
    }

    if (!message.stream) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { status: "completed", conversationId: "fake-conversation" } }),
      );
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const scenario = currentScenario();
    if (scenario === "stalled") {
      // Keep the socket open and send nothing: this is what a stalled backend
      // looks like to the adapter.
      res.write(": keep-alive\n\n");
      return;
    }
    for (const event of frames(corpus[scenario] ?? "")) {
      if (event === null) continue;
      res.write(`data: ${JSON.stringify({ event })}\n\n`);
    }
    res.write(
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { status: "completed", conversationId: "fake-conversation" } })}\n\n`,
    );
    res.end();
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  // the plugin only needs to see the address somewhere on stdout
  process.stdout.write(`catpaw-cli server listening on http://127.0.0.1:${port}\n`);
  if (process.env.FAKE_CLI_READY) writeFileSync(process.env.FAKE_CLI_READY, String(port));
});
