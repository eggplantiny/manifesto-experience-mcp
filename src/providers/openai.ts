import type { LLMMessage, LLMProvider, RemoteApiProviderOptions } from "./types.js";

const DEFAULT_OPENAI_URL = "https://api.openai.com/v1";
const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_TIMEOUT_MS = 30_000;

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface OpenAIEmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
}

export function createOpenAIProvider(options: RemoteApiProviderOptions = {}): LLMProvider {
  return new OpenAIProvider(options);
}

class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: RemoteApiProviderOptions) {
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_URL).replace(/\/$/, "");
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_CHAT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async chat(messages: LLMMessage[], options: { json?: boolean } = {}): Promise<string> {
    this.assertApiKey();
    const response = await this.request<OpenAIChatResponse>({
      path: "/chat/completions",
      payload: {
        model: this.model,
        messages,
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
      },
    });

    return response.choices?.[0]?.message?.content?.trim() ?? "";
  }

  async embed(text: string): Promise<number[]> {
    this.assertApiKey();
    const response = await this.request<OpenAIEmbeddingResponse>({
      path: "/embeddings",
      payload: {
        model: process.env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
        input: text,
      },
    });

    const embedding = response.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error("OpenAI embedding response is invalid.");
    }

    return embedding;
  }

  private async request<T>(input: { path: string; payload: Record<string, unknown> }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${input.path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(input.payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`OpenAI request failed (${response.status}): ${detail || "no detail"}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertApiKey(): void {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required for the OpenAI provider.");
    }
  }
}
