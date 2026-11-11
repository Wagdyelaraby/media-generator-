import { taskResultUrls, taskAttempts, type TaskRecord } from "./tasks";

/**
 * صياغة الردود العربية للأدوات — المصطلحات التقنية وأسماء الأدوات تبقى بالإنجليزية.
 */
const TYPE_LABEL: Record<string, string> = {
  image: "صورة",
  video: "فيديو",
  merge: "دمج",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "بانتظار المعالجة",
  processing: "قيد المعالجة",
  completed: "مكتملة",
  failed: "فاشلة",
};

const MERGE_EXPIRY_NOTE = "⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.";

function isDataUri(url: string): boolean {
  return url.startsWith("data:");
}

export interface FormattedResult {
  text: string;
  isError?: boolean;
  /** صورة مضمّنة (base64) إن أعادها المزود بلا رابط مباشر */
  image?: { data: string; mimeType: string };
}

/** صياغة نتيجة أداة حسب حالة المهمة */
export function formatTaskResult(task: TaskRecord): FormattedResult {
  const urls = taskResultUrls(task);

  if (task.status === "completed") {
    if (task.type === "image") {
      const first = urls[0] ?? "";
      if (isDataUri(first)) {
        // المزود أعاد الصورة مضمّنة base64 — نرسلها ككتلة صورة للعميل
        const match = /^data:([^;]+);base64,(.*)$/s.exec(first);
        const mimeType = match?.[1] || "image/png";
        const base64 = match?.[2] || "";
        return {
          text: [
            "✅ تم توليد الصورة بنجاح",
            "(هذا المزود أعاد الصورة مضمّنة base64 — انظر الصورة المرفقة؛ لا يوجد رابط مباشر منه)",
          ].join("\n"),
          image: { data: base64, mimeType },
        };
      }
      const lines = ["✅ تم توليد الصورة بنجاح"];
      if (first) lines.push(`![image](${first})`, `الرابط المباشر: ${first}`);
      for (const u of urls.slice(1)) lines.push(`رابط إضافي: ${u}`);
      return { text: lines.join("\n") };
    }

    if (task.type === "video") {
      const lines = ["✅ تم توليد الفيديو بنجاح"];
      for (const u of urls) lines.push(`الرابط المباشر: ${u}`);
      return { text: lines.join("\n") };
    }

    // دمج — أضف تحذير الحذف بعد 24 ساعة حرفيًا
    const lines = ["✅ تم دمج المقاطع بنجاح"];
    for (const u of urls) lines.push(`الرابط المباشر: ${u}`);
    lines.push(MERGE_EXPIRY_NOTE);
    return { text: lines.join("\n") };
  }

  if (task.status === "failed") {
    return {
      text: `❌ فشلت المهمة: ${task.errorMessage || "سبب غير معروف"}`,
      isError: true,
    };
  }

  // جارية — العميل يتابع بـ get_task كل ~10 ثوانٍ
  return {
    text: [
      `⏳ المهمة قيد المعالجة — task_id: ${task.id}`,
      `التقدم: ${task.progress}%`,
      "تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.",
    ].join("\n"),
  };
}

/** صياغة قائمة الوسائط المخزنة — data URIs الضخمة تُختصر إلى ملاحظة */
function shortUrl(u: string): string {
  if (isDataUri(u) && u.length > 120) {
    return "[صورة مضمّنة base64 — مررها إلى get_task لعرضها]";
  }
  return u;
}

export function formatMediaList(tasks: TaskRecord[], filters: { type?: string; status?: string }): string {
  if (tasks.length === 0) {
    return "📋 لا توجد مهام مخزنة بعد" + (filters.type || filters.status ? " بهذه المرشحات" : "") + ". ولّد صورة أو فيديو أولًا بـ generate_image أو generate_video.";
  }
  const header = `📋 أحدث الوسائط (${tasks.length}):`;
  const lines = tasks.map((t, i) => {
    const urls = taskResultUrls(t).map(shortUrl);
    const parts = [
      `${i + 1}. [${TYPE_LABEL[t.type]}] ${STATUS_LABEL[t.status]} — ${t.model}`,
      `   task_id: ${t.id}`,
      t.prompt ? `   الوصف: ${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? "…" : ""}` : "",
      ...(urls.length ? urls.map((u) => `   الرابط: ${u}`) : []),
      t.status === "failed" && t.errorMessage ? `   الخطأ: ${t.errorMessage.slice(0, 120)}` : "",
      t.status === "processing" ? "   تابعه بـ get_task كل ~10 ثوانٍ." : "",
    ].filter(Boolean);
    return parts.join("\n");
  });
  return [header, ...lines].join("\n");
}

/** عدد المحاولات للعرض في الواجهة */
export function attemptsCount(task: TaskRecord): number {
  return taskAttempts(task).length;
}
