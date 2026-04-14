import type { TypedMEL } from "@manifesto-ai/sdk";
import type { PatchBuilder } from "@manifesto-ai/sdk/effects";

import type { MemoryAgentDomain } from "../types.js";
import type { VectorStore } from "../vector/store.js";

type ConsolidateParams = {
  decayFactor: number;
  crystallizeThreshold: number;
};

export function createPheromoneConsolidateHandler(
  ops: PatchBuilder,
  MEL: TypedMEL<MemoryAgentDomain>,
  vectorStore: VectorStore,
) {
  return async (params: unknown) => {
    const input = normalizeParams(params);
    await vectorStore.decayAll(input.decayFactor);
    const patterns = await vectorStore.listStrongPatterns(input.crystallizeThreshold);
    return [ops.set(MEL.state.strongPatterns, patterns)] as const;
  };
}

function normalizeParams(params: unknown): ConsolidateParams {
  const source = isRecord(params) ? params : {};
  return {
    decayFactor: typeof source.decayFactor === "number" && Number.isFinite(source.decayFactor)
      ? source.decayFactor
      : 0.9,
    crystallizeThreshold: typeof source.crystallizeThreshold === "number" && Number.isFinite(source.crystallizeThreshold)
      ? source.crystallizeThreshold
      : 7.0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
