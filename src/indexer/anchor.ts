import type { LineageInstance } from "@manifesto-ai/lineage";
import type { TypedIntent } from "@manifesto-ai/sdk";

import type { LLMProvider } from "../providers/types.js";
import type {
  ConsolidationRecord,
  EntryRecord,
  MemoryAgentDomain,
  MemoryAgentState,
  OutcomeRecord,
} from "../types.js";
import type { VectorStore } from "../vector/store.js";

export async function commitAndAnchor(
  runtime: LineageInstance<MemoryAgentDomain>,
  intent: TypedIntent<MemoryAgentDomain>,
  vectorStore: VectorStore,
  provider: LLMProvider,
  previousEntryEventId: string | null,
): Promise<{ worldId: string; entry: EntryRecord | null }> {
  const report = await runtime.commitAsyncWithReport(intent);
  if (report.kind !== "completed") {
    throw new Error(report.kind === "rejected" ? report.rejection.reason : report.error.message);
  }

  const snapshot = runtime.getSnapshot();
  const entry = toEntryRecord((snapshot.data as MemoryAgentState).lastEntry);
  let worldId = report.resultWorld;

  if (entry?.eventId && entry.eventId !== previousEntryEventId) {
    const head = await runtime.getLatestHead();
    if (head) {
      worldId = head.worldId;
      const worldSnapshot = await runtime.getWorldSnapshot(head.worldId);
      const embedding = await provider.embed(entry.summary);
      await vectorStore.insert({
        worldId: head.worldId,
        embedding,
        summary: entry.summary,
        mood: entry.mood,
        timestamp: extractTimestamp(worldSnapshot),
        strength: 1.0,
      });
    }
  }

  return { worldId, entry };
}

export function toEntryRecord(value: unknown): EntryRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.eventId !== "string" || !value.eventId) return null;
  if (typeof value.summary !== "string" || !value.summary) return null;
  if (typeof value.mood !== "string" || !value.mood) return null;
  return {
    eventId: value.eventId,
    summary: value.summary,
    mood: value.mood,
  };
}

export function toOutcomeRecord(value: unknown): OutcomeRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.eventId !== "string" || !value.eventId) return null;
  if (typeof value.actionWorldId !== "string" || !value.actionWorldId) return null;
  if (typeof value.outcome !== "string") return null;
  if (typeof value.delta !== "number" || !Number.isFinite(value.delta)) return null;
  return {
    eventId: value.eventId,
    actionWorldId: value.actionWorldId,
    outcome: value.outcome,
    delta: value.delta,
  };
}

export function toConsolidationRecord(value: unknown): ConsolidationRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.eventId !== "string" || !value.eventId) return null;
  if (typeof value.decayFactor !== "number" || !Number.isFinite(value.decayFactor)) return null;
  if (typeof value.crystallizeThreshold !== "number" || !Number.isFinite(value.crystallizeThreshold)) return null;
  return {
    eventId: value.eventId,
    decayFactor: value.decayFactor,
    crystallizeThreshold: value.crystallizeThreshold,
  };
}

export function extractTimestamp(snapshot: unknown): string {
  if (isRecord(snapshot)) {
    const system = isRecord(snapshot.system) ? snapshot.system : null;
    const sealedAt = system?.sealedAt;
    if (typeof sealedAt === "string" && sealedAt) {
      return sealedAt;
    }
    if (typeof sealedAt === "number" && Number.isFinite(sealedAt) && sealedAt > 0) {
      return new Date(sealedAt).toISOString();
    }

    const meta = isRecord(snapshot.meta) ? snapshot.meta : null;
    const timestamp = meta?.timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) {
      return new Date(timestamp).toISOString();
    }
  }

  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
