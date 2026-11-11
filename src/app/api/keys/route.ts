import { listKeys, addKey } from "@/lib/keys";

/** إدارة المفاتيح للواجهة — القائمة مقنَّعة دائمًا ولا يُعاد المفتاح الكامل في أي استجابة */
export const runtime = "nodejs";

export async function GET() {
  try {
    const keys = await listKeys();
    return Response.json({ keys });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "خطأ غير متوقع" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { provider?: string; api_key?: string; label?: string };
    const provider = (body.provider || "").trim();
    const apiKey = (body.api_key || "").trim();
    const label = (body.label || "").trim();

    if (provider !== "kie" && provider !== "cometapi") {
      return Response.json({ error: "المزود غير صالح — القيم المقبولة: kie أو cometapi" }, { status: 400 });
    }
    if (!apiKey) {
      return Response.json({ error: "المفتاح مطلوب" }, { status: 400 });
    }

    const result = await addKey(provider, apiKey, label);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 409 });
    }
    return Response.json({ key: result.key }, { status: 201 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "خطأ غير متوقع" },
      { status: 500 }
    );
  }
}
