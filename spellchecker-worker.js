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
  
  console.log('🔧 Database initialized, size:', buffer.byteLength, 'bytes');
  
  // Check if madde table exists and has data
  try {
    const tableCheck = db.prepare('SELECT COUNT(*) as count FROM madde');
    tableCheck.step();
    const count = tableCheck.getAsObject().count;
    console.log(`📊 Madde table has ${count} entries`);
    tableCheck.free();
  } catch (error) {
    console.error('❌ Error checking madde table:', error);
  }
  
  // Prepare statements for reuse
  validateStmt = db.prepare('SELECT 1 FROM madde WHERE lower(madde)=lower(?) OR lower(madde_duz)=lower(?) LIMIT 1');
  
  // Basit LIKE sorgusu için statement hazırla
  suggestionsStmt = db.prepare('SELECT madde FROM madde WHERE length(madde) BETWEEN ? AND ? AND lower(madde) LIKE ? LIMIT 300');
  console.log('✅ Simple LIKE statement prepared');
   
  // Initialize personal dictionary
  personalDict = new Set(personalDictArray || []);
  
  // Test database functionality
  console.log('🧪 Testing database functionality...');
  try {
    // Test validation
    const testWord = 'merhaba';
    const isValid = isWordValid(testWord);
    console.log(`  Test word "${testWord}" is valid: ${isValid}`);
    
    // Test suggestions
    const testSuggestions = getSuggestions('merhaba', 3);
    console.log(`  Test suggestions for "merhaba": [${testSuggestions.join(', ')}]`);
    
    // Test with a misspelled word
    const misspelledSuggestions = getSuggestions('meraba', 3);
    console.log(`  Test suggestions for "meraba": [${misspelledSuggestions.join(', ')}]`);
    
  } catch (error) {
    console.error('❌ Database test failed:', error);
  }
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

// Basit edit distance hesaplama (Levenshtein distance)
function simpleEditDistance(str1, str2) {
  const matrix = [];
  
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  
  return matrix[str2.length][str1.length];
}

function getSuggestions(word, limit = 5) {
  const suggestions = new Set();
  const wordLower = word.toLowerCase();
  
  console.log(`🔍 Getting suggestions for: "${word}" (lowercase: "${wordLower}")`);

  // 1. Basit Türkçe karakter değişiklikleri
  const turkishChars = {
    'c': ['ç'],
    'ç': ['c'],
    'g': ['ğ'],
    'ğ': ['g'],
    'i': ['ı', 'İ'],
    'ı': ['i'],
    'İ': ['i'],
    'o': ['ö'],
    'ö': ['o'],
    's': ['ş'],
    'ş': ['s'],
    'u': ['ü'],
    'ü': ['u']
  };

  // Her karakter için Türkçe alternatiflerini dene
  for (let i = 0; i < wordLower.length; i++) {
    const char = wordLower[i];
    const alternatives = turkishChars[char] || [];
    
    for (const alt of alternatives) {
      const variant = wordLower.slice(0, i) + alt + wordLower.slice(i + 1);
      console.log(`  🔄 Trying Turkish variant: "${variant}"`);
      if (isWordValid(variant)) {
        console.log(`  ✅ Found valid variant: "${variant}"`);
        suggestions.add(variant);
      }
    }
  }

  // 2. Basit edit distance ile benzer kelimeleri bul
  const similarWords = findSimilarWords(wordLower, limit * 3);
  console.log(`  📊 Found ${similarWords.length} similar words`);
  
  for (const similar of similarWords) {
    if (suggestions.size >= limit) break;
    suggestions.add(similar);
  }

  const finalSuggestions = Array.from(suggestions);
  console.log(`  🎯 Final suggestions for "${word}":`, finalSuggestions);
  return finalSuggestions;
}



// Benzer kelimeleri bul
function findSimilarWords(target, maxResults = 15) {
  const candidates = [];
  const targetLen = target.length;
  
  try {
    // Uzunluk olarak benzer kelimeleri bul (target ± 2 karakter)
    const minLen = Math.max(2, targetLen - 2);
    const maxLen = targetLen + 2;
    
    console.log(`  🔍 Searching for words with length ${minLen}-${maxLen}`);
    
    // Basit LIKE sorgusu kullan
    const stmt = db.prepare(`
      SELECT madde FROM madde 
      WHERE length(madde) BETWEEN ? AND ? 
      AND lower(madde) LIKE ? 
      LIMIT ?
    `);
    
    // Farklı prefix'ler dene
    const prefixes = [
      target.substring(0, Math.min(3, target.length)) + '%',
      target.substring(0, Math.min(2, target.length)) + '%',
      '%' + target.substring(0, Math.min(2, target.length)) + '%'
    ];
    
    for (const prefix of prefixes) {
      console.log(`  🔍 Trying prefix: "${prefix}"`);
      stmt.bind([minLen, maxLen, prefix, maxResults]);
      
      while (stmt.step()) {
        const word = stmt.getAsObject().madde;
        if (word && word.length > 1) {
          candidates.push(word);
        }
      }
      stmt.reset();
    }
    
    stmt.free();
    
    console.log(`  📊 Found ${candidates.length} candidates with LIKE queries`);
    
    // Edit distance ile sırala
    const scored = candidates.map(word => ({
      word: word,
      distance: simpleEditDistance(target, word.toLowerCase())
    }));
    
    scored.sort((a, b) => a.distance - b.distance);
    
    console.log(`  🏆 Top 5 by edit distance:`, scored.slice(0, 5).map(s => `${s.word}(${s.distance})`));
    
    return scored.slice(0, maxResults).map(s => s.word);
    
  } catch (error) {
    console.error(`  ❌ Error in findSimilarWords:`, error);
    return [];
  }
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