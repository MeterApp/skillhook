// `skillhook mcp --cloud`, the `skillhook-cloud` MCP server of the skillhook plugin: Skillhook Cloud's operations as
// tools for the agent on this computer. The tools are the cloud's own catalogue (src/cloud/tools.ts), fetched when the
// server starts with the organisation API key that `skillhook cloud login` keeps in .env, each one forwarded to
// `POST /api/v1/tools/<name>`, where the cloud validates, authorises and audits it as that key. One more, generate_secret,
// needs a key pair only a local process can hold (src/cloud/remote-secret.ts). Without a key, or while the cloud cannot
// be reached, the server offers one tool, skillhook_cloud_setup, which says what is missing and loads the tools once it
// is fixed. Logging in stays with the person, in a terminal: an agent never handles the key.
import { fromJsonSchema, McpServer, type JsonSchemaType, type JsonSchemaValidator, type jsonSchemaValidator } from "@modelcontextprotocol/server";
import { z } from "zod";
import { loadConfig } from "../config.js";
import type { Paths } from "../paths.js";
import { errorMessage } from "../util.js";
import { VERSION } from "../version.js";
import { CloudApiError, fleetClient, storedApiKey, type FleetClient } from "./api.js";
import { generateRemoteSecret, secretNameFor } from "./remote-secret.js";
import { callTool, fetchCatalog, type Catalog } from "./tools.js";

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(data: Record<string, unknown>, summary?: string): ToolResult {
  return { content: [{ type: "text", text: `${summary ? `${summary}\n\n` : ""}${JSON.stringify(data, null, 2)}` }], structuredContent: data };
}

function fail(error: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${errorMessage(error)}` }], isError: true };
}

/** The cloud validates every input against its own schema; here the schema is what the client is shown. */
const SHOWN_ONLY: jsonSchemaValidator = { getValidator: <T,>(): JsonSchemaValidator<T> => (data) => ({ valid: true, data: data as T, errorMessage: undefined }) };

const ANNOTATIONS: Record<string, { readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint: boolean }> = {
  read: { readOnlyHint: true, openWorldHint: true },
  write: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  destructive: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};

const LOGIN_HINT = "The person logs in once, in a terminal: `skillhook cloud login --url https://<their Skillhook Cloud>`, pasting an organisation API key from the dashboard (Settings → API keys; fleet:read to look, fleet:run to also answer agents and run skills, fleet:admin to also change skills and settings). Never ask them to paste the key into this conversation.";

export type CloudConnection = { client: FleetClient; catalog: Catalog } | { problem: string };

/** The key and URL this home keeps, and the catalogue the cloud offers that key; or why there is none. */
export async function connectCloud(paths: Paths, env: NodeJS.ProcessEnv): Promise<CloudConnection> {
  try {
    const client = fleetClient(env, loadConfig(paths).cloud, storedApiKey(paths, env));
    return { client, catalog: await fetchCatalog(client) };
  } catch (error) {
    return { problem: errorMessage(error) };
  }
}

function instructionsFor(catalog: Catalog): string {
  const key = catalog.key;
  return [
    `Skillhook Cloud for ${catalog.organisation?.name ?? "this organisation"} (key "${key?.name ?? "?"}": ${key?.scopes?.join(", ") || key?.role || "?"}), through skillhook on this computer. These tools act on every machine of the organisation; the separate skillhook server is this computer's own skillhook.`,
    catalog.instructions ?? "",
    generatesSecrets(catalog) ? "generate_secret creates a skill's secret on a machine and returns it here once, sealed end to end (the cloud never sees it): for configuring the webhook sender." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function generatesSecrets(catalog: Catalog): boolean {
  return Boolean(catalog.key?.scopes?.includes("fleet:admin") || catalog.key?.role === "admin");
}

/** The server for one connection: the catalogue's tools when connected, else the setup tool that connects. */
export function buildCloudMcpServer(paths: Paths, env: NodeJS.ProcessEnv, connection: CloudConnection): McpServer {
  const connected = "catalog" in connection;
  const server = new McpServer(
    { name: "skillhook-cloud", version: VERSION },
    { capabilities: { tools: {} }, instructions: connected ? instructionsFor(connection.catalog) : `Skillhook Cloud is not connected on this computer: ${connection.problem}\nskillhook_cloud_setup checks again and loads the cloud's tools once it works. ${LOGIN_HINT}` },
  );

  const install = (client: FleetClient, catalog: Catalog) => {
    for (const tool of catalog.tools) {
      if (tool.allowed === false) continue;
      server.registerTool(tool.name, { title: tool.title ?? undefined, description: tool.description, inputSchema: fromJsonSchema(tool.input_schema as JsonSchemaType, SHOWN_ONLY), annotations: ANNOTATIONS[tool.kind ?? ""] ?? ANNOTATIONS.write }, async (input: unknown) => {
        try {
          return ok(await callTool(client, tool.name, (input ?? {}) as Record<string, unknown>));
        } catch (error) {
          return fail(error);
        }
      });
    }
    if (generatesSecrets(catalog) && !catalog.tools.some((tool) => tool.name === "generate_secret")) {
      server.registerTool(
        "generate_secret",
        {
          title: "Generate a skill's secret on a machine",
          description: "Generate the secret of a skill on a machine of the organisation (the webhook sender signs with it, or sends it as a bearer token) and return the value here once. The machine seals it to a key pair made for this call on this computer, so the cloud never sees it. It is stored in the machine's .env; an existing one is kept unless force, which replaces it (the old value stops working). Give the value to the person for the sender's configuration; do not repeat it anywhere else.",
          inputSchema: z.object({ machine: z.string().min(1).describe("Machine id or name"), skill: z.string().min(1).describe("The skill (its secret variable comes from the machine), or the variable itself, like SKILLHOOK_SECRET_HELLO"), force: z.boolean().optional().describe("Replace an existing secret") }),
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        },
        async ({ machine, skill, force }) => {
          try {
            const name = await secretNameFor(client, machine, skill);
            const made = await generateRemoteSecret(client, { machine, name, force });
            return made.secret === null ? ok({ ...made }, `${made.machine} already has ${name}; force: true replaces it (the sender then needs the new value).`) : ok({ ...made }, `${name} on ${made.machine} (shown once):`);
          } catch (error) {
            return fail(error);
          }
        },
      );
    }
  };

  if (connected) {
    install(connection.client, connection.catalog);
    return server;
  }
  const setup = server.registerTool(
    "skillhook_cloud_setup",
    { title: "Connect Skillhook Cloud", description: `Why the Skillhook Cloud tools are missing on this computer, and a new attempt to load them (call it again after the person logged in). ${LOGIN_HINT}`, inputSchema: z.object({}), annotations: { readOnlyHint: true, openWorldHint: true } },
    async () => {
      const again = await connectCloud(paths, env);
      if ("problem" in again) return fail(new CloudApiError(`${again.problem}\n${LOGIN_HINT}`));
      setup.remove();
      install(again.client, again.catalog);
      return ok({ connected: true, organisation: again.catalog.organisation ?? null, key: again.catalog.key ?? null, tools: again.catalog.tools.filter((tool) => tool.allowed !== false).length }, `Connected to ${again.client.url}: the Skillhook Cloud tools are listed now (describe_cloud first). If your client does not show them, reconnect this MCP server.`);
    },
  );
  return server;
}

export async function serveCloudMcp(paths: Paths, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const connection = await connectCloud(paths, env);
  if ("problem" in connection) console.error(`[skillhook mcp --cloud] not connected: ${connection.problem}`);
  const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
  serveStdio(() => buildCloudMcpServer(paths, env, connection), { onerror: (error) => console.error(`[skillhook mcp --cloud] ${error.message}`) });
}
