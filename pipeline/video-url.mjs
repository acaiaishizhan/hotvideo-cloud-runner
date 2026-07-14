export function extractDouyinItemId(value) {
  if (value == null) return null;
  let raw = String(value).trim();
  const markdownMatch = raw.match(/\[[^\]]*]\(([^)]+)\)/);
  if (markdownMatch) raw = markdownMatch[1];

  const decoded = (() => {
    try { return decodeURIComponent(raw); } catch { return raw; }
  })();

  if (/^\d{10,}$/.test(decoded)) return decoded;
  const match = decoded.match(/(?:\/video\/|[?&](?:modal_id|item_id|itemId|aweme_id)=)(\d{10,})/);
  return match ? match[1] : null;
}

export function videoRecordKey(value) {
  if (value == null) return '';
  let raw = String(value).trim();
  if (!raw) return '';
  const markdownMatch = raw.match(/\[[^\]]*]\(([^)]+)\)/);
  if (markdownMatch) raw = markdownMatch[1].trim();
  const itemId = extractDouyinItemId(raw);
  return itemId ? `douyin:${itemId}` : `url:${raw}`;
}
