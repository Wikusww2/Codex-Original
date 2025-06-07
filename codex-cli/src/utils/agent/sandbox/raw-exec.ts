import type { ExecResult } from "./interface";
import type { AppConfig } from "../../config";
import type { ChildProcess, SpawnOptions } from "child_process";

import { log } from "../../logger/log.js";
import { adaptCommandForPlatform } from "../platform-commands.js";
import { createTruncatingCollector } from "./create-truncating-collector";
import { spawn } from "child_process";
import * as os from "os";
import { requiresShell as utilRequiresShell } from "../exec";
import kill from "tree-kill";

/**
 * This function should never return a rejected promise: errors should be
 * mapped to a non-zero exit code and the error message should be in stderr.
 */
export function exec(
  originalCmd: Array<string>, // Renamed parameter
  options: SpawnOptions,
  config: AppConfig,
  abortSignal?: AbortSignal,
): Promise<ExecResult> {
  console.log(
    `[raw-exec] exec called with originalCmd: ${JSON.stringify(originalCmd)}, workdir: ${options.cwd}`,
  ); // Updated log

  // Adapt command for the current platform (e.g., convert 'ls' to 'dir' on Windows)
  let adaptedCommand = adaptCommandForPlatform(originalCmd); // Updated - changed to let for mutability
  console.log(`[raw-exec] adaptedCommand: ${JSON.stringify(adaptedCommand)}`);

  // Check if this is a PowerShell command
  const isPowerShellCommand =
    adaptedCommand[0]?.toLowerCase() === "powershell" ||
    adaptedCommand[0]?.toLowerCase() === "pwsh";

  // Special handling for PowerShell commands with complex syntax
  if (isPowerShellCommand && adaptedCommand.length > 1) {
    // If we have PowerShell with -Command, ensure the rest is properly handled as a single command
    if (adaptedCommand[1] === "-Command" || adaptedCommand[1] === "-c") {
      if (adaptedCommand.length > 2) {
        // Combine all remaining arguments into a single PowerShell script
        // Get the PowerShell script and properly escape for Windows shell
        let powershellScript = adaptedCommand.slice(2).join(" ");

        // For Windows, wrap the entire script in single quotes and escape any existing single quotes
        if (process.platform === "win32") {
          // Escape single quotes by replacing ' with '' (PowerShell escaping) and wrap in single quotes
          powershellScript = powershellScript.replace(/'/g, "''");
          // For logging purposes only
          console.log(
            `[raw-exec] Original PowerShell script: ${powershellScript}`,
          );
        }
        // Replace the original arguments with a properly escaped single command
        const shellCommand = adaptedCommand[0] || "powershell";
        adaptedCommand = [shellCommand, "-Command", powershellScript];
        console.log(
          `[raw-exec] Reformatted PowerShell command: ${JSON.stringify(adaptedCommand)}`,
        );

        // For logging purposes only
        if (process.platform === "win32") {
          console.log(
            `[raw-exec] PowerShell command to execute directly in PowerShell: ${powershellScript}`,
          );
        }
      }
    }
  }

  // Either use the requiresShell function or force shell for PowerShell commands
  const needsShell = isPowerShellCommand || utilRequiresShell(adaptedCommand);
  console.log(
    `[raw-exec] utilRequiresShell for adaptedCommand returned: ${needsShell} (isPowerShellCommand: ${isPowerShellCommand})`,
  );

  if (JSON.stringify(adaptedCommand) !== JSON.stringify(originalCmd)) {
    // Updated
    log(
      `Command adapted for platform: ${originalCmd.join(
        // Updated
        " ",
      )} -> ${adaptedCommand.join(" ")}`,
    );
  }

  const prog = adaptedCommand[0];
  if (typeof prog !== "string") {
    return Promise.resolve({
      stdout: "",
      stderr: "command[0] is not a string",
      exitCode: 1,
    });
  }

  // We use spawn() instead of exec() or execFile() so that we can set the
  // stdio options to "ignore" for stdin. Ripgrep has a heuristic where it
  // may try to read from stdin as explained here:
  //
  // https://github.com/BurntSushi/ripgrep/blob/e2362d4d5185d02fa857bf381e7bd52e66fafc73/crates/core/flags/hiargs.rs#L1101-L1103
  //
  // This can be a problem because if you save the following to a file and
  // run it with `node`, it will hang forever:
  //
  // ```
  // const {execFile} = require('child_process');
  //
  // execFile('rg', ['foo'], (error, stdout, stderr) => {
  //   if (error) {
  //     console.error(`error: ${error}n\nstderr: ${stderr}`);
  //   } else {
  //     console.log(`stdout: ${stdout}`);
  //   }
  // });
  // ```
  //
  // Even if you pass `{stdio: ["ignore", "pipe", "pipe"] }` to execFile(), the
  // hang still happens as the `stdio` is seemingly ignored. Using spawn()
  // works around this issue.

  // Construct spawn options
  const spawnOptionsForExec: SpawnOptions = {
    ...options, // Contains cwd, timeout from caller (e.g., handle-exec-command.ts)
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], // Force stdin to "ignore", pipe stdout/stderr
    detached: true, // Launch in its own process group for reliable termination
    ...(needsShell ? { shell: true } : {}), // Conditionally add shell option
  };
  console.log(
    `[raw-exec] Calculated spawnOptionsForExec: ${JSON.stringify(spawnOptionsForExec)}`,
  );
  console.log(
    `[raw-exec] Spawning: executable='${prog}', args=${JSON.stringify(adaptedCommand.slice(1))}`,
  );

  const child: ChildProcess = spawn(
    prog,
    adaptedCommand.slice(1),
    spawnOptionsForExec,
  );
  let childSpawnedPid: number | null = null;
  child.stdout?.once("data", (d: Buffer) => {
    const m = d.toString().match(/^(\d+)/);
    if (m) {
      childSpawnedPid = Number(m[1]);
    }
  });
  // If an AbortSignal is provided, ensure the spawned process is terminated
  // when the signal is triggered so that cancellations propagate down to any
  // long‑running child processes. We default to SIGTERM to give the process a
  // chance to clean up, falling back to SIGKILL if it does not exit in a
  // timely fashion.
  if (abortSignal) {
    const abortHandler = () => {
      log(`raw-exec: abort signal received – killing child ${child.pid}`);
      const killTarget = (signal: NodeJS.Signals) => {
        if (child.pid) {
          kill(child.pid, signal, (err) => {
            if (err) {
              log(
                `Error attempting to tree-kill process ${child.pid} with signal ${signal}: ${err.message}`,
              );
              // Fallback or further error handling if tree-kill fails
              try {
                if (child.pid && !child.killed) {
                  // Check if still exists and not killed
                  process.kill(child.pid, signal); // Try direct kill as a last resort
                }
              } catch (e2) {
                log(
                  `Fallback process.kill for ${child.pid} also failed: ${(e2 as Error).message}`,
                );
              }
            } else {
              log(`Successfully sent ${signal} to process tree ${child.pid}`);
            }
          });
        }
      };

      // First try graceful termination.
      console.log("Attempting to terminate child process group with SIGTERM");
      killTarget("SIGTERM");
      try {
        child.kill("SIGTERM");
      } catch {}

      // Immediately send SIGKILL to ensure termination.
      console.log("Sending SIGKILL to child process group");
      killTarget("SIGKILL");
      try {
        child.kill("SIGKILL");
      } catch {}
      if (childSpawnedPid) {
        try {
          process.kill(childSpawnedPid, "SIGKILL");
        } catch {}
      }
    };
    if (abortSignal.aborted) {
      abortHandler();
    } else {
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
  }
  // If spawning the child failed (e.g. the executable could not be found)
  // `child.pid` will be undefined *and* an `error` event will be emitted on
  // the ChildProcess instance.  We intentionally do **not** bail out early
  // here.  Returning prematurely would leave the `error` event without a
  // listener which – in Node.js – results in an "Unhandled 'error' event"
  // process‑level exception that crashes the CLI.  Instead we continue with
  // the normal promise flow below where we are guaranteed to attach both the
  // `error` and `exit` handlers right away.  Either of those callbacks will
  // resolve the promise and translate the failure into a regular
  // ExecResult object so the rest of the agent loop can carry on gracefully.

  return new Promise<ExecResult>((resolve) => {
    // Get shell output limits from config if available
    const maxBytes = config?.tools?.shell?.maxBytes;
    const maxLines = config?.tools?.shell?.maxLines;

    // Collect stdout and stderr up to configured limits.
    const stdoutCollector = createTruncatingCollector(
      child.stdout!,
      maxBytes,
      maxLines,
    );
    const stderrCollector = createTruncatingCollector(
      child.stderr!,
      maxBytes,
      maxLines,
    );

    child.on("exit", (code, signal) => {
      const stdout = stdoutCollector.getString();
      const stderr = stderrCollector.getString();

      // Map (code, signal) to an exit code. We expect exactly one of the two
      // values to be non-null, but we code defensively to handle the case where
      // both are null.
      let exitCode: number;
      if (code != null) {
        exitCode = code;
      } else if (signal != null && signal in os.constants.signals) {
        const signalNum =
          os.constants.signals[signal as keyof typeof os.constants.signals];
        exitCode = 128 + signalNum;
      } else {
        exitCode = 1;
      }

      log(
        `raw-exec: child ${child.pid} exited code=${exitCode} signal=${signal}`,
      );

      const execResult = {
        stdout,
        stderr,
        exitCode,
      };
      setTimeout(() => {
        resolve(
          addTruncationWarningsIfNecessary(
            execResult,
            stdoutCollector.hit,
            stderrCollector.hit,
          ),
        );
      }, 100);
    });

    child.on("error", (err) => {
      const execResult = {
        stdout: "",
        stderr: String(err),
        exitCode: 1,
      };
      resolve(
        addTruncationWarningsIfNecessary(
          execResult,
          stdoutCollector.hit,
          stderrCollector.hit,
        ),
      );
    });
  });
}

/**
 * Adds a truncation warnings to stdout and stderr, if appropriate.
 */
function addTruncationWarningsIfNecessary(
  execResult: ExecResult,
  hitMaxStdout: boolean,
  hitMaxStderr: boolean,
): ExecResult {
  if (!hitMaxStdout && !hitMaxStderr) {
    return execResult;
  } else {
    const { stdout, stderr, exitCode } = execResult;
    return {
      stdout: hitMaxStdout
        ? stdout + "\n\n[Output truncated: too many lines or bytes]"
        : stdout,
      stderr: hitMaxStderr
        ? stderr + "\n\n[Output truncated: too many lines or bytes]"
        : stderr,
      exitCode,
    };
  }
}
