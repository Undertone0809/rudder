import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  poweredByHeader: false,
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
