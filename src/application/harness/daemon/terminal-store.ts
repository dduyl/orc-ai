import { pipeline } from "node:stream";
import type { Socket } from "node:net";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { log } from "../../../core/log.js";
import { CoalescingTransform, SCREEN_STEP_ID, writeEofFrame, writeFrame } from "./frame-transport.js";

// @xterm/headless ships CJS with no ESM wrapper, so it is imported as a CommonJS
// default and the constructor is extracted here. The bundler (esbuild) inlines
// the CJS package, keeping the packaged binary free of a runtime require().
const HeadlessTerminal: new (opts: Record<string, unknown>) => Terminal = Terminal as any;

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
}

interface ClientLink {
  socket: Socket;
  transform: CoalescingTransform;
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
  private pendingParses = 0;
  private drainWaiters: (() => void)[] = [];
  private readonly coalesceMs: number;
  private readonly maxFrameBytes: number;

  constructor(runId: string, opts: RunTerminalOptions = {}) {
    this.runId = runId;
    this.coalesceMs = opts.coalesceMs ?? 16;
    this.maxFrameBytes = opts.maxFrameBytes ?? 4096;
    this.xterm = new HeadlessTerminal({
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
      scrollback: 5000,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.xterm.loadAddon(this.serializer);
  }

  /**
   * Wire a step's PTY into this run's terminal. On the step's first byte a
   * `[step: <id>]` marker is written so the combined stream shows transitions.
   * A subsequent dispatch of the same id (a redo/repair loop) writes a distinct
   * `[step: <id> (redo N)]` marker so gate-failure boundaries stay visible.
   */
  feedPty(stepId: string, pty: PtyLike): void {
    if (this.done) return;
    const dispatch = (this.stepDispatches.get(stepId) ?? 0) + 1;
    this.stepDispatches.set(stepId, dispatch);
    let markerWritten = false;
    pty.onData((data: string) => {
      if (this.done) return;
      if (!markerWritten) {
        markerWritten = true;
        this.write(stepId, dispatch === 1
          ? `\r\n[step: ${stepId}]\r\n`
          : `\r\n[step: ${stepId} (redo ${dispatch - 1})]\r\n`);
      }
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
      const link: ClientLink = { socket, transform };
      this.clients.add(link);
      const cleanup = () => this.removeClient(link);
      socket.on("close", cleanup);
      socket.on("error", cleanup);
      pipeline(transform, socket, (err) => {
        cleanup();
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
    for (const link of [...this.clients]) {
      link.transform.end(); // flushes remaining + EOF frame; pipeline closes socket
    }
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
 */
export class TerminalStore {
  private runs = new Map<string, RunTerminal>();

  ensure(runId: string, opts: RunTerminalOptions = {}): RunTerminal {
    let run = this.runs.get(runId);
    if (!run) {
      run = new RunTerminal(runId, opts);
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
    this.ensure(runId).attach(socket).catch((err: any) => {
      log.debug(`[terminal ${runId}] attach rejected: ${err?.message ?? err}`);
      socket.destroy();
    });
  }

  complete(runId: string): void {
    void this.runs.get(runId)?.complete();
  }

  delete(runId: string): void {
    this.runs.get(runId)?.dispose();
    this.runs.delete(runId);
  }

  /** Dispose every run terminal (daemon shutdown). */
  disposeAll(): void {
    for (const run of this.runs.values()) run.dispose();
    this.runs.clear();
  }

  get size(): number {
    return this.runs.size;
  }
}
