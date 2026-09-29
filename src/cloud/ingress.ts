// Hosted-ingress deliveries: webhooks the cloud received at a hosted URL for this machine. Each one is handed to the
// local server exactly as an HTTP request, through the loopback address, with the original headers and body, so the
// signature is verified with the local secret and the usual dedupe, filters and queueing apply. The original sender's
// address travels as X-Forwarded-For (the server trusts it from loopback) and the cloud's id as X-Skillhook-Ingress-Id.
import type { Logger } from "../logger.js";
import type { IngressLedger } from "./outbox.js";
import type { IngressAck, IngressItem } from "./protocol.js";

export const INGRESS_ID_HEADER = "x-skillhook-ingress-id";

/** Headers of the original request that must not be replayed to the local server as they are. */
const DROPPED_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "expect", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "forwarded", "via", INGRESS_ID_HEADER]);

export interface IngressDeps {
  /** The local server's base URL (`http://127.0.0.1:<port>`), or undefined while it is not listening. */
  baseUrl: () => string | undefined;
  /** `cloud.ingress`. */
  enabled: () => boolean;
  ledger: IngressLedger;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

function ackFor(item: IngressItem, status: number, body: Record<string, unknown> | undefined): IngressAck {
  const jobId = typeof body?.job_id === "string" ? body.job_id : undefined;
  const base = { id: item.id, http_status: status, ...(jobId ? { job_id: jobId } : {}) };
  if (status === 202) return { ...base, outcome: "accepted" };
  if (status === 200) {
    if (body?.duplicate === true) return { ...base, outcome: body.in_flight === true ? "in_flight" : "duplicate", code: body.in_flight === true ? "in_flight" : "duplicate" };
    if (body?.skipped === true) return { ...base, outcome: "skipped", code: "skipped", ...(typeof body.reason === "string" ? { reason: body.reason.slice(0, 500) } : {}) };
    if (typeof body?.challenge === "string") return { ...base, outcome: "challenge", code: "challenge" };
    if (jobId) return { ...base, outcome: "accepted" };
    return { ...base, outcome: "accepted" };
  }
  return { ...base, outcome: status >= 500 && status !== 503 ? "error" : "rejected", code: typeof body?.error === "string" ? body.error.slice(0, 100) : `http_${status}`, ...(typeof body?.message === "string" ? { reason: body.message.slice(0, 500) } : {}) };
}

/** Delivers one item through the local server and records the outcome; an id seen before is answered from the ledger. */
export async function processIngressItem(item: IngressItem, deps: IngressDeps): Promise<IngressAck> {
  const known = deps.ledger.known(item.id);
  if (known) {
    // The cloud sent it again (it may have missed the acknowledgement): answer again, never run it twice.
    deps.ledger.record(known);
    return known;
  }
  let ack: IngressAck;
  if (!deps.enabled()) ack = { id: item.id, outcome: "rejected", http_status: 503, code: "ingress_disabled", reason: "cloud.ingress is false on this machine" };
  else {
    const base = deps.baseUrl();
    if (!base) ack = { id: item.id, outcome: "error", http_status: 503, code: "server_not_listening", reason: "the local server is not listening" };
    else ack = await deliver(item, base, deps);
  }
  deps.ledger.record(ack);
  deps.logger.info("hosted-ingress delivery processed", { ingress: item.id, skill: item.skill, outcome: ack.outcome, http_status: ack.http_status, job: ack.job_id });
  return ack;
}

async function deliver(item: IngressItem, base: string, deps: IngressDeps): Promise<IngressAck> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(item.headers)) {
    const key = name.toLowerCase();
    if (DROPPED_HEADERS.has(key)) continue;
    headers[key] = value;
  }
  headers["x-forwarded-for"] = item.source_ip;
  headers[INGRESS_ID_HEADER] = item.id;
  const body = Buffer.from(item.body_base64, "base64");
  if (!headers["content-type"] && item.content_type) headers["content-type"] = item.content_type;
  const query = new URLSearchParams(item.query);
  query.delete("wait"); // never wait on a hosted delivery
  const url = `${base}/hooks/${encodeURIComponent(item.skill)}${query.size ? `?${query.toString()}` : ""}`;
  try {
    const response = await (deps.fetchImpl ?? fetch)(url, { method: item.method, headers, body: body as unknown as NonNullable<Parameters<typeof fetch>[1]>["body"], signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    let parsed: Record<string, unknown> | undefined;
    try {
      const json = JSON.parse(text) as unknown;
      parsed = json && typeof json === "object" ? (json as Record<string, unknown>) : undefined;
    } catch {
      parsed = undefined;
    }
    return ackFor(item, response.status, parsed);
  } catch (error) {
    return { id: item.id, outcome: "error", http_status: 503, code: "local_delivery_failed", reason: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
  }
}
