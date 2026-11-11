import { createClient, type Client } from "@libsql/client";

/**
 * طبقة Turso — عميل واحد عبر HTTP (libsql:// يُطبَّع إلى https://)
 * لأن الاتصال عبر HTTP الصرف هو المناسب لبيئة Vercel السيرفرلس.
 */
let client: Client | null = null;
let schemaPromise: Promise<void> | null = null;

export function getDb(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرا البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN غير مضبوطين");
    }
    // WebSocket غير ضروري — https:// يعمل عبر Hrana HTTP ويناسب السيرفرلس
    const httpUrl = url.replace(/^libsql:\/\//, "https://").replace(/^turso:\/\//, "https://");
    client = createClient({ url: httpUrl, authToken: token });
  }
  return client;
}

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  provider TEXT,
  provider_task_id TEXT,
  key_id TEXT,
  model TEXT NOT NULL,
  type TEXT NOT NULL,
  prompt TEXT DEFAULT '',
  params_json TEXT DEFAULT '{}',
  status TEXT NOT NULL,
  progress INTEGER DEFAULT 0,
  result_urls_json TEXT,
  error_message TEXT,
  attempts_json TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
)`,
  `CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT DEFAULT '',
  api_key TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`,
  // فهرس بسيط لتسريع قائمة المهام المفروزة زمنيًا
  `CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_keys_provider ON api_keys (provider, created_at)`,
];

/** يُنشئ الجداول عند أول وصول — بلا أداة migrations */
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getDb();
      for (const sql of SCHEMA_SQL) await db.execute(sql);
    })().catch((err) => {
      // فشل مؤقت (شبكة) — اسمح بإعادة المحاولة في الطلب التالي
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

/** فحص جهوزية قاعدة البيانات عبر SELECT 1 */
export async function dbHealthy(): Promise<boolean> {
  try {
    await getDb().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
