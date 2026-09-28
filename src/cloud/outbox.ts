// What the link keeps on disk under `jobs/.cloud/` so nothing is lost while the cloud is unreachable or the server
// restarts: the event outbox (`outbox.jsonl` + `state.json`), the command ledger (`commands.json`: ids handled, results
// not yet acknowledged, a few cached results for retries) and the ingress ledger (`ingress.json`: hosted-ingress
// deliveries already processed and their acknowledgements).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nowIso, readJsonFileOr, writeJsonFile } from "../util.js";
import type { CloudEventType, CommandResult, EventEnvelope, IngressAck } from "./protocol.js";

export function cloudStateDir(jobsDir: string): string {
  return path.join(jobsDir, ".cloud");
}

interface OutboxState {
  seq: number;
  acked_through: number;
  dropped_total: number;
}

const OUTBOX_MAX_FILE_BYTES = 32 * 1024 * 1024;
const COMPACT_EVERY = 500;

/** Durable events waiting for the cloud's acknowledgement, in order; the oldest are dropped past `maxEvents`. */
export class Outbox {
  readonly dir: string;
  private readonly file: string;
  private readonly stateFile: string;
  private state: OutboxState = { seq: 0, acked_through: 0, dropped_total: 0 };
  private entries: EventEnvelope[] = [];
  private sinceCompaction = 0;
  private loaded = false;

  constructor(
    jobsDir: string,
    private readonly options: () => { maxEvents: number },
  ) {
    this.dir = cloudStateDir(jobsDir);
    this.file = path.join(this.dir, "outbox.jsonl");
    this.stateFile = path.join(this.dir, "state.json");
  }

  /** Reads the files once; a torn last line (a crash mid-write) is ignored. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const state = readJsonFileOr<Partial<OutboxState>>(this.stateFile, {});
    this.state = { seq: Number(state.seq) || 0, acked_through: Number(state.acked_through) || 0, dropped_total: Number(state.dropped_total) || 0 };
    this.entries = [];
    if (!existsSync(this.file)) return;
    const text = readFileSync(this.file, "utf8");
    const lines = text.split("\n");
    if (!text.endsWith("\n")) lines.pop(); // torn
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as EventEnvelope;
        if (typeof entry.seq === "number" && entry.seq > this.state.acked_through) this.entries.push(entry);
        if (typeof entry.seq === "number" && entry.seq > this.state.seq) this.state.seq = entry.seq;
      } catch {
        /* skip a corrupt line */
      }
    }
    this.enforceLimit();
  }

  private persistState(): void {
    mkdirSync(this.dir, { recursive: true });
    writeJsonFile(this.stateFile, this.state);
  }

  private enforceLimit(): void {
    const max = Math.max(1, this.options().maxEvents);
    if (this.entries.length <= max) return;
    const dropped = this.entries.splice(0, this.entries.length - max);
    this.state.dropped_total += dropped.length;
    this.sinceCompaction += dropped.length;
  }

  append(machineId: string, type: CloudEventType, data: unknown): EventEnvelope {
    this.load();
    const seq = ++this.state.seq;
    const envelope: EventEnvelope = { id: `${machineId}:${seq}`, seq, ts: nowIso(), machine_id: machineId, type, data };
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.file)) writeFileSync(this.file, "", { mode: 0o600 });
    appendFileSync(this.file, `${JSON.stringify(envelope)}\n`);
    this.entries.push(envelope);
    this.enforceLimit();
    this.persistState();
    this.maybeCompact();
    return envelope;
  }

  /** The oldest pending events, at most `limit` and (after the first) at most `maxBytes` of JSON. */
  pending(limit: number, maxBytes = Number.POSITIVE_INFINITY): EventEnvelope[] {
    this.load();
    const out: EventEnvelope[] = [];
    let bytes = 0;
    for (const entry of this.entries) {
      if (out.length >= limit) break;
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (out.length && bytes + size > maxBytes) break;
      out.push(entry);
      bytes += size;
    }
    return out;
  }

  /** Every event with `seq` at most `throughSeq` is durable on the cloud. */
  ack(throughSeq: number): number {
    this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => (entry.seq ?? 0) > throughSeq);
    const removed = before - this.entries.length;
    if (throughSeq > this.state.acked_through) this.state.acked_through = throughSeq;
    if (removed) {
      this.sinceCompaction += removed;
      this.persistState();
      this.maybeCompact();
    }
    return removed;
  }

  depth(): number {
    this.load();
    return this.entries.length;
  }

  /** Gives up on one event (the cloud refused it even on its own); it counts as dropped. */
  drop(seq: number): boolean {
    this.load();
    const index = this.entries.findIndex((entry) => entry.seq === seq);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    this.state.dropped_total++;
    this.sinceCompaction++;
    this.persistState();
    this.maybeCompact();
    return true;
  }

  droppedTotal(): number {
    this.load();
    return this.state.dropped_total;
  }

  seq(): number {
    this.load();
    return this.state.seq;
  }

  private maybeCompact(): void {
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    if (this.sinceCompaction >= COMPACT_EVERY || size > OUTBOX_MAX_FILE_BYTES) this.compact();
  }

  /** Rewrites the file with only the pending events (temp file + rename). */
  compact(): void {
    this.load();
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, this.entries.map((entry) => JSON.stringify(entry)).join("\n") + (this.entries.length ? "\n" : ""), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.sinceCompaction = 0;
    this.persistState();
  }

  /** Forgets everything (disconnect). */
  purge(): void {
    this.entries = [];
    this.state = { seq: 0, acked_through: 0, dropped_total: 0 };
    this.loaded = true;
    rmSync(this.file, { force: true });
    rmSync(this.stateFile, { force: true });
  }
}

interface CommandLedgerState {
  handled: { id: string; at: string }[];
  results: CommandResult[];
  cached: { id: string; result: CommandResult }[];
}

const HANDLED_MAX = 500;
const CACHED_MAX = 100;

/** Which commands ran (so a re-sent one is not run twice), results waiting for the cloud's ack, and a few results kept for retries. */
export class CommandLedger {
  private readonly file: string;
  private state: CommandLedgerState = { handled: [], results: [], cached: [] };
  private loaded = false;

  constructor(jobsDir: string) {
    this.file = path.join(cloudStateDir(jobsDir), "commands.json");
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = readJsonFileOr<Partial<CommandLedgerState>>(this.file, {});
    this.state = { handled: Array.isArray(raw.handled) ? raw.handled : [], results: Array.isArray(raw.results) ? raw.results : [], cached: Array.isArray(raw.cached) ? raw.cached : [] };
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeJsonFile(this.file, this.state);
  }

  seen(id: string): boolean {
    this.load();
    return this.state.handled.some((h) => h.id === id);
  }

  /** A result kept for a command the cloud sent again (never a sensitive one). */
  cachedResult(id: string): CommandResult | undefined {
    this.load();
    return this.state.cached.find((c) => c.id === id)?.result;
  }

  /** Records that the command ran, its result for the next sync, and a copy for retries unless sensitive. */
  complete(result: CommandResult): void {
    this.load();
    if (!this.state.handled.some((h) => h.id === result.command_id)) this.state.handled.push({ id: result.command_id, at: nowIso() });
    if (this.state.handled.length > HANDLED_MAX) this.state.handled.splice(0, this.state.handled.length - HANDLED_MAX);
    this.state.results = this.state.results.filter((r) => r.command_id !== result.command_id);
    this.state.results.push(result);
    if (!result.sensitive) {
      this.state.cached = this.state.cached.filter((c) => c.id !== result.command_id);
      this.state.cached.push({ id: result.command_id, result });
      if (this.state.cached.length > CACHED_MAX) this.state.cached.splice(0, this.state.cached.length - CACHED_MAX);
    }
    this.save();
  }

  pendingResults(limit: number): CommandResult[] {
    this.load();
    return this.state.results.slice(0, limit);
  }

  ackResults(ids: string[]): void {
    this.load();
    if (!ids.length) return;
    const set = new Set(ids);
    this.state.results = this.state.results.filter((r) => !set.has(r.command_id));
    this.save();
  }

  purge(): void {
    this.state = { handled: [], results: [], cached: [] };
    this.loaded = true;
    rmSync(this.file, { force: true });
  }
}

interface IngressLedgerState {
  /** Acknowledgements not yet sent (or not yet confirmed by an answer from the cloud). */
  pending: IngressAck[];
  /** What each hosted-ingress id became, so a re-sent item is answered without running again. */
  seen: { id: string; ack: IngressAck; at: string }[];
}

const SEEN_MAX = 1000;

export class IngressLedger {
  private readonly file: string;
  private state: IngressLedgerState = { pending: [], seen: [] };
  private loaded = false;

  constructor(jobsDir: string) {
    this.file = path.join(cloudStateDir(jobsDir), "ingress.json");
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = readJsonFileOr<Partial<IngressLedgerState>>(this.file, {});
    this.state = { pending: Array.isArray(raw.pending) ? raw.pending : [], seen: Array.isArray(raw.seen) ? raw.seen : [] };
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeJsonFile(this.file, this.state);
  }

  known(id: string): IngressAck | undefined {
    this.load();
    return this.state.seen.find((s) => s.id === id)?.ack;
  }

  record(ack: IngressAck): void {
    this.load();
    this.state.seen = this.state.seen.filter((s) => s.id !== ack.id);
    this.state.seen.push({ id: ack.id, ack, at: nowIso() });
    if (this.state.seen.length > SEEN_MAX) this.state.seen.splice(0, this.state.seen.length - SEEN_MAX);
    this.state.pending = this.state.pending.filter((p) => p.id !== ack.id);
    this.state.pending.push(ack);
    this.save();
  }

  pendingAcks(limit: number): IngressAck[] {
    this.load();
    return this.state.pending.slice(0, limit);
  }

  /** The cloud answered a sync that carried these acks: it has them. */
  acksSent(ids: string[]): void {
    this.load();
    if (!ids.length) return;
    const set = new Set(ids);
    this.state.pending = this.state.pending.filter((p) => !set.has(p.id));
    this.save();
  }

  purge(): void {
    this.state = { pending: [], seen: [] };
    this.loaded = true;
    rmSync(this.file, { force: true });
  }
}
