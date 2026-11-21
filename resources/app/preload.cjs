const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('localPost', {
  isMacDesktop: process.platform === 'darwin',
  chooseOutputDirectory: () => ipcRenderer.invoke('choose-output-directory'),
  openOutputDirectory: directory => ipcRenderer.invoke('open-output-directory', directory),
  saveTextFile: (filename, content) => ipcRenderer.invoke('save-text-file', filename, content),
});
