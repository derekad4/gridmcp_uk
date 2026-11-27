import type { OpenAI } from "@workspace/integrations-openai-ai-server";
import { ToolError } from "../elexon";

export const ASK_MODEL = "gpt-6-luna";
export const ASK_REASONING_EFFORT = "medium" as const;
// Reasoning tokens share Luna's output budget; leave headroom for final JSON plans.
export const ASK_MAX_OUTPUT_TOKENS = 16384;
const MODEL_TIMEOUT_MS = 120000;

export type ChatInput = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
export type ChatResult = OpenAI.Chat.Completions.ChatCompletion;
type ResponsesInput = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type ResponsesResult = OpenAI.Responses.Response;

function text(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("");
}

/** Keeps the engine's provider-neutral transcript while sending GPT-6 Luna's Responses API shape. */
export function toResponsesRequest(input: ChatInput): ResponsesInput {
  const items: OpenAI.Responses.ResponseInputItem[] = [];
  for (const message of input.messages) {
    if (message.role === "tool") {
      items.push({ type: "function_call_output", call_id: message.tool_call_id, output: text(message.content) });
    } else if (message.role === "assistant") {
      const content = text(message.content);
      if (content) items.push({ role: "assistant", content });
      for (const call of message.tool_calls ?? []) {
        if (call.type === "function") items.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    } else if (message.role === "system" || message.role === "developer" || message.role === "user") {
      items.push({ role: message.role, content: text(message.content) });
    }
  }
  const tools: OpenAI.Responses.FunctionTool[] = (input.tools ?? []).flatMap((tool) => tool.type === "function" ? [{
    type: "function" as const,
    name: tool.function.name,
    description: tool.function.description ?? null,
    parameters: (tool.function.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
    strict: false,
  }] : []);
  return {
    model: ASK_MODEL,
    input: items,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: ASK_REASONING_EFFORT },
    max_output_tokens: ASK_MAX_OUTPUT_TOKENS,
    store: false,
  };
}

export function fromResponsesResult(response: ResponsesResult): ChatResult {
  const toolCalls = response.output.flatMap((item) => item.type === "function_call" ? [{
    id: item.call_id, type: "function" as const, function: { name: item.name, arguments: item.arguments },
  }] : []);
  const content = response.output_text ?? "";
  if (response.status === "incomplete" && !toolCalls.length) {
    throw new ToolError(response.incomplete_details?.reason === "max_output_tokens"
      ? "The AI analysis reached its output limit before finishing. No incomplete answer was saved; please retry or ask for fewer visuals."
      : "The AI service returned an incomplete analysis. No incomplete answer was saved; please retry.", 502);
  }
  if (response.status === "failed") throw new ToolError("The AI service could not complete the analysis. Please retry.", 502);
  return {
    id: response.id,
    object: "chat.completion",
    created: response.created_at,
    model: response.model,
    choices: [{
      index: 0,
      finish_reason: toolCalls.length ? "tool_calls" : "stop",
      logprobs: null,
      message: { role: "assistant", content: toolCalls.length && !content ? null : content, refusal: null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    }],
    usage: {
      prompt_tokens: response.usage?.input_tokens ?? 0,
      completion_tokens: response.usage?.output_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
    },
  };
}

export async function callAskModel(input: ChatInput, signal: AbortSignal) {
  // Lazy import keeps MCP features available if the managed AI connection is absent.
  const { openai } = await import("@workspace/integrations-openai-ai-server");
  const response = await openai.responses.create(toResponsesRequest(input), { signal, timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
  return fromResponsesResult(response);
}
