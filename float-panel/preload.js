const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('floatApi', {
  // —— 球窗口 ——
  openPanel:       ()        => ipcRenderer.send('float:open-panel'),
  dragBallStart:   ()        => ipcRenderer.send('float:drag-ball-start'),
  dragBallEnd:     ()        => ipcRenderer.send('float:drag-ball-end'),
  setBallIgnore:   (ignore)  => ipcRenderer.send('float:ball-ignore', ignore),
  onSetCall:       (cb)      => ipcRenderer.on('float:set-call', (_e, v) => cb(v)),
  // —— 面板窗口 ——
  closePanel:      ()        => ipcRenderer.send('float:close-panel'),
  dragPanelStart:  ()        => ipcRenderer.send('float:drag-panel-start'),
  dragPanelEnd:    ()        => ipcRenderer.send('float:drag-panel-end'),
  setCallState:    (active)  => ipcRenderer.send('float:set-call-state', active),
});