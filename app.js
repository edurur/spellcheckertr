const DB_URL = 'https://p.001717.xyz/v12.gts.sqlite3.db';

// 🆕 IndexedDB cache constants
const CACHE_DB_NAME = 'spellchecker-cache';
const CACHE_STORE = 'files';
const CACHE_KEY = 'dictionary';

let db = null;
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const checkBtn = document.getElementById('checkBtn');
const liveBtn = document.getElementById('liveBtn');
const textInput = document.getElementById('textInput');
const downloadBtn = document.getElementById('downloadBtn');
const backdrop = document.getElementById('editor-backdrop');
const themeToggle = document.getElementById('themeToggle');
const suggestionPopup = document.getElementById('suggestion-popup');
const progressContainer = document.getElementById('progress-container');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const wordCountEl = document.getElementById('word-count');
const charCountEl = document.getElementById('char-count');
const errorCountEl = document.getElementById('error-count');

// 🚀 Prepared statements for better performance
let validateStmt = null;
let suggestionsStmt = null;

// 🔧 Web Worker for heavy spell-checking operations
let spellWorker = null;
let workerReady = false;

let liveMode=false;
let debounceTimer;

// --- PERSONAL DICTIONARY ---

let personalDict = new Set(JSON.parse(localStorage.getItem('personalDict') || '[]'));

function addToPersonalDict(word) {
  const w = word.toLowerCase();
  if (!personalDict.has(w)) {
    personalDict.add(w);
    localStorage.setItem('personalDict', JSON.stringify(Array.from(personalDict)));
    
    // Update worker's personal dictionary
    if (workerReady) {
      spellWorker.postMessage({
        type: 'UPDATE_PERSONAL_DICT',
        data: { words: Array.from(personalDict) }
      });
    }
  }
  
  // After adding, hide popup and re-check text to remove the underline
  hideSuggestionPopup();
  checkTextAsync(textInput.value);
  updateStats(); // Update immediately for word count
}

// 🆕 Helper – open (or create) the cache DB
function openCacheDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(CACHE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 🆕 Helper – read cached ArrayBuffer if exists
async function getCachedBuffer() {
  const db = await openCacheDB();
  return new Promise(resolve => {
    const tx = db.transaction(CACHE_STORE, 'readonly');
    const getReq = tx.objectStore(CACHE_STORE).get(CACHE_KEY);
    getReq.onsuccess = () => resolve(getReq.result || null);
    getReq.onerror = () => resolve(null);
  });
}

// 🆕 Helper – save ArrayBuffer to cache
async function saveBufferToCache(buf) {
  try {
    const db = await openCacheDB();
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    tx.objectStore(CACHE_STORE).put(buf, CACHE_KEY);
  } catch (e) {
    console.warn('Failed to write dict to IndexedDB', e);
  }
}

// 🚀 Init can now optionally force a refresh download
async function init(forceRefresh = false) {
  downloadBtn.disabled = true;
  status('📦 sql.js yükleniyor…');
  const SQL = await initSqlJs({ locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}` });

  let buf = null;
  if (!forceRefresh) {
    status('🔍 Önbellek kontrol ediliyor…');
    buf = await getCachedBuffer();
  }

  if (!buf) {
    buf = await downloadWithProgress(DB_URL);
    if (!buf) {
      status('❌ Veritabanı indirilemedi');
      checkBtn.disabled = true;
      downloadBtn.disabled = false;
      hideProgress();
      return;
    }
    // cache for next runs
    await saveBufferToCache(buf);
    status('✅ Veritabanı indirildi');
    hideProgress();
  } else {
    status('✅ Sözlük önbellekten yüklendi');
  }

  db = new SQL.Database(new Uint8Array(buf));
  console.log('SQLite DB ready, size bytes:', buf.byteLength);
  
  // 🔧 Initialize Web Worker with database
  await initWorker(buf);
   
  checkBtn.disabled = false;
  liveBtn.disabled = false;
  downloadBtn.disabled = false; // enable refresh
  downloadBtn.textContent = '⟳ Veritabanını Güncelle';
}

// 📊 Download with progress tracking using streams
async function downloadWithProgress(url) {
  try {
    showProgress();
    status('⬇️ Sözlük indiriliyor…');
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const contentLength = response.headers.get('Content-Length');
    const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
    
    if (!totalBytes) {
      // Fallback to non-streamed download if no content-length
      status('⬇️ Sözlük indiriliyor (boyut bilinmiyor)…');
      return await response.arrayBuffer();
    }
    
    const reader = response.body.getReader();
    const chunks = [];
    let receivedBytes = 0;
    
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) break;
      
      chunks.push(value);
      receivedBytes += value.length;
      
      // Update progress
      const percentage = Math.round((receivedBytes / totalBytes) * 100);
      updateProgress(percentage, receivedBytes, totalBytes);
    }
    
    // Combine all chunks into a single ArrayBuffer
    const totalArray = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      totalArray.set(chunk, offset);
      offset += chunk.length;
    }
    
    return totalArray.buffer;
    
  } catch (error) {
    console.error('Download failed:', error);
    return null;
  }
}

// 📊 Progress bar management
function showProgress() {
  progressContainer.style.display = 'flex';
  updateProgress(0, 0, 0);
}

function hideProgress() {
  progressContainer.style.display = 'none';
}

function updateProgress(percentage, receivedBytes, totalBytes) {
  progressFill.style.width = `${percentage}%`;
  progressText.textContent = `${percentage}%`;
  
  // Update status with detailed info
  const receivedMB = (receivedBytes / 1024 / 1024).toFixed(1);
  const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
  status(`⬇️ İndiriliyor: ${receivedMB}/${totalMB} MB (${percentage}%)`);
}

async function initWorker(buffer) {
  if (spellWorker) {
    spellWorker.terminate();
  }
  
  spellWorker = new Worker('spellchecker-worker.js');
  workerReady = false;
  
  return new Promise((resolve) => {
    spellWorker.onmessage = function(e) {
      const { type, data, error } = e.data;
      
      switch(type) {
        case 'DB_READY':
          workerReady = true;
          resolve();
          break;
          
        case 'CHECK_RESULT':
          handleCheckResult(data.issues);
          break;
          
        case 'ERROR':
          console.error('Worker error:', error);
          break;
      }
    };
    
    // Send database buffer and personal dictionary to worker
    spellWorker.postMessage({
      type: 'INIT_DB',
      data: {
        buffer: buffer,
        personalDict: Array.from(personalDict)
      }
    });
  });
}

function status(msg) {
  statusEl.textContent = msg;
}

// 🔧 New async function to check text using Web Worker
function checkTextAsync(text) {
  if (!workerReady) {
    console.warn('Worker not ready yet');
    return;
  }
  
  spellWorker.postMessage({
    type: 'CHECK_TEXT',
    data: { text }
  });
}

// Handle results from the Web Worker
function handleCheckResult(issues) {
  console.log('Received check result from worker:', issues.length, 'issues');
  displayResults(issues);
  updateBackdrop(issues);
  updateStats(issues);
}

function displayResults(issues) {
  if (issues.length === 0) {
    resultsEl.innerHTML = '<div class="results-header">✅ Hata bulunamadı</div>';
    console.log('No issues found');
    return;
  }
  console.log('Issues found:', issues);
  resultsEl.innerHTML = `<div class="results-header">🚨 ${issues.length} hata bulundu</div>`;
}

window.replaceWordAtIndex = function(newWord, start, end) {
  const s = parseInt(start, 10);
  const e = parseInt(end, 10);
  
  // 🔄 Preserve undo stack using proper text editing
  replaceTextPreservingUndo(s, e, newWord);
  
  hideSuggestionPopup();
  textInput.focus();

  // Manually trigger a full re-check using worker
  checkTextAsync(textInput.value);
  updateStats(); // Update immediately for character count
};

// 🔄 Replace text while preserving browser's undo stack
function replaceTextPreservingUndo(start, end, replacement) {
  // Focus the textarea to ensure selection works
  textInput.focus();
  
  // Set selection to the word we want to replace
  textInput.setSelectionRange(start, end);
  
  // Use modern approach: try insertText first, fallback to execCommand
  if (!insertTextModern(replacement)) {
    insertTextLegacy(replacement);
  }
  
  // Move cursor to end of inserted text
  const newCursorPos = start + replacement.length;
  textInput.setSelectionRange(newCursorPos, newCursorPos);
}

// Modern approach using InputEvent (Chrome 60+, Firefox 67+)
function insertTextModern(text) {
  try {
    // Create and dispatch an InputEvent - this properly integrates with undo stack
    const inputEvent = new InputEvent('beforeinput', {
      inputType: 'insertReplacementText',
      data: text,
      cancelable: true
    });
    
    if (textInput.dispatchEvent(inputEvent)) {
      // If the event wasn't cancelled, perform the replacement
      document.execCommand('insertText', false, text);
      return true;
    }
  } catch (e) {
    // Fall back to legacy method if modern approach fails
    return false;
  }
  return false;
}

// Legacy approach using execCommand (deprecated but widely supported)
function insertTextLegacy(text) {
  try {
    // execCommand('insertText') is the most reliable way to preserve undo
    return document.execCommand('insertText', false, text);
  } catch (e) {
    // Final fallback: direct value manipulation (breaks undo but works)
    console.warn('Failed to preserve undo stack, falling back to direct manipulation');
    const start = textInput.selectionStart;
    const end = textInput.selectionEnd;
    const value = textInput.value;
    textInput.value = value.substring(0, start) + text + value.substring(end);
    return true;
  }
}

// 🎹 Enhanced keyboard shortcuts and undo support
textInput.addEventListener('keydown', (e) => {
  // Handle Ctrl+Z (Undo) - let browser handle it naturally
  if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
    // Browser's built-in undo will work because we preserved the undo stack
    console.log('Undo triggered - browser will handle this');
    // Update stats after undo completes
    setTimeout(() => {
      updateStats();
      autoExpandTextarea();
      if (liveMode && workerReady) {
        scheduleLive();
      }
    }, 0);
  }
  
  // Handle Ctrl+Y or Ctrl+Shift+Z (Redo)
  if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'z')) {
    console.log('Redo triggered - browser will handle this');
    setTimeout(() => {
      updateStats();
      autoExpandTextarea();
      if (liveMode && workerReady) {
        scheduleLive();
      }
    }, 0);
  }
  
  // Handle Escape key to close suggestion popup
  if (e.key === 'Escape') {
    hideSuggestionPopup();
  }
});

downloadBtn.addEventListener('click', () => {
  // force refresh from network
  init(true);
});

// 🆕 Attempt to load from cache automatically on page load with auto-expand
window.addEventListener('DOMContentLoaded', () => {
  autoExpandTextarea();
  updateStats(); // Initialize stats display
  init();
});

liveBtn.addEventListener('click',()=>{
  liveMode=!liveMode;
  liveBtn.textContent= liveMode? 'Canlı Mod (Açık)':'Canlı Mod (Kapalı)';
  if(liveMode && db){ scheduleLive(); }
});

checkBtn.addEventListener('click', () => {
  if (!workerReady) return;
  checkTextAsync(textInput.value);
  console.log('Manual check requested');
});

// live typing handler
textInput.addEventListener('input',()=>{
  autoExpandTextarea();
  updateStats();
  backdrop.textContent=textInput.value; // ensure visible
  if(liveMode && db){ scheduleLive(); }
});

// sync scroll
textInput.addEventListener('scroll',()=>{
  backdrop.scrollTop=textInput.scrollTop;
  backdrop.scrollLeft=textInput.scrollLeft;
});

// 📏 Auto-expand textarea functionality
function autoExpandTextarea() {
  // Reset height to measure content
  textInput.style.height = 'auto';
  
  // Calculate needed height
  const scrollHeight = textInput.scrollHeight;
  const minHeight = 220; // matches CSS min-height
  const maxHeight = 500; // matches CSS max-height
  
  // Set height within bounds
  const newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
  textInput.style.height = `${newHeight}px`;
  
  // Sync backdrop height
  backdrop.style.height = `${newHeight}px`;
  
  // Enable/disable scrolling based on content
  if (scrollHeight > maxHeight) {
    textInput.style.overflowY = 'auto';
    backdrop.style.overflowY = 'auto';
  } else {
    textInput.style.overflowY = 'hidden';
    backdrop.style.overflowY = 'hidden';
  }
}

// 📊 Update writing statistics
function updateStats(issues = null) {
  const text = textInput.value;
  
  // Count words (split by whitespace and filter empty strings)
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  
  // Count characters (including spaces)
  const chars = text.length;
  
  // Update word and character counts immediately
  wordCountEl.textContent = `${words} ${words === 1 ? 'kelime' : 'kelime'}`;
  charCountEl.textContent = `${chars} ${chars === 1 ? 'karakter' : 'karakter'}`;
  
  // Update error count if issues are provided
  if (issues !== null) {
    const errorCount = issues.length;
    errorCountEl.textContent = `${errorCount} ${errorCount === 1 ? 'hata' : 'hata'}`;
    
    // Style based on error count
    if (errorCount === 0) {
      errorCountEl.className = 'no-errors';
    } else {
      errorCountEl.className = '';
    }
  }
}

// Auto-expand is initialized in the main DOMContentLoaded listener below

// Handle paste events for auto-expand
textInput.addEventListener('paste', () => {
  // Use setTimeout to run after paste content is inserted
  setTimeout(autoExpandTextarea, 0);
});

function scheduleLive(){
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(()=>{
    if (workerReady) {
      checkTextAsync(textInput.value);
      console.log('Live check requested');
    }
  },500);
}

function updateBackdrop(issues){
  const content = textInput.value;
  if(!issues||issues.length===0){
    backdrop.innerHTML=escapeHtml(content);
    return;
  }
  let last=0; const parts=[];
  issues.sort((a,b)=>a.start-b.start).forEach(iss=>{
    parts.push(escapeHtml(content.substring(last,iss.start)));
    const suggestionsString = iss.suggestions.join(',');
    parts.push(`<mark data-word="${escapeHtml(iss.word)}" data-suggestions="${escapeHtml(suggestionsString)}" data-start="${iss.start}" data-end="${iss.end}">${escapeHtml(content.substring(iss.start,iss.end))}</mark>`);
    last=iss.end;
  });
  parts.push(escapeHtml(content.substring(last)));
  backdrop.innerHTML=parts.join('');
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
} 

// --- POPUP HANDLING ---

let activePopup = null;

function showSuggestionPopup(markElement) {
  hideSuggestionPopup(); // Close any existing popup

  const word = markElement.dataset.word;
  const suggestions = markElement.dataset.suggestions.split(',').filter(s => s);
  const start = markElement.dataset.start;
  const end = markElement.dataset.end;

  let html = '';
  if (suggestions.length) {
    suggestions.forEach(s => {
      html += `<span class="suggestion" onclick="replaceWordAtIndex('${escapeHtml(s)}', ${start}, ${end})">${escapeHtml(s)}</span>`;
    });
  } else {
    html += '<span class="no-suggestion">Öneri yok</span>';
  }

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
    activePopup.innerHTML = '';
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
  if (activePopup && !suggestionPopup.contains(e.target) && e.target.tagName !== 'MARK') {
    hideSuggestionPopup();
  }
});

// 🌓 THEME HANDLING
function applyTheme(mode){
  const dark = mode==='dark';
  document.body.classList.toggle('dark', dark);
  themeToggle.textContent = dark? '☀️ Açık Mod':'🌙 Koyu Mod';
}

// initial theme
const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches? 'dark':'light');
applyTheme(savedTheme);

themeToggle.addEventListener('click', ()=>{
  const newMode = document.body.classList.contains('dark')? 'light':'dark';
  localStorage.setItem('theme', newMode);
  applyTheme(newMode);
});
