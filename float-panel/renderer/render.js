const params = new URLSearchParams(location.search);
const WIN = params.get('win') || 'panel';

const ball  = document.getElementById('ball');
const stage = document.getElementById('stage');
const panel = document.getElementById('panel');

if (WIN === 'ball') {
  initBall();
} else {
  initPanel();
}

/* ============ 球窗口 ============ */
function initBall() {
  panel.classList.add('hidden');

  let dragging = false;
  function applyIgnore(x, y) {
    if (dragging || x == null) return;
    const el = document.elementFromPoint(x, y);
    const hit = !!(el && el.closest && el.closest('[data-hit]'));
    window.floatApi.setBallIgnore(!hit);
  }
  window.addEventListener('mousemove', (e) => applyIgnore(e.clientX, e.clientY));
  window.floatApi.setBallIgnore(true);

  ball.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const dx = e.screenX, dy = e.screenY;
    let moved = false;
    const onMove = (ev) => {
      if (!moved && Math.hypot(ev.screenX - dx, ev.screenY - dy) > 4) {
        moved = true;
        dragging = true;
        ball.classList.add('dragging');
        window.floatApi.dragBallStart();
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (moved) {
        window.floatApi.dragBallEnd();
        dragging = false;
        ball.classList.remove('dragging');
      } else {
        window.floatApi.openPanel();
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  window.floatApi.onSetCall((active) => {
    ball.classList.toggle('has-call', !!active);
  });
}

/* ============ 面板窗口 ============ */
function initPanel() {
  stage.classList.add('hidden');
  panel.classList.remove('hidden');

  const closeBtn    = document.getElementById('close');
  const settingsBtn = document.getElementById('settingsBtn');
  const hostTitle   = document.getElementById('hostTitle');
  const tabsEl      = document.querySelector('.tabs');
  const tabUsers    = document.getElementById('tabUsers');
  const tabGroups   = document.getElementById('tabGroups');
  const settingsView = document.getElementById('settingsView');
  const userView    = document.getElementById('userView');
  const groupView   = document.getElementById('groupView');
  const toast       = document.getElementById('toast');
  const userList    = document.getElementById('userList');
  const emptyState  = document.getElementById('emptyState');
  const groupList   = document.getElementById('groupList');
  const hostAddrEl  = document.getElementById('hostAddr');
  const backBtn      = document.getElementById('backBtn');
  const groupListPane   = document.getElementById('groupListPane');
  const groupCreatePane = document.getElementById('groupCreatePane');
  const groupDetailPane = document.getElementById('groupDetailPane');
  const newGroupBtn     = document.getElementById('newGroupBtn');
  const createBackBtn   = document.getElementById('createBackBtn');
  const createGroupBtn  = document.getElementById('createGroupBtn');
  const detailBackBtn   = document.getElementById('detailBackBtn');
  const groupDetailName = document.getElementById('groupDetailName');
  const groupMemberList = document.getElementById('groupMemberList');
  const memberAddList   = document.getElementById('memberAddList');
  const deleteGroupBtn  = document.getElementById('deleteGroupBtn');
  const newGroupName    = document.getElementById('newGroupName');
  const connDot      = document.getElementById('connDot');
  const statusText   = document.getElementById('statusText');

  let hostAddr = localStorage.getItem('floatHost') || '';
  hostAddrEl.value = hostAddr;
  const apiBase = () => 'http://' + (hostAddr || '127.0.0.1:8001');

  const callState = new Map();
  const TERMINAL_KEEP_MS = 8000;
  let groupData = [];
  let knownUsers = [];
  let lastGroupCall = null;
  let lastOnlineUsers = [];
  let activeTab = 'users';   // 记录当前所在标签，返回时按它恢复视图

  /* 呼叫/群发的二次确认态：第一次点击仅"武装"，再点一次才真正发起 */
  const armMap = new Map();
  function isArmed(key) { return armMap.has(key); }
  function armKey(key, ttl) { clearTimeout(armMap.get(key)); const t = setTimeout(() => armMap.delete(key), ttl); armMap.set(key, t); }
  function disarmKey(key) { clearTimeout(armMap.get(key)); armMap.delete(key); }

  async function json(path, opts = {}) {
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const res = await fetch(apiBase() + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  let toastTimer = null;
  function showToast(msg, type) {
    toast.textContent = msg;
    toast.classList.remove('hidden', 'waiting', 'acked', 'failed');
    toast.classList.add(type);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 6000);
  }

  /* ============ 视图切换 ============ */
  function showTab(tab) {
    activeTab = tab;
    const users = tab === 'users';
    tabUsers.classList.toggle('active', users);
    tabGroups.classList.toggle('active', !users);
    userView.classList.toggle('hidden', !users);
    groupView.classList.toggle('hidden', users);
    if (!users) { currentGroup = null; showGroupPane('list'); refreshGroups(); }
  }

  /* 进入设置：隐藏 tabs 和两个列表；返回：按 activeTab 只恢复对应视图 */
  function showSettings(on) {
    if (on) {
      tabsEl.classList.add('hidden');
      userView.classList.add('hidden');
      groupView.classList.add('hidden');
      settingsView.classList.remove('hidden');
    } else {
      settingsView.classList.add('hidden');
      tabsEl.classList.remove('hidden');
      showTab(activeTab);   // 关键：只显示当前 tab 对应的视图
    }
  }

  tabUsers.addEventListener('click', () => showTab('users'));
  tabGroups.addEventListener('click', () => showTab('groups'));
  settingsBtn.addEventListener('click', () => showSettings(true));
  backBtn.addEventListener('click', () => showSettings(false));
  closeBtn.addEventListener('click', () => window.floatApi.closePanel());

  /* ============ 状态轮询 ============ */
  async function pollStatus() {
    let r;
    try {
      r = await json('/status');
      connDot.className = 'conn-dot on';
      statusText.textContent = '已连接 · ' + (r.ip || '');
    } catch (_) {
      connDot.className = 'conn-dot off';
      statusText.textContent = '无法连接主机';
      renderUsers(null);
      return;
    }
    hostTitle.textContent = r.name || '主机';
    mergeCalls(r.calls || []);
    renderUsers(r.onlineUsers || []);

    if (lastGroupCall) {
      const waiters = (r.onlineUsers || []).filter((u) => {
        const st = callState.get(u.name);
        return st && st.status === 'waiting' && lastGroupCall.users.includes(u.name);
      });
      if (!waiters.length) {
        showToast('群「' + lastGroupCall.group + '」已处理完毕', 'acked');
        lastGroupCall = null;
      }
    }
    let hasWaiting = false;
    for (const st of callState.values()) if (st.status === 'waiting') { hasWaiting = true; break; }
    window.floatApi.setCallState(hasWaiting);
  }

  function mergeCalls(calls) {
    for (const c of calls) {
      const prev = callState.get(c.user);
      if (!prev || prev.callId === c.callId) {
        const changed = !prev || prev.status !== c.status;
        callState.set(c.user, { callId: c.callId, status: c.status, reply: c.reply, failReason: c.failReason, at: changed ? Date.now() : prev.at });
      } else if (!prev.callId || c.callId > prev.callId) {
        callState.set(c.user, { callId: c.callId, status: c.status, reply: c.reply, failReason: c.failReason, at: Date.now() });
      }
    }
  }

  /* ============ 渲染用户（独立列表，不分组） ============ */
  const AVATAR_COLORS = 6;
  function avatarClass(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return 'c' + (h % AVATAR_COLORS);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderUsers(users) {
    lastOnlineUsers = users;
    if (users === null) {
      userList.innerHTML = '';
      emptyState.classList.remove('hidden');
      emptyState.querySelector('p').textContent = '无法连接主机';
      emptyState.querySelector('span').textContent = '请检查主机服务是否已启动';
      return;
    }
    if (!users.length) {
      userList.innerHTML = '';
      emptyState.classList.remove('hidden');
      emptyState.querySelector('p').textContent = '暂无在线用户';
      emptyState.querySelector('span').textContent = '等待用户端上线…';
      return;
    }
    emptyState.classList.add('hidden');

    const now = Date.now();
    userList.innerHTML = users.map((u) => {
      const st = callState.get(u.name);
      const gtags = (u.groups || []).map((g) => `<span class="gtag">${esc(g)}</span>`).join('');
      let btn, sub;
      if (st && st.status === 'waiting') {
        btn = `<button class="call-btn waiting" disabled>呼叫中…</button>`;
        sub = '';
      } else if (st && st.status === 'acked' && now - st.at < TERMINAL_KEEP_MS) {
        btn = `<button class="call-btn acked" disabled>✓ 已回复</button>`;
        sub = '回复：' + esc(st.reply || '收到');
      } else if (st && st.status === 'failed' && now - st.at < TERMINAL_KEEP_MS) {
        btn = `<button class="call-btn failed" data-call="${esc(u.name)}">重新呼叫</button>`;
        sub = esc(st.failReason || '呼叫失败');
      } else if (isArmed('user:' + u.name)) {
        btn = `<button class="call-btn armed" data-call="${esc(u.name)}">确认呼叫？</button>`;
        sub = '再点一次发起呼叫';
      } else {
        btn = `<button class="call-btn" data-call="${esc(u.name)}">呼叫</button>`;
        sub = esc((u.since || '').split(' ').pop());
      }
      return `<div class="user-row">
        <div class="avatar ${avatarClass(u.name)}">${esc((u.name[0] || '?').toUpperCase())}</div>
        <div class="user-info">
          <div class="user-name-wrap">${esc(u.name)} ${gtags}</div>
          <div class="user-sub">${sub}</div>
        </div>
        ${btn}
      </div>`;
    }).join('');
  }

  /* ============ 单个呼叫 ============ */
  userList.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-call]');
    if (!b) return;
    const user = b.getAttribute('data-call');
    if (!isArmed('user:' + user)) {
      armKey('user:' + user, 2500);
      showToast('再点一次确认呼叫 ' + user, 'waiting');
      renderUsers(lastOnlineUsers);
      return;
    }
    disarmKey('user:' + user);
    callState.set(user, { callId: null, status: 'waiting', at: Date.now() });
    try {
      const r = await json('/call', { method: 'POST', body: JSON.stringify({ user }) });
      if (r.ok) { callState.set(user, { callId: r.callId, status: 'waiting', at: Date.now() }); showToast('已呼叫 ' + user + '，等待接收…', 'waiting'); }
      else { callState.set(user, { callId: null, status: 'failed', failReason: r.error, at: Date.now() }); showToast('呼叫 ' + user + ' 失败：' + r.error, 'failed'); }
    } catch (err) {
      callState.set(user, { callId: null, status: 'failed', failReason: '请求失败', at: Date.now() });
      showToast('呼叫 ' + user + ' 失败', 'failed');
    }
    setTimeout(pollStatus, 1200);
  });

  /* ============ 群视图（二级界面：列表 → 新建群 / 群详情） ============ */
  let currentGroup = null;

  function showGroupPane(pane) {
    groupListPane.classList.toggle('hidden', pane !== 'list');
    groupCreatePane.classList.toggle('hidden', pane !== 'create');
    groupDetailPane.classList.toggle('hidden', pane !== 'detail');
  }

  async function refreshGroups() {
    try {
      const r = await json('/groups');
      groupData = r.groups || [];
      knownUsers = r.knownUsers || [];
      renderGroupList();
      if (currentGroup) renderGroupDetail();
    } catch (e) {
      groupList.innerHTML = '<div class="settings-hint">无法连接主机</div>';
    }
  }

  function renderGroupList() {
    if (!groupData.length) {
      groupList.innerHTML = '<div class="empty-small">暂无群聊，点右上角「新建群」创建</div>';
      return;
    }
    groupList.innerHTML = groupData.map((g) => {
      const members = g.members || [];
      const online = members.filter((m) => m.online).length;
      return `<div class="group-row" data-open="${esc(g.name)}">
        <div class="group-avatar">${esc((g.name[0] || '#').toUpperCase())}</div>
        <div class="group-row-info">
          <div class="group-row-name">${esc(g.name)}</div>
          <div class="group-row-count">${online}/${members.length} 人在线</div>
        </div>
        <button class="group-call-btn" data-groupcall="${esc(g.name)}">群发</button>
      </div>`;
    }).join('');
  }

  function renderGroupDetail() {
    const g = groupData.find((x) => x.name === currentGroup);
    if (!g) { currentGroup = null; showGroupPane('list'); return; }
    groupDetailName.textContent = g.name;
    const members = g.members || [];
    const sorted = [...members].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
    groupMemberList.innerHTML = sorted.map((m) => {
      const disp = m.name || m.mac;
      return `<div class="member-line ${m.online ? 'on' : 'off'}">
        <span class="member-dot"></span>
        <span class="member-name">${esc(disp)}</span>
        ${m.mac ? `<span class="member-mac">${esc(m.mac)}</span>` : ''}
        <button class="member-x" data-rm="${esc(m.mac)}">移除</button>
      </div>`;
    }).join('') || '<div class="settings-hint">暂无成员</div>';

    const memberMacs = new Set(members.map((m) => m.mac));
    memberAddList.innerHTML = (knownUsers || []).map((u) => {
      const disp = u.name || u.mac;
      if (memberMacs.has(u.mac)) {
        return `<div class="add-user-line"><span class="member-dot ${u.online ? 'on' : 'off'}"></span><span class="member-name">${esc(disp)}</span><span class="joined">已加入</span></div>`;
      }
      return `<div class="add-user-line"><span class="member-dot ${u.online ? 'on' : 'off'}"></span><span class="member-name">${esc(disp)}</span><button class="mini-btn" data-join="${esc(u.mac)}">加入</button></div>`;
    }).join('') || '<div class="settings-hint">暂无可加入的用户（等待用户端登录后被记录）</div>';
  }

  function openGroup(name) {
    currentGroup = name;
    renderGroupDetail();
    showGroupPane('detail');
  }

  /* 一级：群列表点击（打开详情 / 群发） */
  groupList.addEventListener('click', async (e) => {
    const gc = e.target.closest('[data-groupcall]');
    if (gc) {
      const grp = gc.getAttribute('data-groupcall');
      // 二次确认防误触
      if (gc.dataset.armed !== '1') {
        gc.dataset.armed = '1';
        gc.classList.add('armed');
        gc.textContent = '确认群发？';
        clearTimeout(gc._t);
        gc._t = setTimeout(() => { delete gc.dataset.armed; gc.classList.remove('armed'); gc.textContent = '群发'; }, 3000);
        return;
      }
      clearTimeout(gc._t);
      gc.classList.remove('armed');
      gc.textContent = '群发';
      delete gc.dataset.armed;
      try {
        const r = await json('/call-group', { method: 'POST', body: JSON.stringify({ group: grp }) });
        for (const m of r.members) callState.set(m, { callId: null, status: 'waiting', at: Date.now() });
        lastGroupCall = { group: grp, users: r.members };
        const g = groupData.find((x) => x.name === grp);
        const total = (g && g.members && g.members.length) || r.members.length;
        const skipped = Math.max(0, total - r.members.length);
        showToast('已群发「' + grp + '」在线 ' + r.members.length + ' 人' + (skipped ? '，离线 ' + skipped + ' 人已跳过' : ''), 'waiting');
      } catch (err) { showToast('群发失败：' + err.message, 'failed'); }
      setTimeout(pollStatus, 1200);
      return;
    }
    const row = e.target.closest('[data-open]');
    if (row) openGroup(row.getAttribute('data-open'));
  });

  /* 二级：新建群 */
  newGroupBtn.addEventListener('click', () => {
    newGroupName.value = '';
    showGroupPane('create');
  });
  createBackBtn.addEventListener('click', () => showGroupPane('list'));
  createGroupBtn.addEventListener('click', async () => {
    const name = newGroupName.value.trim();
    if (!name) { newGroupName.focus(); return; }
    try {
      await json('/group/create', { method: 'POST', body: JSON.stringify({ name }) });
      newGroupName.value = '';
      showGroupPane('list');
      await refreshGroups();
    } catch (e) { showToast('新建群失败：' + e.message, 'failed'); }
  });

  /* 二级：群详情（移除 / 添加 / 删除群，删除与移除均二次确认） */
  detailBackBtn.addEventListener('click', () => { currentGroup = null; showGroupPane('list'); });

  async function doRemoveMember(mac) {
    await json('/group/remove-member', { method: 'POST', body: JSON.stringify({ group: currentGroup, mac }) });
    await refreshGroups();
  }

  groupMemberList.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (!rm) return;
    const mac = rm.getAttribute('data-rm');
    if (rm.dataset.armed !== '1') {
      rm.dataset.armed = '1';
      rm.classList.add('armed');
      rm.textContent = '确认移除？';
      clearTimeout(rm._t);
      rm._t = setTimeout(() => { delete rm.dataset.armed; rm.classList.remove('armed'); rm.textContent = '移除'; }, 3000);
      return;
    }
    clearTimeout(rm._t);
    await doRemoveMember(mac);
  });

  memberAddList.addEventListener('click', async (e) => {
    const jb = e.target.closest('[data-join]');
    if (!jb) return;
    const mac = jb.getAttribute('data-join');
    await json('/group/add-member', { method: 'POST', body: JSON.stringify({ group: currentGroup, mac }) });
    await refreshGroups();
  });

  let delArmed = false, delTimer = null;
  function resetDelBtn() {
    delArmed = false;
    clearTimeout(delTimer);
    deleteGroupBtn.textContent = '删除群';
    deleteGroupBtn.classList.remove('armed');
  }
  deleteGroupBtn.addEventListener('click', async () => {
    if (!delArmed) {
      delArmed = true;
      deleteGroupBtn.textContent = '确认删除？';
      deleteGroupBtn.classList.add('armed');
      delTimer = setTimeout(resetDelBtn, 3000);
      return;
    }
    resetDelBtn();
    await json('/group/delete', { method: 'POST', body: JSON.stringify({ group: currentGroup }) });
    currentGroup = null;
    showGroupPane('list');
    await refreshGroups();
  });

  /* ============ IP 配置 ============ */
  hostAddrEl.addEventListener('change', () => {
    hostAddr = hostAddrEl.value.trim();
    localStorage.setItem('floatHost', hostAddr);
    pollStatus();
  });

  /* ============ 拖动面板 ============ */
  document.querySelector('.panel-header').addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    window.floatApi.dragPanelStart();
    const onUp = () => { document.removeEventListener('mouseup', onUp); window.floatApi.dragPanelEnd(); };
    document.addEventListener('mouseup', onUp);
  });

  /* ============ 轮询 ============ */
  pollStatus();
  setInterval(pollStatus, 1500);
}
