# MCP Media Generator — خادم MCP لتوليد الوسائط

خادم **MCP (Model Context Protocol)** لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع، مع تبديل تسلسلي تلقائي للمفاتيح ولوحة إدارة عربية.

- **توليد صور** من وصف نصي — الموديل المدمج: `gpt-image-2-6/flare-text-to-image`
- **توليد فيديو** بصوت متزامن أصلي (حوار/مؤثرات/موسيقى) — الموديل المدمج: `grok-imagine-video-1-5-preview`
- **دمج عدة مقاطع** في مقطع واحد عالي الجودة وبالترتيب المطلوب (عبر خدمة دمج منفصلة)

## القواعد الجوهرية

1. **لا يُنزَّل أي ملف وسائط على السيرفر إطلاقًا** — الروابط فقط تُخزَّن في قاعدة البيانات.
2. **المفاتيح تُجرَّب بترتيب تسلسلي صارم** حسب ترتيب الإضافة (أول مفتاح أُضيف يُجرَّب أولًا) — ليست round-robin.
3. **تبديل فوري تلقائي** عند أي خطأ أو نفاد رصيد دون توقف المهمة — نفس `task_id` يُستأنف على المفتاح التالي.
4. **نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا** — التبديل صامت من وجهة نظره.
5. مهمة فشل إنشاؤها على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة 45 ثانية).
6. ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة — التحذير مذكور في وصف الأداة وردودها.

## الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة بـ `gpt-image-2-6/flare-text-to-image` مع نافذة انتظار وبث تقدم |
| `generate_video` | توليد فيديو بـ `grok-imagine-video-1-5-preview` (صوت أصلي، image-to-video اختياري) |
| `merge_videos` | دمج مقاطع عبر `urls` (روابط مباشرة) أو `task_ids` (مهام مكتملة بالترتيب) |
| `get_task` | تتبع أي مهمة (توليد أو دمج) وتحديثها حيًا من المزود/الخدمة |
| `list_media` | استرجاع الوسائط المخزنة سابقًا بروابطها |

نتائج الأدوات بالعربية، ووصف الأدوات بالإنجليزية (يقرأها عميل الذكاء الاصطناعي). التوليد غير متزامن: الأداة تعيد `task_id` فورًا (بعد نافذة انتظار قصيرة تبث تقدمًا حيًا)، والعميل يتابع بـ `get_task` كل ~10 ثوانٍ.

## التقنيات

- Next.js 15 (App Router) + TypeScript + Tailwind CSS 4 — RTL عربي كامل
- `@modelcontextprotocol/sdk` — `McpServer` + نقل Streamable HTTP قياسي للويب (وضع عديم الجلسة، مناسب للسيرفرلس)
- Turso (libSQL) عبر HTTP — بلا ملفات SQLite محلية
- المزودون: **kie.ai** (Jobs API الموحد) و **CometAPI** (نقطة OpenAI للصور + `/grok/v1/videos` للفيديو)

## البنية

```
src/
├── app/
│   ├── mcp/route.ts            # خادم MCP (الأدوات الخمس + حماية Bearer اختيارية)
│   ├── page.tsx                # لوحة الإدارة العربية
│   └── api/
│       ├── health/route.ts     # فحص الجهوزية (Turso + خدمة الدمج + الموديلات)
│       ├── keys/route.ts       # قائمة مفاتيح مقنَّعة + إضافة مع رفض تكرار
│       ├── keys/[id]/route.ts  # تعطيل/تنشيط/حذف يدوي
│       └── tasks/route.ts      # أحدث المهام + الإحصائيات للوحة
├── components/                 # KeyManager / TaskBoard / ConnectPanel
└── lib/
    ├── turso.ts                # العميل + ensureSchema + dbHealthy
    ├── keys.ts                 # getKeyPool بالترتيب التسلسلي + maskKey + عدّادات
    ├── classify.ts             # classifyProviderError (disabled/exhausted/provider/params/temporary)
    ├── models.ts               # سجل MODELS والأسماء البديلة والمتجاوزات بالبيئة
    ├── tasks.ts                # عمليات المهام + attempts_json + الإحصائيات
    ├── orchestrator.ts         # runGeneration / runMerge / refreshTask بمنطق التبديل
    ├── merger.ts               # عميل Video Merger API v2
    ├── format.ts               # الصياغة العربية للردود
    ├── mcpServer.ts            # تعريف الأدوات الخمس + SERVER_INSTRUCTIONS
    └── providers/              # kie.ts + cometapi.ts + types.ts
```

## التشغيل المحلي

```bash
npm install
cp .env.example .env.local   # ثم املأ القيم الحقيقية
npm run dev                  # http://localhost:3000
```

## متغيرات البيئة

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | `libsql://<db>-<org>.turso.io` (يُطبَّع داخليًا إلى `https://` للعمل عبر HTTP) |
| `TURSO_AUTH_TOKEN` | ✅ | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | ✅ للدمج | عنوان خدمة الدمج المنشورة (مشروع `video-merger`) |
| `MCP_ACCESS_TOKEN` | — | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | — | تجاوز اسم الموديل المرسل لـ kie.ai |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | — | تجاوز اسم الموديل المرسل لـ CometAPI |

## إنشاء قاعدة Turso

```bash
# بعد تثبيت Turso CLI وتسجيل الدخول
turso db create media-generator
turso db show media-generator --url     # → TURSO_DATABASE_URL
turso db tokens create media-generator  # → TURSO_AUTH_TOKEN
```

الجداول تُنشأ تلقائيًا عند أول وصول (`CREATE TABLE IF NOT EXISTS`) — لا حاجة لأداة migrations.

## إضافة المفاتيح

من الواجهة: بطاقة «مدير المفاتيح» → اختر المزود (kie.ai / CometAPI) + المفتاح → إضافة.
أو عبر الـ API:

```bash
curl -X POST https://<your-app>/api/keys \
  -H "Content-Type: application/json" \
  -d '{"provider":"kie","api_key":"<KIE_API_KEY>","label":"حساب رئيسي"}'
```

- المفاتيح تظهر **مقنَّعة دائمًا** (`b368b05••••••••6c03`) ولا يُعاد المفتاح الكامل في أي استجابة.
- مفتاح مستنزف يُعلَّم `exhausted` ويبقى في القاعدة (يُعاد تجريبه — لو شُحن رصيده اكتملت المهام المعلّقة تلقائيًا).
- مفتاح مرفوض (401/403) يُعلَّم `disabled` تلقائيًا، والتعطيل اليدوي متاح من الواجهة.

## ربط العملاء

الرابط: `<origin>/mcp` — الجاهز في بطاقة «ربط السيرفر» بالواجهة مع JSON جاهز للنسخ:

- **ChatGPT**: Settings → Connectors → Create → Custom MCP server → ضع الرابط في «Server URL».
- **Claude Desktop** (`claude_desktop_config.json`):
  ```json
  {"mcpServers": {"media-generator": {"type": "http", "url": "https://<your-app>/mcp"}}}
  ```
- **Cursor / Windsurf / Cline** (`mcp.json`):
  ```json
  {"mcpServers": {"media-generator": {"url": "https://<your-app>/mcp"}}}
  ```

مثال اختبار يدوي بـ curl:

```bash
# تهيئة
curl -s -X POST https://<your-app>/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'

# قائمة الأدوات
curl -s -X POST https://<your-app>/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

الوضع عديم الجلسة: لا يُطلب `mcp-session-id` — كل طلب مستقل، وهو الأنسب لبيئة Vercel السيرفرلس.

## النشر على Vercel

1. ارفع المستودع إلى GitHub (لا تُرفع `.env*` — مستثناة في `.gitignore` منذ أول commit).
2. في Vercel: Add New → Project → اختر المستودع.
3. أضف متغيرات البيئة في Settings → Environment Variables:
   - `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (إلزاميان)
   - `MERGER_API_BASE` = عنوان خدمة الدمج بعد نشرها
   - `MCP_ACCESS_TOKEN` (اختياري — يحمي `/mcp`)
4. Deploy. كل الاتصالات عبر HTTP (libSQL) والبث يعمل على مسار `/mcp` (`maxDuration = 300`).

> ملاحظة: على خطة Hobby قد تُقص مدة الدالة — خفّض `wait_seconds` (مثلًا 30) واترك المتابعة لـ `get_task`، فهذا سير العمل المصمم أصلًا.

## خدمة الدمج

المشروع الشقيق [video-merger](https://github.com/Wagdyelaraby/video-merger) يوفر نقاط `/api/jobs` المطلوبة (POST /api/jobs، /process، /video بدعم Range، DELETE، /config، /cron) — Node خالص على Vercel بلا مفاتيح، بحدود: 10 مقاطع، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد، وحذف تلقائي بعد 24 ساعة.
