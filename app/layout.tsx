import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OriginMind × ARTS Robotics 联合研发 OA",
  description: "面向联合研发项目的技术成果、采购、劳务报酬及保密协议审批与归档平台。",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
