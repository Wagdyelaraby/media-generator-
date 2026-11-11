import { getDb, ensureSchema } from "./turso";

/**
 * عميل خدمة دمج الفيديو — Video Merger API v2 (بلا مفاتيح أو توثيق).
 * العنوان من MERGER_API_BASE. المخرجات MP4 (H.264 + AAC) حتى 1080p — بلا معاملات resolution/fps.
 * القيود: 10 مقاطع كحد أقصى، 200MB للمصدر، 150MB للناتج، 600 ثانية مجموع المدد،
 * وكل الملفات تُحذف تلقائيًا بعد 24 ساعة.
 */
export function mergerBase(): string {
  return (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");
}

export class MergerError extends Error {
  status?: number;
  network: boolean; // أخطاء شبكتنا نحن — مؤقتة وتستمر بالاستعلام
  notFound: boolean; // 404 — المهمة حُذفت أو انتهت صلاحيتها
  constructor(message: string, opts?: { status?: number; network?: boolean; notFound?: boolean }) {
    super(message);
    this.name = "MergerError";
    this.status = opts?.status;
    this.network = opts?.network ?? false;
    this.notFound = opts?.notFound ?? false;
  }
}

async function mergerFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 180_000 // نقطة process تحجب ~10–15 ثانية وقد تمتد — مهلة سخية
): Promise<Record<string, unknown>> {
  const base = mergerBase();
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // timeout/fetch = خطأ شبكة مؤقت — ليس فشلًا حتميًا
    throw new MergerError(err instanceof Error ? err.message : String(err), { network: true });
  }
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = (body?.error as string) || (body?.message as string) || (text ? text.slice(0, 300) : `HTTP ${res.status}`);
    throw new MergerError(String(msg || `HTTP ${res.status}`), {
      status: res.status,
      network: false,
      notFound: res.status === 404,
    });
  }
  return body ?? {};
}

export interface MergeJobCreated {
  jobId: string;
  status: string;
  expiresAt?: string;
}

export interface MergeJobInfo {
  status: "queued" | "processing" | "done" | "failed";
  progress: number; // 0..100
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
}

/** إنشاء مهمة دمج: POST /api/jobs {"videos":[...]} */
export async function createMergeJob(urls: string[]): Promise<MergeJobCreated> {
  const body = await mergerFetch("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ videos: urls }),
  });
  const jobId = body.jobId as string;
  if (!jobId || typeof jobId !== "string") {
    throw new MergerError("لم يُعَد jobId من خدمة الدمج");
  }
  return {
    jobId,
    status: String(body.status ?? "queued"),
    expiresAt: body.expiresAt as string | undefined,
  };
}

/** تنفيذ الدمج: POST /api/jobs/{id}/process — يُستدعى مرة واحدة (قفل خارجي) */
export async function fireMergeProcess(jobId: string): Promise<void> {
  // نجاح أو فشل معلن — الردود تُدار من المستدعي عبر MergerError
  await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" });
}

/**
 * تحليل حالة المهمة دفاعيًا: الجسم قد يرد فيه error بدون status؛
 * progress قد يأتي كسرًا 0..1؛ والحالات مكتملة/فاشلة بأشكال متعددة.
 */
export async function getMergeJob(jobId: string): Promise<MergeJobInfo> {
  let body: Record<string, unknown>;
  try {
    body = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }, 20_000);
  } catch (err) {
    if (err instanceof MergerError && err.notFound) {
      // 404 = مهمة غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)
      throw new MergerError("مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)", {
        status: 404,
        notFound: true,
      });
    }
    throw err;
  }

  const rawError = typeof body.error === "string" ? body.error : undefined;
  const rawStatus = typeof body.status === "string" ? body.status.toLowerCase() : "";

  // رد فيه error بدون status → فشل فوري
  if (rawError && !rawStatus) {
    return { status: "failed", progress: 0, error: rawError };
  }

  const DONE = ["done", "completed", "complete", "success", "succeeded", "finished"];
  const FAILED = ["error", "failed", "failure", "cancelled", "canceled"];

  let status: MergeJobInfo["status"] = "processing";
  if (DONE.includes(rawStatus)) status = "done";
  else if (FAILED.includes(rawStatus)) status = "failed";
  else if (rawStatus === "queued" || rawStatus === "uploading") status = "queued";

  // progress كسر 0..1 → اضربه في 100
  let progress = 0;
  const rawProgress = body.progress;
  if (typeof rawProgress === "number") {
    progress = rawProgress <= 1 ? Math.round(rawProgress * 100) : Math.round(rawProgress);
  }

  // رابط النتيجة: فضّل videoUrl ثم downloadUrl ثم رابط الملف المباشر من المعرّف
  const base = mergerBase();
  const videoUrl = typeof body.videoUrl === "string" ? body.videoUrl : undefined;
  const downloadUrl = typeof body.downloadUrl === "string" ? body.downloadUrl : undefined;

  return {
    status,
    progress: status === "done" ? 100 : Math.min(Math.max(progress, 0), 100),
    videoUrl,
    downloadUrl,
    error: rawError,
  };
}

/** رابط النتيجة النهائي وفق التفضيل الموثق */
export function mergeResultUrl(info: MergeJobInfo, jobId: string): string {
  if (info.videoUrl) return info.videoUrl;
  if (info.downloadUrl) return info.downloadUrl;
  return `${mergerBase()}/api/jobs/${encodeURIComponent(jobId)}/video`;
}

/** حذف مهمة من خدمة الدمج (تنظيف) */
export async function deleteMergeJob(jobId: string): Promise<boolean> {
  try {
    await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, 15_000);
    return true;
  } catch (err) {
    if (err instanceof MergerError && err.notFound) return false;
    throw err;
  }
}

/** فحص جهوزية خدمة الدمج عبر GET /api/config بمهلة 4 ثوانٍ */
export async function mergerHealthy(): Promise<boolean> {
  const base = mergerBase();
  if (!base) return false;
  try {
    const res = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * قفل الذاكرة لمنع تنفيذ process مرتين على نفس المهمة
 * (قد يتزامن get_task مع بثّ النافذة الأولى) — globalThis ليعمل عبر الوحدات.
 */
const g = globalThis as unknown as { __mergerProcessInFlight?: Set<string> };
export function processInFlight(): Set<string> {
  if (!g.__mergerProcessInFlight) g.__mergerProcessInFlight = new Set<string>();
  return g.__mergerProcessInFlight;
}

// ضمان تحميل المخطط عند أول استخدام للوحدة المستوردة
void ensureSchema;
void getDb;
