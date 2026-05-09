import { type NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@saleor/apps-shared", "@saleor/apps-ui", "@saleor/react-hook-form-macaw"],
  experimental: {
    optimizePackageImports: ["@saleor/app-sdk"],
  },
  bundlePagesRouterDependencies: true,
  serverExternalPackages: ["mongodb"],
};

export default nextConfig;
