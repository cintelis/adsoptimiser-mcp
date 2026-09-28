# Changelog

All notable changes to `@cintelisai/adsoptimiser-mcp` are recorded here. Versions follow [semantic versioning](https://semver.org/).

## 0.6.0 (2026-09-28)

### Added

- **Claude can now see what was generated.** Tools attach small preview images to their results, the same as the hosted connector: `include_thumbnails` on `adsoptimiser_get_job`, `adsoptimiser_generate_image` and `adsoptimiser_get_character` (on by default) and on `adsoptimiser_list_jobs` and `adsoptimiser_list_character_assets` (off by default). Previews come from the API's `GET /api/v1/media/thumbnail` at 384 px, at most 1 per job, 5 reference images per character and 6 per list. Each image is at most 600,000 base64 bytes and a result carries at most 1,500,000 in total; anything over is left out and named. The images follow the text as `image` blocks, after a line naming them in order ("Attached N preview image(s) ... in order: ...") and a line listing what was not previewed and why ("Not previewed: ..."). The structured content is unchanged.
- Videos are previewed only when a poster frame is stored; otherwise the reply says so. A character's reference images on another host are not previewed ("external URL"), and nothing is fetched from another host.

### Changed

- A preview that fails (not ready, not found, no poster frame, a scaling failure, a timeout) becomes a note in the text, never a tool error. Only in this package: on a deployment that predates previews (the route answers 403 `token_scope_denied`, or 404 because it does not exist) the reply says once that the deployment doesn't serve previews yet, instead of naming each image.
- The API client has a binary request helper for previews. Like every other API call, it sends the token to the Ads Optimiser API host only.

## 0.5.0 (2026-09-28)

### Added

- `adsoptimiser_list_character_assets`, the same as the hosted connector's `list_character_assets`: everything made with a saved character, newest first (images, videos, talking clips, lip-syncs, voiceovers and captioned clips), with result URLs, the kept speech audio (`speech_url`), the line spoken (`script`), the voice and the pipeline run. Takes `character_id` and optionally `type` (`image`, `video`, `talking`, `lip_sync`, `voiceover` or `captions`), `cursor` (the `next_cursor` of the previous page) and `limit` (1 to 50, default 10), and reports counts per kind. Only in this package: `download_to`, a local folder where the listed finished files are saved (images, videos and the speech mp3s kept with lip-syncs and voiceovers), at most 20 files per call. Files are fetched only from this Ads Optimiser deployment's media, never with the token, are named `<job id>-<script or prompt words>` (`<job id>-speech-...mp3` for speech), and never replace an existing file. Folder paths containing `..` are refused before anything is called. Files over the cap are listed by job so a smaller page can pick them up.
- `adsoptimiser_get_character` now also summarises what was made with the character, as the connector does: counts per kind, the latest 5 items and the latest 3 voice previews. Only in this package: an `audio` list gathers the kept speech and voice preview URLs, and the reply says how to save them locally (speech with `download_to`, a preview with `adsoptimiser_preview_voice` and `save_to`).
- `adsoptimiser_preview_voice` takes an optional `character_id` to file the preview in that character's voice preview history (shown on its page in the app), and returns the `preview_id`.

### Changed

- On a deployment without the Characters hub, `adsoptimiser_get_character` still returns the character (the summary is left out), and `adsoptimiser_list_character_assets` says the deployment predates the hub instead of reporting the character as not found.

## 0.4.0 (2026-09-27)

### Added

- `adsoptimiser_lip_sync`, the same as the hosted connector's `lip_sync`: make the person in a finished clip say a new line in a designed voice (an OpenAI voice with instructions, or an xAI preset; by default the character's own voice), with the mouth re-animated to match by Kling LipSync. Takes `video_job_id` or `video_url`, `script` (at most 900 characters), and optionally `voice`, `character_id` and `model` (`kling-lipsync`, the only model). It is asynchronous: it returns the job id and estimated provider cost at once, so follow it with `adsoptimiser_get_job`. Each lip-sync uses one video generation from the plan allowance and counts toward the daily video quota. Only in this package: `video_path`, a local .mp4 or .mov clip (at most 100 MB) that is checked and uploaded for you. Pass exactly one of `video_job_id`, `video_url` or `video_path`.
- Clear messages for the lip-sync refusals: lip-sync not configured, a source clip Kling cannot use (it needs 2 to 10 seconds at 720p or 1080p), speech that does not fit the clip, speech synthesis failures, a source video that is not ready yet, and a deployment that does not yet allow lip-sync for API tokens.
- Job summaries label lip-sync jobs ("lip-sync video", model "Kling LipSync") and show the voice used, where it came from, the length of the speech and the source job.
- The pipeline node catalogue's local descriptions and graph rules cover the `lip_sync` node (inputs video and script; params script, voice, voice_id and model) and the `character-lip-sync` template, "Character talking clip (designed voice)". A graph whose `lip_sync` node has no script and nothing wired into its script input needs a run prompt.

### Changed

- The graph rules now point talking clips in an OpenAI voice to `lip_sync` instead of `strip_audio` then `add_voiceover`.

### Fixed

- A file of the wrong kind now reads "is an image, but a video is needed" instead of "is a image, but an video is needed".

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
