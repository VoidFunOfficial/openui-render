import type { Metadata } from "next";
import RenderHarness from "@/ui/RenderHarness";

export const metadata: Metadata = { title: "OpenUI render", robots: { index: false, follow: false } };

export default function RenderPage() {
  return <RenderHarness />;
}
