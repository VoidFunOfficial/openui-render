import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  devIndicators: false,
  serverExternalPackages: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
  outputFileTracingIncludes: {
    "/api/run": ["./agent/**/*", "./src/openui/system-prompt.txt", "./src/openui/*.md"],
    "/api/projects": ["./agent/**/*"],
    "/api/agents": ["./agent/**/*"],
    "/api/models": ["./agent/**/*"],
  },
};
export default config;
