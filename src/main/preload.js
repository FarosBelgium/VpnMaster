// Narrow, explicit bridge between the UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch, fn) => {
  const listener = (_e, ...a) => fn(...a);
  ipcRenderer.on(ch, listener);
  return () => ipcRenderer.removeListener(ch, listener);
};

contextBridge.exposeInMainWorld('api', {
  vpns: {
    list: () => invoke('vpns:list'),
    save: (v) => invoke('vpns:save', v),
    remove: (id) => invoke('vpns:delete', id),
    move: (id, to) => invoke('vpns:move', id, to),
  },
  cisco: {
    info: () => invoke('cisco:info'),
    status: () => invoke('cisco:status'),
    connect: (ref, opts) => invoke('cisco:connect', ref, opts),
    answer: (id, value, save) => invoke('cisco:answer', id, value, save),
    cancel: () => invoke('cisco:cancel'),
    disconnect: () => invoke('cisco:disconnect'),
    openApp: () => invoke('cisco:openApp'),
    onStatus: (fn) => on('status', fn),
    onStart: (fn) => on('connect:start', fn),
    onOutput: (fn) => on('connect:output', fn),
    onPrompt: (fn) => on('connect:prompt', fn),
    onDone: (fn) => on('connect:done', fn),
    onTrayConnect: (fn) => on('tray:connect', fn),
    onUpdated: (fn) => on('cisco:updated', fn),
    setAutoConnect: (v) => invoke('settings:set', 'autoConnect', v),
  },
  store: {
    info: () => invoke('store:info'),
    reveal: () => invoke('store:reveal'),
  },
  updates: {
    status: () => invoke('update:status'),
    check: () => invoke('update:check'),
    install: () => invoke('update:install'),
    onStatus: (fn) => on('update:status', fn),
  },
  openExternal: (url) => invoke('app:openExternal', url),
});
