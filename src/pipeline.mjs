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
 * Parameter ranges and meanings per node type. The API's catalogue carries the
 * enums; the numeric ranges and free-text params live in the worker's
 * validator (pipeline-graph.ts validateNodeParams), so they are restated here.
 */
const DURATION = { type: "integer", min: 1, max: 15, description: "Seconds, 1 to 15." };
const SCRIPT = {
  type: "string",
  max_length: 5000,
  description: "The exact line to be spoken.",
};
export const PARAM_SPECS = {
  refine_prompt: {
    instruction: {
      type: "string",
      description: "Optional system prompt for the rewrite. Omit to use the default ad-prompt rewrite.",
    },
  },
  generate_image: {
    model: { type: "string", description: "Defaults to grok-imagine-image-2.0." },
    aspect_ratio: { type: "string", description: "9:16 is TikTok vertical." },
    quality: {
      type: "string",
      description: "grok-imagine-image-2.0 only; defaults to low. medium is several times slower.",
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
    script: { ...SCRIPT, required: true },
    voice_id: { type: "string" },
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
        "An https URL of an existing image (for example a media_url from an earlier job or adsoptimiser_upload_file). With this local server, an absolute local file path also works: it is uploaded for you and replaced with its hosted URL.",
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
};

export const GRAPH_RULES = [
  'Graph JSON: {"version":1,"nodes":[{"id":"...","type":"...","params":{...}}],"edges":[{"from":{"node":"<id>","output":"<output>"},"to":{"node":"<id>","input":"<input>"}}]}.',
  `At most ${MAX_GRAPH_NODES} nodes. Node ids are unique, 1 to 40 letters, digits or underscores (no hyphens).`,
  "Use only the node types, input and output names and params listed here. Never invent a node type, port or param.",
  "An edge joins an output to an input of the same kind (text, image or video). No cycles, and a node cannot feed itself.",
  "Each input takes at most its max_connections edges (1 unless stated). One output may feed many inputs (fan-out).",
  "Required inputs other than prompt must be connected.",
  "A prompt input with nothing wired into it uses the run prompt given to adsoptimiser_run_pipeline. When every prompt input is fed by a text or refine_prompt node (or a voice node has a script), no run prompt is needed. Wire one text node to several prompt inputs to share a prompt, or use separate text nodes to give branches different prompts.",
  "Each generate_image, generate_video, image_to_video, extend_video and voiced_video node is one generation from the plan allowance (video nodes also count toward the daily video quota); add_voiceover and strip_audio are post-processing jobs; text, input_image and refine_prompt are free.",
  "input_image needs params.image_url: an https URL, or with this local server an absolute local file path, which is uploaded for you.",
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

/** One node type from GET /pipelines/nodes, reduced to what a graph author needs. */
export function compactNodeType(def) {
  const enums = def.enums ?? {};
  const specs = def.params ?? PARAM_SPECS[def.type] ?? {};
  const params = {};
  for (const [name, spec] of Object.entries(specs)) {
    params[name] = { ...spec, ...(enums[name] ? { enum: enums[name] } : {}) };
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
    outputs: (def.outputs ?? []).map((p) => ({ name: p.name, kind: p.kind })),
    params,
    constraints: def.constraints ?? [],
  };
}

function describeParam(name, spec) {
  const bits = [];
  if (spec.required) bits.push("required");
  if (spec.enum) bits.push(spec.enum.join("|"));
  if (spec.min !== undefined || spec.max !== undefined) bits.push(`${spec.min ?? ""}..${spec.max ?? ""}`);
  if (spec.max_length) bits.push(`max ${spec.max_length} chars`);
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

/** A deep copy of the graph with `version: 1` and an `edges` array filled in. */
export function normaliseGraph(graph) {
  const copy = JSON.parse(JSON.stringify(graph ?? {}));
  if (copy.version === undefined) copy.version = 1;
  if (!Array.isArray(copy.edges)) copy.edges = [];
  return copy;
}
