import type { LineageInstance } from "@manifesto-ai/lineage";
import type { TypedMEL } from "@manifesto-ai/sdk";
import type { PatchBuilder } from "@manifesto-ai/sdk/effects";

import type { LLMProvider } from "../providers/types.js";
import type { MemoryAgentDomain, RecallHit } from "../types.js";
import type { VectorStore } from "../vector/store.js";

type MemoryRecallParams = {
  query: string;
  topK: number;
};

export function createMemoryRecallHandler(
  ops: PatchBuilder,
  MEL: TypedMEL<MemoryAgentDomain>,
  vectorStore: VectorStore,
  runtimeRef: { current: LineageInstance<MemoryAgentDomain> | null },
  provider: LLMProvider,
  defaultTopK: number,
) {
  return async (params: unknown) => {
    const input = normalizeParams(params, defaultTopK);
    if (!runtimeRef.current || !input.query) {
      return [ops.set(MEL.state.recalled, [])] as const;
    }

    try {
      const embedding = await provider.embed(input.query);
      const hits = await vectorStore.search(embedding, input.topK);
      const recalled = hits.map((hit) => ({
        worldId: hit.worldId,
        summary: hit.summary,
        mood: hit.mood,
        score: hit.score,
        strength: hit.strength,
      } satisfies RecallHit));

      return [ops.set(MEL.state.recalled, recalled)] as const;
    } catch {
      return [ops.set(MEL.state.recalled, [])] as const;
    }
  };
}

function normalizeParams(params: unknown, defaultTopK: number): MemoryRecallParams {
  const source = isRecord(params) ? params : {};

  return {
    query: typeof source.query === "string" ? source.query : "",
    topK: typeof source.topK === "number" && Number.isFinite(source.topK) && source.topK > 0
      ? source.topK
      : defaultTopK,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
