import type { CommandConfirmation } from "./agent-loop.js";
import type {
  ApplyPatchCommand,
  ApprovalPolicy,
  SafetyAssessment,
} from "../../approvals.js";
import type { ExecInput } from "./sandbox/interface.js";
import type { ResponseInputItem } from "openai/resources/responses/responses.mjs";

import { canAutoApprove } from "../../approvals.js";
import { formatCommandForDisplay } from "../../format-command.js";
import { CODEX_UNSAFE_ALLOW_NO_SANDBOX, type AppConfig } from "../config.js";
import { exec, execApplyPatch } from "./exec.js";
import { ReviewDecision } from "./review.js";
import { isLoggingEnabled, log } from "../logger/log.js";
import { SandboxType } from "./sandbox/interface.js";
import { PATH_TO_SEATBELT_EXECUTABLE } from "./sandbox/macos-seatbelt.js";
import fs from "fs/promises";

// ---------------------------------------------------------------------------
// Session‑level cache of commands that the user has chosen to always approve.
//
// The values are derived via `deriveCommandKey()` which intentionally ignores
// volatile arguments (for example the patch text passed to `apply_patch`).
// Storing *generalised* keys means that once a user selects "always approve"
// for a given class of command we will genuinely stop prompting them for
// subsequent, equivalent invocations during the same CLI session.
// ---------------------------------------------------------------------------
const alwaysApprovedCommands = new Set<string>();

// ---------------------------------------------------------------------------
// Helper: Given the argv-style representation of a command, return a stable
// string key that can be used for equality checks.
//
// The key space purposefully abstracts away parts of the command line that
// are expected to change between invocations while still retaining enough
// information to differentiate *meaningfully distinct* operations.  See the
// extensive inline documentation for details.
// ---------------------------------------------------------------------------

function deriveCommandKey(cmd: Array<string>): string {
  // pull off only the bits you care about
  const [
    maybeShell,
    maybeFlag,
    coreInvocation,
    /* …ignore the rest… */
  ] = cmd;

  if (coreInvocation?.startsWith("apply_patch")) {
    return "apply_patch";
  }

  if (maybeShell === "bash" && maybeFlag === "-lc") {
    // If the command was invoked through `bash -lc "<script>"` we extract the
    // base program name from the script string.
    const script = coreInvocation ?? "";
    return script.split(/\s+/)[0] || "bash";
  }

  // For every other command we fall back to using only the program name (the
  // first argv element).  This guarantees we always return a *string* even if
  // `coreInvocation` is undefined.
  if (coreInvocation) {
    return coreInvocation.split(/\s+/)[0]!;
  }

  return JSON.stringify(cmd);
}

type HandleExecCommandResult = {
  outputText: string;
  metadata: Record<string, unknown>;
  additionalItems?: Array<ResponseInputItem>;
  newWorkdir?: string;
};

export async function handleExecCommand(
  args: ExecInput,
  config: AppConfig,
  policy: ApprovalPolicy,
  additionalWritableRoots: ReadonlyArray<string>,
  getCommandConfirmation: (
    safetyAssessment: SafetyAssessment,
    command: Array<string>,
    applyPatch: ApplyPatchCommand | undefined,
  ) => Promise<CommandConfirmation>,
  abortSignal?: AbortSignal,
): Promise<HandleExecCommandResult> {
  const { cmd: command, workdir } = args;

  const key = deriveCommandKey(command);

  // 1) If the user has already said "always approve" for this command key, skip
  //    any policy checks & never sandbox.
  if (alwaysApprovedCommands.has(key)) {
    return execCommand(
      args,
      undefined, // applyPatch is not relevant here as it's a general command approval
      false, // Explicitly false because user said "always"
      additionalWritableRoots,
      config,
      abortSignal,
    ).then(convertSummaryToResult);
  }

  // 2) Determine safety assessment using canAutoApprove
  const assessment = canAutoApprove(
    command,
    workdir,
    policy,
    additionalWritableRoots,
    // process.env, // canAutoApprove defaults to process.env if not provided
  );

  // Determine if this is an apply_patch command for later
  // This is a bit redundant if assessment.applyPatch is populated, but good for clarity
  const applyPatchCommandDetails =
    assessment.applyPatch ??
    (command[0] === "apply_patch" &&
    command.length === 2 &&
    typeof command[1] === "string"
      ? { patch: command[1] }
      : undefined);

  // 3) Based on assessment and policy, decide next steps
  if (assessment.type === "auto-approve") {
    // If canAutoApprove says to auto-approve, respect it.
    // The runInSandbox flag from the assessment will be used by execCommand.
    return execCommand(
      args,
      applyPatchCommandDetails, // Pass applyPatch details from assessment or derived
      assessment.runInSandbox,
      additionalWritableRoots,
      config,
      abortSignal,
    ).then(convertSummaryToResult);
  } else if (assessment.type === "reject") {
    // If canAutoApprove says to reject, do so.
    return {
      outputText: "rejected",
      metadata: { reason: assessment.reason },
      additionalItems: [
        {
          type: "message",
          role: "user", // Or system, depending on how you want it to appear
          content: [
            {
              type: "input_text",
              text: `Command rejected: ${assessment.reason}`,
            },
          ],
        },
      ],
    };
  } else {
    // assessment.type === "ask-user"
    // If canAutoApprove says to ask the user, then proceed to ask.
    const userPermissionResult = await askUserPermission(
      args,
      applyPatchCommandDetails,
      assessment, // Pass the assessment
      getCommandConfirmation,
    );

    if (userPermissionResult) {
      // User denied or wants to stop
      return userPermissionResult;
    }

    // User approved (or decision was EXPLAIN, which means proceed without explicit approval yet)
    // Determine sandboxing for user-approved commands after an "ask-user" assessment.
    let runInSandboxAfterUserApproval = false;
    if (policy === "full-auto") {
      // If the policy is full-auto and canAutoApprove still decided to ask the user,
      // it implies the command wasn't simple enough for the direct auto-approve paths
      // (which would have set runInSandbox: false if they were hit).
      // In this case, if the user approves, we should still honor the 'full-auto'
      // intent of running in a sandbox as a default precaution for this policy.
      runInSandboxAfterUserApproval = true;
    }
    // For 'suggest', 'auto-edit', or 'none' (though 'none' shouldn't reach 'ask-user'),
    // if the user explicitly approves after being asked, run without a sandbox.

    return execCommand(
      args,
      applyPatchCommandDetails,
      runInSandboxAfterUserApproval,
      additionalWritableRoots,
      config,
      abortSignal,
    ).then(convertSummaryToResult);
  }
}

function convertSummaryToResult(
  summary: ExecCommandSummary,
): HandleExecCommandResult {
  const { stdout, stderr, exitCode, durationMs, newWorkdir } = summary;
  const rawOutput =
    stdout ||
    stderr ||
    `(code: ${exitCode}, duration: ${Math.round(durationMs / 1000)}s)`;

  // IMPORTANT: OpenAI tool output seems to expect plain text for shell outputs
  // So we're returning the raw command output directly instead of JSON
  // This is the most compatible format based on the error messages
  const outputText = rawOutput;

  return {
    outputText,
    metadata: {
      exitCode,
      durationMs,
      raw_stdout: stdout,
      raw_stderr: stderr,
    },
    ...(newWorkdir && { newWorkdir }),
  };
}

type ExecCommandSummary = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  newWorkdir?: string;
};

async function execCommand(
  execInput: ExecInput,
  applyPatchCommand: ApplyPatchCommand | undefined,
  runInSandbox: boolean,
  additionalWritableRoots: ReadonlyArray<string>,
  config: AppConfig,
  abortSignal?: AbortSignal,
): Promise<ExecCommandSummary> {
  let { workdir } = execInput;
  if (workdir) {
    try {
      await fs.access(workdir);
    } catch (e) {
      log(`EXEC workdir=${workdir} not found, use process.cwd() instead`);
      workdir = process.cwd();
    }
  }

  if (applyPatchCommand != null) {
    log("EXEC running apply_patch command");
  } else if (isLoggingEnabled()) {
    const { cmd, timeoutInMillis } = execInput;
    // Seconds are a bit easier to read in log messages and most timeouts
    // are specified as multiples of 1000, anyway.
    const timeout =
      timeoutInMillis != null
        ? Math.round(timeoutInMillis / 1000).toString()
        : "undefined";
    log(
      `EXEC running \`${formatCommandForDisplay(
        cmd,
      )}\` in workdir=${workdir} with timeout=${timeout}s`,
    );
  }

  // Note execApplyPatch() and exec() are coded defensively and should not
  // throw. Any internal errors should be mapped to a non-zero value for the
  // exitCode field.
  const start = Date.now();
  const execResult =
    applyPatchCommand != null
      ? execApplyPatch(applyPatchCommand.patch, workdir)
      : await exec(
          { ...execInput, additionalWritableRoots },
          await getSandbox(runInSandbox),
          config,
          abortSignal,
        );
  const duration = Date.now() - start;
  const { stdout, stderr, exitCode } = execResult;

  if (isLoggingEnabled()) {
    log(
      `EXEC exit=${exitCode} time=${duration}ms:\n\tSTDOUT: ${stdout}\n\tSTDERR: ${stderr}`,
    );
  }

  return {
    stdout,
    stderr,
    exitCode,
    durationMs: duration,
  };
}

/** Return `true` if the `/usr/bin/sandbox-exec` is present and executable. */
const isSandboxExecAvailable: Promise<boolean> = fs
  .access(PATH_TO_SEATBELT_EXECUTABLE, fs.constants.X_OK)
  .then(
    () => true,
    (err) => {
      if (!["ENOENT", "ACCESS", "EPERM"].includes(err.code)) {
        log(
          `Unexpected error for \`stat ${PATH_TO_SEATBELT_EXECUTABLE}\`: ${err.message}`,
        );
      }
      return false;
    },
  );

async function getSandbox(runInSandbox: boolean): Promise<SandboxType> {
  if (runInSandbox) {
    if (process.platform === "darwin") {
      // On macOS we rely on the system-provided `sandbox-exec` binary to
      // enforce the Seatbelt profile.  However, starting with macOS 14 the
      // executable may be removed from the default installation or the user
      // might be running the CLI on a stripped-down environment (for
      // instance, inside certain CI images).  Attempting to spawn a missing
      // binary makes Node.js throw an *uncaught* `ENOENT` error further down
      // the stack which crashes the whole CLI.
      if (await isSandboxExecAvailable) {
        return SandboxType.MACOS_SEATBELT;
      } else {
        throw new Error(
          "Sandbox was mandated, but 'sandbox-exec' was not found in PATH!",
        );
      }
    } else if (process.platform === "linux") {
      // TODO: Need to verify that the Landlock sandbox is working. For example,
      // using Landlock in a Linux Docker container from a macOS host may not
      // work.
      return SandboxType.LINUX_LANDLOCK;
    } else if (CODEX_UNSAFE_ALLOW_NO_SANDBOX) {
      // Allow running without a sandbox if the user has explicitly marked the
      // environment as already being sufficiently locked-down.
      return SandboxType.NONE;
    }

    // For all else, we hard fail if the user has requested a sandbox and none is available.
    throw new Error("Sandbox was mandated, but no sandbox is available!");
  } else {
    return SandboxType.NONE;
  }
}

/**
 * If return value is non-null, then the command was rejected by the user.
 */
async function askUserPermission(
  args: ExecInput,
  applyPatchCommand: ApplyPatchCommand | undefined,
  safetyAssessment: SafetyAssessment,
  getCommandConfirmation: (
    safetyAssessment: SafetyAssessment,
    command: Array<string>,
    applyPatch: ApplyPatchCommand | undefined,
  ) => Promise<CommandConfirmation>,
): Promise<HandleExecCommandResult | null> {
  const { review: decision, customDenyMessage } = await getCommandConfirmation(
    safetyAssessment,
    args.cmd,
    applyPatchCommand,
  );

  if (decision === ReviewDecision.ALWAYS) {
    // Persist this command so we won't ask again during this session.
    const key = deriveCommandKey(args.cmd);
    alwaysApprovedCommands.add(key);
  }

  // Handle EXPLAIN decision by returning null to continue with the normal flow
  // but with a flag to indicate that an explanation was requested
  if (decision === ReviewDecision.EXPLAIN) {
    return null;
  }

  // Any decision other than an affirmative (YES / ALWAYS) or EXPLAIN aborts execution.
  if (decision !== ReviewDecision.YES && decision !== ReviewDecision.ALWAYS) {
    const note =
      decision === ReviewDecision.NO_CONTINUE
        ? customDenyMessage?.trim() || "No, don't do that — keep going though."
        : "No, don't do that — stop for now.";
    return {
      outputText: "aborted",
      metadata: {},
      additionalItems: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: note }],
        },
      ],
    };
  } else {
    return null;
  }
}
