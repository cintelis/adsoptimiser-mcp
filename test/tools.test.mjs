import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOL_ROUTES } from "../src/server.mjs";
import { TOKEN, startClient, startStub } from "./helpers.mjs";

const READY_IMAGE = {
  job_id: "job_img",
  asset_type: "image",
  status: "ready",
  model: "grok-imagine-image-2.0",
  prompt: "A red sneaker",
  storage_uri: "images/job_img.png",
};

/** A small fake of the API: enough state for every tool to succeed. */
function fakeApi(r) {
  const route = `${r.method} ${r.path}`;
  if (route === "GET /api/v1/me") {
    return { json: { user_email: "p@example.com", workspace_id: "ws_1", workspace_name: "Acme", role: "owner" } };
  }
  if (route === "GET /api/v1/models") {
    return {
      json: {
        models: [
          { id: "grok-imagine-image-2.0", display_name: "Grok Image 2.0", asset_type: "image", default: true, modes: ["text"], resolutions: ["1k"], indicative_cost: "$" },
          { id: "grok-imagine-video", display_name: "Grok Video", asset_type: "video", modes: ["text", "image"], resolutions: ["720p"], indicative_cost: "$$" },
        ],
      },
    };
  }
  if (route === "POST /api/v1/jobs/enhance-prompt") return { json: { enhanced: "A detailed prompt" } };
  if (route === "POST /api/v1/jobs") {
    const body = JSON.parse(r.body.toString());
    return {
      status: 201,
      json: { job_id: body.asset_type === "image" ? "job_new_img" : "job_new_vid", asset_type: body.asset_type, status: "queued", model: body.model, prompt: body.prompt },
    };
  }
  if (route === "GET /api/v1/jobs/job_new_img") return { json: { ...READY_IMAGE, job_id: "job_new_img" } };
  if (route === "GET /api/v1/jobs/job_img") return { json: READY_IMAGE };
  if (route === "GET /api/v1/jobs") return { json: { jobs: [READY_IMAGE], total: 1 } };
  if (route === "GET /api/v1/pipelines/templates") {
    return { json: { templates: [{ id: "product-ad", name: "Product ad", description: "d", stages: ["image", "video"] }] } };
  }
  if (route === "GET /api/v1/pipelines/graphs") return { json: { graphs: [] } };
  if (route === "POST /api/v1/pipelines") {
    return { json: { run: { run_id: "run_1", status: "running" }, stages: [{ stage_type: "image" }], estimated_cost_usd: 0.12 } };
  }
  if (route === "GET /api/v1/pipelines/run_1") {
    return { json: { run: { run_id: "run_1", status: "done" }, stages: [{ stage_type: "image", status: "done", job_id: "job_img", output: { storage_uri: "images/job_img.png" } }] } };
  }
  return undefined;
}

/** Normalise a recorded request to the TOOL_ROUTES notation. */
function routeOf(r) {
  const path = r.path
    .replace(/^\/api\/v1\/jobs\/(?!enhance-prompt$|source-media$)[^/]+$/, "/api/v1/jobs/:id")
    .replace(/^\/api\/v1\/pipelines\/(?!templates$|graphs$)[^/]+$/, "/api/v1/pipelines/:run_id");
  return `${r.method} ${path}`;
}

describe("generate and inspect tools", () => {
  let stub;
  let ctx;
  before(async () => {
    stub = await startStub(fakeApi);
  });
  after(async () => {
    await stub.close();
  });
  afterEach(async () => {
    await ctx?.close();
    stub.requests.length = 0;
    stub.setHandler(fakeApi);
  });

  const calls = [
    ["adsoptimiser_status", {}],
    ["adsoptimiser_list_models", { asset_type: "image" }],
    ["adsoptimiser_enhance_prompt", { prompt: "shoe ad" }],
    ["adsoptimiser_generate_image", { prompt: "A red sneaker" }],
    ["adsoptimiser_generate_video", { prompt: "Sneaker spins" }],
    ["adsoptimiser_get_job", { job_id: "job_img" }],
    ["adsoptimiser_list_jobs", { status: "ready", limit: 5 }],
    ["adsoptimiser_list_pipelines", {}],
    ["adsoptimiser_run_pipeline", { template_id: "product-ad", prompt: "Sneakers" }],
    ["adsoptimiser_get_pipeline_run", { run_id: "run_1" }],
  ];

  for (const [name, args] of calls) {
    it(`${name} calls only its documented routes, with the bearer token`, async () => {
      ctx = await startClient(stub.url);
      ctx.connectToken();
      const res = await ctx.call(name, args);
      assert.equal(res.isError, false, res.text);
      assert.ok(stub.requests.length > 0);
      for (const r of stub.requests) {
        assert.ok(TOOL_ROUTES[name].includes(routeOf(r)), `${name} called ${routeOf(r)}`);
        assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
      }
      assert.ok(!res.text.includes(TOKEN));
    });
  }

  it("generate_image sends the connector's request shape and waits for the result", async () => {
    ctx = await startClient(stub.url);
    ctx.connectToken();
    const res = await ctx.call("adsoptimiser_generate_image", {
      prompt: "A red sneaker",
      aspect_ratio: "9:16",
      quality: "low",
      reference_job_ids: ["job_img"],
    });
    assert.equal(res.isError, false, res.text);
    const post = stub.requests.find((r) => r.method === "POST");
    assert.deepEqual(JSON.parse(post.body.toString()), {
      asset_type: "image",
      prompt: "A red sneaker",
      model: "grok-imagine-image-2.0",
      generation_params: {
        aspect_ratio: "9:16",
        quality: "low",
        image_urls: [`${stub.url}/media/${encodeURIComponent("images/job_img.png")}`],
      },
    });
    assert.equal(res.structured.status, "ready");
    assert.equal(res.structured.media_url, `${stub.url}/media/images%2Fjob_img.png`);
    assert.equal(res.structured.app_url, "https://app.example.test/#/jobs/job_new_img");
    assert.deepEqual(ctx.sleeps, [3000]);
  });

  it("generate_image with wait false returns at once", async () => {
    ctx = await startClient(stub.url);
    ctx.connectToken();
    const res = await ctx.call("adsoptimiser_generate_image", { prompt: "x", wait: false });
    assert.match(res.text, /Still generating/);
    assert.equal(stub.requests.length, 1);
  });

  it("generate_video defaults to 9:16 and passes voices as reference audios", async () => {
    ctx = await startClient(stub.url);
    ctx.connectToken();
    await ctx.call("adsoptimiser_generate_video", {
      prompt: "Say <AUDIO_0>",
      voice_ids: ["ara"],
      source_image_url: "https://cdn.example.com/a.png",
    });
    const body = JSON.parse(stub.requests[0].body.toString());
    assert.deepEqual(body, {
      asset_type: "video",
      prompt: "Say <AUDIO_0>",
      model: "grok-imagine-video",
      generation_params: {
        aspect_ratio: "9:16",
        image_url: "https://cdn.example.com/a.png",
        reference_audios: [{ voice_id: "ara" }],
      },
    });
  });

  it("rejects conflicting inputs before calling the API", async () => {
    ctx = await startClient(stub.url);
    ctx.connectToken();
    const video = await ctx.call("adsoptimiser_generate_video", {
      prompt: "x",
      source_image_url: "https://cdn.example.com/a.png",
      source_job_id: "job_img",
    });
    assert.equal(video.isError, true);
    const pipeline = await ctx.call("adsoptimiser_run_pipeline", {});
    assert.equal(pipeline.isError, true);
    const refs = await ctx.call("adsoptimiser_generate_image", {
      prompt: "x",
      reference_image_urls: ["https://a.example/1.png", "https://a.example/2.png", "https://a.example/3.png"],
      reference_job_ids: ["a", "b", "c"],
    });
    assert.equal(refs.isError, true);
    assert.match(refs.text, /At most 5/);
    assert.equal(stub.requests.length, 0);
  });

  const errorCases = [
    [
      "plan limit",
      { status: 429, json: { error: "You have used all 20 generations this month.", code: "plan_limit_exceeded" } },
      /Plan limit reached: You have used all 20.*upgrade your plan in Billing: https:\/\/app.example.test\/#\/billing/,
    ],
    [
      "daily video quota",
      { status: 429, json: { error: "Daily video generation quota reached.", code: "video_daily_quota_exceeded" } },
      /Daily video quota reached/,
    ],
    [
      "rate limit",
      { status: 429, json: { error: "Rate limit", code: "rate_limited", retry_after_seconds: 42 } },
      /Try again in 42 seconds/,
    ],
    ["validation", { status: 400, json: { error: "duration must be between 1 and 15" } }, /rejected: duration must be/],
    ["not found", { status: 404, json: { error: "Job not found" } }, /Not found: Job not found/],
    [
      "TikTok not connected",
      { status: 403, json: { error: "Connect TikTok first", code: "connect_required" } },
      /connect one at https:\/\/app.example.test\/#\/connect/i,
    ],
    [
      "workspace access revoked",
      { status: 403, json: { error: "gone", code: "workspace_access_revoked" } },
      /adsoptimiser_disconnect, then adsoptimiser_connect/,
    ],
    ["server error", { status: 502, json: { error: "upstream down" } }, /HTTP 502\): upstream down\. Try again shortly/],
    ["non-JSON error", { status: 500, body: "<html>oops</html>" }, /HTTP 500\): HTTP 500/],
  ];
  for (const [label, reply, pattern] of errorCases) {
    it(`maps ${label} to an actionable message`, async () => {
      stub.setHandler(() => reply);
      ctx = await startClient(stub.url);
      ctx.connectToken();
      const res = await ctx.call("adsoptimiser_generate_video", { prompt: "x" });
      assert.equal(res.isError, true);
      assert.match(res.text, pattern);
      if (reply.json?.code === "plan_limit_exceeded") {
        assert.equal(res.structured.upgrade_url, "https://app.example.test/#/billing");
      }
    });
  }

  it("maps network failures to a connection message", async () => {
    ctx = await startClient("http://127.0.0.1:9");
    ctx.connectToken();
    const res = await ctx.call("adsoptimiser_list_jobs");
    assert.equal(res.isError, true);
    assert.match(res.text, /Could not reach Ads Optimiser at http:\/\/127.0.0.1:9/);
    assert.match(res.text, /ADSOPTIMISER_URL/);
  });
});
