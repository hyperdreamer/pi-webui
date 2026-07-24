import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunNpxOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunNpxResult {
  stdout: string;
  stderr: string;
}

/**
 * Invoke npx without a shell. Windows exposes npx as a .cmd shim that cannot
 * safely be used with execFile, so prefer npm's JavaScript entry point when it
 * is colocated with the active Node installation.
 */
export async function runNpx(args: readonly string[], options: RunNpxOptions = {}): Promise<RunNpxResult> {
  const npxCli = findNpxCli();
  const command = npxCli === undefined ? "npx" : execPath;
  const commandArgs = npxCli === undefined ? args : [npxCli, ...args];
  return await execFileAsync(command, commandArgs, {
    timeout: options.timeout,
    cwd: options.cwd,
    env: options.env,
  });
}

function findNpxCli(): string | undefined {
  const nodeDir = dirname(execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
