import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addNote, answerQuestion, askQuestion, NoQuestionError, readAnswer, readCurrent, readProgress, readQuestion, readTimeline, recordOutcome, reportProgress, waitForAnswer } from "./progress.js";
import { tempHome } from "./test-support/helpers.js";

function jobDir(): string {
  const dir = path.join(tempHome("skillhook-progress-").jobsDir, "20260928T120000Z-abcdef");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("progress files", () => {
  it("records progress, notes and the outcome as a timeline plus a current state", () => {
    const dir = jobDir();
    expect(readProgress(dir)).toEqual({ progress: undefined, question: undefined, answer: undefined, timeline: [] });
    const first = reportProgress(dir, { message: "reading the payload", percent: 12.6, step: "read" });
    expect(first).toMatchObject({ state: "working", message: "reading the payload", percent: 13, step: "read" });
    expect(readCurrent(dir)).toEqual(first);
    expect((statSync(path.join(dir, "progress.jsonl")).mode & 0o777).toString(8)).toBe("600");
    reportProgress(dir, { message: "  blocked on a lock  ", state: "blocked", percent: 250 });
    expect(readCurrent(dir)).toMatchObject({ state: "blocked", message: "blocked on a lock", percent: 100 });
    addNote(dir, "found two candidates");
    recordOutcome(dir, "completed", "Merged the fix.");
    const report = readProgress(dir);
    expect(report.progress).toMatchObject({ state: "done", message: "Merged the fix." });
    expect(report.timeline.map((e) => e.type)).toEqual(["progress", "progress", "note", "outcome"]);
    expect(report.timeline[3]).toMatchObject({ type: "outcome", outcome: "completed", summary: "Merged the fix." });
  });

  it("asks, answers and waits for the answer through the files", async () => {
    const dir = jobDir();
    expect(() => answerQuestion(dir, { text: "nothing to answer", requireQuestion: true })).toThrow(NoQuestionError);
    const question = askQuestion(dir, { text: "Deploy A or B?", options: ["A", "B", ""], context: "A is faster", waitSeconds: 60 });
    expect(question).toMatchObject({ text: "Deploy A or B?", options: ["A", "B"], context: "A is faster" });
    expect(question.id).toMatch(/^[0-9a-z]{8}$/);
    expect(Date.parse(question.wait_until!) - Date.parse(question.asked_at)).toBe(60_000);
    expect(readQuestion(dir)).toEqual(question);
    expect(readCurrent(dir)).toMatchObject({ state: "waiting_human", message: "Deploy A or B?" });
    expect(readAnswer(dir)).toBeUndefined();
    expect(await waitForAnswer(dir, question.id, { timeoutMs: 120, pollMs: 20 })).toBeUndefined();
    const pending = waitForAnswer(dir, question.id, { timeoutMs: 5000, pollMs: 20 });
    // An answer to some other question does not count.
    appendFileSync(path.join(dir, "answer.json"), "");
    setTimeout(() => answerQuestion(dir, { text: "Go with B", option: "B", by: "ada" }), 60);
    const answer = await pending;
    expect(answer).toMatchObject({ question_id: question.id, text: "Go with B", option: "B", by: "ada" });
    expect(readQuestion(dir)?.answered_at).toBe(answer!.at);
    expect(readCurrent(dir)).toMatchObject({ state: "working", message: "answered: Go with B" });
    const report = readProgress(dir);
    expect(report.timeline.map((e) => e.type)).toEqual(["question", "answer"]);
    expect(report.answer).toEqual(answer);
    // A second question discards the earlier answer; the next answer needs no question id to stand alone.
    const again = askQuestion(dir, { text: "Sure?" });
    expect(readAnswer(dir)).toBeUndefined();
    expect(again.id).not.toBe(question.id);
    const standalone = answerQuestion(dir, { text: "yes" });
    expect(standalone.question_id).toBe(again.id);
    const orphan = answerQuestion(dir, { text: "and also this" });
    expect(orphan.question_id).toBeUndefined(); // the pending question was already answered
  });

  it("tails the timeline from an offset and ignores a torn last line", () => {
    const dir = jobDir();
    reportProgress(dir, { message: "one" });
    const first = readTimeline(dir, 0);
    expect(first.entries).toHaveLength(1);
    expect(readTimeline(dir, first.offset).entries).toEqual([]);
    const file = path.join(dir, "progress.jsonl");
    appendFileSync(file, '{"at":"2026-09-28T12:00:01.000Z","type":"note","message":"two"}\n{"at":"2026-09-28T12:00:02.000Z","type":"note","mess');
    const second = readTimeline(dir, first.offset);
    expect(second.entries.map((e) => (e.type === "note" ? e.message : e.type))).toEqual(["two"]);
    appendFileSync(file, 'age":"three"}\nnot json at all\n');
    const third = readTimeline(dir, second.offset);
    expect(third.entries.map((e) => (e.type === "note" ? e.message : e.type))).toEqual(["three"]);
    expect(readTimeline(dir, third.offset).entries).toEqual([]);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(4);
    // A file that shrank (rewritten) starts over.
    expect(readTimeline(dir, 10_000).offset).toBe(0);
    expect(readTimeline(path.join(dir, "nope"), 0)).toEqual({ entries: [], offset: 0 });
  });
});
