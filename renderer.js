const pdfInput = document.getElementById('pdfInput');
const convertBtn = document.getElementById('convertBtn');
const langSelect = document.getElementById('langSelect');
const customLang = document.getElementById('customLang');
const progressContainer = document.getElementById('progress-container');
const progressText = document.getElementById('progress-text');
const resultDiv = document.getElementById('result');
const minimizeBtn = document.getElementById('minimize-btn');
const maximizeBtn = document.getElementById('maximize-btn');
const closeBtn = document.getElementById('close-btn');

const settingsBtn = document.getElementById('settingsBtn');
const mainContent = document.getElementById('main-content');
const settingsContent = document.getElementById('settings-content');

settingsBtn.addEventListener('click', () => {
  mainContent.classList.toggle('hidden');
  settingsContent.classList.toggle('hidden');
});

minimizeBtn.addEventListener('click', () => window.electronAPI.minimizeWindow());
maximizeBtn.addEventListener('click', () => window.electronAPI.maximizeWindow());
closeBtn.addEventListener('click', () => window.electronAPI.closeWindow());

window.electronAPI.onWindowMaximized(() => maximizeBtn.classList.add('is-maximized'));
window.electronAPI.onWindowUnmaximized(() => maximizeBtn.classList.remove('is-maximized'));

window.electronAPI.onConversionProgress((text) => {
    progressText.textContent = text;
});

convertBtn.addEventListener('click', async () => {
    if (!pdfInput.files.length) {
        alert('Please select a PDF file.');
        return;
    }

    progressContainer.classList.remove('hidden');
    resultDiv.classList.add('hidden');
    progressText.textContent = 'Preparing to process...';

    const file = pdfInput.files[0];
    const arrayBuffer = await file.arrayBuffer();

    const selectedLanguages = Array.from(langSelect.selectedOptions).map(opt => opt.value);
    const customLanguages = customLang.value.trim().split('+').filter(Boolean);
    const languages = [...new Set([...selectedLanguages, ...customLanguages])].join('+');
    const outputFormat = document.getElementById('outputFormat').value;

    if (!languages) {
        alert('Please select at least one language or enter a custom language code.');
        progressContainer.classList.add('hidden');
        return;
    }

    const ocrEngine = document.getElementById('ocrEngine').value;

    try {
        const outputPath = await window.electronAPI.convertPDF({ arrayBuffer, languages, outputFormat, ocrEngine });
        progressContainer.classList.add('hidden');
        resultDiv.classList.remove('hidden');

        if (outputPath) {
            resultDiv.className = 'result success';
            resultDiv.innerHTML = `<strong>Success!</strong> File saved to: <a href="#" data-path="${outputPath}">${outputPath}</a>`;
        } else {
            resultDiv.className = 'result error';
            resultDiv.innerHTML = '<strong>Error:</strong> Conversion failed. Check the console for details.';
        }
    } catch (error) {
        progressContainer.classList.add('hidden');
        resultDiv.classList.remove('hidden');
        resultDiv.className = 'result error';
        resultDiv.innerHTML = `<strong>Error:</strong> ${error.message}`;
    }
});

resultDiv.addEventListener('click', (e) => {
    if (e.target.tagName === 'A' && e.target.dataset.path) {
        e.preventDefault();
        alert(`File is located at: ${e.target.dataset.path}`);
    }
});