import type {
  ConfirmationResult,
  // ConfirmationPrompt,
} from "../../hooks/use-confirmation";

import MultilineTextEditor, {
  type MultilineTextEditorHandle,
} from "./multiline-editor";
import { TerminalChatCommandReview } from "./terminal-chat-command-review";
import TextCompletions from "./terminal-chat-completions";
import {
  getFileSystemSuggestions,
  type FileSystemSuggestion,
} from "../../utils/file-system-suggestions";
import { expandFileTags } from "../../utils/file-tag-utils";
import {
  createInputItem,
  type ResponseInputItem,
} from "../../utils/input-utils";
import { SLASH_COMMANDS, type SlashCommand } from "../../utils/slash-commands";
import {
  loadCommandHistory,
  addToHistory,
  type HistoryEntry,
} from "../../utils/storage/command-history";
import { clearTerminal } from "../../utils/terminal";
import { Box, Text, useInput, useApp } from "ink";
import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";

export interface TerminalChatInputProps {
  loading: boolean;
  submitInput: (items: Array<ResponseInputItem>) => void;
  confirmationPrompt: React.ReactNode | null;
  explanation?: string;
  submitConfirmation: (result: ConfirmationResult) => void;
  setLastResponseId: (id: string) => void;
  setItems: (items: Array<ResponseInputItem>) => void;
  openOverlay: () => void;
  openModelOverlay: () => void;
  openProviderOverlay: () => void;
  openApprovalOverlay: () => void;
  openHelpOverlay: () => void;
  openDiffOverlay: () => void;
  openSessionsOverlay: () => void;
  openWebOverlay: () => void;
  onCompact: () => void;
  items: Array<ResponseInputItem>;
  workdir?: string;
}

export default function TerminalChatInput({
  loading,
  submitInput,
  confirmationPrompt,
  explanation,
  submitConfirmation,
  setLastResponseId,
  setItems,
  openOverlay,
  openModelOverlay,
  openProviderOverlay,
  openApprovalOverlay,
  openHelpOverlay,
  openDiffOverlay,
  openSessionsOverlay,
  openWebOverlay,
  onCompact,
  items = [],
  workdir,
}: TerminalChatInputProps): React.ReactElement {
  const [selectedSlashSuggestion, setSelectedSlashSuggestion] =
    useState<number>(0);
  const app = useApp();
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<Array<HistoryEntry>>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [draftInput, setDraftInput] = useState<string>("");
  const [skipNextSubmit, setSkipNextSubmit] = useState<boolean>(false);
  const [fsSuggestions, setFsSuggestions] = useState<
    Array<FileSystemSuggestion>
  >([]);
  const [selectedCompletion, setSelectedCompletion] = useState<number>(-1);
  const [editorState, setEditorState] = useState<{
    key: number;
    initialCursorOffset?: number;
  }>({ key: 0 });
  const editorRef = useRef<MultilineTextEditorHandle | null>(null);

  // Derived state for slash command completions
  const slashCommandsToDisplay = useMemo(() => {
    if (!input.startsWith("/")) {
      return [];
    }
    // Match commands that start with the typed query after '/'
    // or show all commands if only '/' is typed or '/ ' (with space)
    const query =
      input.length > 1 ? input.substring(1).toLowerCase().trimStart() : "";
    if (query === "") {
      // If only '/' or '/ ' is typed, show all commands
      return SLASH_COMMANDS;
    }
    return SLASH_COMMANDS.filter((cmd) =>
      cmd.command.toLowerCase().startsWith(query),
    );
  }, [input]);

  const slashCommandCompletions = useMemo(() => {
    return slashCommandsToDisplay.map((cmd) => cmd.command);
  }, [slashCommandsToDisplay]);

  useEffect(() => {
    // Adjust selectedSlashSuggestion when completions change
    if (slashCommandCompletions.length > 0) {
      setSelectedSlashSuggestion((prev) =>
        Math.min(Math.max(0, prev), slashCommandCompletions.length - 1),
      );
    } else {
      setSelectedSlashSuggestion(0); // Or -1 if no selection desired when empty
    }
  }, [slashCommandCompletions]);

  useEffect(() => {
    async function doLoadHistory() {
      setHistory(await loadCommandHistory());
    }
    doLoadHistory();
  }, []);

  const updateFsSuggestions = useCallback(
    (txt: string, alwaysUpdateSelection: boolean = false) => {
      const suggestions = getFileSystemSuggestions(txt);
      setFsSuggestions(suggestions);
      if (alwaysUpdateSelection || selectedCompletion >= suggestions.length) {
        setSelectedCompletion(suggestions.length > 0 ? 0 : -1);
      }
    },
    [selectedCompletion],
  );

  const loadHistory = useCallback(async () => {
    setHistory(await loadCommandHistory());
  }, []);

  const handleChange = useCallback(
    (value: string) => {
      setInput(value);
      if (historyIndex != null) {
        setHistoryIndex(null);
        setDraftInput("");
      }
      updateFsSuggestions(value);
    },
    [historyIndex, updateFsSuggestions],
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      if (skipNextSubmit) {
        setSkipNextSubmit(false);
        return;
      }

      const trimmedValue = value.trim();
      if (!trimmedValue) {return;}

      await addToHistory(trimmedValue, history);
      await loadHistory();
      setHistoryIndex(null);
      setInput("");
      setEditorState((prev) => ({ key: prev.key + 1 }));
      setLastResponseId("");

      const slashCommandMatch = trimmedValue.match(/^\/([\w-]+)\s*(.*)/);
      if (slashCommandMatch) {
        const commandName = slashCommandMatch[1];
        const commandArgs = slashCommandMatch[2];
        // Extract just the command part without the slash for comparison
        const command = SLASH_COMMANDS.find(
          (cmd: SlashCommand) => cmd.command.substring(1) === commandName,
        );

        if (command) {
          if (command.command === "/exit" || command.command === "/quit") {
            clearTerminal();
            app.exit();
            process.exit(0);
          }
          if (command.command === "/clear") {
            setItems([]);
            return;
          }
          if (command.command === "/compact") {
            onCompact();
            return;
          }
          if (command.command === "/help") {
            openHelpOverlay();
            return;
          }
          if (command.command === "/model") {
            openModelOverlay();
            return;
          }
          if (command.command === "/provider") {
            openProviderOverlay();
            return;
          }
          if (command.command === "/approval") {
            openApprovalOverlay();
            return;
          }
          if (command.command === "/web") {
            openWebOverlay();
            return;
          }
          if (command.command === "/sessions") {
            openSessionsOverlay();
            return;
          }
          if (command.command === "/bug") {
            const { default: os } = await import("node:os");
            const { version: cliVersion } = await import(
              "../../../package.json"
            );
            const { version: nodeVersion } = process;
            const lastFewItems = items.slice(-5);
            const bugReportPreamble = `
            --- Bug Report ---
            CLI Version: ${cliVersion}
            Node Version: ${nodeVersion}
            OS: ${os.platform()} ${os.release()}
            Workdir: ${workdir}
            Description: ${commandArgs || "Please describe the bug."}
            ------------------
            Recent Conversation:
            ${JSON.stringify(lastFewItems, null, 2)}
            ------------------
            `;
            setInput(bugReportPreamble);
            setEditorState((prev) => ({
              key: prev.key + 1,
              initialCursorOffset: bugReportPreamble.length,
            }));
            return;
          }
          return;
        }
      }

      const expandedValue = await expandFileTags(trimmedValue);
      submitInput([await createInputItem(expandedValue, [])]);
    },
    [
      skipNextSubmit,
      app,
      setItems,
      onCompact,
      openHelpOverlay,
      openModelOverlay,
      openProviderOverlay,
      openApprovalOverlay,
      openWebOverlay,
      openSessionsOverlay,
      setLastResponseId,
      submitInput,
      loadHistory,
      workdir,
      items,
      history,
    ],
  );

  useInput(
    (character, key) => {
      if (key.ctrl && character === "c") {
        if (input === "") {
          app.exit();
          process.exit(0);
        } else {
          setInput("");
          setEditorState((prev) => ({ key: prev.key + 1 }));
          if (input.startsWith("/")) {setSelectedSlashSuggestion(0);}
        }
        return;
      }

      if (input.startsWith("/") && slashCommandCompletions.length > 0) {
        if (key.upArrow) {
          setSelectedSlashSuggestion((prev) =>
            prev > 0 ? prev - 1 : slashCommandCompletions.length - 1,
          );
          setSkipNextSubmit(true);
          return;
        } else if (key.downArrow) {
          setSelectedSlashSuggestion((prev) =>
            prev < slashCommandCompletions.length - 1 ? prev + 1 : 0,
          );
          setSkipNextSubmit(true);
          return;
        } else if (key.return || key.tab) {
          if (
            selectedSlashSuggestion >= 0 &&
            selectedSlashSuggestion < slashCommandCompletions.length
          ) {
            const command = slashCommandCompletions[selectedSlashSuggestion];
            const newText = `/${command} `;
            setInput(newText);
            setEditorState((prev) => ({
              key: prev.key + 1,
              initialCursorOffset: newText.length,
            }));
            setSelectedSlashSuggestion(0);
            setSkipNextSubmit(true);
            return;
          }
        }
      }

      if (key.upArrow) {
        if (fsSuggestions.length > 0 && selectedCompletion > -1) {
          setSelectedCompletion((prev) => Math.max(0, prev - 1));
        } else if (history.length > 0) {
          let newIndex;
          if (historyIndex == null) {
            setDraftInput(input);
            newIndex = history.length - 1;
          } else {
            newIndex = Math.max(0, historyIndex - 1);
          }
          if (newIndex !== historyIndex) {
            setHistoryIndex(newIndex);
            const newCmd = history[newIndex]?.command || "";
            setInput(newCmd);
            setEditorState((prev) => ({
              key: prev.key + 1,
              initialCursorOffset: newCmd.length,
            }));
          }
        }
        setSkipNextSubmit(true);
      } else if (key.downArrow) {
        if (fsSuggestions.length > 0 && selectedCompletion > -1) {
          setSelectedCompletion((prev) =>
            Math.min(fsSuggestions.length - 1, prev + 1),
          );
        } else if (historyIndex != null && historyIndex < history.length - 1) {
          const newIndex = historyIndex + 1;
          setHistoryIndex(newIndex);
          const newCmd = history[newIndex]?.command || "";
          setInput(newCmd);
          setEditorState((prev) => ({
            key: prev.key + 1,
            initialCursorOffset: newCmd.length,
          }));
        } else if (
          historyIndex != null &&
          historyIndex === history.length - 1
        ) {
          setHistoryIndex(null);
          setInput(draftInput);
          setEditorState((prev) => ({
            key: prev.key + 1,
            initialCursorOffset: draftInput.length,
          }));
        }
        setSkipNextSubmit(true);
      } else if (key.tab) {
        if (fsSuggestions.length > 0 && selectedCompletion > -1) {
          const suggestion = fsSuggestions[selectedCompletion];
          if (suggestion) {
            setInput(suggestion.path);
            setEditorState((prev) => ({
              key: prev.key + 1,
              initialCursorOffset: suggestion.path.length,
            }));
            setFsSuggestions([]);
            setSelectedCompletion(-1);
          }
        }
        setSkipNextSubmit(true);
      } else if (key.pageDown) {
        openOverlay();
        setSkipNextSubmit(true);
      } else if (key.pageUp) {
        openDiffOverlay();
        setSkipNextSubmit(true);
      }

      if (editorRef.current) {
        // prevCursorRow.current = editorRef.current.getRow();
      }
    },
    {
      isActive:
        !loading &&
        !confirmationPrompt &&
        (fsSuggestions.length > 0 ||
          history.length > 0 ||
          slashCommandCompletions.length > 0),
    },
  );

  useEffect(() => {}, []);

  if (loading && !confirmationPrompt) {
    return <Text>Loading...</Text>;
  }

  if (confirmationPrompt) {
    return (
      <TerminalChatCommandReview
        explanation={explanation}
        confirmationPrompt={confirmationPrompt}
        onReviewCommand={submitConfirmation}
        onSwitchApprovalMode={openApprovalOverlay}
      />
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      {fsSuggestions.length > 0 && selectedCompletion >= 0 && (
        <Box flexDirection="column">
          {fsSuggestions.map((suggestion, index) => (
            <Text
              key={suggestion.path}
              color={selectedCompletion === index ? "blue" : "gray"}
            >
              {selectedCompletion === index ? "❯ " : "  "}
              {suggestion.path}
            </Text>
          ))}
        </Box>
      )}
      <Box borderStyle="round" paddingX={1} borderColor="blue">
        <MultilineTextEditor
          key={editorState.key}
          ref={editorRef}
          initialText={input}
          initialCursorOffset={editorState.initialCursorOffset}
          focus={!loading && !confirmationPrompt}
          onSubmit={handleSubmit}
          onChange={handleChange}
        />
      </Box>
      {input.startsWith("/") && slashCommandCompletions.length > 0 && (
        <TextCompletions
          completions={slashCommandCompletions}
          selectedCompletion={selectedSlashSuggestion}
          displayLimit={5}
        />
      )}
    </Box>
  );
}
