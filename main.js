const { app, BrowserWindow, ipcMain } = require('electron');
const { Worker } = require('worker_threads');
const os = require('os');
function safeSend(webContents, channel, ...args) {
  try {
    if (!webContents.isDestroyed()) {
      webContents.send(channel, ...args);
    } 
  } catch (_) {
  }
}
const fs = require('fs');
const path = require('path');
const { PDFiumLibrary } = require('@hyzyla/pdfium');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const Epub = require('epub-gen');
const url = require('url');

const cmapDir = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'cmaps');
const standardFontsDir = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'standard_fonts');

const cmapUrl = url.pathToFileURL(cmapDir).href + '/';
const standardFontDataUrl = url.pathToFileURL(standardFontsDir).href + '/';

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
    pendingJobs.delete(jobId);
    job.resolve(msg.text);
  } else if (type === 'error') {
    pendingJobs.delete(jobId);
    job.reject(new Error(msg.error));
  }
});
worker.on('error', (err) => {
  console.error('Worker thread error:', err);
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

  win.on('maximize', () => {
    win.webContents.send('window-maximized');
  });
  win.on('unmaximize', () => {
    win.webContents.send('window-unmaximized');
  });

  win.loadFile('index.html');
}

async function extractTextFromPDF(buffer, languages, sender) {
safeSend(sender, 'conversion-progress', 'Checking for text layer in PDF...');
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await getDocument({ data: buffer, cMapUrl, cMapPacked: true, standardFontDataUrl }).promise;
    let fullText = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      if (textContent.items.length === 0) {
        throw new Error('No text layer found. Falling back to OCR.');
      }
      const pageText = textContent.items.map(item => item.str).join(' ');
      fullText += `\n--- Page ${i} ---\n` + pageText;
    }
safeSend(sender, 'conversion-progress', 'Text layer found! Extracting text directly.');
    return fullText;
  } catch (e) {
safeSend(sender, 'conversion-progress', 'No text layer found. Starting OCR process...');
    return extractTextWithOCR(buffer, languages, sender);
  }
}

async function extractTextWithOCR(buffer, languages, sender) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scannio-ocr-'));
  let library;
  try {
safeSend(sender, 'conversion-progress', 'Converting PDF to images with PDFium...');
    library = await PDFiumLibrary.init();
    const document = await library.loadDocument(buffer);

async function renderPage(page) {
      const image = await page.render({
        scale: 3,
        render: (options) => sharp(options.data, {
          raw: {
            width: options.width,
            height: options.height,
            channels: 4,
          },
        }).png().toBuffer(),
      });
      return { content: Buffer.from(image.data) };
}

const renderPromises = [];
for (const page of document.pages()) {
  renderPromises.push(renderPage(page));
}

    const pngPages = await Promise.all(renderPromises);

    document.destroy();

    const pageCount = pngPages.length;
safeSend(sender, 'conversion-progress', `Found ${pageCount} pages. Starting OCR with languages: ${languages}...`);

    const maxWorkers = Math.min(os.cpus().length || 4, 4);

    const workers = [];
    for (let w = 0; w < maxWorkers; w++) {
      const worker = await Tesseract.createWorker(languages, 1, {
        logger: m => {
          if (m.status && m.progress !== undefined) {
safeSend(sender, 'conversion-progress', `${m.status} (${Math.round((m.progress || 0) * 100)}%)`);
          }
        },
      });
      workers.push(worker);
    }

    let roundRobin = 0;
    const fullTextParts = new Array(pageCount);

    const ocrPromises = pngPages.map(async (page, idx) => {
      const pageNumber = idx + 1;
      const worker = workers[roundRobin];
      roundRobin = (roundRobin + 1) % workers.length;

safeSend(sender, 'conversion-progress', `Running OCR on page ${pageNumber} (worker ${workers.indexOf(worker) + 1})...`);
      const { data: { text } } = await worker.recognize(page.content);
      fullTextParts[idx] = `\n--- Page ${pageNumber} ---\n` + text;
    });

    await Promise.all(ocrPromises);
    await Promise.all(workers.map(w => w.terminate()));

    const fullText = fullTextParts.join('');
    return fullText;
  } catch (e) {
    console.error('PDF OCR extraction error:', e);
safeSend(sender, 'conversion-progress', `FATAL: ${e.message}`)
    return `FATAL: ${e.message}`;
  } finally {
    if (library) {
      library.destroy();
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

async function generateEPUB(text, outPath) {
  const title = text.substring(0, text.indexOf('\n')) || 'Converted Document';
  const content = text.substring(text.indexOf('\n') + 1).split('---').map(page => ({
    title: `Page ${page.match(/Page (\d+)/)?.[1] || ''}`,
    data: page.replace(/Page \d+ ---/, '').trim()
  }));

  const options = {
    title,
    author: 'Scannio',
    content
  };

  await new Epub(options, outPath).promise;
  return outPath;
}

async function generateTXT(text, outPath) {
  fs.writeFileSync(outPath, text);
  return outPath;
}

ipcMain.on('minimize-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win.minimize();
});

ipcMain.on('maximize-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});

ipcMain.on('close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win.close();
});

ipcMain.handle('convert-pdf', async (event, { arrayBuffer, languages, outputFormat }) => {
  const sender = event.sender;
const buffer = Buffer.from(arrayBuffer);
  try {
safeSend(sender, 'conversion-progress', 'Starting PDF conversion...');
    const jobId = nextJobId++;
    const textPromise = new Promise((resolve, reject) => {
      pendingJobs.set(jobId, { resolve, reject, sender });
    });
    worker.postMessage({ jobId, buffer, languages });

    const text = await textPromise;
safeSend(sender, 'conversion-progress', 'Text extracted. Generating output file...');
    const extension = outputFormat === 'epub' ? '.epub' : '.txt';
    const outputPath = path.join(app.getPath('desktop'), `converted_${Date.now()}${extension}`);
    const finalPath = await (outputFormat === 'epub' ? generateEPUB(text, outputPath) : generateTXT(text, outputPath));
safeSend(sender, 'conversion-progress', 'Generating EPUB file...');
    return finalPath;
  } catch (e) {
    console.error('Conversion error:', e);
safeSend(sender, 'conversion-progress', 'An error occurred during conversion.');
    return null;
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