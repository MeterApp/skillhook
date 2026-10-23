// What `serve` does for accounts between jobs: checks every account once at start (so a logged-out or expired one is
// on the event bus and in the log before a job trips over it), reads the usage windows every
// `account_policy.usage_poll_minutes` when that is set (each account's own CLI asks its provider; off by default), and
// with `account_policy.notify: desktop` shows a notification when an account stops being usable or recovers.
import { collectAccounts } from "./account-report.js";
import { AccountStateStore } from "./accounts.js";
import type { Config } from "./config.js";
import type { Secrets } from "./env.js";
import type { Events } from "./events.js";
import type { JobStore } from "./jobs.js";
import type { Logger } from "./logger.js";
import { notifyDesktop } from "./notify.js";
import type { Paths } from "./paths.js";
import type { ReadinessCache } from "./readiness.js";
import type { SkillRegistry } from "./registry.js";
import { errorMessage } from "./util.js";

export interface AccountWatchDeps {
  config: Config;
  paths: Paths;
  events: Events;
  logger: Logger;
  readiness: ReadinessCache;
  registry: SkillRegistry;
  store: JobStore;
  secrets: () => Secrets;
  baseEnv: () => Record<string, string>;
  /** How often the poll interval is looked at (default one minute); tests pass a short one. */
  tickMs?: number;
  /** Stand-in for the desktop notifier in tests. */
  notify?: (title: string, body: string) => void;
}

export class AccountWatch {
  private timer?: NodeJS.Timeout;
  private lastPoll = 0;
  private polling = false;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly deps: AccountWatchDeps) {}

  start(): void {
    const notify = (body: string) => {
      if (this.deps.config.account_policy.notify !== "desktop") return;
      (this.deps.notify ?? notifyDesktop)("skillhook", body);
    };
    this.unsubscribe.push(
      this.deps.events.on("account.changed", ({ data }) => {
        if (!data.previous && data.readiness.ready) return; // the first look at a usable account is not news
        if (data.readiness.ready) notify(`Account ${data.account} works again`);
        else notify(`Account ${data.account} ${data.readiness.expired ? "login expired" : data.readiness.detail}: skillhook accounts login ${data.account}`);
      }),
      this.deps.events.on("account.updated", ({ data }) => {
        if (data.reason === "limited") notify(`Account ${data.account} hit its usage limit${data.state.limited_until ? ` until ${new Date(data.state.limited_until).toLocaleString()}` : ""}`);
        else if (data.reason === "auth_failed") notify(`Account ${data.account} failed to authenticate: skillhook accounts login ${data.account}`);
        else if (data.reason === "recovered") notify(`Account ${data.account} works again`);
      }),
    );
    void this.check(false);
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const off of this.unsubscribe.splice(0)) off();
  }

  private async tick(): Promise<void> {
    const minutes = this.deps.config.account_policy.usage_poll_minutes;
    if (minutes <= 0 || Date.now() - this.lastPoll < minutes * 60_000) return;
    await this.check(true);
  }

  /** One look at every account (with `usage`: their usage windows too); readiness changes become `account.changed`. */
  async check(usage: boolean): Promise<void> {
    if (this.polling || !Object.keys(this.deps.config.accounts).length) return;
    this.polling = true;
    if (usage) this.lastPoll = Date.now();
    try {
      const secrets = this.deps.secrets();
      const report = await collectAccounts({ config: this.deps.config, home: this.deps.paths.home, secrets, baseEnv: this.deps.baseEnv(), skills: this.deps.registry.list().skills, store: this.deps.store, states: new AccountStateStore(this.deps.paths.jobsDir), readiness: this.deps.readiness, usage, events: this.deps.events });
      for (const view of report.accounts) {
        const serious = view.attention.filter((a) => a.level === "fail");
        if (serious.length) this.deps.logger.warn("account needs attention", { account: view.name, status: view.status, problems: serious.map((a) => a.message), fix: serious[0]?.fix });
      }
    } catch (error) {
      this.deps.logger.warn("account check failed", { error: errorMessage(error) });
    } finally {
      this.polling = false;
    }
  }
}
