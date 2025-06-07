
// Type Imports
import type { TerminalHeaderProps } from "./terminal-header.js";
import type { BatchEntry } from "./terminal-message-history.js";
import type { AppRollout } from "../../app.js";
import type {
  ApprovalPolicy,
  ApplyPatchCommand,
  SafetyAssessment,
} from "../../approvals.js";
import type { ConfirmationResult } from "../../hooks/use-confirmation.js";
import type { CommandConfirmation } from "../../utils/agent/agent-loop.js";
import type { AppConfig } from "../../utils/config.js";
import type {
  ResponseItem,
  ResponseInputItem,
  ResponseFunctionToolCall,
} from "openai/resources/responses/responses.mjs";
import { v4 as uuidv4 } from 'uuid';

// Codegen utils and core logic

// Hooks

// Local Components
import TerminalChatInput from "./terminal-chat-input.js";
import TerminalChatPastRollout from "./terminal-chat-past-rollout.js";
import {
  TerminalChatToolCallCommand,
  TerminalChatToolCallApplyPatch,
} from "./terminal-chat-tool-call-command.js";
import TerminalMessageHistory from "./terminal-message-history.js";
import pkg from "../../../../package.json" with { type: "json" };
import { formatCommandForDisplay } from "../../format-command.js";
import { useConfirmation } from "../../hooks/use-confirmation.js";
import { AgentLoop } from "../../utils/agent/agent-loop.js";
import { ReviewDecision } from "../../utils/agent/review.js";
import { AutoApprovalMode } from "../../utils/auto-approval-mode.js";
import { generateCompactSummary } from "../../utils/compact-summary.js";
import { saveConfig } from "../../utils/config.js";
import { log } from "../../utils/logger/log.js";
import {
  uniqueById,
  isUserMessage, // Added import for isUserMessage
} from "../../utils/model-utils.js";
import { createOpenAIClient } from "../../utils/openai-client.js";
import ApprovalModeOverlay from "../approval-mode-overlay.js";
import DiffOverlay from "../diff-overlay.js";
import HelpOverlay from "../help-overlay.js";
import HistoryOverlay from "../history-overlay.js";
import ModelOverlay from "../model-overlay.js";
import SessionsOverlay from "../sessions-overlay.js";
import chalk from "chalk";
import fs from "fs/promises";
import { Box, useStdout } from "ink";
import { spawn } from "node:child_process";
import React, { useState, useEffect, useRef, useMemo } from "react";
import { inspect } from "util";

// Local type definitions if not imported
export type OverlayModeType =
  | "none"
  | "history"
  | "sessions"
  | "model"
  | "provider"
  | "approval"
  | "diff"
  | "help";

export type Props = {
  config: AppConfig;
  initialPrompt?: string;
  imagePaths?: Array<string>;
  approvalPolicy: ApprovalPolicy;
  additionalWritableRoots: ReadonlyArray<string>;
  fullStdout: boolean;
};

/**
 * Generates an explanation for a shell command using the OpenAI API.
 *
 * @param command The command to explain
 * @param model The model to use for generating the explanation
 * @param flexMode Whether to use the flex-mode service tier
 * @param config The configuration object
 * @returns A human-readable explanation of what the command does
 */
async function generateCommandExplanation(
  command: Array<string>,
  model: string,
  flexMode: boolean,
  config: AppConfig,
): Promise<string> {
  try {
    // Create a temporary OpenAI client
    const oai = createOpenAIClient(config);

    // Format the command for display
    const commandForDisplay = formatCommandForDisplay(command);

    // Create a prompt that asks for an explanation with a more detailed system prompt
    const response = await oai.chat.completions.create({
      model,
      ...(flexMode ? { service_tier: "flex" } : {}),
      messages: [
        {
          role: "system",
          content:
            "You are an expert in shell commands and terminal operations. Your task is to provide detailed, accurate explanations of shell commands that users are considering executing. Break down each part of the command, explain what it does, identify any potential risks or side effects, and explain why someone might want to run it. Be specific about what files or systems will be affected. If the command could potentially be harmful, make sure to clearly highlight those risks.",
        },
        {
          role: "user",
          content: `Please explain this shell command in detail: \`${commandForDisplay}\`\n\nProvide a structured explanation that includes:\n1. A brief overview of what the command does\n2. A breakdown of each part of the command (flags, arguments, etc.)\n3. What files, directories, or systems will be affected\n4. Any potential risks or side effects\n5. Why someone might want to run this command\n\nBe specific and technical - this explanation will help the user decide whether to approve or reject the command.`,
        },
      ],
    });

    // Extract the explanation from the response
    const explanation =
      response.choices[0]?.message.content || "Unable to generate explanation.";
    return explanation;
  } catch (error: unknown) {
    log(`Error generating command explanation: ${error}`);

    let errorMessage = "Unable to generate explanation due to an error.";
    if (error instanceof Error) {
      errorMessage = `Unable to generate explanation: ${error.message}`;

      // If it's an API error, check for more specific information
      if ("status" in error && typeof error.status === "number") {
        // Handle API-specific errors
        if (error.status === 401) {
          errorMessage =
            "Unable to generate explanation: API key is invalid or expired.";
        } else if (error.status === 429) {
          errorMessage =
            "Unable to generate explanation: Rate limit exceeded. Please try again later.";
        } else if (error.status >= 500) {
          errorMessage =
            "Unable to generate explanation: OpenAI service is currently unavailable. Please try again later.";
        }
      }
    }

    return errorMessage;
  }
}

export const TerminalChat: React.FC<Props> = ({
  config,
  initialPrompt: _initialPromptFromProps,
  imagePaths: _initialImagePathsFromProps,
  approvalPolicy,
  additionalWritableRoots,
  fullStdout,
}: Props): React.ReactElement => {
  useEffect(() => {
  }, [approvalPolicy]);

  const notify = Boolean(config.notify);
  const [model, setModel] = useState<string>(config.model || "gpt-4-turbo");
  const [provider, setProvider] = useState<string>(config.provider || "openai");
  const [lastResponseId, setLastResponseId] = useState<string | null>(null);
  const [items, setItems] = useState<Array<ResponseItem>>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const [, forceRender] = useState(0);
  const forceUpdate = () => forceRender((c) => c + 1);
  const PWD = process.cwd();
  const { stdout } = useStdout();
  const terminalRowsFromHook = stdout.rows;

  const colorsByPolicy: Record<string, string | undefined> = {
    "full-auto": "green",
    [AutoApprovalMode.FULL_AUTO]: "green",
    [AutoApprovalMode.NONE]: "red",
    "needs-confirmation": "yellow",
    "manual": "cyan",
  };

  const {
    requestConfirmation,
    confirmationPrompt,
    explanation: _confirmationHookExplanation,
    submitConfirmation,
  } = useConfirmation();

  const handleCompact = async () => {
    setLoading(true);
    try {
      const summary = await generateCompactSummary(
        items,
        model,
        Boolean(config.flexMode),
        config,
      );
      setItems([
        {
          id: `compact-${Date.now()}`,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: summary }],
        } as ResponseItem,
      ]);
    } catch (err: unknown) {
      setItems((prev) => [
        ...prev,
        {
          id: `compact-error-${Date.now()}`,
          type: "message",
          role: "system",
          content: [
            { type: "input_text", text: `Failed to compact context: ${err}` },
          ],
        } as ResponseItem,
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleSetItemsFromInput = (inputItems: ResponseInputItem[]) => {
    const newItems = inputItems.map((item) => {
      if (item.type === "function_call") {
        const toolCallItem = item as ResponseFunctionToolCall;
        return {
          ...toolCallItem,
          id: toolCallItem.id ?? uuidv4(),
        } as ResponseItem;
      }
      // For other types, ensure they are correctly cast to ResponseItem if necessary.
      // This example assumes other ResponseInputItem types are directly assignable to ResponseItem subtypes
      // or that they don't have the id issue.
      return item as ResponseItem;
    });
    // It's important to ensure that `setItems` receives an array of `ResponseItem`.
    // If `newItems` might not fully conform, further checks or transformations might be needed here.
    setItems(prevItems => {
      // This example replaces the entire list. Depending on requirements,
      // you might want to append or merge.
      // Also, consider if unique IDs are needed across all items if merging.
      const updatedItems = [...prevItems];
      newItems.forEach(newItem => {
        const existingIndex = updatedItems.findIndex(existingItem => existingItem.id === newItem.id);
        if (existingIndex !== -1 && newItem.id !== undefined) {
          updatedItems[existingIndex] = newItem; // Update existing item
        } else {
          updatedItems.push(newItem); // Add new item
        }
      });
      return uniqueById(updatedItems);
    });
  };

  const [overlayMode, setOverlayMode] = useState<OverlayModeType>("none");
  const [viewRollout, setViewRollout] = useState<AppRollout | null>(null);

  const [diffText, _setDiffText] = useState<string>("");

  const [initialPromptFromProps, setInitialPromptFromProps] = useState(
    _initialPromptFromProps,
  );
  const [currentImagePaths, setCurrentImagePaths] = useState(
    _initialImagePathsFromProps, // Initialized with the prop value
  );

  const agentRef = useRef<AgentLoop | null>(null);
  const initialPromptProcessed = useRef(false);
  const prevLoadingRef = useRef<boolean>(loading);

  const [workdir, setWorkdir] = useState<string>(process.cwd());

  const handleWorkdirChange = (newWorkdir: string) => {
    setWorkdir(newWorkdir);
  };

  useEffect(() => {
    if (agentRef.current) {
      log(
        "TerminalChat: Terminating existing AgentLoop due to policy/config change.",
      );
      agentRef.current.terminate();
      agentRef.current = null;
    }

    log(
      `TerminalChat: Initializing AgentLoop with approvalPolicy: ${approvalPolicy}, model: ${model}, provider: ${provider}`,
    );
    agentRef.current = new AgentLoop({
      model: model,
      provider: provider,
      config: config,
      instructions: config.instructions,
      approvalPolicy: approvalPolicy,
      additionalWritableRoots: additionalWritableRoots,
      disableResponseStorage: config.disableResponseStorage,
      onItem: (item: ResponseItem) => {
        setItems((prev) => uniqueById([...prev, item]));
        if (
          item.type === "message" &&
          item.role === "assistant" &&
          item.content &&
          item.content.length > 0
        ) {
        }
      },
      onLoading: setLoading,
      getCommandConfirmation: async (
        safetyAssessment: SafetyAssessment,
        commandForConfirmation: Array<string>,
        applyPatch: ApplyPatchCommand | undefined,
      ): Promise<CommandConfirmation> => {
        // Always auto-approve commands in full-auto or none modes
        if (
          approvalPolicy === "full-auto" ||
          approvalPolicy === AutoApprovalMode.FULL_AUTO ||
          approvalPolicy === AutoApprovalMode.NONE
        ) {
          // Only reject commands that have been explicitly marked as reject
          if (safetyAssessment.type === "reject") {
            return {
              review: ReviewDecision.NO_EXIT,
              customDenyMessage: safetyAssessment.reason,
              applyPatch: undefined,
            };
          }

          // Force approve everything else in full-auto or none modes
          return {
            review: ReviewDecision.YES,
            applyPatch: safetyAssessment.applyPatch ?? applyPatch,
          };
        }

        const explanationText = await generateCommandExplanation(
          commandForConfirmation,
          model,
          config.flexMode ?? false,
          config,
        );

        let promptNode;
        if (applyPatch) {
          promptNode = (
            <TerminalChatToolCallApplyPatch
              commandForDisplay={formatCommandForDisplay(
                commandForConfirmation,
              )}
              patch={applyPatch.patch}
            />
          );
        } else {
          promptNode = (
            <TerminalChatToolCallCommand
              commandForDisplay={formatCommandForDisplay(
                commandForConfirmation,
              )}
            />
          );
        }

        const hookConfirmationResult = await requestConfirmation(
          promptNode,
          explanationText,
        );

        return {
          review: hookConfirmationResult.decision,
          customDenyMessage: hookConfirmationResult.customDenyMessage,
          applyPatch: applyPatch,
          explanation: explanationText,
        };
      },
      onLastResponseId: setLastResponseId,
      onWorkdirChanged: handleWorkdirChange,
    });

    forceUpdate();

    log(`AgentLoop created: ${inspect(agentRef.current, { depth: 1 })}`);

    return () => {
      log("terminating AgentLoop");
      agentRef.current?.terminate();
      agentRef.current = null;
      forceUpdate();
    };
  }, [
    model,
    provider,
    config,
    requestConfirmation,
    additionalWritableRoots,
    workdir,
  ]);

  useEffect(() => {
    let handle: ReturnType<typeof setInterval> | null = null;
    if (loading && confirmationPrompt == null) {
      handle = setInterval(() => {
        // Removed thinkingSeconds state and related logic
      }, 1000);
    } else {
      if (handle) {
        clearInterval(handle);
      }
    }
    return () => {
      if (handle) {
        clearInterval(handle);
      }
    };
  }, [loading, confirmationPrompt]);

  useEffect(() => {
    if (!notify) {
      prevLoadingRef.current = loading;
      return;
    }

    if (
      prevLoadingRef.current &&
      !loading &&
      confirmationPrompt == null &&
      items.length > 0
    ) {
      if (process.platform === "darwin") {
        const assistantMessages = items.filter(
          (i) => i.type === "message" && i.role === "assistant",
        );
        const last = assistantMessages[assistantMessages.length - 1];
        if (last) {
          const text = last.content
            .map((c) => {
              if (c.type === "output_text") {
                return c.text;
              }
              return "";
            })
            .join("")
            .trim();
          const preview = text.replace(/\n/g, " ").slice(0, 100);
          const safePreview = preview.replace(/"/g, '\\"');
          const title = "Codex CLI";
          const cwd = PWD;
          spawn("osascript", [
            "-e",
            `display notification "${safePreview}" with title "${title}" subtitle "${cwd}" sound name "Ping"`,
          ]);
        }
      }
    }
    prevLoadingRef.current = loading;
  }, [notify, loading, confirmationPrompt, items, PWD]);

  const agent = agentRef.current;
  useEffect(() => {
    log(`agentRef.current is now ${Boolean(agent)}`);
  }, [agent]);

  const safeItems = useMemo(() => items ?? [], [items]);
  const batch: Array<BatchEntry> = useMemo(
    () => safeItems.map((item) => ({ item })),
    [safeItems],
  );
  const groupCounts: Record<string, number> = useMemo(() => ({}), []);
  const userMsgCount = useMemo(
    () => safeItems.filter((item) => isUserMessage(item)).length,
    [safeItems],
  ); // Used isUserMessage type guard

  const headerProps: TerminalHeaderProps = {
    terminalRows: terminalRowsFromHook || 24,
    version: (pkg as any).version,
    PWD: workdir || process.cwd(),
    model: model,
    provider: provider,
    approvalPolicy: approvalPolicy,
    colorsByPolicy: colorsByPolicy,
    agent: agentRef.current ?? undefined,
    initialImagePaths: currentImagePaths, // Use renamed state variable for header
    flexModeEnabled: config.flexMode,
    workdir: workdir,
  };

  useEffect(() => {
    const processInitialInput = async () => {
      if (initialPromptProcessed.current || !agentRef.current) {return;}
      if (
        (!initialPromptFromProps || initialPromptFromProps.trim() === "") &&
        (!currentImagePaths || currentImagePaths.length === 0) // Use renamed state variable
      ) {
        return;
      }
      console.log(
        `[TerminalChat] Processing initial prompt: "${initialPromptFromProps}"`,
      );
      if (agentRef.current) {
        const inputs: Array<ResponseInputItem> = [];
        if (initialPromptFromProps && initialPromptFromProps.trim() !== "") {
          inputs.push({
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: initialPromptFromProps }],
          });
        }
        // TODO: Add image handling if currentImagePaths exist

        if (inputs.length > 0) {
          console.log(
            `[TerminalChat] Calling agentRef.current.run with initial inputs. Agent available: ${!!agentRef.current}`,
          );
          agentRef.current.run(inputs, lastResponseId || "");
        } else {
          console.log(
            "[TerminalChat] No initial text prompt or images to process after trim/check.",
          );
        }
      } else {
        console.log(
          "[TerminalChat] Agent not ready for initial prompt processing.",
        );
      }
      initialPromptProcessed.current = true;
      // Clear them to prevent subsequent runs if they are one-time props.
      setInitialPromptFromProps("");
      setCurrentImagePaths([]); // Use renamed setter
    };
    processInitialInput();
  }, [agentRef.current, initialPromptFromProps, currentImagePaths]); // Use renamed state variable in dependencies

  useEffect(() => {
    (async () => {
      log("Model availability check would happen here.");
    })();
    // run once on mount
     
  }, [provider, model]);

  if (viewRollout) {
    return (
      <TerminalChatPastRollout
        fileOpener={config.fileOpener}
        session={viewRollout.session}
        items={viewRollout.items}
      />
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <TerminalMessageHistory
        batch={batch}
        groupCounts={groupCounts}
        items={safeItems}
        userMsgCount={userMsgCount}
        confirmationPrompt={confirmationPrompt}
        loading={loading}
        headerProps={headerProps}
        fullStdout={fullStdout}
        setOverlayMode={setOverlayMode}
        fileOpener={config.fileOpener}
        workdir={workdir}
      />

      <Box flexDirection="column" flexGrow={1}>
        <TerminalChatInput
          loading={loading}
          confirmationPrompt={confirmationPrompt}
          explanation={_confirmationHookExplanation}
          submitConfirmation={(result: ConfirmationResult) => {
            submitConfirmation(result);
          }}
          submitInput={(inputs) => {
            agentRef.current?.run(inputs, lastResponseId || "");
          }}
          setLastResponseId={setLastResponseId}
          setItems={handleSetItemsFromInput}
          openOverlay={() => setOverlayMode("help")}
          openModelOverlay={() => setOverlayMode("model")}
          openProviderOverlay={() => setOverlayMode("provider")}
          openApprovalOverlay={() => setOverlayMode("approval")}
          openHelpOverlay={() => setOverlayMode("help")}
          openDiffOverlay={() => setOverlayMode("diff")}
          openSessionsOverlay={() => setOverlayMode("sessions")}
          onCompact={handleCompact}
          items={safeItems}
          workdir={workdir}
        />
      </Box>

      {overlayMode === "history" && (
        <HistoryOverlay
          items={safeItems}
          onExit={() => setOverlayMode("none")}
        />
      )}
      {overlayMode === "sessions" && (
        <SessionsOverlay
          onView={async (p) => {
            try {
              const txt = await fs.readFile(p, "utf-8");
              const data = JSON.parse(txt) as AppRollout;
              setViewRollout(data);
              setOverlayMode("none");
            } catch {
              setOverlayMode("none");
            }
          }}
          onResume={(p) => {
            setOverlayMode("none");
            setInitialPromptFromProps(`Resume this session: ${p}`);
          }}
          onExit={() => setOverlayMode("none")}
        />
      )}
      {overlayMode === "model" && (
        <ModelOverlay
          currentModel={model}
          providers={config.providers}
          currentProvider={provider}
          hasLastResponse={Boolean(lastResponseId)}
          onSelect={(allModels, newModel) => {
            log(
              "TerminalChat: interruptAgent invoked – calling agent.cancel()",
            );
            if (!agentRef.current) {
              log("TerminalChat: agent is not ready yet");
            }
            agentRef.current?.cancel();
            setLoading(false);

            if (!allModels?.includes(newModel)) {
              console.error(
                chalk.bold.red(
                  `Model "${chalk.yellow(
                    newModel,
                  )}" is not available for provider "${chalk.yellow(
                    provider,
                  )}".`,
                ),
              );
              return;
            }

            setModel(newModel);
            setLastResponseId((prev) =>
              prev && newModel !== model ? null : prev,
            );

            saveConfig({
              ...config,
              model: newModel,
              provider: provider,
            });

            setItems((prev) => [
              ...prev,
              {
                id: `switch-model-${Date.now()}`,
                type: "message",
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: `Switched model to ${newModel}`,
                  },
                ],
              },
            ]);

            setOverlayMode("none");
          }}
          onSelectProvider={(newProvider) => {
            log("TerminalChat: onSelectProvider called for new provider: " + newProvider);
            agentRef.current?.cancel(); // Cancel any ongoing agent activity
            setLoading(false);

            let newModelForProvider = ""; // Default to empty string (forces selection)

            const providerDefaults: Record<string, string> = {
              "openai": "o4-mini", // Default OpenAI model
              "gemini": "gemini-pro", // A common, likely available Gemini model
              // Potentially add other known provider defaults here
            };

            const lowerNewProvider = newProvider.toLowerCase();
            if (providerDefaults[lowerNewProvider]) {
              newModelForProvider = providerDefaults[lowerNewProvider];
              log(`TerminalChat: Found default model '${newModelForProvider}' for provider '${newProvider}'`);
            } else {
              log(`TerminalChat: No specific default model found for provider '${newProvider}'. Model will be cleared.`);
            }

            const oldProvider = provider; // Capture old provider for comparison
            const oldModel = model; // Capture old model for comparison

            setModel(newModelForProvider); // Update the model state
            setProvider(newProvider);     // Update the provider state

            // Update and save the configuration
            const updatedConfig = {
              ...config,
              provider: newProvider,
              model: newModelForProvider,
            };
            saveConfig(updatedConfig);
            log("TerminalChat: Configuration saved with new provider and model.");

            // Reset lastResponseId if provider or model actually changes to ensure fresh context
            setLastResponseId((prevLastResponseId) => {
              if (newProvider !== oldProvider || newModelForProvider !== oldModel) {
                log("TerminalChat: Provider or model changed, resetting lastResponseId.");
                return null;
              }
              return prevLastResponseId;
            });

            // Update chat items with a system message
            setItems((prevItems) => [
              ...prevItems,
              {
                id: `switch-provider-${Date.now()}`,
                type: "message",
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: `Switched provider to ${newProvider}. ${newModelForProvider ? `Model set to '${newModelForProvider}'.` : "Please select a model."}`,
                  },
                ],
              } as ResponseItem, // Type assertion
            ]);
            log("TerminalChat: System message added for provider/model switch.");
            // The ModelOverlay component will automatically re-fetch and display models
            // for the `newProvider` because its `useEffect` hook depends on `currentProvider`.
            // The `currentModel` prop of ModelOverlay will be `newModelForProvider`.
          }}
          onExit={() => setOverlayMode("none")}
        />
      )}
      {overlayMode === "provider" && (
        <ModelOverlay
          currentModel={model}
          providers={config.providers}
          currentProvider={provider}
          hasLastResponse={Boolean(lastResponseId)}
          startMode="provider"
          onSelect={(allModels, newModel) => {
            log(
              "TerminalChat: interruptAgent invoked – calling agent.cancel()",
            );
            if (!agentRef.current) {
              log("TerminalChat: agent is not ready yet");
            }
            agentRef.current?.cancel();
            setLoading(false);

            if (!allModels?.includes(newModel)) {
              console.error(
                chalk.bold.red(
                  `Model "${chalk.yellow(
                    newModel,
                  )}" is not available for provider "${chalk.yellow(
                    provider,
                  )}".`,
                ),
              );
              return;
            }

            setModel(newModel);
            setLastResponseId((prev) =>
              prev && newModel !== model ? null : prev,
            );

            saveConfig({
              ...config,
              model: newModel,
              provider: provider,
            });

            setItems((prev) => [
              ...prev,
              {
                id: `switch-model-${Date.now()}`,
                type: "message",
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: `Switched model to ${newModel}`,
                  },
                ],
              },
            ]);

            setOverlayMode("none");
          }}
          onSelectProvider={(newProvider) => {
            log("TerminalChat: onSelectProvider called for new provider: " + newProvider);
            agentRef.current?.cancel(); // Cancel any ongoing agent activity
            setLoading(false);

            let newModelForProvider = ""; // Default to empty string (forces selection)

            const providerDefaults: Record<string, string> = {
              "openai": "o4-mini", // Default OpenAI model
              "gemini": "gemini-pro", // A common, likely available Gemini model
              // Potentially add other known provider defaults here
            };

            const lowerNewProvider = newProvider.toLowerCase();
            if (providerDefaults[lowerNewProvider]) {
              newModelForProvider = providerDefaults[lowerNewProvider];
              log(`TerminalChat: Found default model '${newModelForProvider}' for provider '${newProvider}'`);
            } else {
              log(`TerminalChat: No specific default model found for provider '${newProvider}'. Model will be cleared.`);
            }

            const oldProvider = provider; // Capture old provider for comparison
            const oldModel = model; // Capture old model for comparison

            setModel(newModelForProvider); // Update the model state
            setProvider(newProvider);     // Update the provider state

            // Update and save the configuration
            const updatedConfig = {
              ...config,
              provider: newProvider,
              model: newModelForProvider,
            };
            saveConfig(updatedConfig);
            log("TerminalChat: Configuration saved with new provider and model.");

            // Reset lastResponseId if provider or model actually changes to ensure fresh context
            setLastResponseId((prevLastResponseId) => {
              if (newProvider !== oldProvider || newModelForProvider !== oldModel) {
                log("TerminalChat: Provider or model changed, resetting lastResponseId.");
                return null;
              }
              return prevLastResponseId;
            });

            // Update chat items with a system message
            setItems((prevItems) => [
              ...prevItems,
              {
                id: `switch-provider-${Date.now()}`,
                type: "message",
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: `Switched provider to ${newProvider}. ${newModelForProvider ? `Model set to '${newModelForProvider}'.` : "Please select a model."}`,
                  },
                ],
              } as ResponseItem, // Type assertion
            ]);
            log("TerminalChat: System message added for provider/model switch.");
            // The ModelOverlay component will automatically re-fetch and display models
            // for the `newProvider` because its `useEffect` hook depends on `currentProvider`.
            // The `currentModel` prop of ModelOverlay will be `newModelForProvider`.
          }}
          onExit={() => setOverlayMode("none")}
        />
      )}

      {overlayMode === "approval" && (
        <ApprovalModeOverlay
          currentMode={approvalPolicy}
          onSelect={(newMode: string) => {
            if (newMode === approvalPolicy) {
              return;
            }
            setOverlayMode("none");
          }}
          onExit={() => setOverlayMode("none")}
        />
      )}

      {overlayMode === "help" && (
        <HelpOverlay onExit={() => setOverlayMode("none")} />
      )}

      {overlayMode === "diff" && (
        <DiffOverlay
          diffText={diffText}
          onExit={() => setOverlayMode("none")}
        />
      )}
    </Box>
  );
};
