export type PackageImage = { path: string; alt: string; file: File; type: string };
export type KnowledgePackage = { id: string; title: string; body: string; category: string; updatedAt: string; images: PackageImage[]; unusedPaths: string[]; totalBytes: number };
export const PACKAGE_LIMITS: Readonly<{ files: number; zip: number; total: number; markdown: number; image: number }>;
export function normalizePackagePath(input: string): string;
export function prepareKnowledgePackage(selected: Iterable<File> | ArrayLike<File>, folder?: boolean): Promise<KnowledgePackage>;
export function unpackKnowledgeZip(file: File): Promise<File[]>;
export function submitKnowledgePackage(pkg: KnowledgePackage, options?: { fetcher?: typeof fetch; onProgress?: (message: string) => void; returnedKnowledgeItemId?: string }): Promise<{ received: true; item: { id: string; title: string; status: string } }>;
