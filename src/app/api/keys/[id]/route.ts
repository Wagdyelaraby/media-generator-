import { setManualStatus, deleteKey } from "@/lib/keys";

/** تعطيل/تنشيط يدوي وحذف مفتاح بالمعرّف */
export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { status?: string };
    if (body.status !== "active" && body.status !== "disabled") {
      return Response.json(
        { error: "الحالة المقبولة يدويًا: active أو disabled فقط" },
        { status: 400 }
      );
    }
    const updated = await setManualStatus(id, body.status);
    if (!updated) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
    return Response.json({ ok: true, id, status: body.status });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "خطأ غير متوقع" },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const deleted = await deleteKey(id);
    if (!deleted) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
    return Response.json({ ok: true, id });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "خطأ غير متوقع" },
      { status: 500 }
    );
  }
}
