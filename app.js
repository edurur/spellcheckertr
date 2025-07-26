const DB_URL = 'v12.gts.sqlite3.db'; // local file

let db = null;
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const checkBtn = document.getElementById('checkBtn');
const liveBtn = document.getElementById('liveBtn');
const textInput = document.getElementById('textInput');
const downloadBtn = document.getElementById('downloadBtn');
const backdrop = document.getElementById('editor-backdrop');

let liveMode=false;
let debounceTimer;

async function init() {
  status('📦 sql.js yükleniyor…');
  const SQL = await initSqlJs({ locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}` });

  status('⬇️ Sözlük indiriliyor…');
  const res = await fetch(DB_URL);
  if (!res.ok) {
    status('❌ Veritabanı indirilemedi');
    checkBtn.disabled = true;
    return;
  }
  const buf = await res.arrayBuffer();
  db = new SQL.Database(new Uint8Array(buf));
  status('✅ Veritabanı yüklendi');
  console.log('SQLite DB loaded, size bytes:', buf.byteLength);
  checkBtn.disabled = false;
  liveBtn.disabled=false;
  downloadBtn.disabled = true;
}

function status(msg) {
  statusEl.textContent = msg;
}

function isWordValid(word){
  const stmt=db.prepare('SELECT 1 FROM madde WHERE lower(madde)=lower(?) OR lower(madde_duz)=lower(?) LIMIT 1');
  stmt.bind([word,word]);
  const valid = stmt.step();
  stmt.free();
  return valid;
}

function getSuggestions(word, limit = 5) {
  const suggestions = new Set();
  const wordLower = word.toLowerCase();

  // 1. Quick wins: check for simple Turkish/ASCII character swaps
  const charMap = {
    'c': 'ç', 'g': 'ğ', 'i': 'ı', 'o': 'ö', 's': 'ş', 'u': 'ü',
    'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u'
  };

  for (let i = 0; i < wordLower.length; i++) {
    const char = wordLower[i];
    if (charMap[char]) {
      const variant = wordLower.slice(0, i) + charMap[char] + wordLower.slice(i + 1);
      if (isWordValid(variant)) {
        suggestions.add(variant);
      }
    }
  }

  if (suggestions.size >= limit) {
    return Array.from(suggestions).slice(0, limit);
  }

  // 2. DB search with better candidate selection
  const prefixLen = Math.min(word.length, 3);
  const likePattern = wordLower.substring(0, prefixLen) + '%';
  const minLen = Math.max(1, word.length - 2);
  const maxLen = word.length + 2;

  const stmt = db.prepare('SELECT madde FROM madde WHERE length(madde) BETWEEN ? AND ? AND lower(madde) LIKE ? LIMIT 300');
  stmt.bind([minLen, maxLen, likePattern]);
  
  const candidates = [];
  while(stmt.step()){
    candidates.push(stmt.getAsObject().madde);
  }
  stmt.free();

  // 3. Rank the candidates by Levenshtein distance on normalized strings
  const mapObj={'ç':'c','ğ':'g','ı':'i','ö':'o','ş':'s','ü':'u','Ç':'c','Ğ':'g','İ':'i','I':'i','Ö':'o','Ş':'s','Ü':'u'};
  const normalize=str=>str.replace(/[çğıöşüÇĞİIÖŞÜ]/g,ch=>mapObj[ch]).toLowerCase();
  
  // Levenshtein distance function
  function lev(a,b){
    const al=a.length, bl=b.length;
    const dp=new Array(bl+1).fill(0);
    for(let j=0;j<=bl;j++) dp[j]=j;
    for(let i=1;i<=al;i++){
      let prev=dp[0]; dp[0]=i;
      for(let j=1;j<=bl;j++){
        const tmp=dp[j];
        dp[j]=a[i-1]===b[j-1]?prev:Math.min(prev+1, dp[j]+1, dp[j-1]+1);
        prev=tmp;
      }
    }
    return dp[bl];
  }

  const normTarget = normalize(wordLower);

  candidates.sort((a, b) => lev(normTarget, normalize(a)) - lev(normTarget, normalize(b)));
  
  for (const cand of candidates) {
    if (suggestions.size >= limit) break;
    suggestions.add(cand);
  }
  
  console.log(`Suggestions for "${word}":`, Array.from(suggestions));
  return Array.from(suggestions);
}

function checkText(text) {
  const regex = /\b[\wçğıöşüÇĞİÖŞÜ]+\b/g;
  const issues = [];
  console.log('Running checkText on length', text.length);
  let match;
  while ((match = regex.exec(text)) !== null) {
    const w = match[0];
    if (!isWordValid(w)) {
      issues.push({
        word: w,
        start: match.index,
        end: regex.lastIndex,
        suggestions: getSuggestions(w)
      });
    }
  }
  return issues;
}

function displayResults(issues) {
  if (issues.length === 0) {
    resultsEl.innerHTML = '<div class="results-header">✅ Hata bulunamadı</div>';
    console.log('No issues found');
    return;
  }
  console.log('Issues found:', issues);
  let html = `<div class="results-header">🚨 ${issues.length} hata bulundu</div>`;
  issues.forEach(iss => {
    html += `<div class="error-word">${iss.word}</div>`;
    if (iss.suggestions.length) {
      iss.suggestions.forEach(s => {
        html += `<span class="suggestion" onclick="replaceWord('${iss.word}','${s}')">${s}</span>`;
      });
    } else {
      html += '<span class="no-suggestion">Öneri yok</span>';
    }
    html += '<br />';
  });
  resultsEl.innerHTML = html;
}

window.replaceWord = function(oldW, newW) {
  const txt = textInput.value;
  const re = new RegExp(`\\b${oldW}\\b`, 'g');
  textInput.value = txt.replace(re, newW);
};

downloadBtn.addEventListener('click', () => {
  downloadBtn.disabled = true;
  init();
});

liveBtn.addEventListener('click',()=>{
  liveMode=!liveMode;
  liveBtn.textContent= liveMode? 'Canlı Mod (Açık)':'Canlı Mod (Kapalı)';
  if(liveMode && db){ scheduleLive(); }
});

checkBtn.addEventListener('click', () => {
  if (!db) return;
  const issues = checkText(textInput.value);
  displayResults(issues);
  console.log('Manual check completed');
  updateBackdrop(issues);
});

// live typing handler
textInput.addEventListener('input',()=>{
  backdrop.textContent=textInput.value; // ensure visible
  if(liveMode && db){ scheduleLive(); }
});

// sync scroll
textInput.addEventListener('scroll',()=>{
  backdrop.scrollTop=textInput.scrollTop;
  backdrop.scrollLeft=textInput.scrollLeft;
});

function scheduleLive(){
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(()=>{
    const issues=checkText(textInput.value);
    console.log('Live check issues', issues);
    displayResults(issues);
    updateBackdrop(issues);
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
    parts.push(`<mark>${escapeHtml(content.substring(iss.start,iss.end))}</mark>`);
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
