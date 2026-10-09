// `skillhook mcp --cloud`, the `skillhook-cloud` MCP server of the skillhook plugin: Skillhook Cloud's operations as
// tools for the agent on this computer. The tools are the cloud's own catalogue (src/cloud/tools.ts), fetched when the
// server starts with the organisation API key that `skillhook cloud login` keeps in .env, each one forwarded to
// `POST /api/v1/tools/<name>`, where the cloud validates, authorises and audits it as that key. One more, generate_secret,
// needs a key pair only a local process can hold (src/cloud/remote-secret.ts). Without a key, or while the cloud cannot
// be reached, the server offers one tool, skillhook_cloud_setup, which says what is missing and loads the tools once it
// is fixed. Without a key (or with one the cloud refused) it signs in with the browser as `skillhook cloud login` does
// (src/cloud/login.ts): it opens the person's browser on this computer and gives the agent the link and the code to
// show; the person approves on the cloud, the key goes into .env, and the tools load. The agent never handles the key,
// and it cannot choose the cloud: the sign-in goes where the key would (the one kept with it, else the machine's).
import { fromJsonSchema, McpServer, type JsonSchemaType, type JsonSchemaValidator, type jsonSchemaValidator } from "@modelcontextprotocol/server";
import { z } from "zod";
import { loadConfig } from "../config.js";
import type { Paths } from "../paths.js";
import { errorMessage } from "../util.js";
import { VERSION } from "../version.js";
import { API_KEY_RE, CloudApiError, fleetClient, keepApiKey, storedApiCredentials, type FleetClient } from "./api.js";
import { CLOUD_API_KEY_ENV, DEFAULT_CLOUD_URL, resolveCloudUrl } from "./config.js";
import { browserLogin, openBrowser, type SignInPrompt } from "./login.js";
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

/** Tools this server makes itself: a catalogue tool of the same name never replaces them (generate_secret must stay sealed end to end). */
const LOCAL_TOOLS = new Set(["generate_secret", "skillhook_cloud_setup"]);

const LOGIN_HINT = `To connect, call skillhook_cloud_setup: it signs in with the browser, opening the person's browser on this computer, and returns the link and a code to show them; they approve it on Skillhook Cloud (as an admin or owner of the organisation, choosing the access: read to look, run to also answer agents and run skills, admin to also change skills and settings), the key goes straight into skillhook's .env and the tools load. In a terminal, \`skillhook cloud login\` does the same (with \`--url https://…\` for a Skillhook Cloud other than ${DEFAULT_CLOUD_URL}). Never ask the person to paste a key into this conversation.`;

/** `code` and `status`: the CloudApiError's, so the setup tool knows whether signing in would help. */
export type CloudConnection = { client: FleetClient; catalog: Catalog } | { problem: string; code?: string; status?: number };

export interface CloudMcpOptions {
  /** Opens the sign-in page in the person's browser (`serveCloudMcp`); without it the agent only gets the link to show. */
  openUrl?: (url: string) => boolean;
  /** How a sign-in waits between polls (tests pass their own). */
  sleep?: (ms: number) => Promise<void>;
}

/** How long the server waits for the catalogue when it starts: an MCP client waits for the server meanwhile. */
const CATALOG_TIMEOUT_MS = 8_000;

/** The key and URL this home keeps, and the catalogue the cloud offers that key; or why there is none. */
export async function connectCloud(paths: Paths, env: NodeJS.ProcessEnv): Promise<CloudConnection> {
  try {
    const client = fleetClient(env, loadConfig(paths).cloud, storedApiCredentials(paths, env));
    return { client, catalog: await fetchCatalog(client, { timeoutMs: CATALOG_TIMEOUT_MS }) };
  } catch (error) {
    return { problem: errorMessage(error), ...(error instanceof CloudApiError ? { ...(error.code ? { code: error.code } : {}), ...(error.status !== undefined ? { status: error.status } : {}) } : {}) };
  }
}

/** A sign-in fixes a missing or malformed key, and one the cloud refused; not the kill switch, plain http or a cloud out of reach. */
function signInHelps(problem: { code?: string; status?: number }): boolean {
  return problem.code === "no_key" || problem.code === "invalid_key" || problem.status === 401;
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
export function buildCloudMcpServer(paths: Paths, env: NodeJS.ProcessEnv, connection: CloudConnection, options: CloudMcpOptions = {}): McpServer {
  const connected = "catalog" in connection;
  const server = new McpServer(
    { name: "skillhook-cloud", version: VERSION },
    { capabilities: { tools: {} }, instructions: connected ? instructionsFor(connection.catalog) : `Skillhook Cloud is not connected on this computer: ${connection.problem}\n${LOGIN_HINT}` },
  );

  const install = (client: FleetClient, catalog: Catalog) => {
    for (const tool of catalog.tools) {
      if (tool.allowed === false || LOCAL_TOOLS.has(tool.name)) continue;
      try {
        server.registerTool(tool.name, { title: tool.title ?? undefined, description: tool.description, inputSchema: fromJsonSchema(tool.input_schema as JsonSchemaType, SHOWN_ONLY), annotations: ANNOTATIONS[tool.kind ?? ""] ?? ANNOTATIONS.write }, async (input: unknown) => {
          try {
            return ok(await callTool(client, tool.name, (input ?? {}) as Record<string, unknown>));
          } catch (error) {
            return fail(error);
          }
        });
      } catch {
        // A tool the MCP server cannot offer is left out, like one the catalogue could not read: the others still work.
      }
    }
    if (generatesSecrets(catalog)) {
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
  const connectedResult = (connection: { client: FleetClient; catalog: Catalog }) =>
    ok({ connected: true, organisation: connection.catalog.organisation ?? null, key: connection.catalog.key ?? null, tools: connection.catalog.tools.filter((tool) => tool.allowed !== false).length }, `Connected to ${connection.client.url}: the Skillhook Cloud tools are listed now (describe_cloud first). If your client does not show them, reconnect this MCP server.`);

  // One browser sign-in at a time. When the person approves, the key is kept and the tools load at once; the setup tool
  // stays until it is called again, to say so (an agent checking on the sign-in should not find it gone).
  type SignIn = { url: string; prompt?: SignInPrompt; opened: boolean; state: "waiting" | "connected" | "failed"; connection?: { client: FleetClient; catalog: Catalog }; failure?: string; done: Promise<void> };
  let signIn: SignIn | undefined;
  const waitFor = async (current: SignIn, seconds: number | undefined) => {
    if (current.state !== "waiting" || !seconds) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([current.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, seconds * 1000)))]);
    clearTimeout(timer);
  };
  const startSignIn = async (): Promise<SignIn> => {
    const url = resolveCloudUrl(env, loadConfig(paths).cloud, storedApiCredentials(paths, env).url);
    let prompted!: () => void;
    const shown = new Promise<void>((resolve) => (prompted = resolve));
    const current: SignIn = { url, opened: false, state: "waiting", done: Promise.resolve() };
    current.done = browserLogin({
      url,
      env,
      sleep: options.sleep,
      onPrompt: (prompt) => {
        current.prompt = prompt;
        current.opened = Boolean(options.openUrl?.(prompt.url));
        prompted();
      },
    })
      .then(async ({ key }) => {
        if (!API_KEY_RE.test(key)) throw new CloudApiError(`${url} handed over something that is not an organisation API key; nothing was kept`);
        keepApiKey(paths, key, url);
        const again = await connectCloud(paths, env);
        if ("problem" in again) throw new CloudApiError(again.problem);
        install(again.client, again.catalog);
        current.connection = again;
        current.state = "connected";
      })
      .catch((error: unknown) => {
        current.failure = errorMessage(error);
        current.state = "failed";
      })
      .finally(() => prompted());
    signIn = current;
    await shown;
    return current;
  };
  const report = (current: SignIn): ToolResult => {
    if (current.state === "connected" && current.connection) {
      setup.remove();
      return connectedResult(current.connection);
    }
    if (current.state === "failed" || !current.prompt) {
      signIn = undefined;
      return fail(new CloudApiError(`${current.failure ?? "The sign-in did not start."}\nCall skillhook_cloud_setup again to start a new one.`));
    }
    const { prompt } = current;
    const minutes = Math.max(1, Math.round(prompt.expiresInSeconds / 60));
    return ok(
      { connected: false, signing_in: true, cloud: current.url, url: prompt.url, code: prompt.code, browser_opened: current.opened, expires_in_seconds: prompt.expiresInSeconds },
      `Signing in to ${current.url}. ${current.opened ? "The sign-in page is open in the person's browser on this computer" : "Give the person this link, to open in a browser where they can sign in"}: ${prompt.url}\nIt must show the code ${prompt.code}; they check that and approve (an admin or owner of the organisation, choosing the access). The code expires in ${minutes} minutes, and the key goes straight into skillhook's .env, never through this conversation. Call skillhook_cloud_setup again once they approved (wait_seconds: 60 waits for it); the Skillhook Cloud tools load as soon as they do.`,
    );
  };

  const setup = server.registerTool(
    "skillhook_cloud_setup",
    {
      title: "Connect Skillhook Cloud",
      description: `Connects the Skillhook Cloud tools on this computer: says what is missing, signs in with the browser when there is no working key (it opens the person's browser and returns the link and a code to show them), and loads the tools once it works. Call it again to see whether the person approved, or with wait_seconds to wait for that. ${LOGIN_HINT}`,
      inputSchema: z.object({ wait_seconds: z.number().int().min(0).max(120).optional().describe("Wait up to this long for the person to approve a sign-in that is under way") }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ wait_seconds }) => {
      if (signIn) {
        await waitFor(signIn, wait_seconds);
        return report(signIn);
      }
      // Logged in some other way meanwhile: a terminal, the environment.
      const again = await connectCloud(paths, env);
      if (!("problem" in again)) {
        setup.remove();
        install(again.client, again.catalog);
        return connectedResult(again);
      }
      if (!signInHelps(again)) return fail(new CloudApiError(`${again.problem}\n${LOGIN_HINT}`));
      if (env[CLOUD_API_KEY_ENV]?.trim()) return fail(new CloudApiError(`${again.problem}\n${CLOUD_API_KEY_ENV} is set in this MCP server's environment and wins over a key kept by signing in: fix it there, or remove it and call skillhook_cloud_setup again.`));
      const current = await startSignIn();
      await waitFor(current, wait_seconds);
      return report(current);
    },
  );
  return server;
}

export async function serveCloudMcp(paths: Paths, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const connection = await connectCloud(paths, env);
  if ("problem" in connection) console.error(`[skillhook mcp --cloud] not connected: ${connection.problem}`);
  const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
  serveStdio(() => buildCloudMcpServer(paths, env, connection, { openUrl: (url) => openBrowser(url, env) }), { onerror: (error) => console.error(`[skillhook mcp --cloud] ${error.message}`) });
}
