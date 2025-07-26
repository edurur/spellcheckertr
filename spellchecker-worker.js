// spellchecker-worker.js - Fetches gts.json from remote with caching

let dictionary = new Set();
let personalDict = new Set();

// --- Cache Management ---
const CACHE_DB_NAME = 'SpellCheckerCache';
const CACHE_STORE = 'dictionary';
const CACHE_KEY = 'gts_dictionary';
const CACHE_VERSION = 1;

async function openCacheDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB_NAME, CACHE_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE);
      }
    };
  });
}

async function getCachedDictionary() {
  try {
    const db = await openCacheDB();
    const transaction = db.transaction([CACHE_STORE], 'readonly');
    const store = transaction.objectStore(CACHE_STORE);
    const request = store.get(CACHE_KEY);
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.warn("Cache read failed:", e);
    return null;
  }
}

async function saveDictionaryToCache(dictionaryData) {
  try {
    const db = await openCacheDB();
    const transaction = db.transaction([CACHE_STORE], 'readwrite');
    const store = transaction.objectStore(CACHE_STORE);
    store.put(dictionaryData, CACHE_KEY);
  } catch (e) {
    console.warn("Cache write failed:", e);
  }
}

// --- Initialization ---
async function initialize() {
  try {
    // First try to load from cache
    console.log("Checking cache for dictionary...");
    const cached = await getCachedDictionary();
    
    if (cached) {
      console.log("Loading dictionary from cache...");
      dictionary = new Set(cached);
      console.log(`Dictionary loaded from cache with ${dictionary.size} words.`);
      self.postMessage({ type: 'DB_READY' });
      return;
    }
    
    // If not in cache, fetch from remote
    console.log("Fetching dictionary from remote...");
    const response = await fetch('https://p.001717.xyz/gts.json');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const text = await response.text();
    const lines = text.split('\n');

    for (const line of lines) {
      if (line) {
        try {
          const data = JSON.parse(line);
          if (data && data.madde) {
            dictionary.add(data.madde.toLowerCase());
          }
        } catch (e) {
          // console.warn("Could not parse line, skipping.");
        }
      }
    }
    
    // Save to cache
    console.log("Saving dictionary to cache...");
    await saveDictionaryToCache(Array.from(dictionary));
    
    console.log(`Dictionary loaded with ${dictionary.size} words.`);
    self.postMessage({ type: 'DB_READY' });
    
  } catch (e) {
    console.error("Failed to load dictionary:", e);
    self.postMessage({ type: 'ERROR', error: "Sözlük yüklenemedi." });
  }
}

initialize();


// --- Message Handling ---
self.onmessage = (e) => {
  const { type, data } = e.data;
  try {
    switch (type) {
      case 'CHECK_TEXT':
        const issues = checkText(data.text);
        self.postMessage({ type: 'CHECK_RESULT', data: { issues } });
        break;
      case 'UPDATE_PERSONAL_DICT':
        updatePersonalDict(data.words);
        break;
    }
  } catch (err) {
    console.error("Worker error:", err);
    self.postMessage({ type: 'ERROR', error: err.message });
  }
};


// --- Core Logic ---
function isWordValid(word) {
  const lowerWord = word.toLowerCase();
  return dictionary.has(lowerWord) || personalDict.has(lowerWord);
}

function updatePersonalDict(words) {
  personalDict = new Set(words.map(w => w.toLowerCase()));
  console.log("Personal dictionary updated:", personalDict);
}

function getSuggestions(word) {
  const edits1 = (word) => {
    const letters = 'abcçdefgğhıijklmnoöprsştuüvyz';
    const splits = [];
    for (let i = 0; i <= word.length; i++) {
      splits.push([word.slice(0, i), word.slice(i)]);
    }

    const deletes = splits.filter(([, R]) => R).map(([L, R]) => L + R.slice(1));
    const transposes = splits.filter(([, R]) => R.length > 1).map(([L, R]) => L + R[1] + R[0] + R.slice(2));
    const replaces = splits.filter(([, R]) => R).flatMap(([L, R]) => letters.split('').map(c => L + c + R.slice(1)));
    const inserts = splits.flatMap(([L, R]) => letters.split('').map(c => L + c + R));

    return new Set([...deletes, ...transposes, ...replaces, ...inserts]);
  };

  const candidates = new Set();
  for (const edit of edits1(word.toLowerCase())) {
    if (dictionary.has(edit) || personalDict.has(edit)) {
      candidates.add(edit);
    }
  }

  if (candidates.size > 0) {
    return Array.from(candidates).slice(0, 5);
  }
  
  return [];
}

function checkText(text) {
  const regex = /\b[\wçğıöşüÇĞİÖŞÜ]+\b/g;
  const issues = [];
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    const word = match[0];
    if (!isWordValid(word)) {
      issues.push({
        word: word,
        start: match.index,
        end: regex.lastIndex,
        suggestions: getSuggestions(word)
      });
    }
  }
  return issues;
} 