#!/usr/bin/env node
// MCP server for Ads Optimiser (https://adsoptimiser.com.au).
//
// Bridges Claude (Desktop, Code, or any MCP client) to the versioned machine
// API (/api/v1). Authentication is the OAuth device flow (RFC 8628): the
// connect tool hands the person a URL and a short code, they approve in a
// browser where they are already signed in and choose the workspace there,
// and the bearer token comes back over the polling channel. No credential is
// ever typed or pasted.
//
// The token is workspace-scoped AT APPROVAL and generate-only: the API lets
// it generate and view creatives and pipelines, and nothing else.
//
// Deliberately dependency-light: the MCP SDK, zod (its schema language), and
// global fetch. State is one JSON file per host in the home directory holding
// the token and, briefly, a pending device authorisation.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./src/server.mjs";

try {
  const { server } = createServer();
  await server.connect(new StdioServerTransport());
} catch (err) {
  // stdout belongs to the protocol; diagnostics go to stderr.
  console.error(`adsoptimiser-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
