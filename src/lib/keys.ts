import { getDb, ensureSchema } from "./turso";
import type { ErrorClass } from "./classify";

/**
 * نظام المفاتيح — الترتيب تسلسلي صارم حسب ترتيب الإضافة (created_at ASC, id ASC).
 * ليس round-robin وليس «الأقل استخدامًا أولًا» — هذا مقصود وقلب المشروع.
 */
export interface KeyRecord {
  id: string;
  provider: string;
  label: string;
  apiKey: string; // يُشترط للمزودين — لا يُعاد أبدًا في أي استجابة خارجية
  status: string;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

/** نسخة آمنة للعرض: مفتاح مقنَّع دائمًا */
export interface PublicKeyRecord extends Omit<KeyRecord, "apiKey"> {
  masked: string;
}

/** maskKey = أول 7 + •••••••• + آخر 4 (وللمفاتيح القصيرة: أول 3 + ••••) */
export function maskKey(key: string): string {
  if (key.length >= 11) return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
  return `${key.slice(0, 3)}••••`;
}

function toKeyRecord(row: Record<string, unknown>): KeyRecord {
  return {
    id: String(row.id),
    provider: String(row.provider),
    label: String(row.label ?? ""),
    apiKey: String(row.api_key ?? ""),
    status: String(row.status ?? "active"),
    usageCount: Number(row.usage_count ?? 0),
    successCount: Number(row.success_count ?? 0),
    failCount: Number(row.fail_count ?? 0),
    lastUsedAt: (row.last_used_at as string) ?? null,
    lastCheckedAt: (row.last_checked_at as string) ?? null,
    lastError: (row.last_error as string) ?? null,
    createdAt: String(row.created_at ?? ""),
  };
}

function toPublic(key: KeyRecord): PublicKeyRecord {
  const { apiKey, ...rest } = key;
  return { ...rest, masked: maskKey(apiKey) };
}

/**
 * جلب مفاتيح المزودات المطلوبة بالترتيب التسلسلي الصارم.
 * المستنزف (exhausted) يبقى في القائمة — الاستثناء الوحيد هو التعطيل اليدوي (disabled).
 */
export async function getKeyPool(providers: string[]): Promise<KeyRecord[]> {
  await ensureSchema();
  const db = getDb();
  const placeholders = providers.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return result.rows.map(toKeyRecord);
}

/** تحديث عدّادات المفتاح دائمًا (نجاح أو فشل) مع تعليم الحالة عند disabled/exhausted */
export async function recordKeyUsage(
  keyId: string,
  ok: boolean,
  errorClass?: ErrorClass,
  error?: string
): Promise<void> {
  const db = getDb();
  if (ok) {
    await db.execute({
      sql: `UPDATE api_keys
            SET usage_count = usage_count + 1, success_count = success_count + 1,
                last_used_at = datetime('now'), last_checked_at = datetime('now'), last_error = NULL
            WHERE id = ?`,
      args: [keyId],
    });
  } else {
    await db.execute({
      sql: `UPDATE api_keys
            SET usage_count = usage_count + 1, fail_count = fail_count + 1,
                last_used_at = datetime('now'), last_checked_at = datetime('now'), last_error = ?,
                status = CASE WHEN ? = 'exhausted' THEN 'exhausted'
                              WHEN ? = 'disabled' THEN 'disabled'
                              ELSE status END
            WHERE id = ?`,
      args: [error ?? null, errorClass ?? "", errorClass ?? "", keyId],
    });
  }
}

export async function listKeys(): Promise<PublicKeyRecord[]> {
  await ensureSchema();
  const result = await getDb().execute(
    `SELECT * FROM api_keys ORDER BY created_at ASC, id ASC`
  );
  return result.rows.map(toKeyRecord).map(toPublic);
}

/** إضافة مفتاح مع رفض التكرار لنفس المزود */
export async function addKey(
  provider: string,
  apiKey: string,
  label: string
): Promise<{ ok: true; key: PublicKeyRecord } | { ok: false; error: string }> {
  await ensureSchema();
  const db = getDb();
  const dup = await db.execute({
    sql: `SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1`,
    args: [provider, apiKey],
  });
  if (dup.rows.length > 0) {
    return { ok: false, error: "هذا المفتاح مضاف مسبقًا لنفس المزود — الرفض لمنع التكرار" };
  }
  const id = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [id, provider, label || "", apiKey],
  });
  const row = await db.execute({ sql: `SELECT * FROM api_keys WHERE id = ?`, args: [id] });
  return { ok: true, key: toPublic(toKeyRecord(row.rows[0] as Record<string, unknown>)) };
}

/** تعطيل/تنشيط يدوي فقط — الحالة التلقائية (exhausted) تُدار من نظام التبديل */
export async function setManualStatus(id: string, status: "active" | "disabled"): Promise<boolean> {
  await ensureSchema();
  const result = await getDb().execute({
    sql: `UPDATE api_keys SET status = ? WHERE id = ?`,
    args: [status, id],
  });
  return result.rowsAffected > 0;
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const result = await getDb().execute({ sql: `DELETE FROM api_keys WHERE id = ?`, args: [id] });
  return result.rowsAffected > 0;
}
