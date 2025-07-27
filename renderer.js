const pdfInput = document.getElementById('pdfInput');
const convertBtn = document.getElementById('convertBtn');
const clearBtn = document.getElementById('clearBtn');
const cancelBtn = document.getElementById('cancelBtn');
const langSelect = document.getElementById('langSelect');
const customLang = document.getElementById('customLang');
const ocrEngine = document.getElementById('ocrEngine');
const languageSelection = document.getElementById('language-selection');
const customLanguageSelection = document.getElementById('custom-language-selection');
const progressContainer = document.getElementById('progress-container');
const progressText = document.getElementById('progress-text');
const resultDiv = document.getElementById('result');
const minimizeBtn = document.getElementById('minimize-btn');
const maximizeBtn = document.getElementById('maximize-btn');
const closeBtn = document.getElementById('close-btn');

const settingsBtn = document.getElementById('settingsBtn');
const mainContent = document.getElementById('main-content');
const settingsContent = document.getElementById('settings-content');

const toggleLanguageSelection = () => {
  const selectedEngine = ocrEngine.value;
  if (selectedEngine === 'tesseract') {
    languageSelection.classList.remove('hidden');
    customLanguageSelection.classList.remove('hidden');
  } else {
    languageSelection.classList.add('hidden');
    customLanguageSelection.classList.add('hidden');
  }
};

toggleLanguageSelection();

ocrEngine.addEventListener('change', toggleLanguageSelection);


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

async function loadSettings() {
  try {
    const settings = await window.electronAPI.getSettings();
    
    if (settings.outputFormat) {
      document.getElementById('outputFormat').value = settings.outputFormat;
    }
    if (settings.lmStudioEndpoint) {
      document.getElementById('lmStudioEndpoint').value = settings.lmStudioEndpoint;
    }
    if (settings.googleApiKey) {
      googleApiKeyInput.value = settings.googleApiKey;
      googleApiKeyInput.dispatchEvent(new Event('input'));
    }
    if (settings.googleModel) {
      setTimeout(() => {
        if (googleModelSelect.querySelector(`option[value="${settings.googleModel}"]`)) {
          googleModelSelect.value = settings.googleModel;
        }
      }, 1000);
    }
    if (settings.mistralApiKey) {
      document.getElementById('mistralApiKey').value = settings.mistralApiKey;
    }
    if (settings.ocrEngine) {
      ocrEngine.value = settings.ocrEngine;
      toggleLanguageSelection();
    }
    if (settings.languages && settings.languages.length > 0) {
      Array.from(langSelect.options).forEach(option => option.selected = false);
      settings.languages.forEach(lang => {
        const option = langSelect.querySelector(`option[value="${lang}"]`);
        if (option) option.selected = true;
      });
    }
    if (settings.customLanguages) {
      customLang.value = settings.customLanguages;
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

async function saveSetting(key, value) {
  try {
    await window.electronAPI.saveSetting(key, value);
  } catch (error) {
    console.error('Failed to save setting:', error);
  }
}

document.addEventListener('DOMContentLoaded', loadSettings);

let debounceTimer;
googleApiKeyInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const apiKey = googleApiKeyInput.value.trim();
    await saveSetting('googleApiKey', apiKey);
    
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
          if (model.name.includes('gemini-1.5-pro')) { 
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

document.getElementById('outputFormat').addEventListener('change', (e) => {
  saveSetting('outputFormat', e.target.value);
});

document.getElementById('lmStudioEndpoint').addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    saveSetting('lmStudioEndpoint', e.target.value);
  }, 1000);
});

googleModelSelect.addEventListener('change', (e) => {
  saveSetting('googleModel', e.target.value);
});

document.getElementById('mistralApiKey').addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    saveSetting('mistralApiKey', e.target.value);
  }, 1000);
});

ocrEngine.addEventListener('change', (e) => {
  saveSetting('ocrEngine', e.target.value);
});

langSelect.addEventListener('change', (e) => {
  const selectedLanguages = Array.from(e.target.selectedOptions).map(opt => opt.value);
  saveSetting('languages', selectedLanguages);
});

customLang.addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    saveSetting('customLanguages', e.target.value);
  }, 1000);
});

clearBtn.addEventListener('click', () => {
    pdfInput.value = '';
    langSelect.value = 'eng';
    customLang.value = '';
    resultDiv.classList.add('hidden');
});

cancelBtn.addEventListener('click', () => {
    window.electronAPI.cancelConversion();
    progressContainer.classList.add('hidden');
    cancelBtn.classList.add('hidden');
    convertBtn.classList.remove('hidden');
});

convertBtn.addEventListener('click', async () => {
    if (!pdfInput.files.length) {
        alert('Please select a PDF file.');
        return;
    }

    progressContainer.classList.remove('hidden');
    resultDiv.classList.add('hidden');
    progressText.textContent = 'Preparing to process...';
    convertBtn.classList.add('hidden');
    cancelBtn.classList.remove('hidden');

    const file = pdfInput.files[0];
    const arrayBuffer = await file.arrayBuffer();

    const selectedLanguages = Array.from(langSelect.selectedOptions).map(opt => opt.value);
    const customLanguages = customLang.value.trim().split('+').filter(Boolean);
    const languages = [...new Set([...selectedLanguages, ...customLanguages])].join('+');
    const outputFormat = document.getElementById('outputFormat').value;

    if (ocrEngine.value === 'tesseract' && !languages) {
        alert('Please select at least one language or enter a custom language code.');
        progressContainer.classList.add('hidden');
        convertBtn.classList.remove('hidden');
        cancelBtn.classList.add('hidden');
        return;
    }

    const lmStudioEndpoint = document.getElementById('lmStudioEndpoint').value;
    const googleApiKey = googleApiKeyInput.value;
    const googleModel = googleModelSelect.value;
    const mistralApiKey = document.getElementById('mistralApiKey').value;

    if ((ocrEngine.value === 'google' && !googleApiKey) || (ocrEngine.value === 'mistral' && !mistralApiKey)) {
      alert(`Please enter the API key for the selected OCR engine in Settings.`);
      progressContainer.classList.add('hidden');
      convertBtn.classList.remove('hidden');
      cancelBtn.classList.add('hidden');
      return;
    }

    try {
        const outputPath = await window.electronAPI.convertPDF({ arrayBuffer, languages, outputFormat, ocrEngine: ocrEngine.value, lmStudioEndpoint, googleApiKey, googleModel, mistralApiKey });
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
    } finally {
        convertBtn.classList.remove('hidden');
        cancelBtn.classList.add('hidden');
    }
});

resultDiv.addEventListener('click', (e) => {
    if (e.target.tagName === 'A' && e.target.dataset.path) {
        e.preventDefault();
        alert(`File is located at: ${e.target.dataset.path}`);
    }
});