const API_BASE = 'https://www.googleapis.com/youtube/v3';

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parseDurationSeconds(value = '') {
  const match = String(value).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  return asNumber(match[1]) * 3600 + asNumber(match[2]) * 60 + asNumber(match[3]);
}

function candidateFromVideo(video, lane) {
  const snippet = video?.snippet || {};
  const stats = video?.statistics || {};
  return {
    id: String(video?.id || ''),
    url: `https://www.youtube.com/watch?v=${video?.id}`,
    title: snippet.title || '',
    description: snippet.description || '',
    tags: Array.isArray(snippet.tags) ? snippet.tags : [],
    channelId: snippet.channelId || '',
    channelTitle: snippet.channelTitle || '',
    categoryId: snippet.categoryId || '',
    publishedAt: snippet.publishedAt || '',
    durationSec: parseDurationSeconds(video?.contentDetails?.duration),
    viewCount: asNumber(stats.viewCount),
    likeCount: asNumber(stats.likeCount),
    commentCount: asNumber(stats.commentCount),
    lanes: lane ? [lane] : [],
  };
}

export function mergeCandidate(target, incoming) {
  if (!target) return { ...incoming, lanes: [...new Set(incoming.lanes || [])] };
  return {
    ...target,
    ...incoming,
    lanes: [...new Set([...(target.lanes || []), ...(incoming.lanes || [])])],
  };
}

export function mergeCandidates(groups) {
  const merged = new Map();
  for (const group of groups || []) {
    for (const item of group || []) {
      if (!item?.id) continue;
      merged.set(item.id, mergeCandidate(merged.get(item.id), item));
    }
  }
  return [...merged.values()];
}

export class YouTubeApi {
  constructor({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
    if (!apiKey) throw new Error('缺少 YOUTUBE_API_KEY');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(resource, params) {
    const query = new URLSearchParams({ ...params, key: this.apiKey });
    const response = await this.fetchImpl(`${API_BASE}/${resource}?${query}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`YouTube API ${resource} HTTP ${response.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  }

  async popularVideos({ categoryId, regionCode, maxResults = 50 }) {
    const data = await this.request('videos', {
      part: 'snippet,statistics,contentDetails,topicDetails',
      chart: 'mostPopular',
      videoCategoryId: categoryId,
      regionCode,
      maxResults: String(maxResults),
    });
    return (data.items || []).map(video => candidateFromVideo(video, `popular:${regionCode}:${categoryId}`));
  }

  async searchVideos({ query, publishedAfter, order = 'date', regionCode, maxResults = 50 }) {
    const data = await this.request('search', {
      part: 'snippet',
      type: 'video',
      q: query,
      publishedAfter,
      order,
      regionCode,
      maxResults: String(maxResults),
    });
    return (data.items || []).map(item => ({
      id: item?.id?.videoId || '',
      url: `https://www.youtube.com/watch?v=${item?.id?.videoId}`,
      title: item?.snippet?.title || '',
      description: item?.snippet?.description || '',
      channelId: item?.snippet?.channelId || '',
      channelTitle: item?.snippet?.channelTitle || '',
      publishedAt: item?.snippet?.publishedAt || '',
      lanes: [`search:${order}`],
    }));
  }

  async channelUploads({ channel, maxResults = 12 }) {
    const data = await this.request('playlistItems', {
      part: 'snippet,contentDetails',
      playlistId: channel.uploads,
      maxResults: String(maxResults),
    });
    return (data.items || []).map(item => ({
      id: item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId || '',
      url: `https://www.youtube.com/watch?v=${item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId}`,
      title: item?.snippet?.title || '',
      description: item?.snippet?.description || '',
      channelId: channel.id,
      channelTitle: channel.title,
      publishedAt: item?.contentDetails?.videoPublishedAt || item?.snippet?.publishedAt || '',
      lanes: [channel.focused ? 'channel:focused' : 'channel:broad'],
    }));
  }

  async hydrateVideos(candidates) {
    const byId = new Map((candidates || []).map(item => [item.id, item]));
    const ids = [...byId.keys()].filter(Boolean);
    for (let start = 0; start < ids.length; start += 50) {
      const batch = ids.slice(start, start + 50);
      const data = await this.request('videos', {
        part: 'snippet,statistics,contentDetails,topicDetails',
        id: batch.join(','),
        maxResults: '50',
      });
      for (const video of data.items || []) {
        byId.set(video.id, mergeCandidate(byId.get(video.id), candidateFromVideo(video)));
      }
    }
    return [...byId.values()].filter(item => item.title && item.publishedAt);
  }
}

export function ageHours(candidate, now = Date.now()) {
  const published = Date.parse(candidate?.publishedAt || '');
  if (!Number.isFinite(published)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - published) / 3600000);
}

export function hotScore(candidate, now = Date.now()) {
  const age = Math.max(1, ageHours(candidate, now));
  const velocity = asNumber(candidate?.viewCount) / age;
  const focusedBoost = candidate?.lanes?.includes('channel:focused') ? 12 : 0;
  const searchBoost = candidate?.lanes?.some(lane => lane.startsWith('search:')) ? 4 : 0;
  return Math.log10(velocity + 1) * 30
    + Math.log10(asNumber(candidate?.viewCount) + 1) * 8
    + focusedBoost
    + searchBoost;
}
