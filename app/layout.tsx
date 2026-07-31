import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CTS 短线决策台",
  description: "基于同花顺问财的A股盘中买点与次日候选筛选工具",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
