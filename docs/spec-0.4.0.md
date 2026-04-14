[200~# manifesto-memory-agent

> **어떤 에이전트든 장기 기억을 가질 수 있게 해주는 retry-capable memory protocol.**

---

## 1. 이 프로젝트가 존재하는 이유

LLM 에이전트에게 "기억해"라고 하면 context window에 넣는다. 대화가 끝나면 사라진다. RAG를 붙이면 문서를 검색하지만, 그건 남의 기억이지 자기 기억이 아니다.

manifesto-memory-agent는 **자기 경험을 저장하고, 압축하고, 필요할 때 찾아내는 memory protocol**이다. 이 프로토콜은 retry 정책, 검색 budget, 기억 형성 조건을 **MEL 헌법으로 선언**한다. 외부 client는 `get_available_actions()`와 `whyNot()`으로 이 규칙을 읽고, 그에 따라 행동한다.

이 프로토콜이 제공하는 것:
- **기억 형성:** 경험을 회고하고 봉인하는 구조
- **기억 검색:** budget 기반 반복 검색 + LLM query 정제
- **기억 연속:** 프로세스 재시작 후 복원
- **기억 인덱스 재구축:** Lineage에서 vector index를 언제든 재생성

이 프로토콜이 제공하지 않는 것:
- retry를 **언제** 호출할지 결정하는 것 (외부 client의 몫)
- 기존 도메인에 drop-in 통합되는 것 (action namespace, state composition은 별도 설계)
- 감정 분석, 성장 회고, 패턴 탐색 (이 프로토콜 **위에** 올라가는 응용)

---

## 2. 기억의 구조

```
┌─────────────────────────────────────────────────────────┐
│ 의식 (Snapshot)                            bounded       │
│                                                          │
│   recentWindow: 최근 N개 요약 (config.windowSize)         │
│   selfSummary: "이 존재는..." (config.reflectionMaxLen)   │
│   lastEntry: { worldId?, summary, mood } (봉인 증거)      │
│                                                          │
│   → 상한 = config에서 계산 가능                             │
├─────────────────────────────────────────────────────────┤
│ 장기 기억 (Lineage)                     unbounded DAG     │
│                                                          │
│   각 World = 그 시점의 Snapshot. 불변. persistent.         │
│                                                          │
├─────────────────────────────────────────────────────────┤
│ 기억의 인덱스 (Vector)                  anchor per world   │
│                                                          │
│   { worldId, embedding, summary, mood, timestamp }        │
│   derived. Lineage의 lastEntry + sealedAt에서 재구축.     │
└─────────────────────────────────────────────────────────┘
```

**Bounded Snapshot 보증:** Snapshot 상한은 config에서 계산 가능하다.

```
maxSnapshotPayload
  = config.windowSize × config.summaryMaxLen      (recentWindow)
  + config.reflectionMaxLen                        (selfSummary)
  + config.summaryMaxLen + 50                      (lastEntry)
  + ~500                                           (나머지 fields + JSON overhead)
```

기본 config(window 10, summary 100자, reflection 300자)에서:
`10 × 100 + 300 + 150 + 500 = 1,950 bytes` (ASCII). 한국어 UTF-8 3배 고려 시 ~6KB 상한. 이건 운영 가정이 아니라 **config × truncation의 구조적 산물**이다.

---

## 3. MEL 도메인

```mel
domain MemoryAgent {

  // ─── Types ───

  type MemoryConfig = {
    windowSize: number,
    maxBudget: number,
    summaryMaxLen: number,
    reflectionMaxLen: number
  }

  type ReflectionResult = {
    mood: string,
    reflection: string,
    memorySummary: string
  }

  type EntryRecord = {
    summary: string,
    mood: string
  }

  type RecallHit = {
    worldId: string,
    summary: string,
    mood: string,
    score: number
  }

  // ─── State ───

  state {
    // 설정 (외부에서 조정 가능)
    config: MemoryConfig = {
      windowSize: 10,
      maxBudget: 5,
      summaryMaxLen: 100,
      reflectionMaxLen: 300
    }

    // 의식
    currentDraft: string | null = null
    lastReflection: ReflectionResult | null = null
    status: "idle" | "reflecting" | "recalling" | "refining" = "idle"

    // 단기 기억 (rolling)
    recentWindow: Array<string> = []

    // 자아
    totalEntries: number = 0
    selfSummary: string = "아직 기록이 없습니다."

    // 봉인 증거 (sealed snapshot에 보존 → 인덱스 재구축용)
    lastEntry: EntryRecord | null = null

    // recall 상태
    recalled: Array<RecallHit> | null = null
    recallBudget: number = 0
    recallHistory: Array<string> = []
    recallRefinement: string | null = null
  }

  // ─── Computed ───
  computed hasMemory = gt(totalEntries, 0)
  computed hasRecallBudget = gt(recallBudget, 0)
  computed hasRecalledResults = and(isNotNull(recalled), gt(len(recalled), 0))
  computed recallExhausted = and(eq(recallBudget, 0), gt(len(recallHistory), 0))

  // ─── 설정 변경 ───
  action configure(newConfig: MemoryConfig)
    available when eq(status, "idle")
  {
    onceIntent {
      patch config = newConfig
    }
  }

  // ─── 쓰기: 경험 → 회고 → 기억 봉인 ───
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
        summary: lastReflection.memorySummary,
        mood: lastReflection.mood
      }
      patch currentDraft = null
      patch lastReflection = null
      patch status = "idle"
    }
  }

  // ─── 검색: budget 기반 ───
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

  // ─── 검색 정제: LLM이 더 나은 query 제안 → 자동 재검색 ───
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

    // LLM이 새 query를 제안하면 → 정리 후 재검색
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

  // ─── 검색 종료 ───
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

### 3.1 MEL이 하는 것

| 역할 | 구체적으로 |
|------|----------|
| 상태 보호 | `available when eq(status, "idle")` — reflecting 중 새 write 차단 |
| 입력 검증 | `dispatchable when neq(trim(content), "")` — 빈 입력 구조적 거부 |
| budget 강제 | `lte(budget, config.maxBudget)` — 설정 가능한 상한. 무한 루프 구조적 불가 |
| 능력 활성화 | `refineRecall`은 budget 남아있고 결과 있을 때만 나타남 |
| 기억 전제조건 | `recall`은 `hasMemory`일 때만 — 기억 없으면 검색 자체 불가 |
| 설정 가능성 | `configure(newConfig)` — 외부에서 window size, budget 상한, 요약 길이 조정 |
| 설명 가능성 | `get_available_actions()`, `whyNot()`, `simulate()` |

### 3.2 MEL이 안 하는 것

| 역할 | 누가 하는가 |
|------|-----------|
| 회고 생성 | `mind.reflect` → LLM |
| query 정제 | `mind.refineQuery` → LLM |
| 벡터 검색 | `memory.recall` → vector store |
| 기억 인덱싱 | post-commit anchoring → application code |
| 기억 복원 | `getWorldSnapshot()` → Lineage API |
| retry 시점 결정 | 외부 client (Claude Code, 상위 agent) |

---

## 4. Effect Handlers

### 4.1 `mind.reflect` — 회고

```
Input:  content, recentWindow, selfSummary, totalEntries, summaryMaxLen, reflectionMaxLen
Output: { mood, reflection, memorySummary }
```

LLM이 경험을 읽고 감정, 회고, 요약을 생성한다. **Handler가 config 기반으로 truncate:**

```typescript
return [{ op: "set", path: into, value: {
  mood: VALID_MOODS.includes(parsed.mood) ? parsed.mood : "neutral",
  reflection: String(parsed.reflection ?? "").slice(0, reflectionMaxLen),
  memorySummary: String(parsed.memorySummary ?? "").slice(0, summaryMaxLen),
}}];
```

### 4.2 `mind.refineQuery` — 검색어 정제

```
Input:  originalQueries, previousResults (Array<RecallHit>)
Output: string (새로운 query)
```

LLM이 이전 query들과 구조화된 결과를 보고 더 나은 검색어를 제안한다.

### 4.3 `memory.recall` — 벡터 검색 + Lineage 복원

```
Input:  query, topK
Output: Array<RecallHit> — { worldId, summary, mood, score }
```

query → embedding → vector search → 각 anchor의 worldId로 Lineage에서 canonical snapshot 복원 → 구조화된 hit 반환.

외부 agent는 `recalled[0].worldId`로 `get_world_snapshot()`을 직접 호출할 수 있다.

### 4.4 LLM Provider 추상화

```typescript
type LLMProvider = {
  chat(messages: LLMMessage[], options?: { json?: boolean }): Promise<string>;
  embed(text: string): Promise<number[]>;
};
```

교체: `ollamaProvider("gemma4:e4b")` / `claudeProvider()` / `openaiProvider()` — env로 선택.

---

## 5. Post-Commit Anchoring

### 5.1 왜 subscribe가 아닌가

subscribe 기반 indexer는 연속 커밋 시 entry와 worldId가 어긋날 수 있다. snapshot A의 lastEntry를 보고 callback이 시작됐는데, 그 사이 commit B가 진행되면 `getLatestHead()`는 B를 반환한다.

### 5.2 직렬화된 post-commit wrapper

```typescript
async function commitAndAnchor(
  agent: LineageInstance,
  intent: Intent,
  vectorStore: VectorStore,
  provider: LLMProvider,
  prevEntry: EntryRecord | null,
): Promise<EntryRecord | null> {
  // 1. commit — seal + publish 완료
  await agent.commitAsync(intent);

  // 2. 직렬: head 확정
  const snapshot = agent.getSnapshot();
  const entry = snapshot.data.lastEntry as EntryRecord | null;

  // 3. entry 변경 시만 anchor
  if (entry && entry.summary !== prevEntry?.summary) {
    const head = await agent.getLatestHead();
    if (!head) return entry;

    // 4. timestamp는 sealed snapshot에서 — rebuild와 일치
    const worldSnapshot = await agent.getWorldSnapshot(head.worldId);
    const timestamp = worldSnapshot?.system?.sealedAt ?? new Date().toISOString();

    const embedding = await provider.embed(entry.summary);
    await vectorStore.insert({
      worldId: head.worldId,
      embedding,
      summary: entry.summary,
      mood: entry.mood,
      timestamp,
    });
  }

  return entry;
}
```

경쟁 조건 0. entry와 worldId가 같은 직렬 흐름에서 결정.

### 5.3 재구축 보장

`lastEntry`는 sealed snapshot에 보존된다. timestamp는 `sealedAt`에서 가져온다. vector store가 날아가도:

```typescript
async function rebuildIndex(agent: LineageInstance, vectorStore: VectorStore, provider: LLMProvider) {
  const lineage = await agent.getLineage();
  for (const worldId of lineage.worldIds) {
    const snapshot = await agent.getWorldSnapshot(worldId);
    const entry = snapshot?.data.lastEntry;
    if (!entry) continue;
    const embedding = await provider.embed(entry.summary);
    await vectorStore.insert({
      worldId,
      embedding,
      summary: entry.summary,
      mood: entry.mood,
      timestamp: snapshot.system?.sealedAt ?? "",
    });
  }
}
```

모든 값이 sealed snapshot에서 나온다. 진짜 derived.

---

## 6. MCP Integration

### 6.1 설정

```json
{
  "mcpServers": {
    "memory-agent": {
      "command": "node",
      "args": ["./bin/memory-agent.mjs"],
      "env": {
        "LLM_PROVIDER": "ollama",
        "LLM_MODEL": "gemma4:e4b"
      }
    }
  }
}
```

### 6.2 Tool Surface (LineageInstance)

```
commit(write({ content }))                → 기억 형성
commit(recall({ query, budget }))          → 검색 시작
commit(refineRecall())                     → 검색 정제 (budget 소모)
commit(endRecall())                        → 검색 종료
commit(configure({ windowSize, ... }))     → 설정 변경

get_snapshot()                             → 현재 의식 + recalled (RecallHit[])
get_available_actions()                    → 지금 가능한 행동 (상태에 따라 변동)
get_history()                              → 전체 기억 체인
get_world_snapshot({ worldId })            → 특정 시점의 기억 복원 (recalled hit에서 참조)
simulate({ action, input })                → commit 없이 미리보기
```

### 6.3 Claude Code에서의 사용

```
사용자: DB 장애 대응했던 기억 찾아줘.

Claude:
  → get_available_actions()
    → ["write", "recall", "configure"]

  → commit(recall({ query: "DB 장애 대응", budget: 3 }))
  → get_snapshot()
    recalled: [
      { worldId: "w-48", summary: "Production failover 성공", mood: "relieved", score: 0.91 },
      { worldId: "w-23", summary: "커넥션 풀 고갈 이슈", mood: "anxious", score: 0.85 }
    ]
    recallBudget: 2

  "2개 찾았는데 더 찾아볼게요."
  → get_available_actions()
    → ["write", "refineRecall", "endRecall", "configure"]
                  ↑ budget 남아서 나타남

  → commit(refineRecall())
    LLM: "데이터베이스 장애 복구 자동화"로 재검색
  → get_snapshot()
    recalled: [
      { worldId: "w-67", summary: "DB auto-failover 구현", mood: "hopeful", score: 0.88 }
    ]
    recallBudget: 1

  "한 번 더 볼까요?"
  → commit(refineRecall())
  → recallBudget: 0
  → get_available_actions()
    → ["write", "endRecall", "configure"]
                  ↑ refineRecall 사라짐!

  "w-48 시점의 상세 기록을 볼게요."
  → get_world_snapshot({ worldId: "w-48" })
    → 그 시점의 완전한 Snapshot 복원

  → commit(endRecall())
```

---

## 7. 프로젝트 구조

```
manifesto-memory-agent/
├── domain.mel
├── providers/
│   ├── types.ts                    ← LLMProvider interface
│   ├── ollama.ts
│   ├── anthropic.ts
│   └── openai.ts
├── effects/
│   ├── mind-reflect.ts             ← 회고 (config-aware truncation)
│   ├── mind-refine-query.ts        ← 검색어 정제
│   └── memory-recall.ts            ← 벡터 검색 → RecallHit[]
├── indexer/
│   ├── anchor.ts                   ← post-commit wrapper (직렬)
│   └── rebuild.ts                  ← vector index 재구축
├── vector/
│   ├── store.ts                    ← VectorStore interface
│   └── sqlite-store.ts
├── lineage/
│   └── sqlite-lineage-store.ts     ← persistent LineageStore
├── bin/
│   └── memory-agent.mjs            ← MCP server entry point
├── .mcp.json
├── CLAUDE.md
├── package.json
└── tsconfig.json
```

---

## 8. 구현 순서

### Phase 1: write + persistent lineage (하루)

```
domain.mel → mel check 통과
LLMProvider + ollama 구현
mind.reflect handler (config-aware truncation)
sqlite-lineage-store.ts
commitAndAnchor wrapper (subscribe 대신)
main.ts: write 3개 → kill → restart → restore → 기억 연속
```

### Phase 2: recall + refine (하루)

```
sqlite-vector-store.ts
memory.recall handler → RecallHit[]
mind.refineQuery handler
rebuild.ts
main.ts: write 10개 → recall → refineRecall → endRecall
         vector store 삭제 → rebuild → 같은 결과
```

### Phase 3: MCP server + Claude Code (하루)

```
bin/memory-agent.mjs
.mcp.json + CLAUDE.md
Claude Code에서 전체 flow:
  write → recall(budget:3) → refineRecall → refineRecall → endRecall
  configure로 window size 변경
  get_available_actions 상태별 변동 확인
  get_world_snapshot으로 recalled hit 복원
```

---

## 9. 기술 스택

| 구성요소 | 선택 |
|----------|------|
| Runtime | `@manifesto-ai/sdk` + `@manifesto-ai/lineage` |
| MCP Server | `@manifesto-ai/mcp/runtime` |
| Lineage Store | SQLite (persistent, Phase 1부터) |
| Vector Store | SQLite + cosine similarity (derived) |
| LLM | Ollama gemma4:e4b (기본, `LLM_PROVIDER` env로 교체) |
| Embedding | Ollama nomic-embed-text (기본, provider.embed()로 교체) |

---

## 10. 성공 기준

| 기준 | 측정 |
|------|------|
| 기억 형성 | write → commitAsync → sealed world |
| 기억 참조 | 회고가 recentWindow의 과거를 참조 |
| 기억 검색 | recall → RecallHit[] with worldId + score |
| 검색 정제 | refineRecall → 더 나은 결과 |
| budget 강제 | 소진 시 refineRecall unavailable |
| 구조화된 recall | recalled[n].worldId로 get_world_snapshot 가능 |
| 기억 연속 | kill → restart → restore → 복원 |
| 인덱스 재구축 | vector store 삭제 → rebuild → 동일 결과 |
| Snapshot bounded | config 기반 계산 가능한 상한 |
| 설정 변경 | configure로 runtime 파라미터 조정 |
| MCP 통합 | Claude Code에서 자연어로 전체 flow |
| 설명 가능 | get_available_actions(), whyNot() 정확 동작 |

---

## 11. 재사용

이 memory protocol은 재사용 가능한 capability pattern이다. 다른 에이전트에 통합하려면:

1. MemoryAgent의 state fields와 actions를 대상 도메인의 MEL에 포함
2. effect handler들 (`mind.reflect`, `mind.refineQuery`, `memory.recall`)을 대상 에이전트의 effects에 등록
3. post-commit anchoring wrapper를 대상 에이전트의 commit flow에 적용
4. action namespace 충돌과 state composition은 대상 도메인별로 설계

이 프로토콜은 "그대로 drop-in"이 아니라 "패턴을 이식"하는 것이다. 통합 방식은 대상 도메인의 규모와 구조에 따라 달라진다.

---

*manifesto-memory-agent PRD v0.4.0*

---

