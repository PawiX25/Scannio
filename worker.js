const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const { PDFiumLibrary } = require('@hyzyla/pdfium');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Mistral } = require('@mistralai/mistralai');

const cmapDir = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'cmaps');
const standardFontsDir = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'standard_fonts');
const cmapUrl = url.pathToFileURL(cmapDir).href + '/';
const standardFontDataUrl = url.pathToFileURL(standardFontsDir).href + '/';

function postProgress(jobId, text) {
  parentPort.postMessage({ jobId, type: 'progress', text });
}

async function extractTextWithAIVision(jobId, pages, lmStudioEndpoint) {
  postProgress(jobId, 'Starting AI Vision OCR...');
  const cleanedPages = [];

  for (let i = 0; i < pages.length; i++) {
    const { imageBuffer } = pages[i];
    const pageNumber = i + 1;
    postProgress(jobId, `Processing page ${pageNumber} of ${pages.length} with AI Vision...`);
    const systemPrompt = `You are a universal, high-fidelity OCR engine. Your sole purpose is to transcribe text from an image with perfect accuracy, regardless of the language.\n\n**PRIMARY DIRECTIVE: DETECT, THEN TRANSCRIBE**\nFirst, auto-detect the primary language of the text. Then, using the rules of that specific language, perform a flawless transcription.\n\n**CRITICAL PROCESSING RULES:**\n\n1.  **LANGUAGE-AWARE CHARACTER FIDELITY:** This is your most important task. Once you detect the language, you MUST meticulously transcribe all characters specific to it.\n    *   Pay extreme attention to all diacritics, accents, and special characters (e.g., 'ñ', 'ç', 'ü', 'ö', 'å', 'ø', 'ł', 'ß', etc.).\n    *   Do not substitute or omit these characters. Their accuracy is paramount.\n\n2.  **RECONSTRUCT HYPHENATED WORDS:** This rule is universal. If a word is split with a hyphen at the end of a line (e.g., "transcrip-"), you MUST join it with its remainder on the next line (e.g., "tion") to form the complete, single word ("transcription"). The splitting hyphen must be removed from the final output.\n\n3.  **TRANSCRIBE WITH ABSOLUTE LITERALISM (NO HALLUCINATIONS):**\n    *   Your function is to transcribe, not interpret or "fix". Transcribe the exact letters and words you see.\n    *   Do not guess or substitute visually similar words. If a word seems unusual, archaic, or technical, transcribe it exactly as it appears.\n    *   If a section is genuinely impossible to read due to a blur or damage, use the placeholder '[unreadable]'.\n\n4.  **ISOLATE THE MAIN BODY TEXT:**\n    *   You MUST completely ignore and exclude any text that is not part of the main content.\n    *   **Specifically, EXCLUDE all page numbers, headers, and footers.** These are metadata, not content.\n\n5.  **PRESERVE ORIGINAL FORMATTING:**\n    *   Maintain all original line breaks, paragraph breaks, and indentation.\n    *   Accurately reproduce all punctuation, including quotation marks and different types of dashes (e.g., '–' vs. '-').\n\n**YOUR TASK:**\nFollowing these strict, universal rules, provide a perfect transcription of the main text body from the attached image. If the image contains no text, your entire output must be exactly: "[NO TEXT DETECTED]".\n`;

    try {
      const imageBase64 = imageBuffer.toString('base64');
      const response = await fetch(lmStudioEndpoint || 'http://localhost:1234/v1/chat/completions', {
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

async function extractTextWithGoogleAI(jobId, buffer, apiKey, modelName) {
  postProgress(jobId, `Starting Google AI Vision OCR with model: ${modelName}...`);
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName });

  try {
    const base64Pdf = buffer.toString('base64');
    const filePart = {
      inlineData: {
        data: base64Pdf,
        mimeType: 'application/pdf'
      },
    };

    const prompt = 'Perform OCR on this document. Extract all text content, page by page, preserving the original layout. For each page, format the output like this: "==Start of OCR for page X==[page content]==End of OCR for page X==" where X is the page number.';

    const result = await model.generateContent([prompt, filePart]);
    const response = await result.response;

    let rawText = '';
    if (response.parts && response.parts.length > 0) {
      rawText = response.parts.map(part => part.text).join('');
    } else if (typeof response.text === 'function') {
      rawText = response.text();
    }

    if (!rawText) {
      postProgress(jobId, 'Google AI Vision returned no text.');
      return '';
    }

    // Clean the raw text from the API
    const pages = rawText.split(/==End of OCR for page \d+==/g).filter(Boolean);
    const cleanedPages = pages.map((pageText, i) => {
      const content = pageText.replace(/==Start of OCR for page \d+==/g, '').trim();
      return `\n--- Page ${i + 1} ---\n` + content;
    });

    const fullText = cleanedPages.join('');
    postProgress(jobId, `Google AI Vision OCR complete. Extracted text length: ${fullText.length}.`);
    return fullText;

  } catch (e) {
    postProgress(jobId, `Google AI Vision failed: ${e.message}.`);
    return ''; 
  }
}

async function extractTextWithMistralOCR(jobId, buffer, apiKey) {
  const log = (message) => {
    console.log(`WORKER_MISTRAL_LOG: ${message}`);
    postProgress(jobId, `MISTRAL_LOG: ${message}`);
  };

  const logError = (message, error) => {
    console.error(`WORKER_MISTRAL_ERROR: ${message}`, error);
    postProgress(jobId, `MISTRAL_ERROR: ${message}`);
  };

  log('Process started.');

  if (!apiKey) {
    logError('API key is missing or empty.');
    return '';
  }

  let uploadedPdf;
  try {
    log('Instantiating Mistral client.');
    const client = new Mistral({ apiKey });
    log('Client instantiated successfully.');
    postProgress(jobId, 'Successfully connected to Mistral AI.');

    log(`Uploading PDF buffer of size ${buffer.length} bytes.`);
    uploadedPdf = await client.files.upload({
      file: { fileName: "input.pdf", content: buffer },
      purpose: "ocr"
    });
    log(`PDF uploaded. File ID: ${uploadedPdf.id}`);

    log('Getting secure URL for processing...');
    const signedUrl = await client.files.getSignedUrl({ fileId: uploadedPdf.id });
    log(`Got secure URL: ${signedUrl.url.substring(0, 70)}...`);

    log('Sending document to OCR for processing...');
    const ocrResponse = await client.ocr.process({
      model: "mistral-ocr-latest",
      document: { type: "document_url", documentUrl: signedUrl.url },
    });
    log('OCR processing complete. Parsing response.');

    const fullText = (ocrResponse.pages && Array.isArray(ocrResponse.pages) && ocrResponse.pages.length > 0)
      ? ocrResponse.pages.map((page, i) => {
          let content = page.markdown || '';
          content = content.replace(/!\[.*?\]\(.*?\)/g, '').trim();
          if (content === '.') {
            content = '';
          }
          return `\n--- Page ${i + 1} ---\n` + content;
        }).join('')
      : ocrResponse.content || '';

    log(`Successfully extracted text of length ${fullText.length}.`);
    return fullText;

  } catch (e) {
    logError(`An error occurred: ${e.message}`, e.stack);
    return '';
  } finally {
    if (uploadedPdf) {
      try {
        log(`Deleting uploaded file ID: ${uploadedPdf.id}`);
        await new Mistral({ apiKey }).files.delete({ fileId: uploadedPdf.id });
        log('Cleanup complete.');
      } catch (cleanupError) {
        logError(`Failed to delete uploaded file: ${cleanupError.message}`, cleanupError.stack);
      }
    }
  }
}


async function extractTextFromPDF(jobId, buffer, languages, ocrEngine, lmStudioEndpoint, googleApiKey, googleModel, mistralApiKey) {
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
    return extractTextWithOCR(jobId, buffer, languages, ocrEngine, lmStudioEndpoint, googleApiKey, googleModel, mistralApiKey);
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

async function extractTextWithOCR(jobId, buffer, languages, ocrEngine, lmStudioEndpoint, googleApiKey, googleModel, mistralApiKey) {
  if (ocrEngine === 'google') {
    return await extractTextWithGoogleAI(jobId, buffer, googleApiKey, googleModel);
  }
  if (ocrEngine === 'mistral') {
    return await extractTextWithMistralOCR(jobId, buffer, mistralApiKey);
  }

  let library;
  try {
    postProgress(jobId, 'Converting PDF to images for OCR...');
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
      return await extractTextWithAIVision(jobId, pngPages, lmStudioEndpoint);
    } else if (ocrEngine === 'paddle') {
      return await extractTextWithPaddleOCR(jobId, pngPages);
    }

    const pageCount = pngPages.length;
    postProgress(jobId, `Found ${pageCount} pages. Starting parallel Tesseract OCR with languages: ${languages}...`);

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
  const { jobId, buffer, languages, ocrEngine, lmStudioEndpoint, googleApiKey, googleModel, mistralApiKey } = msg;
  try {
    const text = await extractTextFromPDF(jobId, Buffer.from(buffer), languages, ocrEngine, lmStudioEndpoint, googleApiKey, googleModel, mistralApiKey);
    parentPort.postMessage({ jobId, type: 'done', text });
  } catch (e) {
    parentPort.postMessage({ jobId, type: 'error', error: e.message || String(e) });
  }
});

process.on('SIGINT', () => {
  parentPort.close();
  process.exit(0);
});
