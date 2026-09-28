// HTTP client for the Ads Optimiser machine API (/api/v1), the per-host token
// cache, and the mapping from API failures to messages a person can act on.
//
// The token is a bearer credential (`ao_...`). It is read from the cache file
// for each request and never logged, echoed, or returned by any tool.

import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "https://api.adsoptimiser.com.au";
export const DEFAULT_APP_URL = "https://app.adsoptimiser.com.au";

export function normaliseBaseUrl(raw) {
  const value = (raw ?? "").trim() || DEFAULT_BASE_URL;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`ADSOPTIMISER_URL is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`ADSOPTIMISER_URL must be an http(s) URL: ${value}`);
  }
  return value.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

/**
 * One cache file per host, so pointing ADSOPTIMISER_URL at a preview or
 * localhost can never silently reuse (or clobber) the production token.
 */
export function cachePathFor(baseUrl, dir = homedir()) {
  const host = new URL(baseUrl).host.replace(/[^a-z0-9.-]+/gi, "_");
  return join(dir, `.adsoptimiser-mcp-${host}.json`);
}

export class TokenCache {
  constructor(path) {
    this.path = path;
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  save(state) {
    writeFileSync(this.path, JSON.stringify(state, null, 2), { mode: 0o600 });
    // `mode` only applies when the file is created; tighten an existing one
    // too. Windows ignores POSIX modes (the file inherits the profile ACL).
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Best effort only.
    }
  }

  clear() {
    rmSync(this.path, { force: true });
  }

  get token() {
    const token = this.load().token;
    return typeof token === "string" && token ? token : null;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(status, code, message, body = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** A problem with a local file or folder, found before anything was sent. */
export class LocalFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalFileError";
  }
}

/** Codes after which the cached token is useless and must be forgotten. */
const DEAD_TOKEN_CODES = new Set(["token_revoked", "invalid_token"]);

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ApiClient {
  /**
   * @param {{ baseUrl: string, cache: TokenCache, fetchImpl?: typeof fetch, timeoutMs?: number }} options
   */
  constructor({ baseUrl, cache, fetchImpl, timeoutMs = 30_000 }) {
    this.baseUrl = baseUrl;
    this.cache = cache;
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {"GET"|"POST"|"PATCH"|"DELETE"} method
   * @param {string} path
   * @param {{ json?: unknown, form?: FormData, auth?: boolean, timeoutMs?: number }} [options]
   */
  async request(method, path, options = {}) {
    const res = await this.send(method, path, options, "application/json");
    const parsed = parseJsonObject(await res.text().catch(() => ""));
    if (!res.ok) throw this.toError(res.status, parsed, options.auth ?? true);
    return parsed ?? {};
  }

  /**
   * GET a binary answer (a preview image) from this API. The token goes to
   * the API host only, as for request(). Errors are read as JSON like
   * request(). Returns { bytes: Buffer, contentType, headers }.
   *
   * @param {string} path
   * @param {{ timeoutMs?: number }} [options]
   */
  async requestBinary(path, options = {}) {
    const res = await this.send("GET", path, options, "image/*, application/json");
    if (!res.ok) {
      throw this.toError(res.status, parseJsonObject(await res.text().catch(() => "")), true);
    }
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(),
      headers: res.headers,
    };
  }

  /** Map a failed answer to an ApiError, forgetting a dead token. */
  toError(status, parsed, auth) {
    const code =
      (typeof parsed?.code === "string" && parsed.code) ||
      (typeof parsed?.error === "string" && /^[a-z_]+$/.test(parsed.error) && parsed.error) ||
      null;
    const message =
      (typeof parsed?.error_description === "string" && parsed.error_description) ||
      (typeof parsed?.error === "string" && parsed.error) ||
      (typeof parsed?.message === "string" && parsed.message) ||
      `HTTP ${status}`;
    if (auth && status === 401 && DEAD_TOKEN_CODES.has(code)) {
      this.cache.clear();
    }
    return new ApiError(status, code, message, parsed);
  }

  /** Send one request to the API host; network failures become ApiErrors. */
  async send(method, path, options, accept) {
    const { json, form, auth = true } = options;
    const headers = { accept };
    if (auth) {
      const token = this.cache.token;
      if (!token) {
        throw new ApiError(
          401,
          "not_connected",
          `Not connected to Ads Optimiser at ${this.baseUrl}.`
        );
      }
      headers.authorization = `Bearer ${token}`;
    }
    let body;
    if (form !== undefined) {
      body = form; // fetch sets the multipart boundary itself.
    } else if (json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(json);
    }

    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      throw new ApiError(
        0,
        timedOut ? "timeout" : "network_error",
        timedOut
          ? `Ads Optimiser at ${this.baseUrl} did not answer in time.`
          : `Could not reach Ads Optimiser at ${this.baseUrl}: ${err?.cause?.code ?? err?.message ?? String(err)}.`
      );
    }
  }
}

/** A JSON object body, else null (non-JSON answers from proxies, hard 500s). */
function parseJsonObject(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

export function toolText(message, { isError = false, structured } = {}) {
  return {
    content: [{ type: "text", text: message }],
    ...(structured ? { structuredContent: structured } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

/** One sentence per failure mode, each ending in what to do next. */
export function describeError(err, config) {
  if (err instanceof LocalFileError) return err.message;
  if (!(err instanceof ApiError)) {
    return `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const billingUrl = `${config.appUrl}/#/billing`;

  if (err.code === "openai_voices_not_configured") {
    return `OpenAI voices are not available on this Ads Optimiser deployment (${err.message}). Use an xAI preset voice instead, for example { "provider": "xai", "voice_id": "eve" } (see adsoptimiser_list_voices).`;
  }
  if (err.code === "not_connected") {
    return `${err.message} Call adsoptimiser_connect to sign in.`;
  }
  if (err.status === 0) {
    return `${err.message} Check your internet connection${
      config.baseUrl === DEFAULT_BASE_URL ? "" : " and ADSOPTIMISER_URL"
    }, then try again.`;
  }
  if (err.status === 429) {
    if (err.code === "plan_limit_exceeded") {
      return `Plan limit reached: ${err.message} To keep generating, upgrade your plan in Billing: ${billingUrl}`;
    }
    if (err.code === "video_daily_quota_exceeded") {
      return `Daily video quota reached: ${err.message} The quota resets at midnight UTC.`;
    }
    const retry = err.body?.retry_after_seconds;
    return `Too many requests right now.${
      typeof retry === "number" ? ` Try again in ${retry} seconds.` : " Wait a minute and retry."
    }`;
  }
  if (err.status === 401) {
    if (DEAD_TOKEN_CODES.has(err.code)) {
      return "This machine's Ads Optimiser token is no longer valid (it may have been revoked in the app under Profile > API tokens). It has been removed from this machine; call adsoptimiser_connect to reconnect.";
    }
    return `Ads Optimiser did not accept the request (${err.message}). Call adsoptimiser_connect to sign in again.`;
  }
  if (err.status === 403) {
    switch (err.code) {
      case "workspace_access_revoked":
        return "You no longer have access to the workspace this connection was approved for. Call adsoptimiser_disconnect, then adsoptimiser_connect and choose a workspace you belong to.";
      case "workspace_forbidden":
        return `Your role in this workspace does not allow generating (viewers cannot): ${err.message} Ask a workspace admin to make you a member, or reconnect to another workspace.`;
      case "connect_required":
        return `This workspace must connect a TikTok account before generating. Connect one at ${config.appUrl}/#/connect`;
      case "token_scope_denied":
        return `This Ads Optimiser deployment does not allow that with an API token (${err.message}). It may predate this version of the package.`;
      default:
        return `Not allowed: ${err.message}`;
    }
  }
  if (err.status === 404) return `Not found: ${err.message}`;
  if (err.status === 413) return `Too large: ${err.message}`;
  if ([400, 409, 415, 422].includes(err.status)) {
    const errors = validationErrors(err);
    const list = errors.map((e) => `\n- ${e}`).join("");
    return `The request was rejected: ${err.message}${list}`;
  }
  return `Ads Optimiser returned an error (HTTP ${err.status}): ${err.message}. Try again shortly.`;
}

/** The string errors a 400/422 answer lists (for example voice or character validation). */
function validationErrors(err) {
  return Array.isArray(err.body?.errors) ? err.body.errors.filter((e) => typeof e === "string") : [];
}

export function toToolError(err, config) {
  const structured =
    err instanceof ApiError ? { status: err.status, code: err.code, message: err.message } : undefined;
  if (structured && validationErrors(err).length) structured.errors = validationErrors(err);
  if (err instanceof ApiError && err.code === "plan_limit_exceeded") {
    structured.upgrade_url = `${config.appUrl}/#/billing`;
  }
  return toolText(describeError(err, config), { isError: true, structured });
}

/** True for failures that should stop a batch rather than skip one item. */
export function isStopError(err) {
  if (!(err instanceof ApiError)) return false;
  return err.status === 0 || err.status === 401 || err.status === 403 || err.status === 429 || err.status >= 500;
}
