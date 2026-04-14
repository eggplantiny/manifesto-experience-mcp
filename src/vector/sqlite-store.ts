import Database from "better-sqlite3";

import type { MemoryAnchorRecord, MemorySearchHit, StrongPattern } from "../types.js";
import type { VectorStore } from "./store.js";

type SqliteDatabase = ReturnType<typeof openDatabase>;

type AnchorRow = {
  world_id: string;
  embedding_json: string;
  summary: string;
  mood: string;
  timestamp: string;
  strength: number;
};

export class SQLiteVectorStore implements VectorStore {
  private readonly db: SqliteDatabase;

  constructor(private readonly filename: string) {
    this.db = openDatabase(filename);
    this.initialize();
  }

  async insert(record: MemoryAnchorRecord): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO memory_anchors (world_id, embedding_json, summary, mood, timestamp, strength)
          VALUES (@worldId, @embeddingJson, @summary, @mood, @timestamp, @strength)
          ON CONFLICT(world_id) DO UPDATE SET
            embedding_json = excluded.embedding_json,
            summary = excluded.summary,
            mood = excluded.mood,
            timestamp = excluded.timestamp,
            strength = excluded.strength
        `,
      )
      .run({
        worldId: record.worldId,
        embeddingJson: JSON.stringify(record.embedding),
        summary: record.summary,
        mood: record.mood,
        timestamp: record.timestamp,
        strength: record.strength,
      });
  }

  async search(embedding: number[], limit: number): Promise<MemorySearchHit[]> {
    const rows = this.db
      .prepare(
        `
          SELECT world_id, embedding_json, summary, mood, timestamp, strength
          FROM memory_anchors
          WHERE strength > 0
        `,
      )
      .all() as AnchorRow[];

    return rows
      .map((row) => {
        const record = rowToRecord(row);
        const similarity = cosineSimilarity(embedding, record.embedding);
        return {
          ...record,
          score: similarity * record.strength,
        } satisfies MemorySearchHit;
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  async list(limit = 10): Promise<MemoryAnchorRecord[]> {
    const rows = this.db
      .prepare(
        `
          SELECT world_id, embedding_json, summary, mood, timestamp, strength
          FROM memory_anchors
          ORDER BY timestamp DESC, world_id DESC
          LIMIT ?
        `,
      )
      .all(limit) as AnchorRow[];

    return rows.map(rowToRecord);
  }

  async get(worldId: string): Promise<MemoryAnchorRecord | null> {
    const row = this.db
      .prepare(
        `
          SELECT world_id, embedding_json, summary, mood, timestamp, strength
          FROM memory_anchors
          WHERE world_id = ?
          LIMIT 1
        `,
      )
      .get(worldId) as AnchorRow | undefined;

    return row ? rowToRecord(row) : null;
  }

  async getAll(): Promise<MemoryAnchorRecord[]> {
    const rows = this.db
      .prepare(
        `
          SELECT world_id, embedding_json, summary, mood, timestamp, strength
          FROM memory_anchors
          ORDER BY timestamp DESC, world_id DESC
        `,
      )
      .all() as AnchorRow[];

    return rows.map(rowToRecord);
  }

  async has(worldId: string): Promise<boolean> {
    const row = this.db
      .prepare(
        `
          SELECT 1 AS present
          FROM memory_anchors
          WHERE world_id = ?
          LIMIT 1
        `,
      )
      .get(worldId) as { present: number } | undefined;

    return Boolean(row?.present);
  }

  async updateStrength(worldId: string, delta: number): Promise<void> {
    this.db
      .prepare(
        `
          UPDATE memory_anchors
          SET strength = strength + ?
          WHERE world_id = ?
        `,
      )
      .run(delta, worldId);
  }

  async decayAll(factor: number): Promise<void> {
    this.db
      .prepare(
        `
          UPDATE memory_anchors
          SET strength = strength * ?
        `,
      )
      .run(factor);
  }

  async listStrongPatterns(threshold: number, limit = 100): Promise<StrongPattern[]> {
    const rows = this.db
      .prepare(
        `
          SELECT world_id, summary, strength
          FROM memory_anchors
          WHERE strength >= ?
            AND strength > 0
          ORDER BY strength DESC, timestamp DESC, world_id DESC
          LIMIT ?
        `,
      )
      .all(threshold, limit) as Array<{
      world_id: string;
      summary: string;
      strength: number;
    }>;

    return rows.map((row) => ({
      worldId: row.world_id,
      pattern: row.summary,
      strength: row.strength,
    }));
  }

  async clear(): Promise<void> {
    this.db.prepare("DELETE FROM memory_anchors").run();
  }

  async count(): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM memory_anchors").get() as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_anchors (
        world_id TEXT PRIMARY KEY,
        embedding_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        mood TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 1.0
      );
    `);

    const columns = this.db.prepare("PRAGMA table_info(memory_anchors)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "strength")) {
      this.db.prepare("ALTER TABLE memory_anchors ADD COLUMN strength REAL NOT NULL DEFAULT 1.0").run();
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_anchors_timestamp ON memory_anchors(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_anchors_strength ON memory_anchors(strength DESC);
    `);
  }
}

function openDatabase(filename: string) {
  return new Database(filename);
}

function rowToRecord(row: AnchorRow): MemoryAnchorRecord {
  return {
    worldId: row.world_id,
    embedding: JSON.parse(row.embedding_json) as number[],
    summary: row.summary,
    mood: row.mood,
    timestamp: row.timestamp,
    strength: row.strength,
  };
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return -1;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return -1;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
