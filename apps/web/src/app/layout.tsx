import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import 'maplibre-gl/dist/maplibre-gl.css';
import './globals.css';

export const metadata: Metadata = { title: 'Swachh-Track | Operations Console', description: 'Verified collection records, society operations and municipal evidence.', robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="en"><body><Providers>{children}</Providers></body></html>; }
