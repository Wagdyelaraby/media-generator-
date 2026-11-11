import { dbHealthy, ensureSchema } from "@/lib/turso";
import { listModelsForHealth } from "@/lib/models";
import { mergerBase, mergerHealthy } from "@/lib/merger";

/** فحص جهوزية السيرفر: قاعدة Turso + خدمة الدمج + الموديلات + حالة الحماية */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let database: string = "turso-disconnected";
  let ok = false;
  try {
    await ensureSchema();
    ok = await dbHealthy();
    if (ok) database = "turso-connected";
  } catch {
    ok = false;
  }

  const mergerHealthyResult = await mergerHealthy().catch(() => false);

  return Response.json(
    {
      ok,
      database,
      mcpEndpoint: "/mcp",
      models: listModelsForHealth(),
      merger: { base: mergerBase(), healthy: mergerHealthyResult },
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
    },
    { status: ok ? 200 : 503 }
  );
}
