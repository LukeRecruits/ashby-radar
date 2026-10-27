import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ashby Radar',
  description: 'Companies using Ashby or Greenhouse, and which of them are worth talking to.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
