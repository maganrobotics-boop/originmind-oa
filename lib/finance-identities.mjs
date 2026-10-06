// Explicit server-side finance identities support OAuth accounts without
// treating a synthetic email address as an authenticated email subject.
export function financeIdentities(value) {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string' || value.length > 16000) throw new Error('Invalid finance identity configuration');
  const rows = JSON.parse(value);
  if (!Array.isArray(rows) || rows.length > 20) throw new Error('Invalid finance identity configuration');
  const seen = new Set();
  return rows.map(row => {
    if (!row || typeof row !== 'object' || Object.keys(row).some(k => !['email','accountUserId','displayName'].includes(k))) throw new Error('Invalid finance identity');
    const {email,accountUserId,displayName} = row;
    if (typeof email !== 'string' || email !== email.trim().toLowerCase() || !/^[^\s@|]+@[^\s@|]+$/u.test(email) || email.length > 254 ||
      typeof displayName !== 'string' || !displayName.trim() || displayName.length > 100 || typeof accountUserId !== 'string') throw new Error('Invalid finance identity');
    const bound = accountUserId === 'email:' + email ||
      (/^feishu_[a-f0-9]{64}$/u.test(accountUserId) && email === accountUserId.slice(0,63) + '@feishu.invalid') ||
      (/^github_[1-9][0-9]{0,31}$/u.test(accountUserId) && email === accountUserId + '@github.invalid');
    if (!bound || seen.has(email) || seen.has(accountUserId)) throw new Error('Finance identity is not uniquely bound');
    seen.add(email); seen.add(accountUserId);
    return {email,accountUserId,displayName:displayName.trim()};
  });
}
