# Scannio

Scannio is a desktop application built with Electron that intelligently converts PDF documents into EPUB or TXT files. It's designed to handle both text-based and image-based (scanned) PDFs, making it a versatile tool for document conversion.

## Features

- **Intelligent PDF Processing:** Scannio first attempts to extract text directly from the PDF's text layer for speed and accuracy.
- **Multiple OCR Engines:** If a PDF has no text layer (e.g., it's a scanned document), Scannio can use one of several OCR engines:
    - **Tesseract.js:** On-device OCR with support for multiple languages.
    - **PaddleOCR:** High-accuracy on-device OCR.
    - **AI Vision (LM Studio):** Utilizes a locally running Large Language Model (LLM) for advanced OCR.
    - **Google AI Vision:** Cloud-based OCR using Google's powerful AI models.
    - **Mistral OCR:** Cloud-based OCR from Mistral AI.
- **Multi-language Support:** The Tesseract.js OCR engine supports a variety of languages, which can be selected in the application.
- **EPUB and TXT Output:** Convert your PDFs into either EPUB for e-readers or plain TXT files.
- **User-Friendly Interface:** A simple and clean interface for selecting files, choosing OCR engines, and starting the conversion process.

## How It Works

Scannio uses a combination of libraries to achieve its functionality:

1.  **PDF Parsing:** It uses `pdfjs-dist` to parse the PDF and check for a text layer.
2.  **Image Rendering:** If no text layer is found, `@hyzyla/pdfium` is used to render the PDF pages into high-resolution images.
3.  **OCR:** The selected OCR engine (`Tesseract.js`, `PaddleOCR`, `Google AI Vision`, `Mistral OCR`, or a local AI model) processes these images to recognize and extract the text.
4.  **EPUB Generation:** `epub-gen` takes the extracted text and creates a well-formatted EPUB file.
5.  **Image Processing:** `sharp` is used for efficient image handling during the rendering process.

The application runs in an Electron container, with the heavy processing offloaded to a worker thread to keep the UI responsive.

## Usage

1.  Launch the application.
2.  Click "Select PDF file" to choose the PDF you want to convert.
3.  Select the OCR engine you want to use.
4.  If using Tesseract, select the language(s) of the document.
5.  (Optional) Configure API keys for cloud-based OCR engines in the settings.
6.  Click "Convert".
7.  The converted file will be saved to your desktop.