import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";

export async function createExperimentRun(options) {
  const startedAt = new Date().toISOString();
  const runId = createRunId(startedAt);
  const runDir = path.join(options.rootDir, runId);
  const paths = {
    runDir,
    events: path.join(runDir, "events.jsonl"),
    summary: path.join(runDir, "summary.json"),
    lensAction: path.join(runDir, "lens-action.json"),
    lensMemory: path.join(runDir, "lens-memory.json"),
    manifest: path.join(runDir, "manifest.json"),
  };

  await mkdir(runDir, { recursive: true });

  const events = [];
  let seq = 0;
  let queue = Promise.resolve();

  function log(input) {
    const event = {
      runId,
      seq: seq += 1,
      ts: new Date().toISOString(),
      phase: input.phase ?? "system",
      kind: input.kind ?? "unknown",
      status: input.status ?? "observed",
      ...(input.testCaseId ? { testCaseId: input.testCaseId } : {}),
      ...(input.actionName ? { actionName: input.actionName } : {}),
      ...(input.intentId ? { intentId: input.intentId } : {}),
      ...(input.worldId ? { worldId: input.worldId } : {}),
      ...(input.parentWorldId ? { parentWorldId: input.parentWorldId } : {}),
      ...(input.eventId ? { eventId: input.eventId } : {}),
      data: input.data ?? {},
    };

    events.push(event);
    queue = queue.then(() => appendFile(paths.events, `${JSON.stringify(event)}\n`));
    return event;
  }

  async function flush() {
    await queue;
  }

  log({
    phase: "run",
    kind: "run_started",
    status: "started",
    data: {
      scriptName: options.scriptName,
      provider: options.provider,
      packageName: options.packageName,
      packageVersion: options.packageVersion,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  });

  async function finalize(input) {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    const finalSnapshot = summarizeSnapshot(input.lastSnapshot);
    const serializedError = serializeError(input.error);

    log({
      phase: "run",
      kind: "run_finished",
      status: input.pass ? "passed" : "failed",
      data: {
        error: serializedError,
        finalSnapshot,
        artifactDir: runDir,
      },
    });

    await flush();

    const manifest = {
      runId,
      scriptName: options.scriptName,
      packageName: options.packageName,
      packageVersion: options.packageVersion,
      startedAt,
      finishedAt,
      durationMs,
      provider: normalizeProviderMetadata(options.provider),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      artifactPaths: paths,
    };

    const summary = buildSummary({
      runId,
      runDir,
      scriptName: options.scriptName,
      packageName: options.packageName,
      packageVersion: options.packageVersion,
      provider: options.provider,
      startedAt,
      finishedAt,
      durationMs,
      pass: input.pass,
      error: serializedError,
      finalSnapshot,
      events,
      paths,
    });

    const lensAction = buildActionLens(events);
    const lensMemory = buildMemoryLens(events);

    await Promise.all([
      writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`),
      writeFile(paths.summary, `${JSON.stringify(summary, null, 2)}\n`),
      writeFile(paths.lensAction, `${JSON.stringify(lensAction, null, 2)}\n`),
      writeFile(paths.lensMemory, `${JSON.stringify(lensMemory, null, 2)}\n`),
    ]);

    return { runId, runDir, paths, summary };
  }

  return {
    runId,
    runDir,
    paths,
    events,
    log,
    flush,
    finalize,
  };
}

export function createLoggedProvider(provider, experiment, metadata) {
  const providerInfo = normalizeProviderMetadata(metadata ?? { name: provider.name });

  return {
    name: provider.name,
    async chat(messages, options = {}) {
      const started = Date.now();
      const inputChars = messages.reduce((sum, message) => sum + message.content.length, 0);

      try {
        const response = await provider.chat(messages, options);
        experiment.log({
          phase: "llm",
          kind: "llm_call",
          status: "completed",
          data: {
            provider: providerInfo.name,
            model: providerInfo.model,
            operation: "chat",
            latencyMs: Date.now() - started,
            inputChars,
            outputChars: response.length,
            jsonMode: Boolean(options.json),
            ok: true,
          },
        });
        return response;
      } catch (error) {
        experiment.log({
          phase: "llm",
          kind: "llm_call",
          status: "failed",
          data: {
            provider: providerInfo.name,
            model: providerInfo.model,
            operation: "chat",
            latencyMs: Date.now() - started,
            inputChars,
            outputChars: 0,
            jsonMode: Boolean(options.json),
            ok: false,
            error: serializeError(error),
          },
        });
        throw error;
      }
    },
    async embed(text) {
      const started = Date.now();

      try {
        const embedding = await provider.embed(text);
        experiment.log({
          phase: "llm",
          kind: "llm_call",
          status: "completed",
          data: {
            provider: providerInfo.name,
            model: providerInfo.embeddingModel,
            operation: "embed",
            latencyMs: Date.now() - started,
            inputChars: text.length,
            outputChars: 0,
            embeddingDim: embedding.length,
            jsonMode: false,
            ok: true,
          },
        });
        return embedding;
      } catch (error) {
        experiment.log({
          phase: "llm",
          kind: "llm_call",
          status: "failed",
          data: {
            provider: providerInfo.name,
            model: providerInfo.embeddingModel,
            operation: "embed",
            latencyMs: Date.now() - started,
            inputChars: text.length,
            outputChars: 0,
            jsonMode: false,
            ok: false,
            error: serializeError(error),
          },
        });
        throw error;
      }
    },
  };
}

export function summarizeSnapshot(snapshot) {
  if (!snapshot) {
    return null;
  }

  return {
    status: snapshot.status,
    totalEntries: snapshot.totalEntries,
    recentWindowSize: Array.isArray(snapshot.recentWindow) ? snapshot.recentWindow.length : 0,
    recallBudget: snapshot.recallBudget,
    recalledCount: Array.isArray(snapshot.recalled) ? snapshot.recalled.length : 0,
    strongPatternCount: Array.isArray(snapshot.strongPatterns) ? snapshot.strongPatterns.length : 0,
    lastEntry: snapshot.lastEntry ?? null,
    lastOutcome: snapshot.lastOutcome ?? null,
    lastConsolidation: snapshot.lastConsolidation ?? null,
  };
}

export function summarizeStrengths(anchors) {
  const strengths = anchors.map((anchor) => anchor.strength);
  if (strengths.length === 0) {
    return { count: 0, min: null, max: null, avg: null };
  }

  const total = strengths.reduce((sum, value) => sum + value, 0);
  return {
    count: strengths.length,
    min: Math.min(...strengths),
    max: Math.max(...strengths),
    avg: total / strengths.length,
  };
}

function buildSummary(input) {
  const testCaseResults = input.events
    .filter((event) => event.kind === "test_case_finished")
    .map((event) => ({
      testCaseId: event.testCaseId,
      title: event.data.title,
      status: event.status,
      durationMs: event.data.durationMs ?? null,
      error: event.data.error ?? null,
    }));

  const actionsCommitted = input.events.filter((event) => event.kind === "action_committed");
  const llmCalls = input.events.filter((event) => event.kind === "llm_call");
  const anchorsInserted = input.events.filter((event) => event.kind === "anchor_inserted");
  const failedTestCases = testCaseResults.filter((testCase) => testCase.status !== "passed");

  return {
    runId: input.runId,
    pass: input.pass,
    scriptName: input.scriptName,
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    provider: normalizeProviderMetadata(input.provider),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    artifactDir: input.runDir,
    artifactPaths: input.paths,
    totals: {
      events: input.events.length,
      testCases: testCaseResults.length,
      passedTestCases: testCaseResults.length - failedTestCases.length,
      failedTestCases: failedTestCases.length,
      actionsCommitted: actionsCommitted.length,
      llmCalls: llmCalls.length,
      anchorsInserted: anchorsInserted.length,
    },
    failedTestCases,
    finalSnapshot: input.finalSnapshot,
    error: input.error,
  };
}

function buildActionLens(events) {
  const actions = new Map();
  const tests = new Map();
  const recalls = [];
  const consolidations = [];
  const rebuilds = [];

  for (const event of events) {
    if (event.kind === "test_case_started") {
      tests.set(event.testCaseId, {
        testCaseId: event.testCaseId,
        title: event.data.title,
        startedAt: event.ts,
        status: "started",
        durationMs: null,
      });
      continue;
    }

    if (event.kind === "test_case_finished") {
      const existing = tests.get(event.testCaseId) ?? {
        testCaseId: event.testCaseId,
        title: event.data.title,
      };
      existing.status = event.status;
      existing.finishedAt = event.ts;
      existing.durationMs = event.data.durationMs ?? null;
      tests.set(event.testCaseId, existing);
      continue;
    }

    if (event.kind === "action_committed") {
      const action = ensureAction(actions, event.actionName);
      const latencyMs = event.data.latencyMs ?? 0;
      action.commits += 1;
      action.totalLatencyMs += latencyMs;
      action.maxLatencyMs = Math.max(action.maxLatencyMs, latencyMs);
      action.testCases.add(event.testCaseId);
      continue;
    }

    if (event.kind === "anchor_inserted") {
      const action = ensureAction(actions, event.actionName);
      action.anchorInsertions += 1;
      continue;
    }

    if (event.kind === "recall_results") {
      recalls.push({
        testCaseId: event.testCaseId,
        actionName: event.actionName,
        resultsCount: event.data.resultsCount,
        topHitStrength: event.data.topHit?.strength ?? null,
        topHitWorldId: event.data.topHit?.worldId ?? null,
        allPositiveStrengths: event.data.allPositiveStrengths,
      });
      continue;
    }

    if (event.kind === "strong_patterns_updated") {
      consolidations.push({
        testCaseId: event.testCaseId,
        actionName: event.actionName,
        changedWorlds: event.data.changedWorlds,
        beforeStats: event.data.beforeStats,
        afterStats: event.data.afterStats,
        strongPatternCount: event.data.strongPatternCount,
      });
      continue;
    }

    if (event.kind === "rebuild_finished") {
      rebuilds.push({
        testCaseId: event.testCaseId,
        anchorCountBefore: event.data.anchorCountBefore,
        anchorCountAfter: event.data.anchorCountAfter,
        maxStrengthDiff: event.data.maxStrengthDiff,
        parity: event.data.parity,
      });
    }
  }

  return {
    tests: Array.from(tests.values()),
    actions: Array.from(actions.values()).map((action) => ({
      actionName: action.actionName,
      commits: action.commits,
      avgLatencyMs: action.commits > 0 ? action.totalLatencyMs / action.commits : 0,
      maxLatencyMs: action.maxLatencyMs,
      anchorInsertions: action.anchorInsertions,
      testCases: Array.from(action.testCases),
    })),
    recalls,
    consolidations,
    rebuilds,
  };
}

function buildMemoryLens(events) {
  const memories = new Map();
  let latestStrongPatterns = new Map();

  for (const event of events) {
    if (event.kind === "anchor_inserted") {
      const memory = ensureMemory(memories, event.worldId, event.data.summary, event.data.mood);
      memory.birth = {
        ts: event.ts,
        testCaseId: event.testCaseId,
        actionName: event.actionName,
        eventId: event.eventId ?? null,
        strength: event.data.strength,
      };
      memory.currentStrength = event.data.strength;
      continue;
    }

    if (event.kind === "strength_changed") {
      const memory = ensureMemory(memories, event.worldId, null, null);
      const change = {
        ts: event.ts,
        testCaseId: event.testCaseId,
        before: event.data.before,
        delta: event.data.delta,
        after: event.data.after,
        reason: event.data.reason,
      };
      if (String(event.data.reason).startsWith("recordOutcome:")) {
        memory.reinforcements.push(change);
      } else if (event.data.reason === "consolidate") {
        memory.decays.push(change);
      }
      memory.currentStrength = event.data.after;
      continue;
    }

    if (event.kind === "recall_results") {
      const hits = Array.isArray(event.data.hits) ? event.data.hits : [];
      hits.forEach((hit, index) => {
        const memory = ensureMemory(memories, hit.worldId, hit.summary, hit.mood);
        memory.visibleInRecall += 1;
        memory.recallHits.push({
          ts: event.ts,
          testCaseId: event.testCaseId,
          rank: index + 1,
          score: hit.score,
          strength: hit.strength,
        });
      });
      continue;
    }

    if (event.kind === "strong_patterns_updated") {
      latestStrongPatterns = new Map();
      const patterns = Array.isArray(event.data.patterns) ? event.data.patterns : [];
      for (const pattern of patterns) {
        latestStrongPatterns.set(pattern.worldId, pattern);
      }
      continue;
    }

    if (event.kind === "rebuild_finished") {
      const diffs = Array.isArray(event.data.strengthDiffs) ? event.data.strengthDiffs : [];
      for (const diff of diffs) {
        const memory = ensureMemory(memories, diff.worldId, null, null);
        memory.rebuildParity = {
          diff: diff.diff,
          rebuiltStrength: diff.rebuiltStrength,
          originalStrength: diff.originalStrength,
        };
      }
    }
  }

  const items = Array.from(memories.values()).map((memory) => {
    const pattern = latestStrongPatterns.get(memory.worldId) ?? null;
    return {
      worldId: memory.worldId,
      summary: memory.summary,
      mood: memory.mood,
      birth: memory.birth,
      currentStrength: memory.currentStrength,
      reinforcements: memory.reinforcements,
      decays: memory.decays,
      visibleInRecall: memory.visibleInRecall,
      recallHits: memory.recallHits,
      isStrongPattern: Boolean(pattern),
      strongPattern: pattern,
      rebuildParity: memory.rebuildParity,
    };
  });

  items.sort((left, right) => (right.currentStrength ?? 0) - (left.currentStrength ?? 0));
  return { memories: items };
}

function ensureAction(actions, actionName) {
  const key = actionName ?? "unknown";
  if (!actions.has(key)) {
    actions.set(key, {
      actionName: key,
      commits: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
      anchorInsertions: 0,
      testCases: new Set(),
    });
  }
  return actions.get(key);
}

function ensureMemory(memories, worldId, summary, mood) {
  const key = worldId ?? "unknown";
  if (!memories.has(key)) {
    memories.set(key, {
      worldId: key,
      summary: summary ?? null,
      mood: mood ?? null,
      birth: null,
      currentStrength: null,
      reinforcements: [],
      decays: [],
      visibleInRecall: 0,
      recallHits: [],
      rebuildParity: null,
    });
  }

  const memory = memories.get(key);
  if (summary && !memory.summary) memory.summary = summary;
  if (mood && !memory.mood) memory.mood = mood;
  return memory;
}

function normalizeProviderMetadata(provider) {
  return {
    name: provider?.name ?? "unknown",
    model: provider?.model ?? null,
    embeddingModel: provider?.embeddingModel ?? process.env.OLLAMA_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    baseUrl: provider?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? null,
  };
}

function createRunId(startedAt) {
  const stamp = startedAt.replace(/[:.]/g, "-");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function serializeError(error) {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    };
  }

  return {
    name: "Error",
    message: String(error),
    stack: null,
  };
}
