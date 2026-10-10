import { createHash, createDecipheriv, timingSafeEqual } from 'node:crypto';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function computeSignature({ token, timestamp, nonce, encrypted }) {
  for (const value of [token, timestamp, nonce, encrypted]) {
    if (typeof value !== 'string' || !value || value.length > 100000) throw fail('CALLBACK_INVALID');
  }
  return createHash('sha1').update([token, timestamp, nonce, encrypted].sort().join('')).digest('hex');
}

// Tencent's envelope uses PKCS#7 with a 32-byte block, in addition to AES's
// 16-byte block. Do not enable Node's default 16-byte unpadding here.
export function verifyAndDecrypt({ token, encodingAESKey, corpId, signature, timestamp, nonce, encrypted }) {
  if (typeof encodingAESKey !== 'string' || !/^[A-Za-z0-9+/]{43}$/.test(encodingAESKey)
      || typeof corpId !== 'string' || !corpId || corpId.length > 128) throw fail('CALLBACK_CONFIG');
  if (typeof signature !== 'string' || !/^[a-fA-F0-9]{40}$/.test(signature)
      || typeof timestamp !== 'string' || !/^\d{1,16}$/.test(timestamp)
      || typeof nonce !== 'string' || !nonce || nonce.length > 256
      || typeof encrypted !== 'string' || encrypted.length > 100000
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) throw fail('CALLBACK_INVALID');
  const expected = Buffer.from(computeSignature({ token, timestamp, nonce, encrypted }), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw fail('CALLBACK_SIGNATURE');
  const key = Buffer.from(encodingAESKey + '=', 'base64');
  const ciphertext = Buffer.from(encrypted, 'base64');
  if (key.length !== 32 || ciphertext.length < 32 || ciphertext.length % 32 !== 0
      || ciphertext.toString('base64') !== encrypted) throw fail('CALLBACK_ENVELOPE');
  let padded;
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { throw fail('CALLBACK_ENVELOPE'); }
  const pad = padded.at(-1);
  if (pad < 1 || pad > 32 || padded.length <= pad) throw fail('CALLBACK_PADDING');
  let mismatch = 0;
  for (let i = padded.length - pad; i < padded.length; i++) mismatch |= padded[i] ^ pad;
  if (mismatch) throw fail('CALLBACK_PADDING');
  const plain = padded.subarray(0, padded.length - pad);
  if (plain.length < 21) throw fail('CALLBACK_ENVELOPE');
  const messageLength = plain.readUInt32BE(16);
  if (messageLength > plain.length - 20) throw fail('CALLBACK_ENVELOPE');
  const receiver = plain.subarray(20 + messageLength);
  const required = Buffer.from(corpId);
  if (receiver.length !== required.length || !timingSafeEqual(receiver, required)) throw fail('CALLBACK_RECEIVER');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(plain.subarray(20, 20 + messageLength)); }
  catch { throw fail('CALLBACK_ENCODING'); }
}

function checkXml(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 65536
      || /<!DOCTYPE|<!ENTITY|<\?/i.test(xml) || !/^\s*<xml>[\s\S]*<\/xml>\s*$/.test(xml)) throw fail('CALLBACK_XML');
}

function field(xml, name, optional = false) {
  const matches = [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'g'))];
  if (matches.length !== 1) {
    if (optional && matches.length === 0) return '';
    throw fail('CALLBACK_XML');
  }
  let value = matches[0][1];
  if (value.startsWith('<![CDATA[') && value.endsWith(']]>')) value = value.slice(9, -3);
  else if (/[<&]/.test(value)) throw fail('CALLBACK_XML');
  if (/[<>\u0000]/.test(value) || value.length > (name === 'Encrypt' ? 65536 : 1024)) throw fail('CALLBACK_XML');
  return value;
}

export function extractEncrypted(xml) {
  checkXml(xml);
  return field(xml, 'Encrypt');
}

// Fixed scalar fields only: no XML parser, entity expansion, or customer text.
export function parseCallbackXml(xml) {
  checkXml(xml);
  const event = field(xml, 'Event');
  const msgType = field(xml, 'MsgType');
  const openKfId = field(xml, 'OpenKfId');
  const token = field(xml, 'Token');
  if (event !== 'kf_msg_or_event' || msgType !== 'event') throw fail('CALLBACK_UNSUPPORTED');
  if (!openKfId || Buffer.byteLength(openKfId) > 128 || !token || Buffer.byteLength(token) > 128) throw fail('CALLBACK_XML');
  return { event, msgType, openKfId, token };
}
