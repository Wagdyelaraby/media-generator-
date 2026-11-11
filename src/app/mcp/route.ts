import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "@/lib/mcpServer";

/**
 * خادم MCP على /mcp — نقل Streamable HTTP عبر SDK الرسمي (McpServer + النقل القياسي للويب).
 * runtime="nodejs" + dynamic="force-dynamic" إلزاميان للبث الحي.
 * الوضع عديم الجلسة (sessionIdGenerator: undefined) — لا حالة في الذاكرة،
 * وهو الأنسب لبيئة Vercel السيرفرلس حيث قد تتوزع الطلبات على نوى مختلفة.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نافذة الانتظار قد تمتد حتى 240 ثانية — حد أقصى مدة الدالة على Vercel
export const maxDuration = 300;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Session-Id, Mcp-Session-Id, Last-Event-Id",
  "Access-Control-Expose-Headers": "MCP-Session-Id, Mcp-Session-Id",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: Bearer token required" }, id: null }),
    { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
}

async function handleMcp(req: Request): Promise<Response> {
  // حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token>
  const requiredToken = process.env.MCP_ACCESS_TOKEN;
  if (requiredToken) {
    const provided = req.headers.get("authorization");
    if (provided !== `Bearer ${requiredToken}`) return unauthorized();
  }

  // نقل جديد لكل طلب في الوضع عديم الجلسة — بلا ملفات أو حالة دائمة
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = buildMcpServer();
  await server.connect(transport);

  try {
    const response = await transport.handleRequest(req);
    return withCors(response);
  } catch (err) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32700, message: `خطأ داخلي: ${err instanceof Error ? err.message : String(err)}` },
        id: null,
      }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
}

export async function POST(req: Request) {
  return handleMcp(req);
}

// GET لفتح مجرى SSE من السيرفر — لا نستخدمه في الوضع عديم الجلسة؛ النقل يرد 405 بنفسه
export async function GET(req: Request) {
  return handleMcp(req);
}

// DELETE لإنهاء الجلسة — في الوضع عديم الجلسة لا يوجد ما يُنهى والنقل يرد بنفسه
export async function DELETE(req: Request) {
  return handleMcp(req);
}
