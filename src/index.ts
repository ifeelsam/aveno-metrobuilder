import { spawn } from "bun";
import * as fs from "fs/promises";
import { dirname } from "path";

// Logging utility
function log(level: string, message: string, data?: any) {
  console.log(`[${level.toUpperCase()}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

interface BuildRequest {
  githubUrl: string;
}

interface BuildResponse {
  success: boolean;
  message: string;
  buildId?: string;
  portalUrl?: string;      // e.g. http://<slug>.localhost:3000
  publicHost?: string;     // e.g. <repo>.avenox.xyz
  publicUrl?: string;      // e.g. http(s)://<repo>.avenox.xyz
}

// Configuration via environment variables
const DOMAIN_BASE = process.env.AVENO_DOMAIN_BASE || "avenox.xyz";
const PORTAL_MAP_PATH = process.env.AVENO_PORTAL_MAP_PATH || "/etc/nginx/portal.map";
const NGINX_RELOAD = process.env.AVENO_NGINX_RELOAD === "1" || process.env.AVENO_NGINX_RELOAD === "true";
const CORS_ORIGINS = process.env.AVENO_CORS_ORIGINS || "*"; // comma-separated or '*'

// Generate unique build ID
function generateBuildId(): string {
  const buildId = `build_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  log('info', 'Generated new build ID', { buildId });
  return buildId;
}

// Convert a string into a DNS-safe subdomain
function toSubdomain(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$|\./g, "");
}

// Extract repo name from GitHub URL (supports HTTPS and SSH formats)
function extractRepoNameFromGitHubUrl(githubUrl: string): string | null {
  try {
    // Handle HTTPS-like URLs
    if (githubUrl.startsWith("http://") || githubUrl.startsWith("https://")) {
      const u = new URL(githubUrl);
      const parts = u.pathname.split("/").filter(Boolean);
      const repoRaw = parts[parts.length - 1] || "";
      return repoRaw.replace(/\.git$/i, "");
    }
    // Handle SSH like git@github.com:org/repo.git
    const match = githubUrl.match(/^[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
    if (match) {
      const repoRaw = match[2];
      return repoRaw.replace(/\.git$/i, "");
    }
  } catch {
    // ignore
  }
  return null;
}

// Parse portal URL from site-builder output
function parsePortalUrlFromOutput(output: string): string | null {
  // Prefer full URLs first
  const fullUrl = output.match(/https?:\/\/([a-z0-9-]+)\.localhost:3000[^\s"'\)\]]*/i);
  if (fullUrl) return fullUrl[0];
  // Fallback: bare host:port
  const bareHost = output.match(/([a-z0-9-]+)\.localhost:3000[^\s"'\)\]]*/i);
  if (bareHost) return `http://${bareHost[0]}`;
  return null;
}

async function ensureDirExistsForFile(filePath: string): Promise<void> {
  try {
    await fs.mkdir(dirname(filePath), { recursive: true });
  } catch (error) {
    // ignore EEXIST etc.
  }
}

async function readTextStream(stream: ReadableStream | null | undefined): Promise<string> {
  if (!stream) return "";
  // Bun supports Response on ReadableStream for easy text gathering
  try {
    return await new Response(stream).text();
  } catch {
    return "";
  }
}

async function reloadNginxIfEnabled(force: boolean = false): Promise<void> {
  if (!force && !NGINX_RELOAD) return;
  try {
    log('info', 'Reloading Nginx as per AVENO_NGINX_RELOAD');
    const testProc = spawn(["sudo", "nginx", "-t"], { stdio: ["inherit", "inherit", "inherit"] });
    const testExit = await testProc.exited;
    if (testExit !== 0) {
      log('error', 'nginx -t failed; skipping reload', { testExit });
      return;
    }
    const reloadProc = spawn(["sudo", "systemctl", "reload", "nginx"], { stdio: ["inherit", "inherit", "inherit"] });
    const reloadExit = await reloadProc.exited;
    if (reloadExit !== 0) {
      log('error', 'systemctl reload nginx failed', { reloadExit });
    } else {
      log('info', 'Nginx reloaded');
    }
  } catch (error) {
    log('error', 'Failed to reload Nginx', { error: error instanceof Error ? error.message : error });
  }
}

// CORS helpers
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  const allowHeaders = req.headers.get("Access-Control-Request-Headers") || "Content-Type, Authorization";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

function jsonResponse(req: Request, body: any, status = 200): Response {
  const baseHeaders = {
    "Content-Type": "application/json",
    ...getCorsHeaders(req),
  };
  return new Response(JSON.stringify(body), { status, headers: baseHeaders });
}

function preflightResponse(req: Request): Response {
  return new Response(null, { status: 204, headers: getCorsHeaders(req) });
}

// Update /var/lib/avenox/portal.map with mapping: <repo>.<domainBase> <slug>.localhost;
async function registerPortalMapping(repoName: string, portalUrl: string): Promise<{ publicHost: string; portalHost: string; publicUrl: string }> {
  const repoSubdomain = toSubdomain(repoName);
  if (!repoSubdomain) {
    throw new Error("Invalid repo name after slugify");
  }
  const publicHost = `${repoSubdomain}.${DOMAIN_BASE}`;

  const u = new URL(portalUrl);
  if (u.hostname.endsWith('.localhost') === false || (u.port && u.port !== '3000')) {
    throw new Error(`Unexpected portal URL host/port: ${u.hostname}:${u.port || ''}`);
  }
  const portalHost = u.hostname; // e.g. <slug>.localhost

  const publicUrl = `http://${publicHost}`;

  await ensureDirExistsForFile(PORTAL_MAP_PATH);

  // Read existing map file (if any)
  const current = await fs.readFile(PORTAL_MAP_PATH).then(b => b.toString('utf8')).catch(() => '');
  const existingLines = current.split('\n').filter(line => line.trim().length > 0);
  const filtered = existingLines.filter(line => !line.trimStart().startsWith(publicHost + ' '));
  const updated = [...filtered, `${publicHost} ${portalHost};`].join('\n') + '\n';

  // Atomic replace: write to temp in same dir then rename
  const tmpPath = `${PORTAL_MAP_PATH}.tmp-${Date.now()}`;
  await fs.writeFile(tmpPath, updated, { encoding: 'utf8' });
  await fs.rename(tmpPath, PORTAL_MAP_PATH);

  log('info', 'Registered portal mapping', { publicHost, portalHost, mapPath: PORTAL_MAP_PATH });
  return { publicHost, portalHost, publicUrl };
}

// Clone GitHub repository
async function cloneRepository(githubUrl: string, buildId: string): Promise<boolean> {
  log('info', 'Starting repository clone', { githubUrl, buildId, targetDir: `./builds/${buildId}` });
  
  try {
    const cloneProcess = spawn(["git", "clone", githubUrl, `./builds/${buildId}`], {
      cwd: process.cwd(),
      stdio: ["inherit", "inherit", "inherit"] // Show all output
    });

    log('info', 'Git clone process spawned, waiting for completion...');
    
    const exitCode = await cloneProcess.exited;
    
    if (exitCode === 0) {
      log('info', 'Repository cloned successfully', { exitCode });
      return true;
    } else {
      log('error', 'Repository clone failed', { exitCode });
      return false;
    }
  } catch (error) {
    log('error', 'Error during repository clone', { error: error instanceof Error ? error.message : error });
    return false;
  }
}

// Build the repository
async function buildRepository(buildId: string): Promise<boolean> {
  const buildDir = `./builds/${buildId}`;
  log('info', 'Starting repository build process', { buildId, buildDir });
  
  try {
    // Step 1: Install dependencies
    log('info', 'Installing dependencies with bun install...');
    const buildProcess = spawn(["bun", "install"], {
      cwd: buildDir,
      stdio: ["inherit", "inherit", "inherit"] // Show all output
    });

    const installExitCode = await buildProcess.exited;
    
    if (installExitCode !== 0) {
      log('error', 'Dependency installation failed', { installExitCode });
      return false;
    }
    
    log('info', 'Dependencies installed successfully', { installExitCode });

    // Step 2: Try to run build script
    log('info', 'Running build script with bun run build...');
    const buildScriptProcess = spawn(["bun", "run", "build"], {
      cwd: buildDir,
      stdio: ["inherit", "inherit", "inherit"] // Show all output
    });

    const buildExitCode = await buildScriptProcess.exited;
    
    if (buildExitCode !== 0) {
      log('error', 'Build script failed', { buildExitCode });
      return false;
    }
    
    log('info', 'Build script completed successfully', { buildExitCode });
    
    // Step 3: For Next.js projects, try to export static files
    log('info', 'Checking if this is a Next.js project and trying static export...');
    
    // Check if next.config file exists to confirm it's a Next.js project
    const nextConfigCheck = spawn(['ls', 'next.config.*'], {
      cwd: buildDir,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    const isNextJS = await nextConfigCheck.exited === 0;
    
    if (isNextJS) {
      log('info', 'Detected Next.js project, attempting static export...');
      
      // Try export script first
      try {
        const exportProcess = spawn(["bun", "run", "export"], {
          cwd: buildDir,
          stdio: ["inherit", "inherit", "inherit"]
        });
        
        const exportExitCode = await exportProcess.exited;
        if (exportExitCode === 0) {
          log('info', 'Next.js export script completed successfully');
        } else {
          // Try direct nextjs export command
          log('info', 'Export script failed, trying direct Next.js export...');
          const directExportProcess = spawn(["npx", "next", "export"], {
            cwd: buildDir,
            stdio: ["inherit", "inherit", "inherit"]
          });
          
          const directExportExitCode = await directExportProcess.exited;
          if (directExportExitCode === 0) {
            log('info', 'Direct Next.js export completed successfully');
          } else {
            log('warn', 'Next.js export failed, will use .next build directory');
          }
        }
      } catch (error) {
        log('info', 'No Next.js export available, using build output');
      }
    } else {
      log('info', 'Not a Next.js project, using standard build output');
    }
    
    return true;
  } catch (error) {
    log('error', 'Error during repository build', { error: error instanceof Error ? error.message : error });
    return false;
  }
}

// Publish using site-builder
async function publishSite(buildId: string): Promise<{ ok: boolean; portalUrl?: string }> {
  const buildDir = `./builds/${buildId}`;
  
  // Find the actual dist folder - check common build outputs including Next.js
  const possibleDistDirs = ['out', 'dist', 'build', '.next/standalone', '.next'];
  let distPath = '';
  
  log('info', 'Looking for build output directory', { buildId, possibleDirs: possibleDistDirs });
  
  try {
    // Check which dist directory exists using ls command instead of test
    for (const dir of possibleDistDirs) {
      try {
        const checkProcess = spawn(['ls', dir], {
          cwd: buildDir,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        const exitCode = await checkProcess.exited;
        if (exitCode === 0) {
          distPath = dir;
          log('info', 'Found build output directory', { buildId, distPath });
          break;
        }
      } catch (error) {
        // Continue to next directory
        continue;
      }
    }
    
    if (!distPath) {
      log('error', 'No standard build output directory found. Available directories:');
      // List what directories actually exist
      const lsProcess = spawn(['ls', '-la'], {
        cwd: buildDir,
        stdio: ['inherit', 'inherit', 'inherit']
      });
      await lsProcess.exited;
      
      return false; // Don't proceed with site-builder if no proper dist directory
    }
    
    // Get absolute path to config file
    const configPath = process.cwd() + '/sites-config.yaml';
    
    const siteBuilderCommand = [
      "site-builder", 
      "--config", configPath,
      "publish", 
      "--epochs", "1", 
      distPath
    ];
    
    log('info', 'Starting site publication with site-builder', { 
      buildId, 
      buildDir, 
      distPath,
      command: siteBuilderCommand.join(' ') 
    });
    
    const publishProcess = spawn(siteBuilderCommand, {
      cwd: buildDir,
      stdio: ["inherit", "pipe", "pipe"] // capture stdout/stderr to parse portal URL
    });

    log('info', 'Site-builder process spawned, waiting for completion...');
    
    // Read outputs while process runs
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      readTextStream((publishProcess as any).stdout),
      readTextStream((publishProcess as any).stderr),
      publishProcess.exited
    ]);
    
    if (exitCode === 0) {
      const combined = `${stdoutText}\n${stderrText}`;
      const portalUrl = parsePortalUrlFromOutput(combined) || undefined;
      log('info', 'Site published successfully', { exitCode, distPath, portalUrl });
      return { ok: true, portalUrl };
    } else {
      log('error', 'Site publication failed', { exitCode, distPath, stderr: (stderrText || '').slice(-1000) });
      return { ok: false };
    }
  } catch (error) {
    log('error', 'Error during site publication', { error: error instanceof Error ? error.message : error });
    return { ok: false };
  }
}

// Cleanup build directory
async function cleanupBuild(buildId: string): Promise<void> {
  const buildDir = `./builds/${buildId}`;
  log('info', 'Starting cleanup of build directory', { buildId, buildDir });
  
  try {
    const cleanupProcess = spawn(["rm", "-rf", buildDir], {
      stdio: ["inherit", "inherit", "inherit"] // Show all output
    });
    
    const exitCode = await cleanupProcess.exited;
    
    if (exitCode === 0) {
      log('info', 'Build directory cleaned up successfully', { exitCode });
    } else {
      log('warn', 'Cleanup process completed with non-zero exit code', { exitCode });
    }
  } catch (error) {
    log('error', 'Error during build cleanup', { error: error instanceof Error ? error.message : error });
  }
}

Bun.serve({
  port: 4836,
  routes: {
    "/": (req) => {
      if (req.method === "OPTIONS") return preflightResponse(req);
      log('info', 'Health check endpoint accessed', { method: req.method, url: req.url });
      
      return jsonResponse(req, {
        message: "Aveno MetroBuilder - On-chain deployment platform",
        endpoints: {
          "POST /build": "Build and publish a GitHub repository"
        }
      });
    },
    
    "/build": async (req) => {
      if (req.method === "OPTIONS") return preflightResponse(req);
      log('info', 'Build endpoint accessed', { method: req.method, url: req.url });
      
      if (req.method !== "POST") {
        log('warn', 'Invalid method used on build endpoint', { method: req.method });
        return jsonResponse(req, { 
          success: false, 
          message: "Method not allowed. Use POST." 
        }, 405);
      }

      try {
        const body: BuildRequest = await req.json();
        const { githubUrl } = body;

        log('info', 'Received build request', { githubUrl });

        if (!githubUrl) {
          log('error', 'GitHub URL missing in request body');
          return jsonResponse(req, { 
            success: false, 
            message: "GitHub URL is required" 
          }, 400);
        }

        const buildId = generateBuildId();
        log('info', 'Starting complete build process', { buildId, githubUrl });

        // Step 1: Clone repository
        log('info', 'STEP 1: Cloning repository');
        const cloned = await cloneRepository(githubUrl, buildId);
        if (!cloned) {
          log('error', 'Build failed at clone step', { buildId });
          return jsonResponse(req, { 
            success: false, 
            message: "Failed to clone repository" 
          }, 500);
        }

        // Step 2: Build repository
        log('info', 'STEP 2: Building repository');
        const built = await buildRepository(buildId);
        if (!built) {
          log('error', 'Build failed at build step, starting cleanup', { buildId });
          await cleanupBuild(buildId);
          return jsonResponse(req, { 
            success: false, 
            message: "Failed to build repository" 
          }, 500);
        }

        // Step 3: Publish site
        log('info', 'STEP 3: Publishing site with site-builder');
        const publishResult = await publishSite(buildId);
        if (!publishResult.ok) {
          log('error', 'Build failed at publish step, starting cleanup', { buildId });
          await cleanupBuild(buildId);
          return jsonResponse(req, { 
            success: false, 
            message: "Failed to publish site" 
          }, 500);
        }

        // Step 4: Cleanup
        log('info', 'STEP 4: Cleaning up build directory');
        await cleanupBuild(buildId);

        // Try to map <repo>.<domain> -> <slug>.localhost via Nginx map
        let publicHost: string | undefined;
        let publicUrl: string | undefined;
        let portalUrl: string | undefined = publishResult.portalUrl;

        try {
          const repoNameExtracted = extractRepoNameFromGitHubUrl(githubUrl);
          if (!repoNameExtracted) {
            log('warn', 'Could not extract repo name from GitHub URL; skipping portal map registration', { githubUrl });
          } else if (!portalUrl) {
            log('warn', 'No portal URL found in site-builder output; skipping portal map registration');
          } else {
            const reg = await registerPortalMapping(repoNameExtracted, portalUrl);
            publicHost = reg.publicHost;
            publicUrl = reg.publicUrl;
            // Ensure Nginx picks up the change before responding
            await reloadNginxIfEnabled(true);
          }
        } catch (e) {
          log('error', 'Failed to register portal mapping', { error: e instanceof Error ? e.message : e });
        }

        const response: BuildResponse = {
          success: true,
          message: "Successfully built and published site",
          buildId,
          portalUrl,
          publicHost,
          publicUrl
        };

        log('info', 'Build process completed successfully', response);

        return jsonResponse(req, response, 200);

      } catch (error) {
        log('error', 'Unexpected error in build endpoint', { error: error instanceof Error ? error.message : error });
        return jsonResponse(req, { 
          success: false, 
          message: "Internal server error" 
        }, 500);
      }
    }
  }
});

log('info', '🚀 Aveno MetroBuilder server started successfully', { 
  port: 4836, 
  endpoints: ['/build (POST)', '/ (GET)']
});

console.log("🚀 Aveno MetroBuilder server running on http://localhost:4836");