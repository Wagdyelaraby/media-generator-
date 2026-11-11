"use client";

import { useCallback, useEffect, useState } from "react";

interface KeyItem {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: string;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastError: string | null;
  createdAt: string;
}

const PROVIDER_LABEL: Record<string, string> = {
  kie: "kie.ai",
  cometapi: "CometAPI",
};

const STATUS_STYLE: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  exhausted: "bg-amber-100 text-amber-700",
  disabled: "bg-slate-200 text-slate-500",
};

const STATUS_LABEL: Record<string, string> = {
  active: "نشط",
  exhausted: "مستنزف",
  disabled: "معطّل",
};

/** بطاقة مدير المفاتيح — التجربة تسلسلية (أول مفتاح ثم التالي) مع تبديل فوري تلقائي */
export default function KeyManager() {
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keys");
      const data = await res.json();
      setKeys(data.keys ?? []);
    } catch {
      /* تجاهل أخطاء التحديث الخلفي */
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [load]);

  const addKey = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ text: data.error ?? "فشل الإضافة", ok: false });
      } else {
        setMessage({ text: "أُضيف المفتاح بنجاح — سيُجرَّب أولًا في الترتيب التسلسلي", ok: true });
        setApiKey("");
        setLabel("");
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (key: KeyItem) => {
    const newStatus = key.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${key.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    load();
  };

  const remove = async (key: KeyItem) => {
    await fetch(`/api/keys/${key.id}`, { method: "DELETE" });
    load();
  };

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h2 className="text-xl font-bold">مدير المفاتيح</h2>

      {/* النص التوضيحي الثابت أعلى القائمة */}
      <p className="mt-2 rounded-lg bg-indigo-50 p-3 text-sm text-indigo-800">
        أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري
        تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-slate-600">المزود</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="kie">kie.ai</option>
            <option value="cometapi">CometAPI</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm font-semibold text-slate-600">تسمية (اختياري)</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="مثال: حساب رئيسي"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex min-w-64 flex-1 flex-col gap-1">
          <label className="text-sm font-semibold text-slate-600">المفتاح</label>
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="الصق مفتاح API هنا"
            dir="ltr"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={addKey}
          disabled={busy || !apiKey.trim()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          إضافة المفتاح
        </button>
      </div>

      {message && (
        <p className={`mt-3 text-sm ${message.ok ? "text-green-600" : "text-red-600"}`}>{message.text}</p>
      )}

      <div className="mt-5 space-y-3">
        {keys.length === 0 && (
          <p className="text-sm text-slate-500">لا توجد مفاتيح بعد — أضف أول مفتاح لبدء التوليد.</p>
        )}
        {keys.map((key, index) => (
          <div
            key={key.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-4"
          >
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-slate-400">#{index + 1}</span>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-bold">
                  {PROVIDER_LABEL[key.provider] ?? key.provider}
                </span>
                <span dir="ltr" className="font-mono text-sm">
                  {key.masked}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[key.status] ?? ""}`}>
                  {STATUS_LABEL[key.status] ?? key.status}
                </span>
              </div>
              <div className="text-xs text-slate-500">
                {key.label && <span className="font-semibold">{key.label} — </span>}
                استخدام: {key.usageCount} / نجاح: {key.successCount} / فشل: {key.failCount}
                {key.lastError && <span className="text-red-500"> — آخر خطأ: {key.lastError.slice(0, 80)}</span>}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => toggle(key)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-100"
              >
                {key.status === "disabled" ? "تنشيط" : "تعطيل"}
              </button>
              <button
                onClick={() => remove(key)}
                className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
              >
                حذف
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
