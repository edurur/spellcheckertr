// app.js - Simplified version for the new JSON-based worker

// --- DOM Elements ---
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const checkBtn = document.getElementById('checkBtn');
const liveBtn = document.getElementById('liveBtn');
const textInput = document.getElementById('textInput');
const downloadBtn = document.getElementById('downloadBtn');
const backdrop = document.getElementById('editor-backdrop');
const themeToggle = document.getElementById('themeToggle');
const suggestionPopup = document.getElementById('suggestion-popup');
const wordCountEl = document.getElementById('word-count');
const charCountEl = document.getElementById('char-count');
const errorCountEl = document.getElementById('error-count');

// --- State ---
let spellWorker = null;
let workerReady = false;
let liveMode = false;
let debounceTimer;
let personalDict = new Set(JSON.parse(localStorage.getItem('personalDict') || '[]'));

// --- Initialization ---
async function init() {
  status('🚀 Worker başlatılıyor...');
  checkBtn.disabled = true;
  liveBtn.disabled = true;
  downloadBtn.style.display = 'none'; // No need to download manually

  spellWorker = new Worker('spellchecker-worker.js');
  
  spellWorker.onmessage = function(e) {
    const { type, data, error } = e.data;
    
    switch(type) {
      case 'DB_READY':
        workerReady = true;
        checkBtn.disabled = false;
        liveBtn.disabled = false;
        status('✅ Hazır!');
        // Send personal dictionary to worker
        spellWorker.postMessage({
          type: 'UPDATE_PERSONAL_DICT',
          data: { words: Array.from(personalDict) }
        });
        // Initial check
        checkTextAsync(textInput.value);
        break;
        
      case 'CHECK_RESULT':
        handleCheckResult(data.issues);
        break;
        
      case 'ERROR':
        console.error('Worker error:', error);
        status(`❌ Hata: ${error}`);
        break;
    }
  };
}

// --- Spell Checking ---
function checkTextAsync(text) {
  if (!workerReady) return;
  
  spellWorker.postMessage({
    type: 'CHECK_TEXT',
    data: { text }
  });
}

function handleCheckResult(issues) {
  console.log('Received check result:', issues);
  displayResults(issues);
  updateBackdrop(issues);
  updateStats(issues);
}


// --- UI Updates ---
function displayResults(issues) {
  if (issues.length === 0) {
    resultsEl.innerHTML = '<div class="results-header">✅ Hata bulunamadı</div>';
    return;
  }
  
  let html = `<div class="results-header">🚨 ${issues.length} hata bulundu</div>`;
  html += '<div class="errors-list">';
  issues.forEach(issue => {
    html += '<div class="error-item">';
    html += `<div class="error-word">"${escapeHtml(issue.word)}"</div>`;
    
    if (issue.suggestions && issue.suggestions.length > 0) {
      html += '<div class="suggestions-list">';
      html += '<span class="suggestions-label">Öneriler:</span>';
      issue.suggestions.forEach(suggestion => {
        html += `<span class="suggestion" onclick="replaceWordAtIndex('${escapeHtml(suggestion)}', ${issue.start}, ${issue.end})">${escapeHtml(suggestion)}</span>`;
      });
      html += '</div>';
    } else {
      html += '<div class="no-suggestions">Öneri bulunamadı</div>';
    }
    
    html += `<div class="error-actions">`;
    html += `<span class="add-dict" onclick="addToPersonalDict('${escapeHtml(issue.word)}')">Sözlüğe ekle</span>`;
    html += '</div>';
    html += '</div>';
  });
  html += '</div>';
  
  resultsEl.innerHTML = html;
}

function updateBackdrop(issues){
  const content = textInput.value;
  if (!issues || issues.length === 0) {
    backdrop.innerHTML = escapeHtml(content);
    return;
  }
  let last = 0; 
  const parts = [];
  issues.sort((a,b) => a.start - b.start).forEach(iss => {
    parts.push(escapeHtml(content.substring(last, iss.start)));
    const suggestionsString = iss.suggestions.join(',');
    parts.push(`<mark data-word="${escapeHtml(iss.word)}" data-suggestions="${escapeHtml(suggestionsString)}" data-start="${iss.start}" data-end="${iss.end}">${escapeHtml(content.substring(iss.start,iss.end))}</mark>`);
    last = iss.end;
  });
  parts.push(escapeHtml(content.substring(last)));
  backdrop.innerHTML = parts.join('');
}

function status(msg) {
  statusEl.textContent = msg;
}

function updateStats(issues = null) {
  const text = textInput.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  
  wordCountEl.textContent = `${words} ${words === 1 ? 'kelime' : 'kelime'}`;
  charCountEl.textContent = `${chars} ${chars === 1 ? 'karakter' : 'karakter'}`;
  
  if (issues !== null) {
    const errorCount = issues.length;
    errorCountEl.textContent = `${errorCount} ${errorCount === 1 ? 'hata' : 'hata'}`;
    errorCountEl.className = (errorCount === 0) ? 'no-errors' : '';
  }
}


// --- Personal Dictionary ---
function addToPersonalDict(word) {
  const w = word.toLowerCase();
  if (!personalDict.has(w)) {
    personalDict.add(w);
    localStorage.setItem('personalDict', JSON.stringify(Array.from(personalDict)));
    
    if (workerReady) {
      spellWorker.postMessage({
        type: 'UPDATE_PERSONAL_DICT',
        data: { words: Array.from(personalDict) }
      });
    }
  }
  
  hideSuggestionPopup();
  checkTextAsync(textInput.value);
  updateStats();
}


// --- Event Handlers & Utils ---
checkBtn.addEventListener('click', () => checkTextAsync(textInput.value));

liveBtn.addEventListener('click', () => {
  liveMode = !liveMode;
  liveBtn.textContent= liveMode ? 'Canlı Mod (Açık)' : 'Canlı Mod (Kapalı)';
  if (liveMode) checkTextAsync(textInput.value);
});

textInput.addEventListener('input', () => {
  autoExpandTextarea();
  updateStats();
  backdrop.textContent = textInput.value;
  if (liveMode) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => checkTextAsync(textInput.value), 500);
  }
});

textInput.addEventListener('scroll', () => {
  backdrop.scrollTop = textInput.scrollTop;
  backdrop.scrollLeft = textInput.scrollLeft;
});

function autoExpandTextarea() {
  textInput.style.height = 'auto';
  const newHeight = Math.min(Math.max(textInput.scrollHeight, 220), 500);
  textInput.style.height = `${newHeight}px`;
  backdrop.style.height = `${newHeight}px`;
  textInput.style.overflowY = (textInput.scrollHeight > 500) ? 'auto' : 'hidden';
  backdrop.style.overflowY = textInput.style.overflowY;
}

window.replaceWordAtIndex = function(newWord, start, end) {
  const s = parseInt(start, 10);
  const e = parseInt(end, 10);
  
  textInput.focus();
  textInput.setSelectionRange(s, e);
  document.execCommand('insertText', false, newWord);
  
  hideSuggestionPopup();
  checkTextAsync(textInput.value);
};

function escapeHtml(unsafe) {
  return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


// --- Popup ---
let activePopup = null;
function showSuggestionPopup(markElement) {
  hideSuggestionPopup();
  const { word, suggestions, start, end } = markElement.dataset;
  let html = suggestions.split(',').filter(s => s)
    .map(s => `<span class="suggestion" onclick="replaceWordAtIndex('${escapeHtml(s)}', ${start}, ${end})">${escapeHtml(s)}</span>`)
    .join('');
  if (!html) html = '<span class="no-suggestion">Öneri yok</span>';
  
  html += `<span class="add-dict" onclick="addToPersonalDict('${escapeHtml(word)}')">"${escapeHtml(word)}" kelimesini sözlüğe ekle</span>`;
  suggestionPopup.innerHTML = html;

  const rect = markElement.getBoundingClientRect();
  suggestionPopup.style.left = `${rect.left + window.scrollX}px`;
  suggestionPopup.style.top = `${rect.bottom + window.scrollY + 5}px`;
  suggestionPopup.style.display = 'block';
  activePopup = suggestionPopup;
}

function hideSuggestionPopup() {
  if (activePopup) {
    activePopup.style.display = 'none';
    activePopup = null;
  }
}

backdrop.addEventListener('click', (e) => {
  if (e.target.tagName === 'MARK') {
    e.stopPropagation();
    showSuggestionPopup(e.target);
  }
});

document.addEventListener('click', (e) => {
  if (activePopup && !suggestionPopup.contains(e.target)) {
    hideSuggestionPopup();
  }
});


// --- Theme ---
function applyTheme(mode) {
  const dark = mode === 'dark';
  document.body.classList.toggle('dark', dark);
  themeToggle.textContent = dark ? '☀️ Açık Mod' : '🌙 Koyu Mod';
}

themeToggle.addEventListener('click', () => {
  const newMode = document.body.classList.contains('dark') ? 'light' : 'dark';
  localStorage.setItem('theme', newMode);
  applyTheme(newMode);
});

// --- Initial Load ---
window.addEventListener('DOMContentLoaded', () => {
  autoExpandTextarea();
  updateStats();
  const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(savedTheme);
  init();
});
