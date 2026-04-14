#!/usr/bin/env node

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { createMemoryAgent } from "./memory-agent.js";

async function main() {
  const agent = await createMemoryAgent({
    dataDir: process.env.MEMORY_AGENT_DATA_DIR,
    providerKind: normalizeProviderKind(process.env.LLM_PROVIDER),
  });
  const rl = createInterface({ input, output });

  printHelp();

  try {
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line) continue;
      if (line === "exit" || line === "quit") break;
      if (line === "help") {
        printHelp();
        continue;
      }

      const [command, ...rest] = line.split(" ");
      const payload = rest.join(" ").trim();

      try {
        switch (command) {
          case "write": {
            const result = await agent.write(payload);
            output.write(`${result.entry ? `[${result.entry.mood}] ${result.entry.summary} (${result.entry.eventId})` : "기록 완료"}\n`);
            break;
          }
          case "outcome": {
            const [worldId, ...outcomeParts] = rest;
            const result = await agent.recordOutcome(worldId ?? "", outcomeParts.join(" ").trim());
            output.write(`${result.outcome ? `reinforced ${result.outcome.actionWorldId} by ${result.outcome.delta}` : "outcome recorded"}\n`);
            break;
          }
          case "consolidate": {
            const result = await agent.consolidate();
            output.write(`${formatPatterns(result.strongPatterns)}\n`);
            break;
          }
          case "recall": {
            const [budgetToken, ...queryParts] = rest;
            const budget = Number(budgetToken);
            const hits = await agent.recall(queryParts.join(" ").trim(), budget);
            output.write(`${formatHits(hits)}\n`);
            break;
          }
          case "refine": {
            const hits = await agent.refineRecall();
            output.write(`${formatHits(hits ?? [])}\n`);
            break;
          }
          case "end": {
            await agent.endRecall();
            output.write("recall ended\n");
            break;
          }
          case "configure": {
            const [
              windowSize,
              maxBudget,
              summaryMaxLen,
              reflectionMaxLen,
              decayFactor,
              crystallizeThreshold,
              reinforceSuccess,
              reinforceFailure,
            ] = rest.map(Number);
            await agent.configure({
              windowSize,
              maxBudget,
              summaryMaxLen,
              reflectionMaxLen,
              decayFactor,
              crystallizeThreshold,
              reinforceSuccess,
              reinforceFailure,
            });
            output.write("configured\n");
            break;
          }
          case "actions": {
            output.write(`${agent.getAvailableActions().join(", ")}\n`);
            break;
          }
          case "whynot": {
            output.write(`${await handleWhyNot(agent, rest)}\n`);
            break;
          }
          case "snapshot": {
            output.write(`${JSON.stringify(await agent.getSnapshot(), null, 2)}\n`);
            break;
          }
          case "history": {
            const entries = await agent.getHistory(20);
            output.write(`${entries.map((entry) => `[${entry.mood}] ${entry.summary} (${entry.worldId}, strength=${entry.strength.toFixed(2)})`).join("\n") || "기억이 없습니다."}\n`);
            break;
          }
          case "world": {
            output.write(`${JSON.stringify(await agent.getWorldSnapshot(payload), null, 2)}\n`);
            break;
          }
          case "rebuild": {
            const result = await agent.rebuildIndex();
            output.write(`reindexed entries=${result.entryCount} outcomes=${result.outcomeCount} consolidations=${result.consolidationCount}\n`);
            break;
          }
          default: {
            output.write("unknown command\n");
          }
        }
      } catch (error) {
        output.write(`${formatError(error)}\n`);
      }
    }
  } finally {
    rl.close();
    agent.dispose();
  }
}

async function handleWhyNot(agent: Awaited<ReturnType<typeof createMemoryAgent>>, args: string[]): Promise<string> {
  const [target, ...rest] = args;

  switch (target) {
    case "write":
      return agent.whyNotWrite(rest.join(" ").trim()) ?? "dispatchable";
    case "outcome": {
      const [worldId, ...outcomeParts] = rest;
      return agent.whyNotRecordOutcome(worldId ?? "", outcomeParts.join(" ").trim()) ?? "dispatchable";
    }
    case "consolidate":
      return agent.whyNotConsolidate() ?? "dispatchable";
    case "recall": {
      const [budgetToken, ...queryParts] = rest;
      return agent.whyNotRecall(queryParts.join(" ").trim(), Number(budgetToken)) ?? "dispatchable";
    }
    case "configure": {
      const [
        windowSize,
        maxBudget,
        summaryMaxLen,
        reflectionMaxLen,
        decayFactor,
        crystallizeThreshold,
        reinforceSuccess,
        reinforceFailure,
      ] = rest.map(Number);
      return agent.whyNotConfigure({
        windowSize,
        maxBudget,
        summaryMaxLen,
        reflectionMaxLen,
        decayFactor,
        crystallizeThreshold,
        reinforceSuccess,
        reinforceFailure,
      }) ?? "dispatchable";
    }
    case "refine":
      return agent.whyNotRefineRecall() ?? "dispatchable";
    case "end":
      return agent.whyNotEndRecall() ?? "dispatchable";
    default:
      return "usage: whynot write <text> | whynot outcome <worldId> <success|failure> | whynot consolidate | whynot recall <budget> <query> | whynot refine | whynot end | whynot configure <window> <budget> <summary> <reflection> <decay> <threshold> <successDelta> <failureDelta>";
  }
}

function formatHits(hits: Array<{ mood: string; summary: string; worldId: string; score: number; strength: number }>): string {
  if (hits.length === 0) {
    return "기억이 없습니다.";
  }

  return hits
    .map((hit) => `[${hit.mood}] ${hit.summary} (${hit.worldId}, score=${hit.score.toFixed(3)}, strength=${hit.strength.toFixed(2)})`)
    .join("\n");
}

function formatPatterns(patterns: Array<{ pattern: string; strength: number; worldId: string }>): string {
  if (patterns.length === 0) {
    return "strong pattern이 없습니다.";
  }

  return patterns
    .map((pattern) => `${pattern.pattern} (${pattern.worldId}, strength=${pattern.strength.toFixed(2)})`)
    .join("\n");
}

function printHelp() {
  output.write([
    "commands:",
    "  write <text>",
    "  outcome <worldId> <success|failure>",
    "  consolidate",
    "  recall <budget> <query>",
    "  refine",
    "  end",
    "  configure <windowSize> <maxBudget> <summaryMaxLen> <reflectionMaxLen> <decayFactor> <crystallizeThreshold> <reinforceSuccess> <reinforceFailure>",
    "  actions",
    "  whynot write <text>",
    "  whynot outcome <worldId> <success|failure>",
    "  whynot consolidate",
    "  whynot recall <budget> <query>",
    "  whynot refine",
    "  whynot end",
    "  snapshot",
    "  history",
    "  world <worldId>",
    "  rebuild",
    "  help",
    "  exit",
    "",
  ].join("\n"));
}

function normalizeProviderKind(value: string | undefined) {
  return value === "openai" || value === "anthropic" || value === "ollama" ? value : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  output.write(`${formatError(error)}\n`);
  process.exitCode = 1;
});
