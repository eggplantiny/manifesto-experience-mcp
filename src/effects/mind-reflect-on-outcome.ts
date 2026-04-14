import type { TypedMEL } from "@manifesto-ai/sdk";
import type { PatchBuilder } from "@manifesto-ai/sdk/effects";

import type { LLMProvider } from "../providers/types.js";
import { VALID_MOODS, type MemoryAgentDomain, type ReflectionResult } from "../types.js";

type MindReflectOnOutcomeParams = {
  actionWorldId: string;
  outcome: string;
  recentWindow: string[];
  selfSummary: string;
  summaryMaxLen: number;
  reflectionMaxLen: number;
};

export function createMindReflectOnOutcomeHandler(
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
          "당신은 결과 피드백을 회고하는 기억 엔진이다.",
          "출력은 JSON 객체 하나만 반환한다.",
          `허용 mood: ${VALID_MOODS.join(", ")}`,
          `reflection은 ${input.reflectionMaxLen}자 이하, memorySummary는 ${input.summaryMaxLen}자 이하로 유지한다.`,
          '형식: {"mood":"...","reflection":"...","memorySummary":"..."}',
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `대상 worldId: ${input.actionWorldId}`,
          `결과: ${input.outcome || "failure"}`,
          `최근 기억: ${input.recentWindow.length > 0 ? input.recentWindow.join(" | ") : "없음"}`,
          `자아 요약: ${input.selfSummary}`,
        ].join("\n\n"),
      },
    ], { json: true });

    const parsed = parseJsonObject(response);
    const result = normalizeReflection(parsed, input);
    return [ops.set(MEL.state.lastReflection, result)] as const;
  };
}

function normalizeParams(params: unknown): MindReflectOnOutcomeParams {
  const source = isRecord(params) ? params : {};

  return {
    actionWorldId: typeof source.actionWorldId === "string" ? source.actionWorldId : "",
    outcome: typeof source.outcome === "string" ? source.outcome : "",
    recentWindow: Array.isArray(source.recentWindow)
      ? source.recentWindow.filter((value): value is string => typeof value === "string")
      : [],
    selfSummary: typeof source.selfSummary === "string" ? source.selfSummary : "",
    summaryMaxLen: positiveNumberOr(source.summaryMaxLen, 100),
    reflectionMaxLen: positiveNumberOr(source.reflectionMaxLen, 300),
  };
}

function normalizeReflection(
  payload: Record<string, unknown> | null,
  input: MindReflectOnOutcomeParams,
): ReflectionResult {
  const mood = typeof payload?.mood === "string" ? payload.mood.trim() : "neutral";
  const normalizedMood = VALID_MOODS.includes(mood as (typeof VALID_MOODS)[number]) ? mood : "neutral";
  const fallbackSummary = input.outcome === "success"
    ? `결과가 좋았던 판단을 기억했습니다: ${input.actionWorldId}`
    : `결과가 좋지 않았던 판단을 다시 봤습니다: ${input.actionWorldId}`;

  return {
    mood: normalizedMood,
    reflection: truncate(
      typeof payload?.reflection === "string" ? payload.reflection : fallbackSummary,
      input.reflectionMaxLen,
    ),
    memorySummary: truncate(
      typeof payload?.memorySummary === "string" ? payload.memorySummary : fallbackSummary,
      input.summaryMaxLen,
    ),
  };
}

function truncate(value: string, maxLen: number): string {
  return value.trim().slice(0, maxLen);
}

function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;

    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
