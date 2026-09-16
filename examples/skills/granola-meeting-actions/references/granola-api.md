# Granola API notes for this skill

Only what the skill relies on. Granola's own reference (linked from the app's API and webhook settings) is authoritative if a field differs.

## Base URL and auth

- Base URL: `https://public-api.granola.ai/v1`
- Header: `Authorization: Bearer $GRANOLA_API_KEY` — keys start with `grn_`
- JSON in, JSON out

## Webhook deliveries (what triggers the skill)

Granola signs webhooks with the [Standard Webhooks](https://www.standardwebhooks.com/) scheme. skillhook verifies the signature before the skill runs (`auth: { type: granola }`); the signature headers are stripped before the agent sees the request.

| Header | Meaning |
| --- | --- |
| `webhook-id` | unique delivery id |
| `webhook-timestamp` | unix seconds; skillhook rejects deliveries more than 5 minutes old (`tolerance_seconds`) |
| `webhook-signature` | `v1,<base64 HMAC-SHA256>` over `id.timestamp.body`, keyed with the `whsec_…` secret |

Events: `note.generated`, `note.edited`, `note.access_granted`.

Payload — identifiers only, never note content:

```json
{
  "event_id": "…",
  "event_type": "note.generated",
  "note_id": "…",
  "occurred_at": "2026-09-15T14:32:10Z"
}
```

`note.edited` adds `data.changed_fields` (the fields that changed). The skill filters on `event_type` and de-duplicates on `note_id`, so edits never start a second run within 24 hours.

## Fetching a note

```bash
curl -sS "https://public-api.granola.ai/v1/notes/$NOTE_ID" \
  -H "Authorization: Bearer $GRANOLA_API_KEY" | tee "$SKILLHOOK_JOB_DIR/note.json"
```

Read the JSON you actually receive rather than assuming names. Look for:

- the meeting **title** and **time**
- **attendees / participants**, usually with `name` and `email` — the only acceptable source of invitee addresses
- the generated **notes / summary** (Markdown or HTML) and, when Granola produced one, an explicit **action items** section
- the **transcript**, inline or behind its own link or sub-resource of the note (check the response for a `transcript` field or URL)
- the note's **URL** / share link, for event and task descriptions

If the notes are HTML, strip the tags before reasoning about them. Save anything you fetch under `$SKILLHOOK_JOB_DIR` so a human can audit the run.

## Managing webhook endpoints

In the app: Settings → Connectors → Webhooks. With the API, the same resource is `https://public-api.granola.ai/v1/webhook-endpoints`:

```bash
# list the endpoints this key can see
curl -sS https://public-api.granola.ai/v1/webhook-endpoints \
  -H "Authorization: Bearer $GRANOLA_API_KEY"
```

`POST` to the same path creates one (the URL to call and the event types to subscribe to, in the shape Granola's reference documents). The response — like the app — shows the signing secret exactly once: `whsec_` followed by base64. Put it into skillhook immediately with `skillhook secret set GRANOLA_WEBHOOK_SECRET`; if it is lost, create a new endpoint.

## Errors worth handling

| Status | Meaning for the skill |
| --- | --- |
| 401 | key missing or revoked — report, do not retry |
| 403 | key has no access to this note — report |
| 404 | note not found or not visible to this key — report |
| 429 | rate limited — wait for `Retry-After`, retry once |
