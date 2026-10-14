/**
 * 主机服务（全自动版，零依赖）
 *
 * 自动发现与冗余机制：
 *  1. 启动时 + 每隔 BROADCAST_INTERVAL(默认15秒) 自动扫描同网段(/24)，
 *     向每个 IP 的用户端发送 GET /host-online 广播上线，新用户端会被自动发现。
 *  2. 用户端可主动 POST /register 注册自己（双向发现，冗余）。
 *  3. GET /heartbeat 供用户端探活；主机据此判断自身被用户端感知。
 *  4. TTL 清理：超过 TTL(默认45秒) 未刷新的用户端自动移除，防止僵尸记录。
 *  5. 呼叫失败自动重试 3 次。
 *
 * 接口：
 *  POST /broadcast            手动触发一次广播
 *  POST|GET /call {"user":x}  呼叫用户（按钮按下）
 *  POST /ack                  接收用户"收到"回复
 *  POST /register             用户端主动注册 {port, users, name}
 *  GET  /heartbeat            探活
 *  GET  /status               状态查询
 */
'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const HOST_PORT = Number(process.env.HOST_PORT || 8001);
const USER_PORT = Number(process.env.USER_PORT || 9000); // 广播扫描的默认用户端端口
const SCAN_TIMEOUT = Number(process.env.SCAN_TIMEOUT || 1500);
const BROADCAST_INTERVAL = Number(process.env.BROADCAST_INTERVAL || 15000);
const TTL = Number(process.env.TTL || 45000);
const CALL_TIMEOUT = Number(process.env.CALL_TIMEOUT || 60000); // 呼叫等待回复超时
const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 40); // 广播扫描并发上限
const HOST_NAME = process.env.HOST_NAME || os.hostname();

// 复用 TCP 连接，减少每次请求的握手开销
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 60, keepAliveMsecs: 30000 });

/** 已发现的用户端: key=endpointId -> { endpointId, ip, port, users, mac, lastSeen } */
const discovered = new Map();
/** 在线用户: userName -> { endpoint, since } */
const onlineUsers = new Map();
/** 呼叫记录: callId -> { user, target, time, status: waiting|acked|failed, reply, failReason, hint } */
const calls = new Map();
/** 群组: groupName -> Set<mac>（群成员按 MAC 识别，一个 MAC 可加入多个群，持久化到 groups.json） */
const groups = new Map();
/** 已知用户: userName -> { mac, lastSeen }（含离线用户，历史名称） */
const knownUsers = new Map();
/** MAC -> 当前用户名（每次上线刷新，用于群成员显示最新名称） */
const macToUser = new Map();

const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

/* 心跳活体检测：进程被杀后尽快清除，避免僵尸在线记录 */
const HEARTBEAT_INTERVAL = Number(process.env.HEARTBEAT_INTERVAL || 5000);
const HEARTBEAT_FAIL_MAX = Number(process.env.HEARTBEAT_FAIL_MAX || 2);

/* groups 持久化文件：优先 exe 所在目录 */
const STORE_DIR = (() => {
  try {
    const d = path.dirname(process.execPath);
    fs.accessSync(d, fs.constants.W_OK);
    return d;
  } catch (_) { return process.cwd(); }
})();
const GROUPS_FILE = path.join(STORE_DIR, 'groups.json');
const USERS_FILE = path.join(STORE_DIR, 'known_users.json');

function saveGroups() {
  try {
    const obj = {};
    for (const [name, members] of groups) obj[name] = [...members];
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.error('[群组] 保存失败:', e.message); }
}
function loadGroups() {
  try {
    if (!fs.existsSync(GROUPS_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    for (const [name, members] of Object.entries(obj)) {
      // 仅接受 MAC 格式的成员（旧版按用户名存储的群数据直接丢弃）
      const macs = (members || []).filter((m) => MAC_RE.test(String(m).toLowerCase()));
      if (!macs.length) continue;
      groups.set(name, new Set(macs.map((m) => m.toLowerCase())));
    }
    if (groups.size) console.log(`[群组] 已恢复 ${groups.size} 个群（按 MAC）`);
  } catch (e) { console.error('[群组] 读取失败:', e.message); }
}

/* 某个 MAC 所属的所有群名列表 */
function userGroupsByMac(mac) {
  if (!mac) return [];
  const list = [];
  for (const [name, members] of groups) {
    if (members.has(mac)) list.push(name);
  }
  return list;
}

/* 持久化已知用户名 -> MAC，以及 MAC -> 最新名称（host 重启后群成员仍能显示人名） */
let saveKnownTimer = null;
function saveKnown() {
  clearTimeout(saveKnownTimer);
  saveKnownTimer = setTimeout(() => {
    try {
      const users = {};
      for (const [name, info] of knownUsers) users[name] = info.mac;
      fs.writeFileSync(USERS_FILE, JSON.stringify({ users, macName: Object.fromEntries(macToUser) }, null, 2));
    } catch (e) { console.error('[用户] 保存失败:', e.message); }
  }, 2000);
}
function loadKnown() {
  try {
    if (!fs.existsSync(USERS_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    for (const [name, mac] of Object.entries(obj.users || {})) {
      if (mac) knownUsers.set(name, { mac, lastSeen: 0 });
    }
    for (const [mac, name] of Object.entries(obj.macName || {})) {
      macToUser.set(mac, name);
    }
    if (knownUsers.size) console.log(`[用户] 已恢复 ${knownUsers.size} 个已知用户、${macToUser.size} 个 MAC 名称映射`);
  } catch (e) { console.error('[用户] 读取失败:', e.message); }
}

// ---------------- 冗余：进程级保护，防止意外崩溃 ----------------
process.on('uncaughtException', (e) => console.error('[异常] 未捕获异常(已忽略,继续运行):', e.message));
process.on('unhandledRejection', (e) => console.error('[异常] 未处理的Promise拒绝(已忽略):', e && e.message));

// ---------------- 守护：前端(悬浮球)退出后自动结束，避免孤儿进程 ----------------
const PARENT_PID = Number(process.env.PARENT_PID || 0);
if (PARENT_PID > 0) {
  setInterval(() => {
    try {
      process.kill(PARENT_PID, 0); // 信号 0 仅探测父进程是否存活（不存在则抛错）
    } catch (_) {
      console.log('[守护] 前端已退出，本服务自动结束');
      process.exit(0);
    }
  }, 2000);
}

// ---------------- 工具函数 ----------------

function myIp() {
  if (process.env.HOST_IP) return process.env.HOST_IP;
  const list = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
    .filter((ip) => !/^(192\.168\.56\.|192\.168\.99\.|169\.254\.)/.test(ip));
  return list.length ? list[0] : '127.0.0.1';
}

function request(url, { method = 'GET', timeout = SCAN_TIMEOUT, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      url,
      {
        method,
        agent: httpAgent,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (_) { /* 非 JSON */ }
          resolve({ status: res.statusCode, body: json, raw });
        });
      }
    );
    // 覆盖 TCP 连接建立阶段的超时（req.setTimeout 不覆盖 connect，会导致扫描不可达IP时被OS默认SYN重试拖慢）
    req.on('socket', (socket) => {
      socket.setTimeout(timeout);
      socket.once('timeout', () => req.destroy(new Error('timeout')));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 限制并发的 map：items 较大时避免一次性建立全部连接 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (idx < items.length) {
        const cur = idx++;
        results[cur] = await fn(items[cur], cur);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function collectBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildScanTargets() {
  const targets = new Set(['127.0.0.1']);
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  for (const ip of ips) {
    const [a, b, c] = ip.split('.');
    for (let i = 1; i <= 254; i++) targets.add(`${a}.${b}.${c}.${i}`);
  }
  return [...targets];
}

function registerEndpoint(ip, port, users, source, endpointId, seq, mac) {
  // 用 endpointId 作为主键去重：同一台机器多个 IP 只算一个端点
  const key = endpointId || `${ip}:${port}`;
  const prev = discovered.get(key);
  // 忽略乱序到达的旧注册（按序号比较），防止上下线状态抖动
  if (prev && typeof seq === 'number' && typeof prev.seq === 'number' && seq < prev.seq) {
    return;
  }
  const existed = !!prev;
  const macKey = (mac || (prev && prev.mac) || '').toLowerCase();
  discovered.set(key, {
    endpointId: key, ip, port, users: users || [], lastSeen: Date.now(),
    mac: macKey,
    seq: typeof seq === 'number' ? seq : (prev ? prev.seq : 0),
  });
  if (!existed) {
    console.log(`[发现] √ 新用户端接入: ${key} (${ip}:${port}) 用户[${(users || []).join(', ') || '无'}] mac=${macKey || '无'} (来源:${source})`);
  }
  // 记录已知用户（含 MAC），并刷新 MAC -> 当前名称 的映射（群成员显示名随上线更新）
  for (const u of users || []) {
    const p = knownUsers.get(u);
    knownUsers.set(u, { mac: macKey || (p && p.mac) || '', lastSeen: Date.now() });
    if (macKey) macToUser.set(macKey, u);
  }
  saveKnown();
  syncUsers(key, users || [], source);
}

/** 对比用户列表，产生用户上线/下线事件 */
function syncUsers(endpointKey, users, source) {
  const nowSet = new Set(users);
  // 下线：之前在该用户端、现在不在列表里的用户
  for (const [name, info] of onlineUsers) {
    if (info.endpoint === endpointKey && !nowSet.has(name)) {
      onlineUsers.delete(name);
      console.log(`[下线] 用户 ${name} 已下线（用户端 ${endpointKey}）`);
      failCallsForUser(name, '用户已下线');
    }
  }
  // 上线：新出现的用户
  for (const name of nowSet) {
    const prev = onlineUsers.get(name);
    if (!prev) {
      onlineUsers.set(name, { endpoint: endpointKey, since: new Date().toLocaleString() });
      console.log(`[上线] √ 用户 ${name} 已上线（用户端 ${endpointKey}，来源:${source}）`);
    } else if (prev.endpoint !== endpointKey) {
      prev.endpoint = endpointKey; // 用户换了用户端
    }
  }
}

/** 某用户下线时，将其所有等待中的呼叫标记为失败并提示重新呼叫 */
function failCallsForUser(userName, reason) {
  for (const [callId, c] of calls) {
    if (c.user === userName && c.status === 'waiting') {
      c.status = 'failed';
      c.failReason = reason;
      c.hint = '请重新呼叫';
      if (c.timer) clearTimeout(c.timer);
      console.log(`[呼叫] × 对 ${userName} 的呼叫 (${callId}) 失败：${reason}，请重新呼叫`);
    }
  }
}

/** 某用户端整体掉线时，清理其上的用户 */
function dropEndpointUsers(endpointKey, users) {
  for (const name of users || []) {
    const info = onlineUsers.get(name);
    if (info && info.endpoint === endpointKey) {
      onlineUsers.delete(name);
      console.log(`[下线] 用户 ${name} 已下线（用户端 ${endpointKey} 失联）`);
      failCallsForUser(name, '用户已下线');
    }
  }
}

// ---------------- 1. 上线广播（定时自动） ----------------

async function broadcastOnline(silent) {
  const targets = buildScanTargets();
  if (!silent) console.log(`[广播] 扫描 ${targets.length} 个 IP（/24 网段 + 本机），用户端端口 ${USER_PORT} ...`);

  const results = await mapLimit(targets, SCAN_CONCURRENCY, async (ip) => {
    const url =
      `http://${ip}:${USER_PORT}/host-online` +
      `?hostIp=${encodeURIComponent(myIp())}&hostPort=${HOST_PORT}&hostName=${encodeURIComponent(HOST_NAME)}`;
    try {
      const res = await request(url, { timeout: SCAN_TIMEOUT });
      if (res.status === 200 && res.body && res.body.ok) {
        return { ip, ok: true, users: res.body.users || [], endpointId: res.body.endpointId, seq: res.body.seq, mac: res.body.mac };
      }
      return { ip, ok: false };
    } catch (_) {
      return { ip, ok: false };
    }
  });

  const alive = results.filter((r) => r.ok);
  for (const r of alive) {
    registerEndpoint(r.ip, USER_PORT, r.users, '广播', r.endpointId, r.seq, r.mac);
  }
  console.log(`[广播] 完成：存活 ${alive.length} 个，当前已接入用户端 ${discovered.size} 个`);
  return { scanned: results.length, alive: alive.length };
}

// ---------------- TTL 清理（冗余：剔除掉线的用户端） ----------------

setInterval(() => {
  try {
    const now = Date.now();
    for (const [key, v] of discovered) {
      if (now - v.lastSeen > TTL) {
        console.log(`[清理] 用户端 ${key} 超过 ${TTL / 1000}s 未心跳，移除`);
        dropEndpointUsers(key, v.users);
        discovered.delete(key);
      }
    }
  } catch (e) {
    console.error('[清理] 异常:', e.message);
  }
}, 10000);

// ---------------- 心跳活体检测（进程被杀后尽快清除在线用户） ----------------

const failStreak = new Map(); // endpointKey -> 连续失败次数

function checkEndpointAlive() {
  const entries = [...discovered.entries()];
  // 串行探测（端点数量即用户端机器数，通常很少），失败连续 HEARTBEAT_FAIL_MAX 次即移除
  return (async () => {
    for (const [key, v] of entries) {
      try {
        const res = await request(`http://${v.ip}:${v.port}/host-online`, { timeout: 2000 });
        if (res.status === 200 && res.body && res.body.ok) {
          failStreak.delete(key);
          registerEndpoint(v.ip, v.port, res.body.users || [], '心跳', key, res.body.seq, res.body.mac);
          continue;
        }
        throw new Error('bad status');
      } catch (_) {
        const n = (failStreak.get(key) || 0) + 1;
        failStreak.set(key, n);
        if (n >= HEARTBEAT_FAIL_MAX) {
          console.log(`[心跳] 用户端 ${key} 连续 ${n} 次失联，判定下线`);
          failStreak.delete(key);
          dropEndpointUsers(key, v.users);
          discovered.delete(key);
        }
      }
    }
  })().catch((e) => console.error('[心跳] 异常:', e.message));
}
setInterval(checkEndpointAlive, HEARTBEAT_INTERVAL);

// ---------------- 2. 呼叫（失败自动重试3次） ----------------

function findTarget(userName) {
  for (const t of discovered.values()) {
    if (t.users.includes(userName)) return t;
  }
  return null;
}

async function callUser(userName) {
  let target = findTarget(userName);
  if (!target) {
    // 用户可能是新上线的，立即广播一次再找
    await broadcastOnline(true);
    target = findTarget(userName);
  }
  if (!target) {
    throw new Error(`未找到用户 "${userName}"，请确认该用户已登录`);
  }

  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const url =
    `http://${target.ip}:${target.port}/call` +
    `?user=${encodeURIComponent(userName)}&from=${encodeURIComponent(HOST_NAME)}` +
    `&callId=${callId}&hostIp=${encodeURIComponent(myIp())}&hostPort=${HOST_PORT}`;

  // 冗余：发送失败自动重试 3 次（间隔 1s/2s）
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await request(url, { timeout: 3000 });
      if (res.status === 200 && res.body && res.body.ok) {
        const record = {
          user: userName,
          target: `${target.ip}:${target.port}`,
          time: new Date().toLocaleString(),
          status: 'waiting', // waiting -> acked | failed
          reply: null,
          failReason: null,
          hint: null,
          timer: null,
        };
        // 超时未回复 -> 标记失败并提示重新呼叫
        record.timer = setTimeout(() => {
          if (record.status === 'waiting') {
            record.status = 'failed';
            record.failReason = '等待回复超时';
            record.hint = '请重新呼叫';
            console.log(`[呼叫] × 对 ${userName} 的呼叫 (${callId}) 超时未回复，请重新呼叫`);
          }
        }, CALL_TIMEOUT);
        calls.set(callId, record);
        console.log(`[呼叫] 已呼叫 ${userName}（用户端 ${target.ip}:${target.port}），等待回复...`);
        return { callId, user: userName, target: `${target.ip}:${target.port}` };
      }
      lastErr = new Error(res.raw || `HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < 3) {
      console.log(`[呼叫] 第 ${attempt} 次发送失败，${attempt}s 后重试...`);
      await sleep(attempt * 1000);
    }
  }
  throw new Error(`呼叫发送失败(已重试3次): ${lastErr && lastErr.message}`);
}

/** 群发：呼叫群内所有在线成员（按 MAC 匹配在线用户名） */
async function callGroup(groupName) {
  const memberSet = groups.get(groupName);
  if (!memberSet || !memberSet.size) throw new Error(`群 "${groupName}" 不存在或没有成员`);
  const members = [];
  for (const [name, info] of onlineUsers) {
    const ep = discovered.get(info.endpoint);
    const mac = ep ? ep.mac : '';
    if (mac && memberSet.has(mac)) members.push(name);
  }
  if (!members.length) throw new Error(`群 "${groupName}" 没有在线成员`);
  const results = [];
  for (const m of members) {
    try {
      await callUser(m);
      results.push({ user: m, ok: true });
    } catch (e) {
      results.push({ user: m, ok: false, error: e.message });
    }
  }
  return { ok: true, members, results };
}

// ---------------- HTTP 服务 ----------------

const server = http.createServer((req, res) => {
  // CORS：允许浏览器面板(file:// 或任意来源)跨域访问
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    return send(400, { ok: false, error: 'bad url' });
  }

  // 手动触发广播
  if (req.method === 'POST' && url.pathname === '/broadcast') {
    broadcastOnline(false)
      .then((r) => send(200, { ok: true, ...r }))
      .catch((e) => send(500, { ok: false, error: e.message }));
    return;
  }

  // 呼叫用户
  if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/call') {
    collectBody(req).then((body) => {
      const user = body.user || url.searchParams.get('user');
      if (!user) return send(400, { ok: false, error: '缺少 user 参数' });
      callUser(user)
        .then((r) => send(200, { ok: true, ...r }))
        .catch((e) => send(404, { ok: false, error: e.message }));
    });
    return;
  }

  // 接收用户"收到"回复（一个呼叫只接受一个答复）
  if (req.method === 'POST' && url.pathname === '/ack') {
    collectBody(req).then((body) => {
      const c = calls.get(body.callId);
      if (!c) {
        return send(404, { ok: false, error: `未知呼叫: ${body.callId}` });
      }
      if (c.status === 'acked') {
        return send(409, { ok: false, error: '该呼叫已收到答复，不能重复回复' });
      }
      if (c.status === 'failed') {
        return send(410, { ok: false, error: `该呼叫已失效(${c.failReason})，请重新呼叫` });
      }
      if (body.user && body.user !== c.user) {
        return send(403, { ok: false, error: `该呼叫是发给 ${c.user} 的，${body.user} 不能代答` });
      }
      c.status = 'acked';
      c.reply = body.message || '收到';
      if (c.timer) clearTimeout(c.timer);
      console.log(`[回复] √ 用户 ${c.user} 已回复：「${c.reply}」`);
      // 用户端还能回包说明它活着，刷新存活时间
      const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      for (const v of discovered.values()) {
        if (v.ip === remote) v.lastSeen = Date.now();
      }
      send(200, { ok: true });
    });
    return;
  }

  // 用户端下线通知（用户全部登出或进程退出时调用）
  if (req.method === 'POST' && url.pathname === '/bye') {
    collectBody(req).then((body) => {
      const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const port = Number(body.port) || USER_PORT;
      const key = body.endpointId || `${ip}:${port}`;
      const v = discovered.get(key);
      // 该用户端上的用户全部下线
      const users = body.users && body.users.length ? body.users : (v ? v.users : []);
      for (const name of users) {
        const info = onlineUsers.get(name);
        if (info && info.endpoint === key) {
          onlineUsers.delete(name);
          console.log(`[下线] 用户 ${name} 已下线（用户端 ${key} 主动通知）`);
          failCallsForUser(name, '用户已下线');
        }
      }
      discovered.delete(key);
      send(200, { ok: true });
    });
    return;
  }

  // 用户端主动注册（双向发现，冗余）
  if (req.method === 'POST' && url.pathname === '/register') {
    collectBody(req).then((body) => {
      const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const port = Number(body.port) || USER_PORT;
      if (!ip) return send(400, { ok: false, error: '无法识别来源IP' });
      registerEndpoint(ip, port, body.users || [], '主动注册', body.endpointId, body.seq, body.mac);
      send(200, { ok: true, hostName: HOST_NAME });
    });
    return;
  }

  // 探活（用户端定时调用）
  if (req.method === 'GET' && url.pathname === '/heartbeat') {
    return send(200, { ok: true, name: HOST_NAME, time: Date.now() });
  }

  // ============ 群组管理 ============
  if (req.method === 'GET' && url.pathname === '/groups') {
    // 在线 MAC 集合（用于判断群成员与已知用户的在线状态）
    const onlineMacs = new Set();
    for (const [, info] of onlineUsers) {
      const ep = discovered.get(info.endpoint);
      if (ep && ep.mac) onlineMacs.add(ep.mac);
    }
    // 按 MAC 去重的已知用户列表（显示最新名称）
    const known = [];
    const seen = new Set();
    for (const [name, info] of knownUsers) {
      const mac = info.mac;
      if (!mac || seen.has(mac)) continue;
      seen.add(mac);
      known.push({ name: macToUser.get(mac) || name, mac, online: onlineMacs.has(mac) });
    }
    return send(200, {
      ok: true,
      groups: [...groups.entries()].map(([name, members]) => ({
        name,
        members: [...members].map((mac) => ({
          mac,
          name: macToUser.get(mac) || '',
          online: onlineMacs.has(mac),
        })),
      })),
      knownUsers: known,
    });
  }
  if (req.method === 'POST' && url.pathname === '/group/create') {
    collectBody(req).then((body) => {
      const name = (body.name || '').trim();
      if (!name) return send(400, { ok: false, error: '缺少群名' });
      if (groups.has(name)) return send(409, { ok: false, error: '群已存在' });
      groups.set(name, new Set());
      saveGroups();
      send(200, { ok: true });
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/group/add-member') {
    collectBody(req).then((body) => {
      const g = groups.get(body.group);
      const member = String(body.mac || body.name || body.member || '').trim().toLowerCase();
      if (!g) return send(404, { ok: false, error: '群不存在' });
      if (!member) return send(400, { ok: false, error: '缺少成员 MAC' });
      g.add(member);
      saveGroups();
      send(200, { ok: true });
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/group/remove-member') {
    collectBody(req).then((body) => {
      const g = groups.get(body.group);
      if (!g) return send(404, { ok: false, error: '群不存在' });
      g.delete(String(body.mac || body.name || body.member || '').trim().toLowerCase());
      saveGroups();
      send(200, { ok: true });
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/group/delete') {
    collectBody(req).then((body) => {
      groups.delete(body.group);
      saveGroups();
      send(200, { ok: true });
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/call-group') {
    collectBody(req).then((body) => {
      callGroup(body.group)
        .then((r) => send(200, r))
        .catch((e) => send(404, { ok: false, error: e.message }));
    });
    return;
  }

  // 查询单次呼叫状态（前端"按下按钮"后实时跟踪核对结果）
  if (req.method === 'GET' && url.pathname === '/call-status') {
    const callId = url.searchParams.get('callId');
    const c = callId ? calls.get(callId) : null;
    if (!c) return send(404, { ok: false, error: `未知呼叫: ${callId}` });
    return send(200, {
      ok: true,
      callId, user: c.user, target: c.target, time: c.time,
      status: c.status, reply: c.reply, failReason: c.failReason, hint: c.hint,
    });
  }

  // 状态查询
  if (req.method === 'GET' && url.pathname === '/status') {
    return send(200, {
      ok: true,
      name: HOST_NAME,
      ip: myIp(),
      onlineUsers: [...onlineUsers.entries()].map(([name, info]) => {
        const ep = discovered.get(info.endpoint);
        const mac = ep ? ep.mac : '';
        return { name, endpoint: info.endpoint, since: info.since, mac, groups: userGroupsByMac(mac) };
      }),
      groups: [...groups.entries()].map(([name, members]) => ({ name, members: [...members] })),
      discovered: [...discovered.values()].map((v) => ({ ...v, lastSeen: new Date(v.lastSeen).toLocaleString() })),
      calls: [...calls.entries()].map(([callId, c]) => ({
        callId, user: c.user, target: c.target, time: c.time,
        status: c.status, reply: c.reply, failReason: c.failReason, hint: c.hint,
      })),
    });
  }

  send(404, { ok: false, error: 'not found' });
});

server.listen(HOST_PORT, async () => {
  loadGroups();
  loadKnown();
  console.log(`[主机] 服务已启动: http://0.0.0.0:${HOST_PORT}（名称: ${HOST_NAME}，每 ${BROADCAST_INTERVAL / 1000}s 自动广播）`);
  // 上线立即广播一次，之后定时广播（自动发现新上线的用户端）
  try { await broadcastOnline(false); } catch (e) { console.error('[广播] 异常:', e.message); }
  setInterval(() => {
    broadcastOnline(true).catch((e) => console.error('[广播] 异常:', e.message));
  }, BROADCAST_INTERVAL);
});
