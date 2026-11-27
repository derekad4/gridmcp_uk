import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenAI } from "@workspace/integrations-openai-ai-server";
import { ASK_MAX_OUTPUT_TOKENS, ASK_MODEL, fromResponsesResult, toResponsesRequest } from "./model";
import { ToolError } from "../elexon";

test("Ask uses GPT-6 Luna through Responses API with reasoning and function tools", () => {
  const request = toResponsesRequest({
    model: "ignored",
    max_completion_tokens: 1,
    messages: [
      { role: "system", content: "rules" },
      { role: "user", content: "question" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "discover_tools", arguments: "{\"query\":\"fuel\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "[]" },
    ],
    tools: [{ type: "function", function: { name: "discover_tools", description: "find", parameters: { type: "object", properties: {} } } }],
  });
  assert.equal(request.model, ASK_MODEL);
  assert.equal(request.model, "gpt-6-luna");
  assert.deepEqual(request.reasoning, { effort: "medium" });
  assert.equal(request.max_output_tokens, ASK_MAX_OUTPUT_TOKENS);
  assert.equal(request.store, false);
  assert.deepEqual(request.input, [
    { role: "system", content: "rules" },
    { role: "user", content: "question" },
    { type: "function_call", call_id: "call_1", name: "discover_tools", arguments: "{\"query\":\"fuel\"}" },
    { type: "function_call_output", call_id: "call_1", output: "[]" },
  ]);
  assert.deepEqual(request.tools, [{ type: "function", name: "discover_tools", description: "find", parameters: { type: "object", properties: {} }, strict: false }]);
});

test("Responses API output is normalised for the existing analysis loop", () => {
  const base = { id: "resp_1", created_at: 1, model: "gpt-6-luna", status: "completed", incomplete_details: null, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  const calls = fromResponsesResult({ ...base, output_text: "", output: [{ type: "function_call", call_id: "call_2", name: "calculate_dataset", arguments: "{}" }] } as unknown as OpenAI.Responses.Response);
  assert.equal(calls.choices[0].message.tool_calls?.[0].id, "call_2");
  assert.equal(calls.usage?.total_tokens, 15);
  const final = fromResponsesResult({ ...base, output_text: "{\"title\":\"x\"}", output: [] } as unknown as OpenAI.Responses.Response);
  assert.equal(final.choices[0].message.content, "{\"title\":\"x\"}");
  assert.throws(() => fromResponsesResult({ ...base, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: "{", output: [] } as unknown as OpenAI.Responses.Response), ToolError);
});
