import type { Metadata } from "next";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "确认 OA 扫码请求",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function QrMobileLayout({ children }: { children: ReactNode }) {
  return children;
}
