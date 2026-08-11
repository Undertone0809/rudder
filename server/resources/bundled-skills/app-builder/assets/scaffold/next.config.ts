import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  poweredByHeader: false,
  turbopack: {
    root: process.cwd(),
  },
  webpack(config, { isServer }) {
    if (isServer) {
      config.externals.push((
        { request }: { request?: string },
        callback: (error?: Error | null, result?: string) => void,
      ) => {
        if (request?.startsWith("node:")) {
          callback(null, `commonjs ${request}`);
          return;
        }
        callback();
      });
    }
    return config;
  },
};

export default nextConfig;
