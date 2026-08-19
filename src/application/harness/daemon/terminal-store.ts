import { pipeline } from "node:stream";
import type { Socket } from "node:net";
import type { Terminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { createRequire } from "node:module";
import { log } from "../../../core/log.js";
import { CoalescingTransform, SCREEN_STEP_ID, writeEofFrame, writeFrame } from "./frame-transport.js";
import type { RunLog, RunLogStore } from "./run-log.js";

const req = createRequire(
  typeof import.meta.url === "string" && import.meta.url ? import.meta.url : __filename,
);

const xtermHeadlessModule = req("@xterm/headless");
const HeadlessTerminal: new (opts: Record<string, unknown>) => Terminal = (xtermHeadlessModule.Terminal || xtermHeadlessModule.default?.Terminal || xtermHeadlessModule) as any;

const serializeAddonModule = req("@xterm/addon-serialize");
const SerializeAddonClass: new () => SerializeAddon = (serializeAddonModule.SerializeAddon || serializeAddonModule.default?.SerializeAddon || serializeAddonModule) as any;

/**
 * The subset of node-pty's IPty the daemon consumes. Duck-typed so tests can
 * inject a fake PTY without spawning a real process.
 */
export interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write?(data: string): void;
  kill?(): void;
  resize?(cols: number, rows: number): void;
}

export interface RunTerminalOptions {
  cols?: number;
  rows?: number;
  coalesceMs?: number;
  maxFrameBytes?: number;
  /** Optional disk-log sink: every frame is appended so a finished run can be
   *  re-attached from disk after daemon restart (ADR-025 Phase E #16). */
  log?: RunLog;
}

interface ClientLink {
  socket: Socket;
  transform: CoalescingTransform;
  /** Resolves once this client's pipeline has fully flushed (EOF handed to socket). */
  pipelineDone: Promise<void>;
}

/**
 * One job's combined terminal, held in `@xterm/headless` + SerializeAddon.
 *
 * All step PTY bytes are written into the headless screen and fanned out to
 * every attached terminal-pipe client through a per-client coalescing
 * Transform. A client that attaches late (or after completion) first receives
 * a single replay frame — the serialized screen state — then live frames,
 * then an EOF frame. Replay-then-live is a plain byte concatenation because
 * the serialized screen positions the cursor exactly where the live stream
 * continues from (ADR locked design #7).
 */
export class RunTerminal {
  readonly runId: string;
  private xterm: Terminal;
  private serializer: SerializeAddon;
  private clients = new Set<ClientLink>();
  private done = false;
  private hasContent = false;
  /** stepId -> dispatch count, so a redo/repair-loop dispatch gets its own marker. */
  private stepDispatches = new Map<string, number>();
  /** stepId -> dispatch whose marker has already been written (dedupes noteStart + feedPty). */
  private stepMarked = new Map<string, number>();
  private pendingParses = 0;
  private drainWaiters: (() => void)[] = [];
  private readonly coalesceMs: number;
  private readonly maxFrameBytes: number;
  private readonly log?: RunLog;

  constructor(runId: string, opts: RunTerminalOptions = {}) {
    this.runId = runId;
    this.coalesceMs = opts.coalesceMs ?? 16;
    this.maxFrameBytes = opts.maxFrameBytes ?? 4096;
    this.log = opts.log;
    this.xterm = new HeadlessTerminal({
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
      scrollback: 5000,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddonClass();
    this.xterm.loadAddon(this.serializer);
  }

/** Register the next dispatch round for `stepId` and return its dispatch number. */
  private beginStep(stepId: string): number {
    const dispatch = (this.stepDispatches.get(stepId) ?? 0) + 1;
    this.stepDispatches.set(stepId, dispatch);
    return dispatch;
  }

  /** Write the `[step: <id>]` / `[step: <id> (redo N)]` marker, once per dispatch. */
  private writeStepMarker(stepId: string, dispatch: number): void {
    if (this.stepMarked.get(stepId) === dispatch) return;
    this.stepMarked.set(stepId, dispatch);
    this.write(stepId, dispatch === 1
      ? `\r\n[step: ${stepId}]\r\n`
      : `\r\n[step: ${stepId} (redo ${dispatch - 1})]\r\n`);
  }

  /**
   * Mark a step's start in the combined stream. Used by the daemon for
   * non-PTY steps (script/exec gates) whose raw bytes never flow through a
   * PTY — so a script-only run still produces a tracked, visible terminal
   * (ADR Phase F: F2 needs the terminal to carry content and be completable).
   * A redundant `feedPty` for the same step won't emit a second marker.
   */
  noteStart(stepId: string): void {
    if (this.done) return;
    const dispatch = this.beginStep(stepId);
    this.writeStepMarker(stepId, dispatch);
  }

  /**
   * Wire a step's PTY into this run's terminal. On the step's first byte a
   * `[step: <id>]` marker is written so the combined stream shows transitions
   * (skipped if `noteStart` already wrote it). A subsequent dispatch of the
   * same id (a redo/repair loop) writes a distinct `[step: <id> (redo N)]`
   * marker so gate-failure boundaries stay visible.
   */
  feedPty(stepId: string, pty: PtyLike): void {
    if (this.done) return;
    const dispatch = this.beginStep(stepId);
    pty.onData((data: string) => {
      if (this.done) {
        log.debug(`[terminal ${this.runId}] complete() early-return (already done)`);
        return;
      }
      this.writeStepMarker(stepId, dispatch);
      this.write(stepId, data);
    });
  }

  /**
   * Feed bytes attributed to `stepId` (xterm write + fanout to live clients).
   * The step id flows through to attached clients so a GUI demuxes by frame
   * header rather than parsing `[step: …]` text markers.
   */
  write(stepId: string, data: string): void {
    this.hasContent = true;
    this.pendingParses++;
    this.xterm.write(data, () => {
      this.pendingParses--;
      if (this.pendingParses === 0) {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const w of waiters) w();
      }
    });
    // Durable disk log (E1): persist the attributed frame so a finished/evicted
    // run can be replayed after restart. The `[step: …]` marker is written via
    // this.write below too, so the log preserves the same ordered, attributed
    // stream the live channel saw.
    this.log?.append(stepId, data);
    if (this.clients.size === 0) return;
    const buf = Buffer.from(data, "utf8");
    for (const link of this.clients) {
      link.transform.write({ stepId, data: buf });
    }
  }

  /**
   * Resolves once every previously-written chunk has been parsed by the
   * headless terminal, so a serialized screen snapshot is stable.
   */
  async waitParsed(): Promise<void> {
    while (this.pendingParses > 0) {
      await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    }
  }

  /**
   * Snapshot of the current screen as ANSI text. Used both for the late-attach
   * replay frame and by tests to assert on accumulated content. Scrollback is
   * included up to this terminal's limit so a client that attaches late (or
   * after completion) receives real history rather than only the viewport
   * (Phase D D-6).
   */
  serialize(): string {
    return this.serializer.serialize({ scrollback: 5000 });
  }

  get contentSeen(): boolean {
    return this.hasContent;
  }

  get isDone(): boolean {
    return this.done;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Attach a terminal-pipe client socket. Writes the replay frame (serialized
   * screen) immediately, then live frames until `complete()`; if already done,
   * writes replay + EOF and closes.
   */
  async attach(socket: Socket): Promise<void> {
    // A terminal-pipe socket is fan-out, never the control channel: an error
    // must not crash the run. The live path adds cleanup on 'close'/'error'
    // below; the replay-only path needs at least a swallow so a half-open
    // client can't trigger an unhandled 'error'.
    socket.on("error", () => {});
    try {
      await this.waitParsed();
      if (this.hasContent) {
        writeFrame(socket, SCREEN_STEP_ID, this.serialize());
      }
      if (this.done) {
        writeEofFrame(socket);
        socket.end();
        return;
      }
      const transform = new CoalescingTransform(this.coalesceMs, this.maxFrameBytes);
      let resolvePipeline: () => void = () => {};
      const pipelineDone = new Promise<void>((r) => { resolvePipeline = r; });
      const link: ClientLink = { socket, transform, pipelineDone };
      this.clients.add(link);
      const cleanup = () => this.removeClient(link);
      socket.on("close", cleanup);
      socket.on("error", cleanup);
      pipeline(transform, socket, (err) => {
        cleanup();
        resolvePipeline();
        if (err) log.debug(`[terminal ${this.runId}] client pipeline error: ${err.message}`);
      });
    } catch (err: any) {
      log.debug(`[terminal ${this.runId}] attach failed: ${err?.message ?? err}`);
      socket.destroy();
    }
  }

  /** Mark the run finished: flush + EOF every live client. */
  async complete(): Promise<void> {
    if (this.done) return;
    await this.waitParsed();
    this.done = true;
    const links = [...this.clients];
    log.debug(`[terminal ${this.runId}] complete(): ${links.length} live client(s)`);
    for (const link of links) {
      link.transform.end(); // flushes remaining + EOF frame; pipeline closes socket
    }
    await Promise.all(links.map((l) => l.pipelineDone));
    log.debug(`[terminal ${this.runId}] complete(): pipelines flushed (${links.length})`);
  }

  /** Mark done without touching clients (used for a reconstructed terminal). */
  markDone(): void {
    this.done = true;
  }

  dispose(): void {
    // Mark done first so late PTY data callbacks no-op instead of writing into
    // a disposed xterm; and resolve any waitParsed() waiters so they can't hang.
    this.done = true;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w();
    for (const link of [...this.clients]) {
      link.socket.destroy();
      this.clients.delete(link);
    }
    try { this.xterm.dispose(); } catch { /* ignore */ }
  }

  private removeClient(link: ClientLink): void {
    this.clients.delete(link);
  }
}

/**
 * Registry of per-run terminals keyed by runId, created lazily. The daemon
 * (Phase C step 3) calls `ensure` on run/attach and `feedPty`/`complete` from
 * its progress fan-out.
 *
 * When given a `RunLogStore` (Phase E #16), each run's terminal lazily opens a
 * durable disk log and every frame is appended to it, so a finished/evicted
 * run can be re-attached after daemon restart.
 */
export class TerminalStore {
  private runs = new Map<string, RunTerminal>();
  private replays = new Map<string, RunTerminal>();
  private readonly runStore: RunLogStore | undefined;
  /** Bound on cached reconstructed terminals; oldest is evicted on overflow. */
  private static readonly MAX_REPLAYS = 32;

  constructor(opts: { runLogStore?: RunLogStore } = {}) {
    this.runStore = opts.runLogStore;
  }

  ensure(runId: string, opts: RunTerminalOptions = {}): RunTerminal {
    let run = this.runs.get(runId);
    if (!run) {
      const log = this.runStore?.runLog(runId);
      run = new RunTerminal(runId, { ...opts, log });
      this.runs.set(runId, run);
    }
    return run;
  }

  get(runId: string): RunTerminal | undefined {
    return this.runs.get(runId);
  }

  feedPty(runId: string, stepId: string, pty: PtyLike): void {
    this.ensure(runId).feedPty(stepId, pty);
  }

  /** Attach a terminal-pipe client to a run's live/replay stream. */
  attach(runId: string, socket: Socket): void {
    const run = this.runs.get(runId) ?? this.replays.get(runId) ?? this.reconstruct(runId);
    run.attach(socket).catch((err: any) => {
      log.debug(`[terminal ${runId}] attach rejected: ${err?.message ?? err}`);
      socket.destroy();
    });
  }

  /**
   * Reconstruct a run's terminal from its durable disk log (ADR-025 Phase E
   * #16) when it is no longer live in memory — i.e. a finished/evicted run
   * being re-attached. Replays every persisted frame into a fresh headless
   * terminal and marks it done, so the client receives the whole `__screen__`
   * replay + EOF. Returns an empty live terminal when no log exists.
   *
   * Results are cached in `replays` (bounded LRU) so repeated re-attaches of
   * the same finished run reuse the terminal instead of re-decoding the log
   * and allocating a fresh headless screen each time.
   */
  private reconstruct(runId: string): RunTerminal {
    const cached = this.replays.get(runId);
    if (cached) return cached;
    const hasLog = this.runStore?.exists(runId) === true;
    const terminal = new RunTerminal(runId, {}); // no log sink: frames are replayed to a client, not re-persisted
    if (hasLog) {
      for (const frame of this.runStore!.runLog(runId).decode()) {
        if (frame.stepId === SCREEN_STEP_ID) continue;
        terminal.write(frame.stepId, frame.payload.toString("utf8"));
      }
      terminal.markDone();
      this.replays.set(runId, terminal);
      this.evictReplayOverflow();
    }
    return terminal;
  }

  /** Evict the oldest replay terminal once the cache exceeds its bound. */
  private evictReplayOverflow(): void {
    if (this.replays.size <= TerminalStore.MAX_REPLAYS) return;
    // Maps preserve insertion order → oldest is the first key.
    const oldestRunId = this.replays.keys().next().value as string;
    this.replays.get(oldestRunId)?.dispose();
    this.replays.delete(oldestRunId);
  }

  complete(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      log.debug(`[terminalstore] complete(${runId}): run NOT in map (size=${this.runs.size})`);
      return Promise.resolve();
    }
    return run.complete();
  }

  delete(runId: string): void {
    this.runs.get(runId)?.dispose();
    this.runs.delete(runId);
  }

  /** Dispose every run terminal (daemon shutdown). */
  disposeAll(): void {
    for (const run of this.runs.values()) run.dispose();
    this.runs.clear();
    for (const run of this.replays.values()) run.dispose();
    this.replays.clear();
  }

  get size(): number {
    return this.runs.size;
  }
}
