"use client";

import { useCallback, useEffect, useState } from "react";

interface TaskItem {
  id: string;
  provider: string | null;
  model: string;
  type: string;
  status: string;
  progress: number;
  prompt: string;
  resultUrls: string[];
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
}

const TYPE_LABEL: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_LABEL: Record<string, string> = {
  pending: "بانتظار المعالجة",
  processing: "قيد المعالجة",
  completed: "مكتملة",
  failed: "فاشلة",
};
const STATUS_STYLE: Record<string, string> = {
  pending: "bg-slate-200 text-slate-600",
  processing: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
};

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

/** لوحة المهام — إحصائيات + قائمة أحدث المهام تتحدث تلقائيًا كل ~5 ثوانٍ */
export default function TaskBoard() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks");
      const data = await res.json();
      setTasks(data.tasks ?? []);
      setStats(data.stats ?? null);
    } catch {
      /* تجاهل أخطاء التحديث الخلفي */
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const chips: Array<[string, number | undefined, string]> = [
    ["إجمالي", stats?.total, "bg-slate-100 text-slate-700"],
    ["مكتملة", stats?.completed, "bg-green-100 text-green-700"],
    ["فاشلة", stats?.failed, "bg-red-100 text-red-700"],
    ["جارية", stats?.processing, "bg-blue-100 text-blue-700"],
  ];

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">لوحة المهام</h2>
        <div className="flex flex-wrap gap-2">
          {chips.map(([label, value, style]) => (
            <span key={label} className={`rounded-full px-3 py-1 text-sm font-semibold ${style}`}>
              {label}: {value ?? "—"}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {tasks.length === 0 && <p className="text-sm text-slate-500">لا توجد مهام بعد.</p>}
        {tasks.map((task) => (
          <div key={task.id} className="rounded-xl border border-slate-200 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-bold">
                {TYPE_LABEL[task.type] ?? task.type}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[task.status] ?? ""}`}>
                {STATUS_LABEL[task.status] ?? task.status}
              </span>
              <span dir="ltr" className="font-mono text-xs text-slate-500">
                {task.model}
              </span>
              {task.attempts > 0 && (
                <span className="text-xs text-slate-400">محاولات: {task.attempts}</span>
              )}
              <span className="ms-auto text-xs text-slate-400" dir="ltr">
                {new Date(task.createdAt).toLocaleString("ar")}
              </span>
            </div>

            {task.prompt && (
              <p className="mt-2 line-clamp-2 text-sm text-slate-600">{task.prompt}</p>
            )}

            {(task.status === "processing" || task.status === "pending") && (
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="progress-bar h-full rounded-full bg-blue-500"
                  style={{ width: `${Math.max(task.progress, 3)}%` }}
                />
              </div>
            )}

            {task.status === "failed" && task.errorMessage && (
              <p className="mt-2 text-sm text-red-600">الخطأ: {task.errorMessage}</p>
            )}

            {task.resultUrls.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {task.resultUrls.map((url, i) => (
                  <a
                    key={i}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
                  >
                    فتح النتيجة {task.resultUrls.length > 1 ? `(${i + 1})` : ""} ↗
                  </a>
                ))}
              </div>
            )}

            <p dir="ltr" className="mt-2 font-mono text-[10px] text-slate-400">
              task_id: {task.id}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
