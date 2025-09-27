import { addOrEditMapping, removeMapping, readPortalMap } from "../services/portalMap";
import { toSubdomain } from "../services/portalMap";
import { jsonResponse, preflightResponse } from "./helpers";
import { log } from "../utils/log";

export async function handleDomains(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return preflightResponse(req);
  try {
    if (req.method === "GET") {
      const map = await readPortalMap();
      const entries = Array.from(map.entries()).map(([publicHost, portalHost]) => ({ publicHost, portalHost, publicUrl: `http://${publicHost}` }));
      return jsonResponse(req, { success: true, domains: entries });
    }

    if (req.method === "POST") {
      const body = await req.json() as any;
      const desiredSubdomain = toSubdomain(body?.subdomain || '');
      const repoFallback = body?.repoName || '';
      const portalHostOrUrl = body?.portal;
      if (!portalHostOrUrl) return jsonResponse(req, { success: false, message: 'portal is required' }, 400);
      const result = await addOrEditMapping({ desiredSubdomain, repoNameFallback: repoFallback, portalHostOrUrl });
      return jsonResponse(req, { success: true, ...result });
    }

    if (req.method === "PATCH") {
      const body = await req.json() as any;
      const publicHost = body?.publicHost;
      const portalHostOrUrl = body?.portal;
      const renameTo = body?.renameToSubdomain;
      if (!publicHost) return jsonResponse(req, { success: false, message: 'publicHost is required' }, 400);
      if (!portalHostOrUrl && !renameTo) return jsonResponse(req, { success: false, message: 'portal or renameToSubdomain required' }, 400);
      const result = await addOrEditMapping({ editExistingPublicHost: publicHost, portalHostOrUrl: portalHostOrUrl || '', renameToSubdomain: renameTo });
      return jsonResponse(req, { success: true, ...result });
    }

    if (req.method === "DELETE") {
      const url = new URL(req.url);
      const target = url.searchParams.get('publicHost') || url.searchParams.get('subdomain');
      if (!target) return jsonResponse(req, { success: false, message: 'publicHost or subdomain is required' }, 400);
      const result = await removeMapping(target);
      return jsonResponse(req, { success: true, ...result });
    }

    return jsonResponse(req, { success: false, message: 'Method not allowed' }, 405);
  } catch (error) {
    log('error', 'Domains route error', { error: error instanceof Error ? error.message : error });
    return jsonResponse(req, { success: false, message: 'Internal server error' }, 500);
  }
}
