"use client";

import { useEffect, useMemo, useState } from "react";

const TOOLS: Array<{ name: string; desc: string }> = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي مع تبديل تلقائي لكل المفاتيح النشطة." },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي، وصورة→فيديو اختياري." },
  { name: "merge_videos", desc: "دمج عدة مقاطع في مقطع واحد بالترتيب المطلوب." },
  { name: "get_task", desc: "تتبع حالة أي مهمة بمعرّفها حتى ظهور روابط النتائج." },
  { name: "list_media", desc: "استرجاع الوسائط المخزنة سابقًا بروابطها دون إعادة توليد." },
];

type TabId = "chatgpt" | "claude" | "cursor";

/** بطاقة ربط السيرفر — رابط جاهز للنسخ و JSON لكل عميل MCP */
export default function ConnectPanel({ authRequired }: { authRequired: boolean }) {
  const [origin, setOrigin] = useState("");
  const [tab, setTab] = useState<TabId>("chatgpt");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const mcpUrl = `${origin}/mcp`;
  const headersJson = authRequired
    ? "\n      \"headers\": { \"Authorization\": \"Bearer <MCP_ACCESS_TOKEN>\" },"
    : "";

  const snippets = useMemo<Record<TabId, { json: string; hint: string }>>(() => {
    return {
      chatgpt: {
        json: `{\n  "mcpServers": {\n    "media-generator": {${headersJson}\n      "url": "${mcpUrl}"\n    }\n  }\n}`,
        hint: "في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».",
      },
      claude: {
        json: `{\n  "mcpServers": {\n    "media-generator": {${headersJson}\n      "type": "http",\n      "url": "${mcpUrl}"\n    }\n  }\n}`,
        hint: "الصق في ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop.",
      },
      cursor: {
        json: `{\n  "mcpServers": {\n    "media-generator": {${headersJson}\n      "url": "${mcpUrl}"\n    }\n  }\n}`,
        hint: "الصق في mcp.json (Cursor / Windsurf / Cline) ثم أعد التشغيل.",
      },
    };
  }, [mcpUrl, headersJson]);

  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* المتصفح رفض النسخ */
    }
  };

  const tabs: Array<[TabId, string]> = [
    ["chatgpt", "ChatGPT / GPT Agents"],
    ["claude", "Claude Desktop"],
    ["cursor", "Cursor / Windsurf / Cline"],
  ];

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h2 className="text-xl font-bold">ربط السيرفر بعملاء MCP</h2>

      {/* حقل الرابط المطلق مع زر نسخ */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          readOnly
          dir="ltr"
          value={mcpUrl}
          className="min-w-72 flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-sm"
        />
        <button
          onClick={() => copy(mcpUrl, "url")}
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900"
        >
          {copied === "url" ? "نُسخ ✓" : "نسخ الرابط"}
        </button>
      </div>

      {/* تبويبات JSON لكل عميل */}
      <div className="mt-4 flex flex-wrap gap-2">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${
              tab === id ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-3">
        <pre dir="ltr" className="overflow-x-auto rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">
          {snippets[tab].json}
        </pre>
        <p className="mt-2 text-sm text-slate-500">{snippets[tab].hint}</p>
        <button
          onClick={() => copy(snippets[tab].json, "json")}
          className="mt-2 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-100"
        >
          {copied === "json" ? "نُسخ ✓" : "نسخ JSON"}
        </button>
      </div>

      {/* رقائق الأدوات الخمس */}
      <div className="mt-6">
        <h3 className="text-sm font-bold text-slate-600">الأدوات الخمس المتاحة</h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {TOOLS.map((tool) => (
            <div key={tool.name} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
              <p dir="ltr" className="font-mono text-sm font-bold text-indigo-700">
                {tool.name}
              </p>
              <p className="mt-1 text-xs text-slate-600">{tool.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* الملاحظة الكهرمانية عن سير الفيديو */}
      <div className="mt-5 rounded-lg bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
        الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ —
        وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress
        notifications) حتى لا تنقطع العملية.
      </div>
    </section>
  );
}
