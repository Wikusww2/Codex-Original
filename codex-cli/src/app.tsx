import type { ApprovalPolicy } from "./approvals";
import type { AppConfig } from "./utils/config";
import type { TerminalChatSession } from "./utils/session.js";
import type { ResponseItem } from "openai/resources/responses/responses";


import { TerminalChat } from "./components/chat/terminal-chat";
import TerminalChatPastRollout from "./components/chat/terminal-chat-past-rollout";
import { checkInGit } from "./utils/check-in-git";
import { getApiKey } from "./utils/config";
import { log } from "./utils/logger/log";
import { onExit } from "./utils/terminal";
import { CLI_VERSION } from "./version";
import { ConfirmInput } from "@inkjs/ui";
import { Box, Text, useApp, useStdin } from "ink";
import React, { useMemo, useState } from "react";

export type AppRollout = {
  session: TerminalChatSession;
  items: Array<ResponseItem>;
};

type Props = {
  prompt?: string;
  config: AppConfig;
  imagePaths?: Array<string>;
  rollout?: AppRollout;
  approvalPolicy: ApprovalPolicy;
  additionalWritableRoots: ReadonlyArray<string>;
  fullStdout: boolean;
};

export default function App({
  prompt,
  config: initialConfig, // Renamed prop for clarity
  rollout,
  imagePaths,
  approvalPolicy,
  additionalWritableRoots,
  fullStdout,
}: Props): JSX.Element {
  const app = useApp();
  const [accepted, setAccepted] = useState(() => false);
  const [currentConfig, setCurrentConfig] = useState<AppConfig>(initialConfig);

  const handleProviderChange = (newProviderName: string, selectedModel?: string) => {
    log(`App: handleProviderChange called with Provider: ${newProviderName}, Selected Model: ${selectedModel}`);
    setCurrentConfig(prevConfig => {
      const newModel = selectedModel || prevConfig.providers?.[newProviderName]?.defaultModel || '';
      // getApiKey will look into prevConfig.providerApiKeys or env vars for the newProviderName's key
      const newApiKey = getApiKey(newProviderName);
      return {
        ...prevConfig,
        provider: newProviderName,
        model: newModel,
        apiKey: newApiKey,
      };
    });
  };
  const [cwd, inGitRepo] = useMemo(() => {
    const currentCwd = process.cwd();
    const gitRepoStatus = checkInGit(currentCwd);
    return [currentCwd, gitRepoStatus];
  }, []);
  const { internal_eventEmitter } = useStdin();
  internal_eventEmitter.setMaxListeners(20);

  if (rollout) {
    return (
      <TerminalChatPastRollout
        session={rollout.session}
        items={rollout.items}
        fileOpener={currentConfig.fileOpener}
      />
    );
  }

  if (!inGitRepo && !accepted) {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" paddingX={1} width={64}>
          <Text>
            ● OpenAI <Text bold>Codex</Text>{" "}
            <Text dimColor>
              (research preview) <Text color="blueBright">v{CLI_VERSION}</Text>
            </Text>
          </Text>
        </Box>
        <Box
          borderStyle="round"
          borderColor="redBright"
          flexDirection="column"
          gap={1}
        >
          <Text>
            <Text color="yellow">Warning!</Text> It can be dangerous to run a
            coding agent outside of a git repo in case there are changes that
            you want to revert. Do you want to continue?
          </Text>
          <Text>{cwd}</Text>
          <ConfirmInput
            defaultChoice="cancel"
            onCancel={() => {
              app.exit();
              onExit();
              // eslint-disable-next-line
              console.error(
                "Quitting! Run again to accept or from inside a git repo",
              );
            }}
            onConfirm={() => setAccepted(true)}
          />
        </Box>
      </Box>
    );
  }

  return (
    <TerminalChat
      config={currentConfig} // Pass the stateful config
      initialPrompt={prompt}
      imagePaths={imagePaths}
      approvalPolicy={approvalPolicy}
      additionalWritableRoots={additionalWritableRoots}
      fullStdout={fullStdout}
      onProviderChange={handleProviderChange} // Pass the handler
    />
  );
}
