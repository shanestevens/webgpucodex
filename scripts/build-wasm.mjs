import { access, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const quiet = process.argv.includes("--quiet");
const root = process.cwd();
const sourcePath = path.join(root, "wasm", "cpp-kernel.cpp");
const outputDir = path.join(root, "src", "generated-wasm");
const outputModulePath = path.join(outputDir, "cpp-kernel.mjs");
const outputBinaryPath = path.join(outputDir, "cpp-kernel.wasm");
const emccPath = path.join(root, ".tools", "emsdk", "upstream", "emscripten", "emcc.bat");

const log = (message) => {
  if (!quiet) {
    console.log(message);
  }
};

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureToolchainOrFallback() {
  if (await fileExists(emccPath)) {
    return true;
  }

  const generatedOutputsExist =
    (await fileExists(outputModulePath)) && (await fileExists(outputBinaryPath));

  if (generatedOutputsExist) {
    log("Repo-local Emscripten was not found; using checked-in generated WASM artifacts.");
    return false;
  }

  throw new Error(
    "Repo-local Emscripten was not found, and no generated WASM artifacts are available. Expected emcc at .tools/emsdk/upstream/emscripten/emcc.bat or existing outputs in src/generated-wasm/.",
  );
}

function quoteWindowsArgument(value) {
  if (value.length === 0) {
    return '""';
  }

  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;
}

async function runBuild() {
  const hasToolchain = await ensureToolchainOrFallback();
  if (!hasToolchain) {
    return;
  }

  await mkdir(outputDir, { recursive: true });

  const args = [
    quoteWindowsArgument(emccPath),
    quoteWindowsArgument(sourcePath),
    "-O3",
    "-std=c++20",
    "-fno-exceptions",
    "-fno-rtti",
    "-s",
    "MODULARIZE=1",
    "-s",
    "EXPORT_ES6=1",
    "-s",
    "ENVIRONMENT=web",
    "-s",
    "ALLOW_MEMORY_GROWTH=1",
    "-s",
    "FILESYSTEM=0",
    "-s",
    "ASSERTIONS=0",
    "-s",
    "EXPORT_ALL=1",
    "-s",
    "EXPORT_NAME=createCppKernelModule",
    "-s",
    'EXPORTED_FUNCTIONS=["_malloc","_free","_analyze_polygon","_analyze_heightfield","_quantize_unit_f32","_build_heightfield_mesh","_step_rotation","_update_swarm","_simulate_swarm_frames"]',
    "-s",
    "EXPORTED_RUNTIME_METHODS=[]",
    "-o",
    quoteWindowsArgument(outputModulePath),
  ];

  const command = args.join(" ");

  await new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", command], {
      cwd: root,
      stdio: quiet ? "pipe" : "inherit",
      shell: false,
    });

    let stderr = "";

    if (quiet) {
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }

      reject(new Error(stderr || `emcc exited with code ${code}`));
    });
  });

  log(`Built ${path.relative(root, outputModulePath)}`);
}

await runBuild();
