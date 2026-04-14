import type { LLMMessage, LLMProvider, OllamaProviderOptions } from "./types.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_MODEL = "gemma3:4b-it-qat";
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text-v2-moe:latest";
const DEFAULT_TIMEOUT_MS = 30_000;

interface OllamaGenerateResponse {
  response?: string;
}

interface OllamaEmbeddingResponse {
  embedding?: number[];
  embeddings?: number[][];
}

export function createOllamaProvider(options: OllamaProviderOptions = {}): LLMProvider {
  return new OllamaProvider(options);
}

class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly embeddingModel: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = (options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
    this.model = options.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
    this.embeddingModel = options.embeddingModel ?? process.env.OLLAMA_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async chat(messages: LLMMessage[], options: { json?: boolean } = {}): Promise<string> {
    const prompt = messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n");
    const response = await this.request<OllamaGenerateResponse>({
      path: "/api/generate",
      payload: {
        model: this.model,
        prompt,
        stream: false,
        ...(options.json ? { format: "json" } : {}),
      },
    });

    return response.response?.trim() ?? "";
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
