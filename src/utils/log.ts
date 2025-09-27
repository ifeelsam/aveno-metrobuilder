export function log(level: string, message: string, data?: any) {
  console.log(`[${level.toUpperCase()}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
}
