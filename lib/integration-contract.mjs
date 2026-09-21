export function safeWebmailUrl(value) {
  try {
    if (typeof value !== "string" || !value.trim() || value.length > 2_048) return "";
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}
