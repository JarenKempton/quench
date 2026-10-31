export const version = process.env.QUENCH_VERSION ?? "0.0.0-dev";

export const compiled = /^(\/\$bunfs\/|B:[\\/]~BUN[\\/])/.test(import.meta.path);
