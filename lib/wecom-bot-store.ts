import { getD1Database } from '../db';
import { isMigrationWriteFrozen } from './migration-freeze';
import { knowledgeSearchTerms, type SearchableKnowledgeChunk } from './knowledge-policy';
import {
  BOT_SQL, BOT_PAIRING_LIFETIME_MS, BOT_LEDGER_LIFETIME_MS,
  createBotPairingCode, hashBotPairingCode, maskBotUserId,
  type BotMessage, type BotLinkAction,
} from './wecom-bot-contract.mjs';

export type BotActor = {
  user: { email: string; displayName: string };
  memberId?: string;
  accountUserId?: string;
  memberMutationRevision?: string;
  isAdmin: boolean;
  ndaCompleted: boolean;
  ndaAcceptedAt?: string;
  ndaApprovalId?: string;
  ndaAgreementVersion?: string;
};
export type BotLink = {
  bot_id: string; user_id: string; member_id: string; account_user_id: string;
  linked_member_revision: string; revision: string; created_at: string; updated_at: string; revoked_at: string | null;
};
type Pairing = { id: string; state: 'pending' | 'candidate'; candidate_user_id: string | null; expires_at: string; member_revision: string };
type Context = Record<string, unknown>;

function actorContext(actor: BotActor): Context {
  if (!actor.memberId || !actor.accountUserId || !actor.memberMutationRevision || !actor.ndaCompleted
    || !actor.user.email || (!actor.isAdmin && (!actor.ndaApprovalId || !actor.ndaAcceptedAt || !actor.ndaAgreementVersion))) {
    throw new Error('WECOM_BOT_NOT_AUTHORIZED');
  }
  return {
    memberId: actor.memberId, accountUserId: actor.accountUserId, memberRevision: actor.memberMutationRevision,
    isAdmin: actor.isAdmin ? 1 : 0, name: actor.user.displayName, email: actor.user.email.trim().toLowerCase(),
    ndaApprovalId: actor.ndaApprovalId || null, ndaAcceptedAt: actor.ndaAcceptedAt || null,
    ndaAgreementVersion: actor.ndaAgreementVersion || null,
  };
}
const statement = (database: D1Database, key: keyof typeof BOT_SQL, context: Context) => database.prepare(BOT_SQL[key]).bind(JSON.stringify(context));
const writable = (environment: Record<string, unknown>) => {
  if (isMigrationWriteFrozen(environment) || isMigrationWriteFrozen(process.env)) throw new Error('WECOM_BOT_WRITE_FROZEN');
};
const serializePairing = (pairing: Pairing | null) => pairing ? {
  id: pairing.id, state: pairing.state, expiresAt: pairing.expires_at, userIdHint: maskBotUserId(pairing.candidate_user_id),
} : null;

export async function getBotLinkState(botId: string, actor: BotActor, now = Date.now()) {
  const database = await getD1Database();
  const context = { ...actorContext(actor), botId, now: new Date(now).toISOString() };
  const [link, pairing] = await Promise.all([
    statement(database, 'ownLink', context).first<BotLink>(),
    statement(database, 'ownPairing', context).first<Pairing>(),
  ]);
  return {
    linked: link ? { userIdHint: maskBotUserId(link.user_id), linkedAt: link.created_at } : null,
    pairing: serializePairing(pairing),
  };
}

export async function getBotSenderLink(botId: string, userId: string): Promise<BotLink | null> {
  return statement(await getD1Database(), 'senderLink', { botId, userId }).first<BotLink>();
}

export async function isBotLinkCurrent(link: BotLink, actor: BotActor): Promise<boolean> {
  const row = await statement(await getD1Database(), 'currentLink', {
    ...actorContext(actor), botId: link.bot_id, userId: link.user_id, linkRevision: link.revision,
  }).first<{ revision: string }>();
  return row?.revision === link.revision;
}

export async function claimBotMessage(message: BotMessage, environment: Record<string, unknown>, now = Date.now()) {
  writable(environment);
  const context = {
    botId: message.botId, userId: message.userId, messageId: message.messageId,
    now: new Date(now).toISOString(), expiresAt: new Date(now + BOT_LEDGER_LIFETIME_MS).toISOString(),
    rateCutoff: new Date(now - 60_000).toISOString(), cutoff: new Date(now - BOT_LEDGER_LIFETIME_MS).toISOString(),
  };
  const database = await getD1Database();
  const results = await database.batch([
    statement(database, 'cleanupMessages', context), statement(database, 'cleanupPairings', context), statement(database, 'claimMessage', context),
  ]);
  return Boolean(results[2]?.results?.length);
}

export async function claimBotPairing(botId: string, userId: string, code: string, environment: Record<string, unknown>, now = Date.now()) {
  writable(environment);
  const context = { botId, userId, codeHash: await hashBotPairingCode(code), now: new Date(now).toISOString() };
  return Boolean(await statement(await getD1Database(), 'claimPairing', context).first<{ id: string }>());
}

export async function unlinkBotActor(botId: string, actor: BotActor, environment: Record<string, unknown>, expectedLink?: BotLink, now = Date.now()) {
  writable(environment);
  const database = await getD1Database();
  const actorValues = actorContext(actor);
  const link = expectedLink || await statement(database, 'ownLink', { ...actorValues, botId }).first<BotLink>();
  if (!link || link.bot_id !== botId || link.member_id !== actor.memberId || link.account_user_id !== actor.accountUserId || link.revoked_at) return false;
  const context = { ...actorValues, botId, linkRevision: link.revision, newRevision: crypto.randomUUID(), now: new Date(now).toISOString() };
  const results = await database.batch([
    statement(database, 'unlink', context), statement(database, 'unlinkEvent', context),
  ]);
  return Boolean(results[0]?.results?.length);
}

export async function changeBotLink(botId: string, actor: BotActor, action: BotLinkAction, environment: Record<string, unknown>, now = Date.now()) {
  writable(environment);
  const database = await getD1Database();
  const context = { ...actorContext(actor), botId, now: new Date(now).toISOString() };
  if (action.action === 'create') {
    const code = createBotPairingCode();
    const pairingId = crypto.randomUUID();
    const expiresAt = new Date(now + BOT_PAIRING_LIFETIME_MS).toISOString();
    const values = {
      ...context, pairingId, codeHash: await hashBotPairingCode(code), expiresAt, staleRevision: crypto.randomUUID(),
      rateCutoff: new Date(now - 60_000).toISOString(), cutoff: new Date(now - BOT_LEDGER_LIFETIME_MS).toISOString(),
    };
    const results = await database.batch([
      statement(database, 'cleanupPairings', values), statement(database, 'revokeStaleLink', values),
      statement(database, 'staleLinkEvent', values), statement(database, 'cancelPrevious', values), statement(database, 'createPairing', values),
    ]);
    if (!results[4]?.results?.length) throw new Error('WECOM_BOT_LINK_CONFLICT');
    return { ok: true, code, command: `/绑定 ${code}`, pairing: { id: pairingId, state: 'pending' as const, expiresAt, userIdHint: '' } };
  }
  if (action.action === 'unlink') {
    if (!await unlinkBotActor(botId, actor, environment, undefined, now)) throw new Error('WECOM_BOT_LINK_CONFLICT');
    return { ok: true };
  }
  if (action.action === 'cancel') {
    const row = await statement(database, 'cancelPairing', { ...context, pairingId: action.pairingId }).first<{ id: string }>();
    if (!row) throw new Error('WECOM_BOT_LINK_CONFLICT');
    return { ok: true };
  }
  const values = { ...context, pairingId: action.pairingId, newRevision: crypto.randomUUID() };
  const results = await database.batch([
    statement(database, 'confirmLink', values), statement(database, 'finishPairing', values), statement(database, 'linkEvent', values),
  ]);
  if (!results[0]?.results?.length || !results[1]?.results?.length) throw new Error('WECOM_BOT_LINK_CONFLICT');
  return { ok: true };
}

export async function listBotOwnWorkItems(link: BotLink, actor: BotActor, project: string) {
  const context = { ...actorContext(actor), botId: link.bot_id, userId: link.user_id, linkRevision: link.revision, project };
  const rows = await statement(await getD1Database(), 'ownWorkItems', context).all<{
    id: string; title: string; status: string; priority: string; due_at: string | null;
  }>();
  return rows.results;
}

/** Read the same approved OA knowledge with bot admission and link guards.
 * This does not repair/write the member NDA cache, and keeps the administrator
 * exemption tied to this exact active member. Candidate retrieval is bounded
 * to 256 keyword matches before the shared OA ranker chooses evidence.
 */
export async function getBotActiveKnowledgeChunks(link: BotLink, actor: BotActor, question: string): Promise<SearchableKnowledgeChunk[]> {
  const terms = knowledgeSearchTerms(question);
  if (!terms.length) return [];
  const context = { ...actorContext(actor), botId: link.bot_id, userId: link.user_id, linkRevision: link.revision, terms };
  const result = await statement(await getD1Database(), 'activeKnowledge', context).all<{
    id: string; item_id: string; revision_id: string; title: string; category: string; source_label: string; source_url: string;
    section_title: string; paragraph_ref: string; content: string; search_text: string; updated_at: string;
  }>();
  return result.results.map((row) => ({
    id: row.id, itemId: row.item_id, revisionId: row.revision_id, title: row.title, category: row.category,
    sourceLabel: row.source_label, sourceUrl: row.source_url, sectionTitle: row.section_title, paragraphRef: row.paragraph_ref,
    content: row.content, searchText: row.search_text, updatedAt: row.updated_at,
  }));
}

/** Validate exactly the selected evidence, rather than running the keyword
 * candidate query again. Shared knowledge revisions are immutable; matching
 * content/title also fails closed if an out-of-band writer changes a row.
 */
export async function isBotKnowledgeCurrent(link: BotLink, actor: BotActor, selected: readonly SearchableKnowledgeChunk[]) {
  if (!selected.length) return true;
  if (selected.length > 12 || new Set(selected.map((chunk) => chunk.id)).size !== selected.length) return false;
  const evidence = selected.map((chunk) => ({
    id: chunk.id, itemId: chunk.itemId, revisionId: chunk.revisionId, content: chunk.content, title: chunk.title,
  }));
  const context = { ...actorContext(actor), botId: link.bot_id, userId: link.user_id, linkRevision: link.revision, evidence };
  const result = await statement(await getD1Database(), 'currentEvidence', context).first<{ matched_count: number }>();
  return Number(result?.matched_count) === evidence.length;
}
