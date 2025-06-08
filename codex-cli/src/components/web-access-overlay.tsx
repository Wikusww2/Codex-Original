import { Box, Text, useInput } from "ink";
import React from "react";

export default function WebAccessOverlay({
  enabled,
  onToggle,
  onExit,
}: {
  enabled: boolean;
  onToggle: (value: boolean) => void;
  onExit: () => void;
}): JSX.Element {
  useInput((input, key) => {
    if (input === "y") {
      onToggle(true);
      onExit();
    } else if (input === "n" || key.escape) {
      onToggle(false);
      onExit();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" width={60}>
      <Box paddingX={1}>
        <Text bold>Web access</Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        <Text>Currently {enabled ? "enabled" : "disabled"}.</Text>
        <Text>Enable web access? (y/n)</Text>
      </Box>
    </Box>
  );
}
