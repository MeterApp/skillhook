import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

function output() {
  let text = "";
  return { stream: new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } }), text: () => text };
}

describe("logger error observer", () => {
  it("passes only the operation and original cause, keeping log fields local", () => {
    const sink = output();
    const onError = vi.fn();
    const cause = new TypeError("private payload");
    const fields = { token: "private-secret", error: "local error detail" };
    const logger = createLogger({ stream: sink.stream, onError });
    logger.error("unhandled request error", fields, cause);
    expect(onError.mock.calls).toEqual([["unhandled request error", cause]]);
    const entry = JSON.parse(sink.text());
    expect(entry).toMatchObject({ level: "error", msg: "unhandled request error", ...fields });
    expect(sink.text()).not.toContain("private payload");
    expect(entry).not.toHaveProperty("cause");
  });

  it("retains the observer in children without forwarding child fields", () => {
    const sink = output();
    const onError = vi.fn();
    const cause = new Error("original");
    createLogger({ stream: sink.stream, onError, base: { private: "base" } })
      .child({ skill: "secret-skill" }).child({ job: "secret-job" })
      .error("daemon error", { payload: "secret-body" }, cause);
    expect(onError.mock.calls).toEqual([["daemon error", cause]]);
    expect(JSON.parse(sink.text())).toMatchObject({ private: "base", skill: "secret-skill", job: "secret-job", payload: "secret-body" });
  });

  it("does not observe normal log levels", () => {
    const onError = vi.fn();
    const logger = createLogger({ stream: output().stream, level: "debug", onError });
    logger.debug("debug"); logger.info("info"); logger.warn("warn");
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps logging when the observer throws", () => {
    const sink = output();
    const logger = createLogger({ stream: sink.stream, onError() { throw new Error("broken observer"); } });
    expect(() => logger.error("daemon error", { preserved: true })).not.toThrow();
    expect(JSON.parse(sink.text())).toMatchObject({ level: "error", msg: "daemon error", preserved: true });
  });
});
