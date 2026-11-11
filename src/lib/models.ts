/**
 * سجل الموديلات — الاسم الموحد كما يراه عميل MCP + الأسماء الفعلية لكل مزود.
 * الصيغ البديلة بالنقاط مقبولة وتُوحَّد (شرطات/نقاط)، والأسماء قابلة للتجاوز بمتغيرات البيئة.
 */
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحه كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

const KIE_IMAGE = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
// الاسم الفعلي المقاس لدى CometAPI (بعد اتباع التوثيق الرسمي) — قابل للتجاوز بالبيئة
const COMETAPI_IMAGE =
  process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1.5";

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE, cometapi: COMETAPI_IMAGE },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: [
      "grok-imagine-video-1.5-preview",
      "grok-imagine-video-1.5", // صيغة CometAPI الأصلية — تُوحَّد للاسم الموحد
      "grok-imagine-video-1-5",
    ],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO, cometapi: COMETAPI_VIDEO },
  },
];

/** توحيد اسم الموديل: النقاط تعادل الشرطات، والمائل ممنوع في النهاية */
function normalizeName(name: string): string {
  return name.trim().replace(/\/+$/, "").replace(/\./g, "-").toLowerCase();
}

export function normalizeModel(name: string | undefined | null): ModelDef | null {
  if (!name) return null;
  const n = name.trim();
  for (const def of MODELS) {
    if (def.canonical === n || def.aliases.includes(n)) return def;
  }
  const target = normalizeName(n);
  for (const def of MODELS) {
    if (normalizeName(def.canonical) === target) return def;
    if (def.aliases.some((a) => normalizeName(a) === target)) return def;
  }
  return null;
}

export function defaultModel(type: MediaType): ModelDef | null {
  return MODELS.find((m) => m.type === type) ?? null;
}

export function listModelsForHealth() {
  return MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers }));
}
