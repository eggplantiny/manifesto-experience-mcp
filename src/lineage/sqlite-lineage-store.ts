import Database from "better-sqlite3";
import type { CoreSnapshot as Snapshot } from "@manifesto-ai/sdk";
import type {
  BranchId,
  LineageStore,
  PreparedLineageCommit,
  PreparedBranchMutation,
  SealAttempt,
  SnapshotHashInput,
  World,
  WorldEdge,
  WorldId,
} from "@manifesto-ai/lineage/provider";

type PersistedBranchEntry = Parameters<LineageStore["putBranch"]>[0];

type SqliteDatabase = ReturnType<typeof openDatabase>;

export class SQLiteLineageStore implements LineageStore {
  private readonly db: SqliteDatabase;

  constructor(private readonly filename: string) {
    this.db = openDatabase(filename);
    this.initialize();
  }

  async putWorld(world: World): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO worlds (world_id, schema_hash, snapshot_hash, parent_world_id, terminal_status)
          VALUES (@worldId, @schemaHash, @snapshotHash, @parentWorldId, @terminalStatus)
          ON CONFLICT(world_id) DO UPDATE SET
            schema_hash = excluded.schema_hash,
            snapshot_hash = excluded.snapshot_hash,
            parent_world_id = excluded.parent_world_id,
            terminal_status = excluded.terminal_status
        `,
      )
      .run({
        worldId: world.worldId,
        schemaHash: world.schemaHash,
        snapshotHash: world.snapshotHash,
        parentWorldId: world.parentWorldId,
        terminalStatus: world.terminalStatus,
      });
  }

  async getWorld(worldId: WorldId): Promise<World | null> {
    const row = this.db
      .prepare(
        `
          SELECT world_id, schema_hash, snapshot_hash, parent_world_id, terminal_status
          FROM worlds
          WHERE world_id = ?
        `,
      )
      .get(worldId) as
      | {
          world_id: string;
          schema_hash: string;
          snapshot_hash: string;
          parent_world_id: string | null;
          terminal_status: "completed" | "failed";
        }
      | undefined;

    if (!row) return null;

    return {
      worldId: row.world_id,
      schemaHash: row.schema_hash,
      snapshotHash: row.snapshot_hash,
      parentWorldId: row.parent_world_id,
      terminalStatus: row.terminal_status,
    };
  }

  async putSnapshot(worldId: WorldId, snapshot: Snapshot): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO snapshots (world_id, snapshot_json)
          VALUES (?, ?)
          ON CONFLICT(world_id) DO UPDATE SET snapshot_json = excluded.snapshot_json
        `,
      )
      .run(worldId, JSON.stringify(snapshot));
  }

  async getSnapshot(worldId: WorldId): Promise<Snapshot | null> {
    const row = this.db.prepare("SELECT snapshot_json FROM snapshots WHERE world_id = ?").get(worldId) as
      | { snapshot_json: string }
      | undefined;

    return row ? (JSON.parse(row.snapshot_json) as Snapshot) : null;
  }

  async putAttempt(attempt: SealAttempt): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO attempts (
            attempt_id,
            world_id,
            branch_id,
            base_world_id,
            parent_world_id,
            proposal_ref,
            decision_ref,
            created_at,
            trace_ref_json,
            patch_delta_json,
            reused
          )
          VALUES (
            @attemptId,
            @worldId,
            @branchId,
            @baseWorldId,
            @parentWorldId,
            @proposalRef,
            @decisionRef,
            @createdAt,
            @traceRefJson,
            @patchDeltaJson,
            @reused
          )
          ON CONFLICT(attempt_id) DO UPDATE SET
            world_id = excluded.world_id,
            branch_id = excluded.branch_id,
            base_world_id = excluded.base_world_id,
            parent_world_id = excluded.parent_world_id,
            proposal_ref = excluded.proposal_ref,
            decision_ref = excluded.decision_ref,
            created_at = excluded.created_at,
            trace_ref_json = excluded.trace_ref_json,
            patch_delta_json = excluded.patch_delta_json,
            reused = excluded.reused
        `,
      )
      .run(serializeAttempt(attempt));
  }

  async getAttempts(worldId: WorldId): Promise<readonly SealAttempt[]> {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM attempts
          WHERE world_id = ?
          ORDER BY created_at ASC, attempt_id ASC
        `,
      )
      .all(worldId) as AttemptRow[];

    return rows.map(deserializeAttempt);
  }

  async getAttemptsByBranch(branchId: BranchId): Promise<readonly SealAttempt[]> {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM attempts
          WHERE branch_id = ?
          ORDER BY created_at ASC, attempt_id ASC
        `,
      )
      .all(branchId) as AttemptRow[];

    return rows.map(deserializeAttempt);
  }

  async putHashInput(snapshotHash: string, input: SnapshotHashInput): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO hash_inputs (snapshot_hash, input_json)
          VALUES (?, ?)
          ON CONFLICT(snapshot_hash) DO UPDATE SET input_json = excluded.input_json
        `,
      )
      .run(snapshotHash, JSON.stringify(input));
  }

  async getHashInput(snapshotHash: string): Promise<SnapshotHashInput | null> {
    const row = this.db.prepare("SELECT input_json FROM hash_inputs WHERE snapshot_hash = ?").get(snapshotHash) as
      | { input_json: string }
      | undefined;

    return row ? (JSON.parse(row.input_json) as SnapshotHashInput) : null;
  }

  async putEdge(edge: WorldEdge): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO edges (edge_id, from_world_id, to_world_id)
          VALUES (?, ?, ?)
          ON CONFLICT(edge_id) DO UPDATE SET
            from_world_id = excluded.from_world_id,
            to_world_id = excluded.to_world_id
        `,
      )
      .run(edge.edgeId, edge.from, edge.to);
  }

  async getEdges(worldId: WorldId): Promise<readonly WorldEdge[]> {
    const rows = this.db
      .prepare(
        `
          SELECT edge_id, from_world_id, to_world_id
          FROM edges
          WHERE from_world_id = ? OR to_world_id = ?
          ORDER BY edge_id ASC
        `,
      )
      .all(worldId, worldId) as Array<{
      edge_id: string;
      from_world_id: string;
      to_world_id: string;
    }>;

    return rows.map((row) => ({
      edgeId: row.edge_id,
      from: row.from_world_id,
      to: row.to_world_id,
    }));
  }

  async getBranchHead(branchId: BranchId): Promise<WorldId | null> {
    const row = this.db.prepare("SELECT head FROM branches WHERE branch_id = ?").get(branchId) as { head: string } | undefined;
    return row?.head ?? null;
  }

  async getBranchTip(branchId: BranchId): Promise<WorldId | null> {
    const row = this.db.prepare("SELECT tip FROM branches WHERE branch_id = ?").get(branchId) as { tip: string } | undefined;
    return row?.tip ?? null;
  }

  async getBranchEpoch(branchId: BranchId): Promise<number> {
    const row = this.db.prepare("SELECT epoch FROM branches WHERE branch_id = ?").get(branchId) as { epoch: number } | undefined;
    if (!row) {
      throw new Error(`LIN-EPOCH-6 violation: unknown branch ${branchId}`);
    }

    return row.epoch;
  }

  async mutateBranch(mutation: PreparedBranchMutation): Promise<void> {
    const branch = this.readBranch(mutation.branchId);
    if (!branch) {
      throw new Error(`LIN-STORE-4 violation: unknown branch ${mutation.branchId}`);
    }

    if (
      branch.head !== mutation.expectedHead ||
      branch.tip !== mutation.expectedTip ||
      branch.epoch !== mutation.expectedEpoch
    ) {
      throw new Error(`LIN-STORE-4 violation: branch ${mutation.branchId} CAS mismatch`);
    }

    this.writeBranch({
      ...branch,
      head: mutation.nextHead,
      tip: mutation.nextTip,
      headAdvancedAt: mutation.headAdvancedAt ?? branch.headAdvancedAt,
      epoch: mutation.nextEpoch,
    });
  }

  async putBranch(branch: PersistedBranchEntry): Promise<void> {
    this.writeBranch(branch);
  }

  async getBranches(): Promise<readonly PersistedBranchEntry[]> {
    const rows = this.db
      .prepare(
        `
          SELECT branch_id, name, head, tip, head_advanced_at, epoch, schema_hash, created_at
          FROM branches
          ORDER BY created_at ASC, branch_id ASC
        `,
      )
      .all() as BranchRow[];

    return rows.map(deserializeBranch);
  }

  async getActiveBranchId(): Promise<BranchId | null> {
    const row = this.db.prepare("SELECT branch_id FROM active_branch WHERE singleton_id = 1").get() as
      | { branch_id: string | null }
      | undefined;

    return row?.branch_id ?? null;
  }

  async switchActiveBranch(sourceBranchId: BranchId, targetBranchId: BranchId): Promise<void> {
    if (sourceBranchId === targetBranchId) {
      throw new Error("LIN-SWITCH-5 violation: self-switch is not allowed");
    }

    const activeBranchId = await this.getActiveBranchId();
    if (activeBranchId !== sourceBranchId) {
      throw new Error("LIN-SWITCH-1 violation: source branch is not active");
    }

    const sourceBranch = this.readBranch(sourceBranchId);
    const targetBranch = this.readBranch(targetBranchId);

    if (!sourceBranch) {
      throw new Error(`LIN-SWITCH-3 violation: missing source branch ${sourceBranchId}`);
    }

    if (!targetBranch) {
      throw new Error(`LIN-SWITCH-3 violation: missing target branch ${targetBranchId}`);
    }

    const transaction = this.db.transaction(() => {
      this.writeBranch({
        ...sourceBranch,
        epoch: sourceBranch.epoch + 1,
      });
      this.setActiveBranchId(targetBranchId);
    });

    transaction();
  }

  async commitPrepared(prepared: PreparedLineageCommit): Promise<void> {
    const transaction = this.db.transaction(() => {
      const branches = new Map(this.readAllBranches().map((branch) => [branch.id, branch]));
      let activeBranchId = this.readActiveBranchId();

      if (prepared.branchChange.kind === "bootstrap") {
        if (branches.size !== 0) {
          throw new Error("LIN-GENESIS-3 violation: genesis requires an empty branch store");
        }

        if (activeBranchId !== null) {
          throw new Error("LIN-GENESIS-3 violation: active branch must be empty before genesis bootstrap");
        }

        if (branches.has(prepared.branchChange.branch.id)) {
          throw new Error(`LIN-GENESIS-3 violation: branch ${prepared.branchChange.branch.id} already exists`);
        }

        branches.set(prepared.branchChange.branch.id, prepared.branchChange.branch);
        activeBranchId = prepared.branchChange.activeBranchId;
      } else {
        const currentBranch = branches.get(prepared.branchChange.branchId);
        if (!currentBranch) {
          throw new Error(`LIN-STORE-7 violation: missing branch ${prepared.branchChange.branchId} for prepared commit`);
        }

        if (
          currentBranch.head !== prepared.branchChange.expectedHead ||
          currentBranch.tip !== prepared.branchChange.expectedTip ||
          currentBranch.epoch !== prepared.branchChange.expectedEpoch
        ) {
          throw new Error(`LIN-STORE-4 violation: branch ${prepared.branchChange.branchId} CAS mismatch`);
        }

        branches.set(prepared.branchChange.branchId, {
          ...currentBranch,
          head: prepared.branchChange.nextHead,
          tip: prepared.branchChange.nextTip,
          headAdvancedAt: prepared.branchChange.headAdvancedAt ?? currentBranch.headAdvancedAt,
          epoch: prepared.branchChange.nextEpoch,
        });
      }

      const existingWorld = this.readWorld(prepared.worldId);
      const reused = existingWorld !== null;

      if (reused) {
        if (existingWorld.parentWorldId !== prepared.world.parentWorldId) {
          throw new Error(`LIN-STORE-9 violation: world ${prepared.worldId} exists with a different parent`);
        }

        if (prepared.kind === "next" && !this.hasEdge(prepared.edge.edgeId)) {
          throw new Error(`LIN-STORE-9 violation: reuse world ${prepared.worldId} is missing edge ${prepared.edge.edgeId}`);
        }
      } else {
        this.putWorldSync(prepared.world);
        this.putSnapshotSync(prepared.worldId, prepared.terminalSnapshot);
        this.putHashInputSync(prepared.world.snapshotHash, prepared.hashInput);
        if (prepared.kind === "next") {
          this.putEdgeSync(prepared.edge);
        }
      }

      this.putAttemptSync({
        ...prepared.attempt,
        reused,
      });

      this.db.prepare("DELETE FROM branches").run();
      for (const branch of branches.values()) {
        this.writeBranch(branch);
      }
      this.setActiveBranchId(activeBranchId);
    });

    transaction();
  }

  listWorlds(): World[] {
    const rows = this.db
      .prepare(
        `
          SELECT world_id, schema_hash, snapshot_hash, parent_world_id, terminal_status
          FROM worlds
        `,
      )
      .all() as Array<{
      world_id: string;
      schema_hash: string;
      snapshot_hash: string;
      parent_world_id: string | null;
      terminal_status: "completed" | "failed";
    }>;

    return rows.map((row) => ({
      worldId: row.world_id,
      schemaHash: row.schema_hash,
      snapshotHash: row.snapshot_hash,
      parentWorldId: row.parent_world_id,
      terminalStatus: row.terminal_status,
    }));
  }

  listEdges(): WorldEdge[] {
    const rows = this.db
      .prepare(
        `
          SELECT edge_id, from_world_id, to_world_id
          FROM edges
        `,
      )
      .all() as Array<{
      edge_id: string;
      from_world_id: string;
      to_world_id: string;
    }>;

    return rows.map((row) => ({
      edgeId: row.edge_id,
      from: row.from_world_id,
      to: row.to_world_id,
    }));
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worlds (
        world_id TEXT PRIMARY KEY,
        schema_hash TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        parent_world_id TEXT,
        terminal_status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        world_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hash_inputs (
        snapshot_hash TEXT PRIMARY KEY,
        input_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS edges (
        edge_id TEXT PRIMARY KEY,
        from_world_id TEXT NOT NULL,
        to_world_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        base_world_id TEXT,
        parent_world_id TEXT,
        proposal_ref TEXT,
        decision_ref TEXT,
        created_at INTEGER NOT NULL,
        trace_ref_json TEXT,
        patch_delta_json TEXT,
        reused INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_world_id ON attempts(world_id, created_at, attempt_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_branch_id ON attempts(branch_id, created_at, attempt_id);
      CREATE TABLE IF NOT EXISTS branches (
        branch_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        head TEXT NOT NULL,
        tip TEXT NOT NULL,
        head_advanced_at INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        schema_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_branch (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        branch_id TEXT
      );
      INSERT OR IGNORE INTO active_branch (singleton_id, branch_id) VALUES (1, NULL);
    `);
  }

  private putWorldSync(world: World): void {
    this.db
      .prepare(
        `
          INSERT INTO worlds (world_id, schema_hash, snapshot_hash, parent_world_id, terminal_status)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(world_id) DO UPDATE SET
            schema_hash = excluded.schema_hash,
            snapshot_hash = excluded.snapshot_hash,
            parent_world_id = excluded.parent_world_id,
            terminal_status = excluded.terminal_status
        `,
      )
      .run(world.worldId, world.schemaHash, world.snapshotHash, world.parentWorldId, world.terminalStatus);
  }

  private putSnapshotSync(worldId: WorldId, snapshot: Snapshot): void {
    this.db
      .prepare(
        `
          INSERT INTO snapshots (world_id, snapshot_json)
          VALUES (?, ?)
          ON CONFLICT(world_id) DO UPDATE SET snapshot_json = excluded.snapshot_json
        `,
      )
      .run(worldId, JSON.stringify(snapshot));
  }

  private putHashInputSync(snapshotHash: string, input: SnapshotHashInput): void {
    this.db
      .prepare(
        `
          INSERT INTO hash_inputs (snapshot_hash, input_json)
          VALUES (?, ?)
          ON CONFLICT(snapshot_hash) DO UPDATE SET input_json = excluded.input_json
        `,
      )
      .run(snapshotHash, JSON.stringify(input));
  }

  private putEdgeSync(edge: WorldEdge): void {
    this.db
      .prepare(
        `
          INSERT INTO edges (edge_id, from_world_id, to_world_id)
          VALUES (?, ?, ?)
          ON CONFLICT(edge_id) DO UPDATE SET
            from_world_id = excluded.from_world_id,
            to_world_id = excluded.to_world_id
        `,
      )
      .run(edge.edgeId, edge.from, edge.to);
  }

  private putAttemptSync(attempt: SealAttempt): void {
    this.db
      .prepare(
        `
          INSERT INTO attempts (
            attempt_id,
            world_id,
            branch_id,
            base_world_id,
            parent_world_id,
            proposal_ref,
            decision_ref,
            created_at,
            trace_ref_json,
            patch_delta_json,
            reused
          )
          VALUES (
            @attemptId,
            @worldId,
            @branchId,
            @baseWorldId,
            @parentWorldId,
            @proposalRef,
            @decisionRef,
            @createdAt,
            @traceRefJson,
            @patchDeltaJson,
            @reused
          )
          ON CONFLICT(attempt_id) DO UPDATE SET
            world_id = excluded.world_id,
            branch_id = excluded.branch_id,
            base_world_id = excluded.base_world_id,
            parent_world_id = excluded.parent_world_id,
            proposal_ref = excluded.proposal_ref,
            decision_ref = excluded.decision_ref,
            created_at = excluded.created_at,
            trace_ref_json = excluded.trace_ref_json,
            patch_delta_json = excluded.patch_delta_json,
            reused = excluded.reused
        `,
      )
      .run(serializeAttempt(attempt));
  }

  private readWorld(worldId: WorldId): World | null {
    const row = this.db
      .prepare(
        `
          SELECT world_id, schema_hash, snapshot_hash, parent_world_id, terminal_status
          FROM worlds
          WHERE world_id = ?
        `,
      )
      .get(worldId) as
      | {
          world_id: string;
          schema_hash: string;
          snapshot_hash: string;
          parent_world_id: string | null;
          terminal_status: "completed" | "failed";
        }
      | undefined;

    return row
      ? {
          worldId: row.world_id,
          schemaHash: row.schema_hash,
          snapshotHash: row.snapshot_hash,
          parentWorldId: row.parent_world_id,
          terminalStatus: row.terminal_status,
        }
      : null;
  }

  private hasEdge(edgeId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS value FROM edges WHERE edge_id = ?").get(edgeId) as { value: number } | undefined;
    return Boolean(row);
  }

  private readBranch(branchId: BranchId): PersistedBranchEntry | null {
    const row = this.db
      .prepare(
        `
          SELECT branch_id, name, head, tip, head_advanced_at, epoch, schema_hash, created_at
          FROM branches
          WHERE branch_id = ?
        `,
      )
      .get(branchId) as BranchRow | undefined;

    return row ? deserializeBranch(row) : null;
  }

  private readAllBranches(): PersistedBranchEntry[] {
    const rows = this.db
      .prepare(
        `
          SELECT branch_id, name, head, tip, head_advanced_at, epoch, schema_hash, created_at
          FROM branches
          ORDER BY created_at ASC, branch_id ASC
        `,
      )
      .all() as BranchRow[];

    return rows.map(deserializeBranch);
  }

  private readActiveBranchId(): BranchId | null {
    const row = this.db.prepare("SELECT branch_id FROM active_branch WHERE singleton_id = 1").get() as
      | { branch_id: string | null }
      | undefined;

    return row?.branch_id ?? null;
  }

  private setActiveBranchId(branchId: BranchId | null): void {
    this.db
      .prepare(
        `
          INSERT INTO active_branch (singleton_id, branch_id)
          VALUES (1, ?)
          ON CONFLICT(singleton_id) DO UPDATE SET branch_id = excluded.branch_id
        `,
      )
      .run(branchId);
  }

  private writeBranch(branch: PersistedBranchEntry): void {
    this.db
      .prepare(
        `
          INSERT INTO branches (branch_id, name, head, tip, head_advanced_at, epoch, schema_hash, created_at)
          VALUES (@branchId, @name, @head, @tip, @headAdvancedAt, @epoch, @schemaHash, @createdAt)
          ON CONFLICT(branch_id) DO UPDATE SET
            name = excluded.name,
            head = excluded.head,
            tip = excluded.tip,
            head_advanced_at = excluded.head_advanced_at,
            epoch = excluded.epoch,
            schema_hash = excluded.schema_hash,
            created_at = excluded.created_at
        `,
      )
      .run({
        branchId: branch.id,
        name: branch.name,
        head: branch.head,
        tip: branch.tip,
        headAdvancedAt: branch.headAdvancedAt,
        epoch: branch.epoch,
        schemaHash: branch.schemaHash,
        createdAt: branch.createdAt,
      });
  }
}

type BranchRow = {
  branch_id: string;
  name: string;
  head: string;
  tip: string;
  head_advanced_at: number;
  epoch: number;
  schema_hash: string;
  created_at: number;
};

type AttemptRow = {
  attempt_id: string;
  world_id: string;
  branch_id: string;
  base_world_id: string | null;
  parent_world_id: string | null;
  proposal_ref: string | null;
  decision_ref: string | null;
  created_at: number;
  trace_ref_json: string | null;
  patch_delta_json: string | null;
  reused: number;
};

function openDatabase(filename: string) {
  return new Database(filename);
}

function deserializeBranch(row: BranchRow): PersistedBranchEntry {
  return {
    id: row.branch_id,
    name: row.name,
    head: row.head,
    tip: row.tip,
    headAdvancedAt: row.head_advanced_at,
    epoch: row.epoch,
    schemaHash: row.schema_hash,
    createdAt: row.created_at,
  };
}

function serializeAttempt(attempt: SealAttempt) {
  return {
    attemptId: attempt.attemptId,
    worldId: attempt.worldId,
    branchId: attempt.branchId,
    baseWorldId: attempt.baseWorldId,
    parentWorldId: attempt.parentWorldId,
    proposalRef: attempt.proposalRef ?? null,
    decisionRef: "decisionRef" in attempt ? attempt.decisionRef ?? null : null,
    createdAt: attempt.createdAt,
    traceRefJson: attempt.traceRef ? JSON.stringify(attempt.traceRef) : null,
    patchDeltaJson: attempt.patchDelta ? JSON.stringify(attempt.patchDelta) : null,
    reused: attempt.reused ? 1 : 0,
  };
}

function deserializeAttempt(row: AttemptRow): SealAttempt {
  return {
    attemptId: row.attempt_id,
    worldId: row.world_id,
    branchId: row.branch_id,
    baseWorldId: row.base_world_id,
    parentWorldId: row.parent_world_id,
    proposalRef: row.proposal_ref ?? undefined,
    ...(row.decision_ref ? { decisionRef: row.decision_ref } : {}),
    createdAt: row.created_at,
    ...(row.trace_ref_json ? { traceRef: JSON.parse(row.trace_ref_json) } : {}),
    ...(row.patch_delta_json ? { patchDelta: JSON.parse(row.patch_delta_json) } : {}),
    reused: row.reused === 1,
  };
}
