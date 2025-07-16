const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const { PDFiumLibrary } = require('@hyzyla/pdfium');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

const cmapDir = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'cmaps');
const standardFontsDir = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'standard_fonts');
const cmapUrl = url.pathToFileURL(cmapDir).href + '/';
const standardFontDataUrl = url.pathToFileURL(standardFontsDir).href + '/';

function postProgress(jobId, text) {
  parentPort.postMessage({ jobId, type: 'progress', text });
}

async function extractTextFromPDF(buffer, languages, jobId) {
  postProgress(jobId, 'Checking for text layer in PDF...');
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await getDocument({ data: buffer, cMapUrl: cmapUrl, cMapPacked: true, standardFontDataUrl }).promise;
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
    postProgress(jobId, 'Text layer found! Extracting text directly.');
    return fullText;
  } catch (e) {
    postProgress(jobId, 'No text layer found. Starting OCR process...');
    return extractTextWithOCR(buffer, languages, jobId);
  }
}

async function extractTextWithOCR(buffer, languages, jobId) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scannio-ocr-'));
  let library;
  try {
    postProgress(jobId, 'Converting PDF to images...');
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
    postProgress(jobId, `Found ${pageCount} pages. Starting OCR with languages: ${languages}...`);

    const maxWorkers = Math.min(os.cpus().length || 4, 4);
    const workers = [];
    for (let w = 0; w < maxWorkers; w++) {
      const worker = await Tesseract.createWorker(languages, 1);
      workers.push(worker);
    }

    let roundRobin = 0;
    const fullTextParts = new Array(pageCount);
    let pagesComplete = 0;

    const ocrPromises = pngPages.map(async (page, idx) => {
      const pageNumber = idx + 1;
      const worker = workers[roundRobin];
      roundRobin = (roundRobin + 1) % workers.length;
      const { data: { text } } = await worker.recognize(page.content);
      fullTextParts[idx] = `\n--- Page ${pageNumber} ---\n` + text;
      pagesComplete++;
      postProgress(jobId, `Processing page ${pagesComplete} of ${pageCount}...`);
    });

    await Promise.all(ocrPromises);
    await Promise.all(workers.map(w => w.terminate()));

    return fullTextParts.join('');
  } finally {
    if (library) library.destroy();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

parentPort.on('message', async (msg) => {
  const { jobId, buffer, languages } = msg;
  try {
    const text = await extractTextFromPDF(Buffer.from(buffer), languages, jobId);
    parentPort.postMessage({ jobId, type: 'done', text });
  } catch (e) {
    parentPort.postMessage({ jobId, type: 'error', error: e.message || String(e) });
  }
});