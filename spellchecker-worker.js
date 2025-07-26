// spellchecker-worker.js – Norvig's Algorithm implementation

importScripts('sql-wasm.js');

// ----------------------- Norvig's Algorithm ---------------------------
function edits1(word) {
  const letters = 'abcçdefgğhıijklmnoöprsştuüvyz';
  const splits = [];
  for (let i = 0; i <= word.length; i++) {
    splits.push([word.slice(0, i), word.slice(i)]);
  }
  
  const deletes = [];
  const transposes = [];
  const replaces = [];
  const inserts = [];
  
  for (const [L, R] of splits) {
    if (R) deletes.push(L + R.slice(1));
    if (R.length > 1) transposes.push(L + R[1] + R[0] + R.slice(2));
    if (R) {
      for (const c of letters) {
        replaces.push(L + c + R.slice(1));
      }
    }
    for (const c of letters) {
      inserts.push(L + c + R);
    }
  }
  
  return [...new Set([...deletes, ...transposes, ...replaces, ...inserts])];
}

function edits2(word) {
  const edits1List = edits1(word);
  const edits2List = [];
  for (const e1 of edits1List) {
    for (const e2 of edits1(e1)) {
      edits2List.push(e2);
    }
  }
  return [...new Set(edits2List)];
}

// ----------------------- Worker State -------------------------------------
let db = null;
let wordSet = new Set();
let wordFreq = new Map(); // word -> frequency
let personalDict = new Set();

self.onmessage = async (e) => {
  const { type, data } = e.data;
  try {
    switch (type) {
      case 'INIT_DB':
        await initDatabase(data.buffer, data.personalDict || []);
        self.postMessage({ type: 'DB_READY' });
        break;
      case 'CHECK_TEXT':
        const issues = checkText(data.text);
        self.postMessage({ type: 'CHECK_RESULT', data: { issues } });
        break;
      case 'UPDATE_PERSONAL_DICT':
        updatePersonalDict(data.words);
        break;
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', error: err.message });
  }
};

async function initDatabase(buffer, personalWords) {
  const SQL = await initSqlJs({ locateFile: file => file });
  db = new SQL.Database(new Uint8Array(buffer));

  // Load all words with frequency (assuming frequency column exists, default to 1)
  let stmt;
  try {
    // Try to get frequency if available
    stmt = db.prepare('SELECT lower(madde) AS word, COALESCE(frekans, 1) AS freq FROM madde');
  } catch (e) {
    // Fallback to simple word list
    stmt = db.prepare('SELECT lower(madde) AS word FROM madde');
  }
  
  let count = 0;
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const word = row.word;
    const freq = row.freq || 1;
    
    if (!wordSet.has(word)) {
      wordSet.add(word);
      wordFreq.set(word, freq);
      count++;
    }
  }
  stmt.free();
  console.log(`Dictionary loaded with ${count} words.`);

  // Personal dictionary
  updatePersonalDict(personalWords);
}

function updatePersonalDict(words) {
  for (const w of words) {
    const lw = w.toLowerCase();
    if (!wordSet.has(lw)) {
      personalDict.add(lw);
      wordSet.add(lw);
      wordFreq.set(lw, 10); // High frequency for personal words
    }
  }
}

function isWordValid(word) {
  return wordSet.has(word.toLowerCase());
}

function getSuggestions(word, limit = 5) {
  const wordLower = word.toLowerCase();
  
  // If word is valid, return empty suggestions
  if (isWordValid(word)) return [];
  
  // Get all possible edits
  const candidates = new Set();
  
  // Add edit distance 1 candidates
  for (const edit of edits1(wordLower)) {
    if (isWordValid(edit)) {
      candidates.add(edit);
    }
  }
  
  // If not enough candidates, add edit distance 2
  if (candidates.size < limit) {
    for (const edit of edits2(wordLower)) {
      if (isWordValid(edit)) {
        candidates.add(edit);
      }
    }
  }
  
  // Convert to array and sort by frequency
  const suggestions = Array.from(candidates);
  suggestions.sort((a, b) => {
    const freqA = wordFreq.get(a) || 0;
    const freqB = wordFreq.get(b) || 0;
    if (freqB !== freqA) return freqB - freqA; // Higher frequency first
    return a.localeCompare(b, 'tr'); // Then alphabetical
  });
  
  return suggestions.slice(0, limit);
}

function checkText(text) {
  const regex = /\b[\wçğıöşüÇĞİÖŞÜ]+\b/g;
  const issues = [];
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