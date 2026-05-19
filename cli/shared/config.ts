import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface LlmConfig {
  model?: string;
  apiKey?: string;
  maxContextTokens?: number;
}

export interface ApiRateLimitConfig {
  requestsPerMinute?: number;
  exportMinIntervalSeconds?: number;
  maxRetries?: number;
}

export interface ApiConfig {
  rateLimit?: ApiRateLimitConfig;
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

function resolveConfigDir(): string {
  return process.env.WORKFLOWY_CONFIG_DIR || join(homedir(), ".workflowy");
}

function getConfigPath(): string {
  return join(resolveConfigDir(), "config.json");
}

export function getConfigDir(): string {
  return resolveConfigDir();
}

export function getDbDir(): string {
  const dbDir = join(resolveConfigDir(), "db");
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
  return dbDir;
}

export function getDbPath(): string {
  return join(getDbDir(), "wf.sqlite");
}

export function loadConfig(): WFConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { activeAccount: "default", accounts: {} };
  }
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as WFConfig;
}

export function saveConfig(config: WFConfig): void {
  const configDir = resolveConfigDir();
  const configPath = getConfigPath();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export function getActiveAccount(config: WFConfig): AccountConfig | null {
  return config.accounts[config.activeAccount] ?? null;
}

export function getToken(accountName?: string): string | null {
  const config = loadConfig();
  const name = accountName ?? config.activeAccount;
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
