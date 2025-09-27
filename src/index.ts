import { spawn } from "bun";
// (fs and path moved to services)
import { DOMAIN_BASE } from "./config";
import { log } from "./utils/log";
import { handleDomains } from "./routes/domains";
import { jsonResponse, preflightResponse } from "./routes/helpers";
import { addOrEditMapping, toSubdomain } from "./services/portalMap";

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
  blobId?: string;         // e.g. 292xfyhlld7bahjr4hyvjqsdips66pvslabek0fr2m3ysmozwl
}

// Generate unique build ID
function generateBuildId(): string {
  const buildId = `build_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  log('info', 'Generated new build ID', { buildId });
  return buildId;
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

// Stream logs live to stdout/stderr while collecting for parsing
async function streamAndCollect(
  stream: ReadableStream | null | undefined,
  write: (chunk: string) => void
): Promise<string> {
  if (!stream) return "";
  let collected = "";
  try {
    // Try using a reader for chunked streaming
    const reader = (stream as any).getReader ? (stream as any).getReader() : null;
    if (!reader) {
      const text = await new Response(stream).text();
      write(text);
      return text;
    }
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = typeof value === 'string' ? value : decoder.decode(value);
      collected += text;
      write(text);
    }
    return collected;
  } catch {
    // Fallback: read whole stream
    const text = await new Response(stream).text();
    write(text);
    return text;
  }
}

// no-op

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
      stdio: ["inherit", "pipe", "pipe"] // stream logs while capturing to parse portal URL
    });

    log('info', 'Site-builder process spawned, waiting for completion...');
    
    // Stream outputs live and collect
    const stdoutPromise = streamAndCollect((publishProcess as any).stdout, (t) => {
      try { (process as any).stdout.write(t); } catch { console.log(t); }
    });
    const stderrPromise = streamAndCollect((publishProcess as any).stderr, (t) => {
      try { (process as any).stderr.write(t); } catch { console.error(t); }
    });
    const exitCodePromise = publishProcess.exited;
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      exitCodePromise
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
    
    "/domains": handleDomains,

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

        // Extract blob ID from portal URL for fallback
        let blobId: string | undefined;
        if (portalUrl) {
          const match = portalUrl.match(/^https?:\/\/([a-z0-9]+)\.localhost:3000/);
          blobId = match ? match[1] : undefined;
        }

        try {
          const repoNameExtracted = extractRepoNameFromGitHubUrl(githubUrl);
          if (!repoNameExtracted) {
            log('warn', 'Could not extract repo name from GitHub URL; skipping portal map registration', { githubUrl });
          } else if (!portalUrl) {
            log('warn', 'No portal URL found in site-builder output; skipping portal map registration');
          } else {
            const reg = await addOrEditMapping({ desiredSubdomain: repoNameExtracted, portalHostOrUrl: portalUrl });
            publicHost = reg.publicHost;
            publicUrl = reg.publicUrl;
          }
        } catch (e) {
          log('error', 'Failed to register portal mapping', { error: e instanceof Error ? e.message : e });
        }

        // If nginx mapping failed, create fallback URLs
        if (!publicUrl && portalUrl) {
          const repoNameExtracted = extractRepoNameFromGitHubUrl(githubUrl);
          if (repoNameExtracted && blobId) {
            // Create a clean public URL using the domain base and blob ID
            publicHost = `${toSubdomain(repoNameExtracted)}.${DOMAIN_BASE}`;
            publicUrl = `http://${publicHost}`;
            log('info', 'Created fallback public URL', { publicHost, publicUrl, blobId });
          } else if (blobId) {
            // Fallback to just the blob ID URL
            publicUrl = `https://wal.app/${blobId}`;
            log('info', 'Created blob-based fallback URL', { publicUrl, blobId });
          }
        }

        const response: BuildResponse = {
          success: true,
          message: "Successfully built and published site",
          buildId,
          portalUrl,
          publicHost,
          publicUrl,
          blobId
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