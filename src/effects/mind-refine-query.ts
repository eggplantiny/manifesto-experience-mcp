import type { TypedMEL } from "@manifesto-ai/sdk";
import type { PatchBuilder } from "@manifesto-ai/sdk/effects";

import type { LLMProvider } from "../providers/types.js";
import type { MemoryAgentDomain, RecallHit } from "../types.js";

type MindRefineQueryParams = {
  originalQueries: string[];
  previousResults: RecallHit[];
};

export function createMindRefineQueryHandler(
  ops: PatchBuilder,
  MEL: TypedMEL<MemoryAgentDomain>,
  provider: LLMProvider,
) {
  return async (params: unknown) => {
    const input = normalizeParams(params);
    const response = await provider.chat([
      {
        role: "system",
        content: [
          "당신은 기억 검색 질의를 정제하는 엔진이다.",
          "이전 질의들과 검색 결과를 보고 더 좋은 단일 query 문자열 하나만 반환한다.",
          "설명이나 따옴표 없이 query 텍스트만 출력한다.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `이전 질의: ${input.originalQueries.join(" | ")}`,
          `이전 결과: ${formatResults(input.previousResults)}`,
        ].join("\n\n"),
      },
    ]);

    const refined = normalizeRefinedQuery(response, input);
    return [ops.set(MEL.state.recallRefinement, refined)] as const;
  };
}

function normalizeParams(params: unknown): MindRefineQueryParams {
  const source = isRecord(params) ? params : {};

  return {
    originalQueries: Array.isArray(source.originalQueries)
      ? source.originalQueries.filter((value): value is string => typeof value === "string")
      : [],
    previousResults: Array.isArray(source.previousResults)
      ? source.previousResults.filter(isRecallHit)
      : [],
  };
}

function normalizeRefinedQuery(value: string, input: MindRefineQueryParams): string {
  const candidate = value.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (candidate) {
    return candidate.slice(0, 200);
  }

  return input.originalQueries[input.originalQueries.length - 1] ?? "";
}

function formatResults(results: RecallHit[]): string {
  if (results.length === 0) {
    return "없음";
  }

  return results
    .map((result) => `${result.summary} (${result.mood}, score=${result.score.toFixed(3)})`)
    .join(" | ");
}

function isRecallHit(value: unknown): value is RecallHit {
  return isRecord(value)
    && typeof value.worldId === "string"
    && typeof value.summary === "string"
    && typeof value.mood === "string"
    && typeof value.score === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
