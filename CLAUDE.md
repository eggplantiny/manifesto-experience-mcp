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
- `OLLAMA_BASE_URL`
- `OLLAMA_EMBEDDING_MODEL`
- `MEMORY_AGENT_DATA_DIR`

권장 예시:

```bash
LLM_PROVIDER=ollama
LLM_MODEL=gemma3:4b-it-qat
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_EMBEDDING_MODEL=nomic-embed-text-v2-moe:latest
MEMORY_AGENT_DATA_DIR=/var/lib/manifesto-memory-agent
```

여러 Node 버전을 같이 쓰는 환경에서는 설치된 binary가 같은 prefix의 `node`를 우선 사용한다.
강제 override가 필요하면 `MANIFESTO_MEMORY_AGENT_NODE=/absolute/path/to/node`를 사용할 수 있다.

운영 권장 순서:
1. 절대 경로 `node` + 절대 경로 script
2. project-local install + local `node`
3. 전역 설치 binary

## 운영 전제

- shared/internal MCP는 trusted single-process 환경 전제
- SQLite data dir은 process 단독 사용 전제
- `.data/`는 로컬 실험 산출물 경로이며 git ignore 대상
