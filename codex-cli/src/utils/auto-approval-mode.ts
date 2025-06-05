export enum AutoApprovalMode {
  SUGGEST = "suggest",
  AUTO_EDIT = "auto-edit",
  FULL_AUTO = "full_auto", // Changed from full-auto to full_auto to match UI
  NONE = "none",
}

export enum FullAutoErrorMode {
  ASK_USER = "ask-user",
  IGNORE_AND_CONTINUE = "ignore-and-continue",
}
