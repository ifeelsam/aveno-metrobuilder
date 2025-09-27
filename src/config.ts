export const DOMAIN_BASE: string = process.env.AVENO_DOMAIN_BASE || "avenox.xyz";
export const PORTAL_MAP_PATH: string = process.env.AVENO_PORTAL_MAP_PATH || "/etc/nginx/portal.map";
export const NGINX_RELOAD: boolean = process.env.AVENO_NGINX_RELOAD === "1" || process.env.AVENO_NGINX_RELOAD === "true";
export const CORS_ORIGINS: string = process.env.AVENO_CORS_ORIGINS || "*"; // comma-separated or '*'
