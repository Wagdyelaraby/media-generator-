import { listRecentTasks, taskStats, taskResultUrls, taskAttempts } from "@/lib/tasks";
import { ensureSchema } from "@/lib/turso";

/** قائمة أحدث المهام للوحة المتابعة الحية + الإحصائيات */
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    await ensureSchema();
    const url = new URL(req.url);
    const type = url.searchParams.get("type") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const limit = Number(url.searchParams.get("limit") || 20);

    const [tasks, stats] = await Promise.all([
      listRecentTasks(Math.min(Math.max(limit, 1), 50), { type, status }),
      taskStats(),
    ]);

    return Response.json({
      stats,
      tasks: tasks.map((t) => ({
        id: t.id,
        provider: t.provider,
        model: t.model,
        type: t.type,
        status: t.status,
        progress: t.progress,
        prompt: t.prompt.slice(0, 160),
        resultUrls: taskResultUrls(t).filter((u) => !u.startsWith("data:")),
        errorMessage: t.errorMessage,
        attempts: taskAttempts(t).length,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
      })),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "خطأ غير متوقع" },
      { status: 500 }
    );
  }
}
