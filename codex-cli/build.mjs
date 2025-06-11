import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

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

const inkResolverPlugin = {
  name: "ink-resolver",
  setup(build) {
    const inkSourcePath = path.resolve(".ink-source-for-build");
    const inkBuildPath = path.join(inkSourcePath, "build");

    // Resolve 'ink' itself to our temporary source
    build.onResolve({ filter: /^ink$/ }, args => {
      return { path: path.join(inkBuildPath, "index.js") };
    });

    // Resolve relative paths like './components/Box.js' originating from our patched Ink source
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      const normImporter = path.normalize(args.importer);
      const inkBuildRootSourceFromPatch = path.normalize(inkBuildPath);

      // This resolver should only act on files inside the patched ink directory.
      // If the file doing the importing is not in our patched source, ignore it.
      if (!normImporter.startsWith(inkBuildRootSourceFromPatch)) {
        return undefined;
      }

      // The importer is within our patched source, so resolve the import relative to it.
      const baseResolveDir = path.dirname(normImporter);
      const targetPath = path.resolve(baseResolveDir, args.path);

      // Helper to check for file existence with different extensions, since Ink's source
      // uses extensionless imports (e.g., import './components/Box').
      const checkAndResolve = (p) => {
        const pJs = p + '.js';
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return { path: p };
        if (fs.existsSync(pJs) && fs.statSync(pJs).isFile()) return { path: pJs };
        
        // Check for directory with index.js file (e.g., './components/')
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
          const pIndexJs = path.join(p, 'index.js');
          if (fs.existsSync(pIndexJs) && fs.statSync(pIndexJs).isFile()) return { path: pIndexJs };
        }
        return null;
      };

      const resolved = checkAndResolve(targetPath);
      if (resolved) {
        // console.log(`[ink-resolver] Relative: '${args.path}' (from '${args.importer}') -> '${resolved.path}'`);
        return resolved;
      }

      // If we couldn't resolve it, let esbuild try. This might happen for node built-ins etc.
      return undefined;
    });
  }
};

const plugins = [ignoreReactDevToolsPlugin, inkResolverPlugin]; // Initialize with plugins

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
  sourcemap: false, // Was: isDevBuild ? "inline" : true,
  plugins,
  define: {
    __BUILD_ID__: JSON.stringify(String(Date.now())), // Dynamic build ID
  },
  inject: ["./require-shim.js"], // Restore inject
  external: ["../package.json", "encoding", "iconv-lite", "es-toolkit"],
  conditions: ["node", "node-addons", "import"],
  resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".css", ".json", ".mjs"],
  treeShaking: false, // Keep for prod, or decide later
  logLevel: 'debug',
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

  const inkSourcePath = path.resolve(".ink-source-for-build");
  try {
    console.log(`[build.mjs] Assuming Ink source is already prepared in: ${inkSourcePath}`);
    // Verify extraction by checking for a key file
    const expectedInkFile = path.join(inkSourcePath, 'build', 'index.js');
    if (!fs.existsSync(inkSourcePath) || !fs.existsSync(expectedInkFile)) {
      console.error(`[build.mjs] CRITICAL: Ink source directory '.ink-source-for-build' or key file '${expectedInkFile}' not found. Please prepare it manually using 'pnpm patch ink@5.2.1 --edit-dir=.ink-source-for-build' and then stop the patch command.`);
      throw new Error('Ink source not found or incomplete.');
    }
    console.log(`[build.mjs] Ink source successfully located and verified (found ${expectedInkFile}).`);

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
        sourcemap: false, // Ensure prod sourcemap is false
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
    // Log warnings and errors from esbuild regardless of build mode
    if (result.warnings && result.warnings.length > 0) {
      console.warn(
        "[build.mjs] esbuild reported warnings:",
        JSON.stringify(result.warnings, null, 2),
      );
    }
    if (result.errors && result.errors.length > 0) {
      console.error(
        "[build.mjs] esbuild reported errors:",
        JSON.stringify(result.errors, null, 2),
      );
      console.error(
        "[build.mjs] Forcing exit due to esbuild errors.",
      );
      process.exit(1); // Exit for errors in any build mode
    }

    // --- Add this check ---
    if (!result.errors || result.errors.length === 0) {
        const expectedOutfile = currentBuildOptions.outfile;
        if (expectedOutfile && fs.existsSync(expectedOutfile)) {
            const stats = fs.statSync(expectedOutfile);
            if (stats.size > 0) {
                console.log(`[build.mjs] esbuild build successful. Output file: ${expectedOutfile} (Size: ${stats.size} bytes)`);
                const markerFilePath = path.resolve(OUT_DIR, "build_marker.txt");
                fs.writeFileSync(markerFilePath, "Build script 'build.mjs' believes it completed successfully at " + new Date().toISOString());
                console.log(`[build.mjs] Created marker file: ${markerFilePath}`);
            } else {
                console.error(`[build.mjs] CRITICAL ERROR: esbuild completed without errors, but output file ${expectedOutfile} is EMPTY.`);
                process.exit(1);
            }
        } else {
            console.error(`[build.mjs] CRITICAL ERROR: esbuild completed without errors, but output file ${expectedOutfile} was NOT CREATED.`);
            process.exit(1);
        }
    }
    // --- End of added check ---
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
    console.error("[build.mjs] Build failed. Detailed error information will be written to esbuild-error-details.json");
    const errorDetails = {
      message: error.message,
      stack: error.stack,
      properties: JSON.parse(JSON.stringify(error, Object.getOwnPropertyNames(error))), // Deep clone to capture all properties
      esbuildErrors: (error && error.errors && Array.isArray(error.errors)) ? error.errors : undefined,
      esbuildWarnings: (error && error.warnings && Array.isArray(error.warnings)) ? error.warnings : undefined,
    };
    try {
      fs.writeFileSync(path.resolve("./esbuild-error-details.json"), JSON.stringify(errorDetails, null, 2));
      console.log("[build.mjs] Successfully wrote error details to esbuild-error-details.json");
    } catch (writeError) {
      console.error("[build.mjs] Failed to write error details to file:", writeError);
    }
    console.log("[build.mjs] Forcing exit due to error. Waiting 100ms for logs to flush...");
    setTimeout(() => {
      process.exit(1); // Force exit on error
    }, 100);
  } finally {
    // Temporarily disabled cleanup of inkSourcePath for manual testing
    // if (fs.existsSync(inkSourcePath)) {
    //   console.log(`[build.mjs] Cleaning up Ink source directory: ${inkSourcePath}`);
    //   fs.rmSync(inkSourcePath, { recursive: true, force: true });
    // }
    console.log(
      "[build.mjs] File renaming logic in 'finally' block is temporarily disabled.",
    );
  }
}

build();
