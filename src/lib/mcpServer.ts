import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CallToolRequestSchema,
  type ContentBlock,
  type ServerRequest,
  type ServerNotification,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  runGeneration,
  runMerge,
  refreshTask,
  type ProgressNotify,
  type ToolOutcome,
} from "./orchestrator";
import { formatTaskResult, formatMediaList } from "./format";
import { listRecentTasks } from "./tasks";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

/** التعليمات المرسلة مع initialize — تشرح سير العمل لعميل الذكاء الاصطناعي */
export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolHandler = (args: Record<string, unknown>, extra: Extra) => Promise<CallToolResult>;

/** بناء إشعارات التقدم — تُبث فقط إن زوّد العميل الطلب بـ progressToken */
function makeNotify(extra: Extra): ProgressNotify {
  const meta = (extra._meta ?? {}) as { progressToken?: string | number };
  const token = meta.progressToken;
  return {
    hasToken: token !== undefined,
    async send(progress: number, total: number, message: string): Promise<void> {
      if (token === undefined) return;
      try {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress, total, message },
        });
      } catch {
        // العميل أغلق الاتصال — تجاهل بصمت
      }
    },
  };
}

/** تحويل نتيجة المنسّق إلى محتوى أداة MCP */
function outcomeToContent(outcome: ToolOutcome): CallToolResult {
  switch (outcome.kind) {
    case "completed": {
      const formatted = formatTaskResult(outcome.task);
      const content: ContentBlock[] = [];
      if (formatted.image) {
        content.push({ type: "image", data: formatted.image.data, mimeType: formatted.image.mimeType });
      }
      content.push({ type: "text", text: formatted.text });
      return { content };
    }
    case "processing": {
      const formatted = formatTaskResult(outcome.task);
      return { content: [{ type: "text", text: formatted.text }] };
    }
    default:
      return {
        content: [{ type: "text", text: outcome.text }],
        isError: true,
      };
  }
}

/** تسجيل الأدوات الخمس على خادم MCP مع سجل مناولة محلي للردود العربية */
export function buildMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
    capabilities: { tools: {} },
  });

  // ── 1) generate_image ─────────────────────────────────────────────
  const imageSchema = z.object({
    prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
    model: z
      .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
      .default("gpt-image-2-6/flare-text-to-image"),
    aspect_ratio: z
      .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
      .default("auto"),
    resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
    background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
    output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
    wait_seconds: z.number().int().min(0).max(240).default(90),
  });
  const imageHandler: ToolHandler = async (rawArgs, extra) => {
    const args = imageSchema.parse(rawArgs);
    const notify = makeNotify(extra);
    const outcome = await runGeneration(
      {
        prompt: args.prompt,
        model: args.model,
        aspectRatio: args.aspect_ratio,
        resolution: args.resolution,
        background: args.background,
        outputFormat: args.output_format,
        waitSeconds: args.wait_seconds,
      },
      "image",
      notify,
      extra.signal
    );
    return outcomeToContent(outcome);
  };
  server.registerTool("generate_image", {
    description:
      "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active API keys). " +
      "Returns the ready image URL if generation completes within the wait window; otherwise returns task_id with status PROCESSING — " +
      "then call get_task with that task_id every ~10 seconds until completed (show the URL and stop) or failed (explain why).",
    inputSchema: imageSchema.shape,
  }, imageHandler as never);

  // ── 2) generate_video ─────────────────────────────────────────────
  const videoSchema = z.object({
    prompt: z.string().min(1).max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
    image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
    model: z
      .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
      .default("grok-imagine-video-1-5-preview"),
    aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
    resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
    enable_audio: z.boolean().default(true),
    duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
    wait_seconds: z.number().int().min(0).max(240).default(25),
  });
  const videoHandler: ToolHandler = async (rawArgs, extra) => {
    const args = videoSchema.parse(rawArgs);
    const notify = makeNotify(extra);
    const outcome = await runGeneration(
      {
        prompt: args.prompt,
        model: args.model,
        imageUrl: args.image_url,
        aspectRatio: args.aspect_ratio,
        resolution: args.resolution,
        enableAudio: args.enable_audio,
        duration: args.duration,
        waitSeconds: args.wait_seconds,
      },
      "video",
      notify,
      extra.signal
    );
    return outcomeToContent(outcome);
  };
  server.registerTool("generate_video", {
    description:
      "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio: dialogue in the prompt is spoken, plus effects/music; optional image-to-video). " +
      "Video takes minutes: the tool waits briefly while streaming live progress, then returns task_id — " +
      "call get_task with it every ~10 seconds until the video URL appears. Keys switch automatically and silently on any failure.",
    inputSchema: videoSchema.shape,
  }, videoHandler as never);

  // ── 3) merge_videos ───────────────────────────────────────────────
  const mergeSchema = z.object({
    // الحد الأدنى ≥2 يُفحص على المجموع المدمج (task_ids + urls) في المنسّق برسالة عربية
    urls: z
      .array(z.string())
      .max(10, { message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." })
      .optional()
      .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
    task_ids: z
      .array(z.string())
      .max(10, { message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." })
      .optional()
      .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
    wait_seconds: z.number().int().min(0).max(240).default(60),
  });
  const mergeHandler: ToolHandler = async (rawArgs, extra) => {
    const args = mergeSchema.parse(rawArgs);
    const notify = makeNotify(extra);
    const outcome = await runMerge(
      {
        urls: args.urls,
        taskIds: args.task_ids,
        waitSeconds: args.wait_seconds,
      },
      notify,
      extra.signal
    );
    return outcomeToContent(outcome);
  };
  server.registerTool("merge_videos", {
    description:
      "Merge several clips into ONE final high-quality video in the given order. " +
      "Pass 'urls' (public direct video links — e.g. results of generate_video) or 'task_ids' (COMPLETED video generation tasks whose result URLs are resolved from the database in this order — ideal after generating several clips). " +
      "task_ids links come first, then direct urls, each keeping its own order. Merging is usually fast: brief wait with live progress, then task_id — track it with get_task. " +
      "NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
    inputSchema: mergeSchema.shape,
  }, mergeHandler as never);

  // ── 4) get_task ───────────────────────────────────────────────────
  const getTaskSchema = z.object({
    task_id: z.string().min(1),
  });
  const getTaskHandler: ToolHandler = async (rawArgs) => {
    const args = getTaskSchema.parse(rawArgs);
    const outcome = await refreshTask(args.task_id.trim());
    if (outcome.kind === "not_found") {
      return { content: [{ type: "text", text: outcome.text }], isError: true };
    }
    return outcomeToContent(outcome);
  };
  server.registerTool("get_task", {
    description:
      "Track any task by its task_id — image/video generation AND merging (reads the database and refreshes live from the provider/merging service while still running). " +
      "Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
    inputSchema: getTaskSchema.shape,
  }, getTaskHandler as never);

  // ── 5) list_media ─────────────────────────────────────────────────
  const listSchema = z.object({
    type: z.enum(["image", "video", "merge"]).optional(),
    status: z.enum(["completed", "failed", "processing"]).optional(),
    limit: z.number().int().min(1).max(50).default(10),
  });
  const listHandler: ToolHandler = async (rawArgs) => {
    const args = listSchema.parse(rawArgs);
    const tasks = await listRecentTasks(args.limit ?? 10, {
      type: args.type,
      status: args.status,
    });
    return {
      content: [{ type: "text", text: formatMediaList(tasks, { type: args.type, status: args.status }) }],
    };
  };
  server.registerTool("list_media", {
    description:
      "Latest stored images/videos/merges with their result URLs from the database (no regeneration) — recall previously generated media.",
    inputSchema: listSchema.shape,
  }, listHandler as never);

  // سجل المناولة المحلي: أداة مجهولة أو معطيات فاسدة → رد عربي واضح
  const REGISTRY: Record<string, { schema: z.ZodObject<z.ZodRawShape>; handler: ToolHandler }> = {
    generate_image: { schema: imageSchema, handler: imageHandler },
    generate_video: { schema: videoSchema, handler: videoHandler },
    merge_videos: { schema: mergeSchema, handler: mergeHandler },
    get_task: { schema: getTaskSchema, handler: getTaskHandler },
    list_media: { schema: listSchema, handler: listHandler },
  };
  const KNOWN_TOOLS = Object.keys(REGISTRY);

  const inner = server.server;
  inner.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params?.name ?? "(فارغ)";
    const entry = REGISTRY[name];
    if (!entry) {
      return {
        content: [
          {
            type: "text",
            text: `❌ أداة غير معروفة: ${name}. المتاح: ${KNOWN_TOOLS.join(", ")}`,
          },
        ],
        isError: true,
      };
    }
    const parsed = entry.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      return {
        content: [
          {
            type: "text",
            text: `❌ معطيات غير صالحة للأداة ${name}: ${parsed.error.issues
              .map((i) => `${i.path.join(".") || "(الجذر)"}: ${i.message}`)
              .join("؛ ")}`,
          },
        ],
        isError: true,
      };
    }
    return entry.handler(parsed.data as Record<string, unknown>, extra);
  });

  return server;
}
