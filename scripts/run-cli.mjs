import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

function normalizeWorkingDirectory(value) {
  if (!value) {
    return process.cwd();
  }

  return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

function splitCommands(values) {
  const commands = [];
  let current = [];

  for (const value of values) {
    if (value === "--next") {
      if (current.length > 0) {
        commands.push(current);
        current = [];
      }

      continue;
    }

    current.push(value);
  }

  if (current.length > 0) {
    commands.push(current);
  }

  return commands;
}

async function runCommandSequence() {
  const workingDirectory = normalizeWorkingDirectory(process.env.INIT_CWD || process.cwd());
  const commands = splitCommands(process.argv.slice(2));

  if (commands.length === 0) {
    throw new Error("Expected at least one CLI entrypoint.");
  }

  process.chdir(workingDirectory);

  for (const command of commands) {
    const [entrypoint, ...args] = command;
    const resolvedEntrypoint = path.isAbsolute(entrypoint) ? entrypoint : path.resolve(workingDirectory, entrypoint);

    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [resolvedEntrypoint, ...args], {
        cwd: workingDirectory,
        stdio: "inherit",
        env: process.env,
      });

      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`Process terminated by signal ${signal}`));
          return;
        }

        if (code !== 0) {
          reject(new Error(`Process exited with code ${code ?? "unknown"}`));
          return;
        }

        resolve();
      });
    });
  }
}

runCommandSequence().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
