import { createMemoryRecallHandler } from "./effects/memory-recall.js";
import { createMindReflectHandler } from "./effects/mind-reflect.js";
import { createMindReflectOnOutcomeHandler } from "./effects/mind-reflect-on-outcome.js";
import { createMindRefineQueryHandler } from "./effects/mind-refine-query.js";
import { createPheromoneConsolidateHandler } from "./effects/pheromone-consolidate.js";
import { createPheromoneReinforceHandler } from "./effects/pheromone-reinforce.js";
import { commitAndAnchor } from "./indexer/anchor.js";
import { rebuildVectorIndex } from "./indexer/rebuild.js";
import { SQLiteLineageStore } from "./lineage/sqlite-lineage-store.js";
import { createMemoryAgent } from "./memory-agent.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createOllamaProvider } from "./providers/ollama.js";
import { createOpenAIProvider } from "./providers/openai.js";
import type {
  LLMMessage,
  LLMProvider,
  OllamaProviderOptions,
  ProviderKind,
  RemoteApiProviderOptions,
} from "./providers/types.js";
import { SQLiteVectorStore } from "./vector/sqlite-store.js";

export const createSqliteVectorStore = (filename: string) => new SQLiteVectorStore(filename);
export const createSqliteLineageStore = (filename: string) => new SQLiteLineageStore(filename);
export const ollamaProvider = (options: string | OllamaProviderOptions = {}) => {
  return typeof options === "string"
    ? createOllamaProvider({ model: options })
    : createOllamaProvider(options);
};
export const rebuildIndex = rebuildVectorIndex;

export {
  commitAndAnchor,
  createAnthropicProvider,
  createMemoryAgent,
  createMemoryRecallHandler,
  createMindReflectHandler,
  createMindReflectOnOutcomeHandler,
  createMindRefineQueryHandler,
  createOllamaProvider,
  createOpenAIProvider,
  createPheromoneConsolidateHandler,
  createPheromoneReinforceHandler,
  rebuildVectorIndex,
  SQLiteLineageStore,
  SQLiteVectorStore,
};

export {
  createMemoryRecallHandler as createRecallHandler,
  createMindReflectOnOutcomeHandler as createReflectOnOutcomeHandler,
  createMindRefineQueryHandler as createRefineQueryHandler,
  createPheromoneConsolidateHandler as createConsolidateHandler,
  createPheromoneReinforceHandler as createReinforceHandler,
};

export type {
  LLMMessage,
  LLMProvider,
  OllamaProviderOptions,
  ProviderKind,
  RemoteApiProviderOptions,
};

export type {
  ConsolidationRecord,
  ConsolidationResult,
  EntryRecord,
  MemoryAgent,
  MemoryAgentComputed,
  MemoryAgentDomain,
  MemoryAgentOptions,
  MemoryAgentState,
  MemoryConfig,
  MemoryWorldSnapshot,
  Mood,
  OutcomeRecord,
  OutcomeResult,
  RecallHit,
  ReflectionResult,
  RebuildResult,
  StrongPattern,
  WriteResult,
} from "./types.js";

export { VALID_MOODS } from "./types.js";
