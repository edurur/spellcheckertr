// spellchecker-worker.js - Web Worker for spell checking operations

let db = null;
let validateStmt = null;
let suggestionsStmt = null;
let personalDict = new Set();

// Import sql.js in the worker
importScripts('sql-wasm.js');

self.onmessage = async function(e) {
  const { type, data } = e.data;
  
  try {
    switch(type) {
      case 'INIT_DB':
        await initDatabase(data.buffer, data.personalDict);
        self.postMessage({ type: 'DB_READY' });
        break;
        
      case 'CHECK_TEXT':
        const issues = checkText(data.text);
        self.postMessage({ type: 'CHECK_RESULT', data: { issues } });
        break;
        
      case 'UPDATE_PERSONAL_DICT':
        personalDict = new Set(data.words);
        self.postMessage({ type: 'PERSONAL_DICT_UPDATED' });
        break;
        
      default:
        console.warn('Unknown message type:', type);
    }
  } catch (error) {
    self.postMessage({ type: 'ERROR', error: error.message });
  }
};

async function initDatabase(buffer, personalDictArray) {
  const SQL = await initSqlJs({ locateFile: file => file });
  db = new SQL.Database(new Uint8Array(buffer));
  
  // Prepare statements for reuse
  validateStmt = db.prepare('SELECT 1 FROM madde WHERE lower(madde)=lower(?) OR lower(madde_duz)=lower(?) LIMIT 1');
  
  // 🚀 Create FTS5 virtual table for fast suggestion queries
  try {
    db.exec(`
      CREATE VIRTUAL TABLE madde_fts USING fts5(
        madde,
        madde_normalized,
        content='madde',
        tokenize='unicode61'
      );
    `);
    
    // Populate FTS5 table with normalized content for better matching
    const populateStmt = db.prepare(`
      INSERT INTO madde_fts(madde, madde_normalized) 
      SELECT madde, lower(madde) FROM madde
    `);
    populateStmt.run();
    populateStmt.free();
    
    // Use FTS5 for suggestions
    suggestionsStmt = db.prepare(`
      SELECT madde, rank 
      FROM madde_fts 
      WHERE madde_fts MATCH ? 
      ORDER BY rank 
      LIMIT ?
    `);
    
    console.log('FTS5 virtual table created successfully');
  } catch (error) {
    console.warn('FTS5 not available, falling back to LIKE queries:', error);
    // Fallback to original LIKE-based approach
    suggestionsStmt = db.prepare('SELECT madde FROM madde WHERE length(madde) BETWEEN ? AND ? AND lower(madde) LIKE ? LIMIT 300');
  }
   
  // Initialize personal dictionary
  personalDict = new Set(personalDictArray || []);
}

function isWordValid(word) {
  if (!validateStmt) return false;
  
  // Check personal dictionary first
  if (personalDict.has(word.toLowerCase())) return true;
  
  validateStmt.bind([word, word]);
  const valid = validateStmt.step();
  validateStmt.reset();
  
  return valid;
}

// 🎯 QWERTY keyboard layout for distance-based typo correction
const QWERTY_LAYOUT = {
  'q': [0, 0], 'w': [1, 0], 'e': [2, 0], 'r': [3, 0], 't': [4, 0], 'y': [5, 0], 'u': [6, 0], 'i': [7, 0], 'o': [8, 0], 'p': [9, 0],
  'a': [0, 1], 's': [1, 1], 'd': [2, 1], 'f': [3, 1], 'g': [4, 1], 'h': [5, 1], 'j': [6, 1], 'k': [7, 1], 'l': [8, 1],
  'z': [0, 2], 'x': [1, 2], 'c': [2, 2], 'v': [3, 2], 'b': [4, 2], 'n': [5, 2], 'm': [6, 2],
  // Turkish specific keys
  'ğ': [9, 1], 'ü': [10, 1], 'ş': [9.5, 2], 'i': [7, 0], 'ı': [7.5, 0], 'ö': [8.5, 1], 'ç': [7.5, 2]
};

// Calculate physical distance between two keys on QWERTY keyboard
function getKeyboardDistance(char1, char2) {
  const pos1 = QWERTY_LAYOUT[char1.toLowerCase()];
  const pos2 = QWERTY_LAYOUT[char2.toLowerCase()];
  
  if (!pos1 || !pos2) return 3; // Default penalty for unknown characters
  
  // Euclidean distance between key positions
  const dx = pos1[0] - pos2[0];
  const dy = pos1[1] - pos2[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// Enhanced edit distance that considers keyboard layout
function keyboardAwareEditDistance(source, target) {
  const m = source.length;
  const n = target.length;
  
  if (m === 0) return n;
  if (n === 0) return m;
  
  // Create distance matrix
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  // Initialize base cases
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  // Fill the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (source[i - 1] === target[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]; // No cost for exact match
      } else {
        // Calculate keyboard-aware substitution cost
        const keyDist = getKeyboardDistance(source[i - 1], target[j - 1]);
        const substitutionCost = 0.3 + (keyDist * 0.2); // Base cost + distance penalty
        
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,         // Deletion
          dp[i][j - 1] + 1,         // Insertion  
          dp[i - 1][j - 1] + substitutionCost // Substitution with keyboard penalty
        );
      }
    }
  }
  
  return dp[m][n];
}

function getSuggestions(word, limit = 5) {
  const suggestions = new Set();
  const wordLower = word.toLowerCase();

  // 1. Enhanced quick wins: Turkish/ASCII swaps + adjacent key checks
  // 🔄 Bidirectional Turkish-ASCII character mappings
  const turkishAsciiMap = new Map([
    // Turkish → ASCII
    ['ç', 'c'], ['ğ', 'g'], ['ı', 'i'], ['ö', 'o'], ['ş', 's'], ['ü', 'u'],
    // ASCII → Turkish (common substitutions)
    ['c', 'ç'], ['g', 'ğ'], ['i', 'ı'], ['o', 'ö'], ['s', 'ş'], ['u', 'ü'],
    // Handle İ/i distinction
    ['İ', 'i'], ['I', 'ı'],
    // Circumflex variants
    ['â', 'a'], ['î', 'i'], ['û', 'u']
  ]);

  // Check character swaps
  for (let i = 0; i < wordLower.length; i++) {
    const char = wordLower[i];
    
    // Try Turkish/ASCII variants
    const alternatives = turkishAsciiMap.get(char);
    if (alternatives) {
      // Handle single alternative
      const variant = wordLower.slice(0, i) + alternatives + wordLower.slice(i + 1);
      if (isWordValid(variant)) {
        suggestions.add(variant);
      }
    }
    
    // Also try multiple Turkish variants for ASCII characters
    if (['c', 'g', 'i', 'o', 's', 'u'].includes(char)) {
      const turkishVariants = {
        'c': ['ç'],
        'g': ['ğ'], 
        'i': ['ı', 'İ'],
        'o': ['ö'],
        's': ['ş'],
        'u': ['ü']
      };
      
      for (const turkishChar of turkishVariants[char] || []) {
        const variant = wordLower.slice(0, i) + turkishChar + wordLower.slice(i + 1);
        if (isWordValid(variant)) {
          suggestions.add(variant);
        }
      }
    }
    
    // Check adjacent key substitutions (common typos)
    const adjacentKeys = getAdjacentKeys(char);
    for (const adjKey of adjacentKeys) {
      const variant = wordLower.slice(0, i) + adjKey + wordLower.slice(i + 1);
      if (isWordValid(variant)) {
        suggestions.add(variant);
      }
    }
  }

  if (suggestions.size >= limit) {
    return Array.from(suggestions).slice(0, limit);
  }

  // 2. FTS5 search or fallback to LIKE queries
  if (!suggestionsStmt) return Array.from(suggestions);
  
  let candidates = [];
  
  try {
    // Try FTS5 search with normalized query for better Turkish matching
    const normalizedWord = normalizeTurkish(wordLower);
    const ftsQuery = `"${wordLower}"* OR ${wordLower}* OR "${normalizedWord}"* OR ${normalizedWord}*`;
    suggestionsStmt.bind([ftsQuery, limit * 10]); // Get more candidates for ranking
    
    while(suggestionsStmt.step()){
      const row = suggestionsStmt.getAsObject();
      candidates.push(row.madde);
    }
    suggestionsStmt.reset();
  } catch (error) {
    // Fallback to LIKE queries if FTS5 fails
    const prefixLen = Math.min(word.length, 3);
    const likePattern = wordLower.substring(0, prefixLen) + '%';
    const minLen = Math.max(1, word.length - 2);
    const maxLen = word.length + 2;

    suggestionsStmt.bind([minLen, maxLen, likePattern]);
    
    while(suggestionsStmt.step()){
      candidates.push(suggestionsStmt.getAsObject().madde);
    }
    suggestionsStmt.reset();
  }

  // 3. Rank candidates using keyboard-aware edit distance
  
  // 🇹🇷 Comprehensive Turkish diacritic normalization
  function normalizeTurkish(str) {
    if (!str) return '';
    
    return str
      .toLowerCase()
      // Turkish to ASCII mappings
      .replace(/ç/g, 'c')
      .replace(/ğ/g, 'g') 
      .replace(/ı/g, 'i')
      .replace(/İ/g, 'i')  // Capital İ to i
      .replace(/ö/g, 'o')
      .replace(/ş/g, 's')
      .replace(/ü/g, 'u')
      // Handle edge cases and variations
      .replace(/â/g, 'a')  // Circumflex a
      .replace(/î/g, 'i')  // Circumflex i  
      .replace(/û/g, 'u')  // Circumflex u
      // Remove any remaining diacritics (for borrowed words)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')  // Remove combining diacritical marks
      .normalize('NFC');
  }
  
  const normTarget = normalizeTurkish(wordLower);
  
  // Enhanced ranking: keyboard-aware edit distance + length similarity
  candidates.sort((a, b) => {
    const normA = normalizeTurkish(a);
    const normB = normalizeTurkish(b);
    const distA = keyboardAwareEditDistance(normTarget, normA);
    const distB = keyboardAwareEditDistance(normTarget, normB);
    
    // Primary sort by keyboard-aware edit distance
    if (distA !== distB) return distA - distB;
    
    // Secondary sort by length similarity (prefer similar lengths)
    const lenDiffA = Math.abs(a.length - wordLower.length);
    const lenDiffB = Math.abs(b.length - wordLower.length);
    if (lenDiffA !== lenDiffB) return lenDiffA - lenDiffB;
    
    // Tertiary sort by alphabetical order for consistency
    return a.localeCompare(b, 'tr');
  });
  
  for (const cand of candidates) {
    if (suggestions.size >= limit) break;
    suggestions.add(cand);
  }
  
  return Array.from(suggestions);
}

// Get keys adjacent to a given key on QWERTY layout
function getAdjacentKeys(char) {
  const pos = QWERTY_LAYOUT[char.toLowerCase()];
  if (!pos) return [];
  
  const adjacent = [];
  const [x, y] = pos;
  
  // Check all positions within distance 1.5 (immediate neighbors)
  for (const [key, [kx, ky]] of Object.entries(QWERTY_LAYOUT)) {
    const distance = Math.sqrt((x - kx) ** 2 + (y - ky) ** 2);
    if (distance > 0 && distance <= 1.5) { // Adjacent but not same key
      adjacent.push(key);
    }
  }
  
  return adjacent;
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