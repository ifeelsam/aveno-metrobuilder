import { spawn } from "bun";

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
}

// Generate unique build ID
function generateBuildId(): string {
  const buildId = `build_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  log('info', 'Generated new build ID', { buildId });
  return buildId;
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
async function publishSite(buildId: string): Promise<boolean> {
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
      stdio: ["inherit", "inherit", "inherit"] // Show all output
    });

    log('info', 'Site-builder process spawned, waiting for completion...');
    
    const exitCode = await publishProcess.exited;
    
    if (exitCode === 0) {
      log('info', 'Site published successfully', { exitCode, distPath });
      return true;
    } else {
      log('error', 'Site publication failed', { exitCode, distPath });
      return false;
    }
  } catch (error) {
    log('error', 'Error during site publication', { error: error instanceof Error ? error.message : error });
    return false;
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
  port: 3000,
  routes: {
    "/": (req) => {
      log('info', 'Health check endpoint accessed', { method: req.method, url: req.url });
      
      return new Response(JSON.stringify({
        message: "Aveno Backend - GitHub Builder Service",
        endpoints: {
          "POST /build": "Build and publish a GitHub repository"
        }
      }), {
        headers: { "Content-Type": "application/json" }
      });
    },
    
    "/build": async (req) => {
      log('info', 'Build endpoint accessed', { method: req.method, url: req.url });
      
      if (req.method !== "POST") {
        log('warn', 'Invalid method used on build endpoint', { method: req.method });
        return new Response(JSON.stringify({ 
          success: false, 
          message: "Method not allowed. Use POST." 
        }), {
          status: 405,
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
        const body: BuildRequest = await req.json();
        const { githubUrl } = body;

        log('info', 'Received build request', { githubUrl });

        if (!githubUrl) {
          log('error', 'GitHub URL missing in request body');
          return new Response(JSON.stringify({ 
            success: false, 
            message: "GitHub URL is required" 
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        const buildId = generateBuildId();
        log('info', 'Starting complete build process', { buildId, githubUrl });

        // Step 1: Clone repository
        log('info', 'STEP 1: Cloning repository');
        const cloned = await cloneRepository(githubUrl, buildId);
        if (!cloned) {
          log('error', 'Build failed at clone step', { buildId });
          return new Response(JSON.stringify({ 
            success: false, 
            message: "Failed to clone repository" 
          }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Step 2: Build repository
        log('info', 'STEP 2: Building repository');
        const built = await buildRepository(buildId);
        if (!built) {
          log('error', 'Build failed at build step, starting cleanup', { buildId });
          await cleanupBuild(buildId);
          return new Response(JSON.stringify({ 
            success: false, 
            message: "Failed to build repository" 
          }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Step 3: Publish site
        log('info', 'STEP 3: Publishing site with site-builder');
        const published = await publishSite(buildId);
        if (!published) {
          log('error', 'Build failed at publish step, starting cleanup', { buildId });
          await cleanupBuild(buildId);
          return new Response(JSON.stringify({ 
            success: false, 
            message: "Failed to publish site" 
          }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Step 4: Cleanup
        log('info', 'STEP 4: Cleaning up build directory');
        await cleanupBuild(buildId);

        const response: BuildResponse = {
          success: true,
          message: "Successfully built and published site",
          buildId
        };

        log('info', 'Build process completed successfully', response);

        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });

      } catch (error) {
        log('error', 'Unexpected error in build endpoint', { error: error instanceof Error ? error.message : error });
        return new Response(JSON.stringify({ 
          success: false, 
          message: "Internal server error" 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
  }
});

log('info', '🚀 Aveno Backend server started successfully', { 
  port: 3000, 
  endpoints: ['/build (POST)', '/ (GET)']
});

console.log("🚀 Aveno Backend server running on http://localhost:3000");