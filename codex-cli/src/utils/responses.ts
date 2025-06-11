import type { AppConfig } from "./config.js";
import { completionsCreate } from "./completions.js";
import { loadConfig } from "./config.js";
import { openAiModelInfo } from "./model-info.js"; // Added import
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionCreateParams,
  ChatCompletionChunk,
  ChatCompletion,
  ChatCompletionMessageToolCall,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";

import { log } from "./logger/log";
import type {
  ResponseCreateParams,
  Response,
  Tool,
  FunctionTool,
} from "openai/resources/responses/responses";

// Define interfaces based on OpenAI API documentation
export type ResponseCreateInput = ResponseCreateParams & { max_tokens?: number };
export type ResponseOutput = Response;

// Interface for accumulating tool call data during streaming
interface ToolCallData {
  id: string;
  name: string;
  arguments: string;
  // type: "function"; // Implicitly function for now
}

export type ResponseEvent =
  | { type: "response.created"; response: Partial<ResponseOutput> }
  | { type: "response.in_progress"; response: Partial<ResponseOutput> }
  | {
      type: "response.output_item.added";
      output_index: number;
      item: {
        type: string;
        id?: string;
        status?: string;
        role?: string;
        content?: Array<{
          type: string;
          [key: string]: unknown;
        }>;
        [key: string]: unknown;
      };
    }
  | {
      type: "response.content_part.added";
      item_id: string;
      output_index: number;
      content_index: number;
      part: {
        type: string;
        [key: string]: unknown;
      };
    }
  | {
      type: "response.output_text.delta";
      item_id: string;
      output_index: number;
      content_index: number;
      delta: string;
    }
  | {
      type: "response.output_text.done";
      item_id: string;
      output_index: number;
      content_index: number;
      text: string;
    }
  | {
      type: "response.function_call_arguments.delta";
      item_id: string;
      output_index: number;
      content_index: number;
      delta: string;
    }
  | {
      type: "response.function_call_arguments.done";
      item_id: string;
      output_index: number;
      content_index: number;
      arguments: string;
    }
  | {
      type: "response.content_part.done";
      item_id: string;
      output_index: number;
      content_index: number;
      part: {
        type: string;
        [key: string]: unknown;
      };
    }
  | {
      type: "response.output_item.done";
      output_index: number;
      item: {
        type: string;
        id?: string;
        status?: string;
        role?: string;
        content?: Array<{
          type: string;
          [key: string]: unknown;
        }>;
        [key: string]: unknown;
      };
    }
  | { type: "response.completed"; response: ResponseOutput }
  | { type: "error"; code: string; message: string; param: string | null };

// Global map to store conversation histories
const conversationHistories = new Map<
  string,
  {
    previous_response_id: string | null;
    messages: Array<ChatCompletionMessageParam>;
  }
>();

// Utility function to generate unique IDs
function generateId(prefix: string = "msg"): string {
  return `${prefix}_${Math.random().toString(36).substr(2, 9)}`;
}

// Function to convert ResponseInputItem to ChatCompletionMessageParam
type ResponseInputItem = ResponseCreateInput["input"][number];

function convertInputItemToMessage(
  item: string | ResponseInputItem,
): ChatCompletionMessageParam {
  if (typeof item === "string") {
    return { role: "user", content: item };
  }
  // Use correct type for function tool call messages
  const { role, content, name, tool_calls, tool_call_id } = item as any; // fallback to any for union
  const message: ChatCompletionMessageParam = { role };
  if (content) message.content = content;
  if (name) (message as any).name = name;
  if (tool_calls) (message as any).tool_calls = tool_calls;
  if (tool_call_id) (message as any).tool_call_id = tool_call_id;
  return message;
}

// Function to get full messages including history
function getFullMessages(
  input: ResponseCreateInput,
): Array<ChatCompletionMessageParam> {
  let fullMessages: Array<ChatCompletionMessageParam> = [];
  if (input.previous_response_id) {
    const history = conversationHistories.get(input.previous_response_id);
    if (history) {
      fullMessages = [...history.messages];
    }
  }

  // Add current input messages
  if (Array.isArray(input.input)) {
    fullMessages.push(
      ...input.input.map((item) => convertInputItemToMessage(item)),
    );
  } else if (input.input) {
    fullMessages.push(convertInputItemToMessage(input.input));
  }

  // Add system message if provided
  if (input.instructions) {
    fullMessages.unshift({ role: "system", content: input.instructions });
  }
  return fullMessages;
}

// Function to convert tools
function convertTools(
  tools?: ResponseCreateInput["tools"],
): Array<ChatCompletionTool> | undefined {
  if (!tools) return undefined;
  return tools.map((tool: Tool) => {
    if (tool.type === "function") {
      const functionTool = tool as FunctionTool;
      return {
        type: "function",
        function: {
          name: functionTool.name,
          description: functionTool.description ?? undefined,
          parameters: functionTool.parameters ?? {},
        },
      };
    }
    if (tool.type === "web_search_preview") {
      // Pass through all valid web search tool options
      const { user_location, search_context_size } = tool as any;
      const webTool: any = { type: "web_search_preview" };
      if (user_location) webTool.user_location = user_location;
      if (search_context_size) webTool.search_context_size = search_context_size;
      return webTool;
    }
    throw new Error(`Unsupported tool type: ${tool.type}`);
  });
}

// Helper function to create completion
const createCompletion = async (
  openai: OpenAI,
  input: ResponseCreateInput,
  sessionConfig: AppConfig, // Ensure sessionConfig is always provided
): Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>> => {
  if (!sessionConfig.apiKey) {
    // It's crucial to have an API key. If not, we should stop early.
    // Consider if this should be a more specific error or handled by the caller.
    log(
      `[createCompletion] API key for provider '${sessionConfig.provider}' is not configured.`,
    );
    throw new Error(
      `API key for provider '${sessionConfig.provider}' is not configured. Please set it in the configuration.`,
    );
  }

  const modelInfo = openAiModelInfo[input.model as keyof typeof openAiModelInfo];
  const messages = getFullMessages(input);

  let chatInputParams: ChatCompletionCreateParams;

  if (modelInfo?.usesWebSearchOptions) {
    chatInputParams = {
      model: input.model,
      messages,
      stream: input.stream ?? false,
      web_search_options: {
        search_context_size: sessionConfig.search_context_size || "medium",
      },
      max_tokens: input.max_tokens ?? sessionConfig.max_tokens ?? undefined,
      user: input.user ?? undefined,
    };
  } else {
    let tools: Array<ChatCompletionTool> = convertTools(input.tools) ?? [];
    const webAccess = sessionConfig.webAccess ?? false;
    const isOpenAI = !sessionConfig.provider || sessionConfig.provider.toLowerCase() === "openai";

    if (webAccess && isOpenAI && !tools.some((tool: any) => tool.type === "web_search_preview")) {
      const webSearchTool: any = { type: "web_search_preview" };
      if (sessionConfig.user_location) webSearchTool.user_location = sessionConfig.user_location;
      if (sessionConfig.search_context_size) webSearchTool.search_context_size = sessionConfig.search_context_size;
      tools.push(webSearchTool);
    }

    chatInputParams = {
      model: input.model,
      messages,
      stream: input.stream ?? false,
      temperature: input.temperature ?? sessionConfig.temperature ?? 0.7,
      top_p: input.top_p ?? sessionConfig.top_p ?? undefined,
      max_tokens: input.max_tokens ?? sessionConfig.max_tokens ?? undefined,
    };

    if (input.user) {
      chatInputParams.user = input.user;
    }

    if (tools.length > 0) {
      chatInputParams.tools = tools;
      if (input.tool_choice) {
        chatInputParams.tool_choice = input.tool_choice as ChatCompletionToolChoiceOption;
      } else if (webAccess && isOpenAI && tools.some((tool: any) => tool.type === "web_search_preview")) {
        chatInputParams.tool_choice = { type: "web_search_preview" } as any;
      } else {
        chatInputParams.tool_choice = "auto";
      }
    }
  }

  // By checking the stream property, we help TypeScript resolve the correct overload.
  if (chatInputParams.stream) {
    return completionsCreate(openai, chatInputParams, sessionConfig);
  } else {
    return completionsCreate(openai, chatInputParams, sessionConfig);
  }
};

// Non-streaming implementation
async function nonStreamResponses(
  input: ResponseCreateInput,
  completion: ChatCompletion,
): Promise<ResponseOutput> {
  const fullMessages = getFullMessages(input);

  try {
    const chatResponse = completion;
    if (!("choices" in chatResponse) || chatResponse.choices.length === 0) {
      throw new Error("No choices in chat completion response");
    }
    const assistantMessage = chatResponse.choices?.[0]?.message;
    if (!assistantMessage) {
      throw new Error("No assistant message in chat completion response");
    }

    const responseId = generateId("resp");
    const outputItemId = generateId("msg");
    const outputContent: Array<import("openai/resources/responses/responses").ResponseOutputText | import("openai/resources/responses/responses").ResponseOutputRefusal> = [];

    const hasFunctionCalls =
      assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0;

    if (assistantMessage.content) {
      outputContent.push({
        type: "output_text",
        text: assistantMessage.content,
        annotations: [],
      });
    }

    const responseOutput: ResponseOutput = {
      id: responseId,
      object: "response" as const,
      created_at: Math.floor(Date.now() / 1000),
      status: hasFunctionCalls ? ("in_progress" as const) : ("completed" as const),
      error: null,
      output: [
        {
          type: "message" as const,
          id: outputItemId,
          status: "completed" as const,
          role: "assistant" as const,
          content: outputContent,
        },
        // If there are function calls, add them as separate output items
        ...(
          hasFunctionCalls && assistantMessage.tool_calls
            ? assistantMessage.tool_calls.map((toolCall) => ({
                type: "function_call" as const,
                call_id: toolCall.id,
                name: toolCall.function.name,
                arguments: toolCall.function.arguments,
              }))
            : []
        ),
      ],
      parallel_tool_calls: input.parallel_tool_calls ?? false,
      previous_response_id: input.previous_response_id ?? null,
      reasoning: null,
      temperature: input.temperature ?? null,
      text: { format: { type: "text" as const } },
      tool_choice: input.tool_choice ?? ("auto" as const),
      tools: input.tools ?? [],
      top_p: input.top_p ?? null,
      truncation: input.truncation ?? ("disabled" as const),
      usage: chatResponse.usage
        ? {
            input_tokens: chatResponse.usage.prompt_tokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: chatResponse.usage.completion_tokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: chatResponse.usage.total_tokens,
          }
        : undefined,
      user: input.user ?? undefined,
      metadata: input.metadata ?? {},
      output_text: assistantMessage.content || "",
      incomplete_details: null,
      instructions: input.instructions ?? null,
      model: chatResponse.model,
    };

    if (hasFunctionCalls && assistantMessage.tool_calls) {
      type ResponseWithAction = ResponseOutput & {
        required_action: {
          type: "submit_tool_outputs";
          submit_tool_outputs: {
            tool_calls: Array<{
              id: string;
              type: "function";
              function: { name: string; arguments: string };
            }>;
          };
        };
      };
      (responseOutput as ResponseWithAction).required_action = {
        type: "submit_tool_outputs",
        submit_tool_outputs: {
          tool_calls: assistantMessage.tool_calls.map(
            (toolCall: ChatCompletionMessageToolCall) => ({
              id: toolCall.id,
              type: toolCall.type as "function",
              function: {
                name: toolCall.function.name,
                arguments: toolCall.function.arguments,
              },
            }),
          ),
        },
      };
    }

    const newHistory = [...fullMessages, assistantMessage];
    conversationHistories.set(responseId, {
      previous_response_id: input.previous_response_id ?? null,
      messages: newHistory,
    });

    return responseOutput;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`[responses.ts] Error in nonStreamResponses: ${errorMessage}`);
    throw new Error(
      `Failed to process non-streaming chat completion: ${errorMessage}`,
    );
  }
}

// Streaming implementation
async function* streamResponses(
  input: ResponseCreateInput,
  completionStream: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<ResponseEvent> {
  const fullMessages = getFullMessages(input);
  const responseId = generateId("resp");
  const outputItemId = generateId("msg");
  let textContentAdded = false;
  let textContent = "";
  const toolCalls = new Map<number, ToolCallData>();
  let usage: import("openai/resources/responses/responses").ResponseUsage | null = null;
  const finalOutputItemAccumulator: Array<import("openai/resources/responses/responses").ResponseOutputItem> = [];
  let currentModel = input.model; // Initialize with input model

  const initialResponse: Partial<ResponseOutput> = {
    id: responseId,
    object: "response" as const,
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress" as const,
    model: currentModel,
    output: [],
    error: null,
    incomplete_details: null,
    instructions: input.instructions ?? null,
    max_output_tokens: input.max_output_tokens ?? null,
    parallel_tool_calls: input.parallel_tool_calls ?? true, // Default to true for streaming
    previous_response_id: input.previous_response_id ?? null,
    reasoning: null,
    temperature: input.temperature,
    text: { format: { type: "text" as const } },
    tool_choice: input.tool_choice ?? ("auto" as const),
    tools: input.tools ?? [],
    top_p: input.top_p,
    truncation: input.truncation ?? ("disabled" as const),
    usage: undefined,
    user: input.user ?? undefined,
    metadata: input.metadata ?? {},
    output_text: "",
  };
  yield { type: "response.created", response: initialResponse };
  yield { type: "response.in_progress", response: initialResponse };

  let assistantMessageForHistory: ChatCompletionMessageParam = {
    role: "assistant",
    content: null, // Initialize content as null
  };
  const toolCallsForHistory: ChatCompletionMessageToolCall[] = [];

  try {
    for await (const chunk of completionStream) {
      if (chunk.model) currentModel = chunk.model; // Update model if present in chunk

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.prompt_tokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: chunk.usage.completion_tokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: chunk.usage.total_tokens,
        };
      }

      if (choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
        for (const tcDelta of choice.delta.tool_calls) {
          if (tcDelta.index === undefined) continue; // Should not happen with SDK v4
          const tcIndex = tcDelta.index;

          if (!toolCalls.has(tcIndex)) {
            const toolCallId = tcDelta.id || generateId("call");
            const functionName = tcDelta.function?.name || "";
            toolCalls.set(tcIndex, {
              id: toolCallId,
              name: functionName,
              arguments: "",
            });
            yield {
              type: "response.output_item.added",
              output_index: tcIndex,
              item: {
                type: "function_call",
                id: outputItemId, // This might need to be unique per tool call item
                status: "in_progress",
                call_id: toolCallId,
                name: functionName,
                arguments: "",
              },
            };
          }

          const currentToolCall = toolCalls.get(tcIndex)!;
          if (tcDelta.id) currentToolCall.id = tcDelta.id; // Update ID if provided
          if (tcDelta.function?.name) currentToolCall.name = tcDelta.function.name;
          if (tcDelta.function?.arguments) {
            currentToolCall.arguments += tcDelta.function.arguments;
            yield {
              type: "response.function_call_arguments.delta",
              item_id: outputItemId,
              output_index: tcIndex,
              content_index: tcIndex, // Assuming one content part per tool call item
              delta: tcDelta.function.arguments,
            };
          }
        }
      }

      if (choice.delta.content) {
        if (!textContentAdded) {
          yield {
            type: "response.content_part.added",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          };
          textContentAdded = true;
        }
        textContent += choice.delta.content;
        assistantMessageForHistory.content = textContent; // Update history message content
        yield {
          type: "response.output_text.delta",
          item_id: outputItemId,
          output_index: 0,
          content_index: 0,
          delta: choice.delta.content,
        };
      }

      if (choice.finish_reason) {
        if (textContentAdded) {
          const textOutputItem: import("openai/resources/responses/responses").ResponseOutputText = {
            type: "output_text",
            text: textContent,
            annotations: [],
          };
          finalOutputItemAccumulator.push({
            type: "message",
            id: outputItemId,
            status: "completed",
            role: "assistant",
            content: [textOutputItem],
          });
          yield {
            type: "response.output_text.done",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            text: textContent,
          };
          yield {
            type: "response.content_part.done",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: textContent, annotations: [] },
          };
        }

        if (choice.finish_reason === "tool_calls") {
          for (const [tcIndex, tc] of toolCalls) {
            yield {
              type: "response.function_call_arguments.done",
              item_id: outputItemId,
              output_index: tcIndex,
              content_index: tcIndex,
              arguments: tc.arguments,
            };
            finalOutputItemAccumulator.push({
              type: "function_call",
              call_id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            });
            yield {
              type: "response.output_item.done",
              output_index: tcIndex,
              item: { type: "function_call", id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments, status: "completed" },
            };
            toolCallsForHistory.push({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            });
          }
          if (toolCallsForHistory.length > 0) {
            (assistantMessageForHistory as any).tool_calls = toolCallsForHistory;
          }
        }
      }
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log(`[responses.ts] Error during streaming: ${err.message}`);
    yield {
      type: "error",
      code: "streaming_error",
      message: err.message,
      param: null,
    };
    return;
  } finally {
    // This block executes regardless of try/catch outcome
    // Construct final response object
    const finalResponse: ResponseOutput = {
      ...initialResponse,
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed" as const,
      model: currentModel,
      output: finalOutputItemAccumulator,
      usage: usage ?? undefined,
      output_text: textContent,
      error: null,
      incomplete_details: null,
      instructions: initialResponse.instructions ?? null,
      metadata: initialResponse.metadata ?? null,
      parallel_tool_calls: initialResponse.parallel_tool_calls ?? false,
      temperature: initialResponse.temperature ?? null,
      top_p: initialResponse.top_p ?? null,
      tool_choice: initialResponse.tool_choice ?? "auto",
      tools: initialResponse.tools ?? [],
    };

    // Add tool_calls to history message if they exist
    if (toolCallsForHistory.length > 0) {
        (assistantMessageForHistory as any).tool_calls = toolCallsForHistory;
    } else if (!assistantMessageForHistory.content) {
        // If there was no text content and no tool calls, ensure content is at least an empty string for valid message
        assistantMessageForHistory.content = "";
    }


    const newHistory = [...fullMessages, assistantMessageForHistory];
    conversationHistories.set(responseId, {
      previous_response_id: input.previous_response_id ?? null,
      messages: newHistory,
    });

    yield { type: "response.completed", response: finalResponse };
  }
}

// Main function with overloading
export async function responsesCreateViaChatCompletions(
  openai: OpenAI,
  input: ResponseCreateInput & { stream: true },
  sessionConfig?: AppConfig,
): Promise<AsyncGenerator<ResponseEvent>>;
export async function responsesCreateViaChatCompletions(
  openai: OpenAI,
  input: ResponseCreateInput & { stream?: false },
  sessionConfig?: AppConfig,
): Promise<ResponseOutput>;
export async function responsesCreateViaChatCompletions(
  openai: OpenAI,
  input: ResponseCreateInput,
  sessionConfig?: AppConfig,
): Promise<ResponseOutput | AsyncGenerator<ResponseEvent>> {
  const config = sessionConfig ?? loadConfig();
  if (!config.provider) {
    config.provider = "openai"; // Default to openai if not specified
  }

  const completion = await createCompletion(openai, input, config);

  if (input.stream) {
    return streamResponses(
      input,
      completion as AsyncIterable<ChatCompletionChunk>,
    );
  } else {
    return nonStreamResponses(
      input,
      completion as ChatCompletion, // Corrected type cast
    );
  }
}
