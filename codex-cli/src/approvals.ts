import type { ParseEntry, ControlOperator } from "shell-quote";

import {
  identify_files_added,
  identify_files_needed,
} from "./utils/agent/apply-patch";
import * as path from "path";
import { parse } from "shell-quote";

export type SafetyAssessment = {
  /**
   * If set, this approval is for an apply_patch call and these are the
   * arguments.
   */
  applyPatch?: ApplyPatchCommand;
} & (
  | {
      type: "auto-approve";
      /**
       * This must be true if the command is not on the "known safe" list, but
       * was auto-approved due to `full-auto` mode.
       */
      runInSandbox: boolean;
      reason: string;
      group: string;
    }
  | {
      type: "ask-user";
    }
  /**
   * Reserved for a case where we are certain the command is unsafe and should
   * not be presented as an option to the user.
   */
  | {
      type: "reject";
      reason: string;
    }
);

// TODO: This should also contain the paths that will be affected.
export type ApplyPatchCommand = {
  patch: string;
};

export type ApprovalPolicy =
  /**
   * Under this policy, only "known safe" commands as defined by
   * `isSafeCommand()` that only read files will be auto-approved.
   */
  | "suggest"

  /**
   * In addition to commands that are auto-approved according to the rules for
   * "suggest", commands that write files within the user's approved list of
   * writable paths will also be auto-approved.
   */
  | "auto-edit"

  /**
   * All commands are auto-approved, but are expected to be run in a sandbox
   * where network access is disabled and writes are limited to a specific set
   * of paths.
   */
  | "full-auto"
  | "full_auto" // UI format with underscore

  /**
   * No approval is ever asked. Commands are run directly, bypassing sandbox
   * policy checks. USE WITH EXTREME CAUTION.
   */
  | "none";

/**
 * Tries to assess whether a command is safe to run, though may defer to the
 * user for approval.
 *
 * Note `env` must be the same `env` that will be used to spawn the process.
 */
// Helper function to check policy values for TypeScript narrowing
function isFullAutoOrNone(policy: ApprovalPolicy): boolean {
  return policy === "full-auto" || policy === "full_auto" || policy === "none";
}

export function canAutoApprove(
  command: ReadonlyArray<string>,
  workdir: string | undefined,
  policy: ApprovalPolicy,
  writableRoots: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): SafetyAssessment {
  // Handle "none" and "full-auto" policies upfront
  if (isFullAutoOrNone(policy)) {
    // Still reject malformed apply_patch commands even in "none" or "full-auto" mode
    if (
      command[0] === "apply_patch" &&
      (command.length !== 2 || typeof command[1] !== "string")
    ) {
      return {
        type: "reject",
        reason: "Invalid apply_patch command",
      };
    }
    // For all other commands, auto-approve
    return {
      type: "auto-approve",
      // Run in sandbox if in full-auto mode, but not in none mode
      runInSandbox: policy === "full-auto",
      reason: `Approval policy is '${policy}'`,
      group: command[0] === "apply_patch" ? "Editing" : "Running commands",
      ...(command[0] === "apply_patch" && {
        applyPatch: { patch: command[1] as string },
      }),
    };
  }
  if (command[0] === "apply_patch") {
    return command.length === 2 && typeof command[1] === "string"
      ? canAutoApproveApplyPatch(command[1], workdir, writableRoots, policy)
      : {
          type: "reject",
          reason: "Invalid apply_patch command",
        };
  }

  const isSafe = isSafeCommand(command);
  if (isSafe != null) {
    const { reason, group } = isSafe;
    return {
      type: "auto-approve",
      reason,
      group,
      runInSandbox: false,
    };
  }

  if (
    command[0] === "bash" &&
    command[1] === "-lc" &&
    typeof command[2] === "string" &&
    command.length === 3
  ) {
    const applyPatchArg = tryParseApplyPatch(command[2]);
    if (applyPatchArg != null) {
      return canAutoApproveApplyPatch(
        applyPatchArg,
        workdir,
        writableRoots,
        policy,
      );
    }

    let bashCmd;
    try {
      bashCmd = parse(command[2], env);
    } catch (e) {
      // In practice, there seem to be syntactically valid shell commands that
      // shell-quote cannot parse, so we should not reject, but ask the user.
      // UNLESS we are in full-auto or none, in which case we run it
      if (isFullAutoOrNone(policy)) {
        return {
          type: "auto-approve",
          reason: `${policy === "full-auto" ? "Full auto" : "None"} mode (unparsable bash command)`,
          group: "Running commands",
          runInSandbox: policy === "full-auto", // Keep sandbox for unparsable bash in full-auto, but not in none
        };
      } else {
        // For suggest and auto-edit policies
        return {
          type: "ask-user",
        };
      }
    }

    // bashCmd could be a mix of strings and operators, e.g.:
    //   "ls || (true && pwd)" => [ 'ls', { op: '||' }, '(', 'true', { op: '&&' }, 'pwd', ')' ]
    // We try to ensure that *every* command segment is deemed safe and that
    // all operators belong to an allow-list. If so, the entire expression is
    // considered auto-approvable.

    const shellSafe = isEntireShellExpressionSafe(bashCmd || []);
    if (shellSafe != null) {
      const { reason, group } = shellSafe;
      return {
        type: "auto-approve",
        reason,
        group,
        runInSandbox: false,
      };
    }
  }

  // Fallback for other commands not explicitly handled by isSafeCommand or bash parsing
  if (isFullAutoOrNone(policy)) {
    return {
      type: "auto-approve",
      reason: `${policy === "full-auto" ? "Full auto" : "None"} mode (command not on explicit safe list)`,
      group: "Running commands",
      runInSandbox: policy === "full-auto", // Use sandbox in full-auto mode only
    };
  }

  return { type: "ask-user" };
}

function canAutoApproveApplyPatch(
  applyPatchArg: string,
  workdir: string | undefined,
  writableRoots: ReadonlyArray<string>,
  policy: ApprovalPolicy,
): SafetyAssessment {
  // START ADDITION: Handle "none" policy upfront for apply_patch
  if (policy === "none") {
    return {
      type: "auto-approve",
      runInSandbox: false,
      reason: "Approval policy is 'none' for apply_patch",
      group: "Editing",
      applyPatch: { patch: applyPatchArg },
    };
  }
  // END ADDITION
  switch (policy) {
    case "full-auto":
      // Continue to see if this can be auto-approved.
      break;
    case "suggest":
      return {
        type: "ask-user",
        applyPatch: { patch: applyPatchArg },
      };
    case "auto-edit":
      // Continue to see if this can be auto-approved.
      break;
  }

  if (
    isWritePatchConstrainedToWritablePaths(
      applyPatchArg,
      workdir,
      writableRoots,
    )
  ) {
    return {
      type: "auto-approve",
      reason: "apply_patch command is constrained to writable paths",
      group: "Editing",
      runInSandbox: false,
      applyPatch: { patch: applyPatchArg },
    };
  }

  return policy === "full-auto"
    ? {
        type: "auto-approve",
        reason: "Full auto mode",
        group: "Editing",
        runInSandbox: true,
        applyPatch: { patch: applyPatchArg },
      }
    : {
        type: "ask-user",
        applyPatch: { patch: applyPatchArg },
      };
}

/**
 * All items in `writablePaths` must be absolute paths.
 */
function isWritePatchConstrainedToWritablePaths(
  applyPatchArg: string,
  workdir: string | undefined,
  writableRoots: ReadonlyArray<string>,
): boolean {
  // `identify_files_needed()` returns a list of files that will be modified or
  // deleted by the patch, so all of them should already exist on disk. These
  // candidate paths could be further canonicalized via fs.realpath(), though
  // that does seem necessary and may even cause false negatives (assuming we
  // allow writes in other directories that are symlinked from a writable path)
  //
  // By comparison, `identify_files_added()` returns a list of files that will
  // be added by the patch, so they should NOT exist on disk yet and therefore
  // using one with fs.realpath() should return an error.
  return (
    allPathsConstrainedTowritablePaths(
      identify_files_needed(applyPatchArg),
      workdir,
      writableRoots,
    ) &&
    allPathsConstrainedTowritablePaths(
      identify_files_added(applyPatchArg),
      workdir,
      writableRoots,
    )
  );
}

function allPathsConstrainedTowritablePaths(
  candidatePaths: ReadonlyArray<string>,
  workdir: string | undefined,
  writableRoots: ReadonlyArray<string>,
): boolean {
  return candidatePaths.every((candidatePath) =>
    isPathConstrainedTowritablePaths(candidatePath, workdir, writableRoots),
  );
}

/** If candidatePath is relative, it will be resolved against cwd. */
function isPathConstrainedTowritablePaths(
  candidatePath: string,
  workdir: string | undefined,
  writableRoots: ReadonlyArray<string>,
): boolean {
  const candidateAbsolutePath = resolvePathAgainstWorkdir(
    candidatePath,
    workdir,
  );

  return writableRoots.some((writablePath) =>
    pathContains(writablePath, candidateAbsolutePath),
  );
}

/**
 * If not already an absolute path, resolves `candidatePath` against `workdir`
 * if specified; otherwise, against `process.cwd()`.
 */
export function resolvePathAgainstWorkdir(
  candidatePath: string,
  workdir: string | undefined,
): string {
  // Normalize candidatePath to prevent path traversal attacks
  const normalizedCandidatePath = path.normalize(candidatePath);
  if (path.isAbsolute(normalizedCandidatePath)) {
    return normalizedCandidatePath;
  } else if (workdir != null) {
    return path.resolve(workdir, normalizedCandidatePath);
  } else {
    return path.resolve(normalizedCandidatePath);
  }
}

/** Both `parent` and `child` must be absolute paths. */
function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    // relative path doesn't go outside parent
    !!relative && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/**
 * `bashArg` might be something like "apply_patch << 'EOF' *** Begin...".
 * If this function returns a string, then it is the content the arg to
 * apply_patch with the heredoc removed.
 */
function tryParseApplyPatch(bashArg: string): string | null {
  const prefix = "apply_patch";
  if (!bashArg.startsWith(prefix)) {
    return null;
  }

  const heredoc = bashArg.slice(prefix.length);
  const heredocMatch = heredoc.match(
    /^\s*<<\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\1/,
  );
  if (heredocMatch != null && typeof heredocMatch[2] === "string") {
    return heredocMatch[2].trim();
  } else {
    return heredoc.trim();
  }
}

const VALID_SED_N_ARG = /^[0-9]+(,[0-9]+)?[p]$/;
function isValidSedNArg(arg: string | undefined): boolean {
  if (arg === undefined) {
    return false;
  }
  return VALID_SED_N_ARG.test(arg);
}

export type SafeCommandReason = {
  reason: string;
  group: string;
};

/**
 * If this is a "known safe" command, returns the (reason, group); otherwise,
 * returns null.
 */
export function isSafeCommand(
  command: ReadonlyArray<string>,
): SafeCommandReason | null {
  if (command.length === 0) {
    return null;
  }

  // Always approve PowerShell commands as safe
  if (
    command[0]?.toLowerCase() === "powershell" ||
    command[0]?.toLowerCase() === "pwsh"
  ) {
    return {
      reason: "PowerShell command",
      group: "PowerShell",
    };
  }

  let workingCmdArray = [...command]; // Use a mutable copy

  // Handle agent wrapping 'dir > file.txt' in single quotes,
  // resulting in cmdArray being ["'dir > file.txt'"].
  // This is a workaround for a specific agent misbehavior.
  if (workingCmdArray.length === 1) {
    const singleCommandString = workingCmdArray[0];
    // Explicitly check if singleCommandString is a string before using string methods
    if (typeof singleCommandString === "string") {
      if (
        singleCommandString.startsWith("'dir > ") &&
        singleCommandString.endsWith("'")
      ) {
        const innerCommand = singleCommandString.slice(1, -1); // Remove outer single quotes
        const parts = innerCommand.split(" ");
        // Ensure parts[0] is a string before calling toLowerCase()
        if (
          parts.length === 3 &&
          typeof parts[0] === "string" &&
          parts[0].toLowerCase() === "dir" &&
          parts[1] === ">"
        ) {
          const filename = parts[2]; // parts[2] is also a string due to split(' ')
          // Check if filename is a simple filename (not an option character and has some length)
          if (
            filename &&
            filename.length > 0 &&
            !filename.startsWith("/") &&
            !filename.startsWith("-")
          ) {
            return {
              reason:
                "List directory contents and redirect to file (auto-approved due to unwrapping agent's quotes)",
              group: "File system",
            };
          }
        }
      }
    }
  }

  // Ensure workingCmdArray[0] is valid before toLowerCase()
  const cmdName =
    typeof workingCmdArray[0] === "string"
      ? workingCmdArray[0].toLowerCase()
      : undefined;
  if (!cmdName) {
    return null;
  }

  const commandHandlers: Record<
    string,
    (cmdArray: ReadonlyArray<string>) => SafeCommandReason | null
  > = {
    cd: (_cmdArray: ReadonlyArray<string>) => ({
      reason: "Change directory",
      group: "Navigating",
    }),
    ls: (cmdArray: ReadonlyArray<string>) => {
      if (cmdArray.slice(1).some((arg) => arg.includes("`") || arg.includes("$")))
        return null;
      return { reason: "List directory", group: "Searching" };
    },
    dir: (cmdArray: ReadonlyArray<string>) => {
      if (process.platform !== "win32") return null;
      // Allow 'dir'
      if (cmdArray.length === 1 && cmdArray[0]?.toLowerCase() === "dir") {
        return { reason: "List directory contents", group: "File system" };
      }
      // Allow 'dir > filename' or 'dir >> filename'
      if (
        cmdArray.length === 3 &&
        cmdArray[0]?.toLowerCase() === "dir" &&
        (cmdArray[1] === ">" || cmdArray[1] === ">>") &&
        cmdArray[2] && // Ensure cmdArray[2] exists and is truthy
        typeof cmdArray[2] === "string" &&
        !cmdArray[2].startsWith("-")
      ) {
        return {
          reason: "List directory contents and redirect to file",
          group: "File system",
        };
      }
      // If no redirection, check other arguments
      // All arguments must not start with / or - unless they are known safe options
      for (let i = 1; i < cmdArray.length; i++) {
        const arg = cmdArray[i];
        // Handle potential null/undefined from split if it occurs
        if (arg === null || arg === undefined) {
          // Consider this malformed and unsafe
          return null;
        }
        // If argument is an empty string, it's not an option, treat as safe and continue.
        if (arg === "") {
          continue;
        }

        if (arg.startsWith("/") || arg.startsWith("-")) {
          const safeDirOptions = [
            "/ad",
            "/b",
            "/s",
            "/o",
            "/on",
            "/od",
            "/og",
            "/os",
            "/oe",
            "/a",
          ]; // /a for attributes
          if (!safeDirOptions.includes(arg.toLowerCase())) {
            return null;
          }
        }
      }
      return { reason: "List directory contents", group: "File system" };
    },
    pwd: (_cmdArray: ReadonlyArray<string>) => ({
      reason: "Print working directory",
      group: "Navigating",
    }),
    true: (_cmdArray: ReadonlyArray<string>) => ({
      reason: "No-op (true)",
      group: "Utility",
    }),
    false: (_cmdArray: ReadonlyArray<string>) => ({
      reason: "No-op (false)",
      group: "Utility",
    }),
    echo: (_cmdArray: ReadonlyArray<string>) => ({
      reason: "Echo string",
      group: "Printing",
    }),
    cat: (cmdArray: ReadonlyArray<string>) => {
      if (
        cmdArray.slice(1).some((arg) => arg.includes("`") || arg.includes("$"))
      )
        return null;
      return { reason: "View file contents", group: "Reading files" };
    },
    nl: (_cmdArray: ReadonlyArray<string>) => ({
      reason: "View file with line numbers",
      group: "Reading files",
    }),
    clear: (_cmdArray: ReadonlyArray<string>) => ({
      reason: "Clear screen",
      group: "Utility",
    }),
    grep: (cmdArray: ReadonlyArray<string>) => {
      if (
        cmdArray.slice(1).some((arg) => arg.includes("`") || arg.includes("$"))
      )
        return null;
      return { reason: "Text search (grep)", group: "Searching" };
    },
    head: (_cmdArray: ReadonlyArray<string>) => ({
      reason: "Show file head",
      group: "Reading files",
    }),
    tail: (_cmdArray: ReadonlyArray<string>) => ({
      reason: "Show file tail",
      group: "Reading files",
    }),
    which: (_cmdArray: ReadonlyArray<string>) => ({
      reason: "Locate command",
      group: "Searching",
    }),
    git: (cmdArray: ReadonlyArray<string>) => {
      const subCommand = cmdArray[1]?.toLowerCase();
      if (!subCommand) return null;

      const safeSubCommands: Record<string, string> = {
        "status": "View status",
        "diff": "View differences",
        "log": "View history",
        "show": "View specific commit/object",
        "branch": "List branches",
        "tag": "List tags",
        "rev-parse": "Find commit IDs",
        "shortlog -s -n": "Summarize git log",
      };

      // Handle specific multi-word command "shortlog -s -n"
      if (
        subCommand === "shortlog" &&
        cmdArray.length >= 4 &&
        cmdArray[2] === "-s" &&
        cmdArray[3] === "-n"
      ) {
        const reasonText = safeSubCommands["shortlog -s -n"];
        // This key is literal, so reasonText should always be a string here.
        // Adding an explicit check for robustness or to satisfy the type checker if it's being overly cautious.
        if (typeof reasonText === "string") {
          return { reason: reasonText, group: "Versioning" };
        }
        return null; // Should not be reached if safeSubCommands is correctly defined
      }

      // Handle other general safe subcommands
      const reasonForSubCommand = safeSubCommands[subCommand];
      if (typeof reasonForSubCommand === "string") {
        // Explicitly check that a string was retrieved
        if (
          (subCommand === "branch" || subCommand === "tag") &&
          cmdArray.length > 2
        ) {
          if (cmdArray.slice(2).every((arg) => !arg.startsWith("-")))
            return null;
        }
        const gitGroup = ["diff", "log", "show"].includes(subCommand)
          ? "Using git"
          : "Versioning";
        return {
          reason: reasonForSubCommand, // Now reasonForSubCommand is confirmed to be a string
          group: gitGroup,
        };
      }

      // Handle 'git apply --stat --check'
      if (
        subCommand === "apply" &&
        cmdArray.includes("--check") &&
        cmdArray.includes("--stat")
      ) {
        return { reason: "Check patch applicability", group: "Source control" };
      }
      return null;
    },
    cargo: (cmdArray: ReadonlyArray<string>) => {
      if (cmdArray[1]?.toLowerCase() === "check") {
        return { reason: "Cargo check", group: "Building" };
      }
      return null;
    },
    sed: (cmdArray: ReadonlyArray<string>) => {
      if (
        cmdArray[1]?.toLowerCase() === "-n" &&
        isValidSedNArg(cmdArray[2]) &&
        (cmdArray.length === 3 ||
          (typeof cmdArray[3] === "string" && cmdArray.length === 4))
      ) {
        return { reason: "Sed print subset", group: "Reading files" };
      }
      return null;
    },
    start: (cmdArray: ReadonlyArray<string>) => {
      if (process.platform !== "win32") return null; // 'start' is Windows-specific

      if (cmdArray.length === 2) {
        // Case: start <file_path>
        // e.g., start dir_output.txt
        const filePath = cmdArray[1];
        if (
          typeof filePath === "string" &&
          filePath.length > 0 &&
          !filePath.startsWith("-") &&
          !filePath.startsWith("/")
        ) {
          return {
            reason: "Open file/directory with default application",
            group: "File system",
          };
        }
      } else if (cmdArray.length === 3) {
        // Case: start <program> <file_path_or_argument>
        // e.g., start notepad dir_output.txt
        // e.g., start explorer .
        const program = cmdArray[1]?.toLowerCase();
        const argument = cmdArray[2]; // Can be a file path or other arguments like '.' for explorer
        const knownSafePrograms = ["notepad", "explorer"]; // Add more if needed (e.g., "code")

        if (
          typeof program === "string" &&
          knownSafePrograms.includes(program) &&
          typeof argument === "string" &&
          argument.length > 0 &&
          // For explorer, '.' is a safe argument. For others, avoid options.
          (program === "explorer" ||
            (!argument.startsWith("-") && !argument.startsWith("/")))
        ) {
          return { reason: `Open with ${program}`, group: "File system" };
        }
      }
      return null; // Unhandled 'start' command pattern or unsafe arguments
    },
    cmd: (cmdArray: ReadonlyArray<string>) => {
      if (process.platform !== "win32") return null;
      // Allow 'cmd /c dir'
      if (
        cmdArray.length === 3 &&
        cmdArray[0]?.toLowerCase() === "cmd" &&
        cmdArray[1]?.toLowerCase() === "/c" &&
        cmdArray[2]?.toLowerCase() === "dir"
      ) {
        return {
          reason: "List directory contents via cmd",
          group: "File system",
        };
      }
      // Allow 'cmd /c dir > filename' or 'cmd /c dir >> filename'
      if (
        cmdArray.length === 5 &&
        cmdArray[0]?.toLowerCase() === "cmd" &&
        cmdArray[1]?.toLowerCase() === "/c" &&
        cmdArray[2]?.toLowerCase() === "dir" &&
        (cmdArray[3] === ">" || cmdArray[3] === ">>") &&
        cmdArray[4] && // Ensure cmdArray[4] exists and is truthy
        typeof cmdArray[4] === "string" &&
        !cmdArray[4].startsWith("-")
      ) {
        return {
          reason: "List directory contents via cmd and redirect to file",
          group: "File system",
        };
      }
      return null;
    },
    find: (cmdArray: ReadonlyArray<string>) => {
      if (
        cmdArray.some((arg: string) => UNSAFE_OPTIONS_FOR_FIND_COMMAND.has(arg))
      ) {
        return null;
      }
      return {
        reason: "Find files or directories",
        group: "Searching",
      };
    },
    rg: (_cmdArray: ReadonlyArray<string>) => ({
      reason: "Ripgrep search",
      group: "Searching",
    }),
    wc: (_cmdArray: ReadonlyArray<string>) => ({
      reason: "Word count",
      group: "Reading files",
    }),
    type: (cmdArray: ReadonlyArray<string>) => {
      if (process.platform !== "win32") return null;
      // Allow 'type filename.ext'
      if (
        cmdArray.length === 2 &&
        cmdArray[0]?.toLowerCase() === "type" &&
        cmdArray[1] && // Ensure cmdArray[1] (the filename) exists
        typeof cmdArray[1] === "string" &&
        !cmdArray[1].startsWith("/") &&
        !cmdArray[1].startsWith("-")
      ) {
        return { reason: "Display file contents", group: "File system" };
      }
      return null;
    },
  };

  const handler = commandHandlers[cmdName];
  if (handler) {
    return handler(command);
  }

  return null; // Default for commands not explicitly handled
}

const UNSAFE_OPTIONS_FOR_FIND_COMMAND: ReadonlySet<string> = new Set([
  // Options that can execute arbitrary commands.
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  // Option that deletes matching files.
  "-delete",
  // Options that write pathnames to a file.
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
]);

// ---------------- Helper utilities for complex shell expressions -----------------

// A conservative allow-list of bash operators that do not, on their own, cause
// side effects. Redirections (>, >>, <, etc.) and command substitution `$()`
// are intentionally excluded. Parentheses used for grouping are treated as
// strings by `shell-quote`, so we do not add them here. Reference:
// https://github.com/substack/node-shell-quote#parsecmd-opts
const SAFE_SHELL_OPERATORS: ReadonlySet<string> = new Set([
  "&&", // logical AND
  "||", // logical OR
  "|", // pipe
  ";", // command separator
]);

/**
 * Determines whether a parsed shell expression consists solely of safe
 * commands (as per `isSafeCommand`) combined using only operators in
 * `SAFE_SHELL_OPERATORS`.
 *
 * If entirely safe, returns the reason/group from the *first* command
 * segment so callers can surface a meaningful description. Otherwise returns
 * null.
 */
function isEntireShellExpressionSafe(
  parts: ReadonlyArray<ParseEntry>,
): SafeCommandReason | null {
  if (parts.length === 0) {
    return null;
  }

  try {
    // Collect command segments delimited by operators. `shell-quote` represents
    // subshell grouping parentheses as literal strings "(" and ")"; treat them
    // as unsafe to keep the logic simple (since subshells could introduce
    // unexpected scope changes).

    let currentSegment: Array<string> = [];
    let firstReason: SafeCommandReason | null = null;

    const flushSegment = (): boolean => {
      if (currentSegment.length === 0) {
        return true; // nothing to validate (possible leading operator)
      }
      const assessment = isSafeCommand(currentSegment);
      if (assessment == null) {
        return false;
      }
      if (firstReason == null) {
        firstReason = assessment;
      }
      currentSegment = [];
      return true;
    };

    for (const part of parts) {
      if (typeof part === "string") {
        // If this string looks like an open/close parenthesis or brace, treat as
        // unsafe to avoid parsing complexity.
        if (part === "(" || part === ")" || part === "{" || part === "}") {
          return null;
        }
        currentSegment.push(part);
      } else if (isParseEntryWithOp(part)) {
        // Validate the segment accumulated so far.
        if (!flushSegment()) {
          return null;
        }

        // Validate the operator itself.
        if (!SAFE_SHELL_OPERATORS.has(part.op)) {
          return null;
        }
      } else {
        // Unknown token type
        return null;
      }
    }

    // Validate any trailing command segment.
    if (!flushSegment()) {
      return null;
    }

    return firstReason;
  } catch (_err) {
    // If there's any kind of failure, just bail out and return null.
    return null;
  }
}

// Runtime type guard that narrows a `ParseEntry` to the variants that
// carry an `op` field. Using a dedicated function avoids the need for
// inline type assertions and makes the narrowing reusable and explicit.
function isParseEntryWithOp(
  entry: ParseEntry,
): entry is { op: ControlOperator } | { op: "glob"; pattern: string } {
  return (
    typeof entry === "object" &&
    entry != null &&
    // Using the safe `in` operator keeps the check property-safe even when
    // `entry` is a `string`.
    "op" in entry &&
    typeof (entry as { op?: unknown }).op === "string"
  );
}
