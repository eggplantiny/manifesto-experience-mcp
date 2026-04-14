import type { LineageInstance, World } from "@manifesto-ai/lineage";

import type { LLMProvider } from "../providers/types.js";
import type { MemoryAgentDomain, MemoryAgentState, RebuildResult } from "../types.js";
import type { VectorStore } from "../vector/store.js";
import { extractTimestamp, toConsolidationRecord, toEntryRecord, toOutcomeRecord } from "./anchor.js";

export async function rebuildVectorIndex(
  runtime: LineageInstance<MemoryAgentDomain>,
  vectorStore: VectorStore,
  provider: LLMProvider,
): Promise<RebuildResult> {
  await vectorStore.clear();

  const lineage = await runtime.getLineage();
  const worlds = orderWorlds(lineage.worlds);
  const snapshots = new Map<string, unknown>();
  const seenEntry = new Set<string>();
  const seenOutcome = new Set<string>();
  const seenConsolidation = new Set<string>();

  let entryCount = 0;
  let outcomeCount = 0;
  let consolidationCount = 0;

  for (const world of worlds) {
    const snapshot = await runtime.getWorldSnapshot(world.worldId);
    snapshots.set(world.worldId, snapshot);

    const state = snapshot?.data as MemoryAgentState | undefined;
    const entry = toEntryRecord(state?.lastEntry);
    if (!entry || seenEntry.has(entry.eventId)) continue;

    seenEntry.add(entry.eventId);
    const embedding = await provider.embed(entry.summary);
    await vectorStore.insert({
      worldId: world.worldId,
      embedding,
      summary: entry.summary,
      mood: entry.mood,
      timestamp: extractTimestamp(snapshot),
      strength: 1.0,
    });
    entryCount += 1;
  }

  for (const world of worlds) {
    const snapshot = snapshots.get(world.worldId);
    const state = (snapshot as { data?: MemoryAgentState } | undefined)?.data;
    const outcome = toOutcomeRecord(state?.lastOutcome);
    if (!outcome || seenOutcome.has(outcome.eventId)) continue;

    seenOutcome.add(outcome.eventId);
    await vectorStore.updateStrength(outcome.actionWorldId, outcome.delta);
    outcomeCount += 1;
  }

  for (const world of worlds) {
    const snapshot = snapshots.get(world.worldId);
    const state = (snapshot as { data?: MemoryAgentState } | undefined)?.data;
    const consolidation = toConsolidationRecord(state?.lastConsolidation);
    if (!consolidation || seenConsolidation.has(consolidation.eventId)) continue;

    seenConsolidation.add(consolidation.eventId);
    await vectorStore.decayAll(consolidation.decayFactor);
    consolidationCount += 1;
  }

  return {
    entryCount,
    outcomeCount,
    consolidationCount,
  };
}

function orderWorlds(worldMap: ReadonlyMap<string, World>): World[] {
  const worlds = Array.from(worldMap.values());
  const children = new Map<string, World[]>();
  const roots: World[] = [];

  for (const world of worlds) {
    if (world.parentWorldId && worldMap.has(world.parentWorldId)) {
      const bucket = children.get(world.parentWorldId) ?? [];
      bucket.push(world);
      children.set(world.parentWorldId, bucket);
    } else {
      roots.push(world);
    }
  }

  const ordered: World[] = [];
  const visit = (world: World) => {
    ordered.push(world);
    const next = (children.get(world.worldId) ?? []).sort((left, right) => left.worldId.localeCompare(right.worldId));
    for (const child of next) {
      visit(child);
    }
  };

  for (const root of roots.sort((left, right) => left.worldId.localeCompare(right.worldId))) {
    visit(root);
  }

  return ordered;
}
