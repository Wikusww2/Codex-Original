// Defines the available slash commands and their descriptions.
// Used for autocompletion in the chat input.

export interface SlashCommand {
  command: string;
  description: string;
  getArguments?: (
    currentInput: string,
    context?: {
      providers?: Record<
        string,
        { name: string; baseURL: string; envKey: string }
      >;
      models?: string[];
    },
  ) => string[];
}

export const SLASH_COMMANDS: Array<SlashCommand> = [
  {
    command: "/clear",
    description: "Clear conversation history and free up context",
  },
  {
    command: "/clearhistory",
    description: "Clear command history",
  },
  {
    command: "/compact",
    description:
      "Clear conversation history but keep a summary in context. Optional: /compact [instructions for summarization]",
  },
  { command: "/history", description: "Open command history" },
  { command: "/sessions", description: "Browse previous sessions" },
  { command: "/help", description: "Show list of commands" },
  {
    command: "/model",
    description: "Switch the AI model (e.g., /model o4-mini)",
    getArguments: (
      currentArgInput: string,
      context?: {
        providers?: Record<
          string,
          { name: string; baseURL: string; envKey: string }
        >;
        models?: string[];
      },
    ) => {
      const availableModels = context?.models || [];
      if (currentArgInput === "") {
        return availableModels; // Show all available models if no argument typed
      }
      const argQuery = currentArgInput.toLowerCase();
      return availableModels.filter((model) =>
        model.toLowerCase().startsWith(argQuery),
      );
    },
  },
  { command: "/approval", description: "Open approval mode selection panel" },
  {
    command: "/bug",
    description: "Generate a prefilled GitHub issue URL with session log",
  },
  {
    command: "/diff",
    description:
      "Show git diff of the working directory (or applied patches if not in git)",
  },
  {
    command: "/provider",
    description: "Change the AI provider (e.g., /provider Deepseek)",
    getArguments: (
      currentArgInput: string,
      context?: {
        providers?: Record<
          string,
          { name: string; baseURL: string; envKey: string }
        >;
        models?: string[];
      },
    ) => {
      const providerKeys = context?.providers
        ? Object.keys(context.providers)
        : [];
      if (currentArgInput === "") {
        return providerKeys; // Show all providers if no argument has been typed yet (e.g. after "/provider ")
      }
      const argQuery = currentArgInput.toLowerCase();
      return providerKeys.filter((key) =>
        key.toLowerCase().startsWith(argQuery),
      );
    },
  },
];
