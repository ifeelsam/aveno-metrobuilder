import { spawn } from "bun";
import { NGINX_RELOAD } from "../config";
import { log } from "../utils/log";

export async function reloadNginx(force: boolean = false): Promise<void> {
  if (!force && !NGINX_RELOAD) return;
  try {
    log('info', 'Reloading Nginx');
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
