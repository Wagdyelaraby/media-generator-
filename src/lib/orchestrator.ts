import { ensureSchema } from "./turso";
import { getKeyPool, recordKeyUsage, type KeyRecord } from "./keys";
import { insertTask, getTask, updateTask, taskAttempts, taskResultUrls, type TaskRecord, type TaskType, type AttemptEntry } from "./tasks";
import { MODELS, normalizeModel, defaultModel, type ModelDef, type MediaType } from "./models";
import { ProviderError, type ProviderAdapter, type TaskInput } from "./providers/types";
import { kieAdapter } from "./providers/kie";
import { cometApiAdapter } from "./providers/cometapi";
import { classifyProviderError, isKeyOrBalanceMessage, sanitizeOutboundMessage, type ErrorClass } from "./classify";
import {
  mergerBase,
  createMergeJob,
  fireMergeProcess,
  getMergeJob,
  mergeResultUrl,
  MergerError,
  processInFlight,
} from "./merger";

/** إشعار تقدم يُبث للعميل فقط إن زوّد الطلب بـ progressToken */
export interface ProgressNotify {
  hasToken: boolean;
  send(progress: number, total: number, message: string): Promise<void>;
}

export const noopNotify: ProgressNotify = { hasToken: false, async send() {} };

export function getAdapter(provider: string): ProviderAdapter {
  if (provider === "kie") return kieAdapter;
  if (provider === "cometapi") return cometApiAdapter;
  throw new Error(`لا يوجد موائم للمزود: ${provider}`);
}

/** وسائط أدوات التوليد بعد التحقق من المخطط */
export interface GenerationArgs {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  background?: string;
  outputFormat?: string;
  imageUrl?: string;
  enableAudio?: boolean;
  duration?: number;
  waitSeconds?: number;
}

export type ToolOutcome =
  | { kind: "completed"; task: TaskRecord }
  | { kind: "processing"; task: TaskRecord }
  | { kind: "failed"; text: string }
  | { kind: "params_error"; text: string }
  | { kind: "no_keys"; text: string };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function buildTaskInput(def: ModelDef, provider: string, args: GenerationArgs): TaskInput {
  return {
    model: def.providerModel[provider as "kie" | "cometapi"],
    type: def.type,
    prompt: args.prompt,
    imageUrl: args.imageUrl,
    aspectRatio: args.aspectRatio,
    resolution: args.resolution,
    background: args.background,
    outputFormat: args.outputFormat,
    enableAudio: args.enableAudio,
    duration: args.duration,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

interface Attempt {
  entry: AttemptEntry;
  keyId: string;
  ok: boolean;
}

/**
 * تجربة المرشحين بالترتيب التسلسلي الصارم حتى نجاح الإنشاء.
 * كل محاولة تُسجَّل في attempts_json وعدّادات المفتاح تُحدَّث دائمًا.
 */
async function attemptCandidates(
  taskId: string,
  def: ModelDef,
  args: GenerationArgs,
  pool: KeyRecord[],
  startIndex: number,
  notify: ProgressNotify,
  signal?: AbortSignal
): Promise<{ created: boolean; syncUrls?: string[]; boundKey?: KeyRecord; providerTaskId?: string; allFailedClass?: ErrorClass }> {
  let lastClass: ErrorClass | undefined;

  for (let i = Math.max(startIndex, 0); i < pool.length; i++) {
    if (signal?.aborted) break;
    const key = pool[i];
    const provider = key.provider;

    // المفتاح يجب أن ينتمي لمزود يدعم هذا الموديل
    if (!def.providers.includes(provider as "kie" | "cometapi")) continue;

    const entry: AttemptEntry = {
      provider,
      keyId: key.id,
      keyLabel: key.label || `${provider}:*`,
      ok: false,
      at: nowIso(),
    };

    try {
      const adapter = getAdapter(provider);
      const input = buildTaskInput(def, provider, args);

      // صور متزامنة إن دعمها المزود — النتيجة فورية
      if (def.type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key.apiKey, input);
        entry.ok = true;
        await recordKeyUsage(key.id, true);
        await updateTask(taskId, {
          provider,
          keyId: key.id,
          status: "processing",
          progress: 60,
          newAttempt: entry,
        });
        return { created: true, syncUrls: urls, boundKey: key };
      }

      const { providerTaskId } = await adapter.createTask(key.apiKey, input);
      entry.ok = true;
      await recordKeyUsage(key.id, true);
      await updateTask(taskId, {
        provider,
        providerTaskId,
        keyId: key.id,
        status: "processing",
        progress: 5,
        newAttempt: entry,
      });
      return { created: true, boundKey: key, providerTaskId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = err instanceof ProviderError ? err.status : undefined;
      const cls = err instanceof ProviderError ? err.cls : classifyProviderError(undefined, msg);
      entry.errorClass = cls;
      entry.error = msg.slice(0, 500);
      lastClass = cls;
      await recordKeyUsage(key.id, false, cls, msg.slice(0, 500));
      await updateTask(taskId, { newAttempt: entry });

      if (cls === "params") {
        // خطأ معطيات — تبديل المفاتيح لن يحلّه: توقف فورًا (المهمة تُفشل من الخارج)
        return { created: false, allFailedClass: "params" };
      }
      // disabled / exhausted / provider / temporary → انتقل للمفتاح التالي فورًا
      continue;
    }
  }
  return { created: false, allFailedClass: lastClass };
}

/**
 * نافذة الانتظار: استعلام المزود كل 3 ثوانٍ مع بث تقدم عربي (~كل 3 ثوانٍ).
 * فشل مفتاح/رصيد في المنتصف → "switch" لإعادة الإنشاء بنفس task_id على المفتاح التالي.
 */
type WindowResult =
  | { kind: "completed"; task: TaskRecord }
  | { kind: "still_processing"; task: TaskRecord }
  | { kind: "switch"; error: string }
  | { kind: "failed"; error: string };

async function pollGenerationWindow(
  task: TaskRecord,
  key: KeyRecord,
  providerTaskId: string,
  waitSeconds: number,
  notify: ProgressNotify,
  signal?: AbortSignal
): Promise<WindowResult> {
  const adapter = getAdapter(key.provider);
  const def = normalizeModel(task.model) ?? defaultModel(task.type);
  const totalMs = Math.max(waitSeconds, 0) * 1000;
  const deadline = Date.now() + totalMs;
  const startedAt = Date.now();
  let lastNotifyAt = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) break;
    await sleep(3000, signal);
    if (signal?.aborted) break;

    let check;
    try {
      check = await adapter.checkTask(key.apiKey, providerTaskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cls = err instanceof ProviderError ? err.cls : classifyProviderError(undefined, msg);
      if (cls === "disabled" || cls === "exhausted") {
        // المفتاح صار مرفوضًا/مستنزفًا أثناء المهمة → تبديل بنفس task_id
        await recordKeyUsage(key.id, false, cls, msg.slice(0, 500));
        return { kind: "switch", error: msg };
      }
      // temporary — استمر بالاستعلام حتى انتهاء النافذة
      continue;
    }

    if (check.status === "completed" && check.urls?.length) {
      await recordKeyUsage(key.id, true);
      await updateTask(task.id, {
        status: "completed",
        progress: 100,
        resultUrlsJson: JSON.stringify(check.urls),
      });
      const updated = await getTask(task.id);
      return { kind: "completed", task: updated ?? task };
    }
    if (check.status === "failed") {
      const errText = check.error || "فشل التوليد لدى المزود";
      // فشل بنمط مفتاح/رصيد → أعد الإنشاء على المفتاح التالي بنفس task_id
      if (isKeyOrBalanceMessage(errText)) {
        return { kind: "switch", error: errText };
      }
      await recordKeyUsage(key.id, false, undefined, errText.slice(0, 500));
      await updateTask(task.id, { status: "failed", errorMessage: errText.slice(0, 800) });
      return { kind: "failed", error: errText };
    }

    // قيد المعالجة — حدّث التقدم في القاعدة وابعث إشعارًا كل ~3 ثوانٍ
    const elapsedRatio = (Date.now() - startedAt) / Math.max(totalMs, 1);
    const progress = Math.min(95, Math.max(check.progress ?? 10 + Math.round(elapsedRatio * 80), 5));
    await updateTask(task.id, { status: "processing", progress });
    if (notify.hasToken && Date.now() - lastNotifyAt >= 2800) {
      await notify.send(progress, 100, `قيد التوليد… ${progress}%`);
      lastNotifyAt = Date.now();
    }
  }
  const updated = await getTask(task.id);
  return { kind: "still_processing", task: updated ?? task };
}

/** مهلة التهدئة قبل إعادة محاولة الإنشاء عند استدعاء get_task (حتى لا نضغط المزودين) */
const RETRY_COOLDOWN_MS = 45_000;

function lastAttemptAt(task: TaskRecord): number {
  const attempts = taskAttempts(task);
  const last = attempts[attempts.length - 1];
  return last ? Date.parse(last.at) || 0 : Date.parse(task.updatedAt) || 0;
}

/**
 * منسّق التوليد لأداتي generate_image / generate_video.
 * تسجّل المهمة في Turso قبل أي نداء خارجي ثم تجرّب المفاتيح بالترتيب.
 */
export async function runGeneration(
  args: GenerationArgs,
  type: Exclude<TaskType, "merge">,
  notify: ProgressNotify = noopNotify,
  signal?: AbortSignal
): Promise<ToolOutcome> {
  await ensureSchema();

  // 1) وحّد اسم الموديل — غير معروف → خطأ معطيات فوري
  const def = (args.model ? normalizeModel(args.model) : null) ?? defaultModel(type);
  if (!def || def.type !== type) {
    const available = MODELS.map((m) => m.canonical).join("، ");
    return {
      kind: "params_error",
      text: `❌ موديل غير معروف: ${args.model ?? "(فارغ)"}. المتاح: ${available}`,
    };
  }

  // 2) جلب المفاتيح بالترتيب التسلسلي — فارغ → رد no_keys
  const pool = await getKeyPool(def.providers);
  if (pool.length === 0) {
    return {
      kind: "no_keys",
      text: `❌ لا توجد مفاتيح نشطة لخدمة ${def.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    };
  }

  // 3) سجّل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى مع انقطاع الاتصال
  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    model: def.canonical,
    type,
    prompt: args.prompt,
    paramsJson: JSON.stringify({ ...args, model: def.canonical }),
    status: "pending",
    progress: 0,
  });
  const task = (await getTask(taskId))!;

  // 4) جرّب المرشحين بالترتيب حتى نجاح الإنشاء
  const attempt = await attemptCandidates(taskId, def, args, pool, 0, notify, signal);
  if (!attempt.created) {
    if (attempt.allFailedClass === "params") {
      const failedTask = (await getTask(taskId))!;
      const last = taskAttempts(failedTask).at(-1);
      const reason = sanitizeOutboundMessage(last?.error);
      await updateTask(taskId, { status: "failed", errorMessage: reason });
      return { kind: "failed", text: `❌ فشلت المهمة: ${reason}` };
    }
    // فشل على كل المفاتيح → تبقى processing «بانتظار توفر مفتاح صالح…» وتُعاد مع get_task
    return { kind: "processing", task: (await getTask(taskId))! };
  }

  if (attempt.syncUrls) {
    // صورة متزامنة — اكتملت فورًا
    await updateTask(taskId, {
      status: "completed",
      progress: 100,
      resultUrlsJson: JSON.stringify(attempt.syncUrls),
    });
    return { kind: "completed", task: (await getTask(taskId))! };
  }

  // 5) نافذة الانتظار مع بث التقدم (الافتراضي: 90 للصور و25 للفيديو)
  const waitSeconds = args.waitSeconds ?? (type === "image" ? 90 : 25);
  const liveTask = (await getTask(taskId))!;
  const windowResult = await pollGenerationWindow(
    liveTask,
    attempt.boundKey!,
    attempt.providerTaskId!,
    waitSeconds,
    notify,
    signal
  );

  if (windowResult.kind === "switch") {
    // 6) إعادة الإنشاء بنفس task_id على المفاتيح التالية — العميل لا يرى شيئًا
    const fresh = (await getTask(taskId))!;
    const boundIndex = pool.findIndex((k) => k.id === attempt.boundKey!.id);
    const nextAttempt = await attemptCandidates(
      taskId,
      def,
      args,
      pool,
      boundIndex + 1,
      notify,
      signal
    );
    if (!nextAttempt.created) {
      return { kind: "processing", task: (await getTask(taskId))! };
    }
    if (nextAttempt.syncUrls) {
      await updateTask(taskId, {
        status: "completed",
        progress: 100,
        resultUrlsJson: JSON.stringify(nextAttempt.syncUrls),
      });
      return { kind: "completed", task: (await getTask(taskId))! };
    }
    const secondWindow = await pollGenerationWindow(
      (await getTask(taskId))!,
      nextAttempt.boundKey!,
      nextAttempt.providerTaskId!,
      Math.max(waitSeconds - Math.round((Date.now() - Date.parse(liveTask.createdAt)) / 1000), 10),
      notify,
      signal
    );
    if (secondWindow.kind === "completed") return secondWindow;
    if (secondWindow.kind === "failed") {
      return { kind: "failed", text: `❌ فشلت المهمة: ${sanitizeOutboundMessage(secondWindow.error)}` };
    }
    // تبديل ثانٍ — قائمة المفاتيح نفدت غالبًا؛ اترك المهمة جارية وتابع عبر get_task
    if (secondWindow.kind === "switch") {
      return { kind: "processing", task: (await getTask(taskId))! };
    }
    return { kind: "processing", task: (await getTask(taskId))! };
  }

  if (windowResult.kind === "failed") {
    return { kind: "failed", text: `❌ فشلت المهمة: ${sanitizeOutboundMessage(windowResult.error)}` };
  }

  // 7) انتهت النافذة دون نتيجة → أعد task_id والعميل يتابع بـ get_task
  return { kind: "processing", task: windowResult.task };
}

/**
 * تتبع مهمة قائمة عبر get_task — تحديث حي من المزود/الخدمة
 * مع نفس منطق إعادة المحاولة والتبديل.
 */
export async function refreshTask(taskId: string): Promise<ToolOutcome | { kind: "not_found"; text: string }> {
  await ensureSchema();
  const task = await getTask(taskId);
  if (!task) {
    return { kind: "not_found", text: `❌ لا توجد مهمة بهذا المعرّف: ${taskId}` };
  }
  if (task.status === "completed") return { kind: "completed", task };
  if (task.status === "failed") return { kind: "failed", text: `❌ فشلت المهمة: ${task.errorMessage || "سبب غير معروف"}` };

  // مهمة دمج — مسار مستقل
  if (task.provider === "merger") {
    return refreshMergeTask(task);
  }

  const def = normalizeModel(task.model) ?? defaultModel(task.type);
  if (!def) return { kind: "processing", task };

  const pool = await getKeyPool(def.providers);

  if (!task.providerTaskId) {
    // فشل الإنشاء سابقًا على كل المفاتيح — أعد المحاولة بعد تهدئة ~45 ثانية
    if (Date.now() - lastAttemptAt(task) < RETRY_COOLDOWN_MS) {
      return { kind: "processing", task };
    }
    const args = JSON.parse(task.paramsJson || "{}") as GenerationArgs;
    const attempt = await attemptCandidates(taskId, def, args, pool, 0, noopNotify);
    if (!attempt.created) {
      return { kind: "processing", task: (await getTask(taskId))! };
    }
    if (attempt.syncUrls) {
      await updateTask(taskId, {
        status: "completed",
        progress: 100,
        resultUrlsJson: JSON.stringify(attempt.syncUrls),
      });
      return { kind: "completed", task: (await getTask(taskId))! };
    }
    // مهمة أُعيد إنشاؤها — استمر ببقية نافذة افتراضية قصيرة داخل refresh
    const windowResult = await pollGenerationWindow(
      (await getTask(taskId))!,
      attempt.boundKey!,
      attempt.providerTaskId!,
      20,
      noopNotify
    );
    if (windowResult.kind === "completed") return windowResult;
    if (windowResult.kind === "failed") {
      return { kind: "failed", text: `❌ فشلت المهمة: ${sanitizeOutboundMessage(windowResult.error)}` };
    }
    if (windowResult.kind === "switch") {
      return { kind: "processing", task: (await getTask(taskId))! };
    }
    return { kind: "processing", task: (await getTask(taskId))! };
  }

  // مهمة مرتبطة بمزود — حدّث حيًا بالمفتاح المربوط
  const boundKey =
    pool.find((k) => k.id === task.keyId && k.provider === task.provider) ??
    pool.find((k) => k.provider === task.provider);
  if (!boundKey) {
    // لا مفتاح متاح لهذا المزود الآن — تبقى جارية حتى يعود مفتاح
    return { kind: "processing", task };
  }
  const adapter = getAdapter(boundKey.provider);
  let check;
  try {
    check = await adapter.checkTask(boundKey.apiKey, task.providerTaskId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cls = err instanceof ProviderError ? err.cls : classifyProviderError(undefined, msg);
    if (cls === "disabled" || cls === "exhausted") {
      // المفتاح المربوط انكسر — أعد الإنشاء على بقية المفاتيح بنفس task_id
      const args = JSON.parse(task.paramsJson || "{}") as GenerationArgs;
      const boundIndex = pool.findIndex((k) => k.id === boundKey.id);
      const attempt = await attemptCandidates(taskId, def, args, pool, boundIndex + 1, noopNotify);
      if (!attempt.created) return { kind: "processing", task: (await getTask(taskId))! };
      if (attempt.syncUrls) {
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          resultUrlsJson: JSON.stringify(attempt.syncUrls),
        });
        return { kind: "completed", task: (await getTask(taskId))! };
      }
      const windowResult = await pollGenerationWindow(
        (await getTask(taskId))!,
        attempt.boundKey!,
        attempt.providerTaskId!,
        20,
        noopNotify
      );
      if (windowResult.kind === "completed") return windowResult;
      if (windowResult.kind === "failed") {
        return { kind: "failed", text: `❌ فشلت المهمة: ${sanitizeOutboundMessage(windowResult.error)}` };
      }
      return { kind: "processing", task: (await getTask(taskId))! };
    }
    // temporary — المزود متذبذب الآن؛ أرجع حالة جارية
    return { kind: "processing", task };
  }

  if (check.status === "completed" && check.urls?.length) {
    await recordKeyUsage(boundKey.id, true);
    await updateTask(taskId, {
      status: "completed",
      progress: 100,
      resultUrlsJson: JSON.stringify(check.urls),
    });
    return { kind: "completed", task: (await getTask(taskId))! };
  }
  if (check.status === "failed") {
    const errText = check.error || "فشل التوليد لدى المزود";
    if (isKeyOrBalanceMessage(errText)) {
      const args = JSON.parse(task.paramsJson || "{}") as GenerationArgs;
      const boundIndex = pool.findIndex((k) => k.id === boundKey.id);
      const attempt = await attemptCandidates(taskId, def, args, pool, boundIndex + 1, noopNotify);
      if (!attempt.created) return { kind: "processing", task: (await getTask(taskId))! };
      if (attempt.syncUrls) {
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          resultUrlsJson: JSON.stringify(attempt.syncUrls),
        });
        return { kind: "completed", task: (await getTask(taskId))! };
      }
      const windowResult = await pollGenerationWindow(
        (await getTask(taskId))!,
        attempt.boundKey!,
        attempt.providerTaskId!,
        20,
        noopNotify
      );
      if (windowResult.kind === "completed") return windowResult;
      if (windowResult.kind === "failed") {
        return { kind: "failed", text: `❌ فشلت المهمة: ${sanitizeOutboundMessage(windowResult.error)}` };
      }
      return { kind: "processing", task: (await getTask(taskId))! };
    }
    await recordKeyUsage(boundKey.id, false, undefined, errText.slice(0, 500));
    await updateTask(taskId, { status: "failed", errorMessage: errText.slice(0, 800) });
    return { kind: "failed", text: `❌ فشلت المهمة: ${sanitizeOutboundMessage(errText)}` };
  }

  const progress = Math.max(task.progress, Math.min(95, check.progress ?? task.progress));
  await updateTask(taskId, { status: "processing", progress });
  return { kind: "processing", task: (await getTask(taskId))! };
}

/** إطلاق process خلفيًا وبمرة واحدة فقط (قفل في الذاكرة) */
async function fireProcessInBackground(jobId: string, taskId: string): Promise<void> {
  const lock = processInFlight();
  if (lock.has(jobId)) return;
  lock.add(jobId);
  void (async () => {
    try {
      await fireMergeProcess(jobId);
      // نجاح process — الحالة النهائية تُلتقط من getMergeJob (done + روابط)
      const info = await getMergeJob(jobId);
      if (info.status === "done") {
        const url = mergeResultUrl(info, jobId);
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          resultUrlsJson: JSON.stringify([url]),
        });
      } else if (info.status === "failed") {
        await updateTask(taskId, {
          status: "failed",
          errorMessage: sanitizeOutboundMessage(info.error || "فشل الدمج لدى الخدمة").slice(0, 800),
        });
      }
    } catch (err) {
      if (err instanceof MergerError && !err.network) {
        // خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة
        await updateTask(taskId, {
          status: "failed",
          errorMessage: sanitizeOutboundMessage(err.message).slice(0, 800),
        });
      }
      // أخطاء الشبكة مؤقتة — get_task سيستكمل الحالة لاحقًا
    } finally {
      lock.delete(jobId);
    }
  })();
}

/**
 * تدفق الدمج: تحقق صارم من الروابط → تسجيل أولًا → إنشاء لدى الخدمة →
 * process خلفيًا مرة واحدة → نافذة استعلام مع بث تقدم وكتابة فورية في Turso.
 */
export interface MergeArgs {
  urls?: string[];
  taskIds?: string[];
  waitSeconds?: number;
}

export async function runMerge(
  args: MergeArgs,
  notify: ProgressNotify = noopNotify,
  signal?: AbortSignal
): Promise<ToolOutcome> {
  await ensureSchema();

  if (!mergerBase()) {
    return {
      kind: "no_keys",
      text: "❌ خدمة الدمج غير مضبوطة على السيرفر (متغير MERGER_API_BASE مفقود). أضف العنوان في متغيرات البيئة ثم أعد المحاولة.",
    };
  }

  // حل الروابط: روابط task_ids المكتملة أولًا ثم urls المباشرة بنفس ترتيبها
  const urls: string[] = [];
  const failures: string[] = [];
  for (const tid of args.taskIds ?? []) {
    const t = await getTask(String(tid).trim());
    if (!t) {
      failures.push(`${tid}: مهمة غير موجودة`);
    } else if (t.status !== "completed") {
      failures.push(`${tid}: الحالة ${t.status} (يُقبل فقط المكتمل)`);
    } else {
      const taskUrls = taskResultUrls(t);
      if (taskUrls.length === 0) {
        failures.push(`${tid}: لا توجد روابط نتائج`);
      } else {
        urls.push(taskUrls[0]);
      }
    }
  }
  for (const u of args.urls ?? []) {
    urls.push(String(u).trim());
  }

  if (urls.length < 2) {
    let text = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (failures.length) text += `\nتفاصيل المعرّفات الفاشلة:\n- ${failures.join("\n- ")}`;
    return { kind: "params_error", text };
  }
  if (urls.length > 10) {
    return {
      kind: "params_error",
      text: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
    };
  }
  // روابط http/https مباشرة وعامة فقط
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("بروتوكول");
      const host = parsed.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host.endsWith(".local") ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      ) {
        throw new Error("نطاق غير عام");
      }
    } catch {
      return {
        kind: "params_error",
        text: `❌ رابط غير صالح للدمج (يجب أن يكون http/https مباشرًا وعامًا): ${u}`,
      };
    }
  }

  // سجّل مهمة الدمج في Turso أولًا
  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: "",
    paramsJson: JSON.stringify({ urls }),
    status: "pending",
    progress: 0,
  });

  // أنشئ المهمة لدى الخدمة
  let jobId: string;
  try {
    const job = await createMergeJob(urls);
    jobId = job.jobId;
  } catch (err) {
    if (err instanceof MergerError && err.network) {
      // خطأ شبكتنا — تبقى جارية وتستكمل عبر get_task
      await updateTask(taskId, { status: "processing", progress: 5 });
      return { kind: "processing", task: (await getTask(taskId))! };
    }
    const reason = sanitizeOutboundMessage(err instanceof Error ? err.message : String(err));
    await updateTask(taskId, { status: "failed", errorMessage: reason.slice(0, 800) });
    return { kind: "failed", text: `❌ فشلت المهمة: ${reason}` };
  }

  await updateTask(taskId, { providerTaskId: jobId, status: "processing", progress: 5 });

  // أطلق process خلفيًا وبمرة واحدة فقط
  await fireProcessInBackground(jobId, taskId);

  // نافذة الانتظار (الافتراضي 60 ثانية): استعلام كل 3 ثوانٍ مع بث تقدم
  const waitSeconds = args.waitSeconds ?? 60;
  const deadline = Date.now() + waitSeconds * 1000;
  let lastNotifyAt = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) break;
    await sleep(3000, signal);
    if (signal?.aborted) break;

    const fresh = (await getTask(taskId))!;
    if (fresh.status === "completed") return { kind: "completed", task: fresh };
    if (fresh.status === "failed") {
      return { kind: "failed", text: `❌ فشلت المهمة: ${sanitizeOutboundMessage(fresh.errorMessage)}` };
    }

    let info: Awaited<ReturnType<typeof getMergeJob>>;
    try {
      info = await getMergeJob(jobId);
    } catch (err) {
      if (err instanceof MergerError && err.notFound) {
        // 404 = فشل نهائي فوري
        await updateTask(taskId, { status: "failed", errorMessage: err.message.slice(0, 800) });
        return { kind: "failed", text: `❌ فشلت المهمة: ${err.message}` };
      }
      if (err instanceof MergerError && !err.network) {
        await updateTask(taskId, { status: "failed", errorMessage: sanitizeOutboundMessage(err.message).slice(0, 800) });
        return { kind: "failed", text: `❌ فشلت المهمة: ${sanitizeOutboundMessage(err.message)}` };
      }
      continue; // أخطاء شبكتنا مؤقتة → استمر بالاستعلام حتى انتهاء النافذة
    }

    if (info.status === "done") {
      const url = mergeResultUrl(info, jobId);
      await updateTask(taskId, {
        status: "completed",
        progress: 100,
        resultUrlsJson: JSON.stringify([url]),
      });
      return { kind: "completed", task: (await getTask(taskId))! };
    }
    if (info.status === "failed") {
      await updateTask(taskId, {
        status: "failed",
        errorMessage: sanitizeOutboundMessage(info.error || "فشل الدمج لدى الخدمة").slice(0, 800),
      });
      return {
        kind: "failed",
        text: `❌ فشلت المهمة: ${sanitizeOutboundMessage(info.error || "فشل الدمج لدى الخدمة")}`,
      };
    }

    const progress = Math.max(5, Math.min(95, info.progress));
    await updateTask(taskId, { status: "processing", progress });
    if (notify.hasToken && Date.now() - lastNotifyAt >= 2800) {
      await notify.send(progress, 100, `جارٍ دمج المقاطع… ${progress}%`);
      lastNotifyAt = Date.now();
    }
  }
  return { kind: "processing", task: (await getTask(taskId))! };
}

/** تحديث حي لمهمة دمج عبر get_task */
export async function refreshMergeTask(task: TaskRecord): Promise<ToolOutcome> {
  if (!task.providerTaskId) {
    // الإنشاء لم يكتمل لدى الخدمة — أعد المحاولة من الروابط المخزنة
    const params = JSON.parse(task.paramsJson || "{}") as { urls?: string[] };
    if (!params.urls || params.urls.length < 2) return { kind: "processing", task };
    try {
      const job = await createMergeJob(params.urls);
      await updateTask(task.id, { providerTaskId: job.jobId, status: "processing", progress: 5 });
      await fireProcessInBackground(job.jobId, task.id);
      return { kind: "processing", task: (await getTask(task.id))! };
    } catch (err) {
      if (err instanceof MergerError && err.network) return { kind: "processing", task };
      const reason = sanitizeOutboundMessage(err instanceof Error ? err.message : String(err));
      await updateTask(task.id, { status: "failed", errorMessage: reason.slice(0, 800) });
      return { kind: "failed", text: `❌ فشلت المهمة: ${reason}` };
    }
  }

  const jobId = task.providerTaskId;
  let info: Awaited<ReturnType<typeof getMergeJob>>;
  try {
    info = await getMergeJob(jobId);
  } catch (err) {
    if (err instanceof MergerError && err.notFound) {
      await updateTask(task.id, { status: "failed", errorMessage: err.message.slice(0, 800) });
      return { kind: "failed", text: `❌ فشلت المهمة: ${err.message}` };
    }
    if (err instanceof MergerError && !err.network) {
      await updateTask(task.id, {
        status: "failed",
        errorMessage: sanitizeOutboundMessage(err.message).slice(0, 800),
      });
      return { kind: "failed", text: `❌ فشلت المهمة: ${sanitizeOutboundMessage(err.message)}` };
    }
    return { kind: "processing", task }; // شبكة — تبقى جارية
  }

  if (info.status === "done") {
    const url = mergeResultUrl(info, jobId);
    await updateTask(task.id, {
      status: "completed",
      progress: 100,
      resultUrlsJson: JSON.stringify([url]),
    });
    return { kind: "completed", task: (await getTask(task.id))! };
  }
  if (info.status === "failed") {
    await updateTask(task.id, {
      status: "failed",
      errorMessage: sanitizeOutboundMessage(info.error || "فشل الدمج لدى الخدمة").slice(0, 800),
    });
    return {
      kind: "failed",
      text: `❌ فشلت المهمة: ${sanitizeOutboundMessage(info.error || "فشل الدمج لدى الخدمة")}`,
    };
  }

  // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن (القفل يمنع التزامن)
  await fireProcessInBackground(jobId, task.id);
  const progress = Math.max(task.progress, Math.min(95, info.progress));
  await updateTask(task.id, { status: "processing", progress });
  return { kind: "processing", task: (await getTask(task.id))! };
}
