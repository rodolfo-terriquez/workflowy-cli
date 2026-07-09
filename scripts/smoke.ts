import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = join(import.meta.dir, "..");
const binary = existsSync(join(root, "dist/wf.exe"))
  ? join(root, "dist/wf.exe")
  : join(root, "dist/wf");

if (!existsSync(binary)) {
  throw new Error(`Compiled binary not found: ${binary}`);
}

const packageVersion = (await Bun.file(join(root, "package.json")).json() as { version: string }).version;

async function run(args: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn([binary, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `${args.join(" ")} exited with ${exitCode}`);
  }
  return stdout.trim();
}

const topLevelVersion = await run(["--version"]);
if (topLevelVersion !== packageVersion) {
  throw new Error(`Binary version ${topLevelVersion} does not match package version ${packageVersion}`);
}

const configDir = mkdtempSync(join(tmpdir(), "workflowy-cli-smoke-"));
let daemonPid: number | null = null;
try {
  const workflowsDir = join(configDir, "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, "compiled-smoke.yaml"), `name: compiled-smoke
steps:
  - id: version
    command: version
    output: version
`);

  const workflowOutput = JSON.parse(await run(
    ["--agent", "workflow:run", "compiled-smoke"],
    { WORKFLOWY_CONFIG_DIR: configDir },
  )) as { results?: Array<{ success?: boolean; output?: { app_version?: string } }> };

  const result = workflowOutput.results?.[0];
  if (!result?.success || result.output?.app_version !== packageVersion) {
    throw new Error(`Compiled workflow self-invocation failed: ${JSON.stringify(workflowOutput)}`);
  }

  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    activeAccount: "default",
    accounts: { default: { name: "default", token: "smoke-test-token" } },
  }), { mode: 0o600 });

  const daemonStart = JSON.parse(await run(
    ["--agent", "cache:sync", "--watch"],
    { WORKFLOWY_CONFIG_DIR: configDir },
  )) as { daemon_pid?: number; daemon_running?: boolean };
  if (!daemonStart.daemon_running || !daemonStart.daemon_pid) {
    throw new Error(`Compiled sync daemon did not start: ${JSON.stringify(daemonStart)}`);
  }
  daemonPid = daemonStart.daemon_pid;
  process.kill(daemonPid, 0);

  const daemonStop = JSON.parse(await run(
    ["--agent", "cache:sync", "--stop"],
    { WORKFLOWY_CONFIG_DIR: configDir },
  )) as { daemon_running?: boolean };
  if (daemonStop.daemon_running !== false) {
    throw new Error(`Compiled sync daemon did not stop cleanly: ${JSON.stringify(daemonStop)}`);
  }
  daemonPid = null;
} finally {
  if (daemonPid) {
    try { process.kill(daemonPid); } catch { /* already stopped */ }
  }
  rmSync(configDir, { recursive: true, force: true });
}

console.log(`Compiled binary smoke checks passed for ${packageVersion}.`);
