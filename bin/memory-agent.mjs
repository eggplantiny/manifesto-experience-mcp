#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { createMemoryAgent } from "../dist/index.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const serverVersion = packageJson.version ?? "0.0.0";

const agent = await createMemoryAgent({
  dataDir: process.env.MEMORY_AGENT_DATA_DIR,
  providerKind: normalizeProviderKind(process.env.LLM_PROVIDER),
});

const tools = [
  {
    name: "commit",
    description: "Commit a MemoryAgent action: write, recordOutcome, consolidate, recall, refineRecall, endRecall, configure.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        input: { type: "object" }
      },
      required: ["action"]
    }
  },
  {
    name: "get_snapshot",
    description: "Return the current MemoryAgent snapshot.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_available_actions",
    description: "Return currently available MemoryAgent actions.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_history",
    description: "Return anchored memory history.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" }
      }
    }
  },
  {
    name: "get_world_snapshot",
    description: "Return the canonical snapshot for a specific worldId.",
    inputSchema: {
      type: "object",
      properties: {
        worldId: { type: "string" }
      },
      required: ["worldId"]
    }
  },
  {
    name: "simulate",
    description: "Simulate a MemoryAgent action without committing.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        input: { type: "object" }
      },
      required: ["action"]
    }
  }
];

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain().catch((error) => {
    writeMessage({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: {
        level: "error",
        data: formatError(error),
      },
    });
  });
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function drain() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = buffer.slice(0, headerEnd).toString("utf8");
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) {
      buffer = Buffer.alloc(0);
      return;
    }

    const contentLength = Number(lengthMatch[1]);
    const messageEnd = headerEnd + 4 + contentLength;
    if (buffer.length < messageEnd) return;

    const body = buffer.slice(headerEnd + 4, messageEnd).toString("utf8");
    buffer = buffer.slice(messageEnd);

    const message = JSON.parse(body);
    await handleMessage(message);
  }
}

async function handleMessage(message) {
  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "manifesto-memory-agent",
          version: serverVersion
        }
      });
      return;
    case "notifications/initialized":
      return;
    case "ping":
      respond(message.id, {});
      return;
    case "tools/list":
      respond(message.id, { tools });
      return;
    case "tools/call": {
      try {
        const result = await callTool(message.params?.name, message.params?.arguments ?? {});
        respond(message.id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ],
          structuredContent: result
        });
      } catch (error) {
        respond(message.id, {
          content: [
            {
              type: "text",
              text: formatError(error)
            }
          ],
          structuredContent: { error: formatError(error) },
          isError: true
        });
      }
      return;
    }
    default:
      if (message.id !== undefined) {
        writeMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `Method not found: ${message.method}`
          }
        });
      }
  }
}

async function callTool(name, args) {
  switch (name) {
    case "commit":
      return callCommit(args.action, args.input ?? {});
    case "get_snapshot":
      return agent.getSnapshot();
    case "get_available_actions":
      return agent.getAvailableActions();
    case "get_history":
      return agent.getHistory(typeof args.limit === "number" ? args.limit : undefined);
    case "get_world_snapshot":
      return agent.getWorldSnapshot(String(args.worldId ?? ""));
    case "simulate":
      return simulateAction(args.action, args.input ?? {});
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function callCommit(action, input) {
  switch (action) {
    case "write":
      return agent.write(String(input.content ?? ""));
    case "recordOutcome":
      return agent.recordOutcome(String(input.actionWorldId ?? ""), String(input.outcome ?? ""));
    case "consolidate":
      return agent.consolidate();
    case "recall":
      return agent.recall(String(input.query ?? ""), Number(input.budget ?? 0));
    case "refineRecall":
      return agent.refineRecall();
    case "endRecall":
      await agent.endRecall();
      return { ok: true };
    case "configure":
      await agent.configure(normalizeConfig(input));
      return { ok: true };
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function simulateAction(action, input) {
  switch (action) {
    case "write":
      return agent.runtime.simulate(agent.runtime.MEL.actions.write, String(input.content ?? ""));
    case "recordOutcome":
      return agent.runtime.simulate(
        agent.runtime.MEL.actions.recordOutcome,
        String(input.actionWorldId ?? ""),
        String(input.outcome ?? ""),
      );
    case "consolidate":
      return agent.runtime.simulate(agent.runtime.MEL.actions.consolidate);
    case "recall":
      return agent.runtime.simulate(agent.runtime.MEL.actions.recall, String(input.query ?? ""), Number(input.budget ?? 0));
    case "refineRecall":
      return agent.runtime.simulate(agent.runtime.MEL.actions.refineRecall);
    case "endRecall":
      return agent.runtime.simulate(agent.runtime.MEL.actions.endRecall);
    case "configure":
      return agent.runtime.simulate(agent.runtime.MEL.actions.configure, normalizeConfig(input));
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function normalizeConfig(input) {
  return {
    windowSize: Number(input.windowSize ?? 0),
    maxBudget: Number(input.maxBudget ?? 0),
    summaryMaxLen: Number(input.summaryMaxLen ?? 0),
    reflectionMaxLen: Number(input.reflectionMaxLen ?? 0),
    decayFactor: Number(input.decayFactor ?? 0),
    crystallizeThreshold: Number(input.crystallizeThreshold ?? 0),
    reinforceSuccess: Number(input.reinforceSuccess ?? 0),
    reinforceFailure: Number(input.reinforceFailure ?? 0),
  };
}

function respond(id, result) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result
  });
}

function writeMessage(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

function normalizeProviderKind(value) {
  return value === "openai" || value === "anthropic" || value === "ollama" ? value : undefined;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function shutdown() {
  agent.dispose();
}
