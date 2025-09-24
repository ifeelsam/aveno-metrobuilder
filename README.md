# Aveno MetroBuilder

Minimal on-chain deployment platform that builds GitHub repositories and publishes them using site-builder.

Environment variables to enable Nginx portal mapping (optional):

- AVENO_DOMAIN_BASE: base domain for public mapping (default: avenox.xyz)
- AVENO_PORTAL_MAP_PATH: path to Nginx map file (default: /etc/nginx/portal.map)
- AVENO_NGINX_RELOAD: set to "1" or "true" to run `sudo nginx -t` and `sudo systemctl reload nginx` after updating the map

## Quick Start

```bash
# Install dependencies
bun install

# Start development server
bun dev

# Or start production server
bun start
```

Server runs on `http://localhost:4836`

## Usage

Deploy a GitHub repository:
```bash
curl -X POST http://api.avenox.xyz/build \
  -H "Content-Type: application/json" \
  -d '{"githubUrl": "https://github.com/ifeelsam/testsui"}'
```

## File Structure

```
aveno-metrobuilder/
├── src/
│   └── index.ts          # Main server & build logic
├── sites-config.yaml     # Site-builder configuration
├── package.json          # Project dependencies
└── README.md             # This file
```

## How Builds Work

1. **Clone** GitHub repo to temporary `./builds/{buildId}/` directory
2. **Install** dependencies with `bun install`
3. **Build** project with `bun run build`
4. **Export** static files (for Next.js projects)
5. **Detect** output directory (`out`, `dist`, `build`, `.next`)
6. **Publish** to chain using `site-builder --config sites-config.yaml publish --epochs 1 {dist-path}`
7. **Cleanup** temporary build directory

## Build Output Detection

MetroBuilder automatically detects build outputs in this order:
- `out/` (Next.js static export)
- `dist/` (Vite, Webpack, etc.)
- `build/` (Create React App, etc.)
- `.next/standalone/` (Next.js standalone)
- `.next/` (Next.js fallback)

## Requirements

- Bun runtime
- site-builder CLI tool
- Git


server {
    listen 80;
    server_name api.avenox.xyz;
    return 308 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name api.avenox.xyz;

    ssl_certificate     /etc/letsencrypt/live/api.avenox.xyz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.avenox.xyz/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass http://127.0.0.1:4836;  # FIXED
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
    }
}