const { app, BrowserWindow, ipcMain, net } = require('electron');
const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const Epub = require('epub-gen');

let store = null;
async function initStore() {
  const { default: Store } = await import('electron-store');
  store = new Store({
    defaults: {
      outputFormat: 'epub',
      lmStudioEndpoint: 'http://localhost:1234/v1/chat/completions',
      googleApiKey: '',
      googleModel: '',
      mistralApiKey: '',
      ocrEngine: 'tesseract',
      languages: ['eng'],
      customLanguages: ''
    }
  });
}

function safeSend(webContents, channel, ...args) {
  if (webContents && !webContents.isDestroyed()) {
    webContents.send(channel, ...args);
  }
}

function createWorker() {
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'worker.js'),
    path.join(__dirname, 'worker.js'),
  ];

  const workerPath = candidates.find(p => fs.existsSync(p));
  if (!workerPath) {
    console.error('Unable to locate worker.js in any known location:', candidates);
    return null;
  }

  const w = new Worker(workerPath);
  w.on('online', () => console.log('Worker thread started:', workerPath));
  w.on('error', err => console.error('Worker thread error:', err));
  w.on('exit', code => console.log('Worker thread exited with code', code));
  return w;
}

const worker = createWorker();
let nextJobId = 1;
const pendingJobs = new Map();

worker.on('message', (msg) => {
  const { jobId, type } = msg;
  const job = pendingJobs.get(jobId);
  if (!job) return;
  if (type === 'progress') {
console.log('Worker message', msg.type);
    safeSend(job.sender, 'conversion-progress', msg.text);
  } else if (type === 'done') {
    job.resolve(msg.text);
    pendingJobs.delete(jobId);
  } else if (type === 'error') {
    job.reject(new Error(msg.error));
    pendingJobs.delete(jobId);
  }
});

worker.on('error', (err) => {
  for (const [jobId, job] of pendingJobs.entries()) {
    job.reject(new Error('A fatal worker error occurred.'));
    pendingJobs.delete(jobId);
  }
});

worker.on('exit', (code) => {
  if (code !== 0) {
    console.error(`Worker stopped with exit code ${code}`);
  }
});


function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 10, y: 10 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.on('maximize', () => safeSend(win.webContents, 'window-maximized'));
  win.on('unmaximize', () => safeSend(win.webContents, 'window-unmaximized'));

  win.loadFile('index.html');
}

async function generateEPUB(text, outPath) {
  const pages = text.split(/\n--- Page \d+ ---\n/).filter(Boolean);
  
  const title = pages[0]?.substring(0, 40) || 'Converted Document';

  const content = pages.map((pageText, i) => ({
    title: `Page ${i + 1}`,
    data: pageText.trim(),
  }));

  const options = {
    title,
    author: 'Scannio',
    content,
  };

  await new Epub(options, outPath).promise;
  return outPath;
}

async function generateTXT(text, outPath) {
  await fs.promises.writeFile(outPath, text);
  return outPath;
}

ipcMain.on('minimize-window', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.on('maximize-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win?.isMaximized()) {
    win.unmaximize();
  } else {
    win?.maximize();
  }
});
ipcMain.on('close-window', (event) => BrowserWindow.fromWebContents(event.sender)?.close());
ipcMain.on('cancel-conversion', (event) => {
  const job = Array.from(pendingJobs.values()).find(p => p.sender === event.sender);
  if (job) {
    worker.terminate();
    job.reject(new Error('Conversion cancelled by user.'));
  }
});

ipcMain.handle('get-settings', async () => {
  if (!store) await initStore();
  return store.store;
});

ipcMain.handle('save-setting', async (event, key, value) => {
  if (!store) await initStore();
  store.set(key, value);
  return true;
});

ipcMain.handle('save-settings', async (event, settings) => {
  if (!store) await initStore();
  Object.keys(settings).forEach(key => {
    store.set(key, settings[key]);
  });
  return true;
});

ipcMain.handle('get-google-models', async (event, apiKey) => {
  if (!apiKey) return [];
  return new Promise((resolve) => {
    const request = net.request({
      method: 'GET',
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    });

    let body = '';
    request.on('response', (response) => {
      response.on('data', (chunk) => {
        body += chunk.toString();
      });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.models) {
            const models = data.models
              .filter(m => 
                m.supportedGenerationMethods.includes('generateContent') &&
                m.name.includes('gemini') &&
                (m.name.includes('vision') || m.name.includes('pro'))
              )
              .map(m => ({ name: m.name, displayName: m.displayName }))
              .sort((a, b) => {
                const versionA = parseFloat(a.displayName.match(/[\d\.]+/)?.[0] || '0');
                const versionB = parseFloat(b.displayName.match(/[\d\.]+/)?.[0] || '0');
                if (versionB !== versionA) {
                  return versionB - versionA;
                }
                return b.displayName.localeCompare(a.displayName);
              });
            resolve(models);
          } else {
            console.error('Failed to fetch Google AI models: No models in response', data);
            resolve([]);
          }
        } catch (e) {
          console.error('Failed to parse Google AI models response:', e.message);
          resolve([]);
        }
      });
       response.on('error', (error) => {
        console.error('Error during Google AI models fetch response:', error.message);
        resolve([]);
      });
    });

    request.on('error', (error) => {
      console.error('Failed to fetch Google AI models:', error.message);
      resolve([]);
    });

    request.end();
  });
});

ipcMain.handle('convert-pdf', async (event, { arrayBuffer, languages, outputFormat, ocrEngine, lmStudioEndpoint, googleApiKey, googleModel, mistralApiKey }) => {
  const sender = event.sender;
  const buffer = Buffer.from(arrayBuffer);
  const jobId = nextJobId++;

  try {
    safeSend(sender, 'conversion-progress', 'Starting conversion...');

         const textPromise = new Promise((resolve, reject) => {
       pendingJobs.set(jobId, { resolve, reject, sender });
     });
     worker.postMessage({ jobId, buffer, languages, ocrEngine, lmStudioEndpoint, googleApiKey, googleModel, mistralApiKey });

    const text = await textPromise;
    safeSend(sender, 'conversion-progress', 'Text extracted. Generating output file...');
    const extension = outputFormat === 'epub' ? '.epub' : '.txt';
    const outputPath = path.join(app.getPath('desktop'), `converted_${Date.now()}${extension}`);
    const finalPath = await (outputFormat === 'epub' ? generateEPUB(text, outputPath) : generateTXT(text, outputPath));
    safeSend(sender, 'conversion-progress', 'Done!');
    return finalPath;
  } catch (e) {
    safeSend(sender, 'conversion-progress', `Error: ${e.message}`);
    return null;
  } finally {
    pendingJobs.delete(jobId);
  }
});

app.whenReady().then(async () => {
  await initStore();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});