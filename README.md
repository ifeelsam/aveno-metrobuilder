# Aveno MetroBuilder

Minimal on-chain deployment platform that builds GitHub repositories and publishes them using site-builder.

Environment variables to enable Nginx portal mapping (optional):

- AVENO_DOMAIN_BASE: base domain for public mapping (default: avenox.xyz)
- AVENO_PORTAL_MAP_PATH: path to Nginx map file (default: /var/lib/avenox/portal.map)
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
curl -X POST http://localhost:4836/build \
  -H "Content-Type: application/json" \
  -d '{"githubUrl": "https://github.com/username/repo"}'
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