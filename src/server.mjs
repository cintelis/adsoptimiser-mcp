// The Ads Optimiser MCP server: device-flow sign-in, the same generate tools
// as the hosted connector (mcp.adsoptimiser.com.au), and the local-file tools
// that only a process on your own machine can offer.
//
// Every tool maps onto a route of the /api/v1 machine contract. Nothing here
// can publish, schedule, touch ads or campaigns, delete creatives, or change
// billing: the API refuses those routes to tokens (403 token_scope_denied).

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ApiClient,
  ApiError,
  DEFAULT_APP_URL,
  LocalFileError,
  TokenCache,
  cachePathFor,
  describeError,
  isStopError,
  normaliseBaseUrl,
  toToolError,
  toolText,
} from "./api.mjs";
import {
  defaultOutputBase,
  downloadFileName,
  extensionFor,
  inspectLocalMedia,
  listImagesInFolder,
  readPromptsFile,
  resolveOutputFolder,
  saveStream,
} from "./files.mjs";

export const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

export const CLIENT_NAME = "Claude (MCP)";
export const MAX_REFERENCE_IMAGES = 5;
export const MAX_BATCH_ITEMS = 10;
const DEFAULT_IMAGE_MODEL = "grok-imagine-image-2.0";
const DEFAULT_VIDEO_MODEL = "grok-imagine-video";

/** Which API routes each tool calls. Documented contract, asserted in tests. */
export const TOOL_ROUTES = {
  adsoptimiser_connect: ["POST /api/v1/device/code"],
  adsoptimiser_finish_connect: ["POST /api/v1/device/token"],
  adsoptimiser_status: ["GET /api/v1/me"],
  adsoptimiser_disconnect: ["DELETE /api/v1/tokens/current"],
  adsoptimiser_list_models: ["GET /api/v1/models"],
  adsoptimiser_enhance_prompt: ["POST /api/v1/jobs/enhance-prompt"],
  adsoptimiser_generate_image: [
    "POST /api/v1/jobs/source-media",
    "POST /api/v1/jobs",
    "GET /api/v1/jobs/:id",
  ],
  adsoptimiser_generate_video: ["POST /api/v1/jobs/source-media", "POST /api/v1/jobs"],
  adsoptimiser_get_job: ["GET /api/v1/jobs/:id"],
  adsoptimiser_list_jobs: ["GET /api/v1/jobs"],
  adsoptimiser_list_pipelines: ["GET /api/v1/pipelines/templates", "GET /api/v1/pipelines/graphs"],
  adsoptimiser_run_pipeline: ["POST /api/v1/pipelines"],
  adsoptimiser_get_pipeline_run: ["GET /api/v1/pipelines/:run_id"],
  adsoptimiser_upload_file: ["POST /api/v1/jobs/source-media"],
  adsoptimiser_download_job: ["GET /api/v1/jobs/:id", "GET /media/:key"],
  adsoptimiser_batch_generate: ["POST /api/v1/jobs/source-media", "POST /api/v1/jobs"],
};

const INSTRUCTIONS = [
  "Ads Optimiser generates TikTok ad images and videos with Grok.",
  "If a tool says it is not connected, call adsoptimiser_connect and give the user the URL and code; after they approve in the browser, call adsoptimiser_finish_connect.",
  "Every generation uses the workspace's monthly plan allowance, so confirm before generating many at once.",
  "Local files: pass absolute paths. Use adsoptimiser_download_job to save finished media to disk.",
].join(" ");

// ---------------------------------------------------------------------------
// Schemas (names, limits and descriptions match the hosted connector)
// ---------------------------------------------------------------------------

const httpsUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\/\S+$/i, "Must be an https:// URL");
const jobId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "Invalid id");
const localPath = z.string().trim().min(1).max(4096);

export const schemas = {
  connect: z.object({}),
  finish_connect: z.object({}),
  status: z.object({}),
  disconnect: z.object({}),
  list_models: z.object({
    asset_type: z.enum(["image", "video"]).optional().describe("Only list image or video models."),
  }),
  enhance_prompt: z.object({
    prompt: z.string().trim().min(1).max(2000).describe("The rough idea to expand."),
    asset_type: z.enum(["image", "video"]).optional().describe("What the prompt is for."),
    language: z
      .enum(["en", "ru", "es", "de", "ja", "ko"])
      .optional()
      .describe("Language of the rough prompt. The result is always English."),
  }),
  generate_image: z.object({
    prompt: z.string().trim().min(1).max(4000).describe("What to create."),
    model: z
      .string()
      .max(64)
      .optional()
      .describe("Model id from adsoptimiser_list_models. Defaults to grok-imagine-image-2.0."),
    aspect_ratio: z
      .string()
      .max(10)
      .optional()
      .describe("For example 9:16 (TikTok vertical), 1:1 or 16:9. See adsoptimiser_list_models."),
    resolution: z.enum(["1k", "2k"]).optional(),
    quality: z
      .enum(["low", "medium", "auto"])
      .optional()
      .describe("Grok Image 2.0 only. low is fastest (about 13s); medium and auto can take 45 to 50s."),
    reference_image_paths: z
      .array(localPath)
      .min(1)
      .max(MAX_REFERENCE_IMAGES)
      .optional()
      .describe(
        "Local image files (absolute paths; png, jpg, webp or gif, max 10 MB each) to upload and edit or use as references."
      ),
    reference_image_urls: z
      .array(httpsUrl)
      .min(1)
      .max(MAX_REFERENCE_IMAGES)
      .optional()
      .describe("Images to edit or use as references (https URLs, for example media_url values)."),
    reference_job_ids: z
      .array(jobId)
      .min(1)
      .max(MAX_REFERENCE_IMAGES)
      .optional()
      .describe("Finished image jobs to use as references instead of URLs."),
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
    wait: z
      .boolean()
      .optional()
      .describe("Wait briefly for the finished image (default true). false returns the job id at once."),
  }),
  generate_video: z.object({
    prompt: z.string().trim().min(1).max(4000).describe("What should happen in the video."),
    model: z
      .string()
      .max(64)
      .optional()
      .describe("grok-imagine-video (default) or grok-imagine-video-1.5; see adsoptimiser_list_models."),
    duration: z.number().int().min(1).max(15).optional().describe("Seconds, 1 to 15."),
    aspect_ratio: z.string().max(10).optional().describe("Defaults to 9:16 (TikTok vertical)."),
    resolution: z
      .enum(["480p", "720p", "1080p"])
      .optional()
      .describe("Defaults to 720p. 1080p is Grok Video 1.5 only and costs about 3x more."),
    source_image_path: localPath
      .optional()
      .describe("Animate this local image (absolute path; image-to-video). It is uploaded first."),
    source_image_url: httpsUrl.optional().describe("Animate this image (image-to-video)."),
    source_job_id: jobId.optional().describe("Animate the image from this finished image job."),
    voice_ids: z
      .array(z.string().regex(/^[a-z0-9_-]{1,64}$/))
      .min(1)
      .max(3)
      .optional()
      .describe(
        "Preset voices (Grok Video 1.5, text-to-video, max 720p). Tag speech in the prompt as <AUDIO_0>..<AUDIO_2>."
      ),
  }),
  get_job: z.object({ job_id: jobId }),
  list_jobs: z.object({
    status: z.enum(["queued", "generating", "ready", "failed", "expired"]).optional(),
    asset_type: z.enum(["image", "video"]).optional(),
    limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
    offset: z.number().int().min(0).max(10_000).optional(),
  }),
  list_pipelines: z.object({}),
  run_pipeline: z.object({
    template_id: z
      .string()
      .max(64)
      .optional()
      .describe("A template id from adsoptimiser_list_pipelines, for example product-ad."),
    graph_id: jobId.optional().describe("A saved pipeline id from adsoptimiser_list_pipelines."),
    prompt: z
      .string()
      .trim()
      .max(4000)
      .optional()
      .describe("The run prompt. Required unless every step gets its prompt elsewhere."),
  }),
  get_pipeline_run: z.object({ run_id: jobId }),
  upload_file: z.object({
    path: localPath.describe(
      "Absolute path of a local image (png, jpg, webp, gif; max 10 MB) or video (mp4, mov; max 120 MB)."
    ),
    purpose: z
      .enum(["reference", "extend"])
      .optional()
      .describe("Videos only: extend accepts source videos up to 15s instead of 8.7s."),
  }),
  download_job: z.object({
    job_id: jobId,
    folder: z
      .string()
      .max(4096)
      .optional()
      .describe(
        "Folder to save into (created if missing). Defaults to ./adsoptimiser-output, or ADSOPTIMISER_OUTPUT_DIR when set."
      ),
    overwrite: z
      .boolean()
      .optional()
      .describe("Replace a file with the same name. Default false: a numbered name is used instead."),
  }),
  batch_generate: z.object({
    mode: z
      .enum(["image_to_video", "image_edit", "prompts"])
      .describe(
        "image_to_video: one video per image in `folder`. image_edit: one edited image per image in `folder`. prompts: one job per line of `prompts_file`."
      ),
    folder: localPath.optional().describe("Folder of images (png, jpg, webp, gif) for the image modes."),
    prompts_file: localPath
      .optional()
      .describe("Text file with one prompt per line (blank lines and # comments skipped)."),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .optional()
      .describe("Image modes: the instruction applied to every image. Required for them."),
    asset_type: z
      .enum(["image", "video"])
      .optional()
      .describe("prompts mode only: generate images (default) or videos."),
    model: z.string().max(64).optional(),
    aspect_ratio: z.string().max(10).optional().describe("Videos default to 9:16."),
    resolution: z.string().max(10).optional().describe("Images: 1k or 2k. Videos: 480p, 720p or 1080p."),
    quality: z.enum(["low", "medium", "auto"]).optional().describe("Grok Image 2.0 only."),
    duration: z.number().int().min(1).max(15).optional().describe("Videos: seconds, 1 to 15."),
    max_items: z
      .number()
      .int()
      .min(1)
      .max(MAX_BATCH_ITEMS)
      .optional()
      .describe(`How many to queue in this call (default and maximum ${MAX_BATCH_ITEMS}).`),
    offset: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe("Skip this many items first, to resume a batch that stopped."),
  }),
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   baseUrl?: string, appUrl?: string, cacheDir?: string, cwd?: string,
 *   env?: Record<string, string|undefined>, fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>, imageWaitSeconds?: number, pollIntervalMs?: number,
 * }} [options]
 */
export function createServer(options = {}) {
  const env = options.env ?? process.env;
  const baseUrl = normaliseBaseUrl(options.baseUrl ?? env.ADSOPTIMISER_URL);
  const appUrl = (options.appUrl ?? env.ADSOPTIMISER_APP_URL ?? DEFAULT_APP_URL).replace(/\/+$/, "");
  const cwd = options.cwd ?? process.cwd();
  const config = {
    baseUrl,
    appUrl,
    cwd,
    output: defaultOutputBase(cwd, env),
    imageWaitSeconds: options.imageWaitSeconds ?? 30,
    pollIntervalMs: options.pollIntervalMs ?? 3000,
  };
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  const cache = new TokenCache(cachePathFor(baseUrl, options.cacheDir));
  const api = new ApiClient({ baseUrl, cache, fetchImpl });

  const server = new McpServer(
    { name: "adsoptimiser", version: PACKAGE_VERSION },
    { instructions: INSTRUCTIONS }
  );

  const guard = (fn) => async (args) => {
    try {
      return await fn(args ?? {});
    } catch (err) {
      return toToolError(err, config);
    }
  };
  const ok = (message, structured) => toolText(message, { structured });
  const fail = (message, structured) => toolText(message, { isError: true, structured });
  const tool = (name, title, description, schema, annotations, handler) =>
    server.registerTool(name, { title, description, inputSchema: schema, annotations }, guard(handler));

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const mediaUrl = (storageUri) =>
    storageUri ? `${baseUrl}/media/${encodeURIComponent(storageUri)}` : null;
  const jobLink = (id) => `${appUrl}/#/jobs/${encodeURIComponent(id)}`;

  function summarizeJob(job) {
    return {
      job_id: job.job_id,
      asset_type: job.asset_type ?? null,
      status: job.status ?? null,
      model: job.model ?? null,
      prompt: job.prompt ?? null,
      media_url: job.status === "ready" ? mediaUrl(job.storage_uri) : null,
      thumbnail_url: mediaUrl(job.thumbnail_uri),
      app_url: jobLink(job.job_id),
      error: job.error_detail ?? null,
      created_at: job.created_at ?? null,
      updated_at: job.updated_at ?? null,
    };
  }

  function describeJob(summary) {
    const lines = [
      `Job ${summary.job_id}: ${summary.asset_type ?? "asset"} ${summary.status ?? "unknown"} (${summary.model ?? "model unknown"})`,
    ];
    if (summary.media_url) lines.push(`Result: ${summary.media_url}`);
    if (summary.error) lines.push(`Error: ${summary.error}`);
    lines.push(`Open in Ads Optimiser: ${summary.app_url}`);
    return lines.join("\n");
  }

  const getJob = (id) => api.request("GET", `/api/v1/jobs/${encodeURIComponent(id)}`);

  /** Resolve earlier jobs to their media URLs (for references and sources). */
  async function resolveJobMedia(ids, expected) {
    const urls = [];
    for (const id of ids) {
      const job = await getJob(id);
      if (job.status !== "ready" || !job.storage_uri) {
        throw new ApiError(
          400,
          "job_not_ready",
          `Job ${id} is ${job.status ?? "not ready"}; only finished jobs can be used as a source.`
        );
      }
      if (job.asset_type && job.asset_type !== expected) {
        throw new ApiError(400, "wrong_asset_type", `Job ${id} is not an ${expected}.`);
      }
      urls.push(mediaUrl(job.storage_uri));
    }
    return urls;
  }

  /** Upload one validated local file; returns the API's { source_url, key, bytes }. */
  async function uploadLocal(file, purpose) {
    const bytes = await readFile(file.path);
    const form = new FormData();
    form.append("source_type", file.kind);
    if (purpose) form.append("purpose", purpose);
    form.append("file", new Blob([bytes], { type: file.mime }), file.name);
    const result = await api.request("POST", "/api/v1/jobs/source-media", {
      form,
      timeoutMs: 300_000,
    });
    if (typeof result.source_url !== "string" || !result.source_url) {
      throw new ApiError(502, "bad_response", "The upload finished without returning a source_url.");
    }
    return result;
  }

  function imageParams(args, imageUrls) {
    const params = {};
    if (args.aspect_ratio) params.aspect_ratio = args.aspect_ratio;
    if (args.resolution) params.resolution = args.resolution;
    if (args.quality) params.quality = args.quality;
    if (args.seed !== undefined) params.seed = args.seed;
    if (imageUrls?.length) params.image_urls = imageUrls;
    return params;
  }

  function videoParams(args, sourceImage) {
    const params = { aspect_ratio: args.aspect_ratio ?? "9:16" };
    if (args.duration !== undefined) params.duration = args.duration;
    if (args.resolution) params.resolution = args.resolution;
    if (sourceImage) params.image_url = sourceImage;
    if (args.voice_ids?.length) {
      params.reference_audios = args.voice_ids.map((voice_id) => ({ voice_id }));
    }
    return params;
  }

  const createJob = (assetType, prompt, model, params) =>
    api.request("POST", "/api/v1/jobs", {
      json: {
        asset_type: assetType,
        prompt,
        model: model ?? (assetType === "image" ? DEFAULT_IMAGE_MODEL : DEFAULT_VIDEO_MODEL),
        generation_params: params,
      },
    });

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  tool(
    "adsoptimiser_connect",
    "Connect to Ads Optimiser",
    "Start signing in to Ads Optimiser (OAuth device flow). Returns a URL and a code for the user to approve in their browser, where they also choose the workspace; afterwards call adsoptimiser_finish_connect.",
    schemas.connect,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async () => {
      const state = cache.load();
      if (state.token) {
        return ok(
          `Already connected to ${baseUrl}${state.workspaceName ? ` (workspace "${state.workspaceName}")` : ""}. Call adsoptimiser_disconnect first to connect a different workspace.`
        );
      }
      const body = await api.request("POST", "/api/v1/device/code", {
        auth: false,
        json: { client_name: CLIENT_NAME },
      });
      if (!body.device_code || !body.user_code) {
        return fail("Ads Optimiser did not return a device code. Try again shortly.");
      }
      const verificationUri = body.verification_uri_complete ?? body.verification_uri;
      const expiresIn = Number(body.expires_in) || 600;
      cache.save({
        pending: {
          deviceCode: body.device_code,
          userCode: body.user_code,
          verificationUri,
          interval: Number(body.interval) || 5,
          expiresAt: Date.now() + expiresIn * 1000,
          lastPolledAt: null,
        },
      });
      return ok(
        [
          "To connect, the user must approve this device in their browser:",
          "",
          `  1. Open: ${verificationUri}`,
          `  2. Sign in to Ads Optimiser if asked, and check the code on the page matches: ${body.user_code}`,
          "  3. Choose the workspace this connection should use, then approve. The token only works in that workspace, and only for generating and viewing creatives (no publishing, ads, deletes or billing).",
          "",
          `The code expires in ${Math.round(expiresIn / 60)} minutes. Once approved, call adsoptimiser_finish_connect.`,
        ].join("\n"),
        { verification_uri: verificationUri, user_code: body.user_code, expires_in: expiresIn }
      );
    }
  );

  tool(
    "adsoptimiser_finish_connect",
    "Finish connecting",
    "Complete a pending Ads Optimiser sign-in after the user has approved it in the browser.",
    schemas.finish_connect,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async () => {
      const state = cache.load();
      if (state.token) return ok(`Already connected to ${baseUrl}.`);
      const pending = state.pending;
      if (!pending?.deviceCode) {
        return fail("No sign-in is in progress. Call adsoptimiser_connect first.");
      }

      // A few polls at the server's interval, so one call usually suffices
      // right after the user says they approved, without blocking for long if
      // they have not. The interval is honoured across calls too: polling
      // early earns slow_down, which lengthens it for the rest of the flow.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (pending.expiresAt <= Date.now()) {
          cache.clear();
          return fail("The sign-in code expired. Call adsoptimiser_connect to start again.");
        }
        const waitMs = pending.lastPolledAt
          ? pending.lastPolledAt + pending.interval * 1000 - Date.now()
          : 0;
        if (waitMs > 0) await sleep(waitMs);

        let body;
        try {
          body = await api.request("POST", "/api/v1/device/token", {
            auth: false,
            json: {
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: pending.deviceCode,
            },
          });
        } catch (err) {
          pending.lastPolledAt = Date.now();
          if (!(err instanceof ApiError) || err.status === 0 || err.status >= 500) {
            cache.save({ pending });
            throw err;
          }
          const code = err.code ?? "unknown";
          if (code === "authorization_pending") {
            cache.save({ pending });
            continue;
          }
          if (code === "slow_down") {
            const next = Number(err.body?.interval);
            pending.interval = Number.isFinite(next) && next > 0 ? next : pending.interval + 5;
            cache.save({ pending });
            continue;
          }
          cache.clear();
          if (code === "expired_token") {
            return fail("The sign-in code expired. Call adsoptimiser_connect to start again.");
          }
          if (code === "access_denied") {
            return fail(
              `The connection was not approved (${err.message}). Call adsoptimiser_connect to try again.`
            );
          }
          return fail(
            `The connection was not completed (${code}): ${err.message} Call adsoptimiser_connect to start again.`
          );
        }

        if (typeof body.access_token !== "string" || !body.access_token) {
          cache.clear();
          return fail("Ads Optimiser answered without a token. Call adsoptimiser_connect to start again.");
        }
        cache.save({
          token: body.access_token,
          tokenId: body.token_id ?? null,
          workspaceId: body.workspace_id ?? null,
          workspaceName: body.workspace_name ?? null,
          userEmail: body.user_email ?? null,
          connectedAt: new Date().toISOString(),
        });
        const workspace = body.workspace_name ? `"${body.workspace_name}"` : body.workspace_id;
        return ok(
          `Connected${body.user_email ? ` as ${body.user_email}` : ""} to workspace ${workspace} on ${baseUrl}. This connection can generate and view creatives; revoke it any time in the app under Profile > API tokens.`,
          {
            connected: true,
            workspace_id: body.workspace_id ?? null,
            workspace_name: body.workspace_name ?? null,
            user_email: body.user_email ?? null,
          }
        );
      }
      return ok(
        `Still waiting for approval at ${pending.verificationUri} (code ${pending.userCode}). Approve it in the browser, then call adsoptimiser_finish_connect again.`
      );
    }
  );

  tool(
    "adsoptimiser_status",
    "Connection status",
    "Show whether this machine is connected to Ads Optimiser, as which user, to which workspace and with what role.",
    schemas.status,
    { readOnlyHint: true, openWorldHint: false },
    async () => {
      const state = cache.load();
      if (!state.token) {
        if (state.pending?.deviceCode && state.pending.expiresAt > Date.now()) {
          return ok(
            `A sign-in is waiting for approval at ${state.pending.verificationUri} with code ${state.pending.userCode}. Approve it in the browser, then call adsoptimiser_finish_connect.`
          );
        }
        return ok(`Not connected to ${baseUrl}. Call adsoptimiser_connect to start.`, {
          connected: false,
        });
      }
      const me = await api.request("GET", "/api/v1/me");
      return ok(
        `Connected to ${baseUrl} as ${me.user_email} in workspace "${me.workspace_name ?? me.workspace_id}" (role: ${me.role ?? "unknown"}).`,
        { connected: true, ...me }
      );
    }
  );

  tool(
    "adsoptimiser_disconnect",
    "Disconnect",
    "Revoke this machine's Ads Optimiser token and delete it from this machine.",
    schemas.disconnect,
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async () => {
      const state = cache.load();
      if (!state.token) {
        cache.clear();
        return ok("Not connected; nothing to revoke. Any pending sign-in was cancelled.");
      }
      let remote = "revoked on the server";
      try {
        await api.request("DELETE", "/api/v1/tokens/current");
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) {
          remote = `could not be revoked on the server (${describeError(err, config)}); revoke it in the app under Profile > API tokens`;
        }
      }
      cache.clear();
      return ok(`Disconnected: the token was ${remote}, and it was deleted from this machine.`);
    }
  );

  // -------------------------------------------------------------------------
  // Generate and inspect (same behaviour as the hosted connector)
  // -------------------------------------------------------------------------

  tool(
    "adsoptimiser_list_models",
    "List generation models",
    "List the image and video models available for generation with their modes, aspect ratios, resolutions, quality options and indicative cost. Call this before choosing a non-default model.",
    schemas.list_models,
    { readOnlyHint: true, openWorldHint: false },
    async ({ asset_type }) => {
      const catalog = await api.request("GET", "/api/v1/models");
      const models = (catalog.models ?? []).filter((m) => !asset_type || m.asset_type === asset_type);
      const lines = models.map(
        (m) =>
          `- ${m.display_name} (${m.id})${m.default ? " [default]" : ""}: ${m.asset_type}; modes ${(m.modes ?? []).join(", ")}; resolutions ${(m.resolutions ?? []).join(", ") || "n/a"}; ${m.indicative_cost ?? ""}`
      );
      return ok(lines.join("\n") || "No models available.", { models });
    }
  );

  tool(
    "adsoptimiser_enhance_prompt",
    "Enhance a prompt",
    "Expand a rough idea into a detailed prompt tuned for TikTok ad creatives. Returns text only; nothing is generated and no allowance is used.",
    schemas.enhance_prompt,
    { readOnlyHint: true, openWorldHint: true },
    async (args) => {
      const result = await api.request("POST", "/api/v1/jobs/enhance-prompt", { json: args });
      return ok(result.enhanced ?? "", result);
    }
  );

  tool(
    "adsoptimiser_generate_image",
    "Generate an image",
    "Generate an ad image with Grok (or Luma where enabled). Uses one image generation from the workspace's monthly plan allowance. Usually returns the finished image URL; if it takes longer, returns the job id to check with adsoptimiser_get_job. To edit or restyle existing images pass reference_image_paths (local files, uploaded for you), reference_image_urls or reference_job_ids.",
    schemas.generate_image,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (args) => {
      const total =
        (args.reference_image_paths?.length ?? 0) +
        (args.reference_image_urls?.length ?? 0) +
        (args.reference_job_ids?.length ?? 0);
      if (total > MAX_REFERENCE_IMAGES) {
        return fail(`At most ${MAX_REFERENCE_IMAGES} reference images can be used in one generation.`);
      }
      // Check every local file before uploading any of them.
      const files = [];
      for (const p of args.reference_image_paths ?? []) {
        files.push(await inspectLocalMedia(p, { base: config.cwd, expected: "image" }));
      }
      const imageUrls = [...(args.reference_image_urls ?? [])];
      if (args.reference_job_ids?.length) {
        imageUrls.push(...(await resolveJobMedia(args.reference_job_ids, "image")));
      }
      for (const file of files) imageUrls.push((await uploadLocal(file)).source_url);

      let job = await createJob("image", args.prompt, args.model, imageParams(args, imageUrls));
      const waitMs = args.wait === false ? 0 : config.imageWaitSeconds * 1000;
      const polls = Math.floor(waitMs / config.pollIntervalMs);
      for (let i = 0; i < polls && (job.status === "queued" || job.status === "generating"); i++) {
        await sleep(config.pollIntervalMs);
        job = await getJob(job.job_id);
      }

      const summary = summarizeJob(job);
      if (job.status === "failed") return fail(describeJob(summary), summary);
      const tail =
        job.status === "ready"
          ? "\nSave it locally with adsoptimiser_download_job."
          : "\nStill generating. Call adsoptimiser_get_job with this job id in a few seconds.";
      return ok(describeJob(summary) + tail, summary);
    }
  );

  tool(
    "adsoptimiser_generate_video",
    "Generate a video",
    "Start an ad video generation (text-to-video, or image-to-video from source_image_path, source_image_url or source_job_id). Uses one video generation from the plan allowance and counts toward the daily video quota. Returns immediately with a job id; videos take one to several minutes, so check progress with adsoptimiser_get_job.",
    schemas.generate_video,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (args) => {
      const sources = [args.source_image_path, args.source_image_url, args.source_job_id].filter(Boolean);
      if (sources.length > 1) {
        return fail("Pass only one of source_image_path, source_image_url or source_job_id.");
      }
      let sourceImage = args.source_image_url;
      if (args.source_job_id) {
        [sourceImage] = await resolveJobMedia([args.source_job_id], "image");
      }
      if (args.source_image_path) {
        const file = await inspectLocalMedia(args.source_image_path, {
          base: config.cwd,
          expected: "image",
        });
        sourceImage = (await uploadLocal(file)).source_url;
      }
      const job = await createJob("video", args.prompt, args.model, videoParams(args, sourceImage));
      const summary = summarizeJob(job);
      if (job.status === "failed") return fail(describeJob(summary), summary);
      return ok(
        `${describeJob(summary)}\nVideo generation started. It usually takes one to several minutes; call adsoptimiser_get_job with this job id to check.`,
        summary
      );
    }
  );

  tool(
    "adsoptimiser_get_job",
    "Get a creative job",
    "Get the status of an image or video job, with the result URL once it is ready (statuses: queued, generating, ready, failed, expired).",
    schemas.get_job,
    { readOnlyHint: true, openWorldHint: false },
    async ({ job_id }) => {
      const summary = summarizeJob(await getJob(job_id));
      return ok(describeJob(summary), summary);
    }
  );

  tool(
    "adsoptimiser_list_jobs",
    "List recent creative jobs",
    "List recent image and video jobs in the workspace, newest first. Filter by status or asset type.",
    schemas.list_jobs,
    { readOnlyHint: true, openWorldHint: false },
    async (args) => {
      const params = new URLSearchParams({ limit: String(args.limit ?? 10) });
      if (args.offset) params.set("offset", String(args.offset));
      if (args.status) params.set("status", args.status);
      if (args.asset_type) params.set("asset_type", args.asset_type);
      const result = await api.request("GET", `/api/v1/jobs?${params}`);
      const jobs = (result.jobs ?? []).map(summarizeJob);
      const lines = jobs.map(
        (j) =>
          `- ${j.job_id} ${j.asset_type} ${j.status}${j.media_url ? ` ${j.media_url}` : ""} "${String(j.prompt ?? "").slice(0, 80)}"`
      );
      const total = result.total ?? jobs.length;
      return ok(`${total} job(s) in total; showing ${jobs.length}.\n${lines.join("\n")}`, {
        jobs,
        total,
      });
    }
  );

  tool(
    "adsoptimiser_list_pipelines",
    "List pipelines",
    "List pipeline templates and the workspace's saved pipelines that adsoptimiser_run_pipeline can start.",
    schemas.list_pipelines,
    { readOnlyHint: true, openWorldHint: false },
    async () => {
      const [templates, graphs] = await Promise.all([
        api.request("GET", "/api/v1/pipelines/templates"),
        api.request("GET", "/api/v1/pipelines/graphs"),
      ]);
      const templateList = (templates.templates ?? []).map((t) => ({
        template_id: t.id,
        name: t.name,
        description: t.description,
        steps: t.stages,
      }));
      const savedList = (graphs.graphs ?? []).map((g) => ({
        graph_id: g.graph_id,
        name: g.name,
        description: g.description,
        updated_at: g.updated_at,
      }));
      const lines = [
        "Templates:",
        ...templateList.map((t) => `- ${t.template_id}: ${t.name}. ${t.description ?? ""}`),
        "Saved pipelines:",
        ...(savedList.length
          ? savedList.map((g) => `- ${g.graph_id}: ${g.name}`)
          : ["- none yet (build them in the app under Pipelines)"]),
      ];
      return ok(lines.join("\n"), { templates: templateList, saved: savedList });
    }
  );

  tool(
    "adsoptimiser_run_pipeline",
    "Run a pipeline",
    "Start a pipeline run from a template_id or a saved graph_id. Each generation step uses plan allowance like a single job (video steps also count toward the daily video quota). Returns the run id and an estimated provider cost; check progress with adsoptimiser_get_pipeline_run.",
    schemas.run_pipeline,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (args) => {
      if (!!args.template_id === !!args.graph_id) {
        return fail("Pass exactly one of template_id or graph_id (see adsoptimiser_list_pipelines).");
      }
      const body = args.graph_id ? { graph_id: args.graph_id } : { template_id: args.template_id };
      if (args.prompt) body.prompt = args.prompt;
      const result = await api.request("POST", "/api/v1/pipelines", { json: body });
      const run = result.run ?? {};
      const structured = {
        run_id: run.run_id,
        status: run.status,
        steps: (result.stages ?? []).map((s) => s.stage_type),
        estimated_cost_usd: result.estimated_cost_usd ?? null,
        app_url: `${appUrl}/#/pipelines`,
      };
      return ok(
        `Pipeline run ${run.run_id} started (${structured.steps.join(" > ")}). Estimated provider cost about US$${result.estimated_cost_usd ?? "?"}. Check it with adsoptimiser_get_pipeline_run.`,
        structured
      );
    }
  );

  tool(
    "adsoptimiser_get_pipeline_run",
    "Get a pipeline run",
    "Get a pipeline run's status and each step's status, job id and result URL.",
    schemas.get_pipeline_run,
    { readOnlyHint: true, openWorldHint: false },
    async ({ run_id }) => {
      const result = await api.request("GET", `/api/v1/pipelines/${encodeURIComponent(run_id)}`);
      const steps = (result.stages ?? []).map((stage) => {
        const output = stage.output ?? {};
        return {
          step: stage.stage_type,
          status: stage.status,
          job_id: stage.job_id ?? null,
          media_url: mediaUrl(typeof output.storage_uri === "string" ? output.storage_uri : null),
          text: typeof output.text === "string" ? output.text.slice(0, 500) : null,
          error: stage.error_detail ?? null,
        };
      });
      const structured = {
        run_id: result.run?.run_id,
        status: result.run?.status,
        error: result.run?.error_detail ?? null,
        steps,
        app_url: `${appUrl}/#/pipelines`,
      };
      const lines = [
        `Pipeline run ${structured.run_id}: ${structured.status}`,
        ...steps.map(
          (s) =>
            `- ${s.step}: ${s.status}${s.media_url ? ` ${s.media_url}` : ""}${s.error ? ` (error: ${s.error})` : ""}`
        ),
      ];
      return ok(lines.join("\n"), structured);
    }
  );

  // -------------------------------------------------------------------------
  // Local files
  // -------------------------------------------------------------------------

  tool(
    "adsoptimiser_upload_file",
    "Upload a local file",
    "Upload a local image (png, jpg, webp, gif; max 10 MB) or video (mp4, mov; max 120 MB) to Ads Optimiser and return its hosted URL, for use as reference_image_urls or source_image_url. Uses no plan allowance.",
    schemas.upload_file,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ path, purpose }) => {
      const file = await inspectLocalMedia(path, { base: config.cwd });
      if (purpose === "extend" && file.kind !== "video") {
        return fail("purpose extend only applies to videos.");
      }
      const result = await uploadLocal(file, file.kind === "video" ? purpose : undefined);
      const hint =
        file.kind === "image"
          ? "Use it as reference_image_urls in adsoptimiser_generate_image or source_image_url in adsoptimiser_generate_video."
          : "Source videos are used by video edit and extend in the app and API (max 8.7s for edits, 15s for extends).";
      return ok(`Uploaded ${file.name} (${(file.size / 1024).toFixed(0)} kB).\nURL: ${result.source_url}\n${hint}`, {
        source_url: result.source_url,
        source_type: file.kind,
        file_name: file.name,
        bytes: result.bytes ?? file.size,
      });
    }
  );

  tool(
    "adsoptimiser_download_job",
    "Download a finished job",
    "Save a finished job's image or video to a local folder (default ./adsoptimiser-output). The file is named after the job id and prompt, and an existing file is never replaced unless overwrite is true.",
    schemas.download_job,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ job_id, folder, overwrite }) => {
      const target = resolveOutputFolder(folder, config.output);
      const job = await getJob(job_id);
      if (job.status !== "ready" || !job.storage_uri) {
        const next =
          job.status === "queued" || job.status === "generating"
            ? " Check again with adsoptimiser_get_job in a little while."
            : "";
        return fail(`Job ${job_id} is ${job.status ?? "not ready"}; only ready jobs can be downloaded.${next}`);
      }
      const url = mediaUrl(job.storage_uri);
      let res;
      try {
        // Media is served publicly by its unguessable key; the token is not sent.
        res = await fetchImpl(url, { signal: AbortSignal.timeout(300_000) });
      } catch (err) {
        throw new ApiError(0, "network_error", `Could not download ${url}: ${err?.cause?.code ?? err?.message ?? err}.`);
      }
      if (!res.ok || !res.body) {
        throw new ApiError(res.status || 502, "media_unavailable", `The media for job ${job_id} could not be fetched (HTTP ${res.status}).`);
      }
      const ext = extensionFor({
        storageUri: job.storage_uri,
        contentType: res.headers.get("content-type"),
        assetType: job.asset_type,
      });
      const saved = await saveStream(res.body, target, downloadFileName(job.job_id ?? job_id, job.prompt, ext), {
        overwrite: overwrite === true,
      });
      const note = saved.renamed ? " (a file with the intended name already existed, so a numbered name was used)" : "";
      return ok(`Saved ${saved.path} (${(saved.bytes / 1024 / 1024).toFixed(2)} MB)${note}.`, {
        job_id: job.job_id ?? job_id,
        path: saved.path,
        bytes: saved.bytes,
        renamed: saved.renamed,
      });
    }
  );

  tool(
    "adsoptimiser_batch_generate",
    "Batch generate",
    `Queue one job per local image in a folder (image_to_video or image_edit) or per line of a prompts file (prompts). At most ${MAX_BATCH_ITEMS} per call; each job uses plan allowance like a single generation. Stops at a plan limit, quota or rate limit and reports what was queued and the offset to resume from. Returns job ids at once; check them with adsoptimiser_get_job or adsoptimiser_list_jobs.`,
    schemas.batch_generate,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (args) => {
      const offset = args.offset ?? 0;
      const limit = Math.min(args.max_items ?? MAX_BATCH_ITEMS, MAX_BATCH_ITEMS);
      let items;
      let sourceLabel;
      if (args.mode === "prompts") {
        if (!args.prompts_file) return fail("prompts mode needs prompts_file.");
        const { path, prompts } = await readPromptsFile(args.prompts_file, config.cwd);
        items = prompts.map((prompt, i) => ({ label: `line ${i + 1}`, prompt }));
        sourceLabel = path;
      } else {
        if (!args.folder) return fail(`${args.mode} mode needs folder.`);
        if (!args.prompt) return fail(`${args.mode} mode needs prompt (the instruction applied to every image).`);
        const { folder, files } = await listImagesInFolder(args.folder, config.cwd);
        items = files.map((file) => ({ label: file, file }));
        sourceLabel = folder;
      }
      if (items.length === 0) return fail(`Nothing to generate: no usable items in ${sourceLabel}.`);
      if (offset >= items.length) {
        return fail(`offset ${offset} is past the end: ${sourceLabel} has ${items.length} item(s).`);
      }

      const window = items.slice(offset, offset + limit);
      const queued = [];
      const failed = [];
      let stopped = null;
      let processed = 0;
      for (const item of window) {
        try {
          let job;
          if (args.mode === "prompts") {
            if (item.prompt.length > 4000) throw new LocalFileError("prompt is longer than 4000 characters");
            const assetType = args.asset_type ?? "image";
            job =
              assetType === "image"
                ? await createJob("image", item.prompt, args.model, imageParams(args))
                : await createJob("video", item.prompt, args.model, videoParams(args));
          } else {
            const file = await inspectLocalMedia(item.file, { base: config.cwd, expected: "image" });
            const { source_url } = await uploadLocal(file);
            job =
              args.mode === "image_edit"
                ? await createJob("image", args.prompt, args.model, imageParams(args, [source_url]))
                : await createJob("video", args.prompt, args.model, videoParams(args, source_url));
          }
          queued.push({ item: item.label, job_id: job.job_id, status: job.status ?? null });
        } catch (err) {
          if (isStopError(err)) {
            stopped = { item: item.label, reason: describeError(err, config), code: err.code ?? null };
            break;
          }
          failed.push({ item: item.label, reason: describeError(err, config) });
        }
        processed += 1;
      }

      const resumeAt = offset + processed;
      const remaining = items.length - resumeAt;
      const lines = [`Batch from ${sourceLabel}: ${queued.length} queued, ${failed.length} failed.`];
      for (const q of queued) lines.push(`- queued ${q.job_id} for ${q.item}`);
      for (const f of failed) lines.push(`- failed ${f.item}: ${f.reason}`);
      if (stopped) {
        lines.push(`Stopped at ${stopped.item}: ${stopped.reason}`);
      }
      if (remaining > 0) {
        lines.push(
          `${remaining} item(s) not attempted. To continue, call adsoptimiser_batch_generate again with offset ${resumeAt}.`
        );
      }
      if (queued.length) lines.push("Check progress with adsoptimiser_list_jobs or adsoptimiser_get_job.");
      const structured = {
        total_items: items.length,
        offset,
        queued,
        failed,
        stopped,
        next_offset: remaining > 0 ? resumeAt : null,
      };
      return toolText(lines.join("\n"), { structured, isError: queued.length === 0 });
    }
  );

  return { server, config, cache, api };
}
