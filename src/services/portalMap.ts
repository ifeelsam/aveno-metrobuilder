import * as fs from "fs/promises";
import { dirname } from "path";
import { DOMAIN_BASE, PORTAL_MAP_PATH } from "../config";
import { reloadNginx } from "./nginx";

export async function ensureDirExistsForFile(filePath: string): Promise<void> {
  try {
    await fs.mkdir(dirname(filePath), { recursive: true });
  } catch {}
}

export function toSubdomain(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$|\./g, "");
}

const UNIQUE_SUFFIX_WORDS: string[] = [
  "amber","aqua","azure","blush","charcoal","crimson","cyan","denim","ember","fern",
  "flint","gold","honey","indigo","ivory","jade","lemon","linen","magenta","mint",
  "navy","olive","onyx","pearl","peach","plum","rose","ruby","saffron","sage",
  "salmon","sand","scarlet","sea","slate","smoke","snow","steel","stone","teal"
];

export function buildPublicHostFromSubdomain(subdomain: string): string {
  return `${subdomain}.${DOMAIN_BASE}`;
}

export function normalizePortalHost(hostOrUrl: string): string {
  let hostname = hostOrUrl.trim();
  if (/^https?:\/\//i.test(hostname)) {
    const u = new URL(hostname);
    hostname = u.hostname;
    if (u.port && u.port !== "3000") {
      throw new Error(`Unexpected portal URL port: ${u.port}`);
    }
  }
  hostname = hostname.replace(/;$/,'');
  if (!hostname.endsWith('.localhost')) {
    throw new Error(`Portal host must end with .localhost: ${hostname}`);
  }
  return hostname;
}

export async function readPortalMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const content = await fs.readFile(PORTAL_MAP_PATH).then(b => b.toString('utf8')).catch(() => '');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([^\s]+)\s+([^\s;]+);?$/);
    if (m) {
      const publicHost = m[1];
      const portalHost = m[2];
      map.set(publicHost, portalHost);
    }
  }
  return map;
}

export async function writePortalMapFromMap(mapObj: Map<string, string>): Promise<void> {
  const lines: string[] = [];
  for (const [publicHost, portalHost] of mapObj.entries()) {
    lines.push(`${publicHost} ${portalHost};`);
  }
  const updated = lines.join('\n') + (lines.length ? '\n' : '');
  await ensureDirExistsForFile(PORTAL_MAP_PATH);
  const tmpPath = `${PORTAL_MAP_PATH}.tmp-${Date.now()}`;
  await fs.writeFile(tmpPath, updated, { encoding: 'utf8' });
  await fs.rename(tmpPath, PORTAL_MAP_PATH);
}

export function generateUniqueSubdomain(baseSubdomain: string, existingHosts: Set<string>): string {
  let candidate = baseSubdomain;
  let attempt = 0;
  const now = Date.now();
  while (true) {
    const full = buildPublicHostFromSubdomain(candidate);
    if (!existingHosts.has(full)) return candidate;
    const word = UNIQUE_SUFFIX_WORDS[(attempt + now) % UNIQUE_SUFFIX_WORDS.length];
    candidate = `${baseSubdomain}-${word}`;
    if (attempt > UNIQUE_SUFFIX_WORDS.length) {
      candidate = `${baseSubdomain}-${word}-${(attempt - UNIQUE_SUFFIX_WORDS.length)}`;
    }
    attempt++;
  }
}

export async function addOrEditMapping(params: {
  desiredSubdomain?: string;
  repoNameFallback?: string;
  portalHostOrUrl: string;
  editExistingPublicHost?: string;
  renameToSubdomain?: string;
}): Promise<{ publicHost: string; portalHost: string; publicUrl: string; action: 'created' | 'updated' | 'renamed' }>{
  const portalHost = normalizePortalHost(params.portalHostOrUrl);
  const currentMap = await readPortalMap();
  const existingHosts = new Set(currentMap.keys());

  if (params.editExistingPublicHost) {
    const existing = currentMap.get(params.editExistingPublicHost);
    if (!existing) throw new Error(`Public host not found: ${params.editExistingPublicHost}`);

    let action: 'updated' | 'renamed' = 'updated';
    let targetPublicHost = params.editExistingPublicHost;
    if (params.renameToSubdomain) {
      const sub = toSubdomain(params.renameToSubdomain);
      if (!sub) throw new Error('Invalid new subdomain');
      const uniqueSub = generateUniqueSubdomain(sub, existingHosts);
      const newPublicHost = buildPublicHostFromSubdomain(uniqueSub);
      if (newPublicHost !== targetPublicHost) {
        currentMap.delete(targetPublicHost);
        targetPublicHost = newPublicHost;
        action = 'renamed';
      }
    }
    currentMap.set(targetPublicHost, portalHost);
    await writePortalMapFromMap(currentMap);
    await reloadNginx(true);
    return { publicHost: targetPublicHost, portalHost, publicUrl: `http://${targetPublicHost}`, action };
  }

  let subdomain = toSubdomain(params.desiredSubdomain || params.repoNameFallback || portalHost.split('.localhost')[0]);
  if (!subdomain) subdomain = `site-${Math.random().toString(36).slice(2, 7)}`;
  const uniqueSub = generateUniqueSubdomain(subdomain, existingHosts);
  const publicHost = buildPublicHostFromSubdomain(uniqueSub);
  currentMap.set(publicHost, portalHost);
  await writePortalMapFromMap(currentMap);
  await reloadNginx(true);
  return { publicHost, portalHost, publicUrl: `http://${publicHost}`, action: 'created' };
}

export async function removeMapping(publicHostOrSubdomain: string): Promise<{ removed: boolean; publicHost?: string }>{
  const currentMap = await readPortalMap();
  let targetHost = publicHostOrSubdomain.includes('.') ? publicHostOrSubdomain : buildPublicHostFromSubdomain(publicHostOrSubdomain);
  if (!currentMap.has(targetHost)) {
    const asHost = publicHostOrSubdomain;
    if (currentMap.has(asHost)) targetHost = asHost;
  }
  const existed = currentMap.delete(targetHost);
  if (existed) {
    await writePortalMapFromMap(currentMap);
    await reloadNginx(true);
    return { removed: true, publicHost: targetHost };
  }
  return { removed: false };
}
