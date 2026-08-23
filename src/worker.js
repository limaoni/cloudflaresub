import {
  parseNodeLinks,
  parsePreferredEndpoints,
  expandNodes,
  summarizeNodes,
  renderSubscription,
  detectTarget,
  buildShareUrls
} from './core.js';

const HISTORY_INDEX_KEY = 'sub:history:index';
const MAX_HISTORY_ITEMS = 30;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    },
  });
}

function text(body, status = 200, contentType = 'text/plain; charset=utf-8', headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': contentType,
      'access-control-allow-origin': '*',
      ...headers,
    },
  });
}

function createShortId(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

async function createUniqueShortId(env, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const id = createShortId(10);
    const exists = await env.SUB_STORE.get(`sub:${id}`);
    if (!exists) return id;
  }
  throw new Error('无法生成唯一短链接，请稍后再试');
}

function normalizeLines(value = '') {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
    .join('\n');
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function buildDedupHash(body) {
  const normalized = {
    nodeLinks: normalizeLines(body.nodeLinks || ''),
    preferredIps: normalizeLines(body.preferredIps || ''),
    namePrefix: String(body.namePrefix || '').trim(),
    keepOriginalHost: body.keepOriginalHost !== false,
  };
  return sha256Hex(JSON.stringify(normalized));
}

// 记录历史（瘦身版，防止 KV 1MB 限制超限）
async function recordHistory(env, historyItem) {
  try {
    const raw = await env.SUB_STORE.get(HISTORY_INDEX_KEY);
    let list = raw ? JSON.parse(raw) : [];
    // 过滤同 ID 记录，插入最新项
    list = list.filter((item) => item.id !== historyItem.id);
    list.unshift(historyItem);
    if (list.length > MAX_HISTORY_ITEMS) {
      list = list.slice(0, MAX_HISTORY_ITEMS);
    }
    await env.SUB_STORE.put(HISTORY_INDEX_KEY, JSON.stringify(list));
  } catch (e) {
    console.error('Failed to update history index in KV:', e);
  }
}

async function handleGenerate(request, env, url) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  let baseNodes, preferredEndpoints, warnings = [];
  try {
    const parsedNodes = parseNodeLinks(body.nodeLinks || '');
    baseNodes = parsedNodes.nodes;
    warnings.push(...parsedNodes.warnings);

    const parsedEndpoints = parsePreferredEndpoints(body.preferredIps || '');
    preferredEndpoints = parsedEndpoints.endpoints;
    warnings.push(...parsedEndpoints.warnings);
  } catch (err) {
    return json({ ok: false, error: err.message }, 400);
  }

  const options = {
    namePrefix: body.namePrefix || '',
    keepOriginalHost: body.keepOriginalHost !== false,
  };

  const expanded = expandNodes(baseNodes, preferredEndpoints, options);
  const nodes = expanded.nodes;
  warnings.push(...expanded.warnings);

  const createdAt = new Date().toISOString();
  
  // 完整负载：写入单挑订阅的详情 KV
  const payload = {
    version: 1,
    createdAt,
    options,
    nodes,
    inputMeta: {
      nodeLinks: body.nodeLinks,
      preferredIps: body.preferredIps,
      namePrefix: body.namePrefix || '',
      keepOriginalHost: body.keepOriginalHost !== false,
    }
  };

  const dedupHash = await buildDedupHash(body);
  const dedupKey = `dedup:${dedupHash}`;

  let id = await env.SUB_STORE.get(dedupKey);
  const ttl = 60 * 60 * 24 * 30; // 30天有效

  if (!id) {
    id = await createUniqueShortId(env);
    await env.SUB_STORE.put(`sub:${id}`, JSON.stringify(payload), { expirationTtl: ttl });
    await env.SUB_STORE.put(dedupKey, id, { expirationTtl: ttl });
  }

  const accessToken = env.SUB_ACCESS_TOKEN || '';
  const urls = buildShareUrls(url.origin, id, accessToken);

  // 写入历史摘要（丢弃胖文本 inputMeta）
  await recordHistory(env, {
    id,
    createdAt,
    namePrefix: options.namePrefix,
    counts: {
      inputNodes: baseNodes.length,
      preferredEndpoints: preferredEndpoints.length,
      outputNodes: nodes.length,
    },
    urls,
  });

  if (!accessToken) {
    warnings.push('未检测到 SUB_ACCESS_TOKEN，订阅链接将没有第二层访问保护。');
  }

  return json({
    ok: true,
    storage: 'kv',
    shortId: id,
    urls,
    counts: {
      inputNodes: baseNodes.length,
      preferredEndpoints: preferredEndpoints.length,
      outputNodes: nodes.length,
    },
    preview: summarizeNodes(nodes, 20),
    warnings,
  });
}

async function handleGetHistory(env) {
  try {
    const raw = await env.SUB_STORE.get(HISTORY_INDEX_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return json({ ok: true, list });
  } catch (e) {
    return json({ ok: false, error: '读取历史记录失败' }, 500);
  }
}

async function handleGetDetail(url, env) {
  const id = url.searchParams.get('id');
  if (!id) return json({ ok: false, error: '缺少 ID 参数' }, 400);

  try {
    const raw = await env.SUB_STORE.get(`sub:${id}`);
    if (!raw) return json({ ok: false, error: '记录不存在或已过期' }, 404);
    
    const record = JSON.parse(raw);
    return json({ ok: true, inputMeta: record.inputMeta });
  } catch (e) {
    return json({ ok: false, error: '读取详情失败' }, 500);
  }
}

async function handleDeleteHistory(url, env) {
  const id = url.searchParams.get('id');
  if (!id) return json({ ok: false, error: '缺少 ID 参数' }, 400);

  try {
    await env.SUB_STORE.delete(`sub:${id}`);
    const raw = await env.SUB_STORE.get(HISTORY_INDEX_KEY);
    if (raw) {
      let list = JSON.parse(raw);
      list = list.filter((item) => item.id !== id);
      await env.SUB_STORE.put(HISTORY_INDEX_KEY, JSON.stringify(list));
    }
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: '删除记录失败' }, 500);
  }
}

// 通用 /api/ 路由鉴权拦截器
function checkApiAuth(url, request, env) {
  const expected = env.SUB_ACCESS_TOKEN;
  if (!expected) return null; // 服务端未配置，则放行

  const provided = url.searchParams.get('token') || (request.headers.get('Authorization') || '').replace('Bearer ', '');
  if (provided !== expected) {
    return json({ ok: false, error: '无权访问：Token 错误或未提供' }, 403);
  }
  return null;
}

// 订阅客户端拉取链接的专属鉴权
function validateSubToken(url, env) {
  const expected = env.SUB_ACCESS_TOKEN;
  if (!expected) return { ok: true };
  const provided = url.searchParams.get('token') || '';
  if (!provided || provided !== expected) {
    return { ok: false, response: text('Forbidden: invalid token', 403) };
  }
  return { ok: true };
}

async function handleSub(request, url, env) {
  const tokenCheck = validateSubToken(url, env);
  if (!tokenCheck.ok) return tokenCheck.response;

  const id = url.pathname.split('/')[2];
  if (!id) return text('missing id', 400);

  const raw = await env.SUB_STORE.get(`sub:${id}`);
  if (!raw) return text('Subscription not found or expired', 404);

  const record = JSON.parse(raw);
  const nodes = record.nodes || [];

  const ua = request.headers.get('user-agent') || '';
  const explicitTarget = url.searchParams.get('target') || '';
  const finalTarget = detectTarget(ua, explicitTarget);

  const rendered = renderSubscription(finalTarget, nodes, url.toString());

  const extraHeaders = {
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(rendered.filename)}`,
    'Profile-Update-Interval': '24',
    'Subscription-Userinfo': 'upload=0; download=0; total=1073741824000; expire=0',
  };

  return text(rendered.body, 200, rendered.contentType, extraHeaders);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type, authorization',
        },
      });
    }

    // 后台管理 API 统一防护网关
    if (url.pathname.startsWith('/api/')) {
      const authError = checkApiAuth(url, request, env);
      if (authError) return authError;

      if (request.method === 'POST' && url.pathname === '/api/generate') {
        return handleGenerate(request, env, url);
      }
      if (request.method === 'GET' && url.pathname === '/api/history') {
        return handleGetHistory(env);
      }
      if (request.method === 'DELETE' && url.pathname === '/api/history') {
        return handleDeleteHistory(url, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/detail') {
        return handleGetDetail(url, env);
      }
      
      return json({ ok: false, error: '接口不存在' }, 404);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/sub/')) {
      return handleSub(request, url, env);
    }

    return env.ASSETS.fetch(request);
  },
};
