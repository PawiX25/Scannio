const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  convertPDF: (data) => ipcRenderer.invoke('convert-pdf', data),
  getGoogleModels: (apiKey) => ipcRenderer.invoke('get-google-models', apiKey),
  cancelConversion: () => ipcRenderer.send('cancel-conversion'),
  onConversionProgress: (callback) => ipcRenderer.on('conversion-progress', (_event, value) => callback(value)),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  onWindowMaximized: (callback) => ipcRenderer.on('window-maximized', callback),
  onWindowUnmaximized: (callback) => ipcRenderer.on('window-unmaximized', callback),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSetting: (key, value) => ipcRenderer.invoke('save-setting', key, value),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings)
});
