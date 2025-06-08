// @ts-expect-error select.js is JavaScript and has no types
import { Select } from "./vendor/ink-select/select";
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
  useInput((_input, key) => {
    if (key.escape) {
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
        <Select
          defaultValue={enabled}
          onChange={(val: boolean) => {
            onToggle(val);
            onExit();
          }}
          options={[
            { label: "Enable", value: true },
            { label: "Disable", value: false },
          ]}
        />
        <Text dimColor>use arrows and enter · esc to cancel</Text>
      </Box>
    </Box>
  );
}
