import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDaemonErrorReporting } from "./daemon-errors.js";

afterEach(() => { vi.useRealTimers(); });

describe("daemon fatal error reporting", () => {
  it.each([
    ["uncaughtException", "daemon uncaught exception"],
    ["unhandledRejection", "daemon unhandled rejection"],
  ])("captures %s and waits for the bounded flush before exiting", async (event, operation) => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const cause = new Error("private fatal detail");
    const capture = vi.fn();
    let finish!: (delivered: boolean) => void;
    const flush = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const exit = vi.fn();
    const beforeExit = vi.fn();
    const log = vi.fn();
    const remove = installDaemonErrorReporting({ capture, flush }, { events: events as unknown as Pick<NodeJS.Process, "on" | "removeListener">, log, beforeExit, exit });
    events.emit(event, cause);
    expect(beforeExit).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls).toEqual([[operation, cause]]);
    expect(log.mock.calls).toEqual([[operation, cause]]);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(flush).toHaveBeenCalledExactlyOnceWith(3_000);
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
    remove();
  });

  it("enforces the independent deadline and exits only once if flush finishes late", async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    let finish!: (delivered: boolean) => void;
    const capture = vi.fn();
    const flush = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const exit = vi.fn();
    const beforeExit = vi.fn();
    const remove = installDaemonErrorReporting({ capture, flush }, { events: events as unknown as Pick<NodeJS.Process, "on" | "removeListener">, log: vi.fn(), beforeExit, exit });
    events.emit("uncaughtException", new Error("first"));
    events.emit("unhandledRejection", new Error("second"));
    await vi.advanceTimersByTimeAsync(3_499);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(beforeExit).toHaveBeenCalledTimes(1);
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    remove();
  });

  it.each(["throw", "reject", "not-delivered"])("preserves fatal exit when flush fails (%s)", async (failure) => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const exit = vi.fn();
    const flush = vi.fn(() => {
      if (failure === "throw") throw new Error("flush threw");
      return failure === "reject" ? Promise.reject(new Error("flush rejected")) : Promise.resolve(false);
    });
    const remove = installDaemonErrorReporting({ capture: vi.fn(), flush }, { events: events as unknown as Pick<NodeJS.Process, "on" | "removeListener">, log: vi.fn(), exit });
    events.emit("unhandledRejection", "non-Error rejection");
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
    remove();
  });

  it("still flushes and exits if local logging, capture, and shutdown preparation throw", async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const exit = vi.fn();
    const flush = vi.fn(async () => false);
    const remove = installDaemonErrorReporting({ capture() { throw new Error("capture"); }, flush }, {
      events: events as unknown as Pick<NodeJS.Process, "on" | "removeListener">, log() { throw new Error("local logging"); }, exit, beforeExit() { throw new Error("shutdown preparation"); },
    });
    expect(() => events.emit("uncaughtException", new Error("fatal"))).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(flush).toHaveBeenCalledExactlyOnceWith(3_000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    remove();
  });

  it("removes only its own process handlers", () => {
    const events = new EventEmitter();
    const existing = vi.fn();
    events.on("uncaughtException", existing);
    const capture = vi.fn();
    const remove = installDaemonErrorReporting({ capture, flush: async () => true }, { events: events as unknown as Pick<NodeJS.Process, "on" | "removeListener">, log: vi.fn(), exit: vi.fn() });
    expect(events.listenerCount("uncaughtException")).toBe(2);
    expect(events.listenerCount("unhandledRejection")).toBe(1);
    remove();
    expect(events.listenerCount("uncaughtException")).toBe(1);
    expect(events.listenerCount("unhandledRejection")).toBe(0);
    events.emit("uncaughtException", new Error("after cleanup"));
    expect(existing).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
  });
});
