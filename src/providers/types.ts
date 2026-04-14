export type ProviderKind = "ollama" | "anthropic" | "openai";
export type LLMRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

export interface LLMProvider {
  readonly name: ProviderKind | string;
  chat(messages: LLMMessage[], options?: { json?: boolean }): Promise<string>;
  embed(text: string): Promise<number[]>;
}

export interface OllamaProviderOptions {
  baseUrl?: string;
  model?: string;
  embeddingModel?: string;
  timeoutMs?: number;
}

export interface RemoteApiProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}
