import { INQUIRY_STATUSES, TOPICS } from "./constants.mjs";
import { ValidationError } from "./errors.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError();
  return value;
}

function exactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw new ValidationError();
  }
}

function text(value, { min = 0, max, trim = false, pattern } = {}) {
  if (typeof value !== "string") throw new ValidationError();
  const result = trim ? value.trim() : value;
  if (result.length < min || (max !== undefined && result.length > max) || (pattern && !pattern.test(result))) {
    throw new ValidationError();
  }
  return result;
}

function oneOf(value, values) {
  if (!values.includes(value)) throw new ValidationError();
  return value;
}

function integer(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new ValidationError();
  return value;
}

function boolean(value) {
  if (typeof value !== "boolean") throw new ValidationError();
  return value;
}

function turn(value) {
  const input = object(value);
  exactKeys(input, ["role", "content"]);
  return {
    role: oneOf(input.role, ["user", "assistant"]),
    content: text(input.content, { trim: true, min: 1, max: 12_000 }),
  };
}

function turns(value, { min = 0, max }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new ValidationError();
  return value.map(turn);
}

export function parseChatPayload(value) {
  const input = object(value);
  exactKeys(input, ["messages", "topic"], ["conversationToken"]);
  return {
    messages: turns(input.messages, { min: 1, max: 9 }),
    topic: oneOf(input.topic, TOPICS),
    conversationToken: input.conversationToken === undefined ? undefined : text(input.conversationToken, { max: 40_000 }),
  };
}

export function parseInquiryPayload(value) {
  const input = object(value);
  exactKeys(input, [
    "requestId",
    "name",
    "organisation",
    "contact",
    "topic",
    "summary",
    "consent",
    "includeConversation",
    "transcript",
  ]);
  if (input.consent !== true) throw new ValidationError();
  return {
    requestId: text(input.requestId, { pattern: UUID_PATTERN }),
    name: text(input.name, { trim: true, min: 1, max: 60 }),
    organisation: text(input.organisation, { trim: true, max: 120 }),
    contact: text(input.contact, { trim: true, min: 3, max: 120 }),
    topic: oneOf(input.topic, TOPICS),
    summary: text(input.summary, { trim: true, min: 10, max: 3_000 }),
    consent: true,
    includeConversation: boolean(input.includeConversation),
    transcript: turns(input.transcript, { max: 12 }),
  };
}

export function parseModelConfigPayload(value) {
  const input = object(value);
  exactKeys(input, ["baseUrl", "model"], ["apiKey"]);
  return {
    baseUrl: text(input.baseUrl, { max: 300 }),
    model: text(input.model, { pattern: /^qwen[a-zA-Z0-9_.-]{1,100}$/u }),
    apiKey: input.apiKey === undefined ? undefined : text(input.apiKey, { max: 400 }),
  };
}

export function parseDocumentPayload(value) {
  const input = object(value);
  exactKeys(input, ["title", "body", "url", "category", "updatedAt", "published"], ["id", "draftRevision"]);
  return {
    id: input.id === undefined ? undefined : text(input.id, { max: 100 }),
    draftRevision: input.draftRevision === undefined ? undefined : integer(input.draftRevision, 1, 2_147_483_647),
    title: text(input.title, { trim: true, min: 2, max: 120 }),
    body: text(input.body, { trim: true, min: 10, max: 30_000 }),
    url: text(input.url, { max: 1_500 }),
    category: oneOf(input.category, TOPICS),
    updatedAt: text(input.updatedAt, { pattern: /^\d{4}-\d{2}-\d{2}$/u }),
    published: integer(input.published, 0, 1),
  };
}

export function parseDocumentSubmissionPayload(value) {
  const input = object(value);
  exactKeys(input, ["id", "draftRevision", "submissionState"], ["oaItemId"]);
  const submissionState = oneOf(input.submissionState, ["unknown", "unsubmitted", "submitted"]);
  if ((submissionState === "submitted") !== Object.hasOwn(input, "oaItemId")) throw new ValidationError();
  return {
    id: text(input.id, { max: 100 }),
    draftRevision: integer(input.draftRevision, 1, 2_147_483_647),
    submissionState,
    oaItemId: submissionState === "submitted" ? text(input.oaItemId, { pattern: UUID_PATTERN }).toLowerCase() : null,
  };
}

export function parseInquiryStatusPayload(value) {
  const input = object(value);
  exactKeys(input, ["id", "status"]);
  return {
    id: text(input.id, { pattern: UUID_PATTERN }),
    status: oneOf(input.status, INQUIRY_STATUSES),
  };
}

export function parseLoginPayload(value) {
  const input = object(value);
  exactKeys(input, ["password"]);
  return { password: text(input.password, { min: 1, max: 256 }) };
}
