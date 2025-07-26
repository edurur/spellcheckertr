// spellchecker-worker.js - Reads gts.json directly

let dictionary = new Set();
let personalDict = new Set();

// --- Initialization ---
async function initialize() {
  try {
    console.log("Fetching dictionary from gts.json...");
    const response = await fetch('gts.json');
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