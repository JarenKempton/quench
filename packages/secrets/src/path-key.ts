export const pathKey = (path: string, platform: NodeJS.Platform = process.platform) =>
  platform === "darwin" || platform === "win32" ? path.toLowerCase() : path;
