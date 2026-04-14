# manifesto-memory-agent

> **기억을 가진 존재의 첫 번째 시연.**

---

## 1. 이 프로젝트가 존재하는 이유

Manifesto의 궁극적 비전은 "AI에게 마음을 만들어주는 것"이다. 마음의 가장 원초적인 형태는 **기억**이다 — 경험을 저장하고, 압축하고, 필요할 때 끄집어내는 능력.

현재 LLM은 context window 안에서만 "기억"한다. 대화가 끝나면 사라진다. RAG는 문서를 검색하지만, 그건 **남의 기억을 빌리는 것**이지 **자기 기억을 형성하는 것**이 아니다.

manifesto-memory-agent는 이 문제를 Manifesto의 구조로 해결한다:

| 기존 접근 | Manifesto 접근 |
|-----------|---------------|
| Context window = 기억 | Snapshot = 의식, Lineage = 장기 기억 |
| 대화 종료 = 기억 소실 | commitAsync = 기억 봉인 (sealed, immutable) |
| RAG = 외부 문서 검색 | Vector anchor = 자기 경험 검색 |
| LLM = 모든 것을 처리 | MEL = 결정론적 판단 구조, LLM = effect handler |
| 무엇을 할 수 있는지 = 불투명 | `available when` + `dispatchable when` = 설명 가능한 세계 |

---

## 2. 무엇을 만드는가

**일기를 쓰면 기억하고, 물어보면 기억을 찾아주는 에이전트.**

```
사용자: write("오늘 벚꽃이 지는 걸 봤다. 쓸쓸했지만 평화로웠다.")
에이전트: (회고) "계절이 바뀌는 걸 느끼셨군요. 지난달 공원 산책에서도
          비슷한 평화를 느꼈었죠. 변화 속의 고요함이 당신의 패턴인 것 같아요."
         mood: reflective

...3개월 후...

사용자: recall("봄에 산책한 기억")
에이전트: [Day 1: 벚꽃 산책, 쓸쓸함과 평화의 공존]
         [Day 23: 퇴근길 공원, 봄바람]
         [Day 45: 주말 한강, 피크닉]
```

단순한 일기장이 아니다. **자기 경험에서 패턴을 발견하고, 과거를 참조하여 현재를 해석하며, 왜 지금 이 행동이 가능한지 설명할 수 있는 존재**다.

---

## 3. 기억의 계층 구조

```
┌─────────────────────────────────────────────────────────┐
│ 의식 (Snapshot.data)                    bounded, ~1KB    │
│                                                          │
│   recentWindow: 최근 10개 경험 요약 (rolling, 각 ≤100자)   │
│   selfSummary: "이 사람은..." (≤300자, 압축된 자아 이해)    │
│   lastEntry: { summary, mood } (재구축 증거, sealed에 보존) │
│   currentDraft / lastReflection: 지금 처리 중인 것         │
│                                                          │
│   → LLM에 전달되는 전부. 토큰 사용량 일정.                  │
├─────────────────────────────────────────────────────────┤
│ 장기 기억 (Lineage)                     unbounded DAG     │
│                                                          │
│   World 1 → World 2 → ... → World 3000 → ...            │
│   각 World = 그 시점의 완전한 Snapshot                     │
│   write만 seal. recall은 비봉인 (장기 기억 ≠ 모든 상태)    │
│                                                          │
│   → 원본 데이터. append-only. 불변. persistent.            │
├─────────────────────────────────────────────────────────┤
│ 기억의 인덱스 (Vector Store)            anchor per world   │
│                                                          │
│   { worldId, embedding, summary, mood, timestamp }        │
│                                                          │
│   → Lineage를 가리키는 포인터. derived. 재구축 가능.        │
│   → 재구축: Lineage 순회 → 각 snapshot.lastEntry에서 추출   │
│   → similarity search → worldId → Lineage에서 복원         │
└─────────────────────────────────────────────────────────┘
```

**핵심 원리:**
- Snapshot은 bounded: handler가 문자열 길이를 구조적으로 truncate
- Lineage는 unbounded + persistent: source of truth (Phase 1부터)
- Vector index는 derived: Lineage의 sealed snapshot에서 언제든 재구축 가능
- LLM은 "의식" 범위만 본다: fat input 원칙
- Lineage에는 "경험"만 남는다: recall/housekeeping은 seal하지 않음

---

## 4. MEL 도메인

```mel
domain MemoryAgent {

  type ReflectionResult = {
    mood: string,
    reflection: string,
    memorySummary: string
  }

  type EntryRecord = {
    summary: string,
    mood: string
  }

  state {
    // ─── 의식 (working memory) ───
    currentDraft: string | null = null
    lastReflection: ReflectionResult | null = null
    status: "idle" | "reflecting" | "recalling" = "idle"

    // ─── 단기 기억 (rolling context) ───
    recentWindow: Array<string> = []

    // ─── 자아 (compressed identity) ───
    totalEntries: number = 0
    selfSummary: string = "아직 기록이 없습니다."

    // ─── 봉인 증거 (sealed snapshot에 보존 → 인덱스 재구축용) ───
    lastEntry: EntryRecord | null = null

    // ─── recall 결과 ───
    recalled: Array<string> | null = null
  }

  // ─── Computed ───
  computed hasMemory = gt(totalEntries, 0)
  computed isIdle = eq(status, "idle")
  computed windowSize = len(recentWindow)

  // ─── 쓰기: 경험 → 회고 → 기억 형성 ───
  //
  //   available when: idle일 때만 쓸 수 있다
  //   dispatchable when: 빈 문자열은 거부한다
  //   → whyNot(write("")), getAvailableActions() 등으로 legality를 설명 가능
  //
  action write(content: string)
    available when eq(status, "idle")
    dispatchable when neq(trim(content), "")
  {
    // Step 1: LLM에 회고 요청
    onceIntent {
      patch currentDraft = content
      patch status = "reflecting"
      effect mind.reflect({
        content: content,
        recentWindow: recentWindow,
        selfSummary: selfSummary,
        totalEntries: totalEntries,
        into: lastReflection
      })
    }

    // Step 2: 회고 결과 반영 → 기억 형성
    when and(isNotNull(lastReflection), eq(status, "reflecting")) {
      // rolling window 업데이트 (최근 10개 요약만 유지)
      patch recentWindow = slice(
        append(recentWindow, lastReflection.memorySummary),
        max(sub(len(append(recentWindow, lastReflection.memorySummary)), 10), 0),
        len(append(recentWindow, lastReflection.memorySummary))
      )
      patch totalEntries = add(totalEntries, 1)
      patch selfSummary = lastReflection.reflection

      // ★ 봉인 증거: sealed snapshot에 보존된다.
      //    vector index 재구축 시 이 필드에서 추출.
      patch lastEntry = {
        summary: lastReflection.memorySummary,
        mood: lastReflection.mood
      }

      // 작업 기억 정리
      patch currentDraft = null
      patch lastReflection = null
      patch status = "idle"
    }
  }

  // ─── 기억 검색: query → vector search → 과거 복원 ───
  //
  //   recall은 세계를 변경하지만 "경험"이 아니므로
  //   application 레벨에서 dispatchAsync (비봉인)으로 실행한다.
  //
  action recall(query: string)
    available when eq(status, "idle")
    dispatchable when neq(trim(query), "")
  {
    onceIntent {
      patch status = "recalling"
      effect memory.recall({
        query: query,
        topK: 5,
        into: recalled
      })
    }

    when and(isNotNull(recalled), eq(status, "recalling")) {
      patch status = "idle"
    }
  }

  // ─── recall 결과 정리 ───
  action clearRecall() available when isNotNull(recalled) {
    onceIntent {
      patch recalled = null
    }
  }
}
```

### 4.1 v0.1.0에서 바뀐 것

| v0.1.0 | v0.2.0 | 이유 |
|--------|--------|------|
| `once(reflecting)` | `onceIntent` | marker field가 state에 없으면 `once()` 불가. `onceIntent`가 현행 MEL surface |
| `effect memory.anchor(...)` in MEL | 삭제. post-seal application code | effect는 compute loop 안. sealed worldId는 commit 후에야 확정 |
| `lastReflection = null` 후 mood/summary 소실 | `lastEntry` 필드 추가 | sealed snapshot에 anchor payload 보존 → 인덱스 재구축 가능 |
| `status: "done"` + `ready()` action | `write` 완료 시 바로 `"idle"`. `ready()` 삭제 | lineage 오염 방지. "경험"만 seal |
| `available when` 없음 | `write`, `recall`에 coarse + fine gate | legality surface 활용. `whyNot()`, `getAvailableActions()` 동작 |
| `takeLast()` 사용 | `slice()` + `append()` 조합 | `takeLast`는 현행 MEL builtin에 없음 |
| bounded 주장은 운영 가정 | handler에서 truncation 강제 | 구조적 보증 |
| Lineage: in-memory | Lineage: persistent (Phase 1부터) | source of truth가 derived cache보다 먼저 사라지면 역전 |

### 4.2 Legality Surface

이 도메인은 Manifesto의 "설명 가능한 세계 계약"을 시연한다:

```typescript
// 지금 뭘 할 수 있는지?
agent.getAvailableActions()
// status가 "idle"이면 → ["write", "recall"]
// status가 "reflecting"이면 → [] (아무것도 못 함)

// 왜 이 행동이 안 되는지?
agent.whyNot(agent.createIntent(agent.MEL.actions.write, { content: "" }))
// → "dispatchable when neq(trim(content), \"\") is false"

// 이 행동을 해도 되는지?
agent.isIntentDispatchable(
  agent.createIntent(agent.MEL.actions.recall, { query: "봄 산책" })
)
// → true

// 시뮬레이션 (commit 없이 결과 미리보기)
agent.simulate(agent.createIntent(agent.MEL.actions.write, { content: "오늘..." }))
// → 예상 snapshot 반환
```

---

## 5. Effect Handlers

**두 개.** `memory.anchor`는 더 이상 effect가 아니다.

### 5.1 `mind.reflect` — LLM 회고 (gemma4)

```
Input:  content, recentWindow, selfSummary, totalEntries
Output: { mood, reflection, memorySummary }
```

LLM이 하는 일:
- 지금 쓴 내용을 읽는다
- 최근 기억(recentWindow)과 자아 이해(selfSummary)를 참조한다
- 감정(mood), 회고(reflection), 요약(memorySummary)을 생성한다

**Bounded output 보증:** handler가 출력을 구조적으로 truncate한다.

```typescript
// handler 내부
const summary = parsed.memorySummary.slice(0, 100);     // ≤100자
const reflection = parsed.reflection.slice(0, 300);      // ≤300자
const mood = VALID_MOODS.includes(parsed.mood) ? parsed.mood : "neutral";  // 허용 목록
```

**모델:** Ollama gemma4:e4b (9B, 로컬 4090)

### 5.2 `memory.recall` — Vector 검색 + Lineage 복원

```
Input:  query, topK
Output: Array<string> — 복원된 기억 요약들
```

query를 embedding하고, vector store에서 top-K anchor를 찾고, 각 anchor의 worldId로 Lineage에서 canonical snapshot을 복원한다.

**모델:** Ollama nomic-embed-text (embedding)

---

## 6. Post-Seal Indexer: Memory Anchor

`memory.anchor`는 MEL effect가 아니다. `commitAsync()` 성공 후 application level에서 실행되는 **post-seal indexer**다.

왜: effect는 compute loop 안에서 실행된다. sealed worldId는 `commitAsync()` 완료 후에야 확정된다. "봉투에 넣기 전에 등기번호를 알고 싶다"는 건 불가능하다.

```typescript
// application code — commitAsync 이후
async function writeAndAnchor(agent: LineageInstance, content: string) {
  // 1. 경험을 기억으로 봉인
  await agent.commitAsync(
    agent.createIntent(agent.MEL.actions.write, { content })
  );

  // 2. 봉인 완료 — 이제 worldId가 확정됨
  const head = await agent.getLatestHead();
  if (!head) return;

  // 3. sealed snapshot에서 anchor payload 추출
  const snapshot = await agent.getWorldSnapshot(head.worldId);
  if (!snapshot?.data.lastEntry) return;

  const { summary, mood } = snapshot.data.lastEntry;

  // 4. vector store에 인덱싱
  const embedding = await embed(summary);
  await vectorStore.insert({
    worldId: head.worldId,
    embedding,
    summary,
    mood,
    timestamp: new Date().toISOString(),
  });
}
```

**재구축 보장:** `lastEntry`는 sealed snapshot의 일부다. vector store가 날아가도 Lineage를 순회하면서 각 world의 `snapshot.data.lastEntry`에서 추출하여 재구축할 수 있다:

```typescript
async function rebuildVectorIndex(agent: LineageInstance, vectorStore: VectorStore) {
  const lineage = await agent.getLineage();
  for (const worldId of lineage.worldIds) {
    const snapshot = await agent.getWorldSnapshot(worldId);
    const entry = snapshot?.data.lastEntry;
    if (!entry) continue;

    const embedding = await embed(entry.summary);
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

---

## 7. Lineage 전략: "경험"만 봉인한다

| Action | 실행 방법 | Lineage에 남는가 | 이유 |
|--------|----------|-----------------|------|
| `write(content)` | `commitAsync` | ✅ Yes | 경험 = 기억을 형성하는 행위 |
| `recall(query)` | `dispatchAsync` | ❌ No | 기억을 조회하는 행위. 경험이 아님 |
| `clearRecall()` | `dispatchAsync` | ❌ No | housekeeping. 경험이 아님 |

"Lineage = 장기 기억"이라는 ontology를 지키려면, **의미 있는 세계 변화(경험)만 seal**해야 한다. recall이나 정리 동작이 lineage에 섞이면 기억 체인이 탁해진다.

```typescript
// write만 commitAsync (봉인)
await agent.commitAsync(agent.createIntent(agent.MEL.actions.write, { content }));

// recall은 dispatchAsync (비봉인)
await agent.dispatchAsync(agent.createIntent(agent.MEL.actions.recall, { query }));
```

**주의:** `LineageInstance`에서 `dispatchAsync`는 제거되어 있다. 그래서 `recall`과 `clearRecall`은 **별도의 base runtime 또는 lineage-aware non-sealing path**가 필요하다. 현재 계약에서 가장 간단한 해법은:

- `write`만 `commitAsync`로 실행
- `recall`, `clearRecall`도 `commitAsync`로 실행하되, **anchor를 생성하지 않는다** (post-seal indexer가 `lastEntry` 변경 여부를 확인)

이렇게 하면 Lineage DAG에는 recall world도 들어가지만, **vector index에는 write world만 인덱싱**된다. 물리적 분리는 아니지만 논리적 분리는 달성된다.

```typescript
async function writeAndAnchor(agent: LineageInstance, content: string) {
  await agent.commitAsync(
    agent.createIntent(agent.MEL.actions.write, { content })
  );

  const head = await agent.getLatestHead();
  const snapshot = await agent.getWorldSnapshot(head.worldId);

  // ★ lastEntry가 이전 world와 다를 때만 anchor 생성
  //   → write는 lastEntry를 갱신하므로 anchor 생성
  //   → recall은 lastEntry를 안 바꾸므로 anchor 미생성
  if (snapshot?.data.lastEntry && hasChanged(snapshot.data.lastEntry, previousEntry)) {
    await anchorMemory(vectorStore, head.worldId, snapshot.data.lastEntry);
    previousEntry = snapshot.data.lastEntry;
  }
}
```

---

## 8. 데이터 흐름

### 8.1 `write("벚꽃이 지고 있었다")`

```
1. commitAsync(write("벚꽃이 지고 있었다"))
   ├── available when eq(status, "idle") → ✅
   └── dispatchable when neq(trim(content), "") → ✅
2. onceIntent:
   - currentDraft = "벚꽃이 지고 있었다"
   - status = "reflecting"
   - effect mind.reflect({
       content: "벚꽃이 지고 있었다",
       recentWindow: ["어제 카페에서 책 읽음", ...],
       selfSummary: "자연과 계절에 감수성이 있는 사람",
       totalEntries: 47
     })
3. gemma4 응답 (handler가 truncate):
   {
     mood: "reflective",                    // 허용 목록 검증
     reflection: "벚꽃이 지는 걸 보며...",    // ≤300자
     memorySummary: "벚꽃 산책, 쓸쓸함과 평화" // ≤100자
   }
4. when(lastReflection):
   - recentWindow: [..., "벚꽃 산책, 쓸쓸함과 평화"] (최근 10개)
   - totalEntries = 48
   - selfSummary 업데이트
   - lastEntry = { summary: "벚꽃 산책, 쓸쓸함과 평화", mood: "reflective" }
   - currentDraft = null, lastReflection = null
   - status = "idle"
5. Lineage seal: World #48
6. [Post-seal] anchor:
   - head.worldId = "world-48"
   - getWorldSnapshot("world-48") → snapshot.data.lastEntry
   - embed("벚꽃 산책, 쓸쓸함과 평화") → vector
   - vectorStore.insert({ worldId: "world-48", embedding, summary, mood, timestamp })
```

### 8.2 `recall("봄에 산책한 기억")` (3개월 후)

```
1. commitAsync(recall("봄에 산책한 기억"))
   ├── available when eq(status, "idle") → ✅
   └── dispatchable when neq(trim(query), "") → ✅
2. onceIntent:
   - status = "recalling"
   - effect memory.recall({ query: "봄에 산책한 기억", topK: 5 })
3. recall handler:
   - embed("봄에 산책한 기억") → query vector
   - vector search → top 5:
     - { worldId: "world-48", summary: "벚꽃 산책...", similarity: 0.92 }
     - { worldId: "world-23", summary: "퇴근길 공원...", similarity: 0.87 }
     - ...
   - getWorldSnapshot("world-48") → canonical snapshot 복원
   - 결과 조립
4. when(recalled):
   - recalled = ["[reflective] 벚꽃 산책...", "[calm] 퇴근길 공원..."]
   - status = "idle"
5. Lineage seal: World #93 (recall world — anchor 미생성)
   [Post-seal] lastEntry 변경 없음 → anchor 미생성 ✅
```

---

## 9. 프로젝트 구조

```
manifesto-memory-agent/
├── domain.mel                          ← MEL 도메인
├── effects/
│   ├── mind-reflect.ts                 ← LLM 회고 (gemma4, bounded output)
│   └── memory-recall.ts                ← Vector 검색 + Lineage 복원
├── indexer/
│   ├── anchor.ts                       ← Post-seal memory anchor
│   └── rebuild.ts                      ← Vector index 재구축 (Lineage 순회)
├── vector/
│   ├── store.ts                        ← VectorStore interface
│   └── sqlite-store.ts                 ← SQLite 기반 로컬 구현
├── lineage/
│   └── sqlite-lineage-store.ts         ← LineageStore 구현 (persistent)
├── main.ts                             ← 실행 스크립트
├── interactive.ts                      ← REPL 인터페이스
├── package.json
└── tsconfig.json
```

---

## 10. 구현 순서

### Phase 1: MEL + LLM + Persistent Lineage (하루)

```
domain.mel 작성 → mel check 통과 확인
mind.reflect handler 구현 (gemma4, bounded output)
sqlite-lineage-store.ts 구현 (LineageStore interface)
main.ts에서 write("...") → commitAsync → sealed world 확인
프로세스 kill → restart → restore → 기억 연속 확인
```

**검증:** 일기를 3개 쓴 후 프로세스 재시작 → 세 번째 일기의 회고가 첫 번째를 참조하는가?

### Phase 2: Post-Seal Anchor + Recall (하루)

```
sqlite-vector-store.ts 구현 (embedding + cosine similarity)
anchor.ts 구현 (post-seal indexer)
memory-recall.ts 구현 (vector search + getWorldSnapshot)
recall("...") → 과거 기억 복원 확인
rebuild.ts 구현 + 테스트 (vector store 삭제 → Lineage에서 재구축)
```

**검증:**
- 10개 일기 쓴 후 recall이 의미적으로 관련된 기억 반환하는가?
- vector store 삭제 → rebuild → 같은 recall 결과 나오는가?

### Phase 3: REPL + Legality 시연 (반나절)

```
interactive.ts — readline 기반 REPL
  > write 오늘 산책을 했다
  > recall 봄 산책
  > actions               (getAvailableActions)
  > whynot write          (whyNot — busy 상태에서)
  > snapshot
  > history
  > rebuild               (vector index 재구축)
  > quit
```

**검증:** legality API가 상태에 따라 정확히 동작하는가?

### Phase 4: 내구성 테스트 (반나절)

```
30개 일기 자동 생성 (다양한 주제/감정)
Snapshot 크기 ≤ 2KB 확인 (bounded 구조적 보증)
recall precision 측정
장기 lineage 순회 성능 확인
```

---

## 11. 기술 스택

| 구성요소 | 선택 | 이유 |
|----------|------|------|
| Runtime | `@manifesto-ai/sdk` + `@manifesto-ai/lineage` | Manifesto 코어 |
| Lineage Store | SQLite via `LineageStore` interface | persistent. source of truth는 Phase 1부터 영속 |
| LLM | Ollama gemma4:e4b | 로컬, 4090, 9B |
| Embedding | Ollama nomic-embed-text | 로컬, 경량 |
| Vector Store | SQLite + cosine similarity | 외부 의존성 0. derived cache |

**저장 우선순위:** Lineage(SQLite, persistent) > Vector(SQLite, derived, rebuildable) > Snapshot(runtime, bounded)

---

## 12. 성공 기준

| 기준 | 측정 방법 |
|------|----------|
| 기억 형성 | write → commitAsync → sealed world 생성 |
| 기억 참조 | LLM 회고가 recentWindow의 과거 경험을 참조 |
| 기억 검색 | recall이 의미적으로 관련된 과거를 top-5로 반환 |
| 기억 연속 | 프로세스 재시작 후 restore → Snapshot + Vector 모두 복원 |
| 인덱스 재구축 | vector store 삭제 → Lineage 순회로 완전 재구축 |
| Snapshot bounded | 30개 일기 후 Snapshot < 2KB (handler truncation 보증) |
| Legality 설명 | `getAvailableActions`, `whyNot`, `isIntentDispatchable` 동작 |
| Lineage 순수성 | write world만 vector index에 포함. recall world는 미포함 |

---

## 13. 이 프로젝트가 증명하는 것

### 13.1 Manifesto의 핵심 테제

**"영혼의 본질은 기억 + 맥락 + 선택의 연속이다"**
→ Lineage가 기억, Snapshot이 맥락, MEL action이 선택. 이 에이전트는 세 가지를 전부 가진다.

**"LLM as Effect Handler"**
→ gemma4는 `mind.reflect` effect의 handler일 뿐. MEL이 판단 구조를 소유하고, LLM은 비정형 세계를 정형 의미로 변환하는 IO bridge.

**"설명 가능한 세계 계약"**
→ `available when` + `dispatchable when`으로 "지금 왜 이 행동이 가능/불가능한지" 설명 가능. 이건 LLM에게도, 사람에게도, 다른 시스템에게도 읽힌다.

### 13.2 Coin Sapiens로의 길

이 에이전트가 동작하면, Coin Sapiens는:

| MemoryAgent | Coin Sapiens |
|-------------|-------------|
| `write(content)` | `observe(symbol)` |
| `mind.reflect` | `mind.think` |
| `recentWindow` | `marketContext` |
| `selfSummary` | `tradingPersonality` |
| `recall(query)` | `reviewHistory(pattern)` |
| post-seal anchor | post-seal market state anchor |

**구조는 같다.** 도메인 이름만 다르다.

---

*manifesto-memory-agent PRD v0.2.0*
