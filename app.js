// TheeWrite — lean, private, local-first freewriting
// Features: tags, reread mode, tag cloud, export PDF/MD/TXT, timer, sounds
'use strict';

// ══════════════════════════════════════════
// DB
// ══════════════════════════════════════════
function openDB() {
    return new Promise((res, rej) => {
        const req = indexedDB.open('TheeWriteDB', 1);
        req.onerror = () => rej(req.error);
        req.onsuccess = () => res(req.result);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('notes')) {
                const s = db.createObjectStore('notes', { keyPath: 'id' });
                s.createIndex('timestamp', 'timestamp');
            }
        };
    });
}

const dbOp = (db, stores, mode, fn) => new Promise((res, rej) => {
    const tx = db.transaction(stores, mode);
    const s  = tx.objectStore(stores[0]);
    const req = fn(s);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
});

const dbPut    = (db, n) => dbOp(db, ['notes'], 'readwrite', s => s.put(n));
const dbGet    = (db, id) => dbOp(db, ['notes'], 'readonly',  s => s.get(id));
const dbDelete = (db, id) => dbOp(db, ['notes'], 'readwrite', s => s.delete(id));
const dbGetAll = (db) =>
    new Promise((res, rej) => {
        const req = db.transaction(['notes'], 'readonly')
                      .objectStore('notes').index('timestamp').getAll();
        req.onsuccess = () => res(req.result.sort((a,b) => b.timestamp.localeCompare(a.timestamp)));
        req.onerror   = () => rej(req.error);
    });

// ══════════════════════════════════════════
// Utilities
// ══════════════════════════════════════════
const $ = id => document.getElementById(id);
const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const wc   = t  => t.trim() ? t.trim().split(/\s+/).length : 0;
const head = t  => { const l = t.split('\n')[0].trim(); return l.length > 64 ? l.slice(0,64)+'…' : l || 'Untitled'; };
const fmtDate = iso => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})
         + ' · ' + d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
};

// ── Toast ─────────────────────────────────
let _toastT;
const toast = (msg, type='') => {
    clearTimeout(_toastT);
    const el = $('toast');
    el.textContent = msg;
    el.className = 'show' + (type ? ' '+type : '');
    _toastT = setTimeout(() => el.className = '', 2400);
};

// ══════════════════════════════════════════
// App
// ══════════════════════════════════════════
class TheeWrite {
    constructor(db) {
        this.db = db;

        // — cached DOM refs —
        this.editorEl     = $('editor');
        this.wcEl         = $('word-count');
        this.timerEl      = $('timer');
        this.tagPillsEl   = $('tag-pills');
        this.tagInputEl   = $('tag-input');
        this.sidebarEl    = $('sidebar');
        this.notesListEl  = $('notes-list');
        this.tagCloudEl   = $('tag-cloud-view');
        this.overlayEl    = $('overlay');
        this.settingsEl   = $('settings-modal');
        this.searchEl     = $('search-notes');
        this.tagFilterWrap = $('tag-filter-wrapper');
        this.tagFilterSel  = $('tag-filter-selected');
        this.tagFilterOpts = $('tag-filter-options');
        this.ambientWrap  = $('ambient-sound-wrapper');
        this.ambientSel   = $('ambient-sound-selected');
        this.ambientOpts  = $('ambient-sound-options');
        this.rereadEl     = $('reread-panel');
        this.printEl      = $('print-area');

        // — state —
        this.note      = { id: null, content: '', tags: [] };
        this.allNotes  = [];
        this.tagFilter = '';
        this.sideView  = 'list'; // 'list' | 'tagcloud'

        this.timer = { running: false, left: 15*60, iv: null };

        // — settings —
        this.cfg = this.loadCfg();

        // — audio —
        this.clickAudio = null;
        this.ambientAudio = null;
        try {
            this.clickAudio = new Audio('./audio/click.mp3');
            this.clickAudio.volume = this.cfg.volume / 100;
        } catch(_) {}

        // — reread state —
        this.rereadNotes = [];
        this.rereadIdx   = 0;

        // — popup tracking —
        this._activePopup = null;

        this.applyCfg();
        this.bind();
        this.loadHistory();
        this.registerSW();
        this.requestPersistence();
        this.editorEl.focus();
    }

    // ── Config ─────────────────────────────
    loadCfg() {
        const d = { fontSize:18, font:'Lato', timerMin:15, autosaveSec:30, sound:false, volume:50, ambientSound:'none' };
        try { return { ...d, ...JSON.parse(localStorage.getItem('gw-cfg')||'{}') }; }
        catch(_) { return d; }
    }
    saveCfg() { localStorage.setItem('gw-cfg', JSON.stringify(this.cfg)); }

    applyCfg() {
        const c = this.cfg;
        this.editorEl.style.fontSize = c.fontSize + 'px';
        this.setFont(c.font, false);
        // sync settings panel
        $('font-size').value         = c.fontSize;
        $('font-size-val').textContent = c.fontSize + 'px';
        $('font-size-label').textContent = c.fontSize + 'px';
        $('timer-duration').value    = c.timerMin;
        $('autosave-interval').value = c.autosaveSec;
        $('typing-sound-enabled').checked = c.sound;
        $('typing-volume').value     = c.volume;
        $('vol-val').textContent     = c.volume + '%';
        if (this.ambientSel && this.ambientOpts) {
            const opt = this.ambientOpts.querySelector(`div[data-val="${c.ambientSound}"]`);
            if (opt) this.ambientSel.textContent = opt.textContent;
            this.ambientOpts.querySelectorAll('div').forEach(el => {
                el.classList.toggle('selected', el.dataset.val === c.ambientSound);
            });
        }
        this.timer.left = c.timerMin * 60;
        this.updateTimerDisplay();
    }

    // ── Font ───────────────────────────────
    setFont(name, save=true) {
        this.cfg.font = name;
        this.editorEl.className = 'font-' + name;
        // update active state in toolbar
        document.querySelectorAll('.font-opt').forEach(b => {
            b.classList.toggle('active', b.dataset.font === name);
        });
        if (save) this.saveCfg();
    }

    // ── Bind all events ────────────────────
    bind() {
        // Editor input
        this.editorEl.addEventListener('input', () => {
            this.note.content = this.editorEl.value;
            this.schedWC();
            this.schedSave();
        });

        // Typing sound
        this.editorEl.addEventListener('keydown', e => {
            if (!this.cfg.sound || !this.clickAudio) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const skip = ['Shift','Control','Alt','Meta','CapsLock','Tab','Escape',
                          'ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key);
            if (skip) return;
            this.clickAudio.currentTime = 0;
            this.clickAudio.play().catch(()=>{});
        });

        // Toolbar buttons
        $('btn-new').addEventListener('click', () => this.newNote());
        $('btn-history').addEventListener('click', () => this.toggleSidebar());
        $('btn-timer').addEventListener('click', () => this.toggleTimer());
        $('btn-fullscreen').addEventListener('click', () => this.toggleFullscreen());
        $('btn-settings').addEventListener('click', () => this.openSettings());
        $('btn-save').addEventListener('click', () => this.downloadCurrent());
        $('btn-reread').addEventListener('click', () => this.openReread());

        // Font opts
        document.querySelectorAll('.font-opt').forEach(b => {
            b.addEventListener('click', () => this.setFont(b.dataset.font));
        });

        // Font size popup
        $('btn-fontsize').addEventListener('click', e => {
            e.stopPropagation();
            this.togglePopup('fontsize-popup', e.target);
        });
        document.querySelectorAll('.size-opt').forEach(b => {
            b.addEventListener('click', () => {
                const sz = +b.dataset.size;
                if (!sz) return;
                this.cfg.fontSize = sz;
                this.editorEl.style.fontSize = sz + 'px';
                $('font-size').value = sz;
                $('font-size-val').textContent = sz + 'px';
                $('font-size-label').textContent = sz + 'px';
                this.saveCfg();
                this.closePopup();
            });
        });

        // Export popup
        $('btn-export').addEventListener('click', e => {
            e.stopPropagation();
            this.togglePopup('export-popup', e.target);
        });
        $('export-md').addEventListener('click',  () => { this.closePopup(); this.download('md');  });
        $('export-txt').addEventListener('click', () => { this.closePopup(); this.download('txt'); });
        $('export-pdf').addEventListener('click', () => { this.closePopup(); this.exportPDF();     });

        // Click outside → close popup
        document.addEventListener('click', e => {
            if (this._activePopup && !$('btn-fontsize').contains(e.target)
                                   && !$('btn-export').contains(e.target)) {
                this.closePopup();
            }
        });

        // Tags
        this.tagInputEl.addEventListener('keydown', e => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const tag = e.target.value.trim().toLowerCase().replace(/\s+/g, '-');
            if (tag && !this.note.tags.includes(tag)) {
                this.note.tags.push(tag);
                this.renderPills();
                this.schedSave();
            }
            e.target.value = '';
        });

        // Sidebar
        $('btn-sidebar-close').addEventListener('click', () => this.closeSidebar());
        this.searchEl.addEventListener('input',  () => this.renderHistory());
        
        // Sidebar custom dropdown
        this.tagFilterSel.addEventListener('click', e => {
            e.stopPropagation();
            this.tagFilterWrap.classList.toggle('active');
            this.tagFilterOpts.classList.toggle('hidden');
            this.closePopup();
        });
        document.addEventListener('click', e => {
            if (!this.tagFilterWrap.contains(e.target)) {
                this.tagFilterWrap.classList.remove('active');
                this.tagFilterOpts.classList.add('hidden');
            }
        });

        // Sidebar tabs
        document.querySelectorAll('.stab').forEach(btn => {
            btn.addEventListener('click', () => {
                this.sideView = btn.dataset.view;
                document.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b === btn));
                $('notes-list').classList.toggle('hidden',   this.sideView !== 'list');
                $('tag-cloud-view').classList.toggle('hidden', this.sideView !== 'tagcloud');
                if (this.sideView === 'tagcloud') this.renderTagCloud();
            });
        });

        // Reread nav
        $('btn-reread-close').addEventListener('click', () => this.closeReread());
        $('btn-reread-prev').addEventListener('click',  () => this.rereadGo(-1));
        $('btn-reread-next').addEventListener('click',  () => this.rereadGo(+1));

        // Overlay
        this.overlayEl.addEventListener('click', () => {
            this.closeSidebar();
            this.closeSettings();
        });

        // Settings
        this.settingsEl.addEventListener('click', e => {
            if (e.target === this.settingsEl) this.closeSettings();
        });
        this.settingsEl.querySelector('.modal-close').addEventListener('click', () => this.closeSettings());

        $('font-size').addEventListener('input', () => {
            const sz = +$('font-size').value;
            this.cfg.fontSize = sz;
            this.editorEl.style.fontSize = sz + 'px';
            $('font-size-val').textContent = sz + 'px';
            $('font-size-label').textContent = sz + 'px';
            this.saveCfg();
        });
        $('timer-duration').addEventListener('change', () => {
            this.cfg.timerMin = +$('timer-duration').value;
            if (!this.timer.running) {
                this.timer.left = this.cfg.timerMin * 60;
                this.updateTimerDisplay();
            }
            this.saveCfg();
        });
        $('autosave-interval').addEventListener('change', () => {
            this.cfg.autosaveSec = +$('autosave-interval').value;
            this.saveCfg();
        });
        $('typing-sound-enabled').addEventListener('change', () => {
            this.cfg.sound = $('typing-sound-enabled').checked;
            this.saveCfg();
        });
        $('typing-volume').addEventListener('input', () => {
            this.cfg.volume = +$('typing-volume').value;
            $('vol-val').textContent = this.cfg.volume + '%';
            if (this.clickAudio) this.clickAudio.volume = this.cfg.volume / 100;
            if (this.ambientAudio) this.ambientAudio.volume = this.cfg.volume / 100;
            this.saveCfg();
        });

        if (this.ambientWrap && this.ambientSel && this.ambientOpts) {
            this.ambientSel.addEventListener('click', e => {
                e.stopPropagation();
                this.ambientWrap.classList.toggle('active');
                this.ambientOpts.classList.toggle('hidden');
                this.closePopup();
            });
            this.ambientOpts.querySelectorAll('div').forEach(el => {
                el.addEventListener('click', () => {
                    const val = el.dataset.val;
                    this.cfg.ambientSound = val;
                    this.ambientSel.textContent = el.textContent;
                    this.ambientOpts.querySelectorAll('div').forEach(o => o.classList.toggle('selected', o === el));
                    this.ambientWrap.classList.remove('active');
                    this.ambientOpts.classList.add('hidden');
                    this.saveCfg();
                    if (this.timer.running) this.playAmbient();
                });
            });
            document.addEventListener('click', e => {
                if (!this.ambientWrap.contains(e.target)) {
                    this.ambientWrap.classList.remove('active');
                    this.ambientOpts.classList.add('hidden');
                }
            });
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                this.closePopup();
                if (!this.rereadEl.classList.contains('hidden')) { this.closeReread(); return; }
                this.closeSidebar(); this.closeSettings(); return;
            }
            const mod = e.ctrlKey || e.metaKey;
            if (!mod) return;
            if (e.key === 'n') { e.preventDefault(); this.newNote(); }
            if (e.key === 'h') { e.preventDefault(); this.toggleSidebar(); }
            if (e.key === 's') { e.preventDefault(); this.downloadCurrent(); }
        });

        window.addEventListener('beforeunload', e => {
            if (this.editorEl.value.trim() && this.editorEl.value !== this.note.content) {
                e.preventDefault(); e.returnValue = '';
            }
        });
    }

    // ── Popup management ───────────────────
    togglePopup(id, anchor) {
        if (this._activePopup === id) { this.closePopup(); return; }
        this.closePopup();
        const el = $(id);
        el.classList.remove('hidden');
        // position above anchor
        const r = anchor.closest ? anchor.closest('button, div') || anchor : anchor;
        const rect = r.getBoundingClientRect();
        el.style.left = rect.left + 'px';
        this._activePopup = id;
    }
    closePopup() {
        if (!this._activePopup) return;
        const el = $(this._activePopup);
        if (el) el.classList.add('hidden');
        this._activePopup = null;
    }

    // ── Word count (debounced) ─────────────
    schedWC() {
        clearTimeout(this._wcT);
        this._wcT = setTimeout(() => {
            const n = wc(this.editorEl.value);
            this.wcEl.textContent = n === 1 ? '1 word' : n + ' words';
        }, 120);
    }

    // ── Autosave (debounced) ───────────────
    schedSave() {
        clearTimeout(this._saveT);
        this._saveT = setTimeout(() => this.saveNote(), this.cfg.autosaveSec * 1000);
    }

    async saveNote() {
        if (!this.editorEl.value.trim()) return;
        const note = {
            id:        this.note.id || uid(),
            content:   this.editorEl.value,
            timestamp: new Date().toISOString(),
            title:     head(this.editorEl.value),
            wordCount: wc(this.editorEl.value),
            tags:      [...(this.note.tags || [])],
            font:      this.cfg.font || 'Lato'
        };
        this.note.id = note.id;
        await dbPut(this.db, note);
        // Only refresh allNotes in memory — don't re-render sidebar unless open
        this.allNotes = await dbGetAll(this.db);
        this.refreshTagFilter();
        if (this.sidebarEl.classList.contains('open')) this.renderHistory();
    }

    // ── New note ───────────────────────────
    newNote() {
        if (this.editorEl.value.trim()) this.saveNote();
        this.note = { id: null, content: '', tags: [] };
        this.editorEl.value = '';
        this.tagPillsEl.innerHTML = '';
        this.schedWC();
        this.editorEl.focus();
        toast('New note started');
    }

    // ── Open note from history ─────────────
    async openNote(id) {
        const note = await dbGet(this.db, id);
        if (!note) return;
        if (this.editorEl.value.trim()) await this.saveNote();
        this.note = { id: note.id, content: note.content, tags: note.tags || [] };
        this.editorEl.value = note.content;
        this.schedWC();
        this.renderPills();
        this.closeSidebar();
        this.editorEl.focus();
        // highlight active note
        document.querySelectorAll('.note-item').forEach(el =>
            el.classList.toggle('active-note', el.dataset.id === id));
    }

    async deleteNote(id) {
        if (!confirm('Delete this note permanently?')) return;
        await dbDelete(this.db, id);
        if (this.note.id === id) this.newNote();
        this.allNotes = await dbGetAll(this.db);
        this.refreshTagFilter();
        this.renderHistory();
        toast('Deleted', 'danger');
    }

    // ── Download / Export ──────────────────
    download(ext, content, filename) {
        const text    = content  || this.editorEl.value.trim();
        const fname   = filename || ('note-' + new Date().toISOString().replace(/[:.]/g,'-') + '.' + ext);
        const mime    = ext === 'md' ? 'text/markdown' : 'text/plain';
        if (!text) { toast('Nothing to save', 'warn'); return; }
        const a = Object.assign(document.createElement('a'), {
            href: URL.createObjectURL(new Blob([text], {type: mime})),
            download: fname
        });
        a.click(); URL.revokeObjectURL(a.href);
        toast('Downloaded!', 'success');
    }

    downloadCurrent() { this.download('md'); }

    exportPDF() {
        const content = this.editorEl.value.trim();
        if (!content) { toast('Nothing to print', 'warn'); return; }
        const el = this.printEl;
        el.innerHTML = `
            <div class="print-title">${head(content)}</div>
            <div class="print-meta">${fmtDate(new Date().toISOString())} · ${wc(content)} words</div>
            <div>${content}</div>
        `;
        el.classList.remove('hidden');
        window.print();
        setTimeout(() => el.classList.add('hidden'), 500);
    }

    // ── History ────────────────────────────
    async loadHistory() {
        this.allNotes = await dbGetAll(this.db);
        this.refreshTagFilter();
    }

    refreshTagFilter() {
        const tags = [...new Set(this.allNotes.flatMap(n => n.tags||[]))].sort();
        const cur  = this.tagFilter;
        this.tagFilterOpts.innerHTML = `<div data-val="" class="${cur===''?'selected':''}">All tags</div>`
            + tags.map(t => `<div data-val="${t}" class="${t===cur?'selected':''}">${t}</div>`).join('');
            
        this.tagFilterOpts.querySelectorAll('div').forEach(el => {
            el.addEventListener('click', () => {
                this.filterByTag(el.dataset.val, el.textContent);
                this.tagFilterWrap.classList.remove('active');
                this.tagFilterOpts.classList.add('hidden');
            });
        });
        
        this.tagFilterSel.textContent = cur ? cur : 'All tags';
    }

    renderHistory() {
        const q   = this.searchEl.value.toLowerCase();
        const tag = this.tagFilter;
        const filtered = this.allNotes.filter(n => {
            const mq  = !q   || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q);
            const mt  = !tag || (n.tags||[]).includes(tag);
            return mq && mt;
        });

        if (!filtered.length) {
            this.notesListEl.innerHTML = '<div class="empty-state">No notes yet.<br>Start writing — it\'s saved automatically.</div>';
            return;
        }

        this.notesListEl.innerHTML = filtered.map(n => `
            <div class="note-item" data-id="${n.id}">
                <div class="note-meta">
                    <span>${fmtDate(n.timestamp)}</span>
                    <span>${n.wordCount||0} words</span>
                </div>
                <div class="note-title">${n.title}</div>
                ${(n.tags||[]).length ? `<div class="note-tags">${n.tags.map(t=>`<span class="tag-chip">${t}</span>`).join('')}</div>` : ''}
                <div class="note-actions">
                    <button class="note-btn" onclick="app.openNote('${n.id}')">Open</button>
                    <button class="note-btn" onclick="app.rereadNote('${n.id}')">Reread</button>
                    <button class="note-btn" onclick="app.download('md','${this._esc(n.content)}','note.md')">↓ md</button>
                    <button class="note-btn danger" onclick="app.deleteNote('${n.id}')">Delete</button>
                </div>
            </div>
        `).join('');
    }

    _esc(s) { return s.replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

    // ── Tag Cloud ──────────────────────────
    renderTagCloud() {
        const freq = {};
        this.allNotes.forEach(n => (n.tags||[]).forEach(t => { freq[t] = (freq[t]||0) + 1; }));
        const tags = Object.entries(freq).sort((a,b) => b[1]-a[1]);

        if (!tags.length) {
            this.tagCloudEl.innerHTML = '<div class="empty-state">No tags yet.<br>Add tags while writing above.</div>';
            return;
        }

        const max = tags[0][1];
        this.tagCloudEl.innerHTML = tags.map(([t, c]) => {
            const sz = 12 + Math.round((c/max) * 18); // 12–30px
            return `<span class="cloud-tag" style="font-size:${sz}px" onclick="app.filterByTag('${t}')" title="${c} note${c>1?'s':''}">
                ${t}<sup class="cloud-count">${c}</sup>
            </span>`;
        }).join('');
    }

    filterByTag(tag, label) {
        this.tagFilter = tag;
        this.sideView = 'list';
        document.querySelectorAll('.stab').forEach(b =>
            b.classList.toggle('active', b.dataset.view === 'list'));
        $('notes-list').classList.remove('hidden');
        $('tag-cloud-view').classList.add('hidden');
        this.refreshTagFilter();
        this.renderHistory();
        toast(`Showing: ${label || (tag ? tag : 'All tags')}`);
    }

    // ── Tags ───────────────────────────────
    renderPills() {
        this.tagPillsEl.innerHTML = (this.note.tags||[]).map(t => `
            <span class="tag-pill">${t}
                <button type="button" onclick="app.removeTag('${t}')" aria-label="Remove">×</button>
            </span>
        `).join('');
    }
    removeTag(tag) {
        this.note.tags = this.note.tags.filter(t => t !== tag);
        this.renderPills();
        this.schedSave();
    }

    // ── Sidebar ────────────────────────────
    toggleSidebar() {
        this.sidebarEl.classList.contains('open') ? this.closeSidebar() : this.openSidebar();
    }
    openSidebar() {
        this.renderHistory();
        if (this.sideView === 'tagcloud') this.renderTagCloud();
        this.sidebarEl.classList.add('open');
        this.overlayEl.classList.add('active');
    }
    closeSidebar() {
        this.sidebarEl.classList.remove('open');
        if (!this.settingsEl.classList.contains('open')) this.overlayEl.classList.remove('active');
    }

    // ── Settings ───────────────────────────
    openSettings() {
        this.settingsEl.classList.remove('hidden');
        this.settingsEl.classList.add('open');
        this.overlayEl.classList.add('active');
    }
    closeSettings() {
        this.settingsEl.classList.add('hidden');
        this.settingsEl.classList.remove('open');
        if (!this.sidebarEl.classList.contains('open')) this.overlayEl.classList.remove('active');
    }

    // ── Reread mode ────────────────────────
    async openReread(startId) {
        this.rereadNotes = [...this.allNotes];
        if (!this.rereadNotes.length) { toast('No saved notes yet', 'warn'); return; }
        this.rereadIdx = startId
            ? Math.max(0, this.rereadNotes.findIndex(n => n.id === startId))
            : 0;
        this.rereadEl.classList.remove('hidden');
        this.renderReread();
    }

    async rereadNote(id) {
        this.closeSidebar();
        await this.openReread(id);
    }

    renderReread() {
        const n = this.rereadNotes[this.rereadIdx];
        if (!n) return;
        $('reread-title').textContent = n.title;
        $('reread-meta').textContent  = fmtDate(n.timestamp) + '  ·  ' + (n.wordCount||wc(n.content)) + ' words';
        $('reread-content').textContent = n.content;
        
        const f = n.font || 'Playfair';
        $('reread-content').className = 'font-' + f;
        
        $('reread-count').textContent   = `${this.rereadIdx+1} / ${this.rereadNotes.length}`;
        $('reread-body').scrollTop = 0;
    }

    rereadGo(dir) {
        this.rereadIdx = Math.max(0, Math.min(this.rereadNotes.length-1, this.rereadIdx + dir));
        this.renderReread();
    }

    closeReread() {
        this.rereadEl.classList.add('hidden');
    }

    // ── Timer ──────────────────────────────
    updateTimerDisplay() {
        const m = Math.floor(this.timer.left / 60);
        const s = String(this.timer.left % 60).padStart(2,'0');
        const display = `${m}:${s}`;
        $('btn-timer').textContent = display;
        this.timerEl.textContent   = display;
    }

    toggleTimer() {
        this.timer.running ? this.stopTimer() : this.startTimer();
    }

    playAmbient() {
        if (this.ambientAudio) {
            this.ambientAudio.pause();
            this.ambientAudio = null;
        }
        if (this.cfg.ambientSound === 'none') return;
        try {
            this.ambientAudio = new Audio(`./audio/${this.cfg.ambientSound}.mp3`);
            this.ambientAudio.loop = true;
            this.ambientAudio.volume = this.cfg.volume / 100;
            this.ambientAudio.play().catch(()=>{});
        } catch(_) {}
    }

    stopAmbient() {
        if (this.ambientAudio) {
            this.ambientAudio.pause();
            this.ambientAudio = null;
        }
    }

    startTimer() {
        this.timer.running = true;
        this.timerEl.classList.remove('hidden');
        this.playAmbient();
        this.timer.iv = setInterval(() => {
            this.timer.left--;
            this.updateTimerDisplay();
            const l = this.timer.left;
            this.timerEl.className = l <= 0 ? 'danger' : l <= 60 ? 'danger' : l <= 180 ? 'warn' : '';
            if (l <= 0) { this.stopTimer(); toast("Time's up! Great session.", 'success'); }
        }, 1000);
    }

    stopTimer() {
        clearInterval(this.timer.iv);
        this.timer.running = false;
        this.stopAmbient();
        this.timer.left = this.cfg.timerMin * 60;
        this.updateTimerDisplay();
        this.timerEl.classList.add('hidden');
        this.timerEl.className = 'hidden';
        $('btn-timer').textContent = this.cfg.timerMin + ':00';
    }

    // ── Fullscreen ─────────────────────────
    toggleFullscreen() {
        document.fullscreenElement
            ? document.exitFullscreen()
            : document.documentElement.requestFullscreen().catch(()=>{});
    }

    // ── Service Worker & Storage ───────────
    registerSW() {
        if ('serviceWorker' in navigator)
            navigator.serviceWorker.register('./sw.js').catch(()=>{});
    }

    async requestPersistence() {
        if (navigator.storage && navigator.storage.persist) {
            try {
                const isPersisted = await navigator.storage.persisted();
                if (!isPersisted) await navigator.storage.persist();
            } catch (_) {}
        }
    }
}

// ══════════════════════════════════════════
// Boot
// ══════════════════════════════════════════
let app;
openDB().then(db => { app = new TheeWrite(db); });