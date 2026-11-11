import type { NextConfig } from "next";

// @libsql/client يعتمد على روابط أصلية (native) — نستثنيه من التجميع لتفادي مشاكل البناء
const nextConfig: NextConfig = {
  serverExternalPackages: ["@libsql/client"],
};

export default nextConfig;
