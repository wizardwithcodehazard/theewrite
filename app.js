// ================================
// GitWrite - Distraction-Free Writing App
// ================================

class GitWrite {
    constructor() {
        this.initializeProperties();
        this.initializeIndexedDB();
        this.bindEvents();
        this.loadSettings();
        this.initializeAudio();
        this.registerServiceWorker();
        this.checkOnlineStatus();
        this.restoreNote();
        this.startAutosave();

        this.rainSound = new RainSound();
    }

    // ================================
    // Initialization
    // ================================

    initializeProperties() {
        // DOM Elements
        this.editor = document.getElementById('editor');
        this.toolbar = document.getElementById('toolbar');
        this.sidebar = document.getElementById('sidebar');
        this.timer = document.getElementById('timer');
        this.wordCount = document.getElementById('word-count');
        this.syncIndicator = document.getElementById('sync-indicator');
        this.queueCount = document.getElementById('queue-count');
        this.notesList = document.getElementById('notes-list');
        
        // State
        this.currentNote = {
            id: null,
            content: '',
            timestamp: null,
            title: ''
        };
        
        this.timerState = {
            isRunning: false,
            timeLeft: 15 * 60, // 15 minutes in seconds
            interval: null
        };
        
        this.settings = {
            fontSize: 18,
            fontFamily: 'Lato',
            timerDuration: 15,
            autosaveInterval: 30,
            theme: 'light',
            typingSoundEnabled: false,
            typingVolume: 50
        };

        this.github = {
            token: '',
            owner: '',
            repo: '',
            branch: '',
            pathTemplate: 'notes/{{date}}.md',
            commitMessage: 'Add note {{date}}',
            rememberToken: false
        };

        // Debounce timers
        this.autosaveTimeout = null;
        this.wordCountTimeout = null;
        this.typingAudio = null;
        
        // Queue for offline sync
        this.syncQueue = [];
        this.notesHistory = [];
        this.isSyncing = false;
    }

    async initializeIndexedDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('GitWriteDB', 1);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                this.loadNotesHistory();
                this.loadSyncQueue();
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // Notes store
                if (!db.objectStoreNames.contains('notes')) {
                    const notesStore = db.createObjectStore('notes', { keyPath: 'id' });
                    notesStore.createIndex('timestamp', 'timestamp', { unique: false });
                }
                
                // Sync queue store
                if (!db.objectStoreNames.contains('queue')) {
                    const queueStore = db.createObjectStore('queue', { keyPath: 'id' });
                    queueStore.createIndex('createdAt', 'createdAt', { unique: false });
                    queueStore.createIndex('status', 'status', { unique: false });
                }
            };
        });
    }

    initializeAudio() {
        this.rainSound = new RainSound();
        
        try {
            // NOTE: You need to add a typing sound file at this path
            this.typingAudio = new Audio('./audio/click.mp3');
            this.typingAudio.volume = this.settings.typingVolume / 100;
        } catch (e) {
            console.error("Could not initialize typing sound", e);
            this.typingAudio = null;
        }
    }

    async registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            try {
                const registration = await navigator.serviceWorker.register('/sw.js');
                console.log('ServiceWorker registration successful:', registration.scope);
            } catch (error) {
                console.warn('ServiceWorker registration failed:', error);
                // Continue app execution even if SW fails
            }
        } else {
            console.log('ServiceWorker is not supported');
        }
    }

    // ================================
    // Event Binding
    // ================================

    bindEvents() {
        // Editor events
        this.editor.addEventListener('input', this.handleEditorInput.bind(this));
        this.editor.addEventListener('keydown', this.handleKeyboardShortcuts.bind(this));
        this.editor.addEventListener('keydown', this.handleTyping.bind(this));

        // Toolbar events
        document.getElementById('new-note').addEventListener('click', this.newNote.bind(this));
        document.getElementById('history-toggle').addEventListener('click', this.toggleSidebar.bind(this));
        document.getElementById('timer-toggle').addEventListener('click', this.toggleTimer.bind(this));
        document.getElementById('fullscreen-toggle').addEventListener('click', this.toggleFullscreen.bind(this));
        document.getElementById('theme-toggle').addEventListener('click', this.toggleTheme.bind(this));
        document.getElementById('settings-btn').addEventListener('click', () => this.openModal('settings-modal'));
        document.getElementById('save-local').addEventListener('click', this.saveLocal.bind(this));
        document.getElementById('save-github').addEventListener('click', this.saveToGitHub.bind(this));

        // Sidebar events
        document.getElementById('sidebar-close').addEventListener('click', this.closeSidebar.bind(this));
        document.getElementById('sync-now').addEventListener('click', this.syncNow.bind(this));
        document.getElementById('search-notes').addEventListener('input', this.filterNotes.bind(this));

        // Settings modal events
        document.getElementById('font-size').addEventListener('input', this.updateFontSize.bind(this));
        document.getElementById('font-family').addEventListener('change', this.updateFontFamily.bind(this));
        document.getElementById('timer-duration').addEventListener('change', this.updateTimerDuration.bind(this));
        document.getElementById('autosave-interval').addEventListener('change', this.updateAutosaveInterval.bind(this));

        // Typing sound settings
        document.getElementById('typing-sound-enabled').addEventListener('change', this.updateTypingSoundEnabled.bind(this));
        document.getElementById('typing-volume').addEventListener('input', this.updateTypingVolume.bind(this));

        // GitHub modal events
        document.getElementById('save-github-settings').addEventListener('click', this.saveGitHubSettings.bind(this));
        document.getElementById('test-github').addEventListener('click', this.testGitHubConnection.bind(this));
        document.getElementById('forget-token').addEventListener('click', this.forgetToken.bind(this));

        // Global events
        window.addEventListener('online', this.handleOnline.bind(this));
        window.addEventListener('offline', this.handleOffline.bind(this));
        window.addEventListener('beforeunload', this.handleBeforeUnload.bind(this));
        document.addEventListener('keydown', this.handleGlobalKeyboard.bind(this));
    }

    // ================================
    // Editor Functionality
    // ================================

    handleEditorInput() {
        this.currentNote.content = this.editor.value;
        this.updateWordCount();
        this.scheduleAutosave();
    }

    handleTyping(e) {
        if (!this.settings.typingSoundEnabled || !this.typingAudio) {
            return;
        }

        // A list of keys that should not trigger the sound
        const silentKeys = [
            'Control', 'Meta', 'Alt', 'Shift', 'CapsLock', 'Tab', 'Escape',
            'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
            'Home', 'End', 'PageUp', 'PageDown',
            'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'
        ];

        if (silentKeys.includes(e.key)) {
            return;
        }

        // To allow for rapid typing, we reset the audio and play it.
        this.typingAudio.currentTime = 0;
        this.typingAudio.play().catch(() => { /* Ignore autoplay errors */ });
    }

    updateWordCount() {
        clearTimeout(this.wordCountTimeout);
        this.wordCountTimeout = setTimeout(() => {
            const words = this.editor.value
                .trim()
                .split(/\s+/)
                .filter(word => word.length > 0).length;
            this.wordCount.textContent = words === 1 ? '1 word' : `${words} words`;
        }, 100);
    }

    scheduleAutosave() {
        clearTimeout(this.autosaveTimeout);
        this.autosaveTimeout = setTimeout(() => {
            this.autosaveNote();
        }, this.settings.autosaveInterval * 1000);
    }

    async autosaveNote() {
        if (!this.editor.value.trim()) return;

        const note = {
            id: this.currentNote.id || this.generateId(),
            content: this.editor.value,
            timestamp: new Date().toISOString(),
            title: this.generateTitle(this.editor.value),
            wordCount: this.editor.value.trim().split(/\s+/).filter(w => w.length > 0).length
        };

        this.currentNote = note;
        await this.saveNoteToIndexedDB(note);
        this.loadNotesHistory();
    }

    generateTitle(content) {
        const firstLine = content.split('\n')[0].trim();
        return firstLine.length > 50 ? firstLine.substring(0, 50) + '...' : firstLine || 'Untitled';
    }

    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    // ================================
    // Note Management
    // ================================

    newNote() {
        if (this.editor.value.trim()) {
            this.autosaveNote();
        }
        
        this.currentNote = {
            id: null,
            content: '',
            timestamp: null,
            title: ''
        };
        
        this.editor.value = '';
        this.editor.focus();
        this.updateWordCount();
        this.showNotification('New note started', 'success');
    }

    async loadNote(noteId) {
        const transaction = this.db.transaction(['notes'], 'readonly');
        const store = transaction.objectStore('notes');
        const request = store.get(noteId);

        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                const note = request.result;
                if (note) {
                    this.currentNote = note;
                    this.editor.value = note.content;
                    this.updateWordCount();
                    this.editor.focus();
                    this.closeSidebar();
                    resolve(note);
                } else {
                    reject(new Error('Note not found'));
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteNote(noteId) {
        if (!confirm('Are you sure you want to delete this note?')) return;

        const transaction = this.db.transaction(['notes'], 'readwrite');
        const store = transaction.objectStore('notes');
        
        await new Promise((resolve, reject) => {
            const request = store.delete(noteId);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });

        this.loadNotesHistory();
        this.showNotification('Note deleted', 'success');
    }

    async saveNoteToIndexedDB(note) {
        const transaction = this.db.transaction(['notes'], 'readwrite');
        const store = transaction.objectStore('notes');
        
        return new Promise((resolve, reject) => {
            const request = store.put(note);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async loadNotesHistory() {
        if (!this.db) return;

        const transaction = this.db.transaction(['notes'], 'readonly');
        const store = transaction.objectStore('notes');
        const index = store.index('timestamp');
        const request = index.getAll();

        request.onsuccess = () => {
            const notes = request.result.sort((a, b) => 
                new Date(b.timestamp) - new Date(a.timestamp)
            );
            this.notesHistory = notes;
            this.renderNotesHistory(notes);
        };
    }

    renderNotesHistory(notes) {
        if (notes.length === 0) {
            this.notesList.innerHTML = `
                <div class="empty-state">
                    <p>No notes found. Start writing!</p>
                </div>
            `;
            return;
        }

        this.notesList.innerHTML = notes.map(note => {
            const date = new Date(note.timestamp).toLocaleDateString();
            const time = new Date(note.timestamp).toLocaleTimeString([], { 
                hour: '2-digit', 
                minute: '2-digit' 
            });
            const isQueued = this.isNoteQueued(note.id);

            return `
                <div class="note-item ${isQueued ? 'queued' : ''}" data-note-id="${note.id}">
                    <div class="note-meta">
                        <span>${date} at ${time}</span>
                        <span>${note.wordCount || 0} words</span>
                    </div>
                    <div class="note-preview">${note.title}</div>
                    <div class="note-actions">
                        <button class="btn btn-small" onclick="gitwrite.loadNote('${note.id}')">Open</button>
                        <button class="btn btn-small" onclick="gitwrite.downloadNote('${note.id}')">Download</button>
                        <button class="btn btn-small btn-danger" onclick="gitwrite.deleteNote('${note.id}')">Delete</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    filterNotes(e) {
        const searchTerm = e.target.value.toLowerCase();
        const filteredNotes = this.notesHistory.filter(note => {
            return note.title.toLowerCase().includes(searchTerm) || 
                   note.content.toLowerCase().includes(searchTerm);
        });
        this.renderNotesHistory(filteredNotes);
    }

    // ================================
    // Save Functionality
    // ================================

    async saveLocal() {
        const content = this.editor.value.trim();
        if (!content) {
            this.showNotification('Nothing to save', 'warning');
            return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `note-${timestamp}.md`;
        
        const blob = new Blob([content], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        
        URL.revokeObjectURL(url);
        this.showNotification('Note downloaded successfully', 'success');
    }

    async downloadNote(noteId) {
        const transaction = this.db.transaction(['notes'], 'readonly');
        const store = transaction.objectStore('notes');
        const request = store.get(noteId);

        request.onsuccess = () => {
            const note = request.result;
            if (note) {
                const timestamp = new Date(note.timestamp).toISOString().replace(/[:.]/g, '-');
                const filename = `note-${timestamp}.md`;
                
                const blob = new Blob([note.content], { type: 'text/markdown' });
                const url = URL.createObjectURL(blob);
                
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                
                URL.revokeObjectURL(url);
                this.showNotification('Note downloaded successfully', 'success');
            }
        };
    }

    async saveToGitHub() {
        try {
            if (!this.github?.token) {
                this.openModal('github-modal');
                return;
            }

            const content = this.editor.value;
            if (!content.trim()) {
                this.showNotification('Cannot save empty note', 'error');
                return;
            }

            const githubService = new GitHubService(this.github.token);
            const date = new Date().toISOString().split('T')[0];
            
            // Process templates
            const path = this.processTemplate(this.github.pathTemplate, { date });
            const message = this.processTemplate(this.github.commitMessage, { date });

            this.showNotification('Saving to GitHub...', 'info');

            await githubService.createOrUpdateFile(
                this.github.owner,
                this.github.repo,
                path,
                content,
                message,
                this.github.branch
            );

            this.showNotification('Saved to GitHub successfully', 'success');
        } catch (error) {
            console.error('Failed to save to GitHub:', error);
            this.showNotification(`GitHub save failed: ${error.message}`, 'error');
            
            // Add to sync queue if offline
            if (!navigator.onLine) {
                await this.addToSyncQueue({
                    type: 'github',
                    content: this.editor.value,
                    timestamp: new Date().toISOString()
                });
                this.showNotification('Added to sync queue', 'warning');
            }
        }
    }

    processTemplate(template) {
        const now = new Date();
        const date = now.toISOString().split('T')[0];
        const timestamp = now.toISOString().replace(/[:.]/g, '-');
        
        return template
            .replace(/\{\{date\}\}/g, date)
            .replace(/\{\{timestamp\}\}/g, timestamp);
    }

    // ================================
    // GitHub API Integration
    // ================================

    async testGitHubConnection() {
        const token = document.getElementById('github-token').value;
        const owner = document.getElementById('github-owner').value;
        const repo = document.getElementById('github-repo').value;

        if (!token || !owner || !repo) {
            this.showNotification('Please fill in all required fields', 'error');
            return;
        }

        try {
            const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if (response.ok) {
                const repoData = await response.json();
                this.showNotification(`Connected to ${repoData.full_name}`, 'success');
                
                // Auto-fill branch if empty
                if (!document.getElementById('github-branch').value) {
                    document.getElementById('github-branch').value = repoData.default_branch;
                }
            } else {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error) {
            this.showNotification(`Connection failed: ${error.message}`, 'error');
        }
    }

    async commitToGitHub(job) {
        try {
            // Get default branch if not specified
            let branch = job.branch;
            if (!branch) {
                const repoResponse = await fetch(`https://api.github.com/repos/${job.owner}/${job.repo}`, {
                    headers: {
                        'Authorization': `token ${job.token}`,
                        'Accept': 'application/vnd.github.v3+json'
                    }
                });
                
                if (repoResponse.ok) {
                    const repoData = await repoResponse.json();
                    branch = repoData.default_branch;
                }
            }

            // Check if file exists to get SHA
            let sha = null;
            const fileResponse = await fetch(
                `https://api.github.com/repos/${job.owner}/${job.repo}/contents/${job.path}?ref=${branch}`,
                {
                    headers: {
                        'Authorization': `token ${job.token}`,
                        'Accept': 'application/vnd.github.v3+json'
                    }
                }
            );

            if (fileResponse.ok) {
                const fileData = await fileResponse.json();
                sha = fileData.sha;
            }

            // Create or update file using UTF-8 safe base64 encoding
            const content = utf8ToBase64(job.content);
            const payload = {
                message: job.commitMessage,
                content: content,
                branch: branch
            };

            if (sha) {
                payload.sha = sha;
            }

            const commitResponse = await fetch(
                `https://api.github.com/repos/${job.owner}/${job.repo}/contents/${job.path}`,
                {
                    method: 'PUT',
                    headers: {
                        'Authorization': `token ${job.token}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                }
            );

            if (commitResponse.ok) {
                const result = await commitResponse.json();
                return { success: true, data: result };
            } else {
                const error = await commitResponse.json();
                throw new Error(error.message || `HTTP ${commitResponse.status}`);
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // ================================
    // Sync Queue Management
    // ================================

    async addToSyncQueue(job) {
        const transaction = this.db.transaction(['queue'], 'readwrite');
        const store = transaction.objectStore('queue');
        
        return new Promise((resolve, reject) => {
            const request = store.put(job);
            request.onsuccess = () => {
                this.loadSyncQueue();
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async loadSyncQueue() {
        if (!this.db) return;

        const transaction = this.db.transaction(['queue'], 'readonly');
        const store = transaction.objectStore('queue');
        const request = store.getAll();

        request.onsuccess = () => {
            this.syncQueue = request.result;
            this.updateSyncUI();
        };
    }

    async processSyncQueue() {
        if (this.isSyncing || !navigator.onLine) return;

        const pendingJobs = this.syncQueue.filter(job => job.status === 'pending');
        if (pendingJobs.length === 0) return;

        this.isSyncing = true;
        this.updateSyncIndicator('syncing');

        for (const job of pendingJobs) {
            const result = await this.commitToGitHub(job);
            
            if (result.success) {
                await this.updateQueueJob(job.id, { status: 'completed' });
                this.showNotification('Note synced to GitHub', 'success');
            } else {
                await this.updateQueueJob(job.id, { 
                    status: 'failed', 
                    error: result.error 
                });
                this.showNotification(`Sync failed: ${result.error}`, 'error');
            }
        }

        await this.loadSyncQueue();
        this.isSyncing = false;
        this.updateSyncIndicator(navigator.onLine ? 'online' : 'offline');
    }

    async updateQueueJob(jobId, updates) {
        const transaction = this.db.transaction(['queue'], 'readwrite');
        const store = transaction.objectStore('queue');
        const getRequest = store.get(jobId);

        return new Promise((resolve, reject) => {
            getRequest.onsuccess = () => {
                const job = getRequest.result;
                if (job) {
                    Object.assign(job, updates);
                    const putRequest = store.put(job);
                    putRequest.onsuccess = () => resolve();
                    putRequest.onerror = () => reject(putRequest.error);
                } else {
                    reject(new Error('Job not found'));
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    async clearCompletedJobs() {
        const transaction = this.db.transaction(['queue'], 'readwrite');
        const store = transaction.objectStore('queue');
        const index = store.index('status');
        const request = index.getAll('completed');

        request.onsuccess = () => {
            const completedJobs = request.result;
            completedJobs.forEach(job => {
                store.delete(job.id);
            });
            this.loadSyncQueue();
        };
    }

    updateSyncUI() {
        const pendingJobs = this.syncQueue.filter(job => job.status === 'pending');
        const queueInfo = document.getElementById('queue-info');

        if (pendingJobs.length > 0) {
            this.queueCount.textContent = pendingJobs.length;
            this.queueCount.classList.remove('hidden');
            queueInfo.textContent = `${pendingJobs.length} notes pending sync`;
        } else {
            this.queueCount.classList.add('hidden');
            queueInfo.textContent = 'No pending syncs';
        }

        this.loadNotesHistory(); // Refresh to show queue status
    }

    isNoteQueued(noteId) {
        return this.syncQueue.some(job => 
            job.noteId === noteId && job.status === 'pending'
        );
    }

    // ================================
    // Timer Functionality
    // ================================

    toggleTimer() {
        if (this.timerState.isRunning) {
            this.stopTimer();
        } else {
            this.startTimer();
        }
    }

    startTimer() {
        this.timerState.isRunning = true;
        this.timerState.timeLeft = this.settings.timerDuration * 60;
        this.timer.classList.remove('hidden');
        
        this.timerState.interval = setInterval(() => {
            this.timerState.timeLeft--;
            this.updateTimerDisplay();
            
            if (this.timerState.timeLeft <= 0) {
                this.timerFinished();
            }
        }, 1000);
        
        this.updateTimerDisplay();

        this.rainSound.play(); // Start rain sound when timer starts
    }

    stopTimer() {
        this.timerState.isRunning = false;
        clearInterval(this.timerState.interval);
        this.timer.classList.add('hidden');
        this.timer.classList.remove('warning', 'danger');

        this.rainSound.stop(); // Stop rain sound when timer stops
    }

    updateTimerDisplay() {
        const minutes = Math.floor(this.timerState.timeLeft / 60);
        const seconds = this.timerState.timeLeft % 60;
        const display = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        this.timer.textContent = display;
        
        // Visual feedback for time remaining
        if (this.timerState.timeLeft <= 60) {
            this.timer.classList.add('danger');
        } else if (this.timerState.timeLeft <= 300) {
            this.timer.classList.add('warning');
        }
    }

    timerFinished() {
        this.stopTimer();
        this.showNotification('Timer finished! Great job writing!', 'success');
        
        // Auto-save when timer finishes
        if (this.editor.value.trim()) {
            this.autosaveNote();
        }
    }

    // ================================
    // UI Controls
    // ================================

    toggleSidebar() {
        this.sidebar.classList.toggle('open');
        if (this.sidebar.classList.contains('open')) {
            this.loadNotesHistory();
        }
    }

    closeSidebar() {
        this.sidebar.classList.remove('open');
    }

    toggleFullscreen() {
        document.body.classList.toggle('fullscreen');
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            document.documentElement.requestFullscreen();
        }
    }

    toggleTheme() {
        const currentTheme = document.body.className.includes('theme-dark') ? 'dark' : 'light';
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        
        document.body.className = document.body.className.replace(/theme-\w+/, `theme-${newTheme}`);
        this.settings.theme = newTheme;
        this.saveSettings();
    }

    openModal(modalId) {
        const modal = document.getElementById(modalId);
        const overlay = document.getElementById('modal-overlay');
        
        if (modalId === 'github-modal') {
            this.loadGitHubSettings();
        }
        
        modal.classList.add('active');
        overlay.classList.add('active');
    }

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        const overlay = document.getElementById('modal-overlay');
        
        modal.classList.remove('active');
        overlay.classList.remove('active');
    }

    // ================================
    // Settings Management
    // ================================

    loadSettings() {
        const saved = localStorage.getItem('gitwrite-settings');
        if (saved) {
            this.settings = { ...this.settings, ...JSON.parse(saved) };
        }
        
        this.applySettings();
    }

    saveSettings() {
        localStorage.setItem('gitwrite-settings', JSON.stringify(this.settings));
    }

    applySettings() {
        // Apply theme
        document.body.className = `theme-${this.settings.theme}`;
        
        // Apply font settings
        this.editor.style.fontSize = `${this.settings.fontSize}px`;
        this.editor.className = `editor font-${this.settings.fontFamily}`;
        
        // Update UI controls
        document.getElementById('font-size').value = this.settings.fontSize;
        document.getElementById('font-size-value').textContent = `${this.settings.fontSize}px`;
        document.getElementById('font-family').value = this.settings.fontFamily;
        document.getElementById('timer-duration').value = this.settings.timerDuration;
        document.getElementById('autosave-interval').value = this.settings.autosaveInterval;

        // Apply typing sound settings
        document.getElementById('typing-sound-enabled').checked = this.settings.typingSoundEnabled;
        document.getElementById('typing-volume').value = this.settings.typingVolume;
        if (this.typingAudio) {
            this.typingAudio.volume = this.settings.typingVolume / 100;
        }
    }

    updateFontSize() {
        const size = document.getElementById('font-size').value;
        this.settings.fontSize = parseInt(size);
        this.editor.style.fontSize = `${size}px`;
        document.getElementById('font-size-value').textContent = `${size}px`;
        this.saveSettings();
    }

    updateFontFamily() {
        const family = document.getElementById('font-family').value;
        this.settings.fontFamily = family;
        this.editor.className = `editor font-${family}`;
        this.saveSettings();
    }

    updateTimerDuration() {
        this.settings.timerDuration = parseInt(document.getElementById('timer-duration').value);
        this.saveSettings();
    }

    updateAutosaveInterval() {
        this.settings.autosaveInterval = parseInt(document.getElementById('autosave-interval').value);
        this.saveSettings();
    }

    updateTypingSoundEnabled() {
        this.settings.typingSoundEnabled = document.getElementById('typing-sound-enabled').checked;
        this.saveSettings();
    }

    updateTypingVolume() {
        const volume = document.getElementById('typing-volume').value;
        this.settings.typingVolume = parseInt(volume, 10);
        if (this.typingAudio) {
            this.typingAudio.volume = this.settings.typingVolume / 100;
        }
        this.saveSettings();
    }

    // ================================
    // GitHub Settings
    // ================================

    loadGitHubSettings() {
        document.getElementById('github-token').value = this.github.token;
        document.getElementById('github-owner').value = this.github.owner;
        document.getElementById('github-repo').value = this.github.repo;
        document.getElementById('github-branch').value = this.github.branch;
        document.getElementById('github-path').value = this.github.pathTemplate;
        document.getElementById('commit-message').value = this.github.commitMessage;
        document.getElementById('remember-token').checked = this.github.rememberToken;
    }

    async saveGitHubSettings() {
        const token = document.getElementById('github-token').value;
        const owner = document.getElementById('github-owner').value;
        const repo = document.getElementById('github-repo').value;
        const branch = document.getElementById('github-branch').value || 'main';
        const pathTemplate = document.getElementById('github-path').value;
        const commitMessage = document.getElementById('commit-message').value;

        if (!token || !owner || !repo) {
            this.showNotification('Please fill in required GitHub settings', 'error');
            return;
        }

        // Test connection before saving
        try {
            const service = new GitHubService(token);
            await service.getFile(owner, repo, 'README.md', branch).catch(() => {
                // Ignore if README.md doesn't exist
            });

            this.github = {
                token,
                owner,
                repo,
                branch,
                pathTemplate: pathTemplate || 'notes/{{date}}.md',
                commitMessage: commitMessage || 'Add note {{date}}'
            };

            localStorage.setItem('github-settings', JSON.stringify({
                ...this.github,
                token: this.github.rememberToken ? token : ''
            }));

            this.closeModal('github-modal');
            this.showNotification('GitHub settings saved', 'success');
        } catch (error) {
            console.error('GitHub connection test failed:', error);
            this.showNotification('Invalid GitHub settings', 'error');
        }
    }

    forgetToken() {
        if (confirm('This will clear your GitHub token and all pending sync jobs. Continue?')) {
            this.github.token = '';
            localStorage.removeItem('gitwrite-github');
            sessionStorage.removeItem('gitwrite-github');
            
            // Clear sync queue
            const transaction = this.db.transaction(['queue'], 'readwrite');
            const store = transaction.objectStore('queue');
            store.clear();
            
            this.loadGitHubSettings();
            this.loadSyncQueue();
            this.showNotification('GitHub token forgotten', 'success');
        }
    }

    // ================================
    // Event Handlers
    // ================================

    handleKeyboardShortcuts(e) {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const cmdKey = isMac ? e.metaKey : e.ctrlKey;

        if (cmdKey && e.key === 's') {
            e.preventDefault();
            if (e.shiftKey) {
                this.saveLocal();
            } else {
                this.saveToGitHub();
            }
        }
    }

    handleGlobalKeyboard(e) {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const cmdKey = isMac ? e.metaKey : e.ctrlKey;

        if (e.key === 'Escape') {
            this.closeSidebar();
            document.querySelectorAll('.modal.active').forEach(modal => {
                modal.classList.remove('active');
            });
            document.getElementById('modal-overlay').classList.remove('active');
        }

        if (cmdKey) {
            switch (e.key) {
                case 'n':
                    e.preventDefault();
                    this.newNote();
                    break;
                case 'b':
                    e.preventDefault();
                    this.toggleSidebar();
                    break;
            }
        }
    }

    handleOnline() {
        this.updateSyncIndicator('online');
        this.processSyncQueue();
    }

    handleOffline() {
        this.updateSyncIndicator('offline');
    }

    updateSyncIndicator(status) {
        this.syncIndicator.className = `sync-indicator ${status}`;
        
        const titles = {
            online: 'Online',
            offline: 'Offline',
            syncing: 'Syncing...'
        };
        
        this.syncIndicator.title = titles[status] || status;
    }

    checkOnlineStatus() {
        this.updateSyncIndicator(navigator.onLine ? 'online' : 'offline');
    }

    handleBeforeUnload(e) {
        if (this.editor.value.trim() && this.editor.value !== this.currentNote.content) {
            e.preventDefault();
            e.returnValue = '';
        }
    }

    syncNow() {
        if (!navigator.onLine) {
            this.showNotification('No internet connection', 'error');
            return;
        }
        
        this.processSyncQueue();
    }

    // ================================
    // Utility Functions
    // ================================

    restoreNote() {
        // Try to restore from localStorage or sessionStorage
        const githubSettings = localStorage.getItem('gitwrite-github') || 
                              sessionStorage.getItem('gitwrite-github');
        
        if (githubSettings) {
            this.github = { ...this.github, ...JSON.parse(githubSettings) };
        }
        
        // Focus editor
        setTimeout(() => {
            this.editor.focus();
        }, 100);
    }

    startAutosave() {
        // Initial word count
        this.updateWordCount();
        
        // Start processing sync queue if online
        if (navigator.onLine) {
            setTimeout(() => {
                this.processSyncQueue();
            }, 1000);
        }
        
        // Clean up completed jobs periodically
        setInterval(() => {
            this.clearCompletedJobs();
        }, 5 * 60 * 1000); // Every 5 minutes
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.textContent = message;
        
        document.getElementById('notifications').appendChild(notification);
        
        setTimeout(() => {
            notification.classList.add('show');
        }, 100);
        
        setTimeout(() => {
            notification.classList.remove('show');
            setTimeout(() => {
                notification.remove();
            }, 300);
        }, 3000);
    }
}

// ================================
// Global Functions
// ================================

function closeModal(modalId) {
    gitwrite.closeModal(modalId);
}

// ================================
// Initialize App
// ================================

let gitwrite;

document.addEventListener('DOMContentLoaded', () => {
    gitwrite = new GitWrite();
});

// Make gitwrite globally available for onclick handlers
window.gitwrite = gitwrite;