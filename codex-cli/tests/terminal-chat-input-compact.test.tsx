import React from "react";
import type { ComponentProps } from "react";
import { renderTui } from "./ui-test-helpers.js";
import TerminalChatInput from "../src/components/chat/terminal-chat-input.js";
import { describe, it, expect, vi } from "vitest";

describe("TerminalChatInput compact command", () => {
  it("shows /compact hint when context is low", async () => {
    const props: ComponentProps<typeof TerminalChatInput> = {
      loading: false,
      submitInput: () => {},
      confirmationPrompt: null,
      explanation: undefined,
      submitConfirmation: () => {},
      setLastResponseId: () => {},
      setItems: () => {},
      items: [],
      openOverlay: () => {},
      openDiffOverlay: () => {},
      openModelOverlay: () => {},
      openProviderOverlay: () => {},
      openApprovalOverlay: () => {},
      openHelpOverlay: () => {},
      openSessionsOverlay: () => {},
      openWebOverlay: vi.fn(), // Added to satisfy TS2741
      onCompact: () => {},
    };
    const { lastFrameStripped } = renderTui(<TerminalChatInput {...props} />);
    const frame = lastFrameStripped();
    expect(frame).toContain("/compact");
  });
});
