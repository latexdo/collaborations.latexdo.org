import type { Env, RequestIdentity } from "./types";

const defaultSessionPrefix = "session";
const defaultClientPrefix = "client";

function safeHeaderValue(value: string | null, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed && trimmed.length <= 256 ? trimmed : fallback;
}

function fallbackId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function identityFromRequest(request: Request): RequestIdentity {
  const url = new URL(request.url);
  return {
    sessionId: safeHeaderValue(
      request.headers.get("x-latexdo-session") ?? url.searchParams.get("session"),
      fallbackId(defaultSessionPrefix),
    ),
    clientId: safeHeaderValue(
      request.headers.get("x-latexdo-client") ?? url.searchParams.get("clientId"),
      fallbackId(defaultClientPrefix),
    ),
    clientName: safeHeaderValue(
      request.headers.get("x-latexdo-client-name") ?? url.searchParams.get("name"),
      "LatexDo collaborator",
    ).slice(0, 80),
    shareToken:
      request.headers.get("x-latexdo-share-token")?.trim() ||
      url.searchParams.get("share")?.trim() ||
      url.searchParams.get("token")?.trim() ||
      undefined,
  };
}

export function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("origin") ?? "";
  const configuredOrigins = (env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowAny = configuredOrigins.includes("*");
  const allowOrigin = allowAny || !origin || configuredOrigins.includes(origin)
    ? origin || "*"
    : configuredOrigins[0] || "*";

  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers":
      "content-type,x-latexdo-session,x-latexdo-client,x-latexdo-client-name,x-latexdo-share-token",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}
