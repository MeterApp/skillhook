import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./main.js";
import type { CliIO } from "./shared.js";
import { lastFailureFile } from "./feedback.js";
import { FakeCloud } from "../test-support/fake-cloud.js";
import { tempHome, writeConfigFile, writeEnv } from "../test-support/helpers.js";

function io(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIO = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: { SKILLHOOK_NO_UPDATE_CHECK: "1", ...env }, isTTY: false };
  return { cli, out: () => out.join(""), err: () => err.join(""), json: () => JSON.parse(out.join("")) as Record<string, unknown> };
}

const item = (number: number, extra: Record<string, unknown> = {}) => ({ id: `id-${number}`, number, kind: "feature", title: `Item ${number}`, status: "open", votes: 2, comments: 1, author: "Ada", url: `https://cloud.example.test/feedback/${number}`, ...extra });

describe("skillhook feedback and review", () => {
  let fake: FakeCloud;
  let home: ReturnType<typeof tempHome>;
  let at: string[];

  beforeEach(async () => {
    fake = await FakeCloud.start();
    home = tempHome("skillhook-feedback-");
    at = ["--dir", home.home];
    writeConfigFile(home, { cloud: { url: fake.url } });
    writeEnv(home, { SKILLHOOK_CLOUD_API_KEY: fake.apiKey, SKILLHOOK_CLOUD_API_URL: fake.url });
  });
  afterEach(async () => {
    await fake.close();
  });

  it("lists, shows and lists mine through the cloud's tools", async () => {
    fake.toolAnswers.set("list_feedback", () => ({ items: [item(12, { viewer: { voted: true } }), item(3, { kind: "issue", visibility: "private" })], next_cursor: null }));
    fake.toolAnswers.set("get_feedback", (input) => ({ item: item(Number(input.item), { status: "planned" }), comments: [{ author: "Skillhook team", body: "On it.", official: true, created_at: "2026-10-17T10:00:00Z" }], timeline: [{ kind: "status", to: "planned", note: "Next sprint.", at: "2026-10-17T10:00:00Z" }] }));
    fake.toolAnswers.set("list_my_feedback", () => ({ items: [item(3)], subscriptions: [item(12)] }));

    const list = io();
    expect(await main(["feedback", "list", "--kind", "feature", "--search", "retry", ...at], list.cli)).toBe(0);
    expect(list.out()).toMatch(/#12\s+feature\s+open\s+2✓/);
    expect(list.out()).toContain("Item 3 (private)");
    const show = io();
    expect(await main(["feedback", "show", "#12", ...at], show.cli)).toBe(0);
    expect(show.out()).toContain("planned: Next sprint.");
    expect(show.out()).toContain("Skillhook team (Skillhook team)");
    const mine = io();
    expect(await main(["feedback", "mine", ...at, "--json"], mine.cli)).toBe(0);
    expect(mine.json()).toMatchObject({ subscriptions: [{ number: 12 }] });
    expect(fake.toolCalls).toEqual([
      { name: "list_feedback", input: { kind: "feature", q: "retry" } },
      { name: "get_feedback", input: { item: "12" } },
      { name: "list_my_feedback", input: {} },
    ]);
    expect(fake.apiRequests.every((request) => request.client === "cli")).toBe(true);
  });

  it("shows similar requests instead of filing, and files with --force", async () => {
    fake.toolAnswers.set("request_feature", (input) => (input.force ? { created: true, item: item(40) } : { created: false, similar: [item(12)], hint: "upvote" }));
    const first = io();
    expect(await main(["feedback", "request", "Retry", "failed", "jobs", "--body", "Automatically.", ...at], first.cli)).toBe(0);
    expect(first.out()).toContain("Similar items exist; nothing was filed");
    expect(first.out()).toContain("#12");
    const forced = io();
    expect(await main(["feedback", "request", "Retry failed jobs", "--force", ...at], forced.cli)).toBe(0);
    expect(forced.out()).toContain("Requested as #40");
    expect(fake.toolCalls.map((call) => call.input)).toEqual([{ title: "Retry failed jobs", body: "Automatically." }, { title: "Retry failed jobs", force: true }]);
  });

  it("reports with the last refused request, the job and the CLI's own context", async () => {
    fake.toolAnswers.set("get_job", () => ({ problem: [500, "internal", "Something went wrong on our side."] }));
    fake.toolAnswers.set("upvote_feedback", () => ({ problem: [409, "closed", "This item is done; it takes no more votes."] }));
    fake.toolAnswers.set("report_issue", () => ({ created: true, item: item(41, { kind: "issue", report: { number: 7, dashboard_url: "https://cloud.example.test/o/fake/issues/7" } }), acknowledged: true }));
    // A refused vote is remembered (the fake answers without a request id; the cloud sends one).
    expect(await main(["feedback", "upvote", "9", ...at], io().cli)).toBe(1);
    expect(existsSync(lastFailureFile(home.home))).toBe(true);
    expect(JSON.parse(readFileSync(lastFailureFile(home.home), "utf8"))).toMatchObject({ method: "POST", path: "/api/v1/tools/upvote_feedback", status: 409, code: "closed" });

    const report = io();
    expect(await main(["feedback", "report", "Votes refused", "--last", "--request-id", "req_1", "--job", "20261017T101500Z-a1b2c3", "--force", ...at], report.cli)).toBe(0);
    expect(report.out()).toContain("Reported as #7 (board #41): https://cloud.example.test/o/fake/issues/7");
    const sent = fake.toolCalls.at(-1)!;
    expect(sent.name).toBe("report_issue");
    expect(sent.input).toMatchObject({ title: "Votes refused", request_id: "req_1", job: "20261017T101500Z-a1b2c3", force: true, context: { client: "skillhook-cli", last_failure: { endpoint: "POST /api/v1/tools/upvote_feedback", status: 409, error_code: "closed" } } });

    const none = io();
    expect(await main(["feedback", "report", "Nothing", "--last", "--dir", tempHome("skillhook-feedback-empty-").home], none.cli)).toBe(1);
  });

  it("votes, takes a vote back and comments", async () => {
    fake.toolAnswers.set("upvote_feedback", () => ({ voted: true, new_vote: true, votes: 3, item: { number: 12, url: "u" } }));
    fake.toolAnswers.set("remove_feedback_vote", () => ({ voted: false, removed: true, votes: 2, item: { number: 12, url: "u" } }));
    fake.toolAnswers.set("comment_on_feedback", () => ({ comment: { id: "c" }, item: { number: 12, url: "u" } }));
    const up = io();
    expect(await main(["feedback", "upvote", "12", ...at], up.cli)).toBe(0);
    expect(up.out()).toContain("Voted: #12 has 3 votes.");
    const down = io();
    expect(await main(["feedback", "upvote", "12", "--remove", ...at], down.cli)).toBe(0);
    expect(down.out()).toContain("Vote removed");
    expect(await main(["feedback", "comment", "12", "We", "need", "this", ...at], io().cli)).toBe(0);
    expect(fake.toolCalls.at(-1)).toEqual({ name: "comment_on_feedback", input: { item: "12", body: "We need this" } });
    expect(await main(["feedback", "upvote", ...at], io().cli)).toBe(2);
  });

  it("posts a review and reads the reviews", async () => {
    fake.toolAnswers.set("submit_review", () => ({ created: true, published: true, review: {} }));
    fake.toolAnswers.set("list_reviews", () => ({ aggregate: { count: 1, average: 5, distribution: {} }, reviews: [{ rating: 5, title: "Great", display_name: "Ada", body: "Runs our webhooks.", response: { body: "Thank you!" } }] }));
    const review = io();
    expect(await main(["review", "--rating", "5", "--likes", "The inbox", "--use-case", "Sentry fixes", "--consent", ...at], review.cli)).toBe(0);
    expect(review.out()).toContain("Posted. It is live");
    expect(fake.toolCalls.at(-1)).toEqual({ name: "submit_review", input: { rating: 5, likes: "The inbox", use_case: "Sentry fixes", marketing_consent: true } });
    const reviews = io();
    expect(await main(["reviews", ...at], reviews.cli)).toBe(0);
    expect(reviews.out()).toContain("★★★★★  Great — Ada");
    expect(reviews.out()).toContain("Skillhook: Thank you!");
    expect(await main(["review", ...at], io().cli)).toBe(2);
  });

  it("sends nothing under SKILLHOOK_NO_CLOUD", async () => {
    expect(await main(["feedback", "list", ...at], io({ SKILLHOOK_NO_CLOUD: "1" }).cli)).toBe(1);
    expect(fake.apiRequests).toEqual([]);
  });
});
