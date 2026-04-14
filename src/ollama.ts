import { VALID_MOODS, type ReflectionResult } from "./types.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_REFLECT_MODEL = "gemma4:e4b";
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REFLECTION_LENGTH = 300;
const MAX_SUMMARY_LENGTH = 100;
const MAX_MOOD_LENGTH = 32;

interface OllamaGenerateResponse {
  response?: string;
}

interface OllamaEmbeddingResponse {
  embedding?: number[];
  embeddings?: number[][];
}

interface ReflectInput {
  content: string;
  recentWindow: string[];
  selfSummary: string;
  totalEntries: number;
}

export class OllamaClient {
  readonly baseUrl: string;
  readonly reflectModel: string;
  readonly embeddingModel: string;
  readonly timeoutMs: number;

  constructor(options: {
    baseUrl?: string;
    reflectModel?: string;
    embeddingModel?: string;
    timeoutMs?: number;
  } = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
    this.reflectModel = options.reflectModel ?? DEFAULT_REFLECT_MODEL;
    this.embeddingModel = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async reflect(input: ReflectInput): Promise<ReflectionResult> {
    const prompt = [
      "당신은 개인 기억을 형성하는 회고 엔진이다.",
      "출력은 JSON 객체 하나만 반환한다.",
      `허용 mood: ${VALID_MOODS.join(", ")}`,
      '형식: {"mood":"...","reflection":"...","memorySummary":"..."}',
      "reflection은 300자 이하, memorySummary는 100자 이하로 유지한다.",
      "현재 입력:",
      input.content,
      "최근 기억:",
      input.recentWindow.length > 0 ? input.recentWindow.join(" | ") : "없음",
      "자아 요약:",
      input.selfSummary,
      `총 기록 수: ${input.totalEntries}`,
    ].join("\n\n");

    try {
      const response = await this.request<OllamaGenerateResponse>({
        path: "/api/generate",
        payload: {
          model: this.reflectModel,
          prompt,
          stream: false,
          format: "json",
        },
      });

      return normalizeReflection(parseJsonObject(response.response ?? ""), input.content);
    } catch {
      return fallbackReflection(input.content);
    }
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.request<OllamaEmbeddingResponse>({
      path: "/api/embeddings",
      payload: {
        model: this.embeddingModel,
        prompt: text,
      },
    });

    if (Array.isArray(response.embedding)) {
      return response.embedding;
    }

    if (Array.isArray(response.embeddings?.[0])) {
      return response.embeddings[0];
    }

    throw new Error("Ollama embedding response is invalid.");
  }

  private async request<T>(input: { path: string; payload: Record<string, unknown> }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${input.path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input.payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Ollama request failed (${response.status}): ${detail || "no detail"}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function normalizeReflection(payload: Record<string, unknown> | null, content: string): ReflectionResult {
  const mood = typeof payload?.mood === "string" ? payload.mood.slice(0, MAX_MOOD_LENGTH) : "neutral";
  const normalizedMood = VALID_MOODS.includes(mood as (typeof VALID_MOODS)[number]) ? mood : "neutral";
  const reflectionSource = typeof payload?.reflection === "string" ? payload.reflection : content;
  const summarySource = typeof payload?.memorySummary === "string" ? payload.memorySummary : content;

  return {
    mood: normalizedMood,
    reflection: truncate(reflectionSource, MAX_REFLECTION_LENGTH),
    memorySummary: truncate(summarySource, MAX_SUMMARY_LENGTH),
  };
}

export function fallbackReflection(content: string): ReflectionResult {
  const summary = truncate(content, MAX_SUMMARY_LENGTH);

  return {
    mood: "neutral",
    reflection: truncate(`기록을 남겼습니다. ${content}`, MAX_REFLECTION_LENGTH),
    memorySummary: summary,
  };
}

function truncate(value: string, limit: number): string {
  return value.trim().slice(0, limit);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;

    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
