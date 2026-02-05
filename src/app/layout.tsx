import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '@/hooks/useAuth';
import { PWAProvider } from '@/components/PWAProvider';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'OpsOS — Operations Management',
  description: 'Sistema di gestione operativa per ristoranti e aziende. Funziona anche senza internet.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'OpsOS',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#2563eb',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="it">
      <head>
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body className={inter.className}>
        <AuthProvider>
          <PWAProvider>{children}</PWAProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
