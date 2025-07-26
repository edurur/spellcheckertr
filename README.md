# Turkish Spell Checker (Web)

## Description

This is a web-based Turkish spell checker that runs entirely in the browser. It uses the TDK (Turkish Language Association) dictionary loaded via SQLite for accurate spelling suggestions. The app supports live checking, suggestions, and various user-friendly features.

## Features

- Local caching of dictionary using IndexedDB for fast subsequent loads
- Dark mode support with automatic OS preference detection
- Inline suggestion popups for misspelled words
- Personal dictionary stored in localStorage
- Performance optimizations with prepared SQL statements and Web Workers
- Full-text search (FTS5) for quick and relevant suggestions
- Keyboard-aware typo detection (QWERTY layout)
- Comprehensive Turkish diacritic handling
- Download progress indicator
- Auto-expanding text area
- Real-time statistics (word count, character count, error count)
- Proper undo/redo support for text edits

## Usage

1. Open the web page in your browser.
2. If it's the first time, click 'Veritabanını İndir / Güncelle' to download the dictionary.
3. Type or paste text into the text area.
4. Enable 'Canlı Mod' for real-time checking.
5. Click underlined words for suggestions.
6. Use Ctrl+Z for undo after accepting suggestions.

## Setup for Development

1. Clone the repository: `git clone https://github.com/edurur/spellcheckertr.git`
2. Navigate to the project directory: `cd spellcheckertr`
3. Run a local server: `python3 -m http.server 8000`
4. Open `http://localhost:8000` in your browser.

## Data Source

The dictionary is sourced from TDK and loaded from https://p.001717.xyz/v12.gts.sqlite3.db

## License

This project is open source and available under the MIT License. 