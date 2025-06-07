import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const SRC_DIR = path.resolve("./src");

// --- Clean up stale temp files from previous runs ---
const filesInSrc = fs.readdirSync(SRC_DIR);
for (const file of filesInSrc) {
  if (file.startsWith("cli_original_") && file.endsWith(".tsx")) {
    fs.unlinkSync(path.join(SRC_DIR, file));
    console.log(`[build.mjs] Deleted stale temp file: ${file}`);
  }
  if (file.startsWith("cli_temp_") && file.endsWith(".tsx")) {
    fs.unlinkSync(path.join(SRC_DIR, file));
    console.log(`[build.mjs] Deleted stale temp file: ${file}`);
  }
}
// --- End clean up ---

const CODEX_VERSION = process.env.npm_package_version || "0.0.0-dev";
// Force production mode to ensure cli.js is created instead of cli-dev.js
const isDevBuild = false; // process.env.CODEX_DEV === "1";
const OUT_DIR = "dist";
const originalCliTsxPath = path.resolve("./src/cli.tsx");
let tempCliTsxPath = ""; // Will be set in build()
/**
 * ink attempts to import react-devtools-core in an ESM-unfriendly way:
 *
 * https://github.com/vadimdemedes/ink/blob/eab6ef07d4030606530d58d3d7be8079b4fb93bb/src/reconciler.ts#L22-L45
 *
 * to make this work, we have to strip the import out of the build.
 */
const ignoreReactDevToolsPlugin = {
  name: "ignore-react-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core\/standalone$/ }, (args) => {
      // Mark as external but provide the original path. For some reason, esbuild needs a valid path here
      // even if it's immediately marked as external. Using a dummy empty file or non-existent path fails.
      // This seems to satisfy esbuild to treat it as truly external and not try to bundle it.
      return { path: "react-devtools-core/standalone", external: true };
    });
  },
};

const plugins = [ignoreReactDevToolsPlugin]; // Initialize with the plugin

// ----------------------------------------------------------------------------
// Build mode detection (production vs development)
//
//  • production (default): minified, external telemetry shebang handling.
if (isDevBuild) {
  const devShebangPlugin = {
    name: "dev-shebang",
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors.length === 0 && build.initialOptions.outfile) {
          const outfile = build.initialOptions.outfile;
          let content = await fs.promises.readFile(outfile, "utf8");
          if (!content.startsWith("#!/usr/bin/env node")) {
            content = "#!/usr/bin/env node\n" + content;
            await fs.promises.writeFile(outfile, content);
            console.log(`[build.mjs] Added shebang to ${outfile}`);
          }
        }
      });
    },
  };
  // plugins.push(devShebangPlugin); // Still disabled for now
}

const prodBuildOptions = {
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.resolve(OUT_DIR, isDevBuild ? "cli-dev.js" : "cli.js"),
  minify: !isDevBuild,
  keepNames: true, // Prevent mangling of names, e.g. for enums
  sourcemap: isDevBuild ? "inline" : true,
  plugins,
  define: {
    __BUILD_ID__: JSON.stringify(String(Date.now())), // Dynamic build ID
  },
  inject: ["./require-shim.js"], // Restore inject
  external: ["../package.json"],
  treeShaking: false, // Keep for prod, or decide later
  // logLevel: 'debug', // Keep for prod if needed
  // drop: [], // Keep for prod if needed
};

const baseBuildOptions = isDevBuild ? {} : prodBuildOptions; // Placeholder, will define dev options next

async function build() {
  // tempCliTsxPath = path.resolve("./src/cli_temp_" + Date.now() + ".tsx"); // Temporarily disabled

  // Cleanup: Check for leftover temp file from a previous failed run
  // const srcDirContents = fs.readdirSync(path.resolve("./src")); // Temporarily disabled
  // const leftoverTempFile = srcDirContents.find(file => file.startsWith("cli_temp_") && file.endsWith(".tsx")); // Temporarily disabled
  // if (leftoverTempFile) { // Temporarily disabled
  //   const leftoverTempFilePath = path.resolve("./src", leftoverTempFile); // Temporarily disabled
  //   console.log(`[build.mjs] Found leftover temp file: ${leftoverTempFilePath}. Renaming it back to ${originalCliTsxPath}`); // Temporarily disabled
  //   try { // Temporarily disabled
  //     fs.renameSync(leftoverTempFilePath, originalCliTsxPath); // Temporarily disabled
  //   } catch (cleanupError) { // Temporarily disabled
  //     console.error(`[build.mjs] Error renaming leftover temp file: ${cleanupError}. Proceeding might fail.`); // Temporarily disabled
  //   } // Temporarily disabled
  // } // Temporarily disabled

  try {
    // fs.renameSync(originalCliTsxPath, tempCliTsxPath); // Temporarily disabled
    // console.log(`[build.mjs] Renamed ${originalCliTsxPath} to ${tempCliTsxPath}`); // Temporarily disabled

    // const tempFileContent = fs.readFileSync(tempCliTsxPath, "utf8"); // Temporarily disabled
    // const tempMarker = "// Force re-read by esbuild"; // Temporarily disabled
    // const tempMarkerIndex = tempFileContent.indexOf(tempMarker); // Temporarily disabled
    // if (tempMarkerIndex !== -1) { // Temporarily disabled
    //   console.log(`[build.mjs] Snippet from TEMP file ${tempCliTsxPath} (from '${tempMarker}', length approx 200 chars):\n---\n${tempFileContent.substring(tempMarkerIndex, tempMarkerIndex + 200)}\n---`); // Temporarily disabled
    // } else { // Temporarily disabled
    //   console.log(`[build.mjs] Diagnostic marker '${tempMarker}' not found in TEMP file ${tempCliTsxPath}!`); // Temporarily disabled
    // } // Temporarily disabled

    let currentBuildOptions;
    if (isDevBuild) {
      console.log("[build.mjs] Using MINIMAL dev build options.");
      console.log(
        "[build.mjs] Inspecting ignoreReactDevToolsPlugin for dev build:",
        typeof ignoreReactDevToolsPlugin,
        ignoreReactDevToolsPlugin
          ? ignoreReactDevToolsPlugin.name
          : "undefined",
      );
      currentBuildOptions = {
        entryPoints: [originalCliTsxPath],
        outfile: path.resolve(OUT_DIR, "cli-dev.js"),
        bundle: true,
        platform: "node",
        format: "esm",
        sourcemap: "inline",
        plugins: [],
        logLevel: "debug",
        logLimit: 100,
      };
    } else {
      console.log("[build.mjs] Using production build options.");
      currentBuildOptions = {
        ...prodBuildOptions,
        entryPoints: [originalCliTsxPath], // Using original path directly
        outfile: path.resolve(OUT_DIR, "cli.js"), // Force cli.js as output regardless of build mode
        minify: true, // Ensure prod minify is true
        sourcemap: true, // Ensure prod sourcemap is true (or 'external')
      };
    }

    const outPath = path.resolve(OUT_DIR);
    if (fs.existsSync(outPath)) {
      fs.rmSync(outPath, { recursive: true, force: true });
    }
    fs.mkdirSync(outPath, { recursive: true });
    console.log(`[build.mjs] Cleaned and created output directory: ${outPath}`);

    // --- File verification (using originalCliTsxPath) ---
    const originalFileContentForVerification = fs.readFileSync(
      originalCliTsxPath,
      "utf8",
    );
    if (originalFileContentForVerification.length > 0) {
      console.log(
        `[build.mjs] VERIFIED: originalCliTsxPath (${originalCliTsxPath}) contains content (${originalFileContentForVerification.length} bytes). Proceeding with build.`,
      );
    } else {
      console.error(
        `[build.mjs] CRITICAL ERROR: originalCliTsxPath (${originalCliTsxPath}) appears to be empty. Build will likely fail.`,
      );
    }
    // --- End verification ---

    console.log(
      "[build.mjs] esbuild options:",
      JSON.stringify(currentBuildOptions, null, 2),
    );
    const result = await esbuild.build(currentBuildOptions);
    if (isDevBuild && result.errors && result.errors.length > 0) {
      console.error(
        "[build.mjs] esbuild reported errors:",
        JSON.stringify(result.errors, null, 2),
      );
      console.log(
        "[build.mjs] Forcing exit due to esbuild errors (dev build).",
      );
      process.exit(1);
    }
    console.log(
      `[build.mjs] esbuild.build() promise resolved for ${currentBuildOptions.outfile}`,
    );
    // Check if the file exists RIGHT AFTER esbuild claims to have finished
    if (fs.existsSync(currentBuildOptions.outfile)) {
      console.log(
        `[build.mjs] CONFIRMED: ${currentBuildOptions.outfile} exists immediately after build.`,
      );
    } else {
      console.error(
        `[build.mjs] CRITICAL ERROR: ${currentBuildOptions.outfile} DOES NOT exist immediately after build. esbuild might have failed silently.`,
      );
      process.exit(1); // Force exit if file not found
    }
    console.log(
      `[build.mjs] Proceeding to read ${currentBuildOptions.outfile}`,
    );

    const buildOutputContent = fs.readFileSync(
      currentBuildOptions.outfile,
      "utf8",
    );
    console.log(
      `\n[build.mjs] START OF GENERATED FILE (${currentBuildOptions.outfile}):\n--------------------------------------------------\n${buildOutputContent.substring(0, 500)}\n--------------------------------------------------\n[build.mjs] END OF GENERATED FILE SNIPPET\n`,
    );
    // Intentionally removed snippet writing and direct marker checks as they are no longer needed.

    try {
      console.log(
        `[build.mjs] Attempting second read of ${currentBuildOptions.outfile} before script ends.`,
      );
      const secondReadContent = fs.readFileSync(
        currentBuildOptions.outfile,
        "utf8",
      );
      console.log(
        `[build.mjs] Second read successful. File size: ${secondReadContent.length}`,
      );
    } catch (readError) {
      console.error(
        `[build.mjs] CRITICAL ERROR: Failed second read of ${currentBuildOptions.outfile} before script exit:`,
        readError,
      );
      console.log("[build.mjs] Forcing exit due to second read failure.");
      process.exit(1);
    }
    console.log("[build.mjs] esbuild build successful.");
  } catch (error) {
    console.error("[build.mjs] Build failed in catch block:", error);
    console.log("[build.mjs] Forcing exit due to error in catch block.");
    process.exit(1); // Force exit on error
  } finally {
    console.log(
      "[build.mjs] File renaming logic in 'finally' block is temporarily disabled.",
    );
  }
}

build();
