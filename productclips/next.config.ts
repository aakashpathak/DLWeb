import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["playwright-core", "sharp", "@remotion/renderer", "@remotion/bundler"],
  images: { unoptimized: true },
};
export default config;
