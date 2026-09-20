export function parseKnowledgeUrlCommand(value: unknown): string | null;
export function safeKnowledgeSourceUrl(value: unknown): URL | null;
export function readableWebDocument(raw: unknown, contentType: string, url: URL): { title: string; content: string };
export function fetchKnowledgeUrl(value: unknown, fetcher?: typeof fetch): Promise<{ title: string; content: string; sourceUrl: string }>;
