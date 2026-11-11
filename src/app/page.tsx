"use client";

import { useEffect, useState } from "react";
import KeyManager from "@/components/KeyManager";
import TaskBoard from "@/components/TaskBoard";
import ConnectPanel from "@/components/ConnectPanel";

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  authRequired: boolean;
  merger: { base: string; healthy: boolean };
}

/** لوحة الإدارة — هيدر حالة + ثلاث بطاقات: المفاتيح، المهام، الربط */
export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    const load = () => {
      fetch("/api/health")
        .then((r) => r.json())
        .then(setHealth)
        .catch(() => setHealth(null));
    };
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);

  const dbOk = health?.ok && health.database === "turso-connected";

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <div>
          <h1 className="text-2xl font-bold">خادم توليد الوسائط — MCP</h1>
          <p className="mt-1 text-sm text-slate-500">
            توليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — تبديل تلقائي تسلسلي للمفاتيح دون توقف
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 text-sm font-semibold ${
              dbOk ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
            }`}
          >
            {dbOk ? "Turso متصل" : "Turso غير متصل"}
          </span>
          <span
            className={`rounded-full px-3 py-1 text-sm font-semibold ${
              health?.merger?.healthy ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
            }`}
          >
            {health?.merger?.healthy ? "خدمة الدمج جاهزة" : "خدمة الدمج غير متاحة"}
          </span>
          {health?.authRequired && (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-700">
              محمي بـ Bearer token
            </span>
          )}
        </div>
      </header>

      <KeyManager />
      <TaskBoard />
      <ConnectPanel authRequired={health?.authRequired ?? false} />
    </main>
  );
}
