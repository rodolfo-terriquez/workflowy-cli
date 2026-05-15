import { platform } from "os";

export async function copyToClipboard(text: string): Promise<boolean> {
  const os = platform();
  let cmd: string[];

  if (os === "darwin") {
    cmd = ["pbcopy"];
  } else if (os === "win32") {
    cmd = ["clip"];
  } else {
    cmd = ["xclip", "-selection", "clipboard"];
  }

  try {
    const proc = Bun.spawn(cmd, { stdin: "pipe" });
    proc.stdin.write(text);
    proc.stdin.end();
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    if (os === "linux") {
      try {
        const proc = Bun.spawn(["xsel", "--clipboard", "--input"], { stdin: "pipe" });
        proc.stdin.write(text);
        proc.stdin.end();
        await proc.exited;
        return proc.exitCode === 0;
      } catch {
        return false;
      }
    }
    return false;
  }
}
