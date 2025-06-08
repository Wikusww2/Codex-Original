import type { AppConfig } from "../config.js";
import type { ExecInput, ExecResult } from "./sandbox/interface.js";
import type { SpawnOptions } from "child_process";
import type { ParseEntry } from "shell-quote";

import { process_patch } from "./apply-patch.js";
import { SandboxType } from "./sandbox/interface.js";
import { execWithLandlock } from "./sandbox/landlock.js";
import { execWithSeatbelt } from "./sandbox/macos-seatbelt.js";
import { exec as rawExec } from "./sandbox/raw-exec.js";
import { formatCommandForDisplay } from "../../format-command.js";
import { log } from "../logger/log.js";
import fs from "fs";
import os from "os";
import path from "path";
import { parse } from "shell-quote";
import { resolvePathAgainstWorkdir } from "src/approvals.js";
import { PATCH_SUFFIX } from "src/parse-apply-patch.js";

const DEFAULT_TIMEOUT_MS = 60_000; // 60 seconds - increased to allow more complex operations

export function requiresShell(cmd: Array<string>): boolean {
  const firstCommand = cmd[0]?.toLowerCase();

  if (process.platform === "win32") {
    // List of common Windows CMD built-ins. This list is not exhaustive
    // but covers many common commands that would be translated from Unix-like systems
    // or used directly.
    const windowsBuiltIns = [
      "assoc",
      "attrib",
      "break",
      "bcdedit",
      "cacls",
      "call",
      "cd",
      "chcp",
      "chdir",
      "chkdsk",
      "chkntfs",
      "cls",
      "cmd",
      "color",
      "comp",
      "compact",
      "convert",
      "copy",
      "date",
      "del",
      "dir",
      "diskcomp",
      "diskcopy",
      "diskpart",
      "doskey",
      "driverquery",
      "echo",
      "endlocal",
      "erase",
      "fc",
      "find",
      "findstr",
      "for",
      "format",
      "fsutil",
      "ftype",
      "goto",
      "gpresult",
      "graftabl",
      "help",
      "icacls",
      "if",
      "label",
      "md",
      "mkdir",
      "mklink",
      "mode",
      "more",
      "move",
      "openfiles",
      "path",
      "pause",
      "popd",
      "print",
      "prompt",
      "pushd",
      "rd",
      "recover",
      "rem",
      "ren",
      "rename",
      "replace",
      "rmdir",
      "robocopy",
      "set",
      "setlocal",
      "sc",
      "schtasks",
      "shift",
      "shutdown",
      "sort",
      "start",
      "subst",
      "systeminfo",
      "tasklist",
      "taskkill",
      "time",
      "title",
      "tree",
      "type",
      "ver",
      "verify",
      "vol",
      "xcopy",
      // Add PowerShell to the list of commands that require a shell
      "powershell",
      "pwsh",
      // Common PowerShell cmdlets/aliases that might be invoked if cmd.exe is the shell.
      // While `shell: true` on Windows defaults to `cmd.exe`, if a user's PATH
      // somehow led to PowerShell being invoked for these, this helps.
      // However, the primary target here is `cmd.exe` built-ins.
      "get-childitem",
      "select-string",
      "get-content",
      "set-content",
      "remove-item",
      "copy-item",
      "move-item",
      "rename-item",
      "new-item",
    ];
    if (firstCommand && windowsBuiltIns.includes(firstCommand)) {
      return true;
    }
  }

  // Original logic for shell operators:
  // If the command is a single string that contains shell operators,
  // it needs to be run with shell: true
  if (cmd.length === 1 && cmd[0] !== undefined) {
    // 'parse' is imported from 'shell-quote'
    const tokens = parse(cmd[0]) as Array<ParseEntry>;
    const needsShellForOperator = tokens.some(
      (token) => typeof token === "object" && "op" in token,
    );
    return needsShellForOperator;
  }

  // If the command is split into multiple arguments (and not a Windows built-in from above),
  // we don't need shell: true even if one of the arguments is a shell operator like '|'.
  // The individual program would handle its arguments.
  return false;
}

/**
 * This function should never return a rejected promise: errors should be
 * mapped to a non-zero exit code and the error message should be in stderr.
 */
export function exec(
  {
    cmd,
    workdir,
    timeoutInMillis,
    additionalWritableRoots,
  }: ExecInput & { additionalWritableRoots: ReadonlyArray<string> },
  sandbox: SandboxType,
  config: AppConfig,
  abortSignal?: AbortSignal,
): Promise<ExecResult> {
  let commandToExecute = [...cmd]; // Clone to allow modification
  let isCdCommand = false;
  const originalCommandForLogging = [...cmd]; // For logging, if we modify commandToExecute

  if (cmd[0]?.toLowerCase() === "cd" && cmd.length > 1) {
    isCdCommand = true;
    const cdArgs = cmd.slice(1).join(" ");
    const dirSuffix = process.platform === "win32" ? " && cd" : " && pwd";
    // Combine into a single command string for shell execution
    commandToExecute = [`cd ${cdArgs}${dirSuffix}`];
  }

  const opts: SpawnOptions = {
    timeout: timeoutInMillis || DEFAULT_TIMEOUT_MS,
    // If it's a cd command modified for pwd/cd, it definitely needs a shell.
    // Otherwise, use requiresShell for the original command.
    ...(isCdCommand || requiresShell(originalCommandForLogging)
      ? { shell: true }
      : {}),
    ...(workdir ? { cwd: workdir } : {}),
  };

  // Choose the executor based on sandbox type
  let executorPromise: Promise<ExecResult>;
  switch (sandbox) {
    case SandboxType.NONE: {
      executorPromise = rawExec(commandToExecute, opts, config, abortSignal);
      break;
    }
    case SandboxType.MACOS_SEATBELT: {
      const writableRoots = [
        process.cwd(),
        os.tmpdir(),
        ...additionalWritableRoots,
      ];
      executorPromise = execWithSeatbelt(
        commandToExecute,
        opts,
        writableRoots,
        config,
        abortSignal,
      );
      break;
    }
    case SandboxType.LINUX_LANDLOCK: {
      executorPromise = execWithLandlock(
        commandToExecute,
        opts,
        additionalWritableRoots,
        config,
        abortSignal,
      );
      break;
    }
  }

  return executorPromise.then((result) => {
    if (isCdCommand && result.exitCode === 0 && result.stdout) {
      const lines = result.stdout.trim().split(/\r?\n/);
      const newPath = lines.pop()?.trim(); // Get the last non-empty line
      if (newPath) {
        // Potentially resolve relative paths against the previous workdir
        // or ensure it's an absolute path.
        // For now, assume the output of pwd/cd is absolute or resolvable from current context.
        return { ...result, newWorkdir: newPath };
      }
    }
    return result;
  });
}

export function execApplyPatch(
  patchText: string,
  workdir: string | undefined = undefined,
): ExecResult {
  // This find/replace is required from some models like 4.1 where the patch
  // text is wrapped in quotes that breaks the apply_patch command.
  let applyPatchInput = patchText
    .replace(/('|")?<<('|")EOF('|")/, "")
    .replace(/\*\*\* End Patch\nEOF('|")?/, "*** End Patch")
    .trim();

  if (!applyPatchInput.endsWith(PATCH_SUFFIX)) {
    applyPatchInput += "\n" + PATCH_SUFFIX;
  }

  log(`Applying patch: \`\`\`${applyPatchInput}\`\`\`\n\n`);

  try {
    const result = process_patch(
      applyPatchInput,
      (p) => fs.readFileSync(resolvePathAgainstWorkdir(p, workdir), "utf8"),
      (p, c) => {
        const resolvedPath = resolvePathAgainstWorkdir(p, workdir);

        // Ensure the parent directory exists before writing the file. This
        // mirrors the behaviour of the standalone apply_patch CLI (see
        // write_file() in apply-patch.ts) and prevents errors when adding a
        // new file in a not‑yet‑created sub‑directory.
        const dir = path.dirname(resolvedPath);
        if (dir !== ".") {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(resolvedPath, c, "utf8");
      },
      (p) => fs.unlinkSync(resolvePathAgainstWorkdir(p, workdir)),
    );
    return {
      stdout: result,
      stderr: "",
      exitCode: 0,
    };
  } catch (error: unknown) {
    // @ts-expect-error error might not be an object or have a message property.
    const stderr = String(error.message ?? error);
    return {
      stdout: "",
      stderr: stderr,
      exitCode: 1,
    };
  }
}

export function getBaseCmd(cmd: Array<string>): string {
  const formattedCommand = formatCommandForDisplay(cmd);
  return formattedCommand.split(" ")[0] || cmd[0] || "<unknown>";
}
