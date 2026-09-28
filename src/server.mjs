// The Ads Optimiser MCP server: device-flow sign-in, the same generate tools
// as the hosted connector (mcp.adsoptimiser.com.au), and the local-file tools
// that only a process on your own machine can offer.
//
// Every tool maps onto a route of the /api/v1 machine contract. Nothing here
// can publish, schedule, touch ads or campaigns, delete creatives, or change
// billing: the API refuses those routes to tokens (403 token_scope_denied).

import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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
import {
  EXAMPLE_DESCRIPTION,
  EXAMPLE_GRAPH,
  GRAPH_RULES,
  LIP_SYNC_MODELS,
  MAX_GRAPH_NODES,
  OPENAI_VOICES,
  compactNodeType,
  describeNodeType,
  localImageRefs,
  needsRunPrompt,
  normaliseGraph,
  shapeErrors,
} from "./pipeline.mjs";
import {
  THUMBNAIL_LIMITS,
  THUMBNAIL_SIZE,
  VIEW_IMAGE_CROP_HINT,
  VIEW_IMAGE_DEFAULT_SIZE,
  VIEW_IMAGE_MAX_IMAGE_BYTES,
  VIEW_IMAGE_MIME_TYPES,
  VIEW_IMAGE_SIZES,
  VIEW_IMAGE_UNSUPPORTED,
  attachThumbnails,
  characterImageTarget,
  characterThumbnails,
  cropError,
  cropParam,
  headerInt,
  jobThumbnail,
  nextSmallerSize,
  viewImageUnsupported,
} from "./thumbnails.mjs";

/* global __ADSOPTIMISER_VERSION__ */
// The bundle (dist/server.mjs) has the version baked in at build time; running
// from source reads it from package.json.
export const PACKAGE_VERSION =
  typeof __ADSOPTIMISER_VERSION__ === "string"
    ? __ADSOPTIMISER_VERSION__
    : JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export const CLIENT_NAME = "Claude (MCP)";
export const MAX_REFERENCE_IMAGES = 5;
export const MAX_BATCH_ITEMS = 10;
export const MAX_CHARACTER_IMAGES = 5;
/** Files list_character_assets saves per call with download_to. */
export const MAX_CHARACTER_DOWNLOADS = 20;
/** Characters hub: the kinds of job a character's gallery holds. */
export const CHARACTER_ASSET_KINDS = ["image", "video", "talking", "lip_sync", "voiceover", "captions"];
/** Kling LipSync refuses source clips over 100 MB (the upload route allows 120). */
export const MAX_LIP_SYNC_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_LIP_SYNC_SCRIPT_CHARS = 900;
/** Friendly names for models whose ids read poorly in a job summary. */
export const MODEL_LABELS = { "kling-lipsync": "Kling LipSync" };
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
    "GET /api/v1/media/thumbnail",
  ],
  adsoptimiser_generate_video: ["POST /api/v1/jobs/source-media", "POST /api/v1/jobs"],
  adsoptimiser_lip_sync: [
    "POST /api/v1/jobs/source-media",
    "GET /api/v1/jobs/:id",
    "POST /api/v1/jobs/lip-sync",
  ],
  adsoptimiser_get_job: ["GET /api/v1/jobs/:id", "GET /api/v1/media/thumbnail"],
  adsoptimiser_list_jobs: ["GET /api/v1/jobs", "GET /api/v1/media/thumbnail"],
  adsoptimiser_list_pipelines: ["GET /api/v1/pipelines/templates", "GET /api/v1/pipelines/graphs"],
  adsoptimiser_run_pipeline: [
    "POST /api/v1/jobs/source-media",
    "POST /api/v1/pipelines/graphs/validate",
    "POST /api/v1/pipelines",
  ],
  adsoptimiser_get_pipeline_run: ["GET /api/v1/pipelines/:run_id"],
  adsoptimiser_get_pipeline_nodes: ["GET /api/v1/pipelines/nodes"],
  adsoptimiser_get_pipeline: ["GET /api/v1/pipelines/graphs/:graph_id"],
  adsoptimiser_validate_pipeline: [
    "POST /api/v1/jobs/source-media",
    "POST /api/v1/pipelines/graphs/validate",
  ],
  adsoptimiser_save_pipeline: [
    "POST /api/v1/jobs/source-media",
    "POST /api/v1/pipelines/graphs",
    "PATCH /api/v1/pipelines/graphs/:graph_id",
  ],
  adsoptimiser_upload_file: ["POST /api/v1/jobs/source-media"],
  adsoptimiser_download_job: ["GET /api/v1/jobs/:id", "GET /media/:key"],
  adsoptimiser_batch_generate: ["POST /api/v1/jobs/source-media", "POST /api/v1/jobs"],
  adsoptimiser_list_characters: ["GET /api/v1/characters"],
  adsoptimiser_get_character: [
    "GET /api/v1/characters/:character_id",
    "GET /api/v1/characters/:character_id/assets",
    "GET /api/v1/characters/:character_id/voice-previews",
    "GET /api/v1/media/thumbnail",
  ],
  adsoptimiser_list_character_assets: [
    "GET /api/v1/characters/:character_id/assets",
    // Only after a 404, to tell an unknown character from an older deployment.
    "GET /api/v1/characters/:character_id",
    "GET /media/:key",
    "GET /api/v1/media/thumbnail",
  ],
  adsoptimiser_create_character: ["POST /api/v1/jobs/source-media", "POST /api/v1/characters"],
  adsoptimiser_update_character: [
    "POST /api/v1/jobs/source-media",
    "PATCH /api/v1/characters/:character_id",
  ],
  adsoptimiser_view_image: [
    // Only for character_id + image_index, to find the image.
    "GET /api/v1/characters/:character_id",
    "GET /api/v1/media/thumbnail",
  ],
  adsoptimiser_list_voices: ["GET /api/v1/voices"],
  adsoptimiser_preview_voice: ["POST /api/v1/voices/preview", "GET /media/:key"],
};

const INSTRUCTIONS = [
  "Ads Optimiser generates TikTok ad images and videos with Grok.",
  "If a tool says it is not connected, call adsoptimiser_connect and give the user the URL and code; after they approve in the browser, call adsoptimiser_finish_connect.",
  "Every generation uses the workspace's monthly plan allowance, so confirm before generating many at once.",
  "Local files: pass absolute paths. Use adsoptimiser_download_job to save finished media to disk.",
  "For a consistent AI person (influencer, brand ambassador): generate a character sheet, save the best shots with adsoptimiser_create_character (local files via image_paths), then pass character_id to adsoptimiser_generate_image, adsoptimiser_generate_video or adsoptimiser_run_pipeline. Audition voices with adsoptimiser_preview_voice. adsoptimiser_get_character summarises what was made with a character; adsoptimiser_list_character_assets lists it all and saves files locally with download_to. For a talking clip in a designed (OpenAI) voice, lip-sync a finished clip with adsoptimiser_lip_sync, or run the character-lip-sync template.",
  `To build a pipeline: call adsoptimiser_get_pipeline_nodes first, use only the node types it lists, keep to ${MAX_GRAPH_NODES} nodes, and check the graph with adsoptimiser_validate_pipeline before saving or running it.`,
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
const characterId = jobId.describe(
  "A character id from adsoptimiser_list_characters or adsoptimiser_create_character."
);
const voiceId = z.string().regex(/^[a-z0-9_-]{1,64}$/, "Invalid voice id");

/** The connector's include_thumbnails flag, with the same wording. */
function includeThumbnails(defaultValue, what) {
  return z
    .boolean()
    .optional()
    .describe(
      `Attach small preview images (${THUMBNAIL_SIZE}px JPEG) of ${what} so you can see them. Default ${defaultValue}.`
    );
}

export const voiceProfileSchema = z
  .discriminatedUnion("provider", [
    z
      .object({
        provider: z.literal("xai"),
        voice_id: voiceId.describe("xAI preset (adsoptimiser_list_voices), e.g. eve, leo, rex."),
      })
      .strict(),
    z
      .object({
        provider: z.literal("openai"),
        voice: z.enum(OPENAI_VOICES).describe("OpenAI gpt-4o-mini-tts voice, e.g. cedar."),
        instructions: z
          .string()
          .trim()
          .max(1000)
          .optional()
          .describe(
            "How to speak: accent, emotion, intonation, pacing, tone, e.g. 'slow, warm, gravelly, rural American accent'."
          ),
        xai_voice_id: voiceId
          .optional()
          .describe(
            "xAI preset talking videos use for this character (they cannot speak OpenAI voices). Default eve."
          ),
      })
      .strict(),
  ])
  .describe(
    "A voice profile: an xAI preset, or an OpenAI voice with delivery instructions (narration and previews)."
  );

const characterFields = {
  description: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .describe(
      "Appearance and persona notes added to every prompt that uses the character, e.g. '101-year-old man, shaved head, long white beard, warm farmer's hands'."
    ),
  style: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe("Look/style notes, e.g. 'realistic skin texture, natural light, not airbrushed'."),
  image_paths: z
    .array(localPath)
    .max(MAX_CHARACTER_IMAGES)
    .optional()
    .describe(
      "Local image files (absolute paths; png, jpg, webp or gif, max 10 MB each) to upload and save as reference images."
    ),
  image_urls: z
    .array(httpsUrl)
    .max(MAX_CHARACTER_IMAGES)
    .optional()
    .describe("https URLs of the character's reference images (e.g. media_url values)."),
  job_ids: z
    .array(jobId)
    .max(MAX_CHARACTER_IMAGES)
    .optional()
    .describe("Finished image jobs to save as reference images (the best shots of a character sheet)."),
  voice: voiceProfileSchema
    .nullable()
    .optional()
    .describe(
      "The character's voice (adsoptimiser_list_voices): an xAI preset, or an OpenAI voice with instructions used for voiceovers (talking videos then use xai_voice_id, else eve). null clears it."
    ),
  default_voice_id: voiceId
    .optional()
    .describe(
      "Shorthand for voice { provider: xai, voice_id } (see adsoptimiser_list_voices), e.g. eve, leo or rex."
    ),
};

const graphNodeId = z.string().max(64).describe("Unique node id: 1 to 40 letters, digits or underscores.");
const pipelineGraph = z
  .object({
    version: z.literal(1).optional().describe("Always 1 (filled in when omitted)."),
    nodes: z
      .array(
        z.object({
          id: graphNodeId,
          type: z
            .string()
            .max(64)
            .describe("A node type from adsoptimiser_get_pipeline_nodes. Never invent one."),
          params: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Params for this node type, from adsoptimiser_get_pipeline_nodes. input_image takes image_url: an https URL or an absolute local file path (uploaded for you)."
            ),
          position: z
            .object({ x: z.number(), y: z.number() })
            .optional()
            .describe("Editor layout only; optional."),
        })
      )
      .min(1)
      .max(50)
      .describe(`The nodes, at most ${MAX_GRAPH_NODES}.`),
    edges: z
      .array(
        z.object({
          from: z.object({ node: graphNodeId, output: z.string().max(64) }),
          to: z.object({ node: graphNodeId, input: z.string().max(64) }),
        })
      )
      .max(200)
      .optional()
      .describe("Connections from an output of one node to an input of another, of the same kind."),
  })
  .describe(
    "A pipeline graph: { version: 1, nodes: [{ id, type, params }], edges: [{ from: { node, output }, to: { node, input } }] }. See adsoptimiser_get_pipeline_nodes."
  );

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
    character_id: characterId
      .optional()
      .describe(
        "Keep a saved character consistent: its images are added as references (5 in total with reference_image_paths/reference_image_urls/reference_job_ids) and its description is added to the prompt."
      ),
    wait: z
      .boolean()
      .optional()
      .describe("Wait briefly for the finished image (default true). false returns the job id at once."),
    include_thumbnails: includeThumbnails(true, "the finished image, when it is ready in time"),
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
        "Preset voices (Grok Video 1.5, text-to-video, max 720p). Tag speech in the prompt as <AUDIO_0>..<AUDIO_2>. Omit to use the character's default voice."
      ),
    character_id: characterId
      .optional()
      .describe(
        "A saved character to star in the video. Without a source image: reference-to-video on Grok Video 1.5 (max 720p) with up to 3 of its images. With a source image: that image stays the first frame and only the character's description is added."
      ),
    script: z
      .string()
      .trim()
      .min(1)
      .max(5000)
      .optional()
      .describe(
        "The exact line spoken to camera (talking video, Grok Video 1.5, text-to-video, max 720p). The voice is voice_ids, else the character's default voice, else eve."
      ),
  }),
  lip_sync: z.object({
    video_job_id: jobId
      .optional()
      .describe(
        "A finished video job to lip-sync (from adsoptimiser_generate_video; 2-10s at 720p or 1080p for Kling)."
      ),
    video_url: httpsUrl.optional().describe("Or an https URL of an .mp4/.mov clip."),
    video_path: localPath
      .optional()
      .describe(
        "Or a local .mp4/.mov clip (absolute path, max 100 MB), uploaded for you. Pass exactly one of video_job_id, video_url or video_path."
      ),
    script: z
      .string()
      .trim()
      .min(1)
      .max(MAX_LIP_SYNC_SCRIPT_CHARS)
      .describe(
        "The exact words the person says. It must fit the clip: about 15 characters a second (an 8s clip fits about 120 characters, about 20 words)."
      ),
    voice: voiceProfileSchema
      .optional()
      .describe(
        "Voice to speak in (adsoptimiser_list_voices). Omit to use character_id's voice, else the voice of the character the video was made from, else eve."
      ),
    character_id: characterId
      .optional()
      .describe("Speak in this saved character's voice when voice is omitted."),
    model: z
      .enum(LIP_SYNC_MODELS)
      .optional()
      .describe("Lip-sync model: kling-lipsync (the default, about US$0.014 per 5 seconds)."),
  }),
  get_job: z.object({
    job_id: jobId,
    include_thumbnails: includeThumbnails(true, "the finished image (or a video's poster frame)"),
  }),
  list_jobs: z.object({
    status: z.enum(["queued", "generating", "ready", "failed", "expired"]).optional(),
    asset_type: z.enum(["image", "video"]).optional(),
    limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
    offset: z.number().int().min(0).max(10_000).optional(),
    include_thumbnails: includeThumbnails(
      false,
      `up to ${THUMBNAIL_LIMITS.list_jobs} finished jobs (images, and videos with a poster frame)`
    ),
  }),
  list_pipelines: z.object({}),
  run_pipeline: z.object({
    template_id: z
      .string()
      .max(64)
      .optional()
      .describe("A template id from adsoptimiser_list_pipelines, for example product-ad."),
    graph_id: jobId.optional().describe("A saved pipeline id from adsoptimiser_list_pipelines."),
    graph: pipelineGraph
      .optional()
      .describe(
        "An unsaved pipeline graph to run as is. Check it with adsoptimiser_validate_pipeline first. Pass exactly one of template_id, graph_id or graph."
      ),
    prompt: z
      .string()
      .trim()
      .max(4000)
      .optional()
      .describe("The run prompt. Required unless every step gets its prompt elsewhere."),
    character_id: characterId
      .optional()
      .describe(
        "Fills every character step that has no character chosen. Required for templates marked needs_character (character-talking-clip, character-scene, character-lip-sync)."
      ),
  }),
  get_pipeline_run: z.object({ run_id: jobId }),
  get_pipeline_nodes: z.object({}),
  get_pipeline: z.object({
    graph_id: jobId.describe("A saved pipeline id from adsoptimiser_list_pipelines or adsoptimiser_save_pipeline."),
  }),
  validate_pipeline: z.object({ graph: pipelineGraph }),
  save_pipeline: z.object({
    name: z.string().trim().min(1).max(200).describe("Name shown in the app's pipeline list."),
    description: z.string().max(2000).optional(),
    graph: pipelineGraph,
    graph_id: jobId
      .optional()
      .describe("Update this saved pipeline instead of creating a new one."),
  }),
  list_characters: z.object({}),
  get_character: z.object({
    character_id: characterId,
    include_thumbnails: includeThumbnails(
      true,
      `the character's reference images (up to ${THUMBNAIL_LIMITS.get_character})`
    ),
  }),
  list_character_assets: z.object({
    character_id: characterId,
    type: z
      .enum(CHARACTER_ASSET_KINDS)
      .optional()
      .describe(
        "Only this kind: image, video, talking (Grok video speaking a preset voice), lip_sync, voiceover or captions."
      ),
    cursor: z
      .string()
      .max(512)
      .optional()
      .describe("next_cursor from a previous call, for the next (older) page."),
    limit: z.number().int().min(1).max(50).optional().describe("Items per page (default 10)."),
    download_to: z
      .string()
      .max(4096)
      .optional()
      .describe(
        `Also save the listed finished assets (images, videos and kept speech mp3s) in this local folder (created if missing), at most ${MAX_CHARACTER_DOWNLOADS} files per call. Use "" for the default ./adsoptimiser-output (or ADSOPTIMISER_OUTPUT_DIR). Existing files are never replaced.`
      ),
    include_thumbnails: includeThumbnails(
      false,
      `up to ${THUMBNAIL_LIMITS.list_character_assets} finished images on this page (videos are not previewed)`
    ),
  }),
  create_character: z.object({
    name: z.string().trim().min(1).max(80).describe("Display name, e.g. Amos."),
    ...characterFields,
  }),
  update_character: z.object({
    character_id: characterId,
    name: z.string().trim().min(1).max(80).optional(),
    ...characterFields,
  }),
  view_image: z.object({
    job_id: jobId.optional().describe("A finished image job (or a video job with a poster frame)."),
    key: z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .optional()
      .describe("A media storage key in this workspace, e.g. the part of a media URL after /media/."),
    character_id: characterId
      .optional()
      .describe("A saved character; pass image_index to choose which reference image."),
    image_index: z
      .number()
      .int()
      .min(1)
      .max(MAX_CHARACTER_IMAGES)
      .optional()
      .describe(`Which of the character's reference images, 1 to ${MAX_CHARACTER_IMAGES} (as listed by adsoptimiser_get_character).`),
    size: z
      .union(VIEW_IMAGE_SIZES.map((n) => z.literal(n)))
      .optional()
      .describe(`Longest side in px: ${VIEW_IMAGE_SIZES.join(", ")}. Default ${VIEW_IMAGE_DEFAULT_SIZE}. Images are never upscaled.`),
    crop: z
      .object({
        x: z.number().min(0).max(1).describe("Left edge, as a fraction of the original width."),
        y: z.number().min(0).max(1).describe("Top edge, as a fraction of the original height."),
        width: z.number().min(0).max(1).describe("Width, as a fraction of the original (at least 0.05)."),
        height: z.number().min(0).max(1).describe("Height, as a fraction of the original (at least 0.05)."),
      })
      .strict()
      .optional()
      .describe(
        "Zoom into a region: fractions of the original image, applied before scaling. x + width and y + height must not exceed 1. Example { x: 0.3, y: 0.5, width: 0.4, height: 0.3 }."
      ),
    save_to: z
      .string()
      .max(4096)
      .optional()
      .describe(
        "Also save the returned image in this local folder (created if missing). Use \"\" for the default ./adsoptimiser-output (or ADSOPTIMISER_OUTPUT_DIR). Existing files are never replaced."
      ),
  }),
  list_voices: z.object({}),
  preview_voice: z.object({
    voice: voiceProfileSchema,
    text: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .optional()
      .describe("What to say (at most 300 characters). Omit for a default sample line."),
    character_id: characterId
      .optional()
      .describe("Record the preview in this character's voice preview history."),
    save_to: z
      .string()
      .max(4096)
      .optional()
      .describe(
        "Also save the sample as an mp3 in this local folder (created if missing) so the user can play it. Use \"\" for the default ./adsoptimiser-output (or ADSOPTIMISER_OUTPUT_DIR)."
      ),
  }),
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
// Characters (formatting matches the hosted connector)
// ---------------------------------------------------------------------------

export function summarizeCharacter(character) {
  const images = character.images ?? (character.image_urls ?? []).map((url) => ({ url, job_id: null }));
  return {
    character_id: character.character_id,
    name: character.name ?? null,
    description: character.description ?? null,
    style: character.style ?? null,
    voice: character.voice ?? null,
    default_voice_id: character.default_voice_id ?? null,
    image_count: images.length,
    images,
    updated_at: character.updated_at ?? null,
  };
}

/** "leo", or "openai cedar (talking videos: rex)" for an OpenAI voice. */
export function voiceLabel(summary) {
  const voice = summary.voice;
  if (voice?.provider === "openai") {
    return `openai ${voice.voice} (talking videos: ${voice.xai_voice_id ?? "eve"})`;
  }
  return String(voice?.voice_id ?? summary.default_voice_id ?? "none");
}

function describeCharacter(summary) {
  const voice = summary.voice;
  return [
    `Character ${summary.character_id}: ${summary.name} (${summary.images.length} image(s), voice ${voiceLabel(summary)})`,
    ...(voice?.provider === "openai" && voice.instructions ? [`Voice instructions: ${voice.instructions}`] : []),
    ...(summary.description ? [`Description: ${summary.description}`] : []),
    ...(summary.style ? [`Style: ${summary.style}`] : []),
    ...summary.images.map((image) => `- ${image.url}${image.job_id ? ` (from ${image.job_id})` : ""}`),
  ].join("\n");
}

/** One gallery item, as the hosted connector summarises it. */
export function summarizeAsset(asset, jobLink) {
  return {
    job_id: asset.job_id,
    kind: asset.kind ?? null,
    asset_type: asset.asset_type ?? null,
    status: asset.status ?? null,
    model: asset.model ?? null,
    media_url: asset.media_url ?? null,
    thumbnail_url: asset.thumbnail_url ?? null,
    speech_url: asset.speech_url ?? null,
    script: asset.script ?? null,
    voice: asset.voice ?? null,
    pipeline_run_id: asset.pipeline_run_id ?? null,
    app_url: jobLink(asset.job_id),
    created_at: asset.created_at ?? null,
  };
}

function describeAsset(asset) {
  return [
    `- ${asset.job_id} ${asset.kind ?? asset.asset_type} ${asset.status}`,
    asset.media_url ? ` ${asset.media_url}` : "",
    asset.speech_url ? ` (speech ${asset.speech_url})` : "",
    asset.script ? ` says "${String(asset.script).slice(0, 80)}"` : "",
  ].join("");
}

/** "3 image, 1 talking" from a counts object (zero kinds omitted). */
export function describeCounts(counts) {
  if (!counts) return "no counts";
  const parts = CHARACTER_ASSET_KINDS.filter((kind) => Number(counts[kind] ?? 0) > 0).map(
    (kind) => `${counts[kind]} ${kind}`
  );
  return parts.length ? parts.join(", ") : "nothing generated yet";
}

/** The character body fields shared by create and update (image_paths already resolved). */
function characterBody(args) {
  const body = {};
  for (const key of ["name", "description", "style", "image_urls", "job_ids", "voice", "default_voice_id"]) {
    if (args[key] !== undefined) body[key] = args[key];
  }
  return body;
}

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

  /** `url` when it is this deployment's /media route (same origin), else null. */
  function ownMediaUrl(url) {
    if (typeof url !== "string" || !url) return null;
    try {
      const candidate = new URL(url);
      const ours = new URL(baseUrl);
      const isMedia = candidate.pathname.startsWith("/media/") && candidate.pathname.length > "/media/".length;
      return candidate.origin === ours.origin && isMedia ? candidate.href : null;
    } catch {
      return null;
    }
  }

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
      ...(job.model && MODEL_LABELS[job.model] ? { model_label: MODEL_LABELS[job.model] } : {}),
      // Set when a talking video could not speak the character's OpenAI voice.
      ...(typeof job.generation_params?.voice_note === "string"
        ? { voice_note: job.generation_params.voice_note }
        : {}),
      ...(job.generation_params?.source_mode === "lip_sync"
        ? { lip_sync: lipSyncDetails(job.generation_params) }
        : {}),
      created_at: job.created_at ?? null,
      updated_at: job.updated_at ?? null,
    };
  }

  /** What a lip-sync job's generation_params say about its source and voice. */
  function lipSyncDetails(params) {
    const voice = params.voice;
    let voiceText = null;
    if (voice?.provider === "openai" && voice.voice) voiceText = `openai ${voice.voice}`;
    else if (voice?.provider === "xai" && voice.voice_id) voiceText = `xai ${voice.voice_id}`;
    else if (typeof params.voice_id === "string") voiceText = `xai ${params.voice_id}`;
    return {
      source_job_id: typeof params.source_job_id === "string" ? params.source_job_id : null,
      voice: voiceText,
      voice_instructions: voice?.provider === "openai" && voice.instructions ? voice.instructions : null,
      voice_source: typeof params.voice_source === "string" ? params.voice_source : null,
      audio_duration_seconds:
        typeof params.audio_duration_seconds === "number" ? params.audio_duration_seconds : null,
    };
  }

  function describeJob(summary) {
    const kind = summary.lip_sync ? "lip-sync video" : (summary.asset_type ?? "asset");
    const model = summary.model_label ?? summary.model ?? "model unknown";
    const lines = [`Job ${summary.job_id}: ${kind} ${summary.status ?? "unknown"} (${model})`];
    if (summary.media_url) lines.push(`Result: ${summary.media_url}`);
    if (summary.error) lines.push(`Error: ${summary.error}`);
    if (summary.lip_sync) {
      const l = summary.lip_sync;
      const bits = [];
      if (l.voice) bits.push(`spoken in ${l.voice}${l.voice_source ? ` (voice from ${l.voice_source})` : ""}`);
      if (l.audio_duration_seconds !== null) bits.push(`${l.audio_duration_seconds.toFixed(1)}s of speech`);
      if (l.source_job_id) bits.push(`source video job ${l.source_job_id}`);
      if (bits.length) lines.push(`Lip-sync: ${bits.join(", ")}.`);
      if (l.voice_instructions) lines.push(`Voice instructions: ${l.voice_instructions}`);
    }
    if (summary.voice_note) lines.push(`Voice: ${summary.voice_note}`);
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

  // Uploaded local files by path, size and modification time, so validating
  // and then saving or running the same graph (or retrying a character save)
  // uploads each file once.
  const uploadedImages = new Map();

  /** Check local images (all of them, before uploading any), then upload each once. */
  async function uploadLocalImages(paths) {
    const files = [];
    for (const p of paths) {
      const file = await inspectLocalMedia(p, { base: config.cwd, expected: "image" });
      const { mtimeMs } = await stat(file.path);
      files.push({ file, key: `${file.path}|${file.size}|${mtimeMs}` });
    }
    const results = [];
    for (const { file, key } of files) {
      let url = uploadedImages.get(key);
      if (!url) {
        url = (await uploadLocal(file)).source_url;
        uploadedImages.set(key, url);
      }
      results.push({ path: file.path, url });
    }
    return results;
  }

  /**
   * Fetch public media (served by its unguessable key; the token is never
   * sent) and stream it into `folder` without replacing an existing file
   * unless asked. `fileName` may be a function of the response content type.
   */
  async function downloadMedia(url, folder, fileName, { overwrite = false, what = "the media" } = {}) {
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(300_000) });
    } catch (err) {
      throw new ApiError(0, "network_error", `Could not download ${url}: ${err?.cause?.code ?? err?.message ?? err}.`);
    }
    if (!res.ok || !res.body) {
      throw new ApiError(res.status || 502, "media_unavailable", `${what} could not be fetched (HTTP ${res.status}).`);
    }
    const contentType = res.headers.get("content-type");
    const name = typeof fileName === "function" ? fileName(contentType) : fileName;
    return { saved: await saveStream(res.body, folder, name, { overwrite }), contentType };
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

  /** `extra` holds top-level job fields (character_id, script); undefined ones are left out. */
  const createJob = (assetType, prompt, model, params, extra = {}) =>
    api.request("POST", "/api/v1/jobs", {
      json: {
        asset_type: assetType,
        prompt,
        model: model ?? (assetType === "image" ? DEFAULT_IMAGE_MODEL : DEFAULT_VIDEO_MODEL),
        generation_params: params,
        ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== "")),
      },
    });

  // -------------------------------------------------------------------------
  // Pipeline builder helpers
  // -------------------------------------------------------------------------

  const editorUrl = `${appUrl}/#/pipeline-editor`;

  /**
   * Builder routes are refused to tokens by deployments that predate them, and
   * a rejected graph comes back as 400 { errors: [...] }. Both get a message
   * that says what to do, instead of the generic one.
   */
  const builderGuard = (fn, { builderRoute = true } = {}) => async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      if (builderRoute && err instanceof ApiError && err.status === 403 && err.code === "token_scope_denied") {
        return fail(
          `This deployment doesn't support pipeline building yet (the API refused ${err.message ? `it: ${err.message}` : "the request"}). Build the pipeline in the app at ${editorUrl}, or run a template or saved pipeline with adsoptimiser_run_pipeline.`,
          { status: err.status, code: err.code, message: err.message }
        );
      }
      if (err instanceof ApiError && err.status === 400 && Array.isArray(err.body?.errors)) {
        const errors = shapeErrors(err.body.errors);
        return fail(
          [`The pipeline graph was rejected: ${err.message}`, ...errors.map((e) => `- ${e.message}`)].join("\n"),
          { valid: false, errors }
        );
      }
      throw err;
    }
  };

  /**
   * Replace local file paths in input_image nodes with hosted URLs. Every file
   * is checked before any is uploaded. Returns the rewritten copy of the graph.
   */
  async function resolveGraphFiles(rawGraph) {
    const graph = normaliseGraph(rawGraph);
    const refs = localImageRefs(graph);
    for (const ref of refs) {
      if (ref.conflict) {
        throw new LocalFileError(
          `input_image node "${ref.node.id}" has both image_url and image_path; give only one.`
        );
      }
    }
    const uploaded = await uploadLocalImages(refs.map((ref) => ref.path));
    const uploads = refs.map((ref, i) => {
      const params = { ...(ref.node.params ?? {}), image_url: uploaded[i].url };
      delete params.image_path;
      ref.node.params = params;
      return { node_id: ref.node.id, path: uploaded[i].path, image_url: uploaded[i].url };
    });
    return { graph, uploads };
  }

  /** POST /graphs/validate, shaped for the tools. */
  async function validateGraph(graph) {
    const result = await api.request("POST", "/api/v1/pipelines/graphs/validate", { json: { graph } });
    const valid = typeof result.valid === "boolean" ? result.valid : result.ok === true;
    return {
      valid,
      errors: shapeErrors(result.errors),
      estimated_cost_usd: typeof result.estimated_cost_usd === "number" ? result.estimated_cost_usd : null,
      // Prefer the API's own figures when it sends them; count locally otherwise.
      node_count: Number.isInteger(result.node_count)
        ? result.node_count
        : Array.isArray(graph.nodes)
          ? graph.nodes.length
          : 0,
      needs_run_prompt: needsRunPrompt(result, graph),
    };
  }

  const usd = (value) => (typeof value === "number" ? `US$${value.toFixed(2)}` : "unknown");

  function describeValidation(v) {
    if (!v.valid) {
      return [
        `The graph is not valid (${v.errors.length} problem${v.errors.length === 1 ? "" : "s"}):`,
        ...v.errors.map((e) => `- ${e.message}`),
        "Fix these using the node catalogue from adsoptimiser_get_pipeline_nodes, then validate again.",
      ].join("\n");
    }
    return `The graph is valid: ${v.node_count} node${v.node_count === 1 ? "" : "s"}, estimated provider cost about ${usd(v.estimated_cost_usd)} per run. ${
      v.needs_run_prompt
        ? "Running it needs a prompt (some prompt input is not wired)."
        : "Running it needs no prompt (every prompt input is wired)."
    }`;
  }

  function describeUploads(uploads) {
    return uploads.length
      ? `\nUploaded ${uploads.length} local image${uploads.length === 1 ? "" : "s"} for input_image nodes (${uploads
          .map((u) => u.node_id)
          .join(", ")}).`
      : "";
  }

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
    "Generate an ad image with Grok (or Luma where enabled). Uses one image generation from the workspace's monthly plan allowance. Usually returns the finished image URL with a small preview so you can check it; if it takes longer, returns the job id to check with adsoptimiser_get_job. To edit or restyle existing images pass reference_image_paths (local files, uploaded for you), reference_image_urls or reference_job_ids. For an AI influencer, first generate a character sheet (the same person from several angles, a full-body shot and a close-up, neutral white background, realistic unretouched skin), save the best shots with adsoptimiser_create_character, then pass character_id to place that person in new scenes (porch, kitchen, garden...).",
    schemas.generate_image,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (args) => {
      const total =
        (args.reference_image_paths?.length ?? 0) +
        (args.reference_image_urls?.length ?? 0) +
        (args.reference_job_ids?.length ?? 0);
      // A character's images share the provider's 5 slots.
      if (total > (args.character_id ? MAX_REFERENCE_IMAGES - 1 : MAX_REFERENCE_IMAGES)) {
        return fail(
          args.character_id
            ? `With character_id at most ${MAX_REFERENCE_IMAGES - 1} other reference images can be used (${MAX_REFERENCE_IMAGES} in total).`
            : `At most ${MAX_REFERENCE_IMAGES} reference images can be used in one generation.`
        );
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

      let job = await createJob("image", args.prompt, args.model, imageParams(args, imageUrls), {
        character_id: args.character_id,
      });
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
      const result = ok(describeJob(summary) + tail, summary);
      const preview = args.include_thumbnails === false ? {} : jobThumbnail(job);
      if (!preview.target) return result;
      return attachThumbnails(api, result, [preview.target], THUMBNAIL_LIMITS.generate_image);
    }
  );

  tool(
    "adsoptimiser_generate_video",
    "Generate a video",
    "Start an ad video generation (text-to-video, or image-to-video from source_image_path, source_image_url or source_job_id). Uses one video generation from the plan allowance and counts toward the daily video quota. Returns immediately with a job id; videos take one to several minutes, so check progress with adsoptimiser_get_job. For a consistent AI influencer pass character_id: with script (the exact words) and no source image you get a 9:16 talking-to-camera clip in the character's voice (talking videos speak xAI preset voices; for a designed OpenAI voice, generate the clip at 720p and follow with adsoptimiser_lip_sync); for silent b-roll, animate a scene image of the character (source_job_id from adsoptimiser_generate_image with character_id) and add on-screen text with a pipeline's add_captions step.",
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
      // A character or a script without a first frame is reference-to-video,
      // which only Grok Video 1.5 serves.
      const referenceToVideo = !sourceImage && Boolean(args.character_id || args.script);
      const job = await createJob(
        "video",
        args.prompt,
        args.model ?? (referenceToVideo ? "grok-imagine-video-1.5" : DEFAULT_VIDEO_MODEL),
        videoParams(args, sourceImage),
        { character_id: args.character_id, script: args.script }
      );
      const summary = summarizeJob(job);
      if (job.status === "failed") return fail(describeJob(summary), summary);
      return ok(
        `${describeJob(summary)}\nVideo generation started. It usually takes one to several minutes; call adsoptimiser_get_job with this job id to check.`,
        summary
      );
    }
  );

  /**
   * The lip-sync route's refusals, each with what to do next. Anything else
   * (plan limit, daily quota, OpenAI voices off, rate limits) keeps the
   * general message.
   */
  function describeLipSyncError(err) {
    if (!(err instanceof ApiError)) return null;
    const msg = String(err.message ?? "").replace(/[.\s]+$/, "");
    if (err.status === 403 && err.code === "token_scope_denied") {
      return `This deployment doesn't support lip-sync yet (the API refused it: ${msg}). For a talking clip, use adsoptimiser_generate_video with a script (xAI preset voices).`;
    }
    if (err.status === 503 && err.code === "lip_sync_not_configured") {
      return `Lip-sync isn't configured on this Ads Optimiser deployment (${msg}). Nothing was charged. For a talking clip, use adsoptimiser_generate_video with a script (xAI preset voices) instead.`;
    }
    if (err.status === 400 && err.code === "invalid_source_video") {
      return `The source video can't be lip-synced: ${msg}. Kling LipSync needs a finished 2 to 10 second clip at 720p or 1080p (each side 720 to 1920 px, at most 100 MB), so generate it at 720p, not 480p. Nothing was charged.`;
    }
    if (err.status === 400 && err.code === "invalid_script") {
      return `The line doesn't fit the clip: ${msg}. Speech runs about 15 characters a second, so an 8 second clip fits about 20 words. Shorten the script or use a longer clip (up to 10 seconds). Nothing was charged.`;
    }
    if (err.status === 400 && err.code === "invalid_audio") {
      return `The speech can't be used for lip-sync: ${msg}. It must run 2 to 60 seconds and be no longer than the clip. Nothing was charged.`;
    }
    if (err.status === 502 && err.code === "tts_failed") {
      return `The line could not be spoken (${msg}). Nothing was charged; try again shortly, or try another voice (adsoptimiser_list_voices).`;
    }
    if (err.status === 404) {
      return `Not found: ${msg}. Check video_job_id (adsoptimiser_list_jobs) and character_id (adsoptimiser_list_characters).`;
    }
    if (err.status === 409) {
      return `The source video isn't ready yet (${msg}). Wait until adsoptimiser_get_job shows it ready, then try again.`;
    }
    return null;
  }

  tool(
    "adsoptimiser_lip_sync",
    "Lip-sync a video to a line",
    "Make the person in an existing video say a new line in a designed voice: the script is spoken (OpenAI voice with instructions, or an xAI preset; by default the character's own voice) and the mouth is re-animated to match (Kling LipSync on fal.ai). The source is a finished video job, an https URL or a local .mp4/.mov file (video_path, max 100 MB, uploaded for you). Kling's limits: the clip must be 2 to 10 seconds at 720p or 1080p (generate it at 720p, not 480p), and the speech must fit the clip at about 15 characters a second (about 20 words for an 8 second clip). Uses one video generation from the plan allowance and counts toward the daily video quota (about US$0.014 per 5 seconds of clip). Returns a job id at once; it takes 2 to 5 minutes, so follow it with adsoptimiser_get_job. For a whole character talking clip in one go, run the character-lip-sync template with adsoptimiser_run_pipeline.",
    schemas.lip_sync,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (args) => {
      const sources = [args.video_job_id, args.video_url, args.video_path].filter(Boolean);
      if (sources.length !== 1) {
        return fail("Pass exactly one of video_job_id, video_url or video_path.");
      }
      try {
        let videoUrl = args.video_url;
        let upload = null;
        if (args.video_path) {
          // Checked on this machine first: nothing is uploaded or charged for a bad file.
          const file = await inspectLocalMedia(args.video_path, { base: config.cwd, expected: "video" });
          if (file.size > MAX_LIP_SYNC_VIDEO_BYTES) {
            throw new LocalFileError(
              `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; lip-sync source videos are limited to ${MAX_LIP_SYNC_VIDEO_BYTES / 1024 / 1024} MB.`
            );
          }
          videoUrl = (await uploadLocal(file)).source_url;
          upload = { path: file.path, video_url: videoUrl };
        }
        if (args.video_job_id) {
          // Fail fast (and free) on an unfinished or non-video source.
          await resolveJobMedia([args.video_job_id], "video");
        }
        const body = {
          ...(args.video_job_id ? { video_job_id: args.video_job_id } : { video_url: videoUrl }),
          script: args.script,
          ...(args.voice ? { voice: args.voice } : {}),
          ...(args.character_id ? { character_id: args.character_id } : {}),
          ...(args.model ? { model: args.model } : {}),
        };
        const job = await api.request("POST", "/api/v1/jobs/lip-sync", { json: body });
        const summary = {
          ...summarizeJob(job),
          estimated_cost_usd: typeof job.estimated_cost_usd === "number" ? job.estimated_cost_usd : null,
          ...(upload ? { upload } : {}),
        };
        if (job.status === "failed") return fail(describeJob(summary), summary);
        return ok(
          `${describeJob(summary)}${upload ? `\nUploaded ${upload.path} as the source video.` : ""}\nLip-sync started (estimated provider cost ${usd(summary.estimated_cost_usd)}; uses one video generation from the plan allowance). It usually takes 2 to 5 minutes; call adsoptimiser_get_job with this job id to check.`,
          summary
        );
      } catch (err) {
        const message = describeLipSyncError(err);
        if (!message) throw err;
        return fail(message, { status: err.status, code: err.code, message: err.message });
      }
    }
  );

  tool(
    "adsoptimiser_get_job",
    "Get a creative job",
    "Get the status of an image or video job, with the result URL once it is ready (statuses: queued, generating, ready, failed, expired). A finished image (or a video with a stored poster frame) comes with a small preview image so you can see it.",
    schemas.get_job,
    { readOnlyHint: true, openWorldHint: false },
    async ({ job_id, include_thumbnails }) => {
      const job = await getJob(job_id);
      const summary = summarizeJob(job);
      const result = ok(describeJob(summary), summary);
      if (include_thumbnails === false) return result;
      const preview = jobThumbnail(job);
      return attachThumbnails(
        api,
        result,
        preview.target ? [preview.target] : [],
        THUMBNAIL_LIMITS.get_job,
        preview.note ? [preview.note] : []
      );
    }
  );

  tool(
    "adsoptimiser_list_jobs",
    "List recent creative jobs",
    `List recent image and video jobs in the workspace, newest first. Filter by status or asset type. Pass include_thumbnails to see small previews of up to ${THUMBNAIL_LIMITS.list_jobs} finished jobs, e.g. to pick the best results.`,
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
          `- ${j.job_id} ${j.lip_sync ? "lip-sync video" : j.asset_type} ${j.status}${j.media_url ? ` ${j.media_url}` : ""} "${String(j.prompt ?? "").slice(0, 80)}"`
      );
      const total = result.total ?? jobs.length;
      const listed = ok(`${total} job(s) in total; showing ${jobs.length}.\n${lines.join("\n")}`, {
        jobs,
        total,
      });
      if (!args.include_thumbnails) return listed;
      const previews = (result.jobs ?? []).map(jobThumbnail);
      const videosWithout = previews.filter((p) => p.note).length;
      return attachThumbnails(
        api,
        listed,
        previews.flatMap((p) => (p.target ? [p.target] : [])),
        THUMBNAIL_LIMITS.list_jobs,
        videosWithout
          ? [`${videosWithout} video(s) without a poster frame (videos are not previewed otherwise)`]
          : []
      );
    }
  );

  tool(
    "adsoptimiser_list_pipelines",
    "List pipelines",
    "List pipeline templates and the workspace's saved pipelines that adsoptimiser_run_pipeline can start. To design a new pipeline, start with adsoptimiser_get_pipeline_nodes.",
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
        needs_character: t.needs_character === true,
      }));
      const savedList = (graphs.graphs ?? []).map((g) => ({
        graph_id: g.graph_id,
        name: g.name,
        description: g.description,
        updated_at: g.updated_at,
      }));
      const lines = [
        "Templates:",
        ...templateList.map(
          (t) =>
            `- ${t.template_id}: ${t.name}. ${t.description ?? ""}${
              t.needs_character ? " (pass character_id to adsoptimiser_run_pipeline)" : ""
            }`
        ),
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
    `Start a pipeline run from exactly one of: a template_id or saved graph_id (see adsoptimiser_list_pipelines), or an unsaved graph. An inline graph must use only node types from adsoptimiser_get_pipeline_nodes, keep to ${MAX_GRAPH_NODES} nodes, and should pass adsoptimiser_validate_pipeline first; it is validated again here and not run if invalid. Local image paths in input_image nodes are uploaded for you. character_id fills every character step that has none (required by templates marked needs_character). Each generation step uses plan allowance like a single job (video steps also count toward the daily video quota), so confirm with the user before running. Returns the run id, step count and estimated provider cost; check progress with adsoptimiser_get_pipeline_run.`,
    schemas.run_pipeline,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (args) => {
      const sources = [args.template_id, args.graph_id, args.graph].filter((v) => v !== undefined && v !== "");
      if (sources.length !== 1) {
        return fail(
          "Pass exactly one of template_id, graph_id (see adsoptimiser_list_pipelines) or graph (an inline pipeline graph)."
        );
      }
      const start = async () => {
        let body;
        let uploads = [];
        if (args.graph) {
          const resolved = await resolveGraphFiles(args.graph);
          uploads = resolved.uploads;
          const check = await validateGraph(resolved.graph);
          if (!check.valid) {
            return fail(`Not run: ${describeValidation(check)}`, check);
          }
          if (check.needs_run_prompt && !args.prompt) {
            return fail(
              "Not run: this graph needs a prompt, because at least one prompt input has nothing wired into it. Pass prompt, or feed every prompt input from a text or refine_prompt node.",
              check
            );
          }
          body = { graph: resolved.graph };
        } else {
          body = args.graph_id ? { graph_id: args.graph_id } : { template_id: args.template_id };
        }
        if (args.prompt) body.prompt = args.prompt;
        if (args.character_id) body.character_id = args.character_id;
        const result = await api.request("POST", "/api/v1/pipelines", { json: body });
        const run = result.run ?? {};
        const steps = (result.stages ?? []).map((s) => s.stage_type);
        const structured = {
          run_id: run.run_id,
          status: run.status,
          step_count: steps.length,
          steps,
          estimated_cost_usd: result.estimated_cost_usd ?? null,
          app_url: `${appUrl}/#/pipelines`,
          ...(uploads.length ? { uploads } : {}),
        };
        return ok(
          `Pipeline run ${run.run_id} started: ${steps.length} step${steps.length === 1 ? "" : "s"} (${steps.join(" > ")}). Estimated provider cost about ${usd(structured.estimated_cost_usd)}. Each generation step uses one generation from the workspace's plan allowance (video steps also count toward the daily video quota).${describeUploads(uploads)}\nCheck progress with adsoptimiser_get_pipeline_run.`,
          structured
        );
      };
      return builderGuard(start, { builderRoute: Boolean(args.graph) })();
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
  // Pipeline builder (same tools as the hosted connector)
  // -------------------------------------------------------------------------

  tool(
    "adsoptimiser_get_pipeline_nodes",
    "Pipeline node catalogue",
    `Get the pipeline node catalogue: every node type with its inputs (kind, required, max connections), outputs, params (allowed values and ranges) and rules, plus the graph rules (at most ${MAX_GRAPH_NODES} nodes, edge format, how the run prompt feeds unwired prompt inputs) and a worked example graph. Always call this before designing or changing a pipeline graph, and use only the node types, ports and params it lists; never invent node types. Uses no allowance.`,
    schemas.get_pipeline_nodes,
    { readOnlyHint: true, openWorldHint: false },
    builderGuard(async () => {
      const catalogue = await api.request("GET", "/api/v1/pipelines/nodes");
      const maxNodes = Number(catalogue.max_nodes) || MAX_GRAPH_NODES;
      const nodeTypes = (catalogue.nodes ?? []).map(compactNodeType);
      const rules = Array.isArray(catalogue.rules) && catalogue.rules.length ? catalogue.rules : GRAPH_RULES;
      const example = catalogue.example ?? { description: EXAMPLE_DESCRIPTION, graph: EXAMPLE_GRAPH };
      const text = [
        `Pipeline node types (${nodeTypes.length}). Inputs marked * are required; xN is the max connections.`,
        ...nodeTypes.map(describeNodeType),
        "",
        "Graph rules:",
        ...rules.map((r) => `- ${r}`),
        "",
        `Example: ${example.description ?? ""}`,
        JSON.stringify(example.graph ?? example),
        "",
        "Next: build the graph, check it with adsoptimiser_validate_pipeline, then save it with adsoptimiser_save_pipeline or run it with adsoptimiser_run_pipeline.",
      ].join("\n");
      return ok(text, { max_nodes: maxNodes, node_types: nodeTypes, rules, example });
    })
  );

  tool(
    "adsoptimiser_get_pipeline",
    "Get a saved pipeline",
    "Get a saved pipeline's graph (nodes, edges and params), name and estimated cost per run, for example to change it and save it again with adsoptimiser_save_pipeline and its graph_id.",
    schemas.get_pipeline,
    { readOnlyHint: true, openWorldHint: false },
    builderGuard(async ({ graph_id }) => {
      const saved = await api.request("GET", `/api/v1/pipelines/graphs/${encodeURIComponent(graph_id)}`);
      const graph = saved.graph ?? { version: 1, nodes: [], edges: [] };
      const structured = {
        graph_id: saved.graph_id ?? graph_id,
        name: saved.name ?? null,
        description: saved.description ?? null,
        node_count: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
        estimated_cost_usd: saved.estimated_cost_usd ?? null,
        needs_run_prompt: needsRunPrompt(saved, graph),
        updated_at: saved.updated_at ?? null,
        graph,
        editor_url: editorUrl,
      };
      return ok(
        [
          `Saved pipeline ${structured.graph_id}: "${structured.name ?? "unnamed"}", ${structured.node_count} node${structured.node_count === 1 ? "" : "s"}, estimated provider cost about ${usd(structured.estimated_cost_usd)} per run.${structured.needs_run_prompt ? " Running it needs a prompt." : ""}`,
          ...(structured.description ? [`Description: ${structured.description}`] : []),
          `Graph: ${JSON.stringify(graph)}`,
          `Edit it in the app: ${editorUrl}`,
        ].join("\n"),
        structured
      );
    })
  );

  tool(
    "adsoptimiser_validate_pipeline",
    "Validate a pipeline graph",
    `Check a pipeline graph without running or saving it: reports whether it is valid, each problem with the node ids involved, the node count (at most ${MAX_GRAPH_NODES}), the estimated provider cost per run, and whether running it needs a prompt. Uses no allowance. Always validate before adsoptimiser_save_pipeline or adsoptimiser_run_pipeline with a graph; build graphs only from adsoptimiser_get_pipeline_nodes. Local image paths in input_image nodes are uploaded, and the returned graph has them replaced with hosted URLs: pass that graph on to save or run.`,
    schemas.validate_pipeline,
    // Not read-only: local images in the graph are uploaded.
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    builderGuard(async ({ graph: rawGraph }) => {
      const { graph, uploads } = await resolveGraphFiles(rawGraph);
      const check = await validateGraph(graph);
      const structured = { ...check, ...(uploads.length ? { uploads, graph } : {}) };
      return toolText(describeValidation(check) + describeUploads(uploads), {
        structured,
        isError: !check.valid,
      });
    })
  );

  tool(
    "adsoptimiser_save_pipeline",
    "Save a pipeline",
    `Save a pipeline graph to the workspace (or update one when graph_id is given) so it can be run later with adsoptimiser_run_pipeline and edited in the app's pipeline editor. Build it only from node types in adsoptimiser_get_pipeline_nodes, keep to ${MAX_GRAPH_NODES} nodes, and check it with adsoptimiser_validate_pipeline first; an invalid graph is refused with its errors. Local image paths in input_image nodes are uploaded for you. Saving uses no allowance.`,
    schemas.save_pipeline,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    builderGuard(async ({ name, description, graph: rawGraph, graph_id }) => {
      const { graph, uploads } = await resolveGraphFiles(rawGraph);
      const body = { name, graph };
      if (description !== undefined) body.description = description;
      // Updates use the existing PATCH route; new pipelines are POSTed.
      const saved = graph_id
        ? await api.request("PATCH", `/api/v1/pipelines/graphs/${encodeURIComponent(graph_id)}`, { json: body })
        : await api.request("POST", "/api/v1/pipelines/graphs", { json: body });
      const structured = {
        graph_id: saved.graph_id ?? graph_id ?? null,
        name: saved.name ?? name,
        node_count: graph.nodes.length,
        estimated_cost_usd: saved.estimated_cost_usd ?? null,
        editor_url: editorUrl,
        ...(uploads.length ? { uploads } : {}),
      };
      return ok(
        `${graph_id ? "Updated" : "Saved"} pipeline "${structured.name}" as ${structured.graph_id} (${structured.node_count} node${structured.node_count === 1 ? "" : "s"}).${describeUploads(uploads)}\nRun it with adsoptimiser_run_pipeline and graph_id ${structured.graph_id}, or open it in the pipeline editor: ${editorUrl}`,
        structured
      );
    })
  );

  // -------------------------------------------------------------------------
  // Characters and voices (same tools as the hosted connector, plus local
  // image files and saving voice previews)
  // -------------------------------------------------------------------------

  /**
   * Check the image count across image_paths, image_urls and job_ids, then
   * upload local files and put their hosted URLs after image_urls. Returns the
   * args with image_paths resolved, or an error message.
   */
  async function resolveCharacterImages(args, { requireOne }) {
    const paths = args.image_paths ?? [];
    const total = paths.length + (args.image_urls?.length ?? 0) + (args.job_ids?.length ?? 0);
    if (requireOne && total === 0) {
      return {
        error: `Pass at least one of image_paths, image_urls or job_ids (1 to ${MAX_CHARACTER_IMAGES} images in total).`,
      };
    }
    if (total > MAX_CHARACTER_IMAGES) {
      return {
        error: `A character has at most ${MAX_CHARACTER_IMAGES} reference images (image_paths, image_urls and job_ids combined).`,
      };
    }
    const { image_paths: _paths, ...rest } = args;
    if (args.image_paths === undefined) return { args: rest, uploads: [] };
    const uploads = await uploadLocalImages(paths);
    return {
      args: { ...rest, image_urls: [...(args.image_urls ?? []), ...uploads.map((u) => u.url)] },
      uploads,
    };
  }

  const describeImageUploads = (uploads) =>
    uploads.length ? `\nUploaded ${uploads.length} local image${uploads.length === 1 ? "" : "s"}.` : "";

  tool(
    "adsoptimiser_list_characters",
    "List characters",
    "List the workspace's saved characters (consistent AI people such as influencers or brand ambassadors) with their reference images, description, style and default voice. Use a character_id with adsoptimiser_generate_image, adsoptimiser_generate_video or adsoptimiser_run_pipeline to keep the same person across scenes and videos.",
    schemas.list_characters,
    { readOnlyHint: true, openWorldHint: false },
    async () => {
      const result = await api.request("GET", "/api/v1/characters");
      const characters = (result.characters ?? []).map(summarizeCharacter);
      const lines = characters.map(
        (c) =>
          `- ${c.character_id}: ${c.name} (${c.image_count} image(s), voice ${voiceLabel(c)})${
            c.description ? `: ${String(c.description).slice(0, 120)}` : ""
          }`
      );
      return ok(
        characters.length
          ? `${characters.length} character(s):\n${lines.join("\n")}`
          : "No characters yet. Generate a character sheet with adsoptimiser_generate_image, then save the best images with adsoptimiser_create_character.",
        { characters }
      );
    }
  );

  tool(
    "adsoptimiser_get_character",
    "Get a character",
    "Get one saved character with every reference image URL (and the job each came from), its description, style and default voice, plus a summary of everything made with it: counts per kind, the latest items (with any kept speech audio) and the latest voice previews. Use adsoptimiser_list_character_assets for the full gallery, and its download_to to save files locally. Small previews of the reference images are attached so you can see the character.",
    schemas.get_character,
    { readOnlyHint: true, openWorldHint: false },
    async ({ character_id, include_thumbnails }) => {
      const path = `/api/v1/characters/${encodeURIComponent(character_id)}`;
      const character = await api.request("GET", path);
      const summary = summarizeCharacter(character);
      // The hub summary is extra context: the character alone still answers,
      // including on a deployment that predates the Characters hub.
      const [assets, previews] = await Promise.all([
        api.request("GET", `${path}/assets?limit=5`).catch(() => null),
        api.request("GET", `${path}/voice-previews?limit=3`).catch(() => null),
      ]);
      const latestItems = (assets?.items ?? []).map((item) => summarizeAsset(item, jobLink));
      const latestPreviews = (previews?.previews ?? []).map((preview) => ({
        preview_id: preview.preview_id,
        voice: preview.voice ?? null,
        text: preview.text ?? null,
        media_url: preview.media_url ?? null,
        created_at: preview.created_at ?? null,
      }));
      // Only in this package: every audio URL in one list, so Claude can offer
      // to save them: speech with list_character_assets download_to, previews
      // with preview_voice save_to (a repeat is served from cache).
      const audio = [
        ...latestItems
          .filter((item) => item.speech_url)
          .map((item) => ({
            source: "speech",
            job_id: item.job_id,
            kind: item.kind,
            url: item.speech_url,
            text: item.script,
          })),
        ...latestPreviews
          .filter((p) => p.media_url)
          .map((p) => ({ source: "voice_preview", preview_id: p.preview_id, voice: p.voice, url: p.media_url, text: p.text })),
      ];
      const structured = {
        ...summary,
        counts: assets?.counts ?? null,
        latest_items: latestItems,
        latest_voice_previews: latestPreviews,
        audio,
      };
      const lines = [describeCharacter(summary)];
      if (assets) {
        lines.push(`Made with this character: ${describeCounts(assets.counts)}.`);
        if (latestItems.length) lines.push("Latest:", ...latestItems.map(describeAsset));
      }
      if (latestPreviews.length) {
        lines.push(
          "Latest voice previews:",
          ...latestPreviews.map((p) => `- ${p.media_url} "${String(p.text ?? "").slice(0, 80)}"`)
        );
      }
      if (audio.length) {
        lines.push(
          "To save audio locally: kept speech with adsoptimiser_list_character_assets and download_to; a voice preview with adsoptimiser_preview_voice, the same voice and text, and save_to (repeats are served from cache and use no allowance)."
        );
      }
      const result = ok(lines.join("\n"), structured);
      if (include_thumbnails === false) return result;
      const { targets, notes } = characterThumbnails(baseUrl, summary.images);
      return attachThumbnails(api, result, targets, THUMBNAIL_LIMITS.get_character, notes);
    }
  );

  // -------------------------------------------------------------------------
  // View image
  // -------------------------------------------------------------------------

  /** The clearest message for a view_image failure, as a tool error. */
  function viewImageFailure(err, what) {
    if (!(err instanceof ApiError)) return toToolError(err, config);
    const structured = { status: err.status, code: err.code, message: err.message };
    const reason = typeof err.body?.reason === "string" ? err.body.reason : null;
    if (reason) structured.reason = reason;
    const say = (message) => fail(message, structured);
    if (viewImageUnsupported(err)) {
      return say(`Can't view ${what}: ${VIEW_IMAGE_UNSUPPORTED}.`);
    }
    if (err.status === 404) {
      return say(`Can't view ${what}: not found in this workspace (${err.message}).`);
    }
    if (err.status === 409 && err.code === "job_not_ready") {
      return say(
        `Can't view ${what}: the job is not finished yet. Check it with adsoptimiser_get_job and try again once it is ready.`
      );
    }
    if (err.status === 415 || err.code === "not_an_image") {
      return say(`Can't view ${what}: it is not an image (${err.message}).`);
    }
    if (err.status === 400 && err.code === "invalid_crop") {
      return say(`Can't view ${what}: the crop was refused (${err.message}). ${VIEW_IMAGE_CROP_HINT}.`);
    }
    if (err.code === "thumbnail_unavailable" || err.status === 422) {
      if (reason === "video_without_poster") {
        return say(`Can't view ${what}: it is a video with no poster frame. Open its media URL to watch it.`);
      }
      if (reason === "transform_not_configured") {
        return say(
          `Can't view ${what}: this Ads Optimiser deployment can't resize images right now (image transformations are not configured).`
        );
      }
      if (reason === "transform_failed") {
        return say(`Can't view ${what}: the image could not be resized. Try another size or crop, or try again shortly.`);
      }
      return say(`Can't view ${what}: the image is unavailable right now (${err.message}).`);
    }
    return toToolError(err, config);
  }

  tool(
    "adsoptimiser_view_image",
    "View an image",
    `See one image at a larger size (${VIEW_IMAGE_SIZES.join(", ")} px; default ${VIEW_IMAGE_DEFAULT_SIZE}) to check detail: colours, small features, text, or the views on a character sheet. Previews in other tools are small (${THUMBNAIL_SIZE}px). Pass exactly one of job_id, key, or character_id with image_index. Use crop to zoom into a region: fractions of the original image, e.g. { x: 0.3, y: 0.5, width: 0.4, height: 0.3 }. For characters, prefer separate images per view: each shows far more detail than one sheet holding many views. Only in this package: save_to also saves the returned image to a local folder. Uses no allowance.`,
    schemas.view_image,
    // Not read-only: save_to writes a local file. The API side only reads.
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ job_id, key, character_id, image_index, size, crop, save_to }) => {
      const given = [job_id, key, character_id].filter((v) => v !== undefined).length;
      if (given !== 1) {
        return fail("Pass exactly one of job_id, key, or character_id (with image_index).");
      }
      if (character_id !== undefined && image_index === undefined) {
        return fail(`character_id needs image_index (1 to ${MAX_CHARACTER_IMAGES}): which reference image to view.`);
      }
      if (image_index !== undefined && character_id === undefined) {
        return fail("image_index only applies with character_id.");
      }
      if (crop !== undefined) {
        const problem = cropError(crop);
        if (problem) return fail(`Invalid crop: ${problem} ${VIEW_IMAGE_CROP_HINT}.`);
      }
      // Refuse a bad folder before anything is fetched.
      const folder = save_to !== undefined ? resolveOutputFolder(save_to, config.output) : null;

      let source;
      let what;
      let fileStem;
      if (job_id !== undefined) {
        source = { type: "job", job_id };
        what = `job ${job_id}`;
        fileStem = `view-${job_id}`;
      } else if (key !== undefined) {
        source = { type: "key", key };
        what = `key ${key}`;
        const base = key.split("/").pop() || "image";
        fileStem = `view-${base.replace(/\.[A-Za-z0-9]+$/, "")}`;
      } else {
        const character = await api.request("GET", `/api/v1/characters/${encodeURIComponent(character_id)}`);
        const summary = summarizeCharacter(character);
        const target = characterImageTarget(baseUrl, summary.images, image_index);
        const name = summary.name ? `${summary.name} (${character_id})` : character_id;
        what = `reference image ${image_index} of character ${name}`;
        if (target.missing) {
          return fail(
            `Character ${name} has ${summary.images.length} reference image(s); image_index must be 1 to ${summary.images.length}.`
          );
        }
        if (target.external !== undefined) {
          return fail(
            `Can't view ${what}: it is an external URL (${target.external}), not stored in Ads Optimiser, so it is not fetched. Open the URL to see it.`
          );
        }
        source = {
          type: "character",
          character_id,
          image_index,
          ...(target.key ? { key: target.key } : { job_id: target.job_id }),
        };
        fileStem = `view-${character_id}-${image_index}`;
      }

      const requested = size ?? VIEW_IMAGE_DEFAULT_SIZE;
      const fetchAt = (px) => {
        const params = new URLSearchParams();
        if (source.key) params.set("key", source.key);
        else params.set("job_id", source.job_id);
        params.set("size", String(px));
        if (crop) params.set("crop", cropParam(crop));
        return api.requestBinary(`/api/v1/media/thumbnail?${params}`, { timeoutMs: 60_000 });
      };
      const isImage = (r) => VIEW_IMAGE_MIME_TYPES.has(r.contentType) && r.bytes.length > 0;
      const limit = VIEW_IMAGE_MAX_IMAGE_BYTES.toLocaleString("en-AU");

      let fetchedSize = requested;
      let res;
      try {
        res = await fetchAt(fetchedSize);
      } catch (err) {
        return viewImageFailure(err, what);
      }
      if (!isImage(res)) {
        return fail(`Can't view ${what}: the answer was not an image (${res.contentType || "no content type"}).`);
      }
      const notes = [];
      let data = res.bytes.toString("base64");
      const smaller = nextSmallerSize(fetchedSize);
      if (data.length > VIEW_IMAGE_MAX_IMAGE_BYTES && smaller) {
        let retry;
        try {
          retry = await fetchAt(smaller);
        } catch (err) {
          return viewImageFailure(err, what);
        }
        if (isImage(retry)) {
          notes.push(`At ${fetchedSize}px the image was over the ${limit}-byte limit, so it was fetched again at ${smaller}px.`);
          res = retry;
          fetchedSize = smaller;
          data = retry.bytes.toString("base64");
        }
      }
      const attach = data.length <= VIEW_IMAGE_MAX_IMAGE_BYTES;
      if (!attach) {
        notes.push(
          `The image is still over ${limit} bytes (base64) at ${fetchedSize}px, so it is not attached. Use crop to view part of it.`
        );
      }

      const width = headerInt(res.headers, "x-image-width");
      const height = headerInt(res.headers, "x-image-height");
      const originalWidth = headerInt(res.headers, "x-original-width");
      const originalHeight = headerInt(res.headers, "x-original-height");
      const structured = {
        source,
        width,
        height,
        original_width: originalWidth,
        original_height: originalHeight,
        crop: crop ?? null,
        size: fetchedSize,
        mime_type: res.contentType,
      };
      if (fetchedSize !== requested) structured.requested_size = requested;
      if (!attach) structured.attached = false;

      const dims = (w, h) => (w && h ? `${w} x ${h}` : "size unknown");
      const lines = [
        `Viewing ${what}.`,
        `Returned ${dims(width, height)} (size ${fetchedSize}); original ${dims(originalWidth, originalHeight)}.`,
      ];
      if (crop) {
        lines.push(`Crop: x ${crop.x}, y ${crop.y}, width ${crop.width}, height ${crop.height} of the original.`);
      }
      lines.push(...notes);
      if (folder) {
        const ext = extensionFor({ contentType: res.contentType, assetType: "image" });
        const label = `${width && height ? `${width}x${height}` : `${fetchedSize}px`}${crop ? " crop" : ""}`;
        const saved = await saveStream(new Blob([res.bytes]).stream(), folder, downloadFileName(fileStem, label, ext));
        structured.path = saved.path;
        structured.bytes = saved.bytes;
        lines.push(
          `Saved ${saved.path}${saved.renamed ? " (a file with that name already existed, so a numbered name was used)" : ""}.`
        );
      }
      lines.push(`${VIEW_IMAGE_CROP_HINT}.`);
      const result = ok(lines.join("\n"), structured);
      if (attach) result.content.push({ type: "image", data, mimeType: res.contentType });
      return result;
    }
  );

  /**
   * Save the listed finished assets (media, then kept speech) into `folder`,
   * at most MAX_CHARACTER_DOWNLOADS files. Only this deployment's /media URLs
   * are fetched, and never with the token. One failure does not stop the rest.
   */
  async function downloadCharacterAssets(items, folder) {
    const files = [];
    for (const item of items) {
      if (item.media_url) files.push({ item, url: item.media_url, speech: false });
      if (item.speech_url) files.push({ item, url: item.speech_url, speech: true });
    }
    const saved = [];
    const skipped = [];
    const failed = [];
    const notAttempted = [];
    for (const file of files) {
      const which = file.speech ? "speech" : "media";
      if (saved.length + failed.length >= MAX_CHARACTER_DOWNLOADS) {
        notAttempted.push({ job_id: file.item.job_id, file: which });
        continue;
      }
      const url = ownMediaUrl(file.url);
      if (!url) {
        skipped.push({ job_id: file.item.job_id, file: which, url: file.url, reason: "not this deployment's media" });
        continue;
      }
      const key = decodeURIComponent(new URL(url).pathname.slice("/media/".length));
      try {
        const { saved: result } = await downloadMedia(
          url,
          folder,
          (contentType) =>
            file.speech
              ? downloadFileName(`${file.item.job_id}-speech`, file.item.script, ".mp3")
              : downloadFileName(
                  file.item.job_id,
                  file.item.script ?? file.item.prompt,
                  extensionFor({ storageUri: key, contentType, assetType: file.item.asset_type })
                ),
          { what: `The ${which} for job ${file.item.job_id}` }
        );
        saved.push({
          job_id: file.item.job_id,
          kind: file.item.kind ?? null,
          file: which,
          path: result.path,
          bytes: result.bytes,
          renamed: result.renamed,
        });
      } catch (err) {
        failed.push({ job_id: file.item.job_id, file: which, reason: describeError(err, config) });
      }
    }
    return { saved, skipped, failed, not_attempted: notAttempted };
  }

  tool(
    "adsoptimiser_list_character_assets",
    "List a character's assets",
    `List everything made with a saved character, newest first: images, videos, talking clips, lip-syncs, voiceovers and captioned clips, with result URLs, the kept speech audio (speech_url) and the line spoken (script) where there is one. Filter by type and page with cursor. Pass include_thumbnails to see small previews of up to ${THUMBNAIL_LIMITS.list_character_assets} finished images on the page. Only in this package: with download_to, the listed finished files (media and speech mp3s) are also saved to that local folder, at most ${MAX_CHARACTER_DOWNLOADS} per call, and existing files are never replaced.`,
    schemas.list_character_assets,
    // Not read-only: download_to writes local files.
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ character_id, type, cursor, limit, download_to, include_thumbnails }) => {
      // Refuse a bad folder before calling the API.
      const folder = download_to !== undefined ? resolveOutputFolder(download_to, config.output) : null;
      const path = `/api/v1/characters/${encodeURIComponent(character_id)}`;
      const params = new URLSearchParams({ limit: String(limit ?? 10) });
      if (type) params.set("type", type);
      if (cursor) params.set("cursor", cursor);
      let page;
      try {
        page = await api.request("GET", `${path}/assets?${params}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403 && err.code === "token_scope_denied") {
          return fail(
            "This Ads Optimiser deployment does not list character assets for API tokens yet. adsoptimiser_get_character still works, and the Characters page in the app shows the gallery."
          );
        }
        if (err instanceof ApiError && err.status === 404) {
          // A 404 is an unknown character, or a deployment without the hub.
          const exists = await api.request("GET", path).then(
            () => true,
            () => false
          );
          if (exists) {
            return fail(
              "This Ads Optimiser deployment predates the Characters hub, so it cannot list a character's assets. adsoptimiser_get_character still works, and adsoptimiser_list_jobs lists recent jobs."
            );
          }
        }
        throw err;
      }
      const items = (page.items ?? []).map((item) => ({
        ...summarizeAsset(item, jobLink),
        prompt: item.prompt ?? null,
      }));
      const lines = [
        `Character ${character_id}: ${describeCounts(page.counts)}.`,
        items.length
          ? `Showing ${items.length}${type ? ` ${type}` : ""} item(s):`
          : `No ${type ? `${type} ` : ""}items${cursor ? " on this page" : ""}.`,
        ...items.map(describeAsset),
        ...(page.next_cursor ? [`More: call again with cursor ${page.next_cursor}`] : []),
      ];
      const structured = {
        character_id,
        items,
        counts: page.counts ?? null,
        next_cursor: page.next_cursor ?? null,
      };
      if (folder) {
        const result = await downloadCharacterAssets(items, folder);
        structured.downloads = result;
        lines.push(
          result.saved.length
            ? `Saved ${result.saved.length} file(s) in ${folder}:`
            : `Nothing saved in ${folder}.${result.skipped.length || result.failed.length ? "" : " No finished media or speech on this page."}`
        );
        for (const s of result.saved) {
          lines.push(`- ${s.path}${s.renamed ? " (a file with that name already existed, so a numbered name was used)" : ""}`);
        }
        for (const s of result.skipped) lines.push(`- not saved: ${s.job_id} ${s.file} (${s.reason})`);
        for (const f of result.failed) lines.push(`- failed: ${f.job_id} ${f.file}: ${f.reason}`);
        if (result.not_attempted.length) {
          const jobs = [...new Set(result.not_attempted.map((n) => n.job_id))];
          lines.push(
            `${result.not_attempted.length} more file(s) not saved (at most ${MAX_CHARACTER_DOWNLOADS} per call): ${jobs.join(", ")}. To save every file, list smaller pages (limit ${Math.floor(MAX_CHARACTER_DOWNLOADS / 2)} always fits) and follow next_cursor.`
          );
        }
      }
      const listed = ok(lines.join("\n"), structured);
      if (!include_thumbnails) return listed;
      const imageItems = (page.items ?? []).filter(
        (item) => item.asset_type === "image" && item.status === "ready"
      );
      const others = (page.items ?? []).length - imageItems.length;
      return attachThumbnails(
        api,
        listed,
        imageItems.map((item) => ({ label: `job ${item.job_id}`, job_id: item.job_id })),
        THUMBNAIL_LIMITS.list_character_assets,
        others ? [`${others} video or unfinished item(s) (only finished images are previewed)`] : []
      );
    }
  );

  tool(
    "adsoptimiser_create_character",
    "Create a character",
    `Save a consistent character from 1 to ${MAX_CHARACTER_IMAGES} reference images: job_ids of finished image jobs (usually the best shots of a character sheet: front, three-quarter and side angles, a full-body shot and a close-up on a neutral white background with realistic skin), https image_urls, and/or image_paths (local files, checked and uploaded for you). Add a description (age, face, hair, build, persona) and optionally style notes and a voice (adsoptimiser_list_voices; audition it with adsoptimiser_preview_voice). Then pass the character_id to adsoptimiser_generate_image for new scenes and to adsoptimiser_generate_video for talking clips. Uses no generation allowance. Needs member (not viewer) role. Characters cannot be deleted from here; delete them in the app.`,
    schemas.create_character,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async (args) => {
      const resolved = await resolveCharacterImages(args, { requireOne: true });
      if (resolved.error) return fail(resolved.error);
      const character = await api.request("POST", "/api/v1/characters", { json: characterBody(resolved.args) });
      const summary = summarizeCharacter(character);
      return ok(
        `Created ${describeCharacter(summary)}${describeImageUploads(resolved.uploads)}\nUse character_id ${summary.character_id} with adsoptimiser_generate_image, adsoptimiser_generate_video or adsoptimiser_run_pipeline.`,
        summary
      );
    }
  );

  tool(
    "adsoptimiser_update_character",
    "Update a character",
    `Change a saved character's name, description, style, voice or reference images. Passing image_paths, image_urls and/or job_ids replaces the whole image list (1 to ${MAX_CHARACTER_IMAGES} images; adsoptimiser_get_character shows the current URLs, so include the ones to keep). For iterations like 'make him older', generate new images with the character as reference, then save the best ones here. Uses no generation allowance. Characters cannot be deleted from here; delete them in the app.`,
    schemas.update_character,
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ character_id, ...rest }) => {
      if (Object.keys(characterBody(rest)).length === 0 && rest.image_paths === undefined) {
        return fail("Nothing to update: pass at least one field to change.");
      }
      const resolved = await resolveCharacterImages(rest, { requireOne: false });
      if (resolved.error) return fail(resolved.error);
      const character = await api.request("PATCH", `/api/v1/characters/${encodeURIComponent(character_id)}`, {
        json: characterBody(resolved.args),
      });
      const summary = summarizeCharacter(character);
      return ok(`Updated ${describeCharacter(summary)}${describeImageUploads(resolved.uploads)}`, summary);
    }
  );

  tool(
    "adsoptimiser_list_voices",
    "List voices",
    "List the voices: xAI presets (talking videos, voiceovers, a character's default_voice_id) and OpenAI gpt-4o-mini-tts voices (voiceovers and previews, steered with instructions such as accent, pacing and tone), plus whether OpenAI voices are configured. Read-only.",
    schemas.list_voices,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async () => {
      const catalog = await api.request("GET", "/api/v1/voices");
      const xai = catalog.providers?.xai?.voice_ids ?? [];
      const openAi = catalog.providers?.openai;
      const openAiVoices = openAi?.voices ?? [];
      const configured = openAi?.configured === true;
      const lines = [
        `xAI preset voices: ${xai.join(", ") || "none"} (talking videos and voiceovers; default eve).`,
        `OpenAI voices (${openAi?.model ?? "gpt-4o-mini-tts"}): ${openAiVoices.join(", ") || "none"} (voiceovers and previews; add instructions for accent, emotion, pacing and tone).`,
        configured
          ? "OpenAI voices are available."
          : `OpenAI voices are not available: ${openAi?.message ?? "not configured on this deployment."}`,
        ...(catalog.rules ?? []).map((rule) => `- ${rule}`),
        "Hear one with adsoptimiser_preview_voice (save_to also saves the mp3 locally) before saving it to a character.",
      ];
      return ok(lines.join("\n"), {
        voice_ids: xai,
        xai_voice_ids: xai,
        openai_voices: openAiVoices,
        openai_configured: configured,
        voices: catalog.voices ?? [],
        preview: catalog.preview ?? null,
        rules: catalog.rules ?? [],
      });
    }
  );

  /**
   * Where to fetch a preview from: only ever this deployment's /media route,
   * built from storage_uri like job media, or media_url when it points there.
   */
  function previewDownloadUrl(preview) {
    if (typeof preview.storage_uri === "string" && preview.storage_uri) return mediaUrl(preview.storage_uri);
    return ownMediaUrl(preview.media_url);
  }

  tool(
    "adsoptimiser_preview_voice",
    "Preview a voice",
    "Synthesise a short sample (at most 300 characters) in a voice profile and return a playable audio URL, e.g. to audition an OpenAI voice with instructions before saving it to a character. Pass character_id to file it in that character's voice preview history (shown on its Characters page). With save_to, the mp3 is also saved to that local folder so the user can play it. Creates no job and uses no plan allowance; limited to 10 previews a minute, and repeats of the same voice and text are served from cache.",
    schemas.preview_voice,
    // Not read-only: save_to writes a local file.
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ voice, text, character_id, save_to }) => {
      // Refuse a bad folder before anything is synthesised.
      const folder = save_to !== undefined ? resolveOutputFolder(save_to, config.output) : null;
      const preview = await api.request("POST", "/api/v1/voices/preview", {
        json: { voice, ...(text ? { text } : {}), ...(character_id ? { character_id } : {}) },
      });
      const label = voice.provider === "openai" ? `OpenAI ${voice.voice}` : `xAI ${voice.voice_id}`;
      const structured = {
        media_url: preview.media_url,
        content_type: preview.content_type ?? "audio/mpeg",
        text: preview.text ?? null,
        cached: preview.cached === true,
        voice: preview.voice ?? voice,
        preview_id: preview.preview_id ?? null,
        character_id: preview.character_id ?? character_id ?? null,
      };
      const lines = [`Preview of ${label}: ${preview.media_url}`, `Said: "${preview.text ?? ""}"`];
      if (folder) {
        const url = previewDownloadUrl(preview);
        if (!url) {
          lines.push("Not saved locally: the preview did not come from this Ads Optimiser deployment's media.");
        } else {
          const name = voice.provider === "openai" ? voice.voice : voice.voice_id;
          const { saved } = await downloadMedia(
            url,
            folder,
            downloadFileName(`voice-preview-${voice.provider}-${name}`, preview.text ?? text, ".mp3"),
            { what: "The voice preview" }
          );
          structured.path = saved.path;
          structured.bytes = saved.bytes;
          lines.push(
            `Saved ${saved.path}${saved.renamed ? " (a file with that name already existed, so a numbered name was used)" : ""}.`
          );
        }
      }
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
      const { saved } = await downloadMedia(
        mediaUrl(job.storage_uri),
        target,
        (contentType) =>
          downloadFileName(
            job.job_id ?? job_id,
            job.prompt,
            extensionFor({ storageUri: job.storage_uri, contentType, assetType: job.asset_type })
          ),
        { overwrite: overwrite === true, what: `The media for job ${job_id}` }
      );
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
