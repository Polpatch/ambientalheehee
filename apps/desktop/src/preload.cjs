const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ambiental', Object.freeze({
  loadInitialScenario: () => ipcRenderer.invoke('ambiental:scenario'),
  chooseScenario: (text) => ipcRenderer.invoke('ambiental:choose', text),
  resolveSource: (index) => ipcRenderer.invoke('ambiental:resolve', index),
  quit: () => ipcRenderer.invoke('ambiental:quit'),
  chooseLocalAudio: () => ipcRenderer.invoke('ambiental:choose-local-audio'),
  prepareAudio: (source) => ipcRenderer.invoke('ambiental:prepare-audio', source),
  releasePreparedAudio: (token) => ipcRenderer.invoke('ambiental:release-audio', token),
  embedAudio: (source) => ipcRenderer.invoke('ambiental:embed-audio', source),
  saveWav: (source, suggestedName) => ipcRenderer.invoke('ambiental:save-wav', source, suggestedName),
  saveScenario: (json, suggestedName, outputKinds) => ipcRenderer.invoke('ambiental:save-scenario', json, suggestedName, outputKinds),
  onSaveProgress: (listener) => {
    const callback = (_event, progress) => listener(progress);
    ipcRenderer.on('ambiental:save-progress', callback);
    return () => ipcRenderer.removeListener('ambiental:save-progress', callback);
  },
}));
