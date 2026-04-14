import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { withLineage, type LineageInstance } from "@manifesto-ai/lineage";
import { createManifesto, type TypedIntent } from "@manifesto-ai/sdk";
import { defineEffects } from "@manifesto-ai/sdk/effects";

import { createMemoryRecallHandler } from "./effects/memory-recall.js";
import { createMindReflectHandler } from "./effects/mind-reflect.js";
import { createMindReflectOnOutcomeHandler } from "./effects/mind-reflect-on-outcome.js";
import { createMindRefineQueryHandler } from "./effects/mind-refine-query.js";
import { createPheromoneConsolidateHandler } from "./effects/pheromone-consolidate.js";
import { createPheromoneReinforceHandler } from "./effects/pheromone-reinforce.js";
import {
  commitAndAnchor,
  toConsolidationRecord,
  toEntryRecord,
  toOutcomeRecord,
} from "./indexer/anchor.js";
import { rebuildVectorIndex } from "./indexer/rebuild.js";
import { SQLiteLineageStore } from "./lineage/sqlite-lineage-store.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createOllamaProvider } from "./providers/ollama.js";
import { createOpenAIProvider } from "./providers/openai.js";
import type { LLMProvider, ProviderKind } from "./providers/types.js";
import type {
  ConsolidationResult,
  MemoryAgent,
  MemoryAgentDomain,
  MemoryAgentOptions,
  MemoryAgentState,
  MemoryConfig,
  MemoryWorldSnapshot,
  OutcomeResult,
  RecallHit,
  RebuildResult,
  StrongPattern,
  WriteResult,
} from "./types.js";
import { SQLiteVectorStore } from "./vector/sqlite-store.js";

const DEFAULT_DATA_DIR = ".manifesto-memory-agent";
const DEFAULT_LINEAGE_FILENAME = "lineage.db";
const DEFAULT_VECTOR_FILENAME = "vector.db";
const DEFAULT_RECALL_TOP_K = 5;
const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  windowSize: 10,
  maxBudget: 5,
  summaryMaxLen: 100,
  reflectionMaxLen: 300,
  decayFactor: 0.9,
  crystallizeThreshold: 7.0,
  reinforceSuccess: 3.0,
  reinforceFailure: -2.0,
};

export async function createMemoryAgent(options: MemoryAgentOptions = {}): Promise<MemoryAgent> {
  const resolved = resolveOptions(options);
  await mkdir(resolved.dataDir, { recursive: true });

  const lineageStore = new SQLiteLineageStore(resolved.lineagePath);
  const vectorStore = new SQLiteVectorStore(resolved.vectorPath);
  const provider = resolveProvider(options);
  const runtimeRef: { current: LineageInstance<MemoryAgentDomain> | null } = { current: null };

  const domainSource = await loadDomainSource();
  const effects = defineEffects<MemoryAgentDomain>((ops, MEL) => ({
    "mind.reflect": createMindReflectHandler(ops, MEL, provider),
    "mind.reflectOnOutcome": createMindReflectOnOutcomeHandler(ops, MEL, provider),
    "mind.refineQuery": createMindRefineQueryHandler(ops, MEL, provider),
    "memory.recall": createMemoryRecallHandler(ops, MEL, vectorStore, runtimeRef, provider, resolved.recallTopK),
    "pheromone.reinforce": createPheromoneReinforceHandler(ops, vectorStore),
    "pheromone.consolidate": createPheromoneConsolidateHandler(ops, MEL, vectorStore),
  }));

  const runtime = withLineage(createManifesto<MemoryAgentDomain>(domainSource, effects), {
    store: lineageStore,
    ...(resolved.branchId ? { branchId: resolved.branchId } : {}),
  }).activate();

  runtimeRef.current = runtime;
  await runtime.getLatestHead();
  await ensureSpecDefaultConfig(runtime);

  return new ManifestoMemoryAgent(runtime, lineageStore, vectorStore, provider);
}

class ManifestoMemoryAgent implements MemoryAgent {
  constructor(
    public readonly runtime: LineageInstance<MemoryAgentDomain>,
    private readonly lineageStore: SQLiteLineageStore,
    private readonly vectorStore: SQLiteVectorStore,
    private readonly provider: LLMProvider,
  ) {}

  async configure(newConfig: MemoryConfig): Promise<void> {
    assertValidConfig(newConfig);
    await this.commitOrThrow(this.runtime.createIntent(this.runtime.MEL.actions.configure, newConfig));
  }

  async write(content: string): Promise<WriteResult> {
    const previousEntryEventId = this.snapshotData().lastEntry?.eventId ?? null;
    const result = await commitAndAnchor(
      this.runtime,
      this.runtime.createIntent(this.runtime.MEL.actions.write, content),
      this.vectorStore,
      this.provider,
      previousEntryEventId,
    );

    return {
      worldId: result.worldId,
      entry: result.entry,
      snapshot: this.snapshotData(),
    };
  }

  async recordOutcome(actionWorldId: string, outcome: string): Promise<OutcomeResult> {
    await this.assertOutcomeTarget(actionWorldId);
    const previousEntryEventId = this.snapshotData().lastEntry?.eventId ?? null;
    const result = await commitAndAnchor(
      this.runtime,
      this.runtime.createIntent(this.runtime.MEL.actions.recordOutcome, actionWorldId, outcome),
      this.vectorStore,
      this.provider,
      previousEntryEventId,
    );

    const snapshot = this.snapshotData();
    return {
      worldId: result.worldId,
      entry: result.entry,
      outcome: snapshot.lastOutcome,
      snapshot,
    };
  }

  async consolidate(): Promise<ConsolidationResult> {
    await this.commitOrThrow(this.runtime.createIntent(this.runtime.MEL.actions.consolidate));
    const snapshot = this.snapshotData();
    return {
      consolidation: snapshot.lastConsolidation,
      strongPatterns: snapshot.strongPatterns,
      snapshot,
    };
  }

  async recall(query: string, budget: number): Promise<RecallHit[]> {
    await this.commitOrThrow(this.runtime.createIntent(this.runtime.MEL.actions.recall, query, budget));
    return this.snapshotData().recalled ?? [];
  }

  async refineRecall(): Promise<RecallHit[] | null> {
    await this.commitOrThrow(this.runtime.createIntent(this.runtime.MEL.actions.refineRecall));
    return this.snapshotData().recalled;
  }

  async endRecall(): Promise<void> {
    await this.commitOrThrow(this.runtime.createIntent(this.runtime.MEL.actions.endRecall));
  }

  getAvailableActions(): string[] {
    return this.runtime.getAvailableActions().map((action) => String(action));
  }

  whyNotConfigure(newConfig: MemoryConfig): string | null {
    return formatBlockers(this.runtime.whyNot(this.runtime.createIntent(this.runtime.MEL.actions.configure, newConfig)));
  }

  whyNotWrite(content: string): string | null {
    return formatBlockers(this.runtime.whyNot(this.runtime.createIntent(this.runtime.MEL.actions.write, content)));
  }

  whyNotRecordOutcome(actionWorldId: string, outcome: string): string | null {
    return formatBlockers(
      this.runtime.whyNot(this.runtime.createIntent(this.runtime.MEL.actions.recordOutcome, actionWorldId, outcome)),
    );
  }

  whyNotConsolidate(): string | null {
    return formatBlockers(this.runtime.whyNot(this.runtime.createIntent(this.runtime.MEL.actions.consolidate)));
  }

  whyNotRecall(query: string, budget: number): string | null {
    return formatBlockers(this.runtime.whyNot(this.runtime.createIntent(this.runtime.MEL.actions.recall, query, budget)));
  }

  whyNotRefineRecall(): string | null {
    return formatBlockers(this.runtime.whyNot(this.runtime.createIntent(this.runtime.MEL.actions.refineRecall)));
  }

  whyNotEndRecall(): string | null {
    return formatBlockers(this.runtime.whyNot(this.runtime.createIntent(this.runtime.MEL.actions.endRecall)));
  }

  async getSnapshot(): Promise<MemoryAgentState> {
    return this.snapshotData();
  }

  async getHistory(limit?: number) {
    const resolvedLimit = typeof limit === "number" && limit > 0 ? limit : await this.vectorStore.count();
    return this.vectorStore.list(resolvedLimit);
  }

  async getWorldSnapshot(worldId: string): Promise<MemoryWorldSnapshot | null> {
    const snapshot = await this.runtime.getWorldSnapshot(worldId);
    return snapshot as MemoryWorldSnapshot | null;
  }

  async rebuildIndex(): Promise<RebuildResult> {
    return rebuildVectorIndex(this.runtime, this.vectorStore, this.provider);
  }

  dispose(): void {
    this.runtime.dispose();
    this.vectorStore.close();
    this.lineageStore.close();
  }

  private async commitOrThrow(intent: TypedIntent<MemoryAgentDomain>) {
    const report = await this.runtime.commitAsyncWithReport(intent);
    if (report.kind !== "completed") {
      throw new Error(report.kind === "rejected" ? report.rejection.reason : report.error.message);
    }
    return report;
  }

  private async assertOutcomeTarget(actionWorldId: string): Promise<void> {
    if (!actionWorldId.trim()) {
      throw new Error("recordOutcome requires a non-empty actionWorldId.");
    }

    const snapshot = await this.runtime.getWorldSnapshot(actionWorldId);
    if (!snapshot) {
      throw new Error(`recordOutcome target world does not exist: ${actionWorldId}`);
    }

    const hasAnchor = await this.vectorStore.has(actionWorldId);
    if (!hasAnchor) {
      throw new Error(`recordOutcome target world is not an anchored memory: ${actionWorldId}`);
    }
  }

  private snapshotData(): MemoryAgentState {
    const snapshot = structuredClone(this.runtime.getSnapshot().data as MemoryAgentState);
    snapshot.lastEntry = toEntryRecord(snapshot.lastEntry);
    snapshot.lastOutcome = toOutcomeRecord(snapshot.lastOutcome);
    snapshot.lastConsolidation = toConsolidationRecord(snapshot.lastConsolidation);
    snapshot.strongPatterns = normalizeStrongPatterns(snapshot.strongPatterns);
    return snapshot;
  }
}

async function loadDomainSource(): Promise<string> {
  const domainUrl = new URL("../domain.mel", import.meta.url);
  return readFile(domainUrl, "utf8");
}

function resolveOptions(options: MemoryAgentOptions) {
  const dataDir = path.resolve(options.dataDir ?? DEFAULT_DATA_DIR);
  return {
    dataDir,
    branchId: options.branchId,
    recallTopK: options.recallTopK ?? DEFAULT_RECALL_TOP_K,
    lineagePath: path.join(dataDir, options.lineageFilename ?? DEFAULT_LINEAGE_FILENAME),
    vectorPath: path.join(dataDir, options.vectorFilename ?? DEFAULT_VECTOR_FILENAME),
  };
}

function resolveProvider(options: MemoryAgentOptions): LLMProvider {
  if (options.provider) {
    return options.provider;
  }

  const providerKind = normalizeProviderKind(options.providerKind ?? process.env.LLM_PROVIDER);
  switch (providerKind) {
    case "openai":
      return createOpenAIProvider(options.openai);
    case "anthropic":
      return createAnthropicProvider(options.anthropic);
    case "ollama":
    default:
      return createOllamaProvider(options.ollama);
  }
}

async function ensureSpecDefaultConfig(runtime: LineageInstance<MemoryAgentDomain>): Promise<void> {
  const lineage = await runtime.getLineage();
  if (lineage.worlds.size !== 1) {
    return;
  }

  const snapshot = runtime.getSnapshot().data as MemoryAgentState;
  if (matchesDefaultConfig(snapshot.config)) {
    return;
  }

  const report = await runtime.commitAsyncWithReport(
    runtime.createIntent(runtime.MEL.actions.configure, DEFAULT_MEMORY_CONFIG),
  );
  if (report.kind !== "completed") {
    throw new Error(report.kind === "rejected" ? report.rejection.reason : report.error.message);
  }
}

function matchesDefaultConfig(config: MemoryConfig): boolean {
  return config.windowSize === DEFAULT_MEMORY_CONFIG.windowSize
    && config.maxBudget === DEFAULT_MEMORY_CONFIG.maxBudget
    && config.summaryMaxLen === DEFAULT_MEMORY_CONFIG.summaryMaxLen
    && config.reflectionMaxLen === DEFAULT_MEMORY_CONFIG.reflectionMaxLen
    && config.decayFactor === DEFAULT_MEMORY_CONFIG.decayFactor
    && config.crystallizeThreshold === DEFAULT_MEMORY_CONFIG.crystallizeThreshold
    && config.reinforceSuccess === DEFAULT_MEMORY_CONFIG.reinforceSuccess
    && config.reinforceFailure === DEFAULT_MEMORY_CONFIG.reinforceFailure;
}

function normalizeProviderKind(value: string | undefined): ProviderKind {
  switch (value) {
    case "openai":
    case "anthropic":
    case "ollama":
      return value;
    default:
      return "ollama";
  }
}

function assertValidConfig(config: MemoryConfig): void {
  if (
    config.windowSize <= 0
    || config.windowSize > 50
    || config.maxBudget <= 0
    || config.maxBudget > 10
    || config.summaryMaxLen <= 0
    || config.summaryMaxLen > 500
    || config.reflectionMaxLen <= 0
    || config.reflectionMaxLen > 2000
    || config.decayFactor <= 0
    || config.decayFactor >= 1
    || config.crystallizeThreshold <= 0
    || config.reinforceSuccess <= 0
    || config.reinforceFailure >= 0
  ) {
    throw new Error("MemoryConfig violates the v0.5.2 invariants.");
  }
}

function normalizeStrongPatterns(value: unknown): StrongPattern[] {
  if (!Array.isArray(value)) return [];
  return value.filter((pattern): pattern is StrongPattern => {
    return pattern !== null
      && typeof pattern === "object"
      && typeof (pattern as StrongPattern).worldId === "string"
      && typeof (pattern as StrongPattern).pattern === "string"
      && typeof (pattern as StrongPattern).strength === "number";
  });
}

function formatBlockers(blockers: readonly { layer: string; expression: unknown }[] | null): string | null {
  if (!blockers || blockers.length === 0) return null;
  return blockers.map((blocker) => `${blocker.layer}: ${JSON.stringify(blocker.expression)}`).join("; ");
}
