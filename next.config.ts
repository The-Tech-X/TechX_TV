import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/script-studio", destination: "/podcast", permanent: false },
      { source: "/social", destination: "/productions", permanent: false },
    ];
  },
};

export default nextConfig;
