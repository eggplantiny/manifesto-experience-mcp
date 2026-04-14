# manifesto-memory-agent

> **기억의 무게가 시간에 따라 변하는 memory protocol.**
> 경험을 저장하고 검색하는 건 Hindsight도 한다.
> 경험이 **강화되고, 약해지고, 결정화되고, 소멸하는** 건 이것만 한다.

---

## 1. 이 프로젝트가 존재하는 이유

기억 저장/검색 MCP는 포화 상태다. Hindsight, SimpleMem, Mem0 — 모두 retain/recall/reflect를 한다. 이 영역에서 경쟁하는 건 무의미하다.

이 프로젝트가 해결하는 건 다른 문제다:

```
Hindsight: "비슷한 기억을 찾아준다"
이것:      "유용했던 기억이 더 강하게 떠오르고, 안 먹힌 기억은 흐려진다"
```

이 프로토콜은 **페로몬** 모델로 직관의 형성과 소멸을 구현한다:

```
경험 → 초기 strength 1.0
  → 성공 피드백 → 강화 (+3.0)
  → 실패 피드백 → 약화 (-2.0)
  → consolidate (수면) → 감쇠 (×0.9)
  → 충분히 강하면 → 결정화 (MEL 규칙이 됨)
  → 충분히 약하면 → 소멸 (검색에서 사라짐)
```

이 프로토콜이 제공하는 것:
- **기억 형성:** 경험을 회고하고 봉인하는 구조
- **페로몬 강화/약화:** 결과 피드백으로 기억의 무게를 바꾸는 구조
- **event-driven 감쇠:** consolidate(수면) 시 전체 무게가 줄어드는 구조
- **직관 결정화:** 충분히 강한 패턴이 MEL이 읽는 strongPatterns로 올라오는 구조
- **budget 기반 검색:** retry 횟수가 구조적으로 제한되는 recall protocol

이 프로토콜이 제공하지 않는 것:
- retry를 **언제** 호출할지 결정하는 것 (외부 client의 몫)
- 기존 도메인에 drop-in 통합 (action namespace, state composition은 별도 설계)
- 검색 품질 경쟁 (entity resolution, knowledge graph — Hindsight 영역)

---

## 2. 페로몬의 위치

```
┌──────────────────────────────────────────────────────────┐
│ 의식 (Snapshot)                             bounded       │
│                                                           │
│   recentWindow, selfSummary, config                       │
│   lastEntry: 봉인 증거 (anchor 재구축용, eventId 포함)     │
│   lastOutcome: 결과 증거 (reinforce 재구축용, eventId 포함) │
│   lastConsolidation: 감쇠 증거 (decay 재구축용, eventId)   │
│   strongPatterns: 결정화된 직관 (MEL이 읽는다)             │
│                                                           │
├──────────────────────────────────────────────────────────┤
│ 장기 기억 (Lineage)                         불변 DAG       │
│                                                           │
│   각 World = 그 시점의 sealed Snapshot                     │
│   각 증거의 eventId로 "이 world에서 새 사건이 발생했는가"    │
│   를 결정론적으로 판별 가능                                 │
│                                                           │
├──────────────────────────────────────────────────────────┤
│ 기억의 인덱스 + 무게 (Vector Store)         가변, derived   │
│                                                           │
│   { worldId, embedding, summary, mood, timestamp,          │
│     ★ strength: number }                                   │
│                                                           │
│   ranking = similarity × strength                          │
│   재구축: Lineage 순회 → eventId 기반 중복 제거 → 정확 복원  │
└──────────────────────────────────────────────────────────┘
```

---

## 3. 페로몬의 생명주기

```
         strength
    │
7+  │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  결정화 → strongPatterns → MEL이 읽음
    │           ╱╲
3-7 │         ╱    ╲             가설 — recall 순위 상승
    │       ╱        ╲
1-3 │     ╱    decay    ╲        느낌 — 약한 선호
    │   ╱                  ╲
0   │──────────────────────── time
    │  ↑       ↑         ↑
    │ write  reinforce  consolidate
    │ (1.0)  (+3/-2)    (×0.9 + 결정화)
```

감쇠는 **event-driven**이다. `consolidate()`라는 의식적 행위가 있을 때만 감쇠와 결정화가 일어난다. 이 행위 자체도 Lineage에 sealed되며, `lastConsolidation.eventId`로 재구축 시 정확히 몇 번 감쇠가 발생했는지 추적 가능하다.

---

## 4. Event Identity 설계

### 4.1 문제

Snapshot은 point-in-time 전체 상태다. `lastEntry`를 W10에서 기록하면, W11(recall), W12(recordOutcome), W13(recall)에서도 **같은 lastEntry가 그대로 남아있다.** 재구축 시 "lastEntry가 있으면 anchor 생성"으로 하면 4개 world 모두에서 anchor가 생긴다. 실제로는 W10에서만 태어났는데.

같은 문제가 `lastOutcome`, `lastConsolidation`에도 적용된다.

### 4.2 해법

각 증거에 `eventId`를 포함한다. **같은 eventId를 가진 world는 "같은 사건의 지속"이고, 새 eventId가 나타난 world에서만 "새 사건이 발생"한 것이다.** 재구축은 seen set으로 중복을 제거한다.

```
W10: write("BTC 매도")      → lastEntry.eventId = "e-10"   ← 새 사건
W11: recall("과매수")        → lastEntry.eventId = "e-10"   ← 지속 (skip)
W12: recordOutcome(W10, ok)  → lastOutcome.eventId = "e-12" ← 새 사건
W13: recall("BTC")           → lastOutcome.eventId = "e-12" ← 지속 (skip)
W14: consolidate()           → lastConsolidation.eventId = "e-14" ← 새 사건
W15: write("ETH 관찰")      → lastConsolidation.eventId = "e-14" ← 지속 (skip)
                               lastEntry.eventId = "e-15"   ← 새 사건
```

### 4.3 eventId 생성

`$meta.intentId`를 쓴다. 이미 매 intent마다 unique하고, sealed snapshot에 포함되므로 별도 생성 로직이 불필요하다.

---

## 5. MEL 도메인

```mel
domain MemoryAgent {

  // ─── Types ───

  type MemoryConfig = {
    windowSize: number,
    maxBudget: number,
    summaryMaxLen: number,
    reflectionMaxLen: number,
    decayFactor: number,
    crystallizeThreshold: number,
    reinforceSuccess: number,
    reinforceFailure: number
  }

  type ReflectionResult = {
    mood: string,
    reflection: string,
    memorySummary: string
  }

  type EntryRecord = {
    eventId: string,
    summary: string,
    mood: string
  }

  type OutcomeRecord = {
    eventId: string,
    actionWorldId: string,
    outcome: string,
    delta: number
  }

  type ConsolidationRecord = {
    eventId: string,
    decayFactor: number,
    crystallizeThreshold: number
  }

  type RecallHit = {
    worldId: string,
    summary: string,
    mood: string,
    score: number,
    strength: number
  }

  type StrongPattern = {
    worldId: string,
    pattern: string,
    strength: number
  }

  // ─── State ───

  state {
    config: MemoryConfig = {
      windowSize: 10,
      maxBudget: 5,
      summaryMaxLen: 100,
      reflectionMaxLen: 300,
      decayFactor: 0.9,
      crystallizeThreshold: 7.0,
      reinforceSuccess: 3.0,
      reinforceFailure: -2.0
    }

    // 의식
    currentDraft: string | null = null
    lastReflection: ReflectionResult | null = null
    status: "idle" | "reflecting" | "reinforcing" | "recalling" | "refining" | "consolidating" = "idle"

    // 단기 기억
    recentWindow: Array<string> = []

    // 자아
    totalEntries: number = 0
    selfSummary: string = "아직 기록이 없습니다."

    // ★ 봉인 증거 — 각각 eventId를 가진다
    lastEntry: EntryRecord | null = null
    lastOutcome: OutcomeRecord | null = null
    lastConsolidation: ConsolidationRecord | null = null

    // recall 상태
    recalled: Array<RecallHit> | null = null
    recallBudget: number = 0
    recallHistory: Array<string> = []
    recallRefinement: string | null = null

    // 결정화된 직관
    strongPatterns: Array<StrongPattern> = []
  }

  // ─── Computed ───
  computed hasMemory = gt(totalEntries, 0)
  computed hasRecallBudget = gt(recallBudget, 0)
  computed hasRecalledResults = and(isNotNull(recalled), gt(len(recalled), 0))
  computed recallExhausted = and(eq(recallBudget, 0), gt(len(recallHistory), 0))
  computed hasStrongPatterns = gt(len(strongPatterns), 0)

  // ═══════════════════════════════════════════════════
  // 설정 변경 — 헌법 수정에도 헌법이 적용된다
  // ═══════════════════════════════════════════════════

  action configure(newConfig: MemoryConfig)
    available when eq(status, "idle")
    dispatchable when and(
      gt(newConfig.windowSize, 0),
      lte(newConfig.windowSize, 50),
      gt(newConfig.maxBudget, 0),
      lte(newConfig.maxBudget, 10),
      gt(newConfig.summaryMaxLen, 0),
      lte(newConfig.summaryMaxLen, 500),
      gt(newConfig.reflectionMaxLen, 0),
      lte(newConfig.reflectionMaxLen, 2000),
      gt(newConfig.decayFactor, 0.0),
      lt(newConfig.decayFactor, 1.0),
      gt(newConfig.crystallizeThreshold, 0.0),
      gt(newConfig.reinforceSuccess, 0.0),
      lt(newConfig.reinforceFailure, 0.0)
    )
  {
    onceIntent {
      patch config = newConfig
    }
  }

  // ═══════════════════════════════════════════════════
  // 쓰기: 경험 → 회고 → 기억 봉인 (strength 1.0)
  // ★ lastEntry.eventId = $meta.intentId
  // ═══════════════════════════════════════════════════

  action write(content: string)
    available when eq(status, "idle")
    dispatchable when neq(trim(content), "")
  {
    onceIntent {
      patch currentDraft = content
      patch status = "reflecting"
      effect mind.reflect({
        content: content,
        recentWindow: recentWindow,
        selfSummary: selfSummary,
        totalEntries: totalEntries,
        strongPatterns: strongPatterns,
        summaryMaxLen: config.summaryMaxLen,
        reflectionMaxLen: config.reflectionMaxLen,
        into: lastReflection
      })
    }

    when and(isNotNull(lastReflection), eq(status, "reflecting")) {
      patch recentWindow = slice(
        append(recentWindow, lastReflection.memorySummary),
        max(sub(len(append(recentWindow, lastReflection.memorySummary)), config.windowSize), 0),
        len(append(recentWindow, lastReflection.memorySummary))
      )
      patch totalEntries = add(totalEntries, 1)
      patch selfSummary = lastReflection.reflection
      patch lastEntry = {
        eventId: $meta.intentId,
        summary: lastReflection.memorySummary,
        mood: lastReflection.mood
      }
      patch currentDraft = null
      patch lastReflection = null
      patch status = "idle"
    }
  }

  // ═══════════════════════════════════════════════════
  // ★ 결과 피드백: 3단계 분리 (reflecting → reinforcing → idle)
  // ★ lastOutcome.eventId = $meta.intentId
  // ═══════════════════════════════════════════════════

  action recordOutcome(actionWorldId: string, outcome: string)
    available when and(eq(status, "idle"), hasMemory)
    dispatchable when neq(trim(actionWorldId), "")
  {
    // Step 1: LLM 회고
    onceIntent {
      patch status = "reflecting"
      effect mind.reflectOnOutcome({
        actionWorldId: actionWorldId,
        outcome: outcome,
        recentWindow: recentWindow,
        selfSummary: selfSummary,
        summaryMaxLen: config.summaryMaxLen,
        reflectionMaxLen: config.reflectionMaxLen,
        into: lastReflection
      })
    }

    // Step 2: 회고 결과 반영 → effect 전 cleanup 완료 → reinforce
    when and(isNotNull(lastReflection), eq(status, "reflecting")) {
      patch selfSummary = lastReflection.reflection
      patch lastEntry = {
        eventId: $meta.intentId,
        summary: lastReflection.memorySummary,
        mood: lastReflection.mood
      }
      patch lastOutcome = {
        eventId: $meta.intentId,
        actionWorldId: actionWorldId,
        outcome: outcome,
        delta: eq(outcome, "success")
          ? config.reinforceSuccess
          : config.reinforceFailure
      }
      patch lastReflection = null
      patch status = "reinforcing"
      effect pheromone.reinforce({
        worldId: actionWorldId,
        delta: eq(outcome, "success")
          ? config.reinforceSuccess
          : config.reinforceFailure
      })
    }

    // Step 3: reinforce 완료 → idle
    when eq(status, "reinforcing") {
      patch status = "idle"
    }
  }

  // ═══════════════════════════════════════════════════
  // ★ 수면: event-driven 감쇠 + 결정화
  // ★ lastConsolidation.eventId = $meta.intentId
  // ═══════════════════════════════════════════════════

  action consolidate()
    available when and(eq(status, "idle"), hasMemory)
  {
    onceIntent {
      patch lastConsolidation = {
        eventId: $meta.intentId,
        decayFactor: config.decayFactor,
        crystallizeThreshold: config.crystallizeThreshold
      }
      patch status = "consolidating"
      effect pheromone.consolidate({
        decayFactor: config.decayFactor,
        crystallizeThreshold: config.crystallizeThreshold,
        into: strongPatterns
      })
    }

    when eq(status, "consolidating") {
      patch status = "idle"
    }
  }

  // ═══════════════════════════════════════════════════
  // 검색: similarity × strength
  // ═══════════════════════════════════════════════════

  action recall(query: string, budget: number)
    available when and(eq(status, "idle"), hasMemory)
    dispatchable when and(
      neq(trim(query), ""),
      gt(budget, 0),
      lte(budget, config.maxBudget)
    )
  {
    onceIntent {
      patch status = "recalling"
      patch recallBudget = budget
      patch recallHistory = [query]
      patch recalled = null
      patch recallRefinement = null
      effect memory.recall({ query: query, topK: 5, into: recalled })
    }

    when and(isNotNull(recalled), eq(status, "recalling")) {
      patch recallBudget = sub(recallBudget, 1)
      patch status = "idle"
    }
  }

  // ═══════════════════════════════════════════════════
  // 검색 정제
  // ═══════════════════════════════════════════════════

  action refineRecall()
    available when and(
      eq(status, "idle"),
      hasRecallBudget,
      isNotNull(recalled)
    )
  {
    onceIntent {
      patch status = "refining"
      effect mind.refineQuery({
        originalQueries: recallHistory,
        previousResults: recalled,
        into: recallRefinement
      })
    }

    when and(isNotNull(recallRefinement), eq(status, "refining")) {
      patch recallHistory = append(recallHistory, recallRefinement)
      patch recalled = null
      patch recallRefinement = null
      patch status = "recalling"
      effect memory.recall({
        query: at(recallHistory, sub(len(recallHistory), 1)),
        topK: 5,
        into: recalled
      })
    }

    when and(isNotNull(recalled), eq(status, "recalling")) {
      patch recallBudget = sub(recallBudget, 1)
      patch status = "idle"
    }
  }

  // ═══════════════════════════════════════════════════
  // 검색 종료
  // ═══════════════════════════════════════════════════

  action endRecall()
    available when or(isNotNull(recalled), recallExhausted)
  {
    onceIntent {
      patch recalled = null
      patch recallBudget = 0
      patch recallHistory = []
      patch recallRefinement = null
    }
  }
}
```

---

## 6. Effect Handlers

### 6.1 기존

| Effect | 역할 |
|--------|------|
| `mind.reflect` | LLM 회고 (config-aware truncation) |
| `mind.refineQuery` | LLM 검색어 정제 |
| `memory.recall` | vector search → RecallHit[] (similarity × strength) |

### 6.2 페로몬

| Effect | 역할 |
|--------|------|
| `mind.reflectOnOutcome` | LLM이 결과를 해석 |
| `pheromone.reinforce` | anchor.strength += delta |
| `pheromone.consolidate` | decayAll + extractStrong → strongPatterns |

---

## 7. Post-Commit Anchoring

```typescript
async function commitAndAnchor(
  agent: LineageInstance,
  intent: Intent,
  vectorStore: VectorStore,
  provider: LLMProvider,
  lastSeenEntryEventId: string | null,
): Promise<string | null> {
  await agent.commitAsync(intent);

  const snapshot = agent.getSnapshot();
  const entry = snapshot.data.lastEntry as EntryRecord | null;

  // ★ eventId가 바뀌었을 때만 = 이 commit에서 새 entry가 태어났을 때만
  if (entry && entry.eventId !== lastSeenEntryEventId) {
    const head = await agent.getLatestHead();
    if (!head) return entry.eventId;

    const timestamp = head.headAdvancedAt ?? new Date().toISOString();
    const embedding = await provider.embed(entry.summary);
    await vectorStore.insert({
      worldId: head.worldId,
      embedding,
      summary: entry.summary,
      mood: entry.mood,
      timestamp,
      strength: 1.0,
    });
  }

  return entry?.eventId ?? lastSeenEntryEventId;
}
```

**dedupe가 eventId 기반.** worldId가 아니라 "새 entry 사건이 발생했는가"로 판별. recall이나 consolidate commit에서는 entry eventId가 안 바뀌므로 anchor를 안 만든다.

---

## 8. 재구축 보장

### 8.1 원칙

모든 재구축 정보는 **domain-owned sealed evidence + eventId**다. Lineage를 순회하되, 이미 본 eventId는 skip한다. 이로써 "같은 사건의 지속"과 "새 사건의 발생"을 결정론적으로 구분한다.

### 8.2 재구축 코드

```typescript
async function rebuildIndex(agent, vectorStore, provider) {
  const lineage = await agent.getLineage();

  const seenEntry = new Set<string>();
  const seenOutcome = new Set<string>();
  const seenConsolidation = new Set<string>();

  // Pass 1: anchor 생성 (새 entry event만)
  for (const worldId of lineage.worldIds) {
    const snapshot = await agent.getWorldSnapshot(worldId);
    const entry = snapshot?.data.lastEntry;
    if (!entry || seenEntry.has(entry.eventId)) continue;
    seenEntry.add(entry.eventId);

    const head = /* world metadata */;
    const embedding = await provider.embed(entry.summary);
    await vectorStore.insert({
      worldId, embedding,
      summary: entry.summary, mood: entry.mood,
      timestamp: head.headAdvancedAt, strength: 1.0,
    });
  }

  // Pass 2: reinforce (새 outcome event만)
  for (const worldId of lineage.worldIds) {
    const snapshot = await agent.getWorldSnapshot(worldId);
    const outcome = snapshot?.data.lastOutcome;
    if (!outcome || seenOutcome.has(outcome.eventId)) continue;
    seenOutcome.add(outcome.eventId);

    await vectorStore.updateStrength(outcome.actionWorldId, outcome.delta);
  }

  // Pass 3: decay (새 consolidation event만)
  for (const worldId of lineage.worldIds) {
    const snapshot = await agent.getWorldSnapshot(worldId);
    const c = snapshot?.data.lastConsolidation;
    if (!c || seenConsolidation.has(c.eventId)) continue;
    seenConsolidation.add(c.eventId);

    await vectorStore.decayAll(c.decayFactor);
  }
}
```

**수학이 맞다:** 각 사건은 정확히 한 번만 적용된다. world 수에 비례한 중복 오염이 구조적으로 불가능하다.

---

## 9. MCP Tool Surface

```
commit(write({ content }))                          → 경험 기록 (strength 1.0)
commit(recordOutcome({ actionWorldId, outcome }))    → 페로몬 강화/약화
commit(consolidate())                                → 감쇠 + 결정화
commit(recall({ query, budget }))                    → 검색 (similarity × strength)
commit(refineRecall())                               → 검색 정제
commit(endRecall())                                  → 검색 종료
commit(configure({ ... }))                           → 설정 변경 (invariant guarded)

get_snapshot()                                       → strongPatterns + recalled 포함
get_available_actions()                              → 상태에 따라 변동
get_world_snapshot({ worldId })                      → 특정 시점 복원
```

---

## 10. Hindsight와의 차이

| 차원 | Hindsight | 이것 |
|------|-----------|------|
| 검색 품질 | ★★★★★ (4-way + cross-encoder) | ★★ (cosine) |
| 피드백 루프 | ❌ | ★ recordOutcome → reinforce |
| 시간 감쇠 | ❌ | ★ consolidate → decay |
| 직관 결정화 | ❌ | ★ strongPatterns → MEL guard |
| 행동 제약 | ❌ | ★ available when / dispatchable when |
| 설명 가능 | ❌ | ★ whyNot(), getAvailableActions() |
| 재구축 | N/A | ★ eventId 기반 결정론적 재구축 |

---

## 11. 구현 순서

### Phase 1: write + persistent lineage + anchor (하루)

```
domain.mel, LLMProvider, mind.reflect
sqlite-lineage-store, sqlite-vector-store (strength 필드)
commitAndAnchor (entry.eventId 기반 dedupe)
write 5개 → recall → similarity × strength 확인
```

### Phase 2: recordOutcome + reinforce (하루)

```
mind.reflectOnOutcome, pheromone.reinforce
3단계 분리 (reflecting → reinforcing → idle)
lastOutcome.eventId sealed 확인
write 10개 → recordOutcome 5개 → recall → 강화된 기억 상위
```

### Phase 3: consolidate + rebuild (하루)

```
pheromone.consolidate (decayAll + extractStrong)
lastConsolidation.eventId sealed 확인
rebuild.ts (3-pass, seen<eventId> 기반)
vector store 삭제 → rebuild → 원본과 동일 strength
```

### Phase 4: MCP server + Claude Code (하루)

```
bin/memory-agent.mjs, .mcp.json, CLAUDE.md
Claude Code에서 전체 flow
```

---

## 12. 성공 기준

| 기준 | 측정 |
|------|------|
| 기억 형성 | write → sealed world + anchor(strength: 1.0) + entry.eventId |
| 페로몬 강화 | recordOutcome("success") → strength 증가 + outcome.eventId |
| 페로몬 약화 | recordOutcome("failure") → strength 감소 |
| effect 경계 | reflecting → reinforcing → idle 3단계 |
| event-driven 감쇠 | consolidate → decay + consolidation.eventId |
| 직관 결정화 | strength > threshold → strongPatterns |
| 가중 검색 | similarity × strength 순위 |
| ★ 재구축 정확성 | rebuild → seen<eventId> → 중복 0 → 원본과 동일 strength |
| ★ 사건 추적 | recall/endRecall world에서 lastEntry.eventId가 지속 → anchor 미생성 |
| config 자기보존 | invariant guard 11개 |
| MCP 통합 | Claude Code에서 전체 flow |

---

## 13. 다음 단계 (이번 범위 밖)

| 개선 | 트리거 |
|------|--------|
| strength → salience + valence 분리 | 실패의 결정화 패턴이 불충분할 때 |
| strongPatterns.pattern → normalized patternKey/tags | 자연어 substring이 불안정할 때 |
| Hindsight를 recall backend로 연결 | cosine 단독 recall 정밀도 부족할 때 |
| Genealogy로 schema 자체 변경 | crystallize → schema patch 수요 생길 때 |

---

## 14. 한 줄 요약

**기억은 모두가 한다. 직관은 아무도 안 한다. 우리가 한다.**

---

*manifesto-memory-agent PRD v0.5.2*
