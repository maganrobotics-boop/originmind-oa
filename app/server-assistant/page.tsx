import type { Metadata } from 'next';
import ServerAssistant from './client';
import './server-assistant.css';

export const metadata: Metadata = {
  title: '服务器助手 · OriginMind',
  robots: { index: false, follow: false, noarchive: true },
};

export default function ServerAssistantPage() {
  return <ServerAssistant />;
}
