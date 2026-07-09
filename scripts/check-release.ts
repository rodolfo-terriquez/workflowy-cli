import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

export async function getReleaseConsistencyErrors(env = process.env): Promise<string[]> {
  const errors: string[] = [];
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { version?: string };
  const packageVersion = packageJson.version ?? "";
  const versionSource = readFileSync(join(ROOT, "cli/shared/version.ts"), "utf-8");
  const appVersion = versionSource.match(/APP_VERSION\s*=\s*["']([^"']+)["']/)?.[1] ?? "";

  if (!packageVersion || !appVersion || packageVersion !== appVersion) {
    errors.push(`package.json version (${packageVersion || "missing"}) does not match APP_VERSION (${appVersion || "missing"})`);
  }

  const glob = new Bun.Glob("cli/**/*.ts");
  for await (const relativePath of glob.scan({ cwd: ROOT })) {
    const source = readFileSync(join(ROOT, relativePath), "utf-8");
    for (const match of source.matchAll(/(?:wf_version\s*:\s*|WF_VERSION\s*=\s*|APP_VERSION\s*=\s*)["'](\d+\.\d+\.\d+)["']/g)) {
      if (match[1] !== packageVersion) {
        errors.push(`${relativePath} contains version ${match[1]} instead of ${packageVersion}`);
      }
    }
  }

  const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
  const readmeVersion = readme.match(/Current version:\s*`([^`]+)`/)?.[1] ?? "";
  if (readmeVersion !== packageVersion) {
    errors.push(`README current version (${readmeVersion || "missing"}) does not match ${packageVersion}`);
  }
  for (const version of readme.match(/(?<![\d.])\d+\.\d+\.\d+(?![\d.])/g) ?? []) {
    if (version !== packageVersion) errors.push(`README contains stale version ${version}`);
  }

  const releaseDoc = readFileSync(join(ROOT, "RELEASE.md"), "utf-8");
  for (const version of releaseDoc.match(/\bv\d+\.\d+\.\d+\b/g) ?? []) {
    if (version !== `v${packageVersion}`) errors.push(`RELEASE.md contains stale version ${version}`);
  }

  const tag = env.GITHUB_REF_TYPE === "tag" || env.GITHUB_REF_NAME?.startsWith("v")
    ? env.GITHUB_REF_NAME
    : undefined;
  if (tag && tag !== `v${packageVersion}`) {
    errors.push(`release tag ${tag} does not match package version v${packageVersion}`);
  }

  return errors;
}

if (import.meta.main) {
  const errors = await getReleaseConsistencyErrors();
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exit(1);
  }
  console.log("Release version metadata is consistent.");
}
