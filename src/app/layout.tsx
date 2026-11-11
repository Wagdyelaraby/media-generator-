import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MCP Media Generator — لوحة الإدارة",
  description: "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع، مع لوحة إدارة عربية",
};

// RTL من أول لحظة مع خط عربي جيد (Cairo مع بدائل نظام)
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
