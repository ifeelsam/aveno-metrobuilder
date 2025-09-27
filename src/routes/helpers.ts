import { CORS_ORIGINS } from "../config";

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  const allowHeaders = req.headers.get("Access-Control-Request-Headers") || "Content-Type, Authorization";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": allowHeaders,
    "Access-Control-Max-Age": "86400",
  };
  if (CORS_ORIGINS === "*") {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin) {
    const allowed = CORS_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
    if (allowed.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Vary"] = "Origin";
    }
  }
  return headers;
}

export function jsonResponse(req: Request, body: any, status = 200): Response {
  const baseHeaders = {
    "Content-Type": "application/json",
    ...getCorsHeaders(req),
  };
  return new Response(JSON.stringify(body), { status, headers: baseHeaders });
}

export function preflightResponse(req: Request): Response {
  return new Response(null, { status: 204, headers: getCorsHeaders(req) });
}
