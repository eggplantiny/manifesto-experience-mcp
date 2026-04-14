#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withLineage } from "@manifesto-ai/lineage";
import { createManifesto } from "@manifesto-ai/sdk";
import { defineEffects } from "@manifesto-ai/sdk/effects";

import {
  commitAndAnchor,
  createConsolidateHandler,
  createRecallHandler,
  createRefineQueryHandler,
  createReflectOnOutcomeHandler,
  createReinforceHandler,
  createSqliteLineageStore,
  createSqliteVectorStore,
  createMindReflectHandler,
  ollamaProvider,
  rebuildIndex,
} from "../dist/index.js";
import {
  createExperimentRun,
  createLoggedProvider,
  summarizeSnapshot,
  summarizeStrengths,
} from "./lib/experiment-run.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dataDir = path.join(repoRoot, ".data");
const experimentsDir = path.join(dataDir, "experiments");
const lineagePath = path.join(dataDir, "test-lineage.db");
const vectorPath = path.join(dataDir, "test-vectors.db");
const mel = await readFile(path.join(repoRoot, "domain.mel"), "utf8");
const packageInfo = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

const providerConfig = {
  baseUrl: process.env.OLLAMA_BASE_URL,
  model: process.env.MEMORY_AGENT_TEST_MODEL ?? process.env.LLM_MODEL ?? "gemma4:e4b",
  embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL,
  timeoutMs: process.env.OLLAMA_TIMEOUT_MS ? Number(process.env.OLLAMA_TIMEOUT_MS) : undefined,
};
const providerMetadata = {
  name: "ollama",
  model: providerConfig.model,
  embeddingModel: providerConfig.embeddingModel ?? process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text",
  baseUrl: providerConfig.baseUrl ?? process.env.OLLAMA_BASE_URL ?? null,
};

const experiment = await createExperimentRun({
  rootDir: experimentsDir,
  scriptName: "scripts/test-pheromone-lifecycle.mjs",
  packageName: packageInfo.name,
  packageVersion: packageInfo.version,
  provider: providerMetadata,
});
const provider = createLoggedProvider(ollamaProvider(providerConfig), experiment, providerMetadata);

const SPEC_DEFAULT_CONFIG = {
  windowSize: 10,
  maxBudget: 5,
  summaryMaxLen: 100,
  reflectionMaxLen: 300,
  decayFactor: 0.9,
  crystallizeThreshold: 7,
  reinforceSuccess: 3,
  reinforceFailure: -2,
};

let agent;
let vectorStore;
let lineageStore;
let lastSeenEntryEventId = null;
let currentTestCaseId = null;
let btcWrite;
let ethWrite;
let solWrite;
let btcWorldId;
let ethWorldId;
let solWorldId;
let finalSnapshot = null;
let runError = null;

await resetDataFiles();
await activateRuntime();
await configureDefaults();

try {
  await runTestCase("T1", "기억 형성", async () => {
    console.log("═══ Test 1: 기억 형성 ═══");

    btcWrite = await write("BTC/USDT RSI 74에서 매도했다. 과매수 구간 판단.");
    const s1 = snap();

    assert.equal(s1.status, "idle");
    assert.equal(s1.totalEntries, 1);
    assert.ok(s1.lastEntry !== null);
    assert.ok(s1.lastEntry.eventId, "eventId가 있어야 함");
    assert.ok(s1.lastEntry.summary.length > 0);
    assert.ok(s1.lastEntry.summary.length <= 100, "summaryMaxLen 보증");
    assert.ok(s1.selfSummary.length <= 300, "reflectionMaxLen 보증");
    assert.equal(s1.recentWindow.length, 1);

    const anchors1 = await vectorStore.getAll();
    assert.equal(anchors1.length, 1);
    assert.equal(anchors1[0].strength, 1.0, "초기 strength = 1.0");

    logSnapshot("test_1_final");
    console.log("  ✓ write → sealed + anchor(1.0) + eventId");
  });

  await runTestCase("T2", "여러 기억 + anchor dedupe", async () => {
    console.log("\n═══ Test 2: 여러 기억 + anchor dedupe ═══");

    ethWrite = await write("ETH/USDT 이더리움 거래량 급증. 상승 추세 시작 판단.");
    solWrite = await write("SOL/USDT 솔라나 네트워크 장애 뉴스. 매도 결정.");
    await write("BTC/USDT 비트코인 반감기 이후 첫 월봉 양봉. 긍정적.");
    await write("ETH/USDT 이더리움 DeFi TVL 신고점. 장기 보유 결정.");

    const s2 = snap();
    assert.equal(s2.totalEntries, 5);
    assert.equal(s2.recentWindow.length, 5);

    const allAnchors = await vectorStore.getAll();
    assert.equal(allAnchors.length, 5, "5개 anchor — 중복 없음");
    for (const anchor of allAnchors) {
      assert.equal(anchor.strength, 1.0);
    }

    logSnapshot("test_2_final");
    console.log("  ✓ 5개 write → 5개 anchor, 모두 strength 1.0");
  });

  await runTestCase("T3", "recall (strength 동일 = similarity 순위)", async () => {
    console.log("\n═══ Test 3: recall (strength 동일 = similarity 순위) ═══");

    await commitIntent("recall", agent.createIntent(agent.MEL.actions.recall, "비트코인 과매수", 2), {
      input: { query: "비트코인 과매수", budget: 2 },
    });

    const s3 = snap();
    assert.ok(s3.recalled !== null);
    assert.ok(s3.recalled.length > 0);
    assert.equal(s3.recallBudget, 1, "budget 1 소모");
    assert.ok(
      s3.recalled.some((hit) => hit.summary.includes("BTC") || hit.summary.includes("과매수") || hit.summary.includes("RSI")),
      "BTC 관련 hit가 하나 이상 있어야 함",
    );

    console.log("  recalled:");
    for (const hit of s3.recalled) {
      console.log(`    [${hit.mood}] ${hit.summary} (score: ${hit.score}, strength: ${hit.strength})`);
      assert.ok(hit.worldId, "worldId 있어야 함");
      assert.equal(hit.strength, 1.0, "아직 reinforce 전이므로 1.0");
    }

    logSnapshot("test_3_final");
    console.log("  ✓ recall → RecallHit[] with worldId + strength");
  });

  await runTestCase("T4", "refineRecall + budget 소진", async () => {
    console.log("\n═══ Test 4: refineRecall + budget 소진 ═══");

    assert.ok(actions().includes("refineRecall"), "budget 남아서 refineRecall 가능");
    await commitIntent("refineRecall", agent.createIntent(agent.MEL.actions.refineRecall));

    const s4 = snap();
    assert.equal(s4.recallBudget, 0, "budget 소진");
    assert.ok(!actions().includes("refineRecall"), "refineRecall 사라짐");
    assert.ok(actions().includes("endRecall"), "endRecall은 있음");
    console.log("  ✓ budget 0 → refineRecall unavailable");

    await commitIntent("endRecall", agent.createIntent(agent.MEL.actions.endRecall));
    assert.equal(snap().recalled, null);

    logSnapshot("test_4_final");
    console.log("  ✓ endRecall → recalled = null");
  });

  await runTestCase("T5", "recordOutcome → 페로몬 강화", async () => {
    console.log("\n═══ Test 5: recordOutcome → 페로몬 강화 ═══");

    const btcAnchor = await vectorStore.get(btcWrite.worldId);
    assert.ok(btcAnchor, "BTC anchor가 있어야 함");
    btcWorldId = btcAnchor.worldId;
    const beforeStrength = btcAnchor.strength;

    await recordOutcome(btcWorldId, "success");

    const s5 = snap();
    assert.equal(s5.status, "idle", "reflecting → reinforcing → idle 완료");
    assert.ok(s5.lastOutcome !== null);
    assert.equal(s5.lastOutcome.actionWorldId, btcWorldId);
    assert.equal(s5.lastOutcome.outcome, "success");
    assert.equal(s5.lastOutcome.delta, 3.0, "config.reinforceSuccess = 3.0");
    assert.ok(s5.lastOutcome.eventId, "outcome eventId 있어야 함");

    const afterAnchor = await vectorStore.get(btcWorldId);
    assert.ok(afterAnchor);
    assert.equal(afterAnchor.strength, beforeStrength + 3.0, "strength += 3.0");

    logSnapshot("test_5_final");
    console.log(`  ✓ strength: ${beforeStrength} → ${afterAnchor.strength}`);
  });

  await runTestCase("T6", "recordOutcome → 페로몬 약화", async () => {
    console.log("\n═══ Test 6: recordOutcome → 페로몬 약화 ═══");

    const solAnchor = await vectorStore.get(solWrite.worldId);
    assert.ok(solAnchor);
    solWorldId = solAnchor.worldId;

    await recordOutcome(solWorldId, "failure");

    const solAfter = await vectorStore.get(solWorldId);
    assert.ok(solAfter);
    assert.equal(solAfter.strength, -1.0, "strength += -2.0 = -1.0");

    logSnapshot("test_6_final");
    console.log(`  ✓ SOL strength: 1.0 → ${solAfter.strength} (약화)`);
  });

  await runTestCase("T7", "반복 강화 → strength 누적", async () => {
    console.log("\n═══ Test 7: 반복 강화 → strength 누적 ═══");

    for (let index = 0; index < 3; index += 1) {
      await recordOutcome(btcWorldId, "success");
    }

    const btcAfterRepeat = await vectorStore.get(btcWorldId);
    assert.ok(btcAfterRepeat);
    assert.equal(btcAfterRepeat.strength, 13.0, "1.0 + 4×3.0 = 13.0");

    logSnapshot("test_7_final");
    console.log("  ✓ BTC strength: 13.0 (4회 성공 누적)");
  });

  await runTestCase("T8", "recall — strength가 순위를 바꾸는가", async () => {
    console.log("\n═══ Test 8: recall — strength가 순위를 바꾸는가 ═══");

    await commitIntent("recall", agent.createIntent(agent.MEL.actions.recall, "암호화폐 시장 분석", 1), {
      input: { query: "암호화폐 시장 분석", budget: 1 },
    });

    const s8 = snap();
    assert.ok(s8.recalled.length > 0);

    const topHit = s8.recalled[0];
    console.log(`  1위: [${topHit.mood}] ${topHit.summary} (score: ${topHit.score}, strength: ${topHit.strength})`);
    assert.ok(topHit.strength > 10, "최상위가 강화된 기억이어야 함");

    const solInResults = s8.recalled.find((hit) => hit.strength < 0);
    assert.equal(solInResults, undefined, "약화된 기억은 검색에서 제외");
    console.log("  ✓ strength가 recall 순위를 결정한다");

    await commitIntent("endRecall", agent.createIntent(agent.MEL.actions.endRecall));
    logSnapshot("test_8_final");
  });

  await runTestCase("T9", "consolidate → decay + crystallize", async () => {
    console.log("\n═══ Test 9: consolidate → decay + crystallize ═══");

    const beforeConsolidate = await vectorStore.getAll();
    console.log("  Before decay:");
    for (const anchor of beforeConsolidate) {
      console.log(`    ${anchor.summary.slice(0, 30)}... strength: ${anchor.strength}`);
    }

    await consolidate();

    const s9 = snap();
    assert.equal(s9.status, "idle");
    assert.ok(s9.lastConsolidation !== null);
    assert.ok(s9.lastConsolidation.eventId, "consolidation eventId 있어야 함");
    assert.equal(s9.lastConsolidation.decayFactor, 0.9);

    const afterConsolidate = await vectorStore.getAll();
    console.log("  After decay (×0.9):");
    for (const anchor of afterConsolidate) {
      console.log(`    ${anchor.summary.slice(0, 30)}... strength: ${anchor.strength}`);
    }

    const btcDecayed = afterConsolidate.find((anchor) => anchor.worldId === btcWorldId);
    assert.ok(btcDecayed);
    assert.ok(Math.abs(btcDecayed.strength - 11.7) < 0.1, "13.0 × 0.9 = 11.7");

    const ethDecayed = await vectorStore.get(ethWrite.worldId);
    assert.ok(ethDecayed);
    ethWorldId = ethDecayed.worldId;
    assert.ok(ethDecayed.strength < 1.0, "1.0 × 0.9 < 1.0");

    assert.ok(s9.strongPatterns.length > 0, "결정화된 패턴이 있어야 함");
    const btcPattern = s9.strongPatterns.find((pattern) => pattern.worldId === btcWorldId);
    assert.ok(btcPattern, "BTC 패턴이 결정화됨");
    assert.ok(btcPattern.strength > 7.0, "threshold 이상");

    console.log(`  ✓ strongPatterns: ${s9.strongPatterns.length}개`);
    for (const pattern of s9.strongPatterns) {
      console.log(`    [${pattern.worldId}] ${pattern.pattern} (strength: ${pattern.strength})`);
    }
    logSnapshot("test_9_final");
  });

  await runTestCase("T10", "반복 consolidate → 점진적 소멸", async () => {
    console.log("\n═══ Test 10: 반복 consolidate → 점진적 소멸 ═══");

    for (let index = 0; index < 10; index += 1) {
      await consolidate();
    }

    const afterMultiDecay = await vectorStore.getAll();
    const ethFinal = await vectorStore.get(ethWorldId ?? ethWrite.worldId);
    assert.ok(ethFinal);
    console.log(`  ETH strength after 11× decay: ${ethFinal.strength}`);
    assert.ok(ethFinal.strength < 0.5, "ETH는 거의 소멸");

    const btcFinal = afterMultiDecay.find((anchor) => anchor.worldId === btcWorldId);
    assert.ok(btcFinal);
    console.log(`  BTC strength after 11× decay: ${btcFinal.strength}`);
    assert.ok(btcFinal.strength > 3.0, "BTC는 아직 가설 수준");

    const s10 = snap();
    const btcStillStrong = s10.strongPatterns.find((pattern) => pattern.worldId === btcWorldId);
    if (!btcStillStrong) {
      console.log("  ✓ BTC가 strongPatterns에서 탈락 (decay로 threshold 이하)");
    } else {
      console.log(`  BTC 아직 strong: ${btcStillStrong.strength}`);
    }
    console.log("  ✓ 반복 decay → 약한 기억 소멸, 강한 기억도 점진적 약화");
    logSnapshot("test_10_final");
  });

  await runTestCase("T11", "get_world_snapshot → 과거 시점", async () => {
    console.log("\n═══ Test 11: get_world_snapshot → 과거 시점 ═══");

    const pastSnapshot = await agent.getWorldSnapshot(btcWorldId);
    assert.ok(pastSnapshot !== null);
    console.log(`  selfSummary at ${btcWorldId}: ${pastSnapshot.data.selfSummary}`);
    console.log(`  lastEntry: ${JSON.stringify(pastSnapshot.data.lastEntry)}`);
    console.log(`  totalEntries at that time: ${pastSnapshot.data.totalEntries}`);

    assert.ok(pastSnapshot.data.lastEntry.eventId, "과거 snapshot에도 eventId 보존");
    assert.equal(pastSnapshot.data.totalEntries, 1, "첫 번째 write였으므로");

    experiment.log({
      phase: "snapshot",
      kind: "snapshot_observed",
      status: "observed",
      testCaseId: currentTestCaseId,
      worldId: btcWorldId,
      data: {
        label: "past_world_snapshot",
        snapshot: summarizeSnapshot(pastSnapshot.data),
      },
    });

    console.log("  ✓ 과거 world의 완전한 상태 복원");
  });

  await runTestCase("T12", "재구축 — vector store 삭제 → rebuild", async () => {
    console.log("\n═══ Test 12: 재구축 — vector store 삭제 → rebuild ═══");

    const beforeRebuild = await vectorStore.getAll();
    await vectorStore.clear();
    const afterClear = await vectorStore.getAll();
    assert.equal(afterClear.length, 0, "삭제 확인");

    const { afterRebuild, strengthDiffs, maxStrengthDiff } = await rebuildAndLog(beforeRebuild);

    console.log("  Before vs After rebuild:");
    for (const diff of strengthDiffs) {
      console.log(`    ${diff.worldId}: original=${diff.originalStrength?.toFixed(2)} rebuilt=${diff.rebuiltStrength.toFixed(2)} diff=${diff.diff.toFixed(4)}`);
      assert.ok(diff.diff < 0.01, `strength 차이 < 0.01 (실제: ${diff.diff})`);
    }
    assert.equal(afterRebuild.length, beforeRebuild.length, "anchor 수 일치");
    assert.ok(maxStrengthDiff < 0.01, "재구축 strength parity 유지");

    console.log("  ✓ 재구축 = 원본. eventId 기반 중복 0.");
    logSnapshot("test_12_final");
  });

  await runTestCase("T13", "eventId dedupe — recall은 anchor 안 만듦", async () => {
    console.log("\n═══ Test 13: eventId dedupe — recall은 anchor 안 만듦 ═══");

    const anchorCountBefore = (await vectorStore.getAll()).length;
    await commitIntent("recall", agent.createIntent(agent.MEL.actions.recall, "아무거나", 1), {
      input: { query: "아무거나", budget: 1 },
    });
    await commitIntent("endRecall", agent.createIntent(agent.MEL.actions.endRecall));

    const anchorCountAfter = (await vectorStore.getAll()).length;
    assert.equal(anchorCountAfter, anchorCountBefore, "recall이 anchor를 만들면 안 됨");

    logSnapshot("test_13_final");
    console.log("  ✓ recall/endRecall → anchor 미생성");
  });

  await runTestCase("T14", "configure — invariant guard", async () => {
    console.log("\n═══ Test 14: configure — invariant guard ═══");

    const dangerous = [
      { desc: "windowSize = 0", config: { ...snap().config, windowSize: 0 } },
      { desc: "maxBudget = -1", config: { ...snap().config, maxBudget: -1 } },
      { desc: "summaryMaxLen = 100000", config: { ...snap().config, summaryMaxLen: 100000 } },
      { desc: "decayFactor = 1.5", config: { ...snap().config, decayFactor: 1.5 } },
      { desc: "crystallizeThreshold = -1", config: { ...snap().config, crystallizeThreshold: -1 } },
      { desc: "reinforceSuccess = -5", config: { ...snap().config, reinforceSuccess: -5 } },
      { desc: "reinforceFailure = 5", config: { ...snap().config, reinforceFailure: 5 } },
    ];

    for (const { desc, config } of dangerous) {
      const dispatchable = agent.isIntentDispatchable(agent.MEL.actions.configure, config);
      assert.equal(dispatchable, false, `${desc}는 거부되어야 함`);
      console.log(`  ✓ ${desc} → dispatchable = false`);
    }

    const safe = { ...snap().config, windowSize: 20, maxBudget: 3 };
    const safeDispatchable = agent.isIntentDispatchable(agent.MEL.actions.configure, safe);
    assert.equal(safeDispatchable, true, "안전한 설정은 통과");

    logSnapshot("test_14_final");
    console.log("  ✓ windowSize=20, maxBudget=3 → dispatchable = true");
  });

  await runTestCase("T15", "legality surface", async () => {
    console.log("\n═══ Test 15: legality surface ═══");

    const idleActions = actions();
    console.log(`  idle actions: ${idleActions.join(", ")}`);
    assert.ok(idleActions.includes("write"));
    assert.ok(idleActions.includes("recall"));
    assert.ok(idleActions.includes("consolidate"));
    assert.ok(idleActions.includes("configure"));

    const emptyWriteDispatchable = agent.isIntentDispatchable(agent.MEL.actions.write, "");
    assert.equal(emptyWriteDispatchable, false);
    console.log("  ✓ write(\"\") → dispatchable = false");

    const overBudget = agent.isIntentDispatchable(agent.MEL.actions.recall, "test", 999);
    assert.equal(overBudget, false);
    console.log("  ✓ recall(budget: 999) → dispatchable = false");

    logSnapshot("test_15_final");
    console.log("  ✓ legality surface 동작 확인");
  });

  await runTestCase("T16", "기억 연속", async () => {
    console.log("\n═══ Test 16: 기억 연속 ═══");

    const beforeKill = snap();
    const beforeEntries = beforeKill.totalEntries;
    const beforeSummary = beforeKill.selfSummary;
    console.log(`  Before kill: ${beforeEntries} entries, selfSummary: \"${beforeSummary.slice(0, 50)}...\"`);

    closeStores();
    await activateRuntime();
    const head = await agent.getLatestHead();
    assert.ok(head, "lineage에 head가 있어야 함");
    await agent.restore(head.worldId);

    const afterRestore = snap();
    assert.equal(afterRestore.totalEntries, beforeEntries, "entries 복원");
    assert.equal(afterRestore.selfSummary, beforeSummary, "selfSummary 복원");

    logSnapshot("test_16_final");
    console.log(`  After restore: ${afterRestore.totalEntries} entries ✓`);
    console.log("  ✓ 기억 연속 — kill → restart → restore 성공");
  });

  console.log("\n═══════════════════════════════════════");
  console.log("  전체 테스트 완료");
  console.log("═══════════════════════════════════════");
  console.log(`
  ✓ Test 1:  write → anchor(strength 1.0) + eventId
  ✓ Test 2:  5개 write → 5개 anchor, 중복 없음
  ✓ Test 3:  recall → RecallHit[] with worldId + strength
  ✓ Test 4:  refineRecall + budget 소진 → unavailable
  ✓ Test 5:  recordOutcome("success") → strength +3.0
  ✓ Test 6:  recordOutcome("failure") → strength -2.0
  ✓ Test 7:  반복 강화 → strength 누적 (13.0)
  ✓ Test 8:  recall 순위 = similarity × strength
  ✓ Test 9:  consolidate → decay(×0.9) + crystallize
  ✓ Test 10: 반복 decay → 약한 기억 소멸, 강한 기억 약화
  ✓ Test 11: get_world_snapshot → 과거 시점 복원
  ✓ Test 12: vector store 삭제 → rebuild → 원본과 동일
  ✓ Test 13: recall/endRecall → anchor 미생성 (eventId dedupe)
  ✓ Test 14: configure invariant guard (7개 위험값 거부)
  ✓ Test 15: legality surface (whyNot, isIntentDispatchable)
  ✓ Test 16: kill → restart → restore → 기억 연속
`);
} catch (error) {
  runError = error;
  console.error(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  finalSnapshot = agent ? snap() : finalSnapshot;
  closeStores();
  const artifacts = await experiment.finalize({
    pass: runError === null,
    error: runError,
    lastSnapshot: finalSnapshot,
  });
  console.log(`\nArtifacts: ${artifacts.runDir}`);
}

async function runTestCase(testCaseId, title, callback) {
  currentTestCaseId = testCaseId;
  const started = Date.now();
  experiment.log({
    phase: "test",
    kind: "test_case_started",
    status: "started",
    testCaseId,
    data: { title },
  });

  try {
    await callback();
    experiment.log({
      phase: "test",
      kind: "assertion_passed",
      status: "passed",
      testCaseId,
      data: { title, message: `${testCaseId} completed` },
    });
    experiment.log({
      phase: "test",
      kind: "test_case_finished",
      status: "passed",
      testCaseId,
      data: { title, durationMs: Date.now() - started },
    });
  } catch (error) {
    experiment.log({
      phase: "test",
      kind: "assertion_failed",
      status: "failed",
      testCaseId,
      data: {
        title,
        error: formatError(error),
      },
    });
    experiment.log({
      phase: "test",
      kind: "test_case_finished",
      status: "failed",
      testCaseId,
      data: {
        title,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  } finally {
    currentTestCaseId = null;
  }
}

async function activateRuntime() {
  vectorStore = createSqliteVectorStore(vectorPath);
  lineageStore = createSqliteLineageStore(lineagePath);

  const runtimeRef = { current: null };
  const effects = defineEffects((ops, MEL) => ({
    "mind.reflect": createMindReflectHandler(ops, MEL, provider),
    "mind.refineQuery": createRefineQueryHandler(ops, MEL, provider),
    "mind.reflectOnOutcome": createReflectOnOutcomeHandler(ops, MEL, provider),
    "memory.recall": createRecallHandler(ops, MEL, vectorStore, runtimeRef, provider, 5),
    "pheromone.reinforce": createReinforceHandler(ops, vectorStore),
    "pheromone.consolidate": createConsolidateHandler(ops, MEL, vectorStore),
  }));

  agent = withLineage(createManifesto(mel, effects), { store: lineageStore }).activate();
  runtimeRef.current = agent;
  await agent.getLatestHead();
  lastSeenEntryEventId = null;
}

async function configureDefaults() {
  await commitIntent("configure", agent.createIntent(agent.MEL.actions.configure, SPEC_DEFAULT_CONFIG), {
    input: SPEC_DEFAULT_CONFIG,
  });
}

async function write(content) {
  return commitAnchoredIntent("write", agent.createIntent(agent.MEL.actions.write, content), {
    input: { content, contentChars: content.length },
  });
}

async function recordOutcome(actionWorldId, outcome) {
  return commitAnchoredIntent(
    "recordOutcome",
    agent.createIntent(agent.MEL.actions.recordOutcome, actionWorldId, outcome),
    {
      input: { actionWorldId, outcome },
      targetWorldId: actionWorldId,
      strengthReason: `recordOutcome:${outcome}`,
    },
  );
}

async function consolidate() {
  const beforeAnchors = await vectorStore.getAll();
  const result = await commitIntent("consolidate", agent.createIntent(agent.MEL.actions.consolidate));
  const afterAnchors = await vectorStore.getAll();
  const beforeMap = new Map(beforeAnchors.map((anchor) => [anchor.worldId, anchor]));
  const changedWorlds = [];

  for (const anchor of afterAnchors) {
    const previous = beforeMap.get(anchor.worldId);
    if (!previous || previous.strength === anchor.strength) {
      continue;
    }
    changedWorlds.push(anchor.worldId);
    experiment.log({
      phase: "memory",
      kind: "strength_changed",
      status: "completed",
      testCaseId: currentTestCaseId,
      actionName: "consolidate",
      worldId: anchor.worldId,
      data: {
        before: previous.strength,
        delta: anchor.strength - previous.strength,
        after: anchor.strength,
        reason: "consolidate",
      },
    });
  }

  const snapshot = snap();
  experiment.log({
    phase: "memory",
    kind: "strong_patterns_updated",
    status: "observed",
    testCaseId: currentTestCaseId,
    actionName: "consolidate",
    eventId: snapshot.lastConsolidation?.eventId ?? null,
    data: {
      changedWorlds,
      beforeStats: summarizeStrengths(beforeAnchors),
      afterStats: summarizeStrengths(afterAnchors),
      strongPatternCount: snapshot.strongPatterns.length,
      patterns: snapshot.strongPatterns,
    },
  });

  return result;
}

async function rebuildAndLog(beforeAnchors) {
  const started = Date.now();
  experiment.log({
    phase: "rebuild",
    kind: "rebuild_started",
    status: "started",
    testCaseId: currentTestCaseId,
    data: {
      anchorCountBefore: beforeAnchors.length,
    },
  });

  await rebuildIndex(agent, vectorStore, provider);

  const afterRebuild = await vectorStore.getAll();
  const beforeMap = new Map(beforeAnchors.map((anchor) => [anchor.worldId, anchor.strength]));
  const strengthDiffs = afterRebuild.map((anchor) => {
    const originalStrength = beforeMap.get(anchor.worldId) ?? null;
    return {
      worldId: anchor.worldId,
      originalStrength,
      rebuiltStrength: anchor.strength,
      diff: Math.abs(anchor.strength - (originalStrength ?? 0)),
    };
  });
  const maxStrengthDiff = strengthDiffs.reduce((max, item) => Math.max(max, item.diff), 0);

  experiment.log({
    phase: "rebuild",
    kind: "rebuild_finished",
    status: "completed",
    testCaseId: currentTestCaseId,
    data: {
      latencyMs: Date.now() - started,
      anchorCountBefore: beforeAnchors.length,
      anchorCountAfter: afterRebuild.length,
      parity: beforeAnchors.length === afterRebuild.length,
      maxStrengthDiff,
      strengthDiffs,
    },
  });

  return { afterRebuild, strengthDiffs, maxStrengthDiff };
}

async function commitIntent(actionName, intent, options = {}) {
  const parentHead = await agent.getLatestHead();
  const started = Date.now();

  experiment.log({
    phase: "action",
    kind: "action_submitted",
    status: "started",
    testCaseId: currentTestCaseId,
    actionName,
    intentId: intent.intentId ?? null,
    parentWorldId: parentHead?.worldId ?? null,
    data: options.input ?? {},
  });

  const result = await agent.commitAsync(intent);
  const latestHead = await agent.getLatestHead();
  const snapshot = snap();

  experiment.log({
    phase: "action",
    kind: "action_committed",
    status: "completed",
    testCaseId: currentTestCaseId,
    actionName,
    intentId: intent.intentId ?? null,
    worldId: latestHead?.worldId ?? null,
    parentWorldId: parentHead?.worldId ?? null,
    eventId: selectEventId(snapshot, actionName),
    data: {
      latencyMs: Date.now() - started,
      input: options.input ?? {},
      snapshot: summarizeSnapshot(snapshot),
    },
  });

  if (actionName === "recall" || actionName === "refineRecall") {
    logRecallResults(actionName, intent.intentId ?? null, snapshot);
  }

  logSnapshot(`${actionName}:after`, {
    actionName,
    intentId: intent.intentId ?? null,
  });

  return result;
}

async function commitAnchoredIntent(actionName, intent, options = {}) {
  const parentHead = await agent.getLatestHead();
  const previousEntryEventId = lastSeenEntryEventId;
  const targetBefore = options.targetWorldId ? await vectorStore.get(options.targetWorldId) : null;
  const started = Date.now();

  experiment.log({
    phase: "action",
    kind: "action_submitted",
    status: "started",
    testCaseId: currentTestCaseId,
    actionName,
    intentId: intent.intentId ?? null,
    parentWorldId: parentHead?.worldId ?? null,
    data: options.input ?? {},
  });

  const result = await commitAndAnchor(agent, intent, vectorStore, provider, lastSeenEntryEventId);
  lastSeenEntryEventId = result.entry?.eventId ?? lastSeenEntryEventId;
  const latestHead = await agent.getLatestHead();
  const snapshot = snap();

  experiment.log({
    phase: "action",
    kind: "action_committed",
    status: "completed",
    testCaseId: currentTestCaseId,
    actionName,
    intentId: intent.intentId ?? null,
    worldId: latestHead?.worldId ?? result.worldId,
    parentWorldId: parentHead?.worldId ?? null,
    eventId: result.entry?.eventId ?? null,
    data: {
      latencyMs: Date.now() - started,
      input: options.input ?? {},
      snapshot: summarizeSnapshot(snapshot),
    },
  });

  if (result.entry?.eventId && result.entry.eventId !== previousEntryEventId) {
    const anchor = await vectorStore.get(result.worldId);
    if (anchor) {
      experiment.log({
        phase: "memory",
        kind: "anchor_inserted",
        status: "completed",
        testCaseId: currentTestCaseId,
        actionName,
        intentId: intent.intentId ?? null,
        worldId: result.worldId,
        parentWorldId: parentHead?.worldId ?? null,
        eventId: result.entry.eventId,
        data: {
          summary: anchor.summary,
          mood: anchor.mood,
          strength: anchor.strength,
          timestamp: anchor.timestamp,
        },
      });
    }
  }

  if (options.targetWorldId) {
    const targetAfter = await vectorStore.get(options.targetWorldId);
    if (targetBefore && targetAfter && targetBefore.strength !== targetAfter.strength) {
      experiment.log({
        phase: "memory",
        kind: "strength_changed",
        status: "completed",
        testCaseId: currentTestCaseId,
        actionName,
        intentId: intent.intentId ?? null,
        worldId: options.targetWorldId,
        parentWorldId: parentHead?.worldId ?? null,
        eventId: snapshot.lastOutcome?.eventId ?? null,
        data: {
          before: targetBefore.strength,
          delta: targetAfter.strength - targetBefore.strength,
          after: targetAfter.strength,
          reason: options.strengthReason ?? actionName,
        },
      });
    }
  }

  logSnapshot(`${actionName}:after`, {
    actionName,
    intentId: intent.intentId ?? null,
  });

  return result;
}

function logRecallResults(actionName, intentId, snapshot) {
  const hits = Array.isArray(snapshot.recalled) ? snapshot.recalled : [];
  const topHit = hits[0] ?? null;

  experiment.log({
    phase: "memory",
    kind: "recall_results",
    status: "observed",
    testCaseId: currentTestCaseId,
    actionName,
    intentId,
    worldId: topHit?.worldId ?? null,
    data: {
      resultsCount: hits.length,
      topHit,
      allPositiveStrengths: hits.every((hit) => hit.strength > 0),
      hits,
    },
  });
}

function logSnapshot(label, extra = {}) {
  const snapshot = snap();
  experiment.log({
    phase: "snapshot",
    kind: "snapshot_observed",
    status: "observed",
    testCaseId: currentTestCaseId,
    data: {
      label,
      ...extra,
      snapshot: summarizeSnapshot(snapshot),
    },
  });
}

function selectEventId(snapshot, actionName) {
  if (actionName === "configure") return null;
  if (actionName === "consolidate") return snapshot.lastConsolidation?.eventId ?? null;
  if (actionName === "recall" || actionName === "refineRecall" || actionName === "endRecall") return null;
  if (actionName === "recordOutcome") return snapshot.lastOutcome?.eventId ?? null;
  return snapshot.lastEntry?.eventId ?? null;
}

function snap() {
  return agent.getSnapshot().data;
}

function actions() {
  return agent.getAvailableActions();
}

function closeStores() {
  if (agent) {
    agent.dispose();
    agent = null;
  }
  if (vectorStore) {
    vectorStore.close();
    vectorStore = null;
  }
  if (lineageStore) {
    lineageStore.close();
    lineageStore = null;
  }
}

async function resetDataFiles() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(experimentsDir, { recursive: true });
  for (const target of [lineagePath, vectorPath]) {
    await rm(target, { force: true });
    await rm(`${target}-wal`, { force: true });
    await rm(`${target}-shm`, { force: true });
  }
}

function formatError(error) {
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
