import { ProviderError, type ProviderAdapter, type ProviderCheckResult, type TaskInput } from "./types";

/**
 * موائم CometAPI — وفق التوثيق الرسمي المقاس (apidoc.cometapi.com):
 * - الصور: POST /v1/images/generations (متوافق OpenAI، متزامن) → data[].url أو data[].b64_json
 * - الفيديو: POST /grok/v1/videos/generations {model:"grok-imagine-video-1.5", prompt, ...}
 *   → يُعاد request_id فورًا ثم GET /grok/v1/videos/{request_id}
 *     {status:"pending|done|failed|expired", progress?, video:{url}}
 */
const BASE = "https://api.cometapi.com";

async function cometRequest(key: string, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000), // الصور المتزامنة قد تأخذ وقتًا
    });
  } catch (err) {
    throw new ProviderError(undefined, err instanceof Error ? err.message : String(err), "temporary");
  }
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg =
      (body?.error as { message?: string } | undefined)?.message ||
      (body?.message as string) ||
      (body?.msg as string) ||
      (text ? text.slice(0, 300) : "") ||
      `HTTP ${res.status}`;
    throw new ProviderError(res.status, String(msg));
  }
  return body ?? {};
}

/** تحويل نسبة العرض إلى أقرب مقاس مدعوم في نقطة OpenAI المتوافقة */
function aspectToSize(aspectRatio?: string): string | undefined {
  switch (aspectRatio) {
    case "1:1":
      return "1024x1024";
    case "3:2":
    case "4:3":
    case "5:4":
    case "16:9":
    case "2:1":
    case "21:9":
    case "3:1":
      return "1536x1024";
    case "2:3":
    case "3:4":
    case "4:5":
    case "9:16":
    case "1:2":
    case "9:21":
    case "1:3":
      return "1024x1536";
    default:
      return undefined; // auto — لا يُرسل شيء
  }
}

function extractUrls(body: Record<string, unknown>, outputFormat: string): string[] {
  const data = body.data;
  const urls: string[] = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      const rec = item as Record<string, unknown>;
      if (typeof rec.url === "string" && rec.url) {
        urls.push(rec.url);
      } else if (typeof rec.b64_json === "string" && rec.b64_json) {
        // المزود أعاد الصورة مضمّنة base64 — نحوّلها إلى data URI (بلا تنزيل أي ملف)
        urls.push(`data:image/${outputFormat};base64,${rec.b64_json}`);
      }
    }
  }
  return urls;
}

export const cometApiAdapter: ProviderAdapter = {
  async createTask(key, input): Promise<{ providerTaskId: string }> {
    // فيديو Grok: الشكل الموثق — image يتلقى كائن {url} وليس نصًا
    const body: Record<string, unknown> = { model: input.model, prompt: input.prompt };
    if (input.imageUrl) body.image = { url: input.imageUrl };
    if (input.aspectRatio && input.aspectRatio !== "auto") body.aspect_ratio = input.aspectRatio;
    if (input.resolution && input.resolution !== "auto") body.resolution = input.resolution;
    if (input.duration) body.duration = input.duration;
    const res = await cometRequest(key, "/grok/v1/videos/generations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const id =
      (res.request_id as string) ??
      (res.task_id as string) ??
      ((res.data as Record<string, unknown> | undefined)?.request_id as string) ??
      ((res.data as Record<string, unknown> | undefined)?.task_id as string);
    if (!id || typeof id !== "string") {
      throw new ProviderError(200, "لم يُعَد request_id من CometAPI", "temporary");
    }
    return { providerTaskId: id };
  },

  async createImageSync(key, input): Promise<{ urls: string[] }> {
    // صور متزامنة عبر النقطة المتوافقة مع OpenAI — نرسل فقط الحقول الموثقة
    const body: Record<string, unknown> = { model: input.model, prompt: input.prompt };
    const size = aspectToSize(input.aspectRatio);
    if (size) body.size = size;
    if (input.background && input.background !== "auto") body.background = input.background;
    if (input.outputFormat && input.outputFormat !== "png") body.output_format = input.outputFormat;
    const res = await cometRequest(key, "/v1/images/generations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const urls = extractUrls(res, input.outputFormat || "png");
    if (urls.length === 0) {
      throw new ProviderError(200, "لم يُعَد أي رابط صورة من CometAPI", "temporary");
    }
    return { urls };
  },

  async checkTask(key, providerTaskId): Promise<ProviderCheckResult> {
    const res = await cometRequest(key, `/grok/v1/videos/${encodeURIComponent(providerTaskId)}`);
    const status = String(res.status ?? "").toLowerCase();
    if (status === "done" || status === "succeeded" || status === "completed" || status === "success") {
      const video = res.video as { url?: string } | undefined;
      const url =
        video?.url ||
        (res.video_url as string) ||
        ((res.data as Record<string, unknown> | undefined)?.video_url as string);
      if (!url || typeof url !== "string") {
        return { status: "failed", error: "اكتملت المهمة لدى CometAPI دون رابط فيديو" };
      }
      return { status: "completed", urls: [url], progress: 100 };
    }
    if (status === "failed" || status === "expired" || status === "error") {
      const errObj = res.error as { message?: string } | undefined;
      return {
        status: "failed",
        error: errObj?.message || (res.error as string) || "فشل توليد الفيديو لدى CometAPI",
      };
    }
    // pending أو أي حالة أخرى — progress أحيانًا كسر 0..1 وأحيانًا نسبة
    let progress: number | undefined;
    const raw = res.progress;
    if (typeof raw === "number") progress = raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
    return { status: "processing", progress };
  },
};
