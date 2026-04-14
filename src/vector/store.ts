import type { MemoryAnchorRecord, MemorySearchHit, StrongPattern } from "../types.js";

export interface VectorStore {
  insert(record: MemoryAnchorRecord): Promise<void>;
  search(embedding: number[], limit: number): Promise<MemorySearchHit[]>;
  list(limit?: number): Promise<MemoryAnchorRecord[]>;
  get(worldId: string): Promise<MemoryAnchorRecord | null>;
  getAll(): Promise<MemoryAnchorRecord[]>;
  has(worldId: string): Promise<boolean>;
  updateStrength(worldId: string, delta: number): Promise<void>;
  decayAll(factor: number): Promise<void>;
  listStrongPatterns(threshold: number, limit?: number): Promise<StrongPattern[]>;
  clear(): Promise<void>;
  count(): Promise<number>;
  close(): void;
}
