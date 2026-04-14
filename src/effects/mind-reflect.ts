import type { TypedMEL } from "@manifesto-ai/sdk";
import type { PatchBuilder } from "@manifesto-ai/sdk/effects";

import type { LLMProvider } from "../providers/types.js";
import { VALID_MOODS, type MemoryAgentDomain, type ReflectionResult, type StrongPattern } from "../types.js";

type MindReflectParams = {
  content: string;
  recentWindow: string[];
  selfSummary: string;
  totalEntries: number;
  strongPatterns: StrongPattern[];
  summaryMaxLen: number;
  reflectionMaxLen: number;
};

export function createMindReflectHandler(
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
          "당신은 개인 기억을 형성하는 회고 엔진이다.",
          "출력은 JSON 객체 하나만 반환한다.",
          `허용 mood: ${VALID_MOODS.join(", ")}`,
          `reflection은 ${input.reflectionMaxLen}자 이하, memorySummary는 ${input.summaryMaxLen}자 이하로 유지한다.`,
          '형식: {"mood":"...","reflection":"...","memorySummary":"..."}',
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `현재 입력: ${input.content}`,
          `최근 기억: ${input.recentWindow.length > 0 ? input.recentWindow.join(" | ") : "없음"}`,
          `자아 요약: ${input.selfSummary}`,
          `강한 패턴: ${formatStrongPatterns(input.strongPatterns)}`,
          `총 기록 수: ${input.totalEntries}`,
        ].join("\n\n"),
      },
    ], { json: true });

    const parsed = parseJsonObject(response);
    const result = normalizeReflection(parsed, input);
    return [ops.set(MEL.state.lastReflection, result)] as const;
  };
}

function normalizeParams(params: unknown): MindReflectParams {
  const source = isRecord(params) ? params : {};

  return {
    content: typeof source.content === "string" ? source.content : "",
    recentWindow: Array.isArray(source.recentWindow)
      ? source.recentWindow.filter((value): value is string => typeof value === "string")
      : [],
    selfSummary: typeof source.selfSummary === "string" ? source.selfSummary : "",
    totalEntries: typeof source.totalEntries === "number" ? source.totalEntries : 0,
    strongPatterns: Array.isArray(source.strongPatterns)
      ? source.strongPatterns.filter(isStrongPattern)
      : [],
    summaryMaxLen: positiveNumberOr(source.summaryMaxLen, 100),
    reflectionMaxLen: positiveNumberOr(source.reflectionMaxLen, 300),
  };
}

function normalizeReflection(payload: Record<string, unknown> | null, input: MindReflectParams): ReflectionResult {
  const mood = typeof payload?.mood === "string" ? payload.mood.trim() : "neutral";
  const normalizedMood = VALID_MOODS.includes(mood as (typeof VALID_MOODS)[number]) ? mood : "neutral";
  const reflection = truncate(
    typeof payload?.reflection === "string" ? payload.reflection : `기록을 남겼습니다. ${input.content}`,
    input.reflectionMaxLen,
  );
  const memorySummary = truncate(
    typeof payload?.memorySummary === "string" ? payload.memorySummary : input.content,
    input.summaryMaxLen,
  );

  return {
    mood: normalizedMood,
    reflection,
    memorySummary,
  };
}

function formatStrongPatterns(patterns: StrongPattern[]): string {
  if (patterns.length === 0) {
    return "없음";
  }

  return patterns
    .map((pattern) => `${pattern.pattern} (strength=${pattern.strength.toFixed(2)})`)
    .join(" | ");
}

function isStrongPattern(value: unknown): value is StrongPattern {
  return isRecord(value)
    && typeof value.worldId === "string"
    && typeof value.pattern === "string"
    && typeof value.strength === "number";
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
