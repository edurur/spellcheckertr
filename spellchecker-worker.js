// spellchecker-worker.js – brand-new implementation using BK-tree

importScripts('sql-wasm.js');

// ----------------------- BK-tree implementation ---------------------------
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const v0 = new Array(b.length + 1);
  const v1 = new Array(b.length + 1);

  for (let i = 0; i < v0.length; i++) v0[i] = i;

  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(
        v1[j] + 1,          // insertion
        v0[j + 1] + 1,      // deletion
        v0[j] + cost        // substitution
      );
    }
    for (let j = 0; j < v0.length; j++) v0[j] = v1[j];
  }
  return v1[b.length];
}

class BKNode {
  constructor(word) {
    this.word = word;
    this.children = new Map(); // distance -> BKNode
  }
  insert(word) {
    const dist = levenshtein(word, this.word);
    if (this.children.has(dist)) {
      this.children.get(dist).insert(word);
    } else {
      this.children.set(dist, new BKNode(word));
    }
  }
  search(target, maxDist, results) {
    const dist = levenshtein(target, this.word);
    if (dist <= maxDist) results.push({ word: this.word, dist });

    for (let [childDist, child] of this.children) {
      if (childDist >= dist - maxDist && childDist <= dist + maxDist) {
        child.search(target, maxDist, results);
      }
    }
  }
}

class BKTree {
  constructor() { this.root = null; }
  insert(word) {
    if (!this.root) this.root = new BKNode(word);
    else this.root.insert(word);
  }
  search(word, maxDist = 2) {
    if (!this.root) return [];
    const results = [];
    this.root.search(word, maxDist, results);
    results.sort((a, b) => a.dist - b.dist || a.word.localeCompare(b.word, 'tr'));
    return results.map(r => r.word);
  }
}

// ----------------------- Worker State -------------------------------------
let db = null;
let wordSet = new Set();
let bkTree = new BKTree();
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

  // Fetch all words (unique, lower-case) from dictionary
  const stmt = db.prepare('SELECT lower(madde) AS w FROM madde');
  let count = 0;
  while (stmt.step()) {
    const w = stmt.getAsObject().w;
    if (!wordSet.has(w)) {
      wordSet.add(w);
      bkTree.insert(w);
      count++;
    }
  }
  stmt.free();
  console.log(`BK-tree built with ${count} words.`);

  // Personal dictionary
  updatePersonalDict(personalWords);
}

function updatePersonalDict(words) {
  for (const w of words) {
    const lw = w.toLowerCase();
    if (!wordSet.has(lw)) {
      personalDict.add(lw);
      wordSet.add(lw);
      bkTree.insert(lw);
    }
  }
}

function isWordValid(word) {
  return wordSet.has(word.toLowerCase());
}

function getSuggestions(word, limit = 5) {
  const results = bkTree.search(word.toLowerCase(), 2 /*max distance*/);
  return results.filter(w => w !== word.toLowerCase()).slice(0, limit);
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