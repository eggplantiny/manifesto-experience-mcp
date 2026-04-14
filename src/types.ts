import type { LineageInstance } from "@manifesto-ai/lineage";
import type { CanonicalSnapshot } from "@manifesto-ai/sdk";

import type {
  LLMProvider,
  OllamaProviderOptions,
  ProviderKind,
  RemoteApiProviderOptions,
} from "./providers/types.js";

export const VALID_MOODS = [
  "reflective",
  "calm",
  "wistful",
  "joyful",
  "melancholic",
  "grateful",
  "anxious",
  "hopeful",
  "neutral",
] as const;

export type Mood = (typeof VALID_MOODS)[number];
export type MemoryStatus = "idle" | "reflecting" | "reinforcing" | "recalling" | "refining" | "consolidating";

export interface MemoryConfig {
  [key: string]: any;
  windowSize: number;
  maxBudget: number;
  summaryMaxLen: number;
  reflectionMaxLen: number;
  decayFactor: number;
  crystallizeThreshold: number;
  reinforceSuccess: number;
  reinforceFailure: number;
}

export interface ReflectionResult {
  [key: string]: any;
  mood: string;
  reflection: string;
  memorySummary: string;
}

export interface EntryRecord {
  [key: string]: any;
  eventId: string;
  summary: string;
  mood: string;
}

export interface OutcomeRecord {
  [key: string]: any;
  eventId: string;
  actionWorldId: string;
  outcome: string;
  delta: number;
}

export interface ConsolidationRecord {
  [key: string]: any;
  eventId: string;
  decayFactor: number;
  crystallizeThreshold: number;
}

export interface RecallHit {
  [key: string]: any;
  worldId: string;
  summary: string;
  mood: string;
  score: number;
  strength: number;
}

export interface StrongPattern {
  [key: string]: any;
  worldId: string;
  pattern: string;
  strength: number;
}

export interface MemoryAgentState {
  [key: string]: any;
  config: MemoryConfig;
  currentDraft: string | null;
  lastReflection: ReflectionResult | null;
  status: MemoryStatus;
  recentWindow: string[];
  totalEntries: number;
  selfSummary: string;
  lastEntry: EntryRecord | null;
  lastOutcome: OutcomeRecord | null;
  lastConsolidation: ConsolidationRecord | null;
  recalled: RecallHit[] | null;
  recallBudget: number;
  recallHistory: string[];
  recallRefinement: string | null;
  strongPatterns: StrongPattern[];
}

export interface MemoryAgentComputed {
  [key: string]: any;
  hasMemory: boolean;
  hasRecallBudget: boolean;
  hasRecalledResults: boolean;
  recallExhausted: boolean;
  hasStrongPatterns: boolean;
}

export type MemoryWorldSnapshot = CanonicalSnapshot<MemoryAgentState>;

export interface MemoryAgentActions {
  [key: string]: (...args: any[]) => any;
  configure: (newConfig: MemoryConfig) => void;
  write: (content: string) => void;
  recordOutcome: (actionWorldId: string, outcome: string) => void;
  consolidate: () => void;
  recall: (query: string, budget: number) => void;
  refineRecall: () => void;
  endRecall: () => void;
}

export type MemoryAgentDomain = {
  actions: MemoryAgentActions;
  state: MemoryAgentState;
  computed: MemoryAgentComputed;
};

export interface MemoryAgentOptions {
  dataDir?: string;
  branchId?: string;
  recallTopK?: number;
  provider?: LLMProvider;
  providerKind?: ProviderKind;
  ollama?: OllamaProviderOptions;
  anthropic?: RemoteApiProviderOptions;
  openai?: RemoteApiProviderOptions;
  lineageFilename?: string;
  vectorFilename?: string;
}

export interface MemoryAnchorRecord {
  worldId: string;
  embedding: number[];
  summary: string;
  mood: string;
  timestamp: string;
  strength: number;
}

export interface MemorySearchHit extends MemoryAnchorRecord {
  score: number;
}

export interface WriteResult {
  worldId: string;
  entry: EntryRecord | null;
  snapshot: MemoryAgentState;
}

export interface OutcomeResult {
  worldId: string;
  entry: EntryRecord | null;
  outcome: OutcomeRecord | null;
  snapshot: MemoryAgentState;
}

export interface ConsolidationResult {
  consolidation: ConsolidationRecord | null;
  strongPatterns: StrongPattern[];
  snapshot: MemoryAgentState;
}

export interface RebuildResult {
  entryCount: number;
  outcomeCount: number;
  consolidationCount: number;
}

export interface MemoryAgent {
  readonly runtime: LineageInstance<MemoryAgentDomain>;
  configure(newConfig: MemoryConfig): Promise<void>;
  write(content: string): Promise<WriteResult>;
  recordOutcome(actionWorldId: string, outcome: string): Promise<OutcomeResult>;
  consolidate(): Promise<ConsolidationResult>;
  recall(query: string, budget: number): Promise<RecallHit[]>;
  refineRecall(): Promise<RecallHit[] | null>;
  endRecall(): Promise<void>;
  getAvailableActions(): string[];
  whyNotConfigure(newConfig: MemoryConfig): string | null;
  whyNotWrite(content: string): string | null;
  whyNotRecordOutcome(actionWorldId: string, outcome: string): string | null;
  whyNotConsolidate(): string | null;
  whyNotRecall(query: string, budget: number): string | null;
  whyNotRefineRecall(): string | null;
  whyNotEndRecall(): string | null;
  getSnapshot(): Promise<MemoryAgentState>;
  getHistory(limit?: number): Promise<MemoryAnchorRecord[]>;
  getWorldSnapshot(worldId: string): Promise<MemoryWorldSnapshot | null>;
  rebuildIndex(): Promise<RebuildResult>;
  dispose(): void;
}
