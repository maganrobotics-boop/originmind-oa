import { resolve as fileResolve, load } from './oa-chat-file-loader.mjs';
export { load };
export async function resolve(source, context, nextResolve) {
  if (source.endsWith('/oa-chat-client')) return { url: `data:text/javascript,${encodeURIComponent("export const generateOaTask=async()=>{ throw new Error('DRAFT_MUST_NOT_CALL_MODEL'); };")}`, shortCircuit: true };
  return fileResolve(source, context, nextResolve);
}
