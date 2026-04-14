import type { LLMMessage, LLMProvider, RemoteApiProviderOptions } from "./types.js";

const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com/v1";
const DEFAULT_MODEL = "claude-3-5-sonnet-latest";
const DEFAULT_TIMEOUT_MS = 30_000;

interface AnthropicMessageResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
}

export function createAnthropicProvider(options: RemoteApiProviderOptions = {}): LLMProvider {
  return new AnthropicProvider(options);
}

class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: RemoteApiProviderOptions) {
    this.baseUrl = (options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_URL).replace(/\/$/, "");
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async chat(messages: LLMMessage[], _options?: { json?: boolean }): Promise<string> {
    this.assertApiKey();
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const conversational = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      }));

    const response = await this.request<AnthropicMessageResponse>({
      path: "/messages",
      payload: {
        model: this.model,
        max_tokens: 1024,
        ...(system ? { system } : {}),
        messages: conversational,
      },
    });

    const text = response.content?.find((part) => part.type === "text")?.text;
    return text?.trim() ?? "";
  }

  async embed(_text: string): Promise<number[]> {
    throw new Error("Anthropic provider does not implement embeddings. Supply a custom provider or use Ollama/OpenAI.");
  }

  private async request<T>(input: { path: string; payload: Record<string, unknown> }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${input.path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(input.payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Anthropic request failed (${response.status}): ${detail || "no detail"}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertApiKey(): void {
    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required for the Anthropic provider.");
    }
  }
}
