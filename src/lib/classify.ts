/**
 * تصنيف أخطاء المزودين — دالة موحدة تحكم قرار التبديل بين المفاتيح.
 * الترتيب مقصود: نفاد الرصيد يُفحص قبل 400 لأن بعض المزودين يرسلونه بحالة 400.
 */
export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

const DISABLED_RE =
  /invalid\s*api\s*key|unauthorized|forbidden|authentication|invalid\s*(key|token)|bad\s*key/i;
const EXHAUSTED_RE =
  /insufficient|quota|balance|credit|out\s*of\s*credits|exhausted|充值|no\s*enough\s*credit/i;
const PROVIDER_MODEL_RE = /model\s*not\s*found|unsupported\s*model|model\s*does\s*not\s*exist|no\s*such\s*model/i;

/** نمط رسائل فشل مفتاح/رصيد في منتصف المهمة — يستدعي إعادة الإنشاء على المفتاح التالي */
const KEY_BALANCE_RE =
  /insufficient|balance|credit|quota|402|401|unauthorized|exhausted|充值|invalid\s*api\s*key|forbidden|authentication/i;

export function classifyProviderError(status: number | undefined, message: string): ErrorClass {
  const msg = message || "";
  // 1) المفتاح مرفوض → تعطيل تلقائي
  if (status === 401 || status === 403 || DISABLED_RE.test(msg)) return "disabled";
  // 2) نفاد الرصيد → يبقى المفتاح في القاعدة وينتقل للمفتاح التالي (فحصه قبل 400 مقصود)
  if (status === 402 || EXHAUSTED_RE.test(msg)) return "exhausted";
  // 3) الموديل غير مدعوم لدى هذا المزود
  if ((status === 400 || status === 404 || status === 422) && PROVIDER_MODEL_RE.test(msg)) {
    return "provider";
  }
  // 4) معطيات الطلب خاطئة — التبديل لن يحلها
  if (status === 400 || status === 422) return "params";
  // 5) 429 / 5xx / انقطاع شبكة / timeout — مؤقتة ويبقى المفتاح سليمًا
  return "temporary";
}

/** هل رسالة الفشل تطابق نمط مشكلات مفتاح/رصيد؟ (تُستخدم عند فشل منتصف المهمة) */
export function isKeyOrBalanceMessage(message: string): boolean {
  return KEY_BALANCE_RE.test(message || "");
}

/** إخفاء أي ذكر لمفاتيح/رصيد قبل أن يخرج أي نص إلى عميل MCP — التبديل صامت تمامًا */
export function sanitizeOutboundMessage(message: string | null | undefined): string {
  const msg = (message || "").trim();
  if (!msg) return "حدث خطأ غير محدد";
  if (KEY_BALANCE_RE.test(msg)) {
    return "خطأ مؤقت لدى المزود — سيُعاد المحاولة تلقائيًا أو جرّب مرة أخرى";
  }
  return msg;
}
