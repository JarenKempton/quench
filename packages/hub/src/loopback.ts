export const isLoopback = (host: string) => {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127(\.\d{1,3}){3}$/.test(bare);
};
