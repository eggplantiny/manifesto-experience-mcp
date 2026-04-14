# manifesto-memory-agent

Manifesto 기반 pheromone memory protocol이다. 라이브러리, CLI, MCP server 세 형태로 배포할 수 있다.

기본 권장 모델:
- `gemma3:4b-it-qat`
- `nomic-embed-text-v2-moe:latest`

## 준비

Ollama 모델:

```bash
ollama pull gemma3:4b-it-qat
ollama pull nomic-embed-text-v2-moe:latest
```

개발 빌드:

```bash
pnpm install
pnpm build
```

## 1. 라이브러리로 사용

```ts
import { createMemoryAgent } from "manifesto-memory-agent";

const agent = await createMemoryAgent({
  dataDir: ".manifesto-memory-agent",
  providerKind: "ollama",
});

await agent.write("BTC/USDT RSI 74에서 매도했다. 과매수 구간 판단.");
const hits = await agent.recall("비트코인 과매수", 3);
await agent.recordOutcome(hits[0]?.worldId ?? "", "success");
await agent.consolidate();
```

주요 API:
- `write(content)`
- `recordOutcome(actionWorldId, outcome)`
- `consolidate()`
- `recall(query, budget)`
- `refineRecall()`
- `endRecall()`
- `getSnapshot()`
- `getHistory(limit?)`
- `getWorldSnapshot(worldId)`
- `rebuildIndex()`

## 2. CLI로 사용

repo에서 바로 실행:

```bash
pnpm repl
```

패키지 설치 후 실행:

```bash
manifesto-memory-agent
```

주요 명령:
- `write <text>`
- `outcome <worldId> <success|failure>`
- `consolidate`
- `recall <budget> <query>`
- `refine`
- `end`
- `configure <windowSize> <maxBudget> <summaryMaxLen> <reflectionMaxLen> <decayFactor> <crystallizeThreshold> <reinforceSuccess> <reinforceFailure>`
- `actions`
- `snapshot`
- `history`
- `world <worldId>`
- `rebuild`
- `whynot ...`

CLI는 `MEMORY_AGENT_DATA_DIR`, `LLM_PROVIDER`, `LLM_MODEL`, `OLLAMA_EMBEDDING_MODEL` 환경변수를 읽는다.

## 3. 로컬 dev MCP로 사용

repo에서 직접 실행:

```bash
pnpm build
pnpm mcp
```

저장소 루트의 [.mcp.json](/home/eggp/dev/workspaces/eggp/manifesto-memory-agent/.mcp.json)은 로컬 개발용 예시다.

현재 기본 env:
- `LLM_PROVIDER=ollama`
- `LLM_MODEL=gemma3:4b-it-qat`
- `OLLAMA_BASE_URL=http://127.0.0.1:11434`
- `OLLAMA_EMBEDDING_MODEL=nomic-embed-text-v2-moe:latest`
- `MEMORY_AGENT_DATA_DIR=./.data/mcp`

MCP tool surface:
- `commit`
- `get_snapshot`
- `get_available_actions`
- `get_history`
- `get_world_snapshot`
- `simulate`

## 4. 공유/internal MCP로 사용

trusted single-process 환경 기준 권장 실행:

```bash
LLM_PROVIDER=ollama \
LLM_MODEL=gemma3:4b-it-qat \
OLLAMA_BASE_URL=http://ollama.internal:11434 \
OLLAMA_EMBEDDING_MODEL=nomic-embed-text-v2-moe:latest \
MEMORY_AGENT_DATA_DIR=/var/lib/manifesto-memory-agent \
manifesto-memory-agent-mcp
```

운영 전제:
- 프로세스 1개당 data dir 1개
- SQLite 파일은 해당 process가 단독으로 사용
- 인증/멀티테넌시는 이번 패키지 범위에 포함되지 않음
- shared MCP는 내부 trusted 환경 전제

## 5. npm/bin 패키지로 설치

npm 레지스트리에서 직접 설치:

```bash
npm install -g manifesto-memory-agent
```

설치 없이 일회성 실행:

```bash
npx manifesto-memory-agent-mcp
```

로컬 검증이나 pre-publish 확인이 필요하면 tarball 경로도 사용할 수 있다:

```bash
pnpm pack
npm install -g ./manifesto-memory-agent-0.5.2.tgz
```

GitHub Actions 수동 npm 배포:
- workflow: `.github/workflows/npm-publish.yml`
- trigger: `workflow_dispatch`
- required secret: `NPM_TOKEN`
- inputs:
  - `npm_tag`: 기본 `latest`
  - `dry_run`: 기본 `true`

권장 순서:
1. 먼저 `dry_run=true`로 실행
2. tarball artifact 확인
3. 같은 ref에서 `dry_run=false`로 재실행

설치 후 사용 가능한 binary:
- `manifesto-memory-agent`
- `manifesto-memory-agent-mcp`

전역 설치된 binary는 가능하면 같은 설치 prefix의 `node`를 우선 사용한다.
즉 `nvm`으로 여러 Node 버전을 같이 두는 환경에서도, 패키지를 설치한 prefix의 `node`를 먼저 잡도록 wrapper를 넣었다.

강제로 특정 `node`를 쓰고 싶으면:

```bash
MANIFESTO_MEMORY_AGENT_NODE=/absolute/path/to/node manifesto-memory-agent-mcp
```

설치 후 MCP 예시:

```json
{
  "mcpServers": {
    "memory-agent": {
      "command": "manifesto-memory-agent-mcp",
      "env": {
        "LLM_PROVIDER": "ollama",
        "LLM_MODEL": "gemma3:4b-it-qat",
        "OLLAMA_BASE_URL": "http://127.0.0.1:11434",
        "OLLAMA_EMBEDDING_MODEL": "nomic-embed-text-v2-moe:latest",
        "MEMORY_AGENT_DATA_DIR": "/tmp/manifesto-memory-agent"
      }
    }
  }
}
```

## 6. 데이터 디렉토리

기본 라이브러리 data dir은 `.manifesto-memory-agent`다.

개발 실험 데이터는 `.data/` 아래에 남는다:
- `.data/test-*.db`
- `.data/experiments/*`

`.data/`는 git ignore 대상이다. 배포 산출물에는 포함되지 않는다.

## 7. 검증

현재 검증된 E2E 경로:

```bash
MEMORY_AGENT_TEST_MODEL='gemma3:4b-it-qat' \
OLLAMA_EMBEDDING_MODEL='nomic-embed-text-v2-moe:latest' \
pnpm test:pheromone:e2e
```

실험 아티팩트는 `.data/experiments/<runId>/` 아래에 남는다.
