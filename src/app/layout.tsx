import type { Metadata } from "next";
import "./workspace.css";
import "./settings.css";

export const metadata: Metadata = { title: "LearnGPT", description: "按项目学习、对话和回顾" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
