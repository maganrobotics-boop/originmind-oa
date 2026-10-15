import type { Metadata } from 'next';
import ServerAssistant from '../server-assistant/client';
import '../server-assistant/server-assistant.css';

export const metadata: Metadata = {
  title: 'AI 助手 · OriginMind',
  robots: { index: false, follow: false, noarchive: true },
};

export default function AiAssistantPage() {
  return <ServerAssistant variant="general" />;
}
