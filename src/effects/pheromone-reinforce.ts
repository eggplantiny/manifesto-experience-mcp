import type { PatchBuilder } from "@manifesto-ai/sdk/effects";

import type { VectorStore } from "../vector/store.js";

type ReinforceParams = {
  worldId: string;
  delta: number;
};

export function createPheromoneReinforceHandler(ops: PatchBuilder, vectorStore: VectorStore) {
  void ops;

  return async (params: unknown) => {
    const input = normalizeParams(params);
    if (!input.worldId) {
      return [] as const;
    }

    await vectorStore.updateStrength(input.worldId, input.delta);
    return [] as const;
  };
}

function normalizeParams(params: unknown): ReinforceParams {
  const source = isRecord(params) ? params : {};
  return {
    worldId: typeof source.worldId === "string" ? source.worldId : "",
    delta: typeof source.delta === "number" && Number.isFinite(source.delta) ? source.delta : 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
