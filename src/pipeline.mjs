// Pipeline builder support: the compact node catalogue, graph rules and a
// worked example for Claude, validator error shaping, and substituting local
// files into input_image nodes.
//
// The graph format mirrors the worker's services/pipeline-graph.ts:
//   { version: 1,
//     nodes: [{ id, type, params? }],
//     edges: [{ from: { node, output }, to: { node, input } }] }
// The API is the authority on validity; nothing here second-guesses it except
// graphNeedsRunPrompt, used only when the API does not say.

export const MAX_GRAPH_NODES = 12;

/**
 * Parameter ranges and meanings per node type, mirroring the worker's
 * NODE_CATALOG params. Current deployments publish these themselves in
 * GET /pipelines/nodes (an array per node, which wins); older ones publish
 * only the enums, and then these fill in the ranges and free-text params.
 */
const DURATION = { type: "integer", min: 1, max: 15, description: "Seconds, 1 to 15." };
const SCRIPT = {
  type: "string",
  max_length: 5000,
  description: "The exact line to be spoken.",
};
/** The add_voiceover voice profile, as the API's catalogue describes it. */
const XAI_PRESET_VOICES = ["eve", "leo", "rex", "ara", "gork", "aurora"];
export const OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
];
/** The only lip-sync model enabled on the API. */
export const LIP_SYNC_MODELS = ["kling-lipsync", "sync-lipsync-2-pro"];

/** Timed overlays (POST /api/v1/jobs/overlays and the add_captions node's cues). */
export const MAX_OVERLAY_CUES = 50;
export const MAX_CUE_TEXT_CHARS = 200;
export const OVERLAY_POSITIONS = ["top", "center", "bottom"];
export const OVERLAY_STYLES = ["caption", "card"];
/** Text sizes (default medium for a caption, large for a card). */
export const OVERLAY_SIZES = ["small", "medium", "large"];
/** y: the vertical centre of the text as a fraction of frame height (0 is the top). */
export const OVERLAY_Y_MIN = 0.05;
export const OVERLAY_Y_MAX = 0.95;
/** max_width: the text block's width as a fraction of frame width. */
export const OVERLAY_MAX_WIDTH_MIN = 0.4;
export const OVERLAY_MAX_WIDTH_MAX = 1.0;
/** A cue's text may hold explicit line breaks, at most this many lines. */
export const MAX_CUE_LINES = 3;
/** add_captions timing: even (spread across the clip) or speech (transcribed). */
export const CAPTION_TIMINGS = ["even", "speech"];
const CUE_FIELDS = {
  text: { type: "string" },
  start: { type: "number" },
  end: { type: "number" },
  position: { enum: OVERLAY_POSITIONS, optional: true },
  style: { enum: OVERLAY_STYLES, optional: true },
  y: { type: "number", min: OVERLAY_Y_MIN, max: OVERLAY_Y_MAX, optional: true },
  size: { enum: OVERLAY_SIZES, optional: true },
  max_width: { type: "number", min: OVERLAY_MAX_WIDTH_MIN, max: OVERLAY_MAX_WIDTH_MAX, optional: true },
};

const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

/** A cue's text with Windows line endings made plain \n and each line trimmed. */
export function normaliseCueText(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** A problem with y (or captions_y), or null. */
function yProblem(at, value) {
  if (value === undefined) return null;
  if (!isNumber(value) || value < OVERLAY_Y_MIN || value > OVERLAY_Y_MAX) {
    return `${at} must be a number from ${OVERLAY_Y_MIN} to ${OVERLAY_Y_MAX} (the vertical centre as a fraction of frame height, 0 is the top), not ${JSON.stringify(value)}.`;
  }
  return null;
}

/** A problem with size (or captions_size), or null. */
function sizeProblem(at, value) {
  if (value === undefined || OVERLAY_SIZES.includes(value)) return null;
  return `${at} must be ${OVERLAY_SIZES.join(", ")}, not ${JSON.stringify(value)}.`;
}

/**
 * Every problem the API would report for a list of timed cues (the overlays
 * route's cues and the add_captions node's cues param). `prefix` names the
 * list in messages, for example `cues` or `node "cap" cues`.
 * @returns {string[]}
 */
export function cueListProblems(cueList, prefix = "cues") {
  const problems = [];
  if (cueList.length > MAX_OVERLAY_CUES) {
    problems.push(`At most ${MAX_OVERLAY_CUES} cues in one request (got ${cueList.length}).`);
  }
  cueList.forEach((cue, i) => {
    const at = `${prefix}[${i}]`;
    if (!cue || typeof cue !== "object" || Array.isArray(cue)) {
      problems.push(`${at} must be an object { text, start, end, position?, style?, y?, size?, max_width? }.`);
      return;
    }
    const text = typeof cue.text === "string" ? normaliseCueText(cue.text) : null;
    if (text === null) problems.push(`${at}.text is missing: give the words to show.`);
    else if (!text) problems.push(`${at}.text is empty.`);
    else {
      if (text.length > MAX_CUE_TEXT_CHARS) {
        problems.push(`${at}.text is ${text.length} characters; at most ${MAX_CUE_TEXT_CHARS}.`);
      }
      const lines = text.split("\n").length;
      if (lines > MAX_CUE_LINES) {
        problems.push(`${at}.text has ${lines} lines; at most ${MAX_CUE_LINES} (split it into more cues).`);
      }
    }
    const startOk = isNumber(cue.start);
    const endOk = isNumber(cue.end);
    if (!startOk) problems.push(`${at}.start must be a number of seconds.`);
    else if (cue.start < 0) problems.push(`${at}.start is ${cue.start}; it must be 0 or more.`);
    if (!endOk) problems.push(`${at}.end must be a number of seconds.`);
    if (startOk && endOk && cue.end <= cue.start) {
      problems.push(`${at}.end (${cue.end}) must be after start (${cue.start}).`);
    }
    if (cue.position !== undefined && !OVERLAY_POSITIONS.includes(cue.position)) {
      problems.push(`${at}.position must be ${OVERLAY_POSITIONS.join(", ")}, not ${JSON.stringify(cue.position)}.`);
    }
    if (cue.style !== undefined && !OVERLAY_STYLES.includes(cue.style)) {
      problems.push(`${at}.style must be ${OVERLAY_STYLES.join(" or ")}, not ${JSON.stringify(cue.style)}.`);
    }
    const y = yProblem(`${at}.y`, cue.y);
    if (y) problems.push(y);
    const size = sizeProblem(`${at}.size`, cue.size);
    if (size) problems.push(size);
    if (
      cue.max_width !== undefined &&
      (!isNumber(cue.max_width) || cue.max_width < OVERLAY_MAX_WIDTH_MIN || cue.max_width > OVERLAY_MAX_WIDTH_MAX)
    ) {
      problems.push(
        `${at}.max_width must be a number from ${OVERLAY_MAX_WIDTH_MIN} to ${OVERLAY_MAX_WIDTH_MAX} (a fraction of frame width), not ${JSON.stringify(cue.max_width)}.`
      );
    }
  });
  return problems;
}

/** Problems with the auto captions' placement: captions_y and captions_size. */
export function captionPlacementProblems(args = {}) {
  return [yProblem("captions_y", args.captions_y), sizeProblem("captions_size", args.captions_size)].filter(Boolean);
}

/** A cue as the API takes it: normalised text and only the fields given. */
export function cueForApi(cue) {
  const out = { text: normaliseCueText(cue.text), start: cue.start, end: cue.end };
  for (const key of ["position", "style", "y", "size", "max_width"]) {
    if (cue[key] !== undefined) out[key] = cue[key];
  }
  return out;
}

/**
 * The new placement features a request uses: y, size, max_width and
 * line_breaks from its cues, captions_y and captions_size from `args`.
 * @returns {Set<string>}
 */
export function placementFeaturesUsed(cues, args = {}) {
  const used = new Set();
  for (const cue of Array.isArray(cues) ? cues : []) {
    if (!cue || typeof cue !== "object") continue;
    for (const key of ["y", "size", "max_width"]) if (cue[key] !== undefined) used.add(key);
    if (typeof cue.text === "string" && /[\r\n]/.test(cue.text.trim())) used.add("line_breaks");
  }
  for (const key of ["captions_y", "captions_size"]) if (args[key] !== undefined) used.add(key);
  return used;
}

const REFUSAL_WORDS =
  /unknown|unrecogni[sz]ed|unexpected|not allowed|not supported|unsupported|additional propert|not permitted|invalid (?:key|field)/i;
const LINE_BREAK_WORDS = /line break|newline|new line|control char/i;

/**
 * Which new overlay features an older API refused, judged from its error text
 * and the features the request used (see placementFeaturesUsed). Returns a
 * phrase such as "cue placement (y, size and max_width)", or null when the
 * refusal is about something else.
 */
export function refusedPlacementFeature(text, used) {
  const source = String(text ?? "");
  const named = (field) => new RegExp(`(^|[^a-z_])${field}([^a-z_]|$)`, "i").test(source);
  const refused = REFUSAL_WORDS.test(source);
  const parts = [];
  if (refused && ["y", "size", "max_width"].some((f) => used.has(f) && named(f))) {
    parts.push("cue placement (y, size and max_width)");
  }
  if (refused && ["captions_y", "captions_size"].some((f) => used.has(f) && named(f))) {
    parts.push("caption placement (captions_y and captions_size)");
  }
  if (used.has("line_breaks") && LINE_BREAK_WORDS.test(source)) parts.push("line breaks in cues");
  return parts.length ? parts.join(" or ") : null;
}
const VOICE_PARAM = {
  type: "object",
  one_of: [
    { provider: { const: "xai" }, voice_id: { enum: XAI_PRESET_VOICES } },
    {
      provider: { const: "openai" },
      voice: { enum: OPENAI_VOICES },
      instructions: {
        type: "string",
        maxLength: 1000,
        optional: true,
        description: "Accent, emotion, intonation, pacing, tone (gpt-4o-mini-tts).",
      },
    },
    {
      provider: { const: "elevenlabs" },
      voice_id: { type: "string", description: "A cloned voice listed for this workspace by adsoptimiser_list_voices." },
    },
  ],
  description:
    "Narrator voice profile (see adsoptimiser_list_voices). Wins over voice_id and over the character's voice. Omit both to use the voice of the character the video was made from, else eve. OpenAI voices need the deployment's OpenAI key and a script of at most 4096 characters.",
};

export const PARAM_SPECS = {
  refine_prompt: {
    instruction: {
      type: "string",
      description: "Optional system prompt for the rewrite. Omit to use the default ad-prompt rewrite.",
    },
  },
  generate_image: {
    model: {
      type: "string",
      description:
        "Defaults to grok-imagine-image-2.0. gpt-image-2.5-sunburst (precise) and gpt-image-2.5-flare (fast) where the deployment offers them.",
    },
    aspect_ratio: { type: "string", description: "9:16 is TikTok vertical." },
    quality: {
      type: "string",
      description:
        "grok-imagine-image-2.0: low (default), medium or auto; low is fastest. OpenAI models: low, medium (default), high or auto.",
    },
  },
  generate_video: {
    model: { type: "string" },
    resolution: { type: "string", description: "1080p needs grok-imagine-video-1.5 and bills about 3x 720p." },
    aspect_ratio: { type: "string" },
    duration: DURATION,
  },
  image_to_video: {
    model: { type: "string" },
    resolution: { type: "string", description: "1080p needs grok-imagine-video-1.5." },
    aspect_ratio: { type: "string" },
    duration: DURATION,
  },
  extend_video: {
    model: { type: "string", description: "Only grok-imagine-video can extend." },
    extend_duration: {
      type: "integer",
      min: 1,
      max: 10,
      description: "Seconds added, 1 to 10.",
    },
  },
  add_voiceover: {
    script: {
      ...SCRIPT,
      required: true,
      description: "The exact words spoken over the video. OpenAI voices take at most 4096 characters.",
    },
    voice: VOICE_PARAM,
    voice_id: {
      type: "string",
      description:
        "xAI preset narrator voice (shorthand for voice: { provider: xai }). Omitted: the character's voice, else eve.",
    },
    audio_mode: { type: "string", description: "replace swaps the original audio; mix ducks it under the narration." },
    music_volume: {
      type: "number",
      min: 0,
      max: 1,
      description: "mix only: how loud the original audio stays, 0 to 1.",
    },
  },
  text: {
    text: {
      type: "string",
      required: true,
      max_length: 5000,
      description: "Published verbatim as this node's text output.",
    },
  },
  strip_audio: {},
  input_image: {
    image_url: {
      type: "string",
      required: true,
      description:
        "An https URL of an existing image (for example a media_url from an earlier job or adsoptimiser_upload_file).",
    },
  },
  voiced_video: {
    model: { type: "string" },
    resolution: { type: "string", description: "Capped at 720p." },
    aspect_ratio: { type: "string" },
    voice_id: { type: "string" },
    script: {
      ...SCRIPT,
      description: "The exact line the presenter speaks; tagged <AUDIO_0> for you. With a script, the run prompt is optional.",
    },
    duration: DURATION,
  },
  character: {
    character_id: {
      type: "string",
      required: true,
      description:
        "A saved character id (adsoptimiser_list_characters). Template runs may leave it empty and pass character_id to adsoptimiser_run_pipeline.",
    },
  },
  lip_sync: {
    script: {
      type: "string",
      max_length: 900,
      description:
        "The exact words the person says. Omit to use a wired text node or the run prompt. At most 60 seconds of speech, and it must fit the clip (about 15 characters a second).",
    },
    voice: {
      ...VOICE_PARAM,
      description:
        "Voice profile the line is spoken in (see adsoptimiser_list_voices). Wins over voice_id and over the character's voice. Omit both to use the voice of the character the video was made from, else eve. OpenAI voices need the deployment's OpenAI key.",
    },
    voice_id: {
      type: "string",
      enum: XAI_PRESET_VOICES,
      description: "xAI preset voice (shorthand for voice: { provider: xai }). Omitted: the character's voice, else eve.",
    },
    model: {
      type: "string",
      enum: LIP_SYNC_MODELS,
      default: "kling-lipsync",
      description:
        "Lip-sync model. kling-lipsync (default): 2 to 10 second clips at 720p or 1080p, about US$0.014 per 5 seconds. sync-lipsync-2-pro: best mouth fidelity, any resolution, clips up to 60 seconds, about US$5 per minute.",
    },
  },
  add_captions: {
    captions: {
      type: "string",
      max_length: 2000,
      description: "The words to show. Omit to use a wired text node or the video's script.",
    },
    position: {
      type: "string",
      default: "bottom",
      description: "bottom sits in the lower third above TikTok's own caption area.",
    },
    timing: {
      type: "string",
      enum: CAPTION_TIMINGS,
      description:
        "Optional. even spreads the words evenly across the clip (as before). speech transcribes the clip's speech (whisper-1, about US$0.006 per minute) and shows each chunk of words as it is spoken; the captions text or script, when given, corrects the transcript's spellings.",
    },
    cues: {
      type: "array",
      max_items: MAX_OVERLAY_CUES,
      items: CUE_FIELDS,
      description: `Optional timed text: at most ${MAX_OVERLAY_CUES} cues, each { text (1 to ${MAX_CUE_TEXT_CHARS} characters, at most ${MAX_CUE_LINES} lines split with \\n), start, end (seconds from the start of the clip, 0 <= start < end), position? (${OVERLAY_POSITIONS.join(", ")}), style? (${OVERLAY_STYLES.join(", ")}), y? (${OVERLAY_Y_MIN} to ${OVERLAY_Y_MAX}, the vertical centre as a fraction of frame height, 0 is the top; overrides position), size? (${OVERLAY_SIZES.join(", ")}; default medium for a caption, large for a card), max_width? (${OVERLAY_MAX_WIDTH_MIN} to ${OVERLAY_MAX_WIDTH_MAX} of frame width) }. card is a bold title card, caption a subtitle line; use cards for points timed to spoken moments. In a 9:16 talking clip keep cards out of the upper third (the face), for example y 0.62 or position center.`,
    },
  },
  input_video: {
    video_job_id: {
      type: "string",
      description:
        "A finished (ready) video job in this workspace, for example from adsoptimiser_list_jobs. Give exactly one of video_job_id or video_url.",
    },
    video_url: {
      type: "string",
      description:
        "Or the workspace's own /media URL of a video (for example a media_url from an earlier job or adsoptimiser_upload_file).",
    },
  },
};

/**
 * What this local server adds to a param's meaning: appended to the API's
 * description (or the fallback one above) so it survives catalogue changes.
 */
const LOCAL_PARAM_NOTES = {
  input_image: {
    image_url:
      "With this local server, an absolute local file path also works: it is uploaded for you and replaced with its hosted URL.",
  },
  input_video: {
    video_url:
      "With this local server, an absolute local .mp4 or .mov path also works (as video_url or video_path): it is uploaded for you and replaced with its hosted URL.",
  },
};

export const GRAPH_RULES = [
  'Graph JSON: {"version":1,"nodes":[{"id":"...","type":"...","params":{...}}],"edges":[{"from":{"node":"<id>","output":"<output>"},"to":{"node":"<id>","input":"<input>"}}]}.',
  `At most ${MAX_GRAPH_NODES} nodes. Node ids are unique, 1 to 40 letters, digits or underscores (no hyphens).`,
  "Use only the node types, input and output names and params listed here. Never invent a node type, port or param.",
  "An edge joins an output to an input of the same kind (text, image or video). No cycles, and a node cannot feed itself.",
  "Each input takes at most its max_connections edges (1 unless stated). One output may feed many inputs (fan-out).",
  "Required inputs other than prompt must be connected.",
  "A prompt input with nothing wired into it uses the run prompt given to adsoptimiser_run_pipeline. When every prompt input is fed by a text or refine_prompt node (or a voice node has a script), no run prompt is needed. Wire one text node to several prompt inputs to share a prompt, or use separate text nodes to give branches different prompts.",
  "Each generate_image, generate_video, image_to_video, extend_video, voiced_video and lip_sync node is one generation from the plan allowance (video nodes, lip_sync included, also count toward the daily video quota); add_voiceover, strip_audio and add_captions are post-processing creative jobs, never generations; text, input_image, input_video, character and refine_prompt are free.",
  "A character node (character_id from adsoptimiser_list_characters) feeds a generate_image or voiced_video refs input as ONE connection and fills the free reference slots with its images; it cannot feed image_to_video's image input. Its description is added to that node's prompt and voiced_video uses its default voice when voice_id is omitted.",
  "add_captions burns text into a video: its captions param, else a text node wired into its text input, else the script of the voiced_video (or add_voiceover or lip_sync) it captions.",
  `add_captions timing: even (omitted) spreads the words across the clip; speech transcribes the clip's speech (whisper-1, about US$0.006 per minute) and shows each chunk as it is spoken, with the captions text or script correcting spellings. Its optional cues param adds timed text: [{"text","start","end","position"?,"style"?,"y"?,"size"?,"max_width"?}], at most ${MAX_OVERLAY_CUES}, seconds from the start of the clip, style card for a title card timed to a spoken moment. y (${OVERLAY_Y_MIN} to ${OVERLAY_Y_MAX}, 0 is the top) overrides position; size is ${OVERLAY_SIZES.join(", ")}; max_width is ${OVERLAY_MAX_WIDTH_MIN} to ${OVERLAY_MAX_WIDTH_MAX} of the frame width; text may hold \\n line breaks (at most ${MAX_CUE_LINES} lines). In a 9:16 talking clip keep cards out of the upper third, where the face is: y 0.62 or position center. It stays a post-processing creative job, never a generation. Outside a pipeline, adsoptimiser_add_overlays does the same to a finished video.`,
  'add_voiceover voice: its voice param ({"provider":"xai","voice_id"}, {"provider":"openai","voice","instructions"?} or {"provider":"elevenlabs","voice_id"}, see adsoptimiser_list_voices) or voice_id wins, else the voice of the character the video was made from (a character wired upstream of that video), else eve. OpenAI narration needs a script of at most 4096 characters.',
  "voiced_video (and adsoptimiser_generate_video with a script) only speaks xAI presets: an OpenAI character voice falls back to the character's xai_voice_id, else eve, and the job says so. For a talking clip in an OpenAI (designed) voice with matching mouth movement, use lip_sync.",
  'lip_sync re-animates the mouth in its wired video so the person speaks a line in a designed voice. Script: its script param, else a text node wired into its "script" input, else the run prompt. Voice: its voice ({"provider":"elevenlabs","voice_id"}, {"provider":"openai","voice","instructions"?} or xai) or voice_id, else the voice of the character upstream of the video, else eve. kling-lipsync (the default; about US$0.014 per 5s) needs the generating node to set resolution 720p or 1080p and duration 2 to 10; the line must fit the clip (about 15 characters a second, so about 20 words for an 8s clip). sync-lipsync-2-pro (about US$5 per minute) gives the best lips at any resolution and up to 60s. The output keeps the new audio, so wire add_captions straight after it (captions default to the script); no strip_audio needed.',
  "Template character-lip-sync, \"Character talking clip (designed voice)\" (pass character_id; the run prompt is the exact line spoken, about 20 words): refine_prompt (scene from the line) > character > generate_image > image_to_video (8s, 720p) > lip_sync > add_captions. About US$0.72 per run in provider costs.",
  "generate_image with gpt-image-2.5-sunburst (follows detailed specs closely: exact colours, counts, layouts) or gpt-image-2.5-flare (fast), where the deployment lists them: quality low, medium (default), high or auto; aspect_ratio 9:16, 16:9 or 1:1 (9:16 is delivered as 2:3, 1024x1536); no resolution. A Grok image step that fails upstream (5xx or timeout) is retried once on gpt-image-2.5-sunburst when the deployment has an OpenAI key.",
  "input_image needs params.image_url: an https URL, or with this local server an absolute local file path, which is uploaded for you.",
  "input_video (\"Your video (library)\") starts a pipeline from a video you already have: no inputs, output video, free and creates no job. Params: exactly one of video_job_id (a ready video job in this workspace) or video_url (the workspace's own /media URL; with this local server, or video_path, an absolute local .mp4 or .mov path, uploaded for you). Wire its video into add_captions, add_voiceover, strip_audio, lip_sync or extend_video. To caption or re-caption a finished video no new generation is needed: input_video > add_captions, or simply adsoptimiser_add_overlays.",
  "Template \"Re-caption a video (your video -> captions)\": input_video > add_captions. It needs your video, so build it as a graph with the input_video step's video_job_id or video_url set and pass it to adsoptimiser_run_pipeline as graph (or use adsoptimiser_add_overlays directly).",
  "position is optional editor layout; leave it out.",
];

/** Refine the run prompt, make a 9:16 image, animate it for 6 seconds. */
export const EXAMPLE_GRAPH = {
  version: 1,
  nodes: [
    { id: "refine", type: "refine_prompt" },
    {
      id: "image",
      type: "generate_image",
      params: { model: "grok-imagine-image-2.0", aspect_ratio: "9:16", quality: "low" },
    },
    {
      id: "video",
      type: "image_to_video",
      params: { model: "grok-imagine-video-1.5", duration: 6, resolution: "720p", aspect_ratio: "9:16" },
    },
  ],
  edges: [
    { from: { node: "refine", output: "text" }, to: { node: "image", input: "prompt" } },
    { from: { node: "refine", output: "text" }, to: { node: "video", input: "prompt" } },
    { from: { node: "image", output: "image" }, to: { node: "video", input: "image" } },
  ],
};

export const EXAMPLE_DESCRIPTION =
  "Refines the run prompt, generates a 9:16 product image from it, then animates that image into a 6 second video. Two generations; needs a run prompt.";

/**
 * The API's params for a node as { name: spec }. Current deployments send an
 * array of { name, type, required, enum, min, max, maxLength, default, oneOf,
 * description }; an object map is taken as is. null when there are none.
 */
function apiParams(params) {
  if (Array.isArray(params)) {
    const out = {};
    for (const p of params) {
      if (!p || typeof p.name !== "string") continue;
      const { name, maxLength, maxItems, oneOf, enum: values, ...rest } = p;
      out[name] = {
        ...rest,
        ...(values ? { enum: values } : {}),
        ...(maxLength !== undefined ? { max_length: maxLength } : {}),
        ...(maxItems !== undefined ? { max_items: maxItems } : {}),
        ...(oneOf ? { one_of: oneOf } : {}),
      };
    }
    return out;
  }
  return params && typeof params === "object" ? params : null;
}

/** One node type from GET /pipelines/nodes, reduced to what a graph author needs. */
export function compactNodeType(def) {
  const enums = def.enums ?? {};
  const local = PARAM_SPECS[def.type] ?? {};
  const notes = LOCAL_PARAM_NOTES[def.type] ?? {};
  // The API decides which params exist; the local specs only fill gaps.
  const specs = apiParams(def.params) ?? local;
  const params = {};
  for (const [name, spec] of Object.entries(specs)) {
    const merged = { ...(local[name] ?? {}), ...spec };
    if (enums[name] && !merged.enum) merged.enum = enums[name];
    if (merged.required !== true) delete merged.required;
    if (notes[name]) {
      merged.description = merged.description ? `${merged.description} ${notes[name]}` : notes[name];
    }
    params[name] = merged;
  }
  for (const [name, values] of Object.entries(enums)) {
    if (!params[name]) params[name] = { type: "string", enum: values };
  }
  return {
    type: def.type,
    label: def.label,
    inputs: (def.inputs ?? []).map((p) => ({
      name: p.name,
      kind: p.kind,
      required: p.required === true,
      max_connections: p.maxConnections ?? p.max_connections ?? 1,
      ...(p.description ? { description: p.description } : {}),
    })),
    outputs: (def.outputs ?? []).map((p) => ({
      name: p.name,
      kind: p.kind,
      ...(p.description ? { description: p.description } : {}),
    })),
    params,
    constraints: def.constraints ?? [],
  };
}

/** {"provider":"xai","voice_id"} | {"provider":"openai","voice","instructions"?} */
function describeOneOf(variants) {
  return variants
    .map(
      (variant) =>
        `{${Object.entries(variant ?? {})
          .map(([key, s]) =>
            s && s.const !== undefined ? `"${key}":${JSON.stringify(s.const)}` : `"${key}"${s?.optional ? "?" : ""}`
          )
          .join(",")}}`
    )
    .join(" | ");
}

/**
 * The fields of an array param's items, as { name: spec } with optional
 * marked: a field map as the local specs use, or a JSON schema object
 * ({ properties, required }) as an API may send. null when there are none.
 */
function arrayItemFields(items) {
  if (!items || typeof items !== "object" || Array.isArray(items)) return null;
  if (items.properties && typeof items.properties === "object") {
    const required = Array.isArray(items.required) ? items.required : null;
    const fields = {};
    for (const [key, spec] of Object.entries(items.properties)) {
      fields[key] = { ...(spec ?? {}), ...(required && !required.includes(key) ? { optional: true } : {}) };
    }
    return Object.keys(fields).length ? fields : null;
  }
  if (typeof items.type === "string") return null;
  return Object.keys(items).length ? items : null;
}

function describeParam(name, spec) {
  const bits = [];
  if (spec.required) bits.push("required");
  if (Array.isArray(spec.one_of)) {
    bits.push(`object ${describeOneOf(spec.one_of)}${name === "voice" ? ", see adsoptimiser_list_voices" : ""}`);
  }
  if (spec.type === "array") {
    const fields = arrayItemFields(spec.items);
    bits.push(fields ? `list of ${describeOneOf([fields])}` : "list");
  }
  if (spec.enum) bits.push(spec.enum.join("|"));
  if (spec.min !== undefined || spec.max !== undefined) bits.push(`${spec.min ?? ""}..${spec.max ?? ""}`);
  if (spec.max_length) bits.push(`max ${spec.max_length} chars`);
  if (spec.max_items) bits.push(`max ${spec.max_items} items`);
  if (spec.default !== undefined) bits.push(`default ${spec.default}`);
  return `${name}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

export function describeNodeType(node) {
  const inputs = node.inputs.length
    ? node.inputs
        .map((p) => `${p.name}:${p.kind}${p.required ? "*" : ""}${p.max_connections > 1 ? ` x${p.max_connections}` : ""}`)
        .join(", ")
    : "none";
  const outputs = node.outputs.map((p) => `${p.name}:${p.kind}`).join(", ") || "none";
  const params = Object.entries(node.params).map(([n, s]) => describeParam(n, s));
  return [
    `- ${node.type} (${node.label}). Inputs: ${inputs}. Outputs: ${outputs}.`,
    `  Params: ${params.length ? params.join("; ") : "none"}.`,
    ...(node.constraints.length ? [`  Rules: ${node.constraints.join(" ")}`] : []),
  ].join("\n");
}

/** Node ids a validator message names, e.g. `node "img"` or `edge a.text → b.prompt`. */
export function nodeIdsIn(message) {
  const ids = new Set();
  for (const m of String(message).matchAll(/\b(?:node(?: id)?) "([^"]+)"/gi)) ids.add(m[1]);
  const edge = String(message).match(/^edge ([^.\s]+)\.\S+ \S+ ([^.\s]+)\./);
  if (edge) {
    if (edge[1] !== "?") ids.add(edge[1]);
    if (edge[2] !== "?") ids.add(edge[2]);
  }
  return [...ids];
}

/** Validator errors (strings, or objects from a newer API) as { message, node_ids }. */
export function shapeErrors(errors) {
  return (Array.isArray(errors) ? errors : []).map((e) => {
    if (e && typeof e === "object") {
      const message = String(e.message ?? e.error ?? JSON.stringify(e));
      const ids = Array.isArray(e.node_ids) ? e.node_ids : e.node_id ? [e.node_id] : nodeIdsIn(message);
      return { message, node_ids: ids.map(String) };
    }
    return { message: String(e), node_ids: nodeIdsIn(e) };
  });
}

/** Mirrors graphNeedsRunPrompt in the worker, for when the API does not report it. */
const PROMPTED_TYPES = new Set([
  "refine_prompt",
  "generate_image",
  "generate_video",
  "image_to_video",
  "extend_video",
  "add_voiceover",
  "voiced_video",
]);
export function graphNeedsRunPrompt(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  return nodes.some((node) => {
    // lip_sync speaks the run prompt when it has no script and none is wired.
    if (node?.type === "lip_sync") {
      const script = node.params?.script;
      if (typeof script === "string" && script.trim()) return false;
      return !edges.some((e) => e?.to?.node === node.id && e?.to?.input === "script");
    }
    if (!PROMPTED_TYPES.has(node?.type)) return false;
    const script = node.params?.script;
    if ((node.type === "add_voiceover" || node.type === "voiced_video") && typeof script === "string" && script.trim()) {
      return false;
    }
    return !edges.some((e) => e?.to?.node === node.id && e?.to?.input === "prompt");
  });
}

/** Whichever of the API's names for "a run prompt is needed" it sent, else computed. */
export function needsRunPrompt(apiResult, graph) {
  for (const key of ["needs_run_prompt", "needs_prompt", "requires_prompt", "prompt_required"]) {
    if (typeof apiResult?.[key] === "boolean") return apiResult[key];
  }
  return graphNeedsRunPrompt(graph);
}

const REMOTE_IMAGE = /^(https?:\/\/|data:image\/)/i;

/**
 * The input_image nodes whose image is a local file: `params.image_url` that is
 * not an http(s) or data:image URL, or `params.image_path`.
 * @returns {{ node: object, path: string }[]}
 */
export function localImageRefs(graph) {
  const refs = [];
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (node?.type !== "input_image") continue;
    const params = node.params ?? {};
    const url = typeof params.image_url === "string" ? params.image_url.trim() : "";
    const path = typeof params.image_path === "string" ? params.image_path.trim() : "";
    if (path && url) {
      refs.push({ node, path, conflict: true });
    } else if (path) {
      refs.push({ node, path });
    } else if (url && !REMOTE_IMAGE.test(url)) {
      refs.push({ node, path: url });
    }
  }
  return refs;
}

const REMOTE_VIDEO = /^https?:\/\//i;

/**
 * The input_video nodes whose video is a local file: `params.video_path`, or
 * a `params.video_url` that is not an http(s) URL. A local file with another
 * source on the same node is a conflict.
 * @returns {{ node: object, path: string, conflict?: string }[]}
 */
export function localVideoRefs(graph) {
  const refs = [];
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (node?.type !== "input_video") continue;
    const params = node.params ?? {};
    const str = (v) => (typeof v === "string" ? v.trim() : "");
    const url = str(params.video_url);
    const path = str(params.video_path);
    const jobId = str(params.video_job_id);
    const localUrl = url && !REMOTE_VIDEO.test(url);
    if (path && url) {
      refs.push({ node, path, conflict: "video_url and video_path" });
    } else if ((path || localUrl) && jobId) {
      refs.push({ node, path: path || url, conflict: `video_job_id and ${path ? "video_path" : "a local video_url"}` });
    } else if (path) {
      refs.push({ node, path });
    } else if (localUrl) {
      refs.push({ node, path: url });
    }
  }
  return refs;
}

/**
 * Local problems with the add_captions nodes' cues, checked with the same
 * rules as adsoptimiser_add_overlays so a bad graph fails before anything is
 * uploaded or sent.
 * @returns {string[]}
 */
export function graphCueProblems(graph) {
  const problems = [];
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (node?.type !== "add_captions" || node.params?.cues === undefined) continue;
    const cues = node.params.cues;
    if (!Array.isArray(cues)) {
      problems.push(`node "${node.id}" cues must be a list of { text, start, end, position?, style?, y?, size?, max_width? }.`);
      continue;
    }
    problems.push(...cueListProblems(cues, `node "${node.id}" cues`));
  }
  return problems;
}

/**
 * What an older API's graph errors say it does not support yet, as phrases
 * for "this Ads Optimiser deployment doesn't support <feature> yet": the
 * input_video node, and the add_captions cues' placement fields.
 * @param {{ message: string }[]} errors shaped validator errors
 */
export function unsupportedGraphFeatures(errors, graph) {
  const text = (Array.isArray(errors) ? errors : []).map((e) => e?.message ?? String(e)).join("\n");
  const features = [];
  if (/input_video/.test(text) && /unknown|not a known|unsupported|not supported|invalid (?:node )?type/i.test(text)) {
    features.push('the input_video node ("Your video")');
  }
  const cues = (Array.isArray(graph?.nodes) ? graph.nodes : [])
    .filter((n) => n?.type === "add_captions" && Array.isArray(n.params?.cues))
    .flatMap((n) => n.params.cues);
  const placement = refusedPlacementFeature(text, placementFeaturesUsed(cues));
  if (placement) features.push(placement);
  return features;
}

/** A deep copy of the graph with `version: 1` and an `edges` array filled in. */
export function normaliseGraph(graph) {
  const copy = JSON.parse(JSON.stringify(graph ?? {}));
  if (copy.version === undefined) copy.version = 1;
  if (!Array.isArray(copy.edges)) copy.edges = [];
  return copy;
}
