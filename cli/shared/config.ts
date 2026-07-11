import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { Buffer } from "node:buffer";
import { homedir } from "os";
import { join } from "path";

export interface LlmConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

export interface ApiRateLimitConfig {
  requestsPerMinute?: number;
  exportMinIntervalSeconds?: number;
  maxRetries?: number;
}

export interface ApiConfig {
  rateLimit?: ApiRateLimitConfig;
  timeoutSeconds?: number;
}

export interface McpConfig {
  instructionsNode?: string;
}

export interface AccountConfig {
  name: string;
  token: string;
}

export interface WFConfig {
  activeAccount: string;
  accounts: Record<string, AccountConfig>;
  api?: ApiConfig;
  mcp?: McpConfig;
  llm?: LlmConfig;
  aliases?: Record<string, string>;
  [key: string]: unknown;
}

let accountOverride: string | null = null;

function resolveConfigDir(): string {
  return process.env.WORKFLOWY_CONFIG_DIR || join(homedir(), ".workflowy");
}

function getConfigPath(): string {
  return join(resolveConfigDir(), "config.json");
}

function secureDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== "win32") {
    chmodSync(path, 0o700);
  }
}

function secureFile(path: string): void {
  if (process.platform !== "win32" && existsSync(path)) {
    chmodSync(path, 0o600);
  }
}

export function getConfigDir(): string {
  return resolveConfigDir();
}

export function getDbDir(): string {
  const dbDir = join(resolveConfigDir(), "db");
  secureDirectory(resolveConfigDir());
  secureDirectory(dbDir);
  return dbDir;
}

export function getDbPath(): string {
  return join(getDbDir(), "wf.sqlite");
}

export function getAccountStorageKey(accountName: string): string {
  return Buffer.from(accountName, "utf-8").toString("base64url") || "default";
}

export function getAccountCacheDbPath(accountName: string): string {
  const accountDbDir = join(getDbDir(), "accounts");
  secureDirectory(accountDbDir);
  return join(accountDbDir, `account-${getAccountStorageKey(accountName)}.sqlite`);
}

export function loadConfig(): WFConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { activeAccount: "default", accounts: {} };
  }
  secureDirectory(resolveConfigDir());
  secureFile(configPath);
  const raw = readFileSync(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config in ${configPath}: expected a JSON object.`);
  }
  const config = parsed as Partial<WFConfig>;
  return {
    ...config,
    activeAccount: typeof config.activeAccount === "string" ? config.activeAccount : "default",
    accounts: config.accounts && typeof config.accounts === "object" && !Array.isArray(config.accounts) ? config.accounts : {},
  } as WFConfig;
}

export function saveConfig(config: WFConfig): void {
  const configDir = resolveConfigDir();
  const configPath = getConfigPath();
  secureDirectory(configDir);

  const tempPath = join(configDir, `.config.json.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    secureFile(tempPath);
    if (process.platform === "win32" && existsSync(configPath)) {
      rmSync(configPath, { force: true });
    }
    renameSync(tempPath, configPath);
    secureFile(configPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function isSensitiveConfigKey(key: string): boolean {
  return key.split(".").some((part) => /^(?:token|api[-_]?key|password|secret)$/i.test(part));
}

export function redactConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfigValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    isSensitiveConfigKey(key) ? "[redacted]" : redactConfigValue(child),
  ]));
}

export function getActiveAccount(config: WFConfig): AccountConfig | null {
  return config.accounts[getActiveAccountName(config)] ?? null;
}

export function setAccountOverride(accountName: string | null): void {
  accountOverride = accountName;
  if (accountName) {
    process.env.WORKFLOWY_ACCOUNT = accountName;
  } else {
    delete process.env.WORKFLOWY_ACCOUNT;
  }
}

export function getActiveAccountName(config = loadConfig()): string {
  return accountOverride || process.env.WORKFLOWY_ACCOUNT || config.activeAccount || "default";
}

export function getToken(accountName?: string): string | null {
  const config = loadConfig();
  const name = accountName ?? getActiveAccountName(config);
  return config.accounts[name]?.token ?? null;
}

export function requireToken(accountName?: string): string {
  const token = getToken(accountName);
  if (!token) {
    console.error(
      "Not authenticated. Run `wf login` first."
    );
    process.exit(1);
  }
  return token;
}

// --- Config get/set helpers for dotted keys ---

export function getConfigValue(key: string): unknown {
  const config = loadConfig() as Record<string, unknown>;
  const parts = key.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function setConfigValue(key: string, value: string): void {
  const config = loadConfig() as Record<string, unknown>;
  const parts = key.split(".");

  let current: Record<string, unknown> = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  const lastKey = parts[parts.length - 1]!;
  const numVal = Number(value);
  if (!isNaN(numVal) && value.trim() !== "") {
    current[lastKey] = numVal;
  } else if (value === "true") {
    current[lastKey] = true;
  } else if (value === "false") {
    current[lastKey] = false;
  } else {
    current[lastKey] = value;
  }

  saveConfig(config as unknown as WFConfig);
}

export function getPendingProposalPath(): string {
  return join(resolveConfigDir(), "pending-proposal.json");
}
