// OpenAI GPT Image 2.5 models, the Grok -> OpenAI fallback and the rules that
// go with them, as the hosted connector and the API (routes/api-v1.ts) have them.

import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { imageOptionsError } from "../src/server.mjs";
import { GRAPH_RULES, compactNodeType, describeNodeType } from "../src/pipeline.mjs";
import { startClient, startStub, tempDir } from "./helpers.mjs";

const FALLBACK_PARAMS = (reason) => ({
  aspect_ratio: "9:16",
  fallback: {
    from: "grok-imagine-image-2.0",
    to: "gpt-image-2.5-sunburst",
    reason,
    size: "1024x1536",
    quality: "medium",
    at: "2026-09-28T00:00:00.000Z",
  },
  provider_usage: { provider: "openai", model: "gpt-image-2.5-sunburst", cost_usd: 0.01139 },
});

const JOBS = {
  job_fallback: {
    job_id: "job_fallback",
    asset_type: "image",
    status: "ready",
    model: "gpt-image-2.5-sunburst",
    prompt: "Four buttons",
    storage_uri: "images/fallback.png",
    generation_params: FALLBACK_PARAMS("500"),
  },
  job_fallback_failed: {
    job_id: "job_fallback_failed",
    asset_type: "image",
    status: "failed",
    model: "grok-imagine-image-2.0",
    prompt: "Four buttons",
    error_detail:
      "Grok image generation failed (500): internal; fallback to gpt-image-2.5-sunburst also failed: OpenAI image generation failed (503)",
    generation_params: { aspect_ratio: "9:16", fallback: FALLBACK_PARAMS("timeout").fallback },
  },
  job_sunburst: {
    job_id: "job_sunburst",
    asset_type: "image",
    status: "ready",
    model: "gpt-image-2.5-sunburst",
    prompt: "Character sheet",
    storage_uri: "images/sunburst.png",
    generation_params: {
      aspect_ratio: "2:3",
      quality: "high",
      provider_usage: { provider: "openai", model: "gpt-image-2.5-sunburst", cost_usd: 0.0452 },
    },
  },
  job_grok: {
    job_id: "job_grok",
    asset_type: "image",
    status: "ready",
    model: "grok-imagine-image-2.0",
    prompt: "A red sneaker",
    storage_uri: "images/grok.png",
    generation_params: { aspect_ratio: "9:16", quality: "low" },
  },
};

function fakeApi(r) {
  const route = `${r.method} ${r.path}`;
  if (route === "POST /api/v1/jobs") {
    const body = JSON.parse(r.body.toString());
    return {
      status: 201,
      json: { job_id: "job_new", asset_type: body.asset_type, status: "queued", model: body.model, prompt: body.prompt },
    };
  }
  const id = r.path.match(/^\/api\/v1\/jobs\/([^/]+)$/)?.[1];
  if (r.method === "GET" && id && JOBS[id]) return { json: JOBS[id] };
  if (route === "GET /api/v1/jobs") {
    return { json: { jobs: [JOBS.job_fallback, JOBS.job_grok], total: 2 } };
  }
  return undefined;
}

const jobPosts = (stub) => stub.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/jobs");

describe("OpenAI image models", () => {
  let stub;
  let ctx;
  let work;
  before(async () => {
    stub = await startStub(fakeApi);
  });
  after(async () => {
    await stub.close();
  });
  afterEach(async () => {
    await ctx?.close();
    work?.cleanup();
    work = undefined;
    stub.requests.length = 0;
    stub.setHandler(fakeApi);
  });

  async function connect(options) {
    ctx = await startClient(stub.url, options);
    ctx.connectToken();
    return ctx;
  }

  it("the generate_image schema offers the OpenAI models and quality high", async () => {
    await connect();
    const { tools } = await ctx.client.listTools();
    const gen = tools.find((t) => t.name === "adsoptimiser_generate_image");
    assert.deepEqual(gen.inputSchema.properties.quality.enum, ["low", "medium", "high", "auto"]);
    assert.match(gen.inputSchema.properties.model.description, /gpt-image-2\.5-sunburst \(OpenAI, follows detailed specs closely\)/);
    assert.match(gen.inputSchema.properties.model.description, /gpt-image-2\.5-flare \(OpenAI, fast\)/);
    assert.match(gen.inputSchema.properties.aspect_ratio.description, /1:1, 2:3, 9:16, 3:2, 16:9 or auto/);
    assert.match(gen.inputSchema.properties.resolution.description, /Grok models only/);
    assert.match(gen.description, /retry once on GPT Image 2\.5 Sunburst/);
    const batch = tools.find((t) => t.name === "adsoptimiser_batch_generate");
    assert.deepEqual(batch.inputSchema.properties.quality.enum, ["low", "medium", "high", "auto"]);
  });

  it("generate_image sends an OpenAI model with quality high", async () => {
    await connect();
    const res = await ctx.call("adsoptimiser_generate_image", {
      prompt: "four buttons: green, teal, amber, coral",
      model: "gpt-image-2.5-sunburst",
      quality: "high",
      aspect_ratio: "2:3",
      wait: false,
    });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(JSON.parse(jobPosts(stub)[0].body.toString()), {
      asset_type: "image",
      prompt: "four buttons: green, teal, amber, coral",
      model: "gpt-image-2.5-sunburst",
      generation_params: { aspect_ratio: "2:3", quality: "high" },
    });
  });

  it("accepts 9:16 and auto for OpenAI models, and passes a model it does not know to the API", async () => {
    await connect();
    for (const aspect_ratio of ["9:16", "auto", "16:9", "1:1", "3:2"]) {
      const res = await ctx.call("adsoptimiser_generate_image", {
        prompt: "x",
        model: "gpt-image-2.5-flare",
        aspect_ratio,
        wait: false,
      });
      assert.equal(res.isError, false, `${aspect_ratio}: ${res.text}`);
    }
    const future = await ctx.call("adsoptimiser_generate_image", {
      prompt: "x",
      model: "some-future-model",
      quality: "high",
      wait: false,
    });
    assert.equal(future.isError, false, future.text);
    assert.equal(jobPosts(stub).length, 6);
  });

  const refusals = [
    [
      "an aspect ratio GPT Image 2.5 cannot deliver",
      { model: "gpt-image-2.5-sunburst", aspect_ratio: "4:5" },
      /gpt-image-2\.5-sunburst takes aspect_ratio 1:1, 2:3, 9:16, 3:2, 16:9, auto, not 4:5\. For TikTok vertical use 9:16 \(delivered as 2:3, 1024x1536\)/,
    ],
    [
      "a resolution on an OpenAI model",
      { model: "gpt-image-2.5-flare", resolution: "2k" },
      /gpt-image-2\.5-flare takes no resolution: the size follows aspect_ratio/,
    ],
    [
      "quality high on Grok Image 2.0",
      { quality: "high" },
      /quality high is for the OpenAI models only .*grok-imagine-image-2\.0 takes low, medium or auto/,
    ],
    [
      "quality on grok-imagine-image",
      { model: "grok-imagine-image", quality: "low" },
      /grok-imagine-image takes no quality; leave it out/,
    ],
    [
      "quality high on grok-imagine-image",
      { model: "grok-imagine-image", quality: "high" },
      /quality high is for the OpenAI models only .*grok-imagine-image takes no quality/,
    ],
  ];
  for (const [label, args, pattern] of refusals) {
    it(`refuses ${label} before calling the API`, async () => {
      await connect();
      const res = await ctx.call("adsoptimiser_generate_image", { prompt: "x", ...args });
      assert.equal(res.isError, true);
      assert.match(res.text, pattern);
      assert.match(res.text, /Nothing was sent or charged/);
      assert.equal(stub.requests.length, 0);
    });
  }

  it("get_job explains a Grok -> OpenAI fallback and the provider cost", async () => {
    await connect();
    const ready = await ctx.call("adsoptimiser_get_job", { job_id: "job_fallback", include_thumbnails: false });
    assert.equal(ready.isError, false, ready.text);
    assert.match(ready.text, /\(gpt-image-2\.5-sunburst\)/);
    assert.match(ready.text, /Generated with GPT Image 2\.5 Sunburst after Grok failed \(500\)\./);
    assert.match(ready.text, /Provider cost: US\$0\.0114 \(openai\)\./);
    assert.equal(ready.structured.model, "gpt-image-2.5-sunburst");
    assert.equal(ready.structured.fallback_note, "Generated with GPT Image 2.5 Sunburst after Grok failed (500)");
    assert.deepEqual(ready.structured.fallback, {
      from: "grok-imagine-image-2.0",
      to: "gpt-image-2.5-sunburst",
      reason: "500",
    });
    assert.equal(ready.structured.provider_cost_usd, 0.01139);
    assert.equal(ready.structured.provider, "openai");

    const failed = await ctx.call("adsoptimiser_get_job", {
      job_id: "job_fallback_failed",
      include_thumbnails: false,
    });
    assert.match(failed.text, /Grok timed out; retried once on GPT Image 2\.5 Sunburst\./);
    assert.match(failed.text, /fallback to gpt-image-2\.5-sunburst also failed/);
    assert.doesNotMatch(failed.text, /Provider cost/);

    const chosen = await ctx.call("adsoptimiser_get_job", { job_id: "job_sunburst", include_thumbnails: false });
    assert.match(chosen.text, /Provider cost: US\$0\.0452 \(openai\)\./);
    assert.equal(chosen.structured.fallback_note, undefined);

    const plain = await ctx.call("adsoptimiser_get_job", { job_id: "job_grok", include_thumbnails: false });
    assert.equal(plain.structured.fallback_note, undefined);
    assert.equal(plain.structured.fallback, undefined);
    assert.equal(plain.structured.provider_cost_usd, undefined);
    assert.doesNotMatch(plain.text, /Generated with|Provider cost/);
  });

  it("list_jobs marks jobs made by the fallback", async () => {
    await connect();
    const res = await ctx.call("adsoptimiser_list_jobs");
    assert.equal(res.isError, false, res.text);
    const lines = res.text.split("\n");
    assert.match(lines.find((l) => l.includes("job_fallback")), /\[Generated with GPT Image 2\.5 Sunburst after Grok failed \(500\)\]$/);
    assert.doesNotMatch(lines.find((l) => l.includes("job_grok")), /\[/);
    assert.equal(res.structured.jobs[0].provider_cost_usd, 0.01139);
  });

  const errors = [
    [
      "OpenAI images not configured",
      {
        status: 503,
        json: {
          error: "OpenAI image models aren't configured on this deployment. Use a Grok image model instead.",
          code: "openai_images_not_configured",
        },
      },
      /OpenAI image models \(GPT Image 2\.5 Sunburst and Flare\) aren't configured on this Ads Optimiser deployment .*Nothing was charged\. Use a Grok image model instead, for example grok-imagine-image-2\.0/,
    ],
    [
      "an unknown image model",
      {
        status: 400,
        json: {
          error:
            'Unknown image model "gpt-image-3". Available: grok-imagine-image-2.0, grok-imagine-image, gpt-image-2.5-sunburst, gpt-image-2.5-flare, photon-1, photon-flash-1 (see GET /api/v1/models)',
        },
      },
      /The request was rejected: Unknown image model "gpt-image-3".*\nCall adsoptimiser_list_models to see the image models this deployment offers\./s,
    ],
    [
      "an aspect ratio the API refuses for an OpenAI model",
      {
        status: 400,
        json: {
          error:
            "aspect_ratio must be one of: 1:1, 2:3, 9:16, 3:2, 16:9, auto for gpt-image-2.5-sunburst (9:16 is delivered at 1024x1536, 16:9 at 1536x1024)",
        },
      },
      /\n.*9:16 is delivered as 2:3 \(1024x1536\) and 16:9 as 3:2 \(1536x1024\)\./,
    ],
  ];
  for (const [label, reply, pattern] of errors) {
    it(`maps ${label} to a clear message`, async () => {
      stub.setHandler(() => reply);
      await connect();
      // An id the local rules don't know, so the request reaches the API.
      const res = await ctx.call("adsoptimiser_generate_image", { prompt: "x", model: "gpt-image-3", wait: false });
      assert.equal(res.isError, true);
      assert.match(res.text, pattern);
      assert.equal(res.structured.code, reply.json.code ?? res.structured.code);
    });
  }

  it("batch_generate passes model and quality through and refuses bad combinations up front", async () => {
    work = tempDir();
    const prompts = join(work.dir, "prompts.txt");
    writeFileSync(prompts, "Four buttons\nA character sheet\n");
    await connect({ cwd: work.dir });

    const bad = await ctx.call("adsoptimiser_batch_generate", {
      mode: "prompts",
      prompts_file: prompts,
      model: "gpt-image-2.5-sunburst",
      resolution: "2k",
    });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /takes no resolution/);
    assert.equal(stub.requests.length, 0);

    const res = await ctx.call("adsoptimiser_batch_generate", {
      mode: "prompts",
      prompts_file: prompts,
      model: "gpt-image-2.5-sunburst",
      quality: "high",
      aspect_ratio: "9:16",
    });
    assert.equal(res.isError, false, res.text);
    const bodies = jobPosts(stub).map((r) => JSON.parse(r.body.toString()));
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.equal(body.model, "gpt-image-2.5-sunburst");
      assert.deepEqual(body.generation_params, { aspect_ratio: "9:16", quality: "high" });
    }

    // Videos ignore image quality rules.
    stub.requests.length = 0;
    const videos = await ctx.call("adsoptimiser_batch_generate", {
      mode: "prompts",
      prompts_file: prompts,
      asset_type: "video",
      quality: "high",
      max_items: 1,
    });
    assert.equal(videos.isError, false, videos.text);
  });
});

describe("imageOptionsError", () => {
  it("mirrors the API's image rules and leaves unknown models alone", () => {
    assert.equal(imageOptionsError({}), null);
    assert.equal(imageOptionsError({ quality: "medium" }), null);
    assert.equal(imageOptionsError({ model: "grok-imagine-image-quality", quality: "low" }), null);
    assert.equal(imageOptionsError({ model: "gpt-image-2.5-sunburst", quality: "auto", aspect_ratio: "auto" }), null);
    assert.equal(imageOptionsError({ model: "gpt-image-2.5-flare", aspect_ratio: " 9:16 " }), null);
    assert.equal(imageOptionsError({ model: "photon-1" }), null);
    assert.match(imageOptionsError({ model: "photon-flash-1", quality: "low" }), /takes no quality/);
    assert.match(imageOptionsError({ model: "gpt-image-2.5-flare", aspect_ratio: "21:9" }), /not 21:9/);
    assert.equal(imageOptionsError({ model: "unknown-model", quality: "high", resolution: "2k" }), null);
  });
});

describe("pipeline catalogue", () => {
  it("passes the OpenAI model and quality enums through and describes them", () => {
    const node = compactNodeType({
      type: "generate_image",
      label: "Generate image",
      inputs: [{ name: "prompt", kind: "text" }],
      outputs: [{ name: "image", kind: "image" }],
      params: [
        {
          name: "model",
          type: "enum",
          enum: ["grok-imagine-image-2.0", "grok-imagine-image", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"],
          default: "grok-imagine-image-2.0",
          description: "Image model.",
        },
        {
          name: "quality",
          type: "enum",
          enum: ["low", "medium", "high", "auto"],
          default: "low",
          description: "grok-imagine-image-2.0: low (default), medium or auto. OpenAI models: low, medium (default), high or auto.",
        },
      ],
      constraints: ["gpt-image-2.5-sunburst and gpt-image-2.5-flare (OpenAI) take low, medium, high or auto."],
    });
    assert.deepEqual(node.params.quality.enum, ["low", "medium", "high", "auto"]);
    assert.ok(node.params.model.enum.includes("gpt-image-2.5-flare"));
    const text = describeNodeType(node);
    assert.match(text, /model \(grok-imagine-image-2\.0\|grok-imagine-image\|gpt-image-2\.5-sunburst\|gpt-image-2\.5-flare/);
    assert.match(text, /quality \(low\|medium\|high\|auto, default low\)/);

    // An enums-only (older) catalogue still gets the local descriptions.
    const old = compactNodeType({ type: "generate_image", label: "Generate image", enums: { quality: ["low", "medium", "auto"] } });
    assert.match(old.params.quality.description, /OpenAI models: low, medium \(default\), high or auto/);
    assert.match(old.params.model.description, /gpt-image-2\.5-sunburst \(precise\)/);
  });

  it("the graph rules explain the OpenAI image models and the fallback", () => {
    const rule = GRAPH_RULES.find((r) => r.includes("gpt-image-2.5-sunburst"));
    assert.ok(rule);
    assert.match(rule, /9:16 is delivered as 2:3/);
    assert.match(rule, /retried once on gpt-image-2\.5-sunburst/);
  });
});
