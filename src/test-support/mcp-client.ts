// A minimal JSON-RPC client over the MCP SDK's in-memory transport, for testing MCP servers in-process (the SDK's client
// package is not a dependency).
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";

type Message = Record<string, unknown> & { id?: number; result?: Record<string, unknown>; error?: { message: string } };

export interface McpToolResult {
  text: string;
  data: Record<string, unknown>;
  isError: boolean;
}

export interface McpTestClient {
  init: Message;
  request(method: string, params?: Record<string, unknown>): Promise<Message>;
  call(name: string, args?: Record<string, unknown>): Promise<McpToolResult>;
  tools(): Promise<string[]>;
  close(): Promise<void>;
}

export async function connectMcp(server: McpServer): Promise<McpTestClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (message: Message) => void>();
  clientSide.onmessage = (message) => {
    const m = message as Message;
    if (typeof m.id === "number" && pending.has(m.id)) pending.get(m.id)?.(m);
  };
  await clientSide.start();
  await server.connect(serverSide);
  let seq = 0;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Message>((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      void clientSide.send({ jsonrpc: "2.0", id, method, params });
    });
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    init,
    request,
    async call(name, args = {}) {
      const response = await request("tools/call", { name, arguments: args });
      if (response.error) throw new Error(response.error.message);
      const result = response.result as { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
      return { text: result.content.map((c) => c.text).join("\n"), data: result.structuredContent ?? {}, isError: result.isError === true };
    },
    async tools() {
      const listed = (await request("tools/list")).result as { tools: { name: string }[] };
      return listed.tools.map((t) => t.name).sort();
    },
    close: () => clientSide.close(),
  };
}
