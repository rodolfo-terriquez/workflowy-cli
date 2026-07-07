import { loadConfig, type LlmConfig } from "./config.ts";

const DEFAULT_OPENROUTER_MODEL = "google/gemini-flash-2.5";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export type LlmProvider = "openrouter" | "openai-compatible" | "anthropic";

export interface LlmJsonRequest {
  prompt: string;
  system?: string;
  modelOverride?: string;
  maxOutputTokens?: number;
}

interface LlmSettings {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxOutputTokens: number;
}

export function normalizeLlmProvider(llmConfig: LlmConfig = {}): LlmProvider {
  const provider = llmConfig.provider?.toLowerCase();

  if (provider === "anthropic" || provider === "claude") return "anthropic";
  if (provider === "openai-compatible" || provider === "openai" || provider === "compatible") {
    return "openai-compatible";
  }
  if (provider === "openrouter" || !provider) {
    return llmConfig.baseUrl ? "openai-compatible" : "openrouter";
  }

  throw new Error(
    `Unsupported LLM provider "${llmConfig.provider}". Use openrouter, openai-compatible, or anthropic.`
  );
}

export function getDefaultModelForProvider(provider: LlmProvider): string | undefined {
  return provider === "openrouter" ? DEFAULT_OPENROUTER_MODEL : undefined;
}

export function describeLlmConfig(llmConfig: LlmConfig = {}): { provider: string; model: string; baseUrl: string; error?: string } {
  let provider: LlmProvider;
  try {
    provider = normalizeLlmProvider(llmConfig);
  } catch (err) {
    return {
      provider: llmConfig.provider ?? "(not set)",
      model: llmConfig.model ?? "(not set)",
      baseUrl: llmConfig.baseUrl ?? "(not set)",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    provider,
    model: llmConfig.model ?? getDefaultModelForProvider(provider) ?? "(not set)",
    baseUrl: getBaseUrl(provider, llmConfig),
  };
}

export async function completeJson<T extends object>(request: LlmJsonRequest): Promise<T> {
  const settings = resolveLlmSettings(request);
  const content = settings.provider === "anthropic"
    ? await completeAnthropic(settings, request)
    : await completeOpenAiCompatible(settings, request);

  return parseJsonObject(content) as T;
}

function resolveLlmSettings(request: LlmJsonRequest): LlmSettings {
  const config = loadConfig();
  const llmConfig: LlmConfig = config.llm ?? {};
  const provider = normalizeLlmProvider(llmConfig);
  const apiKey = llmConfig.apiKey;

  if (!apiKey) {
    throw new Error("No LLM API key configured. Run: wf config:set llm.apiKey <key>");
  }

  const model = request.modelOverride ?? llmConfig.model ?? getDefaultModelForProvider(provider);
  if (!model) {
    throw new Error(`No LLM model configured for ${provider}. Run: wf config:set llm.model <model-id>`);
  }

  return {
    provider,
    model,
    apiKey,
    baseUrl: getBaseUrl(provider, llmConfig),
    maxOutputTokens: request.maxOutputTokens ?? llmConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

function getBaseUrl(provider: LlmProvider, llmConfig: LlmConfig): string {
  if (llmConfig.baseUrl) return llmConfig.baseUrl;
  if (provider === "anthropic") return DEFAULT_ANTHROPIC_BASE_URL;
  if (provider === "openai-compatible") return DEFAULT_OPENAI_BASE_URL;
  return DEFAULT_OPENROUTER_BASE_URL;
}

function buildUrl(baseUrl: string, endpoint: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith(endpoint) ? trimmed : `${trimmed}${endpoint}`;
}

async function completeOpenAiCompatible(settings: LlmSettings, request: LlmJsonRequest): Promise<string> {
  const response = await fetch(buildUrl(settings.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
      ...(settings.provider === "openrouter"
        ? {
          "HTTP-Referer": "https://github.com/rodolfo-terriquez/workflowy-cli",
          "X-Title": "WorkFlowy CLI",
        }
        : {}),
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        { role: "user", content: request.prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: settings.maxOutputTokens,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM API call failed (${response.status}): ${body}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = extractTextContent(data.choices?.[0]?.message?.content);
  if (!content) throw new Error("LLM returned empty response");
  return content;
}

async function completeAnthropic(settings: LlmSettings, request: LlmJsonRequest): Promise<string> {
  const response = await fetch(buildUrl(settings.baseUrl, "/messages"), {
    method: "POST",
    headers: {
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: settings.maxOutputTokens,
      temperature: 0.1,
      ...(request.system ? { system: request.system } : {}),
      messages: [{ role: "user", content: request.prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM API call failed (${response.status}): ${body}`);
  }

  const data = await response.json() as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const content = data.content
    ?.filter((item) => item.type === "text" || item.text)
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
  if (!content) throw new Error("LLM returned empty response");
  return content;
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const text = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const value = (part as { text?: unknown }).text;
        return typeof value === "string" ? value : "";
      }
      return "";
    })
    .join("\n")
    .trim();

  return text || null;
}

function parseJsonObject(content: string): object {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed) as object;
  } catch {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]) as object;

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as object;
    }

    throw new Error("LLM response was not valid JSON");
  }
}
