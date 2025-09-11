# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🚨 CRITICAL DEVELOPMENT GUIDELINES

### Code Quality and Safety Standards
Before making ANY changes to this codebase, Claude must adhere to these non-negotiable principles:

#### 1. **Zero-Regression Policy**
- **NEVER break existing functionality** when adding new features or refactoring
- Always test existing features after making changes
- Preserve all current user workflows and interactions
- Maintain backward compatibility for settings and data structures

#### 2. **Impact Assessment Required**
- Before executing any code changes, analyze how they will affect:
  - The main clipboard monitoring system
  - Auto-paste functionality 
  - OCR processing pipeline
  - Settings and data persistence
  - UI responsiveness and user experience
  - Cross-component interactions

#### 3. **Feature Implementation Standards**
- **No regressions allowed** when implementing new features
- New features must integrate seamlessly with existing architecture
- Maintain the application's performance characteristics
- Ensure new features don't interfere with core clipboard functionality

#### 4. **Code Quality Requirements**
- Generate **clean, readable, and well-commented** code
- Write **reusable functions and components** wherever possible
- Follow consistent naming conventions and code structure
- Implement proper error handling and edge case management
- Use TypeScript-style JSDoc comments for complex functions

#### 5. **Testing and Validation**
- Before suggesting code changes, mentally trace through:
  - How the change affects the main.js clipboard polling
  - Whether renderer.js UI updates will still work correctly
  - If the preload.js IPC bridge remains secure and functional
  - Whether settings persistence will continue working
- Validate that all existing hotkeys and shortcuts remain functional
- Ensure OCR processing doesn't get disrupted

## Common Development Commands

### Running the Application
```bash
npm run dev          # Run in development mode with hot reload
npm start           # Run the application in production mode
```

### Building and Distribution
```bash
npm run pack        # Package the app without creating installer
npm run dist        # Create Windows installer (NSIS)
```

## Application Architecture

### Core Technology Stack
- **Electron**: Desktop application framework (main.js, preload.js, overlay.html)
- **Native Dependencies**: 
  - `active-win`: Window detection for clipboard context capture
  - `tesseract.js`: OCR processing for image clipboard content
  - `electron-store`: Persistent settings and history storage

### Main Components

#### Main Process (`main.js`)
- **Clipboard Polling**: Monitors system clipboard for text and images every 200ms
- **OCR Processing**: Automatically extracts text from images using Tesseract.js
- **Window Management**: Creates and manages the overlay window with configurable sizing
- **Auto-paste System**: Windows-specific PowerShell implementation for precise window targeting
- **Active Window Tracking**: Captures source application context when enabled
- **Data Persistence**: Uses electron-store for settings, history, and collections

#### Renderer Process (`renderer.js`) 
- **Sidebar Navigation**: Tab-based filtering (Recent, Images, URLs, Pinned, Collections)
- **Search Engine**: Fuzzy and exact search with advanced filtering (tags, type, OCR content)
- **Paste Stack**: FIFO queue system for multi-item paste operations
- **Quick Actions**: Context-aware actions (email compose, maps, URL opening)
- **Collections Management**: User-defined groupings of clipboard items

#### Preload Script (`preload.js`)
- **IPC Bridge**: Secure communication between renderer and main processes
- **Fuzzy Search**: Optional Fuse.js integration for advanced text matching

### Key Features

#### Auto-paste System
- Captures active window before showing overlay to maintain paste target
- Uses Windows PowerShell with native Win32 APIs for reliable keystroke injection
- Configurable via `autoPasteOnSelect` setting

#### OCR Integration
- Automatically processes clipboard images with Tesseract.js
- Supports multiple model locations (local, resources, node_modules)
- Async processing with UI updates when OCR text is available

#### Clipboard Context Capture
- Optional feature to record source application and window title
- Uses active-win library with noise filtering for system windows
- Configurable sampling interval and age limits

#### Data Storage Structure
- **Settings Store**: Theme, hotkeys, limits, feature toggles
- **History Store**: All clipboard items with metadata, tags, timestamps
- **Collections Store**: User-defined groupings with item references

### Window Sizing and Display
- Three size presets: small (640×440), medium (800×520), large (900×560)
- Automatically centers on display containing mouse cursor
- Maintains focus in source application when auto-paste is enabled

### Hotkey System
- Global shortcut registration with fallback to default
- Electron accelerator format with cross-platform key mapping
- Real-time hotkey capture in settings UI

### File Organization
```
clip-overlay/
├── main.js          # Main Electron process
├── preload.js       # Secure IPC bridge
├── renderer.js      # UI logic and state management
├── overlay.html     # Application UI structure
├── styles.css       # Main styling (dark theme)
├── light-theme.css  # Light theme overrides
└── package.json     # Dependencies and build configuration
```

## Development Best Practices

### Before Making Changes
1. **Understand the current flow**: Trace how clipboard data moves from system → main.js → renderer.js
2. **Identify dependencies**: Map which components depend on the code you're changing
3. **Plan integration**: Design how new features will integrate without disrupting existing ones
4. **Consider edge cases**: Think about error states, race conditions, and unusual user behaviors

### Code Modification Checklist
- [ ] Does this change affect the clipboard polling mechanism?
- [ ] Will existing settings and user data remain compatible?
- [ ] Are all IPC communications still secure and functional?
- [ ] Does the UI remain responsive and intuitive?
- [ ] Are performance characteristics maintained or improved?
- [ ] Is error handling robust and user-friendly?

### Refactoring Guidelines
- Extract common functionality into reusable utility functions
- Maintain clear separation between main process, renderer, and preload responsibilities
- Keep async operations properly handled with appropriate error catching
- Preserve existing API contracts between components

## Development Notes

### Testing OCR Functionality
OCR requires the English trained data model. The application will automatically locate it from:
1. Local `tessdata/eng/` directory
2. Application resources path
3. `@tesseract.js-data/eng` npm package

### Debugging
Enable debug logging via settings UI or by setting `debugLogging: true` in the settings store. Logs include:
- Clipboard capture events with metadata
- OCR processing status and timing
- Auto-paste execution details
- Active window detection results

### Building for Distribution
The build process uses electron-builder with NSIS installer for Windows. The configuration includes:
- ASAR packaging with tesseract WASM file exclusions
- Icon and artifact naming
- Per-user installation with optional directory selection

## ⚠️ Final Reminder for Claude Code

**Every code change must be evaluated through the lens of system stability and user experience. When in doubt, prioritize preserving existing functionality over adding new features. The application's core value is reliable clipboard management - never compromise this foundation.**