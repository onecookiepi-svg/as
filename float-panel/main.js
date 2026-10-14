const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

/* Windows 透明窗口（必须在 app ready 之前） */
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.commandLine.appendSwitch('disable-features', 'DCompPresenter');
}

/* ============ 常量 ============ */
const BALL_WIN     = 88;                  // 球窗口尺寸（球 64 + 边距）
const PANEL_PAD    = 12;
const PANEL_WIN_W  = 340 + PANEL_PAD * 2; // 面板窗口尺寸
const PANEL_WIN_H  = 480 + PANEL_PAD * 2;
const EDGE_GAP     = 6;
const DOCK_TOL     = 60;

/* host 服务可执行文件（打包后位于 resources/backend，开发时位于 ../dist） */
const BACKEND_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'backend')
  : path.join(__dirname, '..', 'dist');
const HOST_SCRIPT = path.join(BACKEND_DIR, 'host.js');
const HOST_HTTP = 'http://127.0.0.1:8001';

let ballWin = null;
let panelWin = null;
let dragWin = null;      // 正在拖动的窗口
let dragState = null;
let isQuitting = false;
let tray = null;         // 系统托盘图标
let hostChild = null;    // 后端服务进程引用（退出时杀掉）

/* ============ 单实例：只能运行一个进程 ============ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (ballWin) { ballWin.show(); ballWin.focus(); }
  });

  /* 自动拉起 host 服务 */
  function ensureHostService() {
    const req = http.get(HOST_HTTP + '/status', (res) => { res.resume(); });
    req.on('error', () => {
      if (fs.existsSync(HOST_EXE)) {
       try {
          const child = spawn(process.execPath, [HOST_SCRIPT], {
            detached: true, stdio: 'ignore', windowsHide: true,
            env: { 
              ...process.env, 
              ELECTRON_RUN_AS_NODE: '1', // 关键：让 Electron 以纯 Node 模式运行
              PARENT_PID: String(process.pid),
              USER_DATA_PATH: app.getPath('userData') // 解决 Mac 没权限写文件的问题
            },
          });
          hostChild = child;
          child.unref();
        } catch (_) {}
      }
    });
    req.setTimeout(1500, () => req.destroy());
  }

  /* 退出时杀掉后端服务，避免其滞留为孤儿进程 */
  function killHostService() {
    if (hostChild) {
      try { hostChild.kill(); } catch (_) {}
      hostChild = null;
    }
  }

  function workAreaAt(x, y) {
    return screen.getDisplayNearestPoint({ x, y }).workArea;
  }

  /* ============ 球窗口 ============ */
  function createBallWindow() {
    const wa = screen.getPrimaryDisplay().workArea;
    ballWin = new BrowserWindow({
      width: BALL_WIN,
      height: BALL_WIN,
      x: wa.x + wa.width - BALL_WIN - EDGE_GAP,
      y: wa.y + wa.height - BALL_WIN - EDGE_GAP,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,           // 不占任务栏，入口在系统托盘
      resizable: false,
      hasShadow: false,
      fullscreenable: false,
      show: false,
      backgroundThrottling: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    ballWin.setAlwaysOnTop(true, 'screen-saver');
    ballWin.loadFile(path.join(__dirname, 'renderer/index.html'), { query: { win: 'ball' } });
    ballWin.once('ready-to-show', () => ballWin.show());
    ballWin.on('closed', () => { ballWin = null; });
  }

  /* ============ 面板窗口 ============ */
  function createPanelWindow() {
    const wa = screen.getPrimaryDisplay().workArea;
    panelWin = new BrowserWindow({
      width: PANEL_WIN_W,
      height: PANEL_WIN_H,
      x: wa.x + wa.width - PANEL_WIN_W - EDGE_GAP - BALL_WIN,
      y: wa.y + wa.height - PANEL_WIN_H - EDGE_GAP,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,           // 面板作为弹层，不占任务栏
      resizable: false,
      hasShadow: false,
      fullscreenable: false,
      show: false,
      backgroundThrottling: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    panelWin.setAlwaysOnTop(true, 'screen-saver');
    panelWin.loadFile(path.join(__dirname, 'renderer/index.html'), { query: { win: 'panel' } });
    // 点系统关闭时仅隐藏，不销毁（退出时由 app 统一关闭）
    panelWin.on('close', (e) => {
      if (!isQuitting) { e.preventDefault(); panelWin.hide(); }
    });
    panelWin.on('closed', () => { panelWin = null; });
  }

  /* 把面板窗口定位到球旁边（球在屏幕右半边则面板放左侧，否则右侧） */
  function positionPanel() {
    if (!ballWin || !panelWin) return;
    const b = ballWin.getBounds();
    const wa = workAreaAt(b.x + b.width / 2, b.y + b.height / 2);
    let nx, ny;
    if (b.x + b.width / 2 > wa.x + wa.width / 2) {
      nx = b.x - PANEL_WIN_W - 6;                       // 球在右，面板在左
    } else {
      nx = b.x + b.width + 6;                           // 球在左，面板在右
    }
    nx = Math.max(wa.x + 8, Math.min(nx, wa.x + wa.width - PANEL_WIN_W - 8));
    ny = b.y + b.height / 2 - PANEL_WIN_H / 2;
    ny = Math.max(wa.y + 8, Math.min(ny, wa.y + wa.height - PANEL_WIN_H - 8));
    panelWin.setPosition(Math.round(nx), Math.round(ny));
  }

  /* ============ IPC ============ */
  // 球窗口
  ipcMain.on('float:ball-ignore', (e, ignore) => {
    if (ballWin) ballWin.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  ipcMain.on('float:drag-ball-start', () => {
    if (!ballWin) return;
    dragWin = ballWin;
    dragState = { offsetX: screen.getCursorScreenPoint().x - ballWin.getBounds().x,
                  offsetY: screen.getCursorScreenPoint().y - ballWin.getBounds().y };
    dragState.timer = setInterval(() => {
      if (!dragState || !ballWin) return;
      const p = screen.getCursorScreenPoint();
      ballWin.setPosition(p.x - dragState.offsetX, p.y - dragState.offsetY);
    }, 16);
  });
  ipcMain.on('float:drag-ball-end', dockBall);
  function dockBall() {
    if (!dragState) return;
    clearInterval(dragState.timer);
    dragState = null;
    if (!ballWin) return;
    const b = ballWin.getBounds();
    const wa = workAreaAt(b.x + b.width / 2, b.y + b.height / 2);
    const d = {
      left:   Math.abs(b.x - wa.x),
      right:  Math.abs(wa.x + wa.width - (b.x + b.width)),
      top:    Math.abs(b.y - wa.y),
      bottom: Math.abs(wa.y + wa.height - (b.y + b.height)),
    };
    let best = null, min = Infinity;
    for (const k of ['left', 'right', 'top', 'bottom']) if (d[k] < min) { min = d[k]; best = k; }
    if (min > DOCK_TOL) return;
    const pos = {};
    if (best === 'right')  pos.x = wa.x + wa.width - BALL_WIN - EDGE_GAP;
    if (best === 'left')   pos.x = wa.x + EDGE_GAP;
    if (best === 'bottom') pos.y = wa.y + wa.height - BALL_WIN - EDGE_GAP;
    if (best === 'top')    pos.y = wa.y + EDGE_GAP;
    ballWin.setPosition(pos.x !== undefined ? pos.x : b.x, pos.y !== undefined ? pos.y : b.y);
  }

  // 面板窗口
  ipcMain.on('float:open-panel', () => {
    if (!panelWin) return;
    positionPanel();
    panelWin.show();
    panelWin.moveTop();
  });
  ipcMain.on('float:close-panel', () => {
    if (panelWin) panelWin.hide();
  });
  ipcMain.on('float:drag-panel-start', () => {
    if (!panelWin) return;
    const p = screen.getCursorScreenPoint();
    const b = panelWin.getBounds();
    dragState = { offsetX: p.x - b.x, offsetY: p.y - b.y };
    dragState.timer = setInterval(() => {
      if (!dragState || !panelWin) return;
      const c = screen.getCursorScreenPoint();
      panelWin.setPosition(c.x - dragState.offsetX, c.y - dragState.offsetY);
    }, 16);
  });
  ipcMain.on('float:drag-panel-end', () => {
    if (dragState) { clearInterval(dragState.timer); dragState = null; }
  });

  // 呼叫状态：面板 -> 球（球变红提示）
  ipcMain.on('float:set-call-state', (e, active) => {
    if (ballWin && !ballWin.isDestroyed()) {
      ballWin.webContents.send('float:set-call', !!active);
    }
  });

  /* ============ 系统托盘 ============ */
  function createTray() {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
    tray = new Tray(icon);
    tray.setToolTip(os.hostname());
    tray.on('click', () => {
      if (!panelWin) return;
      if (panelWin.isVisible()) panelWin.hide();
      else { positionPanel(false); panelWin.show(); panelWin.moveTop(); }
    });
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开面板', click: () => { positionPanel(false); panelWin.show(); panelWin.moveTop(); } },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit(); } },
    ]));
  }

  /* ============ 启动 ============ */
  app.whenReady().then(() => {
    ensureHostService();
    const delay = process.platform === 'win32' ? 200 : 0;
    setTimeout(() => {
      createBallWindow();
      createPanelWindow();
      createTray();
    }, delay);
  });

  app.on('before-quit', () => { isQuitting = true; killHostService(); });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) { createBallWindow(); createPanelWindow(); }
  });
}
