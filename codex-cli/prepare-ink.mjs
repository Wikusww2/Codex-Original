import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const inkSourcePath = path.resolve(".ink-source-for-build");
const expectedInkFile = path.join(inkSourcePath, 'build', 'index.js');

async function prepareInkSource() {
  console.log(`[prepare-ink.mjs] Starting Ink source preparation...`);
  try {
    if (fs.existsSync(inkSourcePath)) {
      console.log(`[prepare-ink.mjs] Deleting existing Ink source directory: ${inkSourcePath}`);
      fs.rmSync(inkSourcePath, { recursive: true, force: true });
    }

    const inkPatchCommand = `pnpm patch ink@5.2.1 --edit-dir=.ink-source-for-build`;
    console.log(`[prepare-ink.mjs] Attempting to extract Ink source with command: ${inkPatchCommand} (timeout: 10s)`);
    // For spawnSync, command and args are separate. pnpm is the command.
    const result = spawnSync('pnpm', ['patch', 'ink@5.2.1', '--edit-dir=.ink-source-for-build'], { stdio: ['pipe', 'pipe', 'inherit'], timeout: 10000, shell: true });

    if (result.status === 0) {
      console.log(`[prepare-ink.mjs] pnpm patch command completed with status 0 (unexpected, as it usually waits for patch-commit).`);
    } else if (result.signal === 'SIGTERM' || result.error?.code === 'ETIMEDOUT') {
      console.warn(`[prepare-ink.mjs] pnpm patch command timed out or was killed by signal, as expected for non-interactive extraction. Assuming files were extracted.`);
    } else {
      console.error(`[prepare-ink.mjs] Error during pnpm patch command execution.`);
      if (result.error) {
        console.error(`  Error: ${result.error.message}`);
      }
      if (result.stderr) {
        console.error(`  pnpm stderr: ${result.stderr.toString()}`);
      }
      console.error(`  Status: ${result.status}, Signal: ${result.signal}`);
      process.exit(1); // Exit if it's not a recognized timeout-related error or successful completion
    }

    // Verification logic now inside the try block
    if (!fs.existsSync(inkSourcePath) || !fs.existsSync(expectedInkFile)) {
      console.error(`[prepare-ink.mjs] CRITICAL: Ink source extraction failed. Directory '${inkSourcePath}' or key file '${expectedInkFile}' not found after patch attempt.`);
      process.exit(1);
    }
    console.log(`[prepare-ink.mjs] Ink source successfully extracted and verified (found ${expectedInkFile}).`);

  } catch (error) { // Catch for the main try block
    console.error(`[prepare-ink.mjs] An unexpected error occurred during Ink source preparation:`, error);
    process.exit(1);
  }
}

prepareInkSource();
