import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../logger.js";
import { tempHome } from "../test-support/helpers.js";
import { processIngressItem } from "./ingress.js";
import { IngressLedger } from "./outbox.js";
import type { IngressItem } from "./protocol.js";

const item: IngressItem = {
  id: "hosted-delivery-1", skill: "diagnostic", received_at: "2026-10-15T12:00:00Z",
  method: "POST", path: "/hooks/diagnostic", query: {}, headers: { "request-id": "provider-delivery-1" },
  body_base64: Buffer.from("{}").toString("base64"), content_type: "application/json", source_ip: "192.0.2.1",
};

function fixture(fetchImpl: typeof fetch) {
  const ledger = new IngressLedger(tempHome("skillhook-ingress-retry-").jobsDir);
  return { ledger, fetchImpl, baseUrl: () => "http://127.0.0.1:8787", enabled: () => true, logger: silentLogger };
}

describe("hosted ingress acknowledgement contract", () => {
  it("leaves a lost local response unacknowledged, then accepts and deduplicates the cloud redelivery", async () => {
    const send = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValue(new Response(JSON.stringify({ job_id: "job-1", duplicate: true }), { status: 200 }));
    const deps = fixture(send);
    expect(await processIngressItem(item, deps)).toMatchObject({ code: "local_delivery_failed" });
    expect(deps.ledger.pendingAcks(10)).toEqual([]);
    expect(deps.ledger.known(item.id)).toBeUndefined();
    expect(await processIngressItem(item, deps)).toMatchObject({ outcome: "duplicate", job_id: "job-1" });
    await processIngressItem(item, deps);
    expect(send).toHaveBeenCalledTimes(2);
    expect(deps.ledger.pendingAcks(10)).toHaveLength(1);
  });

  it("defers while the local listener is unavailable", async () => {
    const send = vi.fn<typeof fetch>();
    const deps = fixture(send);
    expect(await processIngressItem(item, { ...deps, baseUrl: () => undefined })).toMatchObject({ code: "server_not_listening" });
    expect(deps.ledger.pendingAcks(10)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([429, 500, 502, 503, 504])("does not finalize a transient HTTP %s", async (status) => {
    const deps = fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status })));
    await processIngressItem(item, deps);
    expect(deps.ledger.pendingAcks(10)).toEqual([]);
    expect(deps.ledger.known(item.id)).toBeUndefined();
  });

  it.each([{ status: 401, code: "invalid_signature" }, { status: 429, code: "too_many_failures" }, { status: 503, code: "skill_not_configured" }])("keeps terminal rejection $status/$code terminal", async ({ status, code }) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: code }), { status }));
    const deps = fixture(send);
    await processIngressItem(item, deps);
    await processIngressItem(item, deps);
    expect(deps.ledger.pendingAcks(10)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("acknowledges an explicit local ingress opt-out instead of retrying it", async () => {
    const deps = fixture(vi.fn<typeof fetch>());
    expect(await processIngressItem(item, { ...deps, enabled: () => false })).toMatchObject({ code: "ingress_disabled" });
    expect(deps.ledger.pendingAcks(10)).toHaveLength(1);
  });
});
