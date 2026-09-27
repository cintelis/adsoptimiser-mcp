# Ads Optimiser MCP server

Connects Claude (Desktop, Code, or any MCP client) to [Ads Optimiser](https://adsoptimiser.com.au) so you can generate TikTok ad images and videos from a chat, using files on your own computer.

**Sign-in is SSO, not keys.** The first connection starts an OAuth device flow (RFC 8628): Claude shows you a URL and a short code, you approve in a browser where you are already signed in to Ads Optimiser, and a workspace-scoped token is delivered back automatically. Nothing is typed, pasted, or stored in any config file.

## Setup

Requires Node.js 18.17 or later. The package is a single self-contained file with no dependencies, so `npx` has one small download to make and starts in well under Claude Desktop's start-up limit.

### Claude Desktop

Add to `claude_desktop_config.json` (Settings > Developer > Edit Config), then restart Claude Desktop from the system tray:

```json
{
  "mcpServers": {
    "adsoptimiser": {
      "command": "npx",
      "args": ["-y", "@cintelisai/adsoptimiser-mcp@latest"]
    }
  }
}
```

On Windows, if `npx` fails to launch, use `"command": "cmd", "args": ["/c", "npx", "-y", "@cintelisai/adsoptimiser-mcp@latest"]`.

#### Troubleshooting on Windows

If Ads Optimiser does not appear in Claude Desktop, or shows as failed:

1. Check the server log at `%LOCALAPPDATA%\Claude\Logs\mcp-server-adsoptimiser.log`. The Microsoft Store version of Claude Desktop logs there; other installs log to `%APPDATA%\Claude\logs`. Claude Desktop gives a server about 30 seconds to answer, so a log that ends with the transport closing shortly after `initialize` means the server started too slowly.
2. Version 0.2.0 and later start in well under a second once downloaded. If you are on an older version, `@latest` in the config picks up the fix on the next restart.
3. To take `npx` out of the picture entirely, install the package once and point Claude Desktop at it with `node`:

   ```
   npm install -g @cintelisai/adsoptimiser-mcp
   npm root -g
   ```

   `npm root -g` prints the global folder, for example `C:\Users\you\AppData\Roaming\npm\node_modules`. Then use:

   ```json
   {
     "mcpServers": {
       "adsoptimiser": {
         "command": "node",
         "args": ["C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@cintelisai\\adsoptimiser-mcp\\dist\\server.mjs"]
       }
     }
   }
   ```

   A global install does not update itself: run `npm install -g @cintelisai/adsoptimiser-mcp` again to upgrade.

### Claude Code

```
claude mcp add adsoptimiser -- npx -y @cintelisai/adsoptimiser-mcp@latest
```

The `@latest` tag makes `npx` check for updates on each launch, so you never stay stuck on an old cached copy.

## Connecting

In any chat: *"connect to Ads Optimiser"*. Claude will call `adsoptimiser_connect` and give you a URL and code.

1. Open the URL and sign in to Ads Optimiser if asked.
2. **Check the code on the page matches** the one Claude showed you. If it does not, do not approve.
3. **Choose the workspace** this connection should use, then approve. The token only works in that workspace; to use another one later, disconnect and connect again. You need to be a member (not a viewer) of the workspace.
4. Tell Claude you've approved; it calls `adsoptimiser_finish_connect` and you're connected.

## Tools

| Tool | What it does |
| --- | --- |
| `adsoptimiser_connect` | Start the SSO device flow |
| `adsoptimiser_finish_connect` | Collect the token after you approve |
| `adsoptimiser_status` | Show the connected user, workspace and role |
| `adsoptimiser_disconnect` | Revoke the token on the server and delete it from this machine |
| `adsoptimiser_list_models` | List image and video models, their options and indicative cost |
| `adsoptimiser_enhance_prompt` | Expand a rough idea into a detailed ad prompt (uses no allowance) |
| `adsoptimiser_generate_image` | Generate an image; accepts local reference images (`reference_image_paths`), URLs or earlier jobs |
| `adsoptimiser_generate_video` | Start a video; text-to-video, or image-to-video from a local image (`source_image_path`), URL or earlier job |
| `adsoptimiser_get_job` | Status and result URL of one job |
| `adsoptimiser_list_jobs` | Recent jobs, filterable by status and type |
| `adsoptimiser_list_pipelines` | Pipeline templates and saved pipelines |
| `adsoptimiser_get_pipeline_nodes` | The pipeline node catalogue: node types, inputs, outputs, params, graph rules and an example |
| `adsoptimiser_get_pipeline` | A saved pipeline's graph, node count and estimated cost per run |
| `adsoptimiser_validate_pipeline` | Check a pipeline graph: errors by node, node count, estimated cost, whether it needs a prompt (uses no allowance) |
| `adsoptimiser_save_pipeline` | Save a pipeline graph to the workspace, or update a saved one by `graph_id`, and link to the pipeline editor |
| `adsoptimiser_run_pipeline` | Start a pipeline run from a template, a saved pipeline or an inline graph |
| `adsoptimiser_get_pipeline_run` | Status and results of each pipeline step |
| `adsoptimiser_upload_file` | Upload a local image or video and get its hosted URL (uses no allowance) |
| `adsoptimiser_download_job` | Save a finished job's image or video to a local folder |
| `adsoptimiser_batch_generate` | One job per image in a folder (image-to-video or image edit) or per line of a prompts file, up to 10 per call |

Every generation uses your workspace's monthly plan allowance, exactly as in the app. When the allowance runs out, the tools say so and link to **Billing** (`https://app.adsoptimiser.com.au/#/billing`) where you can upgrade. Videos also count toward a daily video quota.

### Building pipelines

A pipeline is a small graph of steps (up to 12 nodes): for example refine a prompt, generate an image, then animate it into a video. Ask Claude to design one, for example *"build a pipeline that turns my product photo into three 9:16 videos with different voices"*. Claude reads the node catalogue with `adsoptimiser_get_pipeline_nodes`, checks its graph with `adsoptimiser_validate_pipeline` (which reports problems by node, the estimated cost per run and whether a prompt is needed), then saves it with `adsoptimiser_save_pipeline` or runs it directly with `adsoptimiser_run_pipeline`. Saved pipelines open in the app's pipeline editor at `https://app.adsoptimiser.com.au/#/pipeline-editor`.

Where a graph needs one of your own images (an `input_image` node), give its local path as the node's `image_url` (or `image_path`). The file is checked and uploaded, and the hosted URL is put in its place before the graph is validated, saved or run.

Validating and saving use no allowance. Running does: each generation step uses allowance like a single job. Pipeline building needs an Ads Optimiser deployment that allows it for API tokens; on an older one these tools say so and templates and saved pipelines still run.

### Working with local files

- **Use absolute paths.** Claude Desktop starts servers in its own folder, so relative paths may not point where you expect. Paths starting with `~` expand to your home folder.
- **Uploads:** images must be PNG, JPEG, WebP or GIF, up to 10 MB (HEIC and TIFF need converting to JPEG or PNG first). Videos must be MP4 or MOV, up to 120 MB. Files are checked on your machine before anything is sent.
- **Downloads** go to `./adsoptimiser-output` by default (or your home folder's `adsoptimiser-output` when the server was started in a system folder). Files are named `<job id>-<prompt words>.<ext>`. An existing file is never replaced unless you ask for `overwrite`; a numbered name such as `-2` is used instead. Folder paths containing `..` are refused.
- **Batches** stop at the first plan limit, daily quota or rate limit and report which jobs were queued and the `offset` to resume from once you are ready. The API allows about 8 generation requests a minute per person, so a full batch of 10 may need a second call.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `ADSOPTIMISER_URL` | `https://api.adsoptimiser.com.au` | The Ads Optimiser API to talk to |
| `ADSOPTIMISER_APP_URL` | `https://app.adsoptimiser.com.au` | The web app used in links (Billing, job pages) |
| `ADSOPTIMISER_OUTPUT_DIR` | `./adsoptimiser-output` | Default folder for `adsoptimiser_download_job` |

Set them in the MCP config entry, for example to target another deployment or choose where downloads land:

```json
"adsoptimiser": {
  "command": "npx",
  "args": ["-y", "@cintelisai/adsoptimiser-mcp@latest"],
  "env": {
    "ADSOPTIMISER_URL": "https://your-deployment.example.com",
    "ADSOPTIMISER_OUTPUT_DIR": "/Users/you/Documents/Ad creatives"
  }
}
```

## Hosted connector or this package?

Ads Optimiser also has a hosted connector at `https://mcp.adsoptimiser.com.au/mcp`. Add it in claude.ai under Settings > Connectors > Add custom connector, and it works in Claude on the web, mobile and desktop with nothing to install. It has the same generate tools, but it runs in the cloud, so it cannot read or write files on your computer.

Use **this package** when you want Claude to work with local files: upload product shots from a folder, turn a folder of images into videos, run a list of prompts from a file, or save finished creatives to disk. You can use both; they are separate connections, each with its own token.

## Security notes

- The token is cached in one file per host in your home folder (`~/.adsoptimiser-mcp-<host>.json`, mode 0600). On Windows the mode is not enforced; the file inherits your user profile's permissions, which by default only you and administrators can read. The token never appears in any config file, log or chat, and tools never return it.
- The token is **generate-only**: it can generate and view creatives and pipelines in the one workspace you chose, and upload source media. The API refuses it for publishing, scheduling, ads and campaigns, deleting, billing, workspace settings and admin.
- Tokens are per machine and individually revocable: each appears in the app under **Profile > API tokens**, where you can revoke it. `adsoptimiser_disconnect` revokes it on the server and deletes the local copy. If a token is revoked elsewhere, the next tool call deletes the local copy and asks you to reconnect; if you lose access to the workspace, the tools tell you to reconnect to another one.
- Uploaded files are stored by Ads Optimiser under unguessable URLs so the generation models can read them. Do not upload anything you would not put in an ad.
- Media downloads fetch the public media URL directly; the token is not sent with them.

## Releasing

Publishing is automated by `.github/workflows/publish.yml`, which runs the tests and publishes to npm with provenance when a version tag is pushed.

1. Add the release to `CHANGELOG.md`, then bump the version: `npm version patch` (or `minor` / `major`), which updates `package.json` and creates a `vX.Y.Z` commit and tag. Or edit `package.json`, commit, and run `git tag vX.Y.Z`.
2. Push the commit and the tag: `git push && git push origin vX.Y.Z`.

The workflow fails if the tag does not match `package.json`, and skips publishing (with a notice) if that version is already on npm, so re-running a tag is safe. It needs an `NPM_TOKEN` repository secret: a granular npm automation token with publish rights on the `@cintelisai` scope.

## Development

```
npm install
npm test
```

The published bin is `dist/server.mjs`, a single ES module bundled by esbuild (`npm run build`, `scripts/build.mjs`) with the MCP SDK and zod inside it, so the package has no runtime dependencies. `npm test` builds it first; `npm pack` and `npm publish` rebuild it. The licences of the bundled packages ship in `dist/THIRD-PARTY-NOTICES.txt`.

- `npm start` runs the unbundled source (`server.mjs`); `npm run start:dist` runs the bundle.
- `npm run smoke` starts the bundle over stdio and times `initialize` and `tools/list`.

Tests use `node --test` against a local stub of the API; they need no network access or account. The bundle tests copy `dist/server.mjs` into an empty folder and drive it over stdio, to prove it runs with no `node_modules`.

## Licence

MIT © Cintelis Pty Limited
