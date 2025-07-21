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

async function extractTextWithAIVision(jobId, pages) {
  postProgress(jobId, 'Starting AI Vision OCR...');
  const cleanedPages = [];

  for (let i = 0; i < pages.length; i++) {
    const { imageBuffer } = pages[i];
    const pageNumber = i + 1;
    postProgress(jobId, `Processing page ${pageNumber} of ${pages.length} with AI Vision...`);
    const systemPrompt = `You are a universal, high-fidelity OCR engine. Your sole purpose is to transcribe text from an image with perfect accuracy, regardless of the language.

**PRIMARY DIRECTIVE: DETECT, THEN TRANSCRIBE**
First, auto-detect the primary language of the text. Then, using the rules of that specific language, perform a flawless transcription.

**CRITICAL PROCESSING RULES:**

1.  **LANGUAGE-AWARE CHARACTER FIDELITY:** This is your most important task. Once you detect the language, you MUST meticulously transcribe all characters specific to it.
    *   Pay extreme attention to all diacritics, accents, and special characters (e.g., 'ñ', 'ç', 'ü', 'ö', 'å', 'ø', 'ł', 'ß', etc.).
    *   Do not substitute or omit these characters. Their accuracy is paramount.

2.  **RECONSTRUCT HYPHENATED WORDS:** This rule is universal. If a word is split with a hyphen at the end of a line (e.g., "transcrip-"), you MUST join it with its remainder on the next line (e.g., "tion") to form the complete, single word ("transcription"). The splitting hyphen must be removed from the final output.

3.  **TRANSCRIBE WITH ABSOLUTE LITERALISM (NO HALLUCINATIONS):**
    *   Your function is to transcribe, not interpret or "fix". Transcribe the exact letters and words you see.
    *   Do not guess or substitute visually similar words. If a word seems unusual, archaic, or technical, transcribe it exactly as it appears.
    *   If a section is genuinely impossible to read due to a blur or damage, use the placeholder '[unreadable]'.

4.  **ISOLATE THE MAIN BODY TEXT:**
    *   You MUST completely ignore and exclude any text that is not part of the main content.
    *   **Specifically, EXCLUDE all page numbers, headers, and footers.** These are metadata, not content.

5.  **PRESERVE ORIGINAL FORMATTING:**
    *   Maintain all original line breaks, paragraph breaks, and indentation.
    *   Accurately reproduce all punctuation, including quotation marks and different types of dashes (e.g., '–' vs. '-').

**YOUR TASK:**
Following these strict, universal rules, provide a perfect transcription of the main text body from the attached image. If the image contains no text, your entire output must be exactly: "[NO TEXT DETECTED]".
`;

    try {
      const imageBase64 = imageBuffer.toString('base64');
      const response = await fetch('http://localhost:1234/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'local-model',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
                { type: 'text', text: 'Extract text from this image.' }
              ]
            },
            { role: 'system', content: systemPrompt }
          ],
          temperature: 0.2,
          stream: false,
        }),
      });

      if (!response.ok) throw new Error(`Server error: ${response.statusText}`);
      
      const jsonResponse = await response.json();
      const cleanedText = jsonResponse.choices[0].message.content;
      cleanedPages.push(cleanedText);

    } catch (e) {
      postProgress(jobId, `AI Vision OCR for page ${pageNumber} failed: ${e.message}.`);
      cleanedPages.push('');
    }
  }

  postProgress(jobId, 'AI Vision OCR complete!');
  return cleanedPages.map((text, i) => `\n--- Page ${i + 1} ---\n` + text).join('');
}

async function extractTextFromPDF(jobId, buffer, languages, ocrEngine) {
  postProgress(jobId, 'Checking for text layer in PDF...');
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await getDocument({ data: buffer, cMapUrl, cMapPacked: true, standardFontDataUrl }).promise;
    let fullText = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      if (textContent.items.length === 0) {
        throw new Error('No text layer found on this page. Falling back to OCR.');
      }
      const pageText = textContent.items.map(item => item.str).join(' ');
      fullText += `\n--- Page ${i} ---\n` + pageText;
    }
    postProgress(jobId, 'Text layer found! Extracting text directly.');
    return fullText;
  } catch (e) {
    postProgress(jobId, 'No text layer found. Starting OCR process...');
    return extractTextWithOCR(jobId, buffer, languages, ocrEngine);
  }
}

const { spawn } = require('child_process');

async function extractTextWithPaddleOCR(jobId, pages) {
  postProgress(jobId, 'Starting PaddleOCR...');
  const cleanedPages = [];

  for (let i = 0; i < pages.length; i++) {
    const { imageBuffer } = pages[i];
    const pageNumber = i + 1;
    postProgress(jobId, `Processing page ${pageNumber} of ${pages.length} with PaddleOCR...`);

    const tempImagePath = path.join(os.tmpdir(), `scannio_page_${pageNumber}.png`);
    await fs.promises.writeFile(tempImagePath, imageBuffer);

    try {
      const pythonProcess = spawn('python', [path.join(__dirname, 'build', 'run_ocr', 'run_paddleocr.py'), tempImagePath]);

      let output = '';
      for await (const chunk of pythonProcess.stdout) {
        output += chunk;
      }

      let error = '';
      for await (const chunk of pythonProcess.stderr) {
        error += chunk;
      }

      const exitCode = await new Promise((resolve) => {
        pythonProcess.on('close', resolve);
      });

      if (exitCode !== 0) {
        throw new Error(`PaddleOCR script exited with code ${exitCode}: ${error}`);
      }

      const result = JSON.parse(output);
      if (result.error) {
        throw new Error(result.error);
      }

      const pageText = result[0]?.rec_texts?.join('\n') || '';
      cleanedPages.push(pageText);

    } catch (e) {
      postProgress(jobId, `PaddleOCR for page ${pageNumber} failed: ${e.message}.`);
      cleanedPages.push('');
    } finally {
      await fs.promises.unlink(tempImagePath);
    }
  }

  postProgress(jobId, 'PaddleOCR complete!');
  return cleanedPages.map((text, i) => `\n--- Page ${i + 1} ---\n` + text).join('');
}

async function extractTextWithOCR(jobId, buffer, languages, ocrEngine) {
  let library;
  try {
    postProgress(jobId, 'Converting PDF to images...');
    library = await PDFiumLibrary.init();
    const document = await library.loadDocument(buffer);

    const renderPromises = document.pages().map(page => 
      page.render({
        scale: 3,
        render: (options) => sharp(options.data, {
          raw: { width: options.width, height: options.height, channels: 4 },
        }).png().toBuffer(),
      }).then(image => ({ imageBuffer: Buffer.from(image.data) }))
    );

    const pngPages = await Promise.all(renderPromises);
    document.destroy();

    if (ocrEngine === 'ai_vision') {
      return await extractTextWithAIVision(jobId, pngPages);
    } else if (ocrEngine === 'paddle') {
      return await extractTextWithPaddleOCR(jobId, pngPages);
    }

    const pageCount = pngPages.length;
    postProgress(jobId, `Found ${pageCount} pages. Starting parallel OCR with languages: ${languages}...`);


    const maxWorkers = Math.min(os.cpus().length || 4, 4);
    const workers = await Promise.all(Array(maxWorkers).fill(0).map(() => Tesseract.createWorker(languages, 1)));
    
    let pagesComplete = 0;
    const ocrPromises = pngPages.map(async ({ imageBuffer }, idx) => {
      const worker = workers[idx % maxWorkers];
      const { data: { text } } = await worker.recognize(imageBuffer);
      pagesComplete++;
      postProgress(jobId, `Processing page ${pagesComplete} of ${pageCount}...`);
      return { ocrText: text, pageNum: idx + 1 };
    });

    const ocrResults = await Promise.all(ocrPromises);
    await Promise.all(workers.map(w => w.terminate()));

    ocrResults.sort((a, b) => a.pageNum - b.pageNum);

    const fullText = ocrResults.map(p => `\n--- Page ${p.pageNum} ---\n` + p.ocrText).join('');
    return fullText;

  } finally {
    if (library) library.destroy();
  }
}

parentPort.on('message', async (msg) => {
  const { jobId, buffer, languages, ocrEngine } = msg;
  try {
    const text = await extractTextFromPDF(jobId, Buffer.from(buffer), languages, ocrEngine);
    parentPort.postMessage({ jobId, type: 'done', text });
  } catch (e) {
    parentPort.postMessage({ jobId, type: 'error', error: e.message || String(e) });
  }
});
