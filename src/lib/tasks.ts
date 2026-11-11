import { getDb, ensureSchema } from "./turso";

/** عمليات المهام على Turso — كل الرسائل تُخزن كنص والروابط فقط (لا ملفات وسائط إطلاقًا) */
export type TaskType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";

/** سجل محاولة واحدة: تبديل المفاتيح يترك أثرًا كاملًا دون كشف المفتاح الكامل */
export interface AttemptEntry {
  provider: string;
  keyId: string;
  keyLabel: string; // مقنَّع دائمًا
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRecord {
  id: string;
  provider: string | null;
  providerTaskId: string | null;
  keyId: string | null;
  model: string;
  type: TaskType;
  prompt: string;
  paramsJson: string;
  status: TaskStatus;
  progress: number;
  resultUrlsJson: string | null;
  errorMessage: string | null;
  attemptsJson: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface NewTask {
  id: string;
  provider?: string | null;
  providerTaskId?: string | null;
  keyId?: string | null;
  model: string;
  type: TaskType;
  prompt?: string;
  paramsJson?: string;
  status?: TaskStatus;
  progress?: number;
}

export function taskResultUrls(task: TaskRecord): string[] {
  if (!task.resultUrlsJson) return [];
  try {
    const parsed = JSON.parse(task.resultUrlsJson);
    return Array.isArray(parsed) ? parsed.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

export function taskAttempts(task: TaskRecord): AttemptEntry[] {
  try {
    const parsed = JSON.parse(task.attemptsJson || "[]");
    return Array.isArray(parsed) ? (parsed as AttemptEntry[]) : [];
  } catch {
    return [];
  }
}

function toTaskRecord(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    provider: (row.provider as string) ?? null,
    providerTaskId: (row.provider_task_id as string) ?? null,
    keyId: (row.key_id as string) ?? null,
    model: String(row.model ?? ""),
    type: String(row.type ?? "image") as TaskType,
    prompt: String(row.prompt ?? ""),
    paramsJson: String(row.params_json ?? "{}"),
    status: String(row.status ?? "pending") as TaskStatus,
    progress: Number(row.progress ?? 0),
    resultUrlsJson: (row.result_urls_json as string) ?? null,
    errorMessage: (row.error_message as string) ?? null,
    attemptsJson: String(row.attempts_json ?? "[]"),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    completedAt: (row.completed_at as string) ?? null,
  };
}

export async function insertTask(task: NewTask): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      task.id,
      task.provider ?? null,
      task.providerTaskId ?? null,
      task.keyId ?? null,
      task.model,
      task.type,
      task.prompt ?? "",
      task.paramsJson ?? "{}",
      task.status ?? "pending",
      task.progress ?? 0,
    ],
  });
}

export async function getTask(id: string): Promise<TaskRecord | null> {
  await ensureSchema();
  const result = await getDb().execute({ sql: `SELECT * FROM tasks WHERE id = ?`, args: [id] });
  if (result.rows.length === 0) return null;
  return toTaskRecord(result.rows[0] as Record<string, unknown>);
}

export interface TaskPatch {
  provider?: string | null;
  providerTaskId?: string | null;
  keyId?: string | null;
  status?: TaskStatus;
  progress?: number;
  resultUrlsJson?: string | null;
  errorMessage?: string | null;
  newAttempt?: AttemptEntry;
}

/** تحديث جزئي يضيف المحاولات ويضبط completed_at تلقائيًا عند الاكتمال */
export async function updateTask(id: string, patch: TaskPatch): Promise<void> {
  await ensureSchema();
  const sets: string[] = [`updated_at = datetime('now')`];
  const args: unknown[] = [];

  const simple: Array<[string, unknown]> = [];
  if (patch.provider !== undefined) simple.push(["provider", patch.provider]);
  if (patch.providerTaskId !== undefined) simple.push(["provider_task_id", patch.providerTaskId]);
  if (patch.keyId !== undefined) simple.push(["key_id", patch.keyId]);
  if (patch.status !== undefined) simple.push(["status", patch.status]);
  if (patch.progress !== undefined) simple.push(["progress", Math.round(patch.progress)]);
  if (patch.resultUrlsJson !== undefined) simple.push(["result_urls_json", patch.resultUrlsJson]);
  if (patch.errorMessage !== undefined) simple.push(["error_message", patch.errorMessage]);

  for (const [col, val] of simple) {
    sets.push(`${col} = ?`);
    args.push(val);
  }
  if (patch.status === "completed") sets.push(`completed_at = datetime('now')`);

  if (patch.newAttempt) {
    const current = await getTask(id);
    const attempts = current ? taskAttempts(current) : [];
    attempts.push(patch.newAttempt);
    // احتفظ بآخر 30 محاولة فقط حتى لا يتضخم السجل
    sets.push(`attempts_json = ?`);
    args.push(JSON.stringify(attempts.slice(-30)));
  }

  args.push(id);
  await getDb().execute({
    sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
    args: args as never[],
  });
}

export interface TaskFilters {
  type?: string;
  status?: string;
}

export async function listRecentTasks(
  limit: number,
  filters?: TaskFilters
): Promise<TaskRecord[]> {
  await ensureSchema();
  const conditions: string[] = [];
  const args: unknown[] = [];
  if (filters?.type) {
    conditions.push(`type = ?`);
    args.push(filters.type);
  }
  if (filters?.status) {
    conditions.push(`status = ?`);
    args.push(filters.status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  args.push(Math.min(Math.max(limit, 1), 50));
  const result = await getDb().execute({
    sql: `SELECT * FROM tasks ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    args: args as never[],
  });
  return result.rows.map((r) => toTaskRecord(r as Record<string, unknown>));
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const result = await getDb().execute(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  return {
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
    failed: Number(row.failed ?? 0),
    processing: Number(row.processing ?? 0),
  };
}
