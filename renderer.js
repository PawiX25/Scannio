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

const googleApiKeyInput = document.getElementById('googleApiKey');
const googleModelSelect = document.getElementById('googleModel');

let debounceTimer;
googleApiKeyInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const apiKey = googleApiKeyInput.value.trim();
    googleModelSelect.innerHTML = '<option>Loading models...</option>';
    googleModelSelect.disabled = true;
    if (apiKey) {
      const models = await window.electronAPI.getGoogleModels(apiKey);
      googleModelSelect.innerHTML = ''; // Clear loading message
      if (models && models.length > 0) {
        models.forEach(model => {
          const option = document.createElement('option');
          option.value = model.name;
          option.textContent = model.displayName;
          if (model.name.includes('gemini-2.5-pro')) { 
            option.selected = true;
          }
          googleModelSelect.appendChild(option);
        });
        googleModelSelect.disabled = false;
      } else {
        googleModelSelect.innerHTML = '<option>No vision models found</option>';
      }
    } else {
      googleModelSelect.innerHTML = '<option>Enter API key first</option>';
    }
  }, 500); 
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
    const lmStudioEndpoint = document.getElementById('lmStudioEndpoint').value;
    const googleApiKey = googleApiKeyInput.value;
    const googleModel = googleModelSelect.value;
    const mistralApiKey = document.getElementById('mistralApiKey').value;

    if ((ocrEngine === 'google' && !googleApiKey) || (ocrEngine === 'mistral' && !mistralApiKey)) {
      alert(`Please enter the API key for the selected OCR engine in Settings.`);
      progressContainer.classList.add('hidden');
      return;
    }

    try {
        const outputPath = await window.electronAPI.convertPDF({ arrayBuffer, languages, outputFormat, ocrEngine, lmStudioEndpoint, googleApiKey, googleModel, mistralApiKey });
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