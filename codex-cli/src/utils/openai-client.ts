import type { AppConfig } from "./config.js";

import {
  getBaseUrl,
  getApiKey,
  AZURE_OPENAI_API_VERSION,
  OPENAI_TIMEOUT_MS,
  OPENAI_ORGANIZATION,
  OPENAI_PROJECT,
} from "./config.js";
import OpenAI, { AzureOpenAI } from "openai";

type OpenAIClientConfig = {
  provider: string;
};

/**
 * Creates an OpenAI client instance based on the provided configuration.
 * Handles both standard OpenAI and Azure OpenAI configurations.
 *
 * @param config The configuration containing provider information
 * @returns An instance of either OpenAI or AzureOpenAI client
 */
export function createOpenAIClient(
  config: OpenAIClientConfig | AppConfig,
): OpenAI | AzureOpenAI {
  const headers: Record<string, string> = {};
  const lowerCaseProvider = config.provider?.toLowerCase();

  if (lowerCaseProvider === "openai") {
    if (OPENAI_ORGANIZATION) {
      headers["OpenAI-Organization"] = OPENAI_ORGANIZATION;
    }
    if (OPENAI_PROJECT) {
      headers["OpenAI-Project"] = OPENAI_PROJECT;
    }
  }

  if (lowerCaseProvider === "azure") {
    return new AzureOpenAI({
      apiKey: getApiKey(config.provider),
      baseURL: getBaseUrl(config.provider),
      apiVersion: AZURE_OPENAI_API_VERSION,
      timeout: OPENAI_TIMEOUT_MS,
      defaultHeaders: headers,
    });
  }

  const commonOptions = {
    apiKey: getApiKey(config.provider),
    baseURL: getBaseUrl(config.provider),
    timeout: OPENAI_TIMEOUT_MS,
    defaultHeaders: headers,
  };

  if (config.provider?.toLowerCase() === "gemini") {
    // Using console.log as the main `log` utility might not be set up here or could be circular
    // console.log("[openai-client] Applying dangerouslyAllowBrowser: true for Gemini provider");
  return new OpenAI({
      ...commonOptions,
      dangerouslyAllowBrowser: true,
    });
  }

  /* if (config.provider?.toLowerCase() === 'deepseek') {
    console.log(`[openai-client.ts DEBUG] For DeepSeek, commonOptions.apiKey starts: ${commonOptions.apiKey?.substring(0,5)}, ends: ${commonOptions.apiKey?.substring(commonOptions.apiKey.length - 4)}, commonOptions.baseURL: ${commonOptions.baseURL}`);
  } */
  return new OpenAI(commonOptions);
}
