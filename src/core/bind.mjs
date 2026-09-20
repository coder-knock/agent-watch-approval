// 一次性能力令牌的构造与校验。
// 核心思想：通知按钮里携带的那串 action 标识，本身就是一个「绑定到具体动作、
// 只能用一次、有寿命」的能力令牌。手表上不需要放任何长期密钥。

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function actionBinding(toolName, toolInput) {
  const h = createHash('sha256');
  h.update(String(toolName || ''));
  h.update('\n');
  h.update(canonicalJson(toolInput === undefined ? null : toolInput));
  return 'sha256:' + h.digest('hex');
}

export function newApprovalId() {
  const t = Date.now().toString(36);
  const r = randomBytes(4).toString('hex');
  return `${t}${r}`;
}

export function newNonce() {
  return randomBytes(8).toString('hex');
}

export function sign(secret, parts) {
  return createHmac('sha256', String(secret)).update(parts.join('|')).digest('hex').slice(0, 16);
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function buildActionId(id, optionId, nonce, sig) {
  return `APR:${id}:${optionId}:${nonce}:${sig}`;
}

export function parseActionId(raw) {
  const s = String(raw || '').trim();
  if (!s.startsWith('APR:')) return null;
  const parts = s.split(':');
  if (parts.length !== 5) return null;
  const [, id, optionId, nonce, sig] = parts;
  if (!id || !optionId || !nonce || !sig) return null;
  return { id, optionId, nonce, sig };
}
