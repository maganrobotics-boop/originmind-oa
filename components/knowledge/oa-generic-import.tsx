'use client';
import { useEffect, useRef, useState } from 'react';
import { readChatAttachments, type ChatAttachmentBundle } from '@/lib/oa-chat-attachments.mjs';
import { OaFilePicker, OaSourceArchive } from './oa-file-controls';

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
      if (live.current) { setBundle(next); setProgress('已自动填写题目和内容，请核对后提交审核。'); }
    } catch (cause) { if (live.current) { setError(cause instanceof Error ? cause.message : '解析失败，请重试。'); setProgress(''); } }
    finally { active.current = null; if (live.current) setBusy(false); }
  }
  return <section className="oa-generic-source" aria-label="通用资料上传">
    <h2>上传资料</h2>
    <p>选择文件后，OA 会自动填写题目和内容。提交后由审核人决定对内、对外公开或退回。</p>
    <OaFilePicker disabled={busy} onFiles={(files, folder) => void select(files, folder)} />
    {progress && <p role="status">{progress}</p>}{error && <p role="alert" className="oa-file-warning">{error}</p>}
    {bundle && <div className="oa-generic-preview" key={bundle.id}>
      <label><span>题目</span><input value={bundle.pkg.title} readOnly /></label>
      <label><span>内容</span><textarea value={bundle.pkg.body} rows={14} readOnly /></label>
      <OaSourceArchive bundle={bundle} onSubmitted={onSubmitted} />
    </div>}
  </section>;
}
