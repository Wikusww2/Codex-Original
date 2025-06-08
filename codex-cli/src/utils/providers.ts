export const providers: Record<
  string,
  { name: string; baseURL: string; envKey: string; defaultModel: string; }
> = {
  openai: {
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-4.1-nano",
  },
  openrouter: {
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "nous-hermes-2-mixtral-8x7b-dpo", // Example, user should verify
  },
  azure: {
    name: "AzureOpenAI",
    baseURL: "https://YOUR_PROJECT_NAME.openai.azure.com/openai",
    envKey: "AZURE_OPENAI_API_KEY",
    defaultModel: "gpt-35-turbo", // Example, user needs to deploy a model
  },
  gemini: {
    name: "Gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-pro", // Example
  },
  ollama: {
    name: "Ollama",
    baseURL: "http://localhost:11434/v1",
    envKey: "OLLAMA_API_KEY",
    defaultModel: "llama2",
  },
  mistral: {
    name: "Mistral",
    baseURL: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
    defaultModel: "mistral-small-latest",
  },
  deepseek: {
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    envKey: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
  },
  xai: {
    name: "xAI",
    baseURL: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
    defaultModel: "grok-1", // Example
  },
  groq: {
    name: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    defaultModel: "llama3-8b-8192", // Example
  },
  arceeai: {
    name: "ArceeAI",
    baseURL: "https://conductor.arcee.ai/v1",
    envKey: "ARCEEAI_API_KEY",
    defaultModel: "arcee-model", // Example, user should verify
  },
};
