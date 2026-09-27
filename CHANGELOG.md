# Changelog

All notable changes to `@cintelisai/adsoptimiser-mcp` are recorded here. Versions follow [semantic versioning](https://semver.org/).

## 0.3.0 (2026-09-27)

### Added

- Character and voice tools, the same as the hosted connector's:
  - `adsoptimiser_list_characters` and `adsoptimiser_get_character`: saved characters (consistent AI people such as influencers or brand ambassadors) with their reference images, description, style and voice.
  - `adsoptimiser_create_character` and `adsoptimiser_update_character`: save a character from 1 to 5 images, with an optional voice (`{ provider: "xai", voice_id }` or `{ provider: "openai", voice, instructions?, xai_voice_id? }`, or the `default_voice_id` shorthand; `null` clears it). As well as `image_urls` and `job_ids`, both accept `image_paths`: local images that are checked and uploaded for you, 5 images in total across all three. Characters cannot be deleted with a token; delete them in the app.
  - `adsoptimiser_list_voices`: xAI preset voices and OpenAI gpt-4o-mini-tts voices, and whether OpenAI voices are configured.
  - `adsoptimiser_preview_voice`: a short sample (at most 300 characters) in any voice, with no job and no allowance. Only in this package: `save_to` also saves the mp3 to a local folder so you can play it, with the same folder checks and no-overwrite naming as `adsoptimiser_download_job`.
- `character_id` on `adsoptimiser_generate_image`, `adsoptimiser_generate_video` and `adsoptimiser_run_pipeline`, and `script` (the exact words spoken to camera) on `adsoptimiser_generate_video`. A character or script with no source image defaults to Grok Video 1.5, which serves reference-to-video. With `character_id`, `adsoptimiser_generate_image` takes at most 4 other reference images.
- Job summaries include a `Voice:` note when a talking video could not speak a character's OpenAI voice and fell back to an xAI preset.
- `adsoptimiser_list_pipelines` marks templates that need a `character_id`.
- The node catalogue from `adsoptimiser_get_pipeline_nodes` carries the new `character` and `add_captions` nodes and the add_voiceover `voice` param with its accepted shapes, and the graph rules explain characters, captions and voice precedence.
- Clearer errors: a rejected request lists the API's validation errors, and an OpenAI voice on a deployment without OpenAI says to use an xAI preset instead.

### Fixed

- `adsoptimiser_get_pipeline_nodes` read the catalogue's params as an object, but current deployments send an array, so params were listed by position instead of by name. Both shapes now work, and the local descriptions only fill in what the API leaves out.

## 0.2.0 (2026-09-27)

### Fixed

- **Starts in time in Claude Desktop on Windows.** 0.1.0 depended on the MCP SDK, whose ~90 dependency packages `npx` resolved and installed on every launch. That took over 30 seconds, longer than Claude Desktop's start-up limit, so the server was dropped before it answered. The package is now a single self-contained file, `dist/server.mjs`, bundled with esbuild: installing it adds one package and nothing else, and in testing it answered `tools/list` in about a tenth of a second.

### Added

- Pipeline builder tools, the same as the hosted connector's:
  - `adsoptimiser_get_pipeline_nodes`: the node catalogue (inputs, outputs, params with allowed values and ranges, rules), the graph rules and a worked example.
  - `adsoptimiser_get_pipeline`: a saved pipeline's graph, node count and estimated cost per run.
  - `adsoptimiser_validate_pipeline`: errors by node id, node count, estimated cost per run and whether a run prompt is needed. Uses no allowance.
  - `adsoptimiser_save_pipeline`: save a new pipeline (`POST /pipelines/graphs`) or update one by `graph_id` (`PATCH /pipelines/graphs/:graph_id`), with a link to the pipeline editor.
- `adsoptimiser_run_pipeline` accepts an inline `graph` as well as `template_id` or `graph_id` (exactly one). Inline graphs are validated first and not run if invalid, and the reply gives the step count and estimated cost.
- Local image paths in `input_image` nodes (`image_url` or `image_path`) are checked, uploaded and replaced with their hosted URL before a graph is validated, saved or run. Each file is uploaded once per session.
- A clear message when the Ads Optimiser deployment does not yet allow pipeline building with API tokens.
- README: Windows and Claude Desktop troubleshooting, including running a global install with `node` instead of `npx`.
- `dist/THIRD-PARTY-NOTICES.txt` with the licences of the bundled packages.

### Changed

- The `bin` is now `dist/server.mjs`. `@modelcontextprotocol/sdk` and `zod` are build-time dependencies only.
- CI tests Node 18.17, 18, 20 and 22 (and 22 on Windows), and installs the packed tarball on its own to check it starts with no other packages.

## 0.1.0 (2026-09-27)

First release.

- Device-flow sign-in (`adsoptimiser_connect`, `adsoptimiser_finish_connect`), with a generate-only, workspace-scoped token cached per host in the home directory; `adsoptimiser_status` and `adsoptimiser_disconnect`.
- The hosted connector's generate tools: list models, enhance a prompt, generate images and videos, get and list jobs, list and run pipelines, get a pipeline run.
- Local file tools: `adsoptimiser_upload_file`, local reference and source images for generation, `adsoptimiser_download_job` and `adsoptimiser_batch_generate`.
