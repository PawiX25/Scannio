const { app, BrowserWindow, ipcMain } = require('electron');
const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const Epub = require('epub-gen');

function safeSend(webContents, channel, ...args) {
  if (webContents && !webContents.isDestroyed()) {
    webContents.send(channel, ...args);
  }
}

const worker = new Worker(path.join(__dirname, 'worker.js'));
let nextJobId = 1;
const pendingJobs = new Map();

worker.on('message', (msg) => {
  const { jobId, type } = msg;
  const job = pendingJobs.get(jobId);
  if (!job) return;
  if (type === 'progress') {
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

ipcMain.handle('convert-pdf', async (event, { arrayBuffer, languages, outputFormat, ocrEngine }) => {
  const sender = event.sender;
  const buffer = Buffer.from(arrayBuffer);
  const jobId = nextJobId++;

  try {
    safeSend(sender, 'conversion-progress', 'Starting conversion...');

    const textPromise = new Promise((resolve, reject) => {
      pendingJobs.set(jobId, { resolve, reject, sender });
    });
    worker.postMessage({ jobId, buffer, languages, ocrEngine });

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

app.whenReady().then(createWindow);

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