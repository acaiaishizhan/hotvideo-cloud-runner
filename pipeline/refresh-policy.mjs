import { extractDouyinItemId } from './video-url.mjs';

export function parseFeishuDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const text = String(value).trim();
  const number = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
  if (Number.isFinite(number) && number <= 0) return null;
  const normalized = Number.isFinite(number) ? (number >= 1e12 ? number : number * 1000)
    : /^\d{4}-\d{2}-\d{2}$/.test(text) ? text + 'T00:00:00+08:00'
      : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : text.replace(' ', 'T') + '+08:00';
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function isWithinRecentDays(value, days, now = new Date()) {
  if (!days) return true;
  const date = parseFeishuDate(value);
  return Boolean(date && date <= now && date >= new Date(now.getTime() - days * 86400000));
}

export function isTrackedRecently({ createdAt, lastSeenAt }, days = 7, now = new Date()) {
  return isWithinRecentDays(createdAt, days, now) || isWithinRecentDays(lastSeenAt, days, now);
}

export function parseRefreshPage(resp, { platform, days = 7, now = new Date(), seenById = {} } = {}) {
  const data = resp?.data;
  if (!resp?.ok || !Array.isArray(data?.fields) || !Array.isArray(data?.data)) throw new Error('飞书记录读取失败: 无效记录页');
  if (data.has_more && !data.data.length) throw new Error('飞书记录读取失败: has_more=true 但返回空页');
  if (!Array.isArray(data.record_id_list) || data.data.length !== data.record_id_list.length) throw new Error('飞书记录读取失败: record_id 数量不匹配');
  const required = ['标题', '视频链接', '发布时间', '平台', '创建时间'];
  if (required.some(x => !data.fields.includes(x))) throw new Error('飞书记录读取失败: 缺少必要字段');
  const items = [], stats = { total: 0, eligible: 0, missingTrackingDate: 0, outsideWindow: 0, missingPublishedAt: 0 };
  for (let i = 0; i < data.data.length; i++) {
    const row = Object.fromEntries(data.fields.map((f, j) => [f, data.data[i][j]]));
    const platforms = Array.isArray(row['平台']) ? row['平台'] : [row['平台']];
    if (!platforms.includes(platform)) continue;
    if (JSON.stringify(row['类型'] || '').includes('人文社科/社科')) continue;
    let url = String(row['视频链接'] || '').trim();
    url = url.match(/\[[^\]]*\]\(([^)]+)\)/)?.[1] || url;
    let id = platform === '抖音' ? extractDouyinItemId(url) : null;
    if (platform === 'YouTube') {
      try { const u = new URL(url); id = u.hostname === 'youtu.be' ? u.pathname.split('/')[1] : /(^|\.)youtube\.com$/.test(u.hostname) ? u.searchParams.get('v') || u.pathname.match(/\/(?:shorts|live)\/([^/]+)/)?.[1] : null; } catch {}
    }
    if (!id || !data.record_id_list[i]) continue;
    stats.total++;
    const createdAt = row['创建时间'];
    const lastSeenAt = [row['最近上榜时间'], seenById[id]?.last_seen, seenById[id]]
      .filter(x => typeof x === 'string' || typeof x === 'number').filter(x => parseFeishuDate(x))
      .sort((a, b) => parseFeishuDate(b) - parseFeishuDate(a))[0];
    if (!parseFeishuDate(row['发布时间'])) stats.missingPublishedAt++;
    if (!parseFeishuDate(createdAt) && !parseFeishuDate(lastSeenAt)) stats.missingTrackingDate++;
    if (!isTrackedRecently({ createdAt, lastSeenAt }, days, now)) { stats.outsideWindow++; continue; }
    items.push({ id, url, recordId: data.record_id_list[i], title: row['标题'] || '', publishedAt: row['发布时间'], createdAt, lastSeenAt, previousMetrics: row });
    stats.eligible++;
  }
  return { items, hasMore: Boolean(data.has_more), stats };
}
