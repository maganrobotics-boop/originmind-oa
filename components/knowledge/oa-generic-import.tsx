'use client';
import { useEffect, useRef, useState } from 'react';
import { readChatAttachments, type ChatAttachmentBundle } from '@/lib/oa-chat-attachments.mjs';
import { OaFilePicker, OaSourceArchive, OaSourceImages } from './oa-file-controls';

/** Sidebar and in-chat entry points share parsing and the same explicit OA submission. */
export function OaGenericImport({ onSubmitted }: { onSubmitted: () => void }) {
  const [bundle, setBundle] = useState<ChatAttachmentBundle | null>(null), [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(''), [error, setError] = useState('');
  const active = useRef<AbortController | null>(null), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; active.current?.abort(); }; }, []);
  async function select(files: File[], folder: boolean) {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError('');
    try {
      const next = await readChatAttachments(files, { folder, signal: controller.signal, onProgress: text => { if (live.current) setProgress(text); } });
      if (live.current) { setBundle(next); setProgress('已解析，请核对正文和图片后归档。'); }
    } catch (cause) { if (live.current) { setError(cause instanceof Error ? cause.message : '解析失败，请重试。'); setProgress(''); } }
    finally { active.current = null; if (live.current) setBusy(false); }
  }
  return <section className="oa-generic-source" aria-label="通用资料上传">
    <h2>文件、图片、文件夹与 ZIP</h2>
    <p>支持 TXT、MD、DOCX、PDF、PNG、JPG、WebP。解析后不自动入库，点击归档才提交 OA 审批。</p>
    <OaFilePicker disabled={busy} onFiles={(files, folder) => void select(files, folder)} />
    {progress && <p role="status">{progress}</p>}{error && <p role="alert" className="oa-file-warning">{error}</p>}
    {bundle && <div key={bundle.id}><h3>{bundle.name}</h3><details><summary>核对完整解析正文（{bundle.text.length.toLocaleString()} 字）</summary><pre>{bundle.text}</pre></details><OaSourceImages bundle={bundle} /><OaSourceArchive bundle={bundle} onSubmitted={onSubmitted} /></div>}
  </section>;
}
