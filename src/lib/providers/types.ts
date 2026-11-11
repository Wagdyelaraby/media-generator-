import type { MediaType } from "../models";
import { classifyProviderError, type ErrorClass } from "../classify";

/** أي خطأ من مزود خارجي يُرمى بهذا الشكل ليُصنَّف ويقرر سلوك التبديل */
export class ProviderError extends Error {
  status?: number;
  cls: ErrorClass;
  constructor(status: number | undefined, message: string, cls?: ErrorClass) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.cls = cls ?? classifyProviderError(status, message);
  }
}

/** معطيات مهمة توليد — تُبنى من وسيطات الأداة ثم تُحوَّل لشكل كل مزود داخليًا */
export interface TaskInput {
  model: string; // اسم الموديل كما يُرسل لهذا المزود تحديدًا
  type: MediaType;
  prompt: string;
  imageUrl?: string;
  aspectRatio?: string;
  resolution?: string;
  background?: string;
  outputFormat?: string;
  enableAudio?: boolean;
  duration?: number;
}

export interface ProviderCheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو وبعض الصور): تعيد معرّف المهمة لدى المزود */
  createTask(key: string, input: TaskInput): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (تُعيد النتيجة فورًا) */
  createImageSync?(key: string, input: TaskInput): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(key: string, providerTaskId: string): Promise<ProviderCheckResult>;
}
