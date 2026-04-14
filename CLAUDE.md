# manifesto-memory-agent 배포/사용 메모

## 권장 모델

- `gemma3:4b-it-qat`
- `nomic-embed-text-v2-moe:latest`

## 로컬 개발

```bash
pnpm build
pnpm repl
pnpm mcp
```

## 설치 후 binary

- `manifesto-memory-agent`
- `manifesto-memory-agent-mcp`

## MCP tools

- `commit`
- `get_snapshot`
- `get_available_actions`
- `get_history`
- `get_world_snapshot`
- `simulate`

`commit.action` 지원 값:
- `write`
- `recordOutcome`
- `consolidate`
- `recall`
- `refineRecall`
- `endRecall`
- `configure`

## 운영 환경 변수

- `LLM_PROVIDER`
- `LLM_MODEL`
- `OLLAMA_EMBEDDING_MODEL`
- `MEMORY_AGENT_DATA_DIR`

권장 예시:

```bash
LLM_PROVIDER=ollama
LLM_MODEL=gemma3:4b-it-qat
OLLAMA_EMBEDDING_MODEL=nomic-embed-text-v2-moe:latest
MEMORY_AGENT_DATA_DIR=/var/lib/manifesto-memory-agent
```

## 운영 전제

- shared/internal MCP는 trusted single-process 환경 전제
- SQLite data dir은 process 단독 사용 전제
- `.data/`는 로컬 실험 산출물 경로이며 git ignore 대상
