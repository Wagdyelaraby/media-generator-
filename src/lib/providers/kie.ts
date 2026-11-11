import { ProviderError, type ProviderAdapter, type ProviderCheckResult, type TaskInput } from "./types";
import { classifyProviderError } from "../classify";

/**
 * موائم kie.ai — Jobs API الموحد (الشكل الحقيقي المقاس):
 * POST /api/v1/jobs/createTask  → {"code":200,"data":{"taskId":"..."}}
 * GET  /api/v1/jobs/recordInfo  → {"code":200,"data":{"state":"success|fail|...",
 *        "resultJson":"{\"resultUrls\":[...]}"  ← نص JSON داخل JSON يحتاج JSON.parse ثانية,
 *        "failMsg":"..."}}
 */
const BASE = "https://api.kie.ai/api/v1/jobs";

interface KieResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

async function kieRequest(key: string, path: string, init?: RequestInit): Promise<KieResponse> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // انقطاع شبكة أو timeout — مؤقت بلا حالة HTTP
    throw new ProviderError(undefined, err instanceof Error ? err.message : String(err), "temporary");
  }
  const text = await res.text();
  let body: KieResponse | null = null;
  try {
    body = JSON.parse(text) as KieResponse;
  } catch {
    body = null;
  }
  const okCode = body?.code === undefined || body.code === 200 || body.code === 201;
  if (!res.ok || !okCode) {
    const msg =
      body?.msg ||
      body?.data?.failMsg as string ||
      (text ? text.slice(0, 300) : "") ||
      `HTTP ${res.status}`;
    throw new ProviderError(body?.code ?? res.status, String(msg));
  }
  return body ?? {};
}

/** بناء input لكل نوع — نرسل فقط الحقول المقاسة في توثيق كل نوع */
function buildKieInput(input: TaskInput): Record<string, unknown> {
  if (input.type === "image") {
    const payload: Record<string, unknown> = { prompt: input.prompt };
    if (input.aspectRatio && input.aspectRatio !== "auto") payload.aspect_ratio = input.aspectRatio;
    if (input.resolution) payload.resolution = input.resolution;
    // خلفية/صيغة غير افتراضية فقط — الافتراضي لا يُرسل تفاديًا لأي رفض معطيات
    if (input.background && input.background !== "auto") payload.background = input.background;
    if (input.outputFormat && input.outputFormat !== "png") payload.output_format = input.outputFormat;
    return payload;
  }
  // فيديو Grok Imagine: prompt + image_url اختياري + aspect_ratio + duration.
  // ملاحظة: الصوت يُولَّد دائمًا ولا يمكن إيقافه — لا يُرسل enable_audio أبدًا.
  const payload: Record<string, unknown> = { prompt: input.prompt };
  if (input.imageUrl) payload.image_url = input.imageUrl;
  if (input.aspectRatio && input.aspectRatio !== "auto") payload.aspect_ratio = input.aspectRatio;
  if (input.duration) payload.duration = input.duration;
  return payload;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, input): Promise<{ providerTaskId: string }> {
    const body = await kieRequest(key, "/createTask", {
      method: "POST",
      body: JSON.stringify({ model: input.model, input: buildKieInput(input) }),
    });
    const taskId = body.data?.taskId;
    if (typeof taskId !== "string" || !taskId) {
      throw new ProviderError(200, "لم يُعَد معرّف مهمة من kie.ai", "temporary");
    }
    return { providerTaskId: taskId };
  },

  async checkTask(key, providerTaskId): Promise<ProviderCheckResult> {
    let body: KieResponse;
    try {
      body = await kieRequest(key, `/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`);
    } catch (err) {
      if (err instanceof ProviderError) {
        // مهمة غير موجودة لدى المزود = فشل حتمي (حُذفت أو انتهت)
        if (err.cls === "params" || err.cls === "provider") {
          return { status: "failed", error: `المهمة غير موجودة لدى المزود: ${err.message}` };
        }
      }
      throw err;
    }
    const data = body.data ?? {};
    const state = String(data.state ?? "");
    if (state === "success") {
      // resultJson نص JSON داخل JSON — يحتاج JSON.parse ثانية (الشكل الحقيقي)
      let urls: string[] = [];
      const raw = data.resultJson;
      if (typeof raw === "string" && raw.trim()) {
        try {
          const parsed = JSON.parse(raw) as { resultUrls?: unknown; resultUrl?: unknown };
          if (Array.isArray(parsed.resultUrls)) {
            urls = parsed.resultUrls.filter((u): u is string => typeof u === "string" && !!u);
          } else if (typeof parsed.resultUrl === "string") {
            urls = [parsed.resultUrl];
          }
        } catch {
          urls = [];
        }
      } else if (Array.isArray(raw)) {
        urls = (raw as unknown[]).filter((u): u is string => typeof u === "string");
      }
      if (urls.length === 0) {
        return { status: "failed", error: "اكتملت المهمة لدى المزود دون روابط نتائج" };
      }
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") {
      const failMsg = String(data.failMsg ?? "") || "فشل التوليد لدى المزود";
      return { status: "failed", error: failMsg };
    }
    // تقدير تقدم لطيف — لا يعطي kie نسبة رقمية
    const progress = state === "generating" ? 55 : state === "queuing" ? 25 : 10;
    return { status: "processing", progress };
  },
};

// إعادة التصدير ليُستخدم المصنِّف في الموائمين
export { classifyProviderError };
