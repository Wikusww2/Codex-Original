import type { AppConfig } from "./config.js";

import { log } from "./logger/log.js";
import OpenAI from "openai";
import type { Stream } from "openai/streaming.mjs";
import type { ChatCompletion, ChatCompletionChunk, ChatCompletionCreateParams, ChatCompletionCreateParamsNonStreaming, ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";

// Overloaded function signatures
export async function completionsCreate(
  oai: OpenAI,
  params: ChatCompletionCreateParamsNonStreaming,
  config: AppConfig,
): Promise<ChatCompletion>;

export async function completionsCreate(
  oai: OpenAI,
  params: ChatCompletionCreateParamsStreaming,
  config: AppConfig,
): Promise<Stream<ChatCompletionChunk>>;

// Implementation
export async function completionsCreate(
  oai: OpenAI,
  params: ChatCompletionCreateParams,
  config: AppConfig,
): Promise<ChatCompletion | Stream<ChatCompletionChunk>> {
  const requestOptions: OpenAI.RequestOptions = {};

  // Ensure we have an API key before proceeding.
  if (!config.apiKey) {
    const errorMessage = `API key for provider '${config.provider}' is not configured.`;
    log(`[completions.ts] ${errorMessage}`);
    throw new Error(errorMessage);
  }

  // Provider-specific adjustments
  if (config.provider?.toLowerCase() === "deepseek") {
    requestOptions.path = "/chat/completions";
  }

  log(`[completions.ts] Requesting completion with params: ${JSON.stringify(params, null, 2)}`);

  if (params.stream) {
    return oai.chat.completions.create(
      params as ChatCompletionCreateParams.ChatCompletionCreateParamsStreaming,
      requestOptions,
    );
  } else {
    return oai.chat.completions.create(
      params as ChatCompletionCreateParams.ChatCompletionCreateParamsNonStreaming,
      requestOptions,
    );
  }
}
