// ============================================================================
// 0. EARLY GLOBAL ERROR MONITOR & DIAGNOSTIC CAPTURE (RUNS BEFORE ALL SCRIPTS)
// ============================================================================
(function initEarlyGlobalErrorMonitor() {
    if (window.APP_ERROR_HANDLER && window.APP_ERROR_HANDLER.__v2Rebuilt) return;
    const STORAGE_KEY = 'starblock_v2_error_log_v3';
    let persistedLogs = [];
    try {
        window.sessionStorage.removeItem('starblock_v2_error_log_v1');
        window.localStorage.removeItem('starblock_v2_error_log_v1');
        window.sessionStorage.removeItem('starblock_v2_error_log_v2');
        window.localStorage.removeItem('starblock_v2_error_log_v2');
        window.sessionStorage.removeItem(STORAGE_KEY);
        window.localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}

    function parseStackLocation(stackStr, fallbackFile, fallbackLine, fallbackCol) {
        const result = {
            file: fallbackFile || 'unknown',
            line: Number.isFinite(Number(fallbackLine)) ? Number(fallbackLine) : 0,
            column: Number.isFinite(Number(fallbackCol)) ? Number(fallbackCol) : 0,
            func: 'anonymous'
        };
        if (typeof stackStr === 'string' && stackStr.trim()) {
            const lines = stackStr.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const ln = lines[i].trim();
                if (!ln || ln.includes('initEarlyGlobalErrorMonitor') || ln.includes('APP_ERROR_HANDLER')) continue;
                const matchWithFn = ln.match(/at\s+([^\s(]+)\s+\((?:.*\/)?([^/:()]+):(\d+):(\d+)\)/);
                if (matchWithFn) {
                    result.func = matchWithFn[1];
                    result.file = matchWithFn[2];
                    result.line = parseInt(matchWithFn[3], 10) || result.line;
                    result.column = parseInt(matchWithFn[4], 10) || result.column;
                    break;
                }
                const matchNoFn = ln.match(/(?:at\s+)?(?:.*\/)?([^/\s:()]+):(\d+):(\d+)/);
                if (matchNoFn) {
                    result.file = matchNoFn[1];
                    result.line = parseInt(matchNoFn[2], 10) || result.line;
                    result.column = parseInt(matchNoFn[3], 10) || result.column;
                    break;
                }
            }
        }
        return result;
    }

    function detectGameContext() {
        let phase = 'initialization';
        let lifecycleStage = 'initialization';
        if (window.__STARBLOCK_PHASE__) {
            phase = String(window.__STARBLOCK_PHASE__);
        } else if (window.BATTLE_CINEMATIC && window.BATTLE_CINEMATIC.active) {
            phase = 'menu_spectator';
        } else if (typeof window.gameStarted !== 'undefined') {
            phase = window.gameStarted ? 'playing' : 'menu';
        }
        if (phase === 'playing') lifecycleStage = 'gameplay';
        else if (phase === 'menu' || phase === 'menu_spectator' || phase === 'multiplayer' || phase === 'lobby') lifecycleStage = 'menu';
        else if (document.readyState === 'complete') lifecycleStage = 'menu';

        let biome = 'koprulu';
        try {
            if (typeof window.getCurrentPlanetBiome === 'function') {
                const b = window.getCurrentPlanetBiome();
                if (b && b.id) biome = b.id;
            } else if (window.CURRENT_PLANET_BIOME_ID) {
                biome = window.CURRENT_PLANET_BIOME_ID;
            }
        } catch (_) {}

        let mapSeed = 0;
        try {
            if (typeof window.ACTIVE_MAP_SEED === 'number') mapSeed = window.ACTIVE_MAP_SEED;
        } catch (_) {}

        return {
            phase,
            lifecycleStage,
            biome,
            mapSeed,
            rendererActive: Boolean(window.renderer && window.renderer.domElement)
        };
    }

    function classifyErrorCategory(contextStr, msgStr, severityStr) {
        const combined = `${contextStr || ''} ${msgStr || ''}`.toLowerCase();
        if (severityStr === 'warn' || severityStr === 'warning') return 'warnings';
        if (combined.includes('resource') || combined.includes('<script') || combined.includes('<img') || combined.includes('<link') || combined.includes('audio') || combined.includes('404')) return 'resource';
        if (combined.includes('webgl') || combined.includes('shader') || combined.includes('three') || combined.includes('texture') || combined.includes('material') || combined.includes('render') || combined.includes('shadow')) return 'graphics';
        if (combined.includes('ai') || combined.includes('zerg') || combined.includes('spectator') || combined.includes('cinematic') || combined.includes('path') || combined.includes('nav')) return 'ai';
        if (combined.includes('init') || combined.includes('bootstrap') || combined.includes('dependency') || combined.includes('load')) return 'initialization';
        return 'errors';
    }

    const handler = {
        __v2Rebuilt: true,
        logs: persistedLogs,
        maxLogs: 5000,
        overlayEl: null,
        pillEl: null,
        activeFilter: 'all',
        searchQuery: '',
        expandedIds: {},
        confirmingClear: false,

        _persist() {
            try {
                const slice = this.logs.slice(-400);
                const serialized = JSON.stringify(slice);
                window.sessionStorage.setItem(STORAGE_KEY, serialized);
                window.localStorage.setItem(STORAGE_KEY, serialized);
            } catch (_) {}
        },

        getCounts() {
            let errors = 0;
            let warnings = 0;
            let totalOccurrences = 0;
            for (let i = 0; i < this.logs.length; i++) {
                const item = this.logs[i];
                const c = item.count || 1;
                totalOccurrences += c;
                if (item.severity === 'warn' || item.category === 'warnings') warnings += c;
                else errors += c;
            }
            return { unique: this.logs.length, errors, warnings, totalOccurrences };
        },

        record(context, err, severity = 'error', extraMeta = null) {
            try {
                const nowIso = new Date().toISOString();
                const nowTime = nowIso.slice(11, 23);
                const msg = err && err.message ? String(err.message) : String(err ?? 'Unknown error');
                const rawStack = err && err.stack ? String(err.stack) : (extraMeta && extraMeta.stack ? String(extraMeta.stack) : `${context}: ${msg}`);
                // Distinguish Vite development HMR WebSocket (/@vite/client) from application multiplayer WebSocket (/ws)
                if (msg.includes('/@vite/client') || rawStack.includes('/@vite/client') || (msg.includes('[vite]') && msg.toLowerCase().includes('websocket'))) {
                    return;
                }
                const parsedLoc = parseStackLocation(
                    rawStack,
                    extraMeta && extraMeta.file,
                    extraMeta && extraMeta.line,
                    extraMeta && extraMeta.column
                );
                const gameCtx = detectGameContext();
                const normSeverity = (severity === 'warn' || severity === 'warning') ? 'warn' : 'error';
                const category = (extraMeta && extraMeta.category) || classifyErrorCategory(context, msg, normSeverity);
                const affectedObject = (extraMeta && extraMeta.affectedObject) || null;
                const dedupKey = `${normSeverity}|${context}|${msg}|${parsedLoc.file}:${parsedLoc.line}:${parsedLoc.column}`;

                let existing = null;
                for (let i = this.logs.length - 1; i >= 0; i--) {
                    if (this.logs[i].dedupKey === dedupKey) {
                        existing = this.logs[i];
                        break;
                    }
                }

                if (existing) {
                    existing.count = (existing.count || 1) + 1;
                    existing.lastSeenIso = nowIso;
                    existing.lastSeenTime = nowTime;
                    existing.gamePhase = gameCtx.phase;
                    existing.lifecycleStage = gameCtx.lifecycleStage;
                    existing.biome = gameCtx.biome;
                    if (!existing.fullStack && rawStack) existing.fullStack = rawStack;
                } else {
                    const entry = {
                        id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                        dedupKey,
                        time: nowTime,
                        firstSeenIso: nowIso,
                        firstSeenTime: nowTime,
                        lastSeenIso: nowIso,
                        lastSeenTime: nowTime,
                        context: String(context || 'runtime'),
                        severity: normSeverity,
                        category,
                        message: msg,
                        file: parsedLoc.file,
                        line: parsedLoc.line,
                        column: parsedLoc.column,
                        func: parsedLoc.func,
                        stack: rawStack.split('\n').slice(0, 6).join(' | '),
                        fullStack: rawStack,
                        count: 1,
                        affectedObject,
                        gamePhase: gameCtx.phase,
                        lifecycleStage: gameCtx.lifecycleStage,
                        biome: gameCtx.biome,
                        mapSeed: gameCtx.mapSeed,
                        rendererActive: gameCtx.rendererActive
                    };
                    if (this.logs.length >= this.maxLogs) {
                        this.logs.shift();
                    }
                    this.logs.push(entry);
                }

                this._persist();
                this.updateStatusPill();
                if (this.overlayEl && this.overlayEl.style.display !== 'none') {
                    this.renderDiagnosticOverlay();
                }
            } catch (_) {}
        },

        ensureStatusPill() {
            if (!document.body) return null;
            if (!this.pillEl) {
                const pill = document.createElement('button');
                pill.id = 'starblock-error-monitor-pill';
                pill.type = 'button';
                pill.title = 'Open StarBlock Error Monitor (Shortcut: F9)';
                pill.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:2147483646;display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:6px;font:700 10px/1.2 monospace;letter-spacing:0.06em;cursor:pointer;pointer-events:auto;box-shadow:0 4px 14px rgba(0,0,0,0.65);transition:transform 0.15s ease,background 0.2s ease;';
                pill.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleDiagnosticOverlay();
                });
                document.body.appendChild(pill);
                this.pillEl = pill;
            }
            this.updateStatusPill();
            return this.pillEl;
        },

        updateStatusPill() {
            if (!document.body) return;
            if (!this.pillEl) {
                this.ensureStatusPill();
                return;
            }
            const counts = this.getCounts();
            if (counts.errors > 0) {
                this.pillEl.style.background = 'rgba(68, 12, 22, 0.94)';
                this.pillEl.style.border = '1px solid #ff4d6d';
                this.pillEl.style.color = '#ffd6de';
                this.pillEl.textContent = `ERR: ${counts.errors} | WARN: ${counts.warnings} [F9]`;
            } else if (counts.warnings > 0) {
                this.pillEl.style.background = 'rgba(64, 46, 10, 0.92)';
                this.pillEl.style.border = '1px solid #f59e0b';
                this.pillEl.style.color = '#fef3c7';
                this.pillEl.textContent = `ERR: 0 | WARN: ${counts.warnings} [F9]`;
            } else {
                this.pillEl.style.background = 'rgba(8, 26, 36, 0.85)';
                this.pillEl.style.border = '1px solid rgba(56, 189, 248, 0.45)';
                this.pillEl.style.color = '#7dd3fc';
                this.pillEl.textContent = 'DIAG: 0 ERR [F9]';
            }
        },

        clearHistory() {
            this.logs.length = 0;
            this.expandedIds = {};
            this.confirmingClear = false;
            try {
                window.sessionStorage.removeItem(STORAGE_KEY);
                window.localStorage.removeItem(STORAGE_KEY);
            } catch (_) {}
            this.updateStatusPill();
            this.renderDiagnosticOverlay();
        },

        exportJsonReport() {
            const report = {
                generatedAt: new Date().toISOString(),
                counts: this.getCounts(),
                gameContext: detectGameContext(),
                dependencyValidation: window.ENGINE_DEPENDENCY_VALIDATOR ? window.ENGINE_DEPENDENCY_VALIDATOR.lastReport : null,
                logs: this.logs
            };
            const json = JSON.stringify(report, null, 2);
            try {
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `starblock-diagnostics-${Date.now()}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 2000);
            } catch (_) {}
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(json).catch(() => {});
            }
            return json;
        },

        captureError(errOrMsg, meta = {}) {
            const ctx = (meta && (meta.context || meta.category)) || 'runtime';
            const sev = (meta && meta.severity) || 'error';
            return this.record(ctx, errOrMsg, sev, meta);
        },

        getEntries() {
            return this.logs;
        },

        get overlayVisible() {
            return Boolean(this.overlayEl && this.overlayEl.style.display !== 'none');
        },

        toggleDiagnosticOverlay() {
            if (!document.body) return;
            if (!this.overlayEl) {
                const el = document.createElement('div');
                el.id = 'rts-error-diag-overlay';
                el.style.cssText = 'position:fixed;top:48px;right:14px;width:min(680px,95vw);max-height:82vh;background:rgba(6,12,20,0.97);border:1px solid #00e5ff;border-radius:10px;z-index:2147483647;color:#e0f7fa;font:11px/1.45 monospace;padding:12px;display:none;flex-direction:column;gap:8px;box-shadow:0 16px 48px rgba(0,0,0,0.9);pointer-events:auto;';
                document.body.appendChild(el);
                this.overlayEl = el;
            }
            const isHidden = this.overlayEl.style.display === 'none';
            this.overlayEl.style.display = isHidden ? 'flex' : 'none';
            if (isHidden) this.renderDiagnosticOverlay();
        },

        renderDiagnosticOverlay() {
            if (!this.overlayEl) return;
            const el = this.overlayEl;
            while (el.firstChild) el.removeChild(el.firstChild);

            const counts = this.getCounts();
            const ctx = detectGameContext();
            const fps = (window.PERF_MANAGER && window.PERF_MANAGER.rollingFps) ? Math.round(window.PERF_MANAGER.rollingFps) : '--';
            const tier = (window.PERF_MANAGER && window.PERF_MANAGER.tier) ? window.PERF_MANAGER.tier : 'auto';

            // Header bar
            const header = document.createElement('div');
            header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;border-bottom:1px solid rgba(0,229,255,0.28);padding-bottom:8px;';

            const titleBox = document.createElement('div');
            const titleText = document.createElement('div');
            titleText.style.cssText = 'font-weight:700;font-size:12px;color:#38bdf8;';
            titleText.textContent = `STARBLOCK DIAGNOSTICS MONITOR [F9] — ${counts.errors} ERR / ${counts.warnings} WARN (${counts.unique} unique)`;
            const subText = document.createElement('div');
            subText.style.cssText = 'font-size:10px;color:#94a3b8;';
            subText.textContent = `Phase: ${ctx.phase} (${ctx.lifecycleStage}) | Biome: ${ctx.biome} | FPS: ${fps} | Tier: ${tier}`;
            titleBox.appendChild(titleText);
            titleBox.appendChild(subText);
            header.appendChild(titleBox);

            const btnGroup = document.createElement('div');
            btnGroup.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;';

            const makeBtn = (label, bg, border, color, onClick) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = label;
                b.style.cssText = `background:${bg};color:${color};border:1px solid ${border};padding:3px 8px;border-radius:4px;cursor:pointer;font:700 10px monospace;`;
                b.addEventListener('click', onClick);
                return b;
            };

            btnGroup.appendChild(makeBtn('COPY ALL', '#093447', '#00e5ff', '#a5f3fc', () => {
                const payload = JSON.stringify(this.logs, null, 2);
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(payload).catch(() => {});
                }
            }));

            btnGroup.appendChild(makeBtn('EXPORT JSON', '#0b3b2e', '#10b981', '#a7f3d0', () => {
                this.exportJsonReport();
            }));

            if (!this.confirmingClear) {
                btnGroup.appendChild(makeBtn('CLEAR', '#3b1c0b', '#f59e0b', '#fde68a', () => {
                    this.confirmingClear = true;
                    this.renderDiagnosticOverlay();
                }));
            } else {
                btnGroup.appendChild(makeBtn('CONFIRM CLEAR?', '#5c111f', '#ff4d6d', '#fecdd3', () => {
                    this.clearHistory();
                }));
                btnGroup.appendChild(makeBtn('CANCEL', '#1e293b', '#64748b', '#cbd5e1', () => {
                    this.confirmingClear = false;
                    this.renderDiagnosticOverlay();
                }));
            }

            btnGroup.appendChild(makeBtn('CLOSE [F9]', '#421020', '#ff3b5c', '#fecdd3', () => {
                this.overlayEl.style.display = 'none';
            }));

            header.appendChild(btnGroup);
            el.appendChild(header);

            // Filter & Search bar
            const filterRow = document.createElement('div');
            filterRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;';

            const filterTabs = document.createElement('div');
            filterTabs.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
            const categories = ['all', 'errors', 'warnings', 'graphics', 'ai', 'initialization', 'resource'];
            categories.forEach((cat) => {
                const active = this.activeFilter === cat;
                const tab = makeBtn(
                    cat.toUpperCase(),
                    active ? '#0284c7' : 'rgba(15,23,42,0.85)',
                    active ? '#38bdf8' : '#334155',
                    active ? '#ffffff' : '#94a3b8',
                    () => {
                        this.activeFilter = cat;
                        this.renderDiagnosticOverlay();
                    }
                );
                filterTabs.appendChild(tab);
            });
            filterRow.appendChild(filterTabs);

            const searchInput = document.createElement('input');
            searchInput.type = 'search';
            searchInput.placeholder = 'Search message, file, stack...';
            searchInput.value = this.searchQuery;
            searchInput.style.cssText = 'background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:3px 8px;font:10px monospace;min-width:170px;';
            searchInput.addEventListener('input', (ev) => {
                this.searchQuery = ev.target.value || '';
                this.renderDiagnosticOverlay();
            });
            filterRow.appendChild(searchInput);
            el.appendChild(filterRow);

            // Log list container
            const listContainer = document.createElement('div');
            listContainer.style.cssText = 'overflow-y:auto;max-height:60vh;display:flex;flex-direction:column;gap:6px;padding-right:4px;';

            const q = this.searchQuery.trim().toLowerCase();
            const filtered = this.logs.slice().reverse().filter((item) => {
                if (this.activeFilter === 'errors' && item.severity === 'warn') return false;
                if (this.activeFilter === 'warnings' && item.severity !== 'warn') return false;
                if (this.activeFilter !== 'all' && this.activeFilter !== 'errors' && this.activeFilter !== 'warnings') {
                    if (item.category !== this.activeFilter) return false;
                }
                if (q) {
                    const hay = `${item.context} ${item.message} ${item.file} ${item.func} ${item.fullStack}`.toLowerCase();
                    if (!hay.includes(q)) return false;
                }
                return true;
            });

            if (filtered.length === 0) {
                const empty = document.createElement('div');
                empty.style.cssText = 'padding:14px;color:#80cbc4;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);border-radius:6px;';
                empty.textContent = this.logs.length === 0
                    ? '0 runtime errors or warnings recorded across initialization, menu, spectator cinematic, and gameplay.'
                    : 'No log entries match the active filter/search.';
                listContainer.appendChild(empty);
            } else {
                filtered.forEach((item) => {
                    const card = document.createElement('div');
                    const isWarn = item.severity === 'warn';
                    card.style.cssText = `padding:8px;border-radius:6px;background:${isWarn ? 'rgba(69,42,10,0.42)' : 'rgba(64,12,24,0.45)'};border:1px solid ${isWarn ? 'rgba(245,158,11,0.45)' : 'rgba(244,63,94,0.45)'};display:flex;flex-direction:column;gap:4px;`;

                    const topLine = document.createElement('div');
                    topLine.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;';

                    const metaLeft = document.createElement('div');
                    metaLeft.style.cssText = `font-weight:700;color:${isWarn ? '#fcd34d' : '#fda4af'};`;
                    metaLeft.textContent = `[${item.category.toUpperCase()}] ${item.context} — ${item.file}:${item.line}:${item.column} (${item.func}) ×${item.count || 1}`;
                    topLine.appendChild(metaLeft);

                    const metaRight = document.createElement('div');
                    metaRight.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:10px;color:#94a3b8;';
                    const timeSpan = document.createElement('span');
                    timeSpan.textContent = item.count > 1
                        ? `first ${item.firstSeenTime} / last ${item.lastSeenTime} | ${item.lifecycleStage}`
                        : `${item.firstSeenTime} | ${item.lifecycleStage}`;
                    metaRight.appendChild(timeSpan);

                    const expandBtn = makeBtn(
                        this.expandedIds[item.id] ? 'HIDE STACK' : 'STACK',
                        '#0f172a',
                        '#334155',
                        '#93c5fd',
                        () => {
                            this.expandedIds[item.id] = !this.expandedIds[item.id];
                            this.renderDiagnosticOverlay();
                        }
                    );
                    metaRight.appendChild(expandBtn);

                    const copyOneBtn = makeBtn('COPY', '#0f172a', '#334155', '#a5f3fc', () => {
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            navigator.clipboard.writeText(JSON.stringify(item, null, 2)).catch(() => {});
                        }
                    });
                    metaRight.appendChild(copyOneBtn);

                    topLine.appendChild(metaRight);
                    card.appendChild(topLine);

                    const msgDiv = document.createElement('div');
                    msgDiv.style.cssText = 'color:#f8fafc;word-break:break-word;font-weight:600;';
                    msgDiv.textContent = item.message;
                    card.appendChild(msgDiv);

                    if (this.expandedIds[item.id]) {
                        const stackPre = document.createElement('pre');
                        stackPre.style.cssText = 'margin:4px 0 0 0;padding:6px;background:rgba(2,6,23,0.85);border:1px solid #1e293b;border-radius:4px;color:#cbd5e1;font-size:10px;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow-y:auto;';
                        stackPre.textContent = item.fullStack || item.stack || 'No stack trace available';
                        card.appendChild(stackPre);
                    }

                    listContainer.appendChild(card);
                });
            }

            el.appendChild(listContainer);
        }
    };

    window.APP_ERROR_HANDLER = handler;

    // 1. Capture-phase listener for resource load failures (<script>, <link>, <img>, <audio>)
    window.addEventListener('error', (ev) => {
        const t = ev && ev.target;
        if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK' || t.tagName === 'IMG' || t.tagName === 'AUDIO')) {
            const url = t.src || t.href || 'unknown_resource';
            handler.record(`resource.${t.tagName.toLowerCase()}`, new Error(`Failed to load ${t.tagName} resource: ${url}`), 'error', {
                category: 'resource',
                file: url,
                affectedObject: t.tagName
            });
            return;
        }
        if (ev && (ev.error || ev.message)) {
            handler.record('window.onerror', ev.error || new Error(ev.message), 'error', {
                file: ev.filename,
                line: ev.lineno,
                column: ev.colno,
                stack: ev.error && ev.error.stack ? ev.error.stack : `${ev.message} at ${ev.filename}:${ev.lineno}:${ev.colno}`
            });
        }
    }, true);

    // 2. Unhandled Promise Rejections
    window.addEventListener('unhandledrejection', (ev) => {
        const reason = ev && ev.reason ? ev.reason : new Error('Unhandled promise rejection');
        handler.record('unhandledrejection', reason instanceof Error ? reason : new Error(String(reason)), 'error');
    });

    // 3. Single Centralized F9 Shortcut (works in every phase: menu, spectator, multiplayer, gameplay)
    window.addEventListener('keydown', (ev) => {
        if (ev && ev.key === 'F9') {
            if (typeof ev.preventDefault === 'function') ev.preventDefault();
            if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
            handler.toggleDiagnosticOverlay();
        }
    }, true);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => handler.ensureStatusPill());
    } else {
        handler.ensureStatusPill();
    }
})();

// ============================================================================
// 1. CUSTOM SVG EMBLEMS, HIGH-RES PBR TEXTURES & ZERO-LEAK SHARED FX POOLS
// ============================================================================
const HUMAN_SVG_ICON = `<svg viewBox="0 0 32 32" fill="none"><path d="M16 2L4 7v9c0 7.4 5.1 13.8 12 15.5C22.9 29.8 28 23.4 28 16V7L16 2z" stroke="#00e5ff" stroke-width="2" fill="rgba(0,229,255,0.18)"/><path d="M16 7l-8 8h5v9h6v-9h5l-8-8z" fill="#ffaa00"/></svg>`;
const ENEMY_SVG_ICON = `<svg viewBox="0 0 32 32" fill="none"><polygon points="16,2 28,9 24,26 16,30 8,26 4,9" stroke="#ff2a4b" stroke-width="2" fill="rgba(255,42,75,0.22)"/><path d="M9 12l5 4-3 7M23 12l-5 4 3 7" stroke="#ffaa00" stroke-width="2"/><circle cx="12" cy="11" r="2" fill="#ffaa00"/><circle cx="20" cy="11" r="2" fill="#ffaa00"/><circle cx="16" cy="8" r="1.8" fill="#ff2a4b"/></svg>`;

// MOBILE PERFORMANCE MODE (Termux / phone playtesting via Cloudflare tunnel)
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && window.matchMedia('(pointer: coarse)').matches);

// Centralized Texture Registry & Safe Fallback Texture Generator
const _whiteFallbackBytes = new Uint8Array([242, 246, 250, 255]);
const _whiteFallbackTex = new THREE.DataTexture(_whiteFallbackBytes, 1, 1, THREE.RGBAFormat);
_whiteFallbackTex.name = '_whiteFallbackTex';
_whiteFallbackTex.encoding = THREE.LinearEncoding;
_whiteFallbackTex.needsUpdate = true;

const _neutralNormalBytes = new Uint8Array([128, 128, 255, 255]);
const _neutralNormalTex = new THREE.DataTexture(_neutralNormalBytes, 1, 1, THREE.RGBAFormat);
_neutralNormalTex.name = '_neutralNormalTex';
_neutralNormalTex.encoding = THREE.LinearEncoding;
_neutralNormalTex.needsUpdate = true;

window.TEXTURE_INIT_STATUS = {};
window.TEXTURE_REGISTRY = {
    _whiteFallbackTex,
    _neutralNormalTex,
    textures: {},
    failures: [],
    inspectTextureDimensions(tex) {
        if (!tex || !tex.isTexture) return { width: 0, height: 0, hasSource: false };
        const img = tex.image;
        if (!img) return { width: 0, height: 0, hasSource: false };
        const w = Number(img.width || (img.videoWidth) || 0);
        const h = Number(img.height || (img.videoHeight) || 0);
        const hasData = Boolean(
            (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement && w > 0 && h > 0) ||
            (typeof Image !== 'undefined' && img instanceof Image && w > 0 && h > 0) ||
            (img.data && img.data.length > 0 && w > 0 && h > 0) ||
            (w > 0 && h > 0)
        );
        return { width: w, height: h, hasSource: hasData };
    },
    register(name, tex, category = 'general', originalError = null) {
        const isNormal = /normal|filigree/i.test(name);
        const fallbackToUse = isNormal ? _neutralNormalTex : _whiteFallbackTex;
        const dim = this.inspectTextureDimensions(tex);
        const isValid = Boolean(tex && tex.isTexture && dim.hasSource && dim.width > 0 && dim.height > 0 && tex !== _whiteFallbackTex && tex !== _neutralNormalTex)
            || (name === '_fallbackFowTex' && Boolean(tex && tex.isTexture && dim.width > 0 && dim.height > 0));

        if (isValid) {
            tex.name = name;
            if (!tex.encoding) tex.encoding = THREE.LinearEncoding;
            tex.needsUpdate = true;
            this[name] = tex;
            const entry = {
                name,
                category,
                status: 'OK',
                width: dim.width,
                height: dim.height,
                colorSpace: tex.encoding === THREE.sRGBEncoding ? 'sRGB' : 'Linear',
                needsUpdate: true,
                isFallback: false,
                originalError: null,
                texture: tex
            };
            this.textures[name] = entry;
            window.TEXTURE_INIT_STATUS[name] = entry;
            return tex;
        }

        const errReason = originalError
            ? (originalError.message || String(originalError))
            : (!tex || !tex.isTexture ? 'Not a valid THREE.Texture' : `Invalid texture source/dimensions (${dim.width}x${dim.height})`);
        this.failures.push({ name, category, reason: errReason, time: new Date().toISOString() });
        if (window.APP_ERROR_HANDLER && originalError) {
            window.APP_ERROR_HANDLER.record(`TextureInit:${name}`, originalError, 'graphics');
        }
        fallbackToUse.needsUpdate = true;
        this[name] = fallbackToUse;
        const fbEntry = {
            name,
            category,
            status: 'FALLBACK',
            width: 1,
            height: 1,
            colorSpace: 'Linear',
            needsUpdate: true,
            isFallback: true,
            originalError: errReason,
            texture: fallbackToUse
        };
        this.textures[name] = fbEntry;
        window.TEXTURE_INIT_STATUS[name] = fbEntry;
        return fallbackToUse;
    },
    getDiagnosticSnapshot() {
        const requiredKeys = [
            'terrainDetailTex',
            'terrainNormalTex',
            'metalTex',
            'metalNormalTex',
            'metalRoughnessTex',
            'zergChitinTex',
            'zergNormalTex',
            'zergRoughnessTex',
            'solarisArmorTex',
            'solarisNormalTex',
            'solarisRoughnessTex',
            'fowTexture',
            '_fallbackFowTex',
            'creepOverlayTex',
            'waterTex',
            'hazardTex',
            'humanEmblemTex',
            'enemyEmblemTex'
        ];
        const allKeys = Array.from(new Set([...requiredKeys, ...Object.keys(this.textures)]));
        const entries = [];
        let validCount = 0;
        let fallbackCount = 0;
        const missingOrInvalid = [];

        allKeys.forEach(k => {
            const regEntry = this.textures[k];
            const texObj = (regEntry && regEntry.texture) || this[k] || window[k];
            const dim = this.inspectTextureDimensions(texObj);
            const isValidTex = Boolean(texObj && texObj.isTexture && dim.hasSource && dim.width > 0 && dim.height > 0);
            const isFallback = Boolean(regEntry && regEntry.isFallback) || !isValidTex || (k !== '_fallbackFowTex' && (texObj === _whiteFallbackTex || texObj === _neutralNormalTex));

            if (isValidTex && !isFallback) {
                validCount++;
            } else {
                fallbackCount++;
                missingOrInvalid.push(k);
            }
            entries.push({
                name: k,
                category: regEntry ? regEntry.category : 'general',
                status: isValidTex && !isFallback ? 'OK' : (isValidTex ? 'FALLBACK' : 'MISSING'),
                width: dim.width,
                height: dim.height,
                colorSpace: texObj && texObj.encoding === THREE.sRGBEncoding ? 'sRGB' : 'Linear',
                isFallback,
                originalError: regEntry ? regEntry.originalError : (!isValidTex ? 'Texture not registered or invalid' : null)
            });
        });

        return {
            totalRegistered: entries.length,
            validCount,
            fallbackCount,
            missingOrInvalid,
            failures: this.failures.slice(-20),
            entries
        };
    }
};

window.registerGameTexture = function(name, tex, category = 'general', originalError = null) {
    return window.TEXTURE_REGISTRY.register(name, tex, category, originalError);
};

function makeProceduralTexture(drawFn, repeatX = 1, repeatY = 1, registryName = '', size = 256) {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        drawFn(ctx, size, size);
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(repeatX, repeatY);
        tex.encoding = THREE.LinearEncoding;
        tex.needsUpdate = true;
        if (registryName) window.registerGameTexture(registryName, tex, 'procedural');
        return tex;
    } catch (err) {
        if (window.APP_ERROR_HANDLER) window.APP_ERROR_HANDLER.record('makeProceduralTexture:' + registryName, err, 'graphics');
        if (registryName) window.registerGameTexture(registryName, _whiteFallbackTex, 'procedural', err);
        return _whiteFallbackTex;
    }
}

// Terran Dominion Aquila Emblem Texture (Used for Ground Ring & Floating 3D Holo-Crest)
const humanEmblemTex = makeProceduralTexture((ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;

    // Outer glowing compass ring
    ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(cx, cy, 224, 0, Math.PI * 2); ctx.stroke();

    ctx.strokeStyle = 'rgba(0, 229, 255, 0.5)'; ctx.lineWidth = 3;
    for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * 198, cy + Math.sin(a) * 198);
        ctx.lineTo(cx + Math.cos(a) * 220, cy + Math.sin(a) * 220);
        ctx.stroke();
    }

    ctx.strokeStyle = '#ffaa00'; ctx.lineWidth = 5;
    ctx.setLineDash([28, 14]);
    ctx.beginPath(); ctx.arc(cx, cy, 182, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);

    // Terran Aquila Wings & Shield
    ctx.fillStyle = 'rgba(0, 229, 255, 0.28)';
    ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 140); ctx.lineTo(cx + 150, cy - 60); ctx.lineTo(cx + 115, cy + 15);
    ctx.lineTo(cx + 138, cy + 40); ctx.lineTo(cx + 72, cy + 98); ctx.lineTo(cx, cy + 155);
    ctx.lineTo(cx - 72, cy + 98); ctx.lineTo(cx - 138, cy + 40); ctx.lineTo(cx - 115, cy + 15);
    ctx.lineTo(cx - 150, cy - 60); ctx.closePath();
    ctx.fill(); ctx.stroke();

    // Central Gold Star & Sword
    ctx.fillStyle = '#ffaa00';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 112); ctx.lineTo(cx + 24, cy - 28); ctx.lineTo(cx + 76, cy - 8);
    ctx.lineTo(cx + 20, cy + 28); ctx.lineTo(cx, cy + 118); ctx.lineTo(cx - 20, cy + 28);
    ctx.lineTo(cx - 76, cy - 8); ctx.lineTo(cx - 24, cy - 28); ctx.closePath();
    ctx.fill();
}, 1, 1, 'humanEmblemTex', 512);

// Zerg Brood Bio-Emblem Texture
const enemyEmblemTex = makeProceduralTexture((ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    ctx.strokeStyle = '#ff2a4b'; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(cx, cy, 224, 0, Math.PI * 2); ctx.stroke();

    ctx.strokeStyle = '#b845ff'; ctx.lineWidth = 5;
    ctx.setLineDash([20, 12]);
    ctx.beginPath(); ctx.arc(cx, cy, 188, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(184, 69, 255, 0.35)';
    ctx.strokeStyle = '#ff5400'; ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 140); ctx.lineTo(cx + 130, cy - 45); ctx.lineTo(cx + 78, cy + 145);
    ctx.lineTo(cx + 25, cy + 65); ctx.lineTo(cx, cy + 118); ctx.lineTo(cx - 25, cy + 65);
    ctx.lineTo(cx - 78, cy + 145); ctx.lineTo(cx - 130, cy - 45); ctx.closePath();
    ctx.fill(); ctx.stroke();

    ctx.fillStyle = '#ffaa00';
    [[-38, -25, 14], [38, -25, 14], [0, -62, 17]].forEach(([ox, oy, r]) => {
        ctx.beginPath(); ctx.arc(cx + ox, cy + oy, r, 0, Math.PI * 2); ctx.fill();
    });
}, 1, 1, 'enemyEmblemTex', 512);

// ============================================================================
// REBUILT STARCRAFT II MULTI-CHANNEL PROCEDURAL PBR TEXTURE SUITE
// Includes Albedo, Tangent-Space Normal, Roughness, Organic Chitin & Khalai Filigree Maps
// ============================================================================
function generateNormalMapFromHeightCanvas(srcCanvas, strength = 2.6, repeatX = 1, repeatY = 1) {
    const w = srcCanvas.width, h = srcCanvas.height;
    const srcCtx = srcCanvas.getContext('2d');
    const srcData = srcCtx.getImageData(0, 0, w, h).data;
    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = w; dstCanvas.height = h;
    const dstCtx = dstCanvas.getContext('2d');
    const dstImg = dstCtx.createImageData(w, h);
    const dstData = dstImg.data;

    const lumaAt = (x, y) => {
        const wx = ((x % w) + w) % w;
        const wy = ((y % h) + h) % h;
        const idx = (wy * w + wx) * 4;
        return (srcData[idx] * 0.299 + srcData[idx + 1] * 0.587 + srcData[idx + 2] * 0.114) / 255.0;
    };

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const tl = lumaAt(x - 1, y - 1);
            const t  = lumaAt(x,     y - 1);
            const tr = lumaAt(x + 1, y - 1);
            const l  = lumaAt(x - 1, y);
            const r  = lumaAt(x + 1, y);
            const bl = lumaAt(x - 1, y + 1);
            const b  = lumaAt(x,     y + 1);
            const br = lumaAt(x + 1, y + 1);

            const dX = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
            const dY = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
            let nx = -dX * strength;
            let ny = -dY * strength;
            let nz = 1.0;
            const invLen = 1.0 / Math.hypot(nx, ny, nz);
            nx *= invLen; ny *= invLen; nz *= invLen;

            const p = (y * w + x) * 4;
            dstData[p]     = Math.floor((nx * 0.5 + 0.5) * 255);
            dstData[p + 1] = Math.floor((ny * 0.5 + 0.5) * 255);
            dstData[p + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
            dstData[p + 3] = 255;
        }
    }
    dstCtx.putImageData(dstImg, 0, 0);
    const normalTex = new THREE.CanvasTexture(dstCanvas);
    normalTex.wrapS = THREE.RepeatWrapping;
    normalTex.wrapT = THREE.RepeatWrapping;
    normalTex.repeat.set(repeatX, repeatY);
    return normalTex;
}

// 1. StarCraft II Terran Dominion Brushed Titanium & Beveled Chobham Armor Texture + Normal + Roughness
const _terranArmorCanvases = (() => {
    const w = 256, h = 256;
    const albCanvas = document.createElement('canvas');
    albCanvas.width = w; albCanvas.height = h;
    const ctx = albCanvas.getContext('2d');

    const rghCanvas = document.createElement('canvas');
    rghCanvas.width = w; rghCanvas.height = h;
    const rCtx = rghCanvas.getContext('2d');

    // Base anisotropic gunmetal-titanium gradient (High-albedo brushed titanium so unit tint colors stay vibrant and never turn black)
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#c4d2e0');
    grad.addColorStop(0.35, '#a8b8c8');
    grad.addColorStop(0.7, '#b6c5d4');
    grad.addColorStop(1, '#98a8ba');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    rCtx.fillStyle = '#6e6e6e';
    rCtx.fillRect(0, 0, w, h);

    // Fine directional brushed steel micro-grain & combat scratches
    for (let i = 0; i < 1000; i++) {
        const gx = Math.random() * w;
        const gy = Math.random() * h;
        const gl = 10 + Math.random() * 32;
        const isLight = i % 3 === 0;
        ctx.fillStyle = isLight ? 'rgba(225, 240, 255, 0.038)' : 'rgba(12, 18, 26, 0.045)';
        ctx.fillRect(gx, gy, gl, 1.2);
        rCtx.fillStyle = isLight ? 'rgba(180,180,180,0.05)' : 'rgba(80,80,80,0.05)';
        rCtx.fillRect(gx, gy, gl, 1.2);
    }

    // Subtle oil/soot cavity grime around panel perimeters
    const drawArmorPanel = (x, y, pw, ph, chamfer = 14) => {
        const grimeGrad = ctx.createLinearGradient(x, y, x, y + ph);
        grimeGrad.addColorStop(0, 'rgba(255, 255, 255, 0.05)');
        grimeGrad.addColorStop(0.82, 'rgba(0, 0, 0, 0.0)');
        grimeGrad.addColorStop(1, 'rgba(10, 14, 20, 0.22)');
        ctx.fillStyle = grimeGrad;
        ctx.fillRect(x + 3, y + 3, pw - 6, ph - 6);

        // Deep recessed panel groove (AO seam)
        ctx.strokeStyle = 'rgba(10, 15, 22, 0.78)';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(x + chamfer, y);
        ctx.lineTo(x + pw - chamfer, y);
        ctx.lineTo(x + pw, y + chamfer);
        ctx.lineTo(x + pw, y + ph - chamfer);
        ctx.lineTo(x + pw - chamfer, y + ph);
        ctx.lineTo(x + chamfer, y + ph);
        ctx.lineTo(x, y + ph - chamfer);
        ctx.lineTo(x, y + chamfer);
        ctx.closePath();
        ctx.stroke();

        // Roughness in seams is higher (matte dirt), edge highlight is lower (worn polished metal)
        rCtx.strokeStyle = '#d8d8d8';
        rCtx.lineWidth = 4;
        rCtx.stroke();

        // Machined edge highlight bevel
        ctx.strokeStyle = 'rgba(210, 232, 255, 0.28)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 4, y + 4, pw - 8, ph - 8);
        rCtx.strokeStyle = '#383838';
        rCtx.lineWidth = 2;
        rCtx.strokeRect(x + 4, y + 4, pw - 8, ph - 8);

        // Recessed hex bolts
        [[x + 14, y + 14], [x + pw - 14, y + 14], [x + 14, y + ph - 14], [x + pw - 14, y + ph - 14]].forEach(([bx, by]) => {
            ctx.fillStyle = '#232c38';
            ctx.beginPath(); ctx.arc(bx, by, 4.2, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#8fa3ba';
            ctx.beginPath(); ctx.arc(bx - 0.8, by - 0.8, 2.5, 0, Math.PI * 2); ctx.fill();
        });
    };

    drawArmorPanel(8, 8, w - 16, h - 16, 22);
    drawArmorPanel(20, 20, w / 2 - 26, h / 2 - 26, 14);
    drawArmorPanel(w / 2 + 6, 20, w / 2 - 26, h / 2 - 26, 14);
    drawArmorPanel(20, h / 2 + 6, w / 2 - 26, h / 2 - 26, 14);
    drawArmorPanel(w / 2 + 6, h / 2 + 6, w / 2 - 26, h / 2 - 26, 14);

    // Recessed heat-exchanger louvers
    for (let vy = h - 76; vy < h - 30; vy += 8) {
        ctx.fillStyle = 'rgba(12, 17, 24, 0.72)';
        ctx.fillRect(42, vy, 98, 4.5);
        ctx.fillRect(w - 140, vy, 98, 4.5);
        ctx.fillStyle = 'rgba(190, 212, 235, 0.18)';
        ctx.fillRect(42, vy + 4.5, 98, 1.2);
        ctx.fillRect(w - 140, vy + 4.5, 98, 1.2);
    }

    const albedo = new THREE.CanvasTexture(albCanvas);
    albedo.wrapS = THREE.RepeatWrapping; albedo.wrapT = THREE.RepeatWrapping;
    const roughness = new THREE.CanvasTexture(rghCanvas);
    roughness.wrapS = THREE.RepeatWrapping; roughness.wrapT = THREE.RepeatWrapping;
    const normal = generateNormalMapFromHeightCanvas(albCanvas, 3.2, 1, 1);
    return { albedo, roughness, normal };
})();

const metalTex = window.registerGameTexture('metalTex', _terranArmorCanvases.albedo, 'terran');
const metalRoughnessTex = window.registerGameTexture('metalRoughnessTex', _terranArmorCanvases.roughness, 'terran');
const metalNormalTex = window.registerGameTexture('metalNormalTex', _terranArmorCanvases.normal, 'terran');
window.metalTex = metalTex;
window.metalNormalTex = metalNormalTex;
window.metalRoughnessTex = metalRoughnessTex;

// 2. Weathered Industrial Caution Chevron Texture (Chipped Paint, Grime & Rivets)
const hazardTex = makeProceduralTexture((ctx, w, h) => {
    ctx.fillStyle = '#d98a16';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1b2028';
    for (let i = -h; i < w + h; i += 64) {
        ctx.beginPath();
        ctx.moveTo(i, 0); ctx.lineTo(i + 32, 0);
        ctx.lineTo(i + 32 - h, h); ctx.lineTo(i - h, h);
        ctx.fill();
    }
    for (let s = 0; s < 900; s++) {
        ctx.fillStyle = s % 2 === 0 ? 'rgba(20, 24, 30, 0.14)' : 'rgba(215, 225, 235, 0.10)';
        ctx.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 8, 1.5 + Math.random() * 3);
    }
    ctx.strokeStyle = 'rgba(15, 20, 28, 0.65)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, w - 6, h - 6);
}, 1, 1, 'hazardTex');

// 3. Organic Zerg Chitin Albedo, Normal & Roughness Maps (With Independent Error Boundary)
const _zergChitinCanvases = (() => {
    try {
        const c = document.createElement('canvas');
        c.width = 256; c.height = 256;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#d4cad2';
        ctx.fillRect(0, 0, 256, 256);

        const rCanvas = document.createElement('canvas');
        rCanvas.width = 256; rCanvas.height = 256;
        const rCtx = rCanvas.getContext('2d');
        rCtx.fillStyle = '#707070';
        rCtx.fillRect(0, 0, 256, 256);

        // Smooth overlapping longitudinal chitin plate bands (high base luminance so material colors stay rich)
        for (let y = 0; y < 256; y += 32) {
            const g = ctx.createLinearGradient(0, y, 0, y + 32);
            g.addColorStop(0, 'rgba(245, 238, 244, 0.55)');
            g.addColorStop(0.55, 'rgba(212, 200, 210, 0.35)');
            g.addColorStop(1, 'rgba(158, 144, 156, 0.52)');
            ctx.fillStyle = g;
            ctx.fillRect(0, y, 256, 32);

            const rg = rCtx.createLinearGradient(0, y, 0, y + 32);
            rg.addColorStop(0, '#525252');
            rg.addColorStop(0.7, '#787878');
            rg.addColorStop(1, '#a8a8a8');
            rCtx.fillStyle = rg;
            rCtx.fillRect(0, y, 256, 32);
        }

        // Flowing organic carapace seam ridges
        ctx.strokeStyle = 'rgba(96, 82, 94, 0.45)';
        ctx.lineWidth = 2.2;
        for (let y = 16; y < 256; y += 32) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            for (let x = 0; x <= 256; x += 16) {
                ctx.lineTo(x, y + Math.sin(x * 0.049) * 3.0);
            }
            ctx.stroke();
        }
        const albedo = new THREE.CanvasTexture(c);
        albedo.wrapS = THREE.RepeatWrapping; albedo.wrapT = THREE.RepeatWrapping;
        albedo.repeat.set(2, 2);
        const roughness = new THREE.CanvasTexture(rCanvas);
        roughness.wrapS = THREE.RepeatWrapping; roughness.wrapT = THREE.RepeatWrapping;
        roughness.repeat.set(2, 2);
        const normal = generateNormalMapFromHeightCanvas(c, 2.8, 2, 2);
        return { albedo, roughness, normal };
    } catch (err) {
        if (window.APP_ERROR_HANDLER) window.APP_ERROR_HANDLER.record('zergChitinTextures', err, 'graphics');
        return { albedo: _whiteFallbackTex, roughness: _whiteFallbackTex, normal: _neutralNormalTex };
    }
})();
const zergChitinTex = window.registerGameTexture('zergChitinTex', _zergChitinCanvases.albedo, 'zerg');
const zergRoughnessTex = window.registerGameTexture('zergRoughnessTex', _zergChitinCanvases.roughness, 'zerg');
const zergNormalTex = window.registerGameTexture('zergNormalTex', _zergChitinCanvases.normal, 'zerg');
const chitinNormalTex = window.registerGameTexture('chitinNormalTex', zergNormalTex, 'zerg');
window.zergChitinTex = zergChitinTex;
window.zergRoughnessTex = zergRoughnessTex;
window.zergNormalTex = zergNormalTex;
window.chitinNormalTex = chitinNormalTex;

// 4. Protoss Solaris Khalai Geometric Filigree Albedo, Normal & Roughness Maps
const _solarisArmorCanvases = (() => {
    try {
        const c = document.createElement('canvas');
        c.width = 256; c.height = 256;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#e8dfc8';
        ctx.fillRect(0, 0, 256, 256);

        const rCanvas = document.createElement('canvas');
        rCanvas.width = 256; rCanvas.height = 256;
        const rCtx = rCanvas.getContext('2d');
        rCtx.fillStyle = '#484848';
        rCtx.fillRect(0, 0, 256, 256);

        ctx.strokeStyle = 'rgba(130, 112, 82, 0.55)';
        ctx.lineWidth = 3;
        rCtx.strokeStyle = '#969696';
        rCtx.lineWidth = 3;
        for (let ring = 28; ring <= 112; ring += 28) {
            ctx.beginPath(); ctx.arc(128, 128, ring, 0, Math.PI * 2); ctx.stroke();
            rCtx.beginPath(); rCtx.arc(128, 128, ring, 0, Math.PI * 2); rCtx.stroke();
        }
        for (let a = 0; a < 8; a++) {
            const ang = (a / 8) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(128 + Math.cos(ang) * 28, 128 + Math.sin(ang) * 28);
            ctx.lineTo(128 + Math.cos(ang) * 120, 128 + Math.sin(ang) * 120);
            ctx.stroke();
        }
        ctx.strokeRect(18, 18, 220, 220);
        const albedo = new THREE.CanvasTexture(c);
        albedo.wrapS = THREE.RepeatWrapping; albedo.wrapT = THREE.RepeatWrapping;
        const roughness = new THREE.CanvasTexture(rCanvas);
        roughness.wrapS = THREE.RepeatWrapping; roughness.wrapT = THREE.RepeatWrapping;
        const normal = generateNormalMapFromHeightCanvas(c, 2.8, 1, 1);
        return { albedo, roughness, normal };
    } catch (err) {
        if (window.APP_ERROR_HANDLER) window.APP_ERROR_HANDLER.record('solarisArmorTextures', err, 'graphics');
        return { albedo: _whiteFallbackTex, roughness: _whiteFallbackTex, normal: _neutralNormalTex };
    }
})();
const solarisArmorTex = window.registerGameTexture('solarisArmorTex', _solarisArmorCanvases.albedo, 'solaris');
const solarisRoughnessTex = window.registerGameTexture('solarisRoughnessTex', _solarisArmorCanvases.roughness, 'solaris');
const solarisNormalTex = window.registerGameTexture('solarisNormalTex', _solarisArmorCanvases.normal, 'solaris');
const solarisFiligreeTex = window.registerGameTexture('solarisFiligreeTex', solarisNormalTex, 'solaris');
window.solarisArmorTex = solarisArmorTex;
window.solarisRoughnessTex = solarisRoughnessTex;
window.solarisNormalTex = solarisNormalTex;
window.solarisFiligreeTex = solarisFiligreeTex;

// 5. 512x512 Seamless Koprulu Highland Turf, Soil & Sedimentary Micro-Detail Texture + Normal Map
// High-luminance neutral micro-detail (216..252) so terrain vertex colors remain bright and vivid on all GPUs!
const _terrainCanvases = (() => {
    try {
        const size = 128;
        const c = document.createElement('canvas');
        c.width = size; c.height = size;
        const ctx = c.getContext('2d');
        const imgData = ctx.createImageData(size, size);
        const data = imgData.data;

        function hash2D(ix, iy, period) {
            const x = ((ix % period) + period) % period;
            const y = ((iy % period) + period) % period;
            let h = (x * 374761393 + y * 668265263) | 0;
            h = ((h ^ (h >>> 13)) * 1274126177) | 0;
            return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
        }

        function valueNoisePeriodic(u, v, freq) {
            const px = u * freq;
            const py = v * freq;
            const ix = Math.floor(px);
            const iy = Math.floor(py);
            const fx = px - ix;
            const fy = py - iy;
            const sx = fx * fx * (3.0 - 2.0 * fx);
            const sy = fy * fy * (3.0 - 2.0 * fy);

            const n00 = hash2D(ix, iy, freq);
            const n10 = hash2D(ix + 1, iy, freq);
            const n01 = hash2D(ix, iy + 1, freq);
            const n11 = hash2D(ix + 1, iy + 1, freq);

            const nx0 = n00 + sx * (n10 - n00);
            const nx1 = n01 + sx * (n11 - n01);
            return nx0 + sy * (nx1 - nx0);
        }

        for (let y = 0; y < size; y++) {
            const v = y / size;
            for (let x = 0; x < size; x++) {
                const u = x / size;
                const n1 = valueNoisePeriodic(u, v, 6);
                const n2 = valueNoisePeriodic(u, v, 16);
                const n3 = valueNoisePeriodic(u, v, 38);
                const n4 = valueNoisePeriodic(u, v, 84);
                const fbm = n1 * 0.40 + n2 * 0.30 + n3 * 0.20 + n4 * 0.10;

                const bladeTuft = Math.sin((u * 48.0 + n2 * 2.1) * Math.PI * 2) * Math.cos((v * 48.0 - n1 * 2.1) * Math.PI * 2) * 0.032;
                const microGrain = (hash2D(x, y, size) - 0.5) * 0.04;

                const lum = Math.min(252, Math.max(214, Math.floor(224 + fbm * 24 + (bladeTuft + microGrain) * 110)));
                const r = Math.max(0, Math.min(255, lum - Math.floor(n2 * 5)));
                const g = Math.max(0, Math.min(255, lum + Math.floor((n1 - 0.35) * 7)));
                const b = Math.max(0, Math.min(255, lum - Math.floor(n3 * 5)));

                const p = (y * size + x) * 4;
                data[p] = r;
                data[p + 1] = g;
                data[p + 2] = b;
                data[p + 3] = 255;
            }
        }
        ctx.putImageData(imgData, 0, 0);

        for (let i = 0; i < 450; i++) {
            const gx = Math.random() * size;
            const gy = Math.random() * size;
            ctx.strokeStyle = i % 3 === 0 ? 'rgba(250, 255, 245, 0.16)' : 'rgba(205, 225, 200, 0.14)';
            ctx.lineWidth = 1.1;
            ctx.beginPath();
            ctx.moveTo(gx, gy);
            ctx.lineTo(gx + (Math.random() - 0.5) * 2.8, gy - 2.5 - Math.random() * 3.0);
            ctx.stroke();
        }

        const tex = new THREE.CanvasTexture(c);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(24, 24);
        const norm = generateNormalMapFromHeightCanvas(c, 2.6, 24, 24);
        return { tex, norm };
    } catch (err) {
        if (window.APP_ERROR_HANDLER) window.APP_ERROR_HANDLER.record('terrainCanvases', err, 'graphics');
        return { tex: _whiteFallbackTex, norm: _neutralNormalTex };
    }
})();

const terrainDetailTex = window.registerGameTexture('terrainDetailTex', _terrainCanvases.tex, 'terrain');
const terrainNormalTex = window.registerGameTexture('terrainNormalTex', _terrainCanvases.norm, 'terrain');
window.terrainDetailTex = terrainDetailTex;
window.terrainNormalTex = terrainNormalTex;

const waterTex = makeProceduralTexture((ctx, w, h) => {
    ctx.fillStyle = '#0c2e40'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(110, 215, 245, 0.28)'; ctx.lineWidth = 2;
    for (let i = 0; i < 95; i++) {
        ctx.beginPath();
        ctx.arc(Math.random() * w, Math.random() * h, 10 + Math.random() * 24, 0, Math.PI);
        ctx.stroke();
    }
}, 10, 10, 'waterTex');

// ============================================================================
// 2. SCENE, CAMERA, ACES FILMIC RENDERER & PROCEDURAL HDR SKY ENVIRONMENT MAP
// ============================================================================
const container = document.getElementById('game-container');
const worldUi = document.getElementById('world-ui');
const cursorTag = document.getElementById('cursor-tag');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x182838);
scene.fog = new THREE.FogExp2(0x182838, 0.00042);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1400);
camera.position.set(22, 38, 56);

const renderer = new THREE.WebGLRenderer({
    antialias: !IS_MOBILE,
    powerPreference: 'high-performance',
    stencil: false
});
renderer.setSize(window.innerWidth, window.innerHeight);
const _initialMaxDpr = IS_MOBILE ? 1.15 : 1.5;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, _initialMaxDpr));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = IS_MOBILE ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
if (renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
    const maxAniso = Math.min(IS_MOBILE ? 2 : 8, renderer.capabilities.getMaxAnisotropy());
    terrainDetailTex.anisotropy = maxAniso;
    terrainNormalTex.anisotropy = maxAniso;
    metalTex.anisotropy = maxAniso;
    metalNormalTex.anisotropy = maxAniso;
}
container.appendChild(renderer.domElement);

// ============================================================================
// ADAPTIVE PERFORMANCE QUALITY MANAGER & IN-GAME PERFORMANCE PROFILER
// ============================================================================
const PERF_QUALITY_PROFILES = {
    high: {
        name: 'High',
        tierIndex: 0,
        maxPixelRatio: IS_MOBILE ? 1.25 : 1.5,
        shadowEnabled: true,
        shadowMapSize: 1024,
        shadowUpdateStride: 1,
        maxParticles: 175,
        maxSmokeClouds: 56,
        maxShellCasings: 45,
        maxCorpses: 32,
        particleSpawnRateMult: 1.0,
        thrusterIntervalScale: 1.0,
        animCloseDistSq: 28 * 28,
        animNormalDistSq: 56 * 56,
        animFarDistSq: 92 * 92,
        fowUpdateInterval: 0.18,
        domProjectionStride: 1,
        aiCloseStride: 1,
        aiMidStride: 2,
        aiFarStride: 4
    },
    balanced: {
        name: 'Balanced',
        tierIndex: 1,
        maxPixelRatio: IS_MOBILE ? 1.15 : 1.35,
        shadowEnabled: true,
        shadowMapSize: 1024,
        shadowUpdateStride: 2,
        maxParticles: 125,
        maxSmokeClouds: 40,
        maxShellCasings: 28,
        maxCorpses: 24,
        particleSpawnRateMult: 0.75,
        thrusterIntervalScale: 1.35,
        animCloseDistSq: 24 * 24,
        animNormalDistSq: 46 * 46,
        animFarDistSq: 78 * 78,
        fowUpdateInterval: 0.22,
        domProjectionStride: 2,
        aiCloseStride: 2,
        aiMidStride: 3,
        aiFarStride: 5
    },
    mobile: {
        name: 'Mobile',
        tierIndex: 2,
        maxPixelRatio: 1.0,
        shadowEnabled: true,
        shadowMapSize: 512,
        shadowUpdateStride: 3,
        maxParticles: 80,
        maxSmokeClouds: 24,
        maxShellCasings: 16,
        maxCorpses: 16,
        particleSpawnRateMult: 0.50,
        thrusterIntervalScale: 1.85,
        animCloseDistSq: 18 * 18,
        animNormalDistSq: 36 * 36,
        animFarDistSq: 64 * 64,
        fowUpdateInterval: 0.26,
        domProjectionStride: 2,
        aiCloseStride: 2,
        aiMidStride: 4,
        aiFarStride: 6
    },
    low: {
        name: 'Low-end',
        tierIndex: 3,
        maxPixelRatio: 0.85,
        shadowEnabled: false,
        shadowMapSize: 512,
        shadowUpdateStride: 4,
        maxParticles: 48,
        maxSmokeClouds: 14,
        maxShellCasings: 8,
        maxCorpses: 10,
        particleSpawnRateMult: 0.30,
        thrusterIntervalScale: 2.6,
        animCloseDistSq: 14 * 14,
        animNormalDistSq: 28 * 28,
        animFarDistSq: 50 * 50,
        fowUpdateInterval: 0.32,
        domProjectionStride: 3,
        aiCloseStride: 3,
        aiMidStride: 5,
        aiFarStride: 8
    }
};

const _PERF_TIER_KEYS = ['high', 'balanced', 'mobile', 'low'];

const PERF_MANAGER = {
    profiles: PERF_QUALITY_PROFILES,
    currentKey: IS_MOBILE ? 'mobile' : 'high',
    current: IS_MOBILE ? PERF_QUALITY_PROFILES.mobile : PERF_QUALITY_PROFILES.high,
    autoAdapt: true,
    rollingFrameMs: 16.6,
    rollingFps: 60.0,
    cooldownSec: 0,
    highLoadTimer: 0,
    lowLoadTimer: 0,
    frameCounter: 0,

    applyTier(key) {
        this.applyProfile(key);
    },

    applyProfile(key) {
        if (!this.profiles[key]) return;
        this.currentKey = key;
        this.current = this.profiles[key];
        const targetDpr = Math.min(window.devicePixelRatio || 1, this.current.maxPixelRatio);
        if (Math.abs(renderer.getPixelRatio() - targetDpr) > 0.04) {
            renderer.setPixelRatio(targetDpr);
            renderer.setSize(window.innerWidth, window.innerHeight, false);
        }
        const shadowChanged = (renderer.shadowMap.enabled !== !!this.current.shadowEnabled)
            || (typeof dirLight !== 'undefined' && dirLight && dirLight.castShadow !== !!this.current.shadowEnabled);
        renderer.shadowMap.enabled = !!this.current.shadowEnabled;
        if (typeof dirLight !== 'undefined' && dirLight) {
            dirLight.castShadow = !!this.current.shadowEnabled;
        }
        if (shadowChanged) {
            renderer.shadowMap.needsUpdate = true;
            if (typeof scene !== 'undefined' && scene) {
                scene.traverse(obj => {
                    if (obj && obj.isMesh && obj.material) {
                        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                        mats.forEach(m => { if (m) m.needsUpdate = true; });
                    }
                });
            }
        }
    },

    update(rawFrameMs, dt, activeActorCount = 0) {
        this.frameCounter = (this.frameCounter + 1) | 0;
        const clampedMs = Math.max(4.0, Math.min(120.0, rawFrameMs));
        this.rollingFrameMs = this.rollingFrameMs * 0.92 + clampedMs * 0.08;
        this.rollingFps = 1000.0 / Math.max(1.0, this.rollingFrameMs);

        // Adaptive shadow map update throttling on lower tiers so static terrain/structure shadows don't re-render every single frame
        const stride = this.current.shadowUpdateStride || 1;
        if (!this.current.shadowEnabled) {
            renderer.shadowMap.autoUpdate = false;
        } else if (stride <= 1) {
            renderer.shadowMap.autoUpdate = true;
        } else {
            renderer.shadowMap.autoUpdate = false;
            if ((this.frameCounter % stride) === 0) {
                renderer.shadowMap.needsUpdate = true;
            }
        }

        if (!this.autoAdapt) return;
        if (this.cooldownSec > 0) {
            this.cooldownSec = Math.max(0, this.cooldownSec - dt);
            return;
        }

        // Hysteresis thresholds:
        // Downgrade if rolling frame time > 23.5ms (< 42.5 FPS) for 1.6s (or > 29ms for 0.8s)
        // Upgrade if rolling frame time < 14.2ms (> 70 FPS) for 4.5s and unit count allows
        const idx = this.current.tierIndex;
        if (this.rollingFrameMs > 23.5 || (activeActorCount > 180 && idx < 2 && this.rollingFrameMs > 19.5)) {
            this.highLoadTimer += dt * (this.rollingFrameMs > 29.0 ? 2.0 : 1.0);
            this.lowLoadTimer = 0;
            if (this.highLoadTimer >= 1.6 && idx < _PERF_TIER_KEYS.length - 1) {
                this.applyProfile(_PERF_TIER_KEYS[idx + 1]);
                this.cooldownSec = 3.5;
                this.highLoadTimer = 0;
            }
        } else if (this.rollingFrameMs < 14.2 && activeActorCount < 140) {
            const minAllowedTier = IS_MOBILE ? 1 : 0;
            this.lowLoadTimer += dt;
            this.highLoadTimer = 0;
            if (this.lowLoadTimer >= 4.5 && idx > minAllowedTier) {
                this.applyProfile(_PERF_TIER_KEYS[idx - 1]);
                this.cooldownSec = 4.5;
                this.lowLoadTimer = 0;
            }
        } else {
            this.highLoadTimer = Math.max(0, this.highLoadTimer - dt * 0.5);
            this.lowLoadTimer = Math.max(0, this.lowLoadTimer - dt * 0.5);
        }
    }
};
window.PERF_MANAGER = PERF_MANAGER;

const PERF_PROFILER = {
    enabled: true,
    overlayVisible: false,
    overlayEl: null,
    lastOverlayUpdateMs: 0,
    sections: {
        mainSimulation: { cur: 0, avg: 0, max: 0, _t0: 0 },
        alliedAI: { cur: 0, avg: 0, max: 0, _t0: 0 },
        enemyAI: { cur: 0, avg: 0, max: 0, _t0: 0 },
        targetAcquisition: { cur: 0, avg: 0, max: 0, _t0: 0 },
        groundNavigation: { cur: 0, avg: 0, max: 0, _t0: 0 },
        collisionResolution: { cur: 0, avg: 0, max: 0, _t0: 0 },
        airSeparation: { cur: 0, avg: 0, max: 0, _t0: 0 },
        unitAnimation: { cur: 0, avg: 0, max: 0, _t0: 0 },
        particleSimulation: { cur: 0, avg: 0, max: 0, _t0: 0 },
        fogOfWar: { cur: 0, avg: 0, max: 0, _t0: 0 },
        domHealthBars: { cur: 0, avg: 0, max: 0, _t0: 0 },
        threeRender: { cur: 0, avg: 0, max: 0, _t0: 0 }
    },
    counts: {
        alliedUnits: 0,
        enemies: 0,
        buildings: 0,
        enemyBuildings: 0,
        projectiles: 0,
        particles: 0,
        pooledParticles: 0,
        smokeClouds: 0,
        corpses: 0,
        drawCalls: 0,
        triangles: 0,
        geometries: 0,
        textures: 0
    },
    beginFrame() {
        if (!this.enabled) return;
        const s = this.sections;
        s.targetAcquisition.cur = 0;
        s.groundNavigation.cur = 0;
        s.unitAnimation.cur = 0;
        s.domHealthBars.cur = 0;
    },
    begin(name) {
        if (!this.enabled) return;
        const sec = this.sections[name];
        if (sec) sec._t0 = performance.now();
    },
    end(name) {
        if (!this.enabled) return;
        const sec = this.sections[name];
        if (!sec || sec._t0 <= 0) return;
        const dtMs = performance.now() - sec._t0;
        sec._t0 = 0;
        sec.cur = dtMs;
        sec.avg = sec.avg * 0.90 + dtMs * 0.10;
        if (dtMs > sec.max) sec.max = dtMs;
    },
    addSample(name, dtMs) {
        if (!this.enabled) return;
        const sec = this.sections[name];
        if (!sec) return;
        sec.cur += dtMs;
    },
    endFrame() {
        if (!this.enabled) return;
        const s = this.sections;
        ['targetAcquisition', 'groundNavigation', 'unitAnimation', 'domHealthBars'].forEach(k => {
            const sec = s[k];
            sec.avg = sec.avg * 0.90 + sec.cur * 0.10;
            if (sec.cur > sec.max) sec.max = sec.cur;
        });
        if (renderer && renderer.info) {
            this.counts.drawCalls = renderer.info.render ? renderer.info.render.calls : 0;
            this.counts.triangles = renderer.info.render ? renderer.info.render.triangles : 0;
            this.counts.geometries = renderer.info.memory ? renderer.info.memory.geometries : 0;
            this.counts.textures = renderer.info.memory ? renderer.info.memory.textures : 0;
        }
    },
    resetPeaks() {
        for (const k in this.sections) {
            this.sections[k].max = 0;
        }
    },
    getSummary() {
        const out = {
            qualityTier: PERF_MANAGER.current.name,
            fps: +PERF_MANAGER.rollingFps.toFixed(1),
            frameMs: +PERF_MANAGER.rollingFrameMs.toFixed(2),
            timingsMs: {},
            counts: { ...this.counts }
        };
        for (const k in this.sections) {
            out.timingsMs[k] = {
                avg: +this.sections[k].avg.toFixed(3),
                max: +this.sections[k].max.toFixed(3)
            };
        }
        return out;
    }
};
window.PERF_PROFILER = PERF_PROFILER;

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.target.set(18, 0, 22);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minPolarAngle = 0.52;
controls.maxPolarAngle = Math.PI / 2 - 0.12;
controls.minDistance = 14;
controls.maxDistance = 145;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_PAN, THREE: THREE.TOUCH.ROTATE };
if (IS_MOBILE) {
    // 1 finger = game input (place / select), 2 fingers = pan/move camera (+ pinch zoom), 3 fingers = rotate camera viewing direction
    controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_PAN, THREE: THREE.TOUCH.ROTATE };
    controls.panSpeed = 1.15;
    controls.rotateSpeed = 0.85;
    camera.position.set(30, 52, 74);
    controls.maxDistance = 165;
}
window.scene = scene;
window.camera = camera;
window.renderer = renderer;
window.controls = controls;

const keysPressed = {};
window.addEventListener('keydown', e => { keysPressed[e.key.toLowerCase()] = true; });
window.addEventListener('keyup', e => { keysPressed[e.key.toLowerCase()] = false; });
window.addEventListener('blur', () => {
    for (const k in keysPressed) keysPressed[k] = false;
});

// ============================================================================
// WEBGL CONTEXT LOSS / RESTORATION RECOVERY & GRAPHICS DIAGNOSTICS ENGINE
// ============================================================================
const GRAPHICS_DIAGNOSTICS = {
    contextStatus: 'ACTIVE',
    contextLossCount: 0,
    contextRestoreCount: 0,
    lastContextEventTime: null,
    rendererInfo: {
        vendor: 'WebGL',
        renderer: 'Hardware Accelerated',
        version: '',
        shadingLanguageVersion: '',
        maxTextureSize: 4096,
        maxAnisotropy: 1
    },
    shaderValidation: {
        validatedCount: 0,
        failedInjections: [],
        compilationErrors: [],
        fallbackMaterialsUsed: 0,
        lastValidatedAt: null
    },
    lowQualityMobileFallback: false,
    initRendererCapabilities() {
        try {
            const gl = renderer.getContext();
            if (gl) {
                const dbgExt = gl.getExtension('WEBGL_debug_renderer_info');
                this.rendererInfo.vendor = (dbgExt && gl.getParameter(dbgExt.UNMASKED_VENDOR_WEBGL)) || gl.getParameter(gl.VENDOR) || 'Unknown Vendor';
                this.rendererInfo.renderer = (dbgExt && gl.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || 'Unknown GPU';
                this.rendererInfo.version = gl.getParameter(gl.VERSION) || 'WebGL';
                this.rendererInfo.shadingLanguageVersion = gl.getParameter(gl.SHADING_LANGUAGE_VERSION) || 'GLSL';
                this.rendererInfo.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
            }
            if (renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
                this.rendererInfo.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
            }
            const lowGpuPattern = /Mali-4|Mali-T|Adreno \(TM\) [234]|PowerVR SGX|SwiftShader|llvmpipe/i;
            if (IS_MOBILE && (this.rendererInfo.maxTextureSize <= 4096 || lowGpuPattern.test(this.rendererInfo.renderer) || (navigator.deviceMemory && navigator.deviceMemory <= 3))) {
                this.lowQualityMobileFallback = true;
                PERF_MANAGER.applyTier('low');
            }
        } catch (err) {
            this.shaderValidation.compilationErrors.push(`Capability probe error: ${err && err.message ? err.message : String(err)}`);
        }
    },
    recordShaderInjectionFailure(matName, missingAnchors) {
        const entry = {
            time: new Date().toISOString(),
            material: matName || 'TerrainStandardMaterial',
            missingAnchors
        };
        this.shaderValidation.failedInjections.push(entry);
        if (this.shaderValidation.failedInjections.length > 24) {
            this.shaderValidation.failedInjections.shift();
        }
        this.shaderValidation.fallbackMaterialsUsed++;
    },
    recordShaderError(msg, details = null) {
        const fullMsg = String(msg || 'Unknown shader compile/link error');
        const entry = {
            time: new Date().toISOString(),
            message: fullMsg,
            details: details || null
        };
        this.shaderValidation.compilationErrors.push(entry);
        if (this.shaderValidation.compilationErrors.length > 50) {
            this.shaderValidation.compilationErrors.shift();
        }
        if (window.APP_ERROR_HANDLER && typeof window.APP_ERROR_HANDLER.record === 'function') {
            window.APP_ERROR_HANDLER.record('WebGLShaderCompilation', new Error(fullMsg), 'shader', 'CRITICAL');
        }
        if (window.SHADER_ENGINE && typeof window.SHADER_ENGINE.enableSafeMaterialFallbacks === 'function') {
            window.SHADER_ENGINE.enableSafeMaterialFallbacks(fullMsg);
        }
    },
    showContextBanner(text, isWarning = true) {
        let banner = document.getElementById('webgl-context-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'webgl-context-banner';
            banner.style.cssText = 'position:fixed;top:46px;left:50%;transform:translateX(-50%);z-index:9999;padding:8px 16px;border-radius:6px;font-family:monospace;font-size:12px;font-weight:700;letter-spacing:0.6px;pointer-events:auto;box-shadow:0 6px 20px rgba(0,0,0,0.65);display:none;';
            document.body.appendChild(banner);
        }
        if (!text) {
            banner.style.display = 'none';
            return;
        }
        banner.style.display = 'block';
        banner.style.background = isWarning ? 'rgba(185, 28, 28, 0.94)' : 'rgba(6, 95, 70, 0.94)';
        banner.style.border = isWarning ? '1px solid #fca5a5' : '1px solid #6ee7b7';
        banner.style.color = '#ffffff';
        banner.innerText = text;
    },
    getSnapshot() {
        const info = (renderer && renderer.info) ? renderer.info : {};
        const rInfo = info.render || {};
        const mInfo = info.memory || {};
        return {
            contextStatus: this.contextStatus,
            contextLossCount: this.contextLossCount,
            contextRestoreCount: this.contextRestoreCount,
            lastContextEventTime: this.lastContextEventTime,
            rendererInfo: { ...this.rendererInfo },
            shaderValidation: {
                validatedCount: this.shaderValidation.validatedCount,
                fallbackMaterialsUsed: this.shaderValidation.fallbackMaterialsUsed,
                failedInjections: this.shaderValidation.failedInjections.slice(-12),
                compilationErrors: this.shaderValidation.compilationErrors.slice(-12)
            },
            drawCalls: rInfo.calls || 0,
            triangles: rInfo.triangles || 0,
            geometries: mInfo.geometries || 0,
            textures: mInfo.textures || 0,
            fps: +(PERF_MANAGER.rollingFps || 60).toFixed(1),
            frameTimeMs: +(PERF_MANAGER.rollingFrameMs || 16.7).toFixed(2),
            qualityTier: PERF_MANAGER.current ? PERF_MANAGER.current.name : 'High',
            devicePixelRatio: +(renderer.getPixelRatio ? renderer.getPixelRatio() : (window.devicePixelRatio || 1)).toFixed(2),
            lowQualityMobileFallback: this.lowQualityMobileFallback
        };
    }
};
window.GRAPHICS_DIAGNOSTICS = GRAPHICS_DIAGNOSTICS;
GRAPHICS_DIAGNOSTICS.initRendererCapabilities();

if (renderer.debug) {
    renderer.debug.checkShaderErrors = true;
    renderer.debug.onShaderError = (gl, program, glVertexShader, glFragmentShader) => {
        try {
            const vStatus = gl.getShaderParameter(glVertexShader, gl.COMPILE_STATUS);
            const fStatus = gl.getShaderParameter(glFragmentShader, gl.COMPILE_STATUS);
            const pStatus = gl.getProgramParameter(program, gl.LINK_STATUS);
            const vLog = gl.getShaderInfoLog(glVertexShader) || '';
            const fLog = gl.getShaderInfoLog(glFragmentShader) || '';
            const pLog = gl.getProgramInfoLog(program) || '';
            const vSrc = gl.getShaderSource(glVertexShader) || '';
            const fSrc = gl.getShaderSource(glFragmentShader) || '';
            GRAPHICS_DIAGNOSTICS.recordShaderError(
                `Shader compile/link error (VS:${vStatus}, FS:${fStatus}, LINK:${pStatus}): ${vLog} ${fLog} ${pLog}`.trim(),
                { vertexLog: vLog, fragmentLog: fLog, programLog: pLog, vertexSnippet: vSrc.slice(0, 600), fragmentSnippet: fSrc.slice(0, 600) }
            );
        } catch (err) {
            GRAPHICS_DIAGNOSTICS.recordShaderError(err && err.message ? err.message : 'Shader error');
        }
    };
}

renderer.domElement.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    GRAPHICS_DIAGNOSTICS.contextStatus = 'LOST';
    GRAPHICS_DIAGNOSTICS.contextLossCount++;
    GRAPHICS_DIAGNOSTICS.lastContextEventTime = new Date().toISOString();
    if (window.APP_ERROR_HANDLER) {
        window.APP_ERROR_HANDLER.record('webglcontextlost', 'WebGL context lost', 'graphics', 'WARNING');
    }
    GRAPHICS_DIAGNOSTICS.showContextBanner('⚠️ WEBGL GRAPHICS CONTEXT LOST — Pausing GPU draw calls & attempting automatic hardware recovery...', true);
    if (IS_MOBILE) {
        GRAPHICS_DIAGNOSTICS.lowQualityMobileFallback = true;
        PERF_MANAGER.applyTier('low');
    }
});

renderer.domElement.addEventListener('webglcontextrestored', () => {
    GRAPHICS_DIAGNOSTICS.contextStatus = 'RESTORED';
    GRAPHICS_DIAGNOSTICS.contextRestoreCount++;
    GRAPHICS_DIAGNOSTICS.lastContextEventTime = new Date().toISOString();
    try {
        // Safely iterate through centralized TEXTURE_REGISTRY and re-verify every texture after context restoration
        if (window.TEXTURE_REGISTRY && typeof window.TEXTURE_REGISTRY === 'object') {
            Object.keys(window.TEXTURE_REGISTRY).forEach(texName => {
                const tex = window.TEXTURE_REGISTRY[texName];
                if (tex && tex.isTexture) {
                    tex.needsUpdate = true;
                }
            });
            if (window.TEXTURE_REGISTRY.textures) {
                Object.keys(window.TEXTURE_REGISTRY.textures).forEach(texName => {
                    const entry = window.TEXTURE_REGISTRY.textures[texName];
                    if (entry && entry.texture && entry.texture.isTexture) {
                        entry.texture.needsUpdate = true;
                    }
                });
            }
        }
        if (typeof fowTexture !== 'undefined' && fowTexture && fowTexture.isTexture) {
            fowTexture.needsUpdate = true;
        }
        if (typeof window.verifyAndRepairFactionMaterials === 'function') {
            window.verifyAndRepairFactionMaterials();
        }
        if (typeof window.validateAndRepairTerrainPipeline === 'function') {
            window.validateAndRepairTerrainPipeline();
        }
        if (window.SCENE_INTEGRITY_VALIDATOR && typeof window.SCENE_INTEGRITY_VALIDATOR.validateSceneGraph === 'function') {
            window.SCENE_INTEGRITY_VALIDATOR.validateSceneGraph(scene, 'webglcontextrestored');
        }
        scene.traverse(obj => {
            if (obj && obj.isMesh) {
                if (obj.geometry && obj.geometry.attributes) {
                    for (const k in obj.geometry.attributes) {
                        if (obj.geometry.attributes[k]) obj.geometry.attributes[k].needsUpdate = true;
                    }
                }
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                mats.forEach(m => { if (m) m.needsUpdate = true; });
            }
        });
        window._forceFowReset = true;
        if (typeof updateFogOfWarVision === 'function') updateFogOfWarVision();
        GRAPHICS_DIAGNOSTICS.showContextBanner('✓ WEBGL GRAPHICS CONTEXT RESTORED — Terrain, shaders & textures recovered.', false);
        setTimeout(() => {
            if (GRAPHICS_DIAGNOSTICS.contextStatus === 'RESTORED') {
                GRAPHICS_DIAGNOSTICS.contextStatus = 'ACTIVE';
                GRAPHICS_DIAGNOSTICS.showContextBanner(null);
            }
        }, 4000);
    } catch (err) {
        const errMsg = `Context restore error: ${err && err.message ? err.message : String(err)}`;
        GRAPHICS_DIAGNOSTICS.recordShaderError(errMsg);
        if (window.APP_ERROR_HANDLER) window.APP_ERROR_HANDLER.record('webglcontextrestored', err, 'graphics');
    }
});

// ============================================================================
// DEVELOPMENT SCENE INTEGRITY VALIDATOR (Detects & Reports Invalid Scene Nodes)
// ============================================================================
const SCENE_INTEGRITY_VALIDATOR = {
    enabled: true,
    reports: [],
    lastValidatedFrame: -1,
    totalChecks: 0,
    totalRepairs: 0,
    _inferSubsystemFromStack(stackStr) {
        if (!stackStr) return 'unknown';
        if (stackStr.includes('terrain-fow.js')) return 'terrain-fow';
        if (stackStr.includes('models-fx.js')) return 'models-fx';
        if (stackStr.includes('textures-scene.js')) return 'textures-scene';
        if (stackStr.includes('perf_optimizer.js')) return 'perf-optimizer';
        if (stackStr.includes('game.js')) return 'game-loop';
        return 'scene-graph';
    },
    _hasInvalidMatrix(mat) {
        if (!mat || !mat.elements || mat.elements.length !== 16) return true;
        for (let i = 0; i < 16; i++) {
            if (!Number.isFinite(mat.elements[i])) return true;
        }
        return false;
    },
    recordInvalidObject(info) {
        const entry = {
            timestamp: new Date().toISOString(),
            name: info.name || '<unnamed>',
            uuid: info.uuid || '<no-uuid>',
            type: info.type || typeof info.rawObject,
            parent: info.parentName || (info.parent ? (info.parent.name || info.parent.type || info.parent.uuid) : '<root>'),
            parentUuid: info.parent ? info.parent.uuid : null,
            creationSource: info.creationSource || 'unknown',
            subsystem: info.subsystem || 'scene-graph',
            invalidPositionOrMatrix: info.invalidPositionOrMatrix || info.reason || 'Invalid Object3D in scene hierarchy',
            participantId: info.participantId || null,
            bridgeId: info.bridgeId !== undefined ? info.bridgeId : null,
            reason: info.reason || 'Invalid Object3D in scene hierarchy'
        };
        this.reports.push(entry);
        if (this.reports.length > 100) this.reports.shift();
        console.warn('[SCENE_INTEGRITY_VALIDATOR] Invalid scene object detected:', entry);
        if (window.APP_ERROR_HANDLER && typeof window.APP_ERROR_HANDLER.record === 'function') {
            window.APP_ERROR_HANDLER.record(
                'scene-integrity',
                `Invalid scene object (${entry.reason}): name=${entry.name}, uuid=${entry.uuid}, type=${entry.type}, parent=${entry.parent}, source=${entry.creationSource}, subsystem=${entry.subsystem}, posOrMat=${entry.invalidPositionOrMatrix}, participant=${entry.participantId || 'none'}, bridge=${entry.bridgeId ?? 'none'}`,
                entry.subsystem
            );
        }
        return entry;
    },
    _findFirstInvalidAncestor(node) {
        let curr = node;
        let firstBad = node;
        const chain = [];
        while (curr) {
            const label = curr.name || curr.type || curr.uuid || 'Object3D';
            chain.push(label);
            const badPos = !curr.position || !Number.isFinite(curr.position.x) || !Number.isFinite(curr.position.y) || !Number.isFinite(curr.position.z);
            const badScale = !curr.scale || !Number.isFinite(curr.scale.x) || !Number.isFinite(curr.scale.y) || !Number.isFinite(curr.scale.z);
            const badQuat = !curr.quaternion || !Number.isFinite(curr.quaternion.x) || !Number.isFinite(curr.quaternion.y) || !Number.isFinite(curr.quaternion.z) || !Number.isFinite(curr.quaternion.w);
            if (badPos || badScale || badQuat) {
                firstBad = curr;
            }
            curr = curr.parent;
        }
        return {
            firstInvalidAncestor: firstBad ? (firstBad.name || firstBad.type || firstBad.uuid) : 'unknown',
            parentChain: chain.join(' -> ')
        };
    },
    validateSceneGraph(rootObj, subsystemContext = 'render-loop') {
        const targetRoot = rootObj || (typeof scene !== 'undefined' ? scene : window.scene);
        if (!targetRoot) return { valid: false, repaired: 0, repairedCount: 0, invalidCount: 0, reports: this.reports };
        this.totalChecks++;
        let repairedCount = 0;
        const stack = [targetRoot];
        const visited = new Set();

        while (stack.length > 0) {
            const node = stack.pop();
            if (!node || typeof node !== 'object') continue;
            if (visited.has(node)) continue;
            visited.add(node);

            if (typeof node.visible === 'undefined') {
                node.visible = true;
            }

            if (Array.isArray(node.children)) {
                for (let i = node.children.length - 1; i >= 0; i--) {
                    const child = node.children[i];
                    if (
                        child === undefined ||
                        child === null ||
                        typeof child !== 'object' ||
                        !child.isObject3D ||
                        !Array.isArray(child.children)
                    ) {
                        const ud = (child && child.userData) || (node && node.userData) || {};
                        this.recordInvalidObject({
                            rawObject: child,
                            name: child && child.name ? child.name : `children[${i}]`,
                            type: child && child.type ? child.type : typeof child,
                            parent: node,
                            parentName: node.name || node.type || node.uuid,
                            uuid: child && child.uuid ? child.uuid : null,
                            creationSource: ud._creationSource || subsystemContext,
                            subsystem: ud._subsystem || subsystemContext,
                            participantId: ud._participantId || ud.participantId || null,
                            bridgeId: ud._bridgeId !== undefined ? ud._bridgeId : (ud.bridgeId !== undefined ? ud.bridgeId : null),
                            invalidPositionOrMatrix: 'Non-Object3D or null child',
                            reason: child === undefined || child === null
                                ? 'Null or undefined child in Object3D.children'
                                : 'Non-Object3D or corrupted children array'
                        });
                        node.children.splice(i, 1);
                        if (child && child.parent === node) {
                            child.parent = null;
                        }
                        repairedCount++;
                        this.totalRepairs++;
                        continue;
                    }

                    if (typeof child.visible === 'undefined') {
                        child.visible = true;
                    }

                    // Check and repair local rotation / quaternion / scale before checking matrixWorld
                    let repairedLocalTransform = false;
                    if (child.scale && (
                        !Number.isFinite(child.scale.x) ||
                        !Number.isFinite(child.scale.y) ||
                        !Number.isFinite(child.scale.z) ||
                        Math.abs(child.scale.x) < 1e-7 ||
                        Math.abs(child.scale.y) < 1e-7 ||
                        Math.abs(child.scale.z) < 1e-7
                    )) {
                        child.scale.set(
                            Number.isFinite(child.scale.x) && Math.abs(child.scale.x) >= 1e-7 ? child.scale.x : 1,
                            Number.isFinite(child.scale.y) && Math.abs(child.scale.y) >= 1e-7 ? child.scale.y : 1,
                            Number.isFinite(child.scale.z) && Math.abs(child.scale.z) >= 1e-7 ? child.scale.z : 1
                        );
                        repairedLocalTransform = true;
                    }
                    if (child.rotation && (
                        !Number.isFinite(child.rotation.x) ||
                        !Number.isFinite(child.rotation.y) ||
                        !Number.isFinite(child.rotation.z)
                    )) {
                        child.rotation.set(
                            Number.isFinite(child.rotation.x) ? child.rotation.x : 0,
                            Number.isFinite(child.rotation.y) ? child.rotation.y : 0,
                            Number.isFinite(child.rotation.z) ? child.rotation.z : 0
                        );
                        repairedLocalTransform = true;
                    }
                    if (child.quaternion && (
                        !Number.isFinite(child.quaternion.x) ||
                        !Number.isFinite(child.quaternion.y) ||
                        !Number.isFinite(child.quaternion.z) ||
                        !Number.isFinite(child.quaternion.w)
                    )) {
                        child.quaternion.set(0, 0, 0, 1);
                        repairedLocalTransform = true;
                    }

                    const hasBadPos = !child.position ||
                        !Number.isFinite(child.position.x) ||
                        !Number.isFinite(child.position.y) ||
                        !Number.isFinite(child.position.z);

                    if (!hasBadPos && (repairedLocalTransform || !child.matrixWorld || this._hasInvalidMatrix(child.matrixWorld))) {
                        try {
                            child.updateMatrix();
                            if (node.matrixWorld && !this._hasInvalidMatrix(node.matrixWorld)) {
                                child.matrixWorld.multiplyMatrices(node.matrixWorld, child.matrix);
                            } else {
                                child.matrixWorld.copy(child.matrix);
                            }
                        } catch (_e) {}
                    }

                    const hasBadMatrix = !child.matrixWorld || this._hasInvalidMatrix(child.matrixWorld);
                    if (hasBadPos || hasBadMatrix) {
                        const ud = (child && child.userData) || (node && node.userData) || {};
                        const ancestorInfo = this._findFirstInvalidAncestor(child);
                        const posDesc = child && child.position
                            ? `pos=(${child.position.x}, ${child.position.y}, ${child.position.z})`
                            : 'pos=missing';
                        const matDesc = hasBadMatrix ? 'matrixWorld=NaN/corrupted' : 'matrixWorld=ok';
                        this.recordInvalidObject({
                            rawObject: child,
                            name: child && child.name ? child.name : `children[${i}]`,
                            type: child && child.type ? child.type : typeof child,
                            parent: node,
                            parentName: `${node.name || node.type || node.uuid} [chain: ${ancestorInfo.parentChain}]`,
                            uuid: child && child.uuid ? child.uuid : null,
                            creationSource: ud._creationSource || subsystemContext,
                            subsystem: ud._subsystem || subsystemContext,
                            participantId: ud._participantId || ud.participantId || null,
                            bridgeId: ud._bridgeId !== undefined ? ud._bridgeId : (ud.bridgeId !== undefined ? ud.bridgeId : null),
                            invalidPositionOrMatrix: `${posDesc}, ${matDesc}, firstInvalidAncestor=${ancestorInfo.firstInvalidAncestor}`,
                            reason: 'NaN position or corrupted matrixWorld'
                        });
                        node.children.splice(i, 1);
                        if (child && child.parent === node) {
                            child.parent = null;
                        }
                        repairedCount++;
                        this.totalRepairs++;
                    } else {
                        stack.push(child);
                    }
                }
            }
        }
        return {
            valid: repairedCount === 0,
            repaired: repairedCount,
            repairedCount,
            invalidCount: repairedCount,
            totalChecks: this.totalChecks,
            totalRepairs: this.totalRepairs,
            reports: this.reports
        };
    }
};

// Guard THREE.Object3D.prototype.add and lookAt against undefined/invalid objects or NaN coordinates
if (typeof THREE !== 'undefined' && THREE.Object3D && !THREE.Object3D.prototype._starblockGuardedAdd) {
    const _origObject3DAdd = THREE.Object3D.prototype.add;
    THREE.Object3D.prototype.add = function (...objects) {
        if (objects.length === 0) return this;
        const validObjects = [];
        for (let i = 0; i < objects.length; i++) {
            const obj = objects[i];
            const hasBadPos = obj && obj.position && (
                !Number.isFinite(obj.position.x) ||
                !Number.isFinite(obj.position.y) ||
                !Number.isFinite(obj.position.z)
            );
            if (!obj || typeof obj !== 'object' || !obj.isObject3D || typeof obj.visible === 'undefined' || hasBadPos) {
                const errStack = new Error().stack || '';
                const ud = (obj && obj.userData) || (this && this.userData) || {};
                SCENE_INTEGRITY_VALIDATOR.recordInvalidObject({
                    rawObject: obj,
                    name: obj && obj.name ? obj.name : `add_arg[${i}]`,
                    type: obj && obj.type ? obj.type : typeof obj,
                    parent: this,
                    parentName: this.name || this.type || this.uuid,
                    uuid: obj && obj.uuid ? obj.uuid : null,
                    creationSource: ud._creationSource || errStack.split('\n').slice(1, 4).map(s => s.trim()).join(' <- '),
                    subsystem: ud._subsystem || SCENE_INTEGRITY_VALIDATOR._inferSubsystemFromStack(errStack),
                    participantId: ud._participantId || null,
                    bridgeId: ud._bridgeId !== undefined ? ud._bridgeId : null,
                    invalidPositionOrMatrix: hasBadPos && obj.position
                        ? `pos=(${obj.position.x}, ${obj.position.y}, ${obj.position.z})`
                        : 'Non-Object3D or missing .visible',
                    reason: hasBadPos
                        ? 'Attempted to call Object3D.add() with non-finite (NaN/Infinity) position'
                        : 'Attempted to call Object3D.add() with undefined or non-Object3D value'
                });
                continue;
            }
            if (obj.userData && !obj.userData._subsystem) {
                obj.userData._subsystem = (this.userData && this.userData._subsystem) || 'scene-object';
            }
            validObjects.push(obj);
        }
        if (validObjects.length === 0) return this;
        return _origObject3DAdd.apply(this, validObjects);
    };

    const _origLookAt = THREE.Object3D.prototype.lookAt;
    THREE.Object3D.prototype.lookAt = function (x, y, z) {
        let tx = x, ty = y, tz = z;
        if (x && typeof x === 'object' && 'x' in x) {
            tx = x.x;
            ty = x.y;
            tz = x.z;
        }
        if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) {
            return this;
        }
        if (this.position) {
            const dx = tx - this.position.x;
            const dy = ty - this.position.y;
            const dz = tz - this.position.z;
            if (dx * dx + dy * dy + dz * dz < 1e-8) {
                return this;
            }
        }
        return _origLookAt.call(this, tx, ty, tz);
    };

    THREE.Object3D.prototype._starblockGuardedAdd = true;
}
window.SCENE_INTEGRITY_VALIDATOR = SCENE_INTEGRITY_VALIDATOR;

// Procedural Web Audio Synthesizer (Weight-scaled tactical feedback with mute toggle)
const SFX = {
    ctx: null,
    muted: false,
    lastShotTime: 0,
    _hwUnlocked: false,
    init() {
        if (!this.ctx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) this.ctx = new AudioCtx();
        }
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume().catch(() => {});
        }
    },
    unlockAndResume() {
        this.init();
        if (!this.ctx) return;
        // Universal WebAudio hardware unlock inside user gesture (works in iframes, Chrome, Safari, Mobile)
        if (!this._hwUnlocked) {
            try {
                const buf = this.ctx.createBuffer(1, 1, 22050);
                const src = this.ctx.createBufferSource();
                src.buffer = buf;
                src.connect(this.ctx.destination);
                src.start(0);
                if (this.ctx.state === 'running') this._hwUnlocked = true;
            } catch (e) {}
        }
        const startOrKickMusic = () => {
            this._hwUnlocked = true;
            if (window.RAID_MUSIC && !window.RAID_MUSIC.muted && !this.muted) {
                if (!window.RAID_MUSIC.playing) {
                    window.RAID_MUSIC.start();
                } else {
                    window.RAID_MUSIC.ensureNodes();
                    window.RAID_MUSIC.syncAudioFilePlayback();
                    if (!window.RAID_MUSIC.timerId) window.RAID_MUSIC.scheduleLoop();
                    if (!window.RAID_MUSIC._firstAudibleBeatPlayed) {
                        window.RAID_MUSIC._firstAudibleBeatPlayed = true;
                        window.RAID_MUSIC.tick();
                    }
                    window.RAID_MUSIC.updateHudButton();
                }
            }
        };
        if (this.ctx.state === 'suspended') {
            this.ctx.resume().then(startOrKickMusic).catch(() => {});
        } else if (this.ctx.state === 'running') {
            startOrKickMusic();
        }
    },
    playClick() {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1320, now + 0.045);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.055);
    },
    playBuild() {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        [330, 440, 660].forEach((freq, idx) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(freq, now + idx * 0.05);
            gain.gain.setValueAtTime(0.07, now + idx * 0.05);
            gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.05 + 0.14);
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start(now + idx * 0.05);
            osc.stop(now + idx * 0.05 + 0.15);
        });
    },
    playShoot(wType = 'mg') {
        if (this.muted) return;
        const perfNow = performance.now();
        if (perfNow - this.lastShotTime < 45) return;
        this.lastShotTime = perfNow;
        this.init();
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        const isHeavy = wType === 'tank' || wType === 'mortar';
        osc.type = isHeavy ? 'sawtooth' : 'square';
        osc.frequency.setValueAtTime(isHeavy ? 140 : 320, now);
        osc.frequency.exponentialRampToValueAtTime(isHeavy ? 38 : 75, now + (isHeavy ? 0.18 : 0.07));
        gain.gain.setValueAtTime(isHeavy ? 0.11 : 0.045, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + (isHeavy ? 0.19 : 0.075));
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + (isHeavy ? 0.2 : 0.08));
    },
    playExplosion(isBig = false) {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(isBig ? 95 : 130, now);
        osc.frequency.exponentialRampToValueAtTime(22, now + (isBig ? 0.38 : 0.22));
        gain.gain.setValueAtTime(isBig ? 0.16 : 0.09, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + (isBig ? 0.4 : 0.24));
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + (isBig ? 0.42 : 0.25));
    },
    playHeal() {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.16);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.19);
    }
};
window.SFX = SFX;

// ============================================================================
// 2A. STARCRAFT II KOPRULU SOUNDTRACK AUDIO ENGINE + TACTICAL SYNTH ACCOMPANIMENT
//     Plays the dedicated /sc2-soundtrack.wav background music file with seamless
//     looping, dynamic combat intensity scaling, and multi-track switching.
// ============================================================================
const RAID_MUSIC = {
    playing: false,
    muted: false,
    trackIndex: 0,
    step: 0,
    timerId: null,
    combatIntensity: 0.25,
    masterGain: null,
    compressor: null,
    distortionCurve: null,
    noiseBuffer: null,
    audioEl: null,
    audioSrc: '/sc2-soundtrack.wav',
    tracks: [
        {
            name: 'KOPRULU FRONTIER (SC2 SOUNDTRACK)',
            bpm: 120,
            useAudioFile: true,
            playbackRate: 1.0,
            bassRiff: [
                41.20, 41.20, 82.41, 41.20,  49.00, 49.00, 55.00, 49.00,
                55.00, 55.00, 110.0, 55.00,  65.41, 65.41, 73.42, 65.41,
                41.20, 41.20, 82.41, 41.20,  49.00, 49.00, 73.42, 55.00,
                65.41, 65.41, 73.42, 65.41,  61.74, 55.00, 49.00, 41.20
            ],
            leadMelody: [
                329.63, 0, 392.00, 440.00,   493.88, 0, 440.00, 392.00,
                392.00, 0, 440.00, 493.88,   587.33, 0, 493.88, 440.00,
                440.00, 0, 493.88, 554.37,   659.25, 0, 554.37, 493.88,
                523.25, 0, 587.33, 659.25,   587.33, 523.25, 493.88, 392.00
            ]
        },
        {
            name: 'TERRAN DOMINION (HEAVEN\x27S DEVILS)',
            bpm: 130,
            useAudioFile: true,
            playbackRate: 1.06,
            bassRiff: [
                41.20, 41.20, 82.41, 41.20,  43.65, 43.65, 49.00, 41.20,
                41.20, 41.20, 82.41, 41.20,  65.41, 61.74, 55.00, 49.00,
                41.20, 41.20, 82.41, 41.20,  43.65, 43.65, 49.00, 55.00,
                61.74, 61.74, 65.41, 61.74,  55.00, 49.00, 43.65, 41.20
            ],
            leadMelody: [
                329.63, 0, 329.63, 0,  349.23, 0, 392.00, 329.63,
                0, 0, 329.63, 0,       523.25, 493.88, 440.00, 392.00,
                329.63, 0, 329.63, 0,  349.23, 0, 392.00, 440.00,
                493.88, 0, 523.25, 493.88, 440.00, 392.00, 349.23, 329.63
            ]
        },
        {
            name: 'SECTOR-09 SIEGE (ARMOR ASSAULT)',
            bpm: 138,
            useAudioFile: true,
            playbackRate: 0.94,
            bassRiff: [
                36.71, 36.71, 73.42, 36.71,  41.20, 43.65, 36.71, 36.71,
                36.71, 36.71, 73.42, 36.71,  55.00, 49.00, 43.65, 41.20,
                36.71, 36.71, 73.42, 36.71,  41.20, 43.65, 49.00, 55.00,
                58.27, 55.00, 49.00, 43.65,  41.20, 36.71, 73.42, 36.71
            ],
            leadMelody: [
                293.66, 0, 293.66, 349.23,   329.63, 0, 293.66, 0,
                440.00, 0, 466.16, 440.00,   392.00, 349.23, 329.63, 293.66,
                293.66, 0, 349.23, 392.00,   440.00, 0, 466.16, 523.25,
                587.33, 0, 523.25, 466.16,   440.00, 392.00, 349.23, 293.66
            ]
        }
    ],
    ensureAudioFile() {
        if (!this.audioEl && typeof Audio !== 'undefined') {
            try {
                const audio = new Audio(this.audioSrc);
                audio.loop = true;
                audio.preload = 'auto';
                audio.volume = 0.55;
                this.audioEl = audio;
            } catch (e) {}
        }
        return this.audioEl;
    },
    syncAudioFilePlayback() {
        const audio = this.ensureAudioFile();
        if (!audio) return;
        const track = this.tracks[this.trackIndex % this.tracks.length];
        const shouldPlay = Boolean(this.playing && !this.muted && !SFX.muted);
        audio.muted = !shouldPlay;
        audio.volume = shouldPlay ? Math.min(0.85, 0.48 + this.combatIntensity * 0.25) : 0;
        if (track && track.playbackRate) {
            try { audio.playbackRate = track.playbackRate; } catch (e) {}
        }
        if (shouldPlay) {
            if (audio.paused) {
                const playPromise = audio.play();
                if (playPromise && typeof playPromise.catch === 'function') {
                    playPromise.catch(() => {});
                }
            }
        } else {
            if (!audio.paused) {
                try { audio.pause(); } catch (e) {}
            }
        }
    },
    ensureNodes() {
        this.ensureAudioFile();
        SFX.init();
        if (!SFX.ctx) return false;
        const ctx = SFX.ctx;
        if (!this.masterGain) {
            this.masterGain = ctx.createGain();
            this.masterGain.gain.value = 0.22;
            if (typeof ctx.createDynamicsCompressor === 'function') {
                this.compressor = ctx.createDynamicsCompressor();
                this.compressor.threshold.setValueAtTime(-16, ctx.currentTime);
                this.compressor.knee.setValueAtTime(18, ctx.currentTime);
                this.compressor.ratio.setValueAtTime(4, ctx.currentTime);
                this.compressor.attack.setValueAtTime(0.005, ctx.currentTime);
                this.compressor.release.setValueAtTime(0.18, ctx.currentTime);
                this.masterGain.connect(this.compressor);
                this.compressor.connect(ctx.destination);
            } else {
                this.masterGain.connect(ctx.destination);
            }
        }
        if (!this.distortionCurve) {
            const samples = 512;
            const curve = new Float32Array(samples);
            const k = 42;
            for (let i = 0; i < samples; i++) {
                const x = (i * 2) / samples - 1;
                curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
            }
            this.distortionCurve = curve;
        }
        if (!this.noiseBuffer) {
            const len = Math.floor(ctx.sampleRate * 0.25);
            this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
            const data = this.noiseBuffer.getChannelData(0);
            for (let i = 0; i < len; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.065));
            }
        }
        return true;
    },
    triggerKickAndBootStomp(now, isHeavyStomp) {
        const ctx = SFX.ctx;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(isHeavyStomp ? 135 : 115, now);
        osc.frequency.exponentialRampToValueAtTime(34, now + 0.14);
        gain.gain.setValueAtTime(isHeavyStomp ? 0.48 : 0.34, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.17);

        if (isHeavyStomp && this.noiseBuffer) {
            const noise = ctx.createBufferSource();
            noise.buffer = this.noiseBuffer;
            const filter = ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.setValueAtTime(320, now);
            filter.Q.value = 1.8;
            const nGain = ctx.createGain();
            nGain.gain.setValueAtTime(0.28, now);
            nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
            noise.connect(filter);
            filter.connect(nGain);
            nGain.connect(this.masterGain);
            noise.start(now);
            noise.stop(now + 0.12);
        }
    },
    triggerMilitantSnare(now, accent = false) {
        const ctx = SFX.ctx;
        if (!this.noiseBuffer) return;
        const noise = ctx.createBufferSource();
        noise.buffer = this.noiseBuffer;
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.setValueAtTime(850, now);
        const nGain = ctx.createGain();
        nGain.gain.setValueAtTime(accent ? 0.32 : 0.16, now);
        nGain.gain.exponentialRampToValueAtTime(0.001, now + (accent ? 0.14 : 0.08));
        noise.connect(filter);
        filter.connect(nGain);
        nGain.connect(this.masterGain);
        noise.start(now);
        noise.stop(now + 0.15);

        const body = ctx.createOscillator();
        const bGain = ctx.createGain();
        body.type = 'triangle';
        body.frequency.setValueAtTime(210, now);
        body.frequency.exponentialRampToValueAtTime(95, now + 0.07);
        bGain.gain.setValueAtTime(accent ? 0.22 : 0.11, now);
        bGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        body.connect(bGain);
        bGain.connect(this.masterGain);
        body.start(now);
        body.stop(now + 0.09);
    },
    triggerHiHat(now, open = false) {
        const ctx = SFX.ctx;
        if (!this.noiseBuffer) return;
        const noise = ctx.createBufferSource();
        noise.buffer = this.noiseBuffer;
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.setValueAtTime(5200, now);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(open ? 0.11 : 0.055, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + (open ? 0.11 : 0.04));
        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);
        noise.start(now);
        noise.stop(now + 0.12);
    },
    triggerPowerChordGuitar(now, rootFreq, duration, accent = false) {
        const ctx = SFX.ctx;
        [rootFreq, rootFreq * 1.4983, rootFreq * 2.0].forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            osc.type = idx === 0 ? 'sawtooth' : 'square';
            osc.frequency.setValueAtTime(freq, now);

            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(accent ? 1750 : 1150, now);
            filter.frequency.exponentialRampToValueAtTime(360, now + duration);
            filter.Q.value = 3.2;

            const shaper = ctx.createWaveShaper();
            shaper.curve = this.distortionCurve;

            const gain = ctx.createGain();
            const vol = (idx === 0 ? 0.16 : 0.085) * (accent ? 1.25 : 0.94);
            gain.gain.setValueAtTime(vol, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

            osc.connect(filter);
            filter.connect(shaper);
            shaper.connect(gain);
            gain.connect(this.masterGain);
            osc.start(now);
            osc.stop(now + duration + 0.01);
        });
    },
    triggerCommandBrassAndSynthLead(now, freq, duration) {
        if (!freq || freq <= 0) return;
        const ctx = SFX.ctx;
        [-4.5, 4.5].forEach(detune => {
            const osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(freq, now);
            osc.detune.setValueAtTime(detune, now);

            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(2400 + this.combatIntensity * 1200, now);
            filter.frequency.exponentialRampToValueAtTime(720, now + duration);

            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.001, now);
            gain.gain.linearRampToValueAtTime(0.10 * (0.78 + this.combatIntensity * 0.45), now + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.masterGain);
            osc.start(now);
            osc.stop(now + duration + 0.02);
        });
    },
    tick() {
        if (!this.playing || this.muted || SFX.muted) return;
        this.syncAudioFilePlayback();
        if (!this.ensureNodes()) return;
        const ctx = SFX.ctx;
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
            return;
        }
        this._firstAudibleBeatPlayed = true;
        const track = this.tracks[this.trackIndex % this.tracks.length];
        const stepDur = (60 / track.bpm) / 4;
        const now = ctx.currentTime + 0.01;
        const s = this.step % 32;
        const beatStep = s % 4;

        if (beatStep === 0 || (s % 8 === 6 && this.combatIntensity > 0.35)) {
            this.triggerKickAndBootStomp(now, s % 8 === 0 || s % 8 === 4);
        }
        if (s % 8 === 4) {
            this.triggerMilitantSnare(now, true);
        } else if (s >= 28 && (s % 2 === 1)) {
            this.triggerMilitantSnare(now, false);
        }
        if (s % 2 === 0 || this.combatIntensity > 0.45) {
            this.triggerHiHat(now, beatStep === 2);
        }
        const bassFreq = track.bassRiff[s];
        if (bassFreq > 0) {
            const isAccent = (beatStep === 0) || (s % 8 === 3);
            this.triggerPowerChordGuitar(now, bassFreq, stepDur * (isAccent ? 1.85 : 1.15), isAccent);
        }
        const leadFreq = track.leadMelody[s];
        if (leadFreq > 0 && (s < 16 || this.combatIntensity > 0.15)) {
            this.triggerCommandBrassAndSynthLead(now, leadFreq, stepDur * 2.1);
        }

        this.step = (this.step + 1) % 32;
    },
    start() {
        this.ensureNodes();
        if (SFX.ctx && SFX.ctx.state === 'suspended') {
            SFX.ctx.resume().catch(() => {});
        }
        if (this.playing) {
            this.syncAudioFilePlayback();
            if (!this.timerId) this.scheduleLoop();
            if (SFX.ctx && SFX.ctx.state === 'running' && !this.muted && !SFX.muted && !this._firstAudibleBeatPlayed) {
                this.tick();
            }
            this.updateHudButton();
            return;
        }
        this.playing = true;
        this.syncAudioFilePlayback();
        this.scheduleLoop();
        if (SFX.ctx && SFX.ctx.state === 'running' && !this.muted && !SFX.muted) {
            this.tick();
        }
        this.updateHudButton();
    },
    scheduleLoop() {
        if (this.timerId) clearInterval(this.timerId);
        if (!this.playing) return;
        const track = this.tracks[this.trackIndex % this.tracks.length];
        const stepMs = ((60 / track.bpm) / 4) * 1000;
        this.timerId = setInterval(() => this.tick(), stepMs);
    },
    toggleMusic() {
        this.ensureNodes();
        const wasSuspended = SFX.ctx && SFX.ctx.state === 'suspended';
        if (wasSuspended) {
            SFX.ctx.resume().catch(() => {});
        }
        if (!this.playing) {
            this.muted = false;
            SFX.muted = false;
            this.start();
        } else if (wasSuspended && !this.muted) {
            this.muted = false;
            SFX.muted = false;
            this.syncAudioFilePlayback();
            this.tick();
        } else {
            this.muted = !this.muted;
            if (!this.muted) {
                SFX.muted = false;
                this.syncAudioFilePlayback();
                this.tick();
            } else {
                this.syncAudioFilePlayback();
            }
        }
        this.updateHudButton();
        return !this.muted;
    },
    nextTrack() {
        this.ensureNodes();
        if (SFX.ctx && SFX.ctx.state === 'suspended') {
            SFX.ctx.resume().catch(() => {});
        }
        this.trackIndex = (this.trackIndex + 1) % this.tracks.length;
        this.step = 0;
        this.muted = false;
        if (this.audioEl) {
            try { this.audioEl.currentTime = (this.trackIndex * 8.0) % 32.0; } catch (e) {}
        }
        if (!this.playing) this.start();
        else {
            this.syncAudioFilePlayback();
            this.scheduleLoop();
            this.tick();
        }
        this.updateHudButton();
        return this.tracks[this.trackIndex].name;
    },
    setCombatIntensity(level) {
        this.combatIntensity = Math.max(0.15, Math.min(1.0, level));
        if (this.playing) this.syncAudioFilePlayback();
    },
    updateHudButton() {
        const btn = document.getElementById('hud-music-btn');
        const track = this.tracks[this.trackIndex % this.tracks.length];
        if (btn) {
            const isOn = this.playing && !this.muted && !SFX.muted;
            btn.textContent = isOn ? `🎸 ${track.name.split(' ')[0]}: ON` : '🎸 MUSIC: OFF';
            btn.style.color = isOn ? '#ffaa00' : '#7896b4';
            btn.style.borderColor = isOn ? 'rgba(255,170,0,0.45)' : 'rgba(255,255,255,0.15)';
        }
        const modalBtn = document.getElementById('modal-music-track-btn');
        if (modalBtn) {
            modalBtn.textContent = `🎸 TRACK: ${track.name}`;
        }
    }
};
window.RAID_MUSIC = RAID_MUSIC;

// Global Capture-Phase User-Gesture Audio Unlock: unlocks Web Audio even when inner buttons call stopPropagation()!
['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown', 'click'].forEach(evtName => {
    window.addEventListener(evtName, () => {
        SFX.unlockAndResume();
    }, { capture: true, passive: true });
    document.addEventListener(evtName, () => {
        SFX.unlockAndResume();
    }, { capture: true, passive: true });
});

// Calibrated StarCraft II Three-Point RTS Studio Lighting Rig:
// 1. Key Light: Warm Koprulu Sun with Soft PCF Shadows & Tuned Shadow Bias
// 2. Fill Light: Cool Sky / Warm Canyon Ground Hemisphere Ambient
// 3. Rim Light: High-Contrast Cool Backlight for Unit Silhouette Separation
// 4. Ground Bounce Fill: Subtle Warm Uplight for Metallic Specular Readability
const hemiLight = new THREE.HemisphereLight(0xa2cef2, 0x3d523b, 0.90);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xfff4e2, 1.28);
dirLight.position.set(58, 96, 48);
dirLight.castShadow = true;
const _initialShadowMapRes = (window.PERF_MANAGER && window.PERF_MANAGER.current)
    ? window.PERF_MANAGER.current.shadowMapSize
    : (IS_MOBILE ? 512 : 1024);
dirLight.shadow.mapSize.width = _initialShadowMapRes;
dirLight.shadow.mapSize.height = _initialShadowMapRes;
const d = 88;
dirLight.shadow.camera.left = -d; dirLight.shadow.camera.right = d;
dirLight.shadow.camera.top = d; dirLight.shadow.camera.bottom = -d;
dirLight.shadow.camera.near = 10;
dirLight.shadow.camera.far = 230;
dirLight.shadow.bias = -0.00032;
dirLight.shadow.normalBias = 0.012;
dirLight.shadow.radius = IS_MOBILE ? 1.0 : 2.0;
scene.add(dirLight);

const rimLight = new THREE.DirectionalLight(0x74beff, 0.56);
rimLight.position.set(-64, 52, -56);
scene.add(rimLight);

const bounceFillLight = new THREE.DirectionalLight(0xffcf96, 0.22);
bounceFillLight.position.set(20, -45, 25);
scene.add(bounceFillLight);

window.hemiLight = hemiLight;
window.dirLight = dirLight;
window.rimLight = rimLight;
window.bounceFillLight = bounceFillLight;
window.SYNC_BIOME_LIGHTING_RIG = function syncBiomeLightingRig(biomeId) {
    const id = String(biomeId || 'koprulu').toLowerCase();
    if (id === 'char_volcanic' || id === 'volcanic' || id === 'char') {
        hemiLight.color.setHex(0xffb48a);
        hemiLight.groundColor.setHex(0x4a1d12);
        hemiLight.intensity = 0.84;
        dirLight.color.setHex(0xffd7b0);
        dirLight.intensity = 1.32;
        rimLight.color.setHex(0xff6b3d);
        rimLight.intensity = 0.62;
    } else if (id === 'kaldir_ice' || id === 'ice' || id === 'kaldir') {
        hemiLight.color.setHex(0xd4f1ff);
        hemiLight.groundColor.setHex(0x46637a);
        hemiLight.intensity = 0.96;
        dirLight.color.setHex(0xf0f9ff);
        dirLight.intensity = 1.24;
        rimLight.color.setHex(0x38bdf8);
        rimLight.intensity = 0.60;
    } else if (id === 'shakuras_twilight' || id === 'void' || id === 'shakuras') {
        hemiLight.color.setHex(0x93c5fd);
        hemiLight.groundColor.setHex(0x1e293b);
        hemiLight.intensity = 0.82;
        dirLight.color.setHex(0xdbeafe);
        dirLight.intensity = 1.18;
        rimLight.color.setHex(0x818cf8);
        rimLight.intensity = 0.64;
    } else {
        hemiLight.color.setHex(0xa2cef2);
        hemiLight.groundColor.setHex(0x3d523b);
        hemiLight.intensity = 0.90;
        dirLight.color.setHex(0xfff4e2);
        dirLight.intensity = 1.28;
        rimLight.color.setHex(0x74beff);
        rimLight.intensity = 0.56;
    }
};

// ============================================================================
// 2B. ADVANCED CUSTOM GLSL SHADER ENGINE (FLAME, BOMB, WATER, TERRAIN & FORCEFIELD)
// ============================================================================
// Procedural Volumetric Flame Shader (Pulsating Turbulent Fire Core + Heat Shimmer)
const flameShaderMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 1.0 }
    },
    vertexShader: `
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vPos;
        varying vec3 vNormal;
        void main() {
            vUv = uv;
            vNormal = normalize(normalMatrix * normal);
            vec3 p = position;
            // Upward flickering wind displacement
            float flameWave = sin(p.y * 7.5 - uTime * 14.0) * cos(p.x * 6.0 + uTime * 9.0) * 0.12 * (p.y + 0.2);
            p.x += flameWave * 0.75;
            p.z += flameWave * 0.55;
            p.y *= (1.0 + 0.15 * sin(uTime * 11.0));
            vPos = p;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
    `,
    fragmentShader: `
        uniform float uTime;
        uniform float uIntensity;
        varying vec2 vUv;
        varying vec3 vPos;
        varying vec3 vNormal;
        void main() {
            float y = clamp(vUv.y, 0.0, 1.0);
            float noise1 = sin(vPos.x * 8.0 + uTime * 8.0) * cos(vPos.y * 10.0 - uTime * 12.0);
            float noise2 = sin(vPos.z * 9.0 - uTime * 10.0) * cos(vPos.x * 7.0 + uTime * 7.0);
            float flicker = 0.5 + 0.5 * (noise1 * 0.6 + noise2 * 0.4);
            
            // Thermal gradient: white-hot core -> gold -> deep roaring crimson -> smoke dissipation
            vec3 coreCol = vec3(1.0, 0.98, 0.85);
            vec3 flameGold = vec3(1.0, 0.62, 0.08);
            vec3 flameRed = vec3(0.96, 0.16, 0.04);
            vec3 charredCol = vec3(0.22, 0.04, 0.01);
            
            vec3 col = mix(coreCol, flameGold, smoothstep(0.0, 0.35, y));
            col = mix(col, flameRed, smoothstep(0.35, 0.78, y));
            col = mix(col, charredCol, smoothstep(0.78, 1.0, y));
            
            float alpha = (1.0 - pow(y, 1.4)) * (0.65 + 0.35 * flicker) * uIntensity;
            gl_FragColor = vec4(col * 1.35, clamp(alpha, 0.0, 1.0));
        }
    `
});

const MAX_WATER_RIPPLES = 8;
const waterRippleCenters = [];
for (let i = 0; i < MAX_WATER_RIPPLES; i++) waterRippleCenters.push(new THREE.Vector2(9999, 9999));
const waterRippleTimes = new Float32Array(MAX_WATER_RIPPLES).fill(-99.0);
const waterRippleStrengths = new Float32Array(MAX_WATER_RIPPLES).fill(0.0);
let nextWaterRippleSlot = 0;

const _fallbackFowBytes = new Uint8Array([255, 255, 255, 0]);
const _fallbackFowTex = new THREE.DataTexture(_fallbackFowBytes, 1, 1, THREE.RGBAFormat);
_fallbackFowTex.needsUpdate = true;
window.registerGameTexture('_fallbackFowTex', _fallbackFowTex, 'fow');
const _sharedFowFlag = { value: 0.0 };
const _sharedMapSize = { value: 260.0 };
const _sharedTitleFlag = { value: 1.0 };
const _sharedSunLightFactor = { value: 1.0 };

const plasmaShaderMat = new THREE.ShaderMaterial({
    uniforms: {
        uTime: { value: 0 },
        uCoreColor: { value: new THREE.Color(0x00e5ff) },
        uRimColor: { value: new THREE.Color(0xffffff) },
        uAccentColor: { value: new THREE.Color(0x38bdf8) },
        uFowMap: { value: _fallbackFowTex },
        uHasFow: _sharedFowFlag,
        uMapSize: _sharedMapSize,
        uTitleScreen: _sharedTitleFlag,
        uSunLightFactor: _sharedSunLightFactor
    },
    vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying vec3 vLocalPos;
        varying vec3 vWorldPos;
        void main() {
            vLocalPos = position;
            vec4 worldPos = modelMatrix * vec4(position, 1.0);
            vWorldPos = worldPos.xyz;
            vNormal = normalize(normalMatrix * normal);
            vec4 mvPosition = viewMatrix * worldPos;
            vViewPosition = -mvPosition.xyz;
            gl_Position = projectionMatrix * mvPosition;
        }
    `,
    fragmentShader: `
        uniform float uTime;
        uniform vec3 uCoreColor;
        uniform vec3 uRimColor;
        uniform vec3 uAccentColor;
        uniform sampler2D uFowMap;
        uniform float uHasFow;
        uniform float uMapSize;
        uniform float uTitleScreen;
        uniform float uSunLightFactor;
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying vec3 vLocalPos;
        varying vec3 vWorldPos;
        void main() {
            vec3 viewDir = normalize(vViewPosition);
            float fresnel = pow(1.0 - abs(dot(vNormal, viewDir)), 1.65);
            float swirl1 = sin(vLocalPos.y * 16.0 + vLocalPos.x * 11.0 - uTime * 8.2);
            float swirl2 = cos(vLocalPos.z * 14.0 - vLocalPos.y * 9.0 + uTime * 6.4);
            float plasmaBand = 0.5 + 0.5 * sin(swirl1 * 1.8 + swirl2 * 1.6);
            float pulse = 0.82 + 0.18 * sin(uTime * 5.5 + vLocalPos.z * 8.0);
            vec3 base = mix(uCoreColor * pulse, uAccentColor, plasmaBand * 0.55);
            vec3 col = mix(base, uRimColor, clamp(fresnel * 0.72 + plasmaBand * 0.28, 0.0, 1.0));
            col *= clamp(0.48 + 0.52 * uSunLightFactor, 0.38, 1.05);
            if (uHasFow > 0.5 && uTitleScreen < 0.5) {
                vec2 fowUv = vec2((vWorldPos.x / uMapSize) + 0.5, 0.5 - (vWorldPos.z / uMapSize));
                if (fowUv.x >= 0.0 && fowUv.x <= 1.0 && fowUv.y >= 0.0 && fowUv.y <= 1.0) {
                    float fA = texture2D(uFowMap, fowUv).a;
                    float fowIntensity = smoothstep(0.03, 0.95, fA);
                    vec3 darkShroud = mix(col * 0.22, vec3(0.02, 0.035, 0.06), smoothstep(0.4, 0.88, fowIntensity));
                    col = mix(col, darkShroud, clamp(fowIntensity * 0.96, 0.0, 0.96));
                }
            }
            gl_FragColor = vec4(col, 1.0);
        }
    `
});

const zergBioShaderMat = new THREE.ShaderMaterial({
    uniforms: {
        uTime: { value: 0 },
        uBaseColor: { value: new THREE.Color(0x381026) },
        uVeinColor: { value: new THREE.Color(0x8c224e) },
        uPulseColor: { value: new THREE.Color(0x681a58) },
        uFowMap: { value: _fallbackFowTex },
        uHasFow: _sharedFowFlag,
        uMapSize: _sharedMapSize,
        uTitleScreen: _sharedTitleFlag,
        uSunLightFactor: _sharedSunLightFactor
    },
    vertexShader: `
        uniform float uTime;
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying vec3 vPos;
        varying vec3 vWorldPos;
        void main() {
            vPos = position;
            float throb = 1.0 + 0.026 * sin(uTime * 2.8 + position.y * 4.5 + position.x * 3.6);
            vec3 displaced = position + normal * (0.015 * sin(uTime * 3.4 + position.z * 5.2));
            vec4 worldPos = modelMatrix * vec4(displaced * throb, 1.0);
            vWorldPos = worldPos.xyz;
            vNormal = normalize(normalMatrix * normal);
            vec4 mvPosition = viewMatrix * worldPos;
            vViewPosition = -mvPosition.xyz;
            gl_Position = projectionMatrix * mvPosition;
        }
    `,
    fragmentShader: `
        uniform float uTime;
        uniform vec3 uBaseColor;
        uniform vec3 uVeinColor;
        uniform vec3 uPulseColor;
        uniform sampler2D uFowMap;
        uniform float uHasFow;
        uniform float uMapSize;
        uniform float uTitleScreen;
        uniform float uSunLightFactor;
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying vec3 vPos;
        varying vec3 vWorldPos;
        void main() {
            vec3 viewDir = normalize(vViewPosition);
            vec3 lightDir = normalize(vec3(0.45, 0.82, 0.35));
            vec3 worldNorm = normalize(vNormal);
            float sunDiff = clamp(0.38 + 0.62 * max(0.0, dot(worldNorm, lightDir)), 0.32, 1.0);
            // Subsurface translucent membrane scattering + controlled wet tissue highlight
            float rim = pow(1.0 - abs(dot(worldNorm, viewDir)), 2.6);
            vec3 halfVec = normalize(lightDir + viewDir);
            float wetSpec = pow(max(0.0, dot(worldNorm, halfVec)), 28.0) * 0.22;

            // Layered branching vascular network + fleshy nodule relief
            float v1 = 1.0 - abs(sin(vPos.x * 9.5 + sin(vPos.z * 6.0) + uTime * 1.4));
            float v2 = 1.0 - abs(cos(vPos.y * 11.0 - sin(vPos.x * 7.5) - uTime * 1.1));
            float veinMask = smoothstep(0.62, 0.94, v1 * 0.65 + v2 * 0.35);
            float nodule = smoothstep(0.35, 0.85, sin(vPos.x * 16.0) * cos(vPos.y * 16.0) * sin(vPos.z * 16.0));

            float fowIntensity = 0.0;
            if (uHasFow > 0.5 && uTitleScreen < 0.5) {
                vec2 fowUv = vec2((vWorldPos.x / uMapSize) + 0.5, 0.5 - (vWorldPos.z / uMapSize));
                if (fowUv.x >= 0.0 && fowUv.x <= 1.0 && fowUv.y >= 0.0 && fowUv.y <= 1.0) {
                    vec2 tStep = vec2(1.25 / 160.0);
                    float fA = texture2D(uFowMap, fowUv).a * 0.40
                             + texture2D(uFowMap, fowUv + vec2(tStep.x, 0.0)).a * 0.15
                             + texture2D(uFowMap, fowUv - vec2(tStep.x, 0.0)).a * 0.15
                             + texture2D(uFowMap, fowUv + vec2(0.0, tStep.y)).a * 0.15
                             + texture2D(uFowMap, fowUv - vec2(0.0, tStep.y)).a * 0.15;
                    fowIntensity = smoothstep(0.03, 0.96, fA);
                }
            }
            float activeVis = 1.0 - smoothstep(0.08, 0.65, fowIntensity);
            veinMask *= activeVis;
            rim *= activeVis;
            wetSpec *= activeVis;

            vec3 fleshBase = mix(uBaseColor, vec3(0.24, 0.06, 0.16), nodule * 0.45);
            vec3 veinMix = mix(uPulseColor, uVeinColor, 0.5 + 0.5 * sin(uTime * 2.2 + vPos.y * 3.5));
            vec3 col = mix(fleshBase * sunDiff, veinMix * (0.48 + 0.52 * sunDiff), clamp(veinMask * 0.52 + rim * 0.28, 0.0, 0.78));
            col += vec3(0.55, 0.28, 0.45) * wetSpec;
            col *= clamp(0.38 + 0.62 * uSunLightFactor, 0.30, 1.05);
            if (fowIntensity > 0.001) {
                float luma = dot(col, vec3(0.299, 0.587, 0.114));
                vec3 exploredCol = mix(col, vec3(luma) * vec3(0.42, 0.52, 0.70), 0.78) * 0.28;
                vec3 unexploredCol = vec3(0.012, 0.020, 0.036);
                vec3 targetFow = mix(exploredCol, unexploredCol, smoothstep(0.40, 0.84, fowIntensity));
                col = mix(col, targetFow, clamp(fowIntensity * 0.98, 0.0, 0.98));
            }
            gl_FragColor = vec4(col, 1.0);
        }
    `
});

const waterShaderMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    uniforms: {
        uTime: { value: 0 },
        uRainIntensity: { value: 0.0 },
        uBiomeId: { value: 0.0 },
        uFlowDir: { value: new THREE.Vector2(0.82, 0.57) },
        uRippleCenters: { value: waterRippleCenters },
        uRippleTimes: { value: waterRippleTimes },
        uRippleStrengths: { value: waterRippleStrengths },
        uFowMap: { value: _fallbackFowTex },
        uHasFow: _sharedFowFlag,
        uMapSize: _sharedMapSize,
        uTitleScreen: _sharedTitleFlag
    },
    vertexShader: `
        attribute vec3 color;
        uniform float uTime;
        uniform float uRainIntensity;
        uniform float uBiomeId;
        uniform vec2 uFlowDir;
        uniform vec2 uRippleCenters[8];
        uniform float uRippleTimes[8];
        uniform float uRippleStrengths[8];
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vViewDir;
        varying vec3 vVertColor;
        varying float vWaveHeight;
        void main() {
            vUv = uv;
            vVertColor = (dot(color, color) > 0.001) ? color : vec3(0.12, 0.36, 0.46);
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            float isOcean = step(0.6, 1.0 - abs(uBiomeId - 2.0));
            float edgeFactor = (isOcean > 0.5)
                ? clamp(1.0 - (vVertColor.g - 0.14) * 1.45, 0.0, 1.0)
                : (min(uv.y, 1.0 - uv.y) * 2.0);
            float shoreWaveMask = smoothstep(0.0, 0.26, edgeFactor);

            float flowPhase = dot(worldPosition.xz, uFlowDir) * 1.65 - uTime * 3.2;
            float h = sin(flowPhase) * cos(worldPosition.z * 1.4 - uTime * 2.1) * 0.055;
            h += sin(worldPosition.x * 3.2 - worldPosition.z * 2.8 + uTime * 4.1) * 0.028;

            for (int i = 0; i < 8; i++) {
                float age = uTime - uRippleTimes[i];
                if (age >= 0.0 && age < 3.2 && uRippleStrengths[i] > 0.01) {
                    float dist = distance(worldPosition.xz, uRippleCenters[i]);
                    float waveFront = age * 5.2;
                    float band = exp(-pow(dist - waveFront, 2.0) * 1.35);
                    float decay = max(0.0, 1.0 - age / 3.2);
                    h += sin((dist - waveFront) * 6.5) * band * decay * uRippleStrengths[i] * 0.22;
                }
            }

            h *= shoreWaveMask;
            worldPosition.y += h;
            vWorldPos = worldPosition.xyz;
            vViewDir = normalize(cameraPosition - worldPosition.xyz);
            vWaveHeight = h;
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
    `,
    fragmentShader: `
        uniform float uTime;
        uniform float uRainIntensity;
        uniform float uBiomeId;
        uniform vec2 uFlowDir;
        uniform vec2 uRippleCenters[8];
        uniform float uRippleTimes[8];
        uniform float uRippleStrengths[8];
        uniform sampler2D uFowMap;
        uniform float uHasFow;
        uniform float uMapSize;
        uniform float uTitleScreen;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vViewDir;
        varying vec3 vVertColor;
        varying float vWaveHeight;
        void main() {
            float isOcean = step(0.6, 1.0 - abs(uBiomeId - 2.0));
            float edgeFactor = (isOcean > 0.5)
                ? clamp(1.0 - (vVertColor.g - 0.14) * 1.45, 0.0, 1.0)
                : (min(vUv.y, 1.0 - vUv.y) * 2.0);
            float radialDist = clamp(1.0 - edgeFactor, 0.0, 1.0);
            vec3 col;

            if (abs(uBiomeId - 3.0) < 0.4) {
                // LAVA PLANET BIOME: Molten Magma River & Volcanic Pools with Crust Plates & Incandescent Fissures
                vec2 lavaUv1 = vWorldPos.xz * 0.28 - uFlowDir * (uTime * 0.32);
                vec2 lavaUv2 = vWorldPos.xz * 0.52 + vec2(-uFlowDir.y, uFlowDir.x) * (uTime * 0.18);
                float n1 = sin(lavaUv1.x * 5.2 + sin(lavaUv1.y * 4.6 + uTime * 1.4)) * cos(lavaUv1.y * 5.2);
                float n2 = cos(lavaUv2.x * 7.8 - lavaUv2.y * 6.4 - uTime * 1.9);
                float magmaHeat = clamp(0.52 + n1 * 0.35 + n2 * 0.28, 0.0, 1.0);
                vec3 basaltCrust = vec3(0.11, 0.05, 0.04);
                vec3 redMagma    = vec3(0.86, 0.18, 0.03);
                vec3 goldCore    = vec3(1.00, 0.76, 0.16);
                col = mix(basaltCrust, redMagma, smoothstep(0.24, 0.65, magmaHeat));
                col = mix(col, goldCore, smoothstep(0.68, 0.94, magmaHeat));
                // Scorched obsidian shoreline transition
                col = mix(col, vec3(0.08, 0.04, 0.03), smoothstep(0.76, 0.98, radialDist));
            } else {
                vec3 baseDeep = vec3(0.03, 0.19, 0.30);
                vec3 baseShallow = vec3(0.08, 0.44, 0.54);
                if (abs(uBiomeId - 2.0) < 0.4) {
                    // OCEAN PLANET: Deep sapphire abyss + vibrant turquoise shallows
                    baseDeep = vec3(0.02, 0.14, 0.34);
                    baseShallow = vec3(0.06, 0.58, 0.68);
                } else if (abs(uBiomeId - 4.0) < 0.4) {
                    // JUNGLE PLANET: Emerald botanical lagoon
                    baseDeep = vec3(0.04, 0.22, 0.18);
                    baseShallow = vec3(0.12, 0.48, 0.34);
                }
                vec3 deepCol = mix(baseDeep, vec3(0.08, 0.28, 0.22), uRainIntensity * 0.55);
                vec3 shallowCol = mix(baseShallow, vec3(0.24, 0.62, 0.32), uRainIntensity * 0.55);
                col = mix(deepCol, shallowCol, smoothstep(0.15, 0.92, radialDist));
                col = mix(col, vVertColor, smoothstep(0.45, 0.96, radialDist) * 0.65);

                vec2 flowUv1 = vWorldPos.xz * 0.42 - uFlowDir * (uTime * 0.65);
                vec2 flowUv2 = vWorldPos.xz * 0.68 + vec2(-uFlowDir.y, uFlowDir.x) * (uTime * 0.42);
                float c1 = sin(flowUv1.x * 8.0 + sin(flowUv1.y * 6.0 + uTime * 2.0)) * cos(flowUv1.y * 8.0);
                float c2 = sin(flowUv2.x * 9.5 - flowUv2.y * 7.5 + uTime * 3.1);
                float caustics = smoothstep(0.34, 0.86, abs(c1 * 0.65 + c2 * 0.45));
                vec3 causticTint = mix(vec3(0.20, 0.72, 0.88), vec3(0.52, 0.95, 0.28), uRainIntensity * 0.65);
                col += causticTint * caustics * 0.28 * (1.0 - smoothstep(0.75, 1.0, radialDist));

                if (uRainIntensity > 0.02) {
                    vec2 cell = floor(vWorldPos.xz * 1.8);
                    vec2 local = fract(vWorldPos.xz * 1.8) - 0.5;
                    float rnd = fract(sin(dot(mod(cell, 64.0), vec2(1.271, 3.117))) * 43.7585);
                    float rAge = fract(uTime * 1.9 + rnd);
                    float rDist = length(local);
                    float rRing = exp(-pow(rDist - rAge * 0.46, 2.0) * 190.0) * (1.0 - rAge);
                    col += vec3(0.58, 1.0, 0.35) * rRing * uRainIntensity * 0.85;
                }

                float rippleFoam = 0.0;
                for (int i = 0; i < 8; i++) {
                    float age = uTime - uRippleTimes[i];
                    if (age >= 0.0 && age < 3.2 && uRippleStrengths[i] > 0.01) {
                        float dist = distance(vWorldPos.xz, uRippleCenters[i]);
                        float waveFront = age * 5.2;
                        float ring = exp(-pow(dist - waveFront, 2.0) * 2.2);
                        float decay = max(0.0, 1.0 - age / 3.2);
                        rippleFoam += ring * decay * uRippleStrengths[i];
                    }
                }
                col = mix(col, vec3(0.72, 0.97, 1.0), clamp(rippleFoam * 0.85 + max(0.0, vWaveHeight * 4.5), 0.0, 0.9));

                vec3 sunDir = normalize(vec3(58.0, 96.0, 48.0));
                vec2 waveGrad = vec2(
                    cos(vWorldPos.x * 2.4 + uTime * 2.8) * 0.14,
                    sin(vWorldPos.z * 2.2 - uTime * 2.4) * 0.14
                );
                vec3 waterNormal = normalize(vec3(waveGrad.x, 1.0, waveGrad.y));
                vec3 halfVec = normalize(sunDir + normalize(vViewDir));
                float specGlint = pow(max(0.0, dot(waterNormal, halfVec)), 72.0) * (1.0 - uRainIntensity * 0.5);

                float fresnel = pow(1.0 - max(0.0, dot(waterNormal, normalize(vViewDir))), 3.0);
                vec3 skyReflCol = mix(vec3(0.42, 0.68, 0.88), vec3(0.28, 0.46, 0.36), uRainIntensity * 0.6);
                col = mix(col, skyReflCol, fresnel * 0.48 * (1.0 - smoothstep(0.75, 1.0, radialDist)));
                col += vec3(1.0, 0.95, 0.82) * specGlint * 0.85 * (1.0 - smoothstep(0.72, 1.0, radialDist));

                float waveMod = 0.025 * sin(uTime * 2.6 + vWorldPos.x * 1.9 - vWorldPos.z * 1.7);
                float foamBand = smoothstep(0.74, 0.88, radialDist + waveMod) * (1.0 - smoothstep(0.90, 0.99, radialDist));
                col = mix(col, mix(vec3(0.76, 0.90, 0.94), vVertColor * 1.25, 0.35), foamBand * 0.38);
            }

            if (uHasFow > 0.5 && uTitleScreen < 0.5) {
                vec2 fowUv = vec2((vWorldPos.x / uMapSize) + 0.5, 0.5 - (vWorldPos.z / uMapSize));
                if (fowUv.x >= 0.0 && fowUv.x <= 1.0 && fowUv.y >= 0.0 && fowUv.y <= 1.0) {
                    vec2 tStep = vec2(1.0 / 160.0);
                    float fA = texture2D(uFowMap, fowUv).a * 0.40
                             + texture2D(uFowMap, fowUv + vec2(tStep.x, 0.0)).a * 0.15
                             + texture2D(uFowMap, fowUv - vec2(tStep.x, 0.0)).a * 0.15
                             + texture2D(uFowMap, fowUv + vec2(0.0, tStep.y)).a * 0.15
                             + texture2D(uFowMap, fowUv - vec2(0.0, tStep.y)).a * 0.15;
                    float fowFactor = smoothstep(0.04, 0.96, fA);
                    float luma = dot(col, vec3(0.299, 0.587, 0.114));
                    vec3 desatWater = mix(col, vec3(luma) * vec3(0.42, 0.58, 0.78), 0.72);
                    vec3 exploredWater = desatWater * 0.42;
                    vec3 unexploredWater = mix(desatWater * 0.18, vec3(0.02, 0.038, 0.065), 0.76);
                    vec3 shroudedWater = mix(exploredWater, unexploredWater, smoothstep(0.42, 0.88, fowFactor));
                    col = mix(col, shroudedWater, clamp(fowFactor * 0.92, 0.0, 0.92));
                }
            }

            float shoreAlpha = smoothstep(0.0, 0.14, edgeFactor);
            gl_FragColor = vec4(col, 0.94 * shoreAlpha);
        }
    `
});

// Hexagonal Forcefield Energy Shield Shader for Turret Shield Domes
// Crystal-clear see-through interior so buildings & units inside are 100% visible,
// with 3D concentric shockwave ripple animation across the dome surface when hit!
const MAX_SHIELD_RIPPLES = 6;
const shieldHitPoints = Array.from({ length: MAX_SHIELD_RIPPLES }, () => new THREE.Vector3(0, -999, 0));
const shieldHitTimes = new Float32Array(MAX_SHIELD_RIPPLES).fill(-999.0);
let nextShieldRippleSlot = 0;

const shieldHexShaderMat = new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.FrontSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x00e5ff) },
        uHitPoints: { value: shieldHitPoints },
        uHitTimes: { value: shieldHitTimes }
    },
    vertexShader: `
        uniform float uTime;
        uniform vec3 uHitPoints[${MAX_SHIELD_RIPPLES}];
        uniform float uHitTimes[${MAX_SHIELD_RIPPLES}];
        varying vec3 vNormal;
        varying vec3 vViewPos;
        varying vec3 vLocalPos;
        varying vec3 vWorldPos;
        void main() {
            vLocalPos = position;
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            float disp = 0.0;
            for (int i = 0; i < ${MAX_SHIELD_RIPPLES}; i++) {
                float age = uTime - uHitTimes[i];
                if (age > 0.0 && age < 1.35) {
                    float d = distance(worldPosition.xyz, uHitPoints[i]);
                    float waveFront = age * 11.5;
                    float ring = exp(-pow(d - waveFront, 2.0) * 1.8) * (1.0 - age / 1.35);
                    disp += sin((d - waveFront) * 4.5) * ring * 0.18;
                }
            }
            vec3 displaced = position + normal * disp;
            worldPosition = modelMatrix * vec4(displaced, 1.0);
            vWorldPos = worldPosition.xyz;
            vNormal = normalize(normalMatrix * normal);
            vec4 mvPos = viewMatrix * worldPosition;
            vViewPos = -mvPos.xyz;
            gl_Position = projectionMatrix * mvPos;
        }
    `,
    fragmentShader: `
        uniform float uTime;
        uniform vec3 uColor;
        uniform vec3 uHitPoints[${MAX_SHIELD_RIPPLES}];
        uniform float uHitTimes[${MAX_SHIELD_RIPPLES}];
        varying vec3 vNormal;
        varying vec3 vViewPos;
        varying vec3 vLocalPos;
        varying vec3 vWorldPos;
        void main() {
            vec3 viewDir = normalize(vViewPos);
            float fresnel = pow(1.0 - clamp(abs(dot(vNormal, viewDir)), 0.0, 1.0), 2.85);
            float hexX = abs(sin(vLocalPos.x * 3.4 + vLocalPos.z * 1.95));
            float hexZ = abs(cos(vLocalPos.z * 3.4 - vLocalPos.y * 2.8));
            float lattice = smoothstep(0.88, 0.985, max(hexX, hexZ));
            float baseRim = smoothstep(0.0, 1.2, 1.2 - vLocalPos.y);

            // Compute concentric 3D impact ripples radiating from hit coordinates
            float hitRippleGlow = 0.0;
            for (int i = 0; i < ${MAX_SHIELD_RIPPLES}; i++) {
                float age = uTime - uHitTimes[i];
                if (age > 0.0 && age < 1.35) {
                    float fade = 1.0 - (age / 1.35);
                    float d = distance(vWorldPos, uHitPoints[i]);
                    float r1 = age * 11.5;
                    float r2 = max(0.0, (age - 0.12) * 11.5);
                    float r3 = max(0.0, (age - 0.24) * 11.5);
                    float wave1 = exp(-pow(d - r1, 2.0) * 3.2);
                    float wave2 = exp(-pow(d - r2, 2.0) * 4.0) * 0.75;
                    float wave3 = exp(-pow(d - r3, 2.0) * 4.5) * 0.5;
                    float centerFlash = exp(-d * d * 0.55) * max(0.0, 1.0 - age * 2.4);
                    hitRippleGlow += (wave1 + wave2 + wave3 + centerFlash) * fade;
                }
            }
            hitRippleGlow = clamp(hitRippleGlow, 0.0, 1.6);

            // Keep interior 98% transparent so buildings & units inside are completely visible!
            float passiveAlpha = fresnel * 0.24 + lattice * 0.055 + baseRim * 0.14;
            float rippleAlpha = hitRippleGlow * (0.48 + lattice * 0.42);
            float alpha = clamp(passiveAlpha + rippleAlpha, 0.012, 0.78);
            vec3 col = mix(uColor, vec3(0.88, 0.99, 1.0), clamp(lattice * 0.5 + fresnel * 0.4 + hitRippleGlow * 0.65, 0.0, 1.0));
            gl_FragColor = vec4(col, alpha);
        }
    `
});

window.pushShieldHitRipple = function(wx, wy, wz) {
    const t = shieldHexShaderMat.uniforms.uTime.value;
    shieldHitPoints[nextShieldRippleSlot].set(wx, wy, wz);
    shieldHitTimes[nextShieldRippleSlot] = t;
    nextShieldRippleSlot = (nextShieldRippleSlot + 1) % MAX_SHIELD_RIPPLES;
};

// Realistic Multi-Layered Domain-Warped Volumetric Cumulus/Stratus Cloud Shroud for Fog of War Overlay Mesh
const fowCloudShaderMat = new THREE.ShaderMaterial({
    uniforms: {
        uFowMap: { value: _fallbackFowTex },
        uTime: { value: 0.0 },
        uMapSize: { value: 260.0 },
        uTitleScreen: _sharedTitleFlag
    },
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
    vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorldPos;
        void main() {
            vUv = uv;
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
        }
    `,
    fragmentShader: `
        uniform sampler2D uFowMap;
        uniform float uTime;
        uniform float uMapSize;
        uniform float uTitleScreen;
        varying vec2 vUv;
        varying vec3 vWorldPos;

        float hash21(vec2 p) {
            p = fract(p * vec2(127.1, 311.7));
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
        }

        float valueNoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
            float a = hash21(i);
            float b = hash21(i + vec2(1.0, 0.0));
            float c = hash21(i + vec2(0.0, 1.0));
            float d = hash21(i + vec2(1.0, 1.0));
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        // 4-Octave Rotational FBM for realistic billowing cumulus cloud structure
        float fbmCloud(vec2 p) {
            float v = 0.0;
            float amp = 0.52;
            mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
            for (int i = 0; i < 4; i++) {
                v += amp * valueNoise(p);
                p = rot * p * 2.08 + vec2(2.3, 1.7);
                amp *= 0.48;
            }
            return v;
        }

        void main() {
            // Never darken title screen or loading/cinematic sweep with gameplay fog
            if (uTitleScreen > 0.5) discard;

            // 9-tap Gaussian-weighted Fog of War sampling for ultra-smooth organic cloud borders
            vec2 texel = vec2(1.5 / 192.0);
            float a0 = texture2D(uFowMap, vUv).a * 0.28;
            float aN = texture2D(uFowMap, vUv + vec2(0.0, texel.y)).a * 0.12;
            float aS = texture2D(uFowMap, vUv - vec2(0.0, texel.y)).a * 0.12;
            float aE = texture2D(uFowMap, vUv + vec2(texel.x, 0.0)).a * 0.12;
            float aW = texture2D(uFowMap, vUv - vec2(texel.x, 0.0)).a * 0.12;
            float aNE = texture2D(uFowMap, vUv + texel).a * 0.06;
            float aNW = texture2D(uFowMap, vUv + vec2(-texel.x, texel.y)).a * 0.06;
            float aSE = texture2D(uFowMap, vUv + vec2(texel.x, -texel.y)).a * 0.06;
            float aSW = texture2D(uFowMap, vUv - texel).a * 0.06;
            float rawFow = a0 + aN + aS + aE + aW + aNE + aNW + aSE + aSW;

            if (rawFow < 0.02) discard;

            // Domain-warped multi-altitude atmospheric cloud layers (Low stratus + High billowing cumulus)
            vec2 baseUv = vWorldPos.xz * 0.028;
            vec2 windLow = vec2(uTime * 0.014, -uTime * 0.010);
            vec2 windHigh = vec2(-uTime * 0.009, uTime * 0.016);

            vec2 q = vec2(
                fbmCloud(baseUv + windLow),
                fbmCloud(baseUv + vec2(5.2, 1.3) - windLow * 0.8)
            );
            float cumulus = fbmCloud(baseUv * 1.45 + q * 1.65 + windHigh);
            float wispyStratus = fbmCloud(baseUv * 2.85 - q * 0.95 + windLow * 1.4);
            float billow = clamp(cumulus * 0.68 + wispyStratus * 0.32, 0.0, 1.0);

            // Pseudo-3D cloud normal gradient for realistic directional sun/moon lighting on cloud puffs
            float dCloudX = fbmCloud(baseUv * 1.45 + vec2(0.08, 0.0) + q * 1.65 + windHigh) - cumulus;
            float dCloudZ = fbmCloud(baseUv * 1.45 + vec2(0.0, 0.08) + q * 1.65 + windHigh) - cumulus;
            float cloudLit = clamp(0.55 + (dCloudX * 3.8 - dCloudZ * 3.2), 0.0, 1.0);

            // Feathered, billowing cloud-bank edge along the line-of-sight boundary
            float edgeBand = 4.0 * rawFow * (1.0 - rawFow);
            float softFow = smoothstep(0.08, 0.94, rawFow + (billow - 0.48) * 0.24 * edgeBand);

            // Subtle atmospheric mist palette so underlying biome terrain colors remain recognizable
            vec3 cloudShadowBase = vec3(0.14, 0.20, 0.30);
            vec3 cloudMidBody    = vec3(0.22, 0.31, 0.44);
            vec3 cloudSilverCrest = vec3(0.34, 0.46, 0.62);

            vec3 cloudCol = mix(cloudShadowBase, cloudMidBody, smoothstep(0.22, 0.72, billow));
            cloudCol = mix(cloudCol, cloudSilverCrest, smoothstep(0.52, 0.92, billow * 0.65 + cloudLit * 0.45) * (0.42 + edgeBand * 0.58));

            float puffDensity = mix(0.60, 1.05, smoothstep(0.25, 0.85, billow));
            // Explored areas (rawFow ~ 0.50) get a subtle memory mist; unexplored areas get a denser shroud veil
            float unexploredWeight = smoothstep(0.58, 0.90, rawFow);
            float exploredWeight = smoothstep(0.12, 0.48, rawFow) * (1.0 - unexploredWeight);
            float finalAlpha = clamp((exploredWeight * 0.14 + unexploredWeight * 0.42) * puffDensity, 0.0, 0.46);
            gl_FragColor = vec4(cloudCol, finalAlpha);
        }
    `
});

// Procedural Layered Biological Zerg Creep Texture (Dark Purple & Muted Burgundy Tissue, Vascular Veins, Translucent Membranes & Fleshy Nodules)
const creepOverlayTex = makeProceduralTexture((ctx, w, h) => {
    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;
    const twoPi = Math.PI * 2;
    for (let y = 0; y < h; y++) {
        const ny = (y / h) * twoPi;
        for (let x = 0; x < w; x++) {
            const nx = (x / w) * twoPi;
            // Domain-warped organic tissue folds & branching vascular root tendrils
            const warpX = nx + 0.78 * Math.sin(ny * 2.0 + Math.cos(nx * 1.0)) + 0.38 * Math.cos(ny * 3.0 - nx);
            const warpY = ny + 0.78 * Math.cos(nx * 2.0 - Math.sin(ny * 1.0)) + 0.38 * Math.sin(nx * 3.0 + ny);

            // Vascular vein ridge network (1.0 - abs(sin)) creates crisp branching arterial roots
            const veinBranch1 = Math.pow(1.0 - Math.abs(Math.sin(warpX * 2.0 + Math.cos(warpY * 2.0))), 3.5);
            const veinBranch2 = Math.pow(1.0 - Math.abs(Math.cos(warpY * 3.0 - Math.sin(warpX * 2.0))), 4.0);
            const vascularVein = Math.min(1.0, veinBranch1 * 0.75 + veinBranch2 * 0.55);

            // Fleshy nodule clusters & translucent membrane pockets
            const membraneFold = Math.sin(warpX * 2.0 + Math.sin(warpY * 2.0)) * 0.5 + 0.5;
            const noduleCell = Math.pow(Math.max(0, Math.sin(warpX * 5.0) * Math.cos(warpY * 5.0)), 2.4);
            const controlledWet = Math.pow(Math.max(0, Math.sin(warpX * 3.0 + warpY * 2.0)), 4.5) * 0.16;

            const idx = (y * w + x) * 4;
            // Deep organic burgundy & dark purple palette (zero plastic neon glare)
            const r = 24 + membraneFold * 30 + vascularVein * 58 + noduleCell * 28 + controlledWet * 32;
            const g = 5  + membraneFold * 7  + vascularVein * 11 + noduleCell * 8  + controlledWet * 12;
            const b = 32 + membraneFold * 36 + vascularVein * 44 + noduleCell * 24 + controlledWet * 36;
            data[idx]     = Math.min(255, Math.round(r));
            data[idx + 1] = Math.min(255, Math.round(g));
            data[idx + 2] = Math.min(255, Math.round(b));
            data[idx + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);
}, 1, 1, 'creepOverlayTex', 128);
window.creepOverlayTex = creepOverlayTex;

const MAX_CREEP_SHADER_NODES = 8;
const _defaultCreepNodes = Array.from({ length: MAX_CREEP_SHADER_NODES }, () => new THREE.Vector3(-9999, -9999, 0));

// Centralized Shader Engine with Custom Vertex Lighting, Shadow Map & Texture-Blending FoW Shader Injection
const SHADER_ENGINE = {
    shieldShaderMat: shieldHexShaderMat,
    fowCloudShaderMat: fowCloudShaderMat,
    safeFallbackMode: false,
    terrainShaderStage: 4, // 0 = Plain MeshStandardMaterial, 1 = +DetailTex, 2 = +Lighting/Normal, 3 = +TerrainShader(no FOW), 4 = Full Shader + FOW
    enhancedMaterials: new Set(),
    terrainUniforms: {
        uTime: { value: 0 },
        uWetness: { value: 0.0 },
        uAcidRain: { value: 0.0 },
        uFogBoost: { value: 0.0 },
        uBiomeId: { value: 0.0 },
        uFowMap: { value: _fallbackFowTex },
        uHasFow: _sharedFowFlag,
        uUseFow: _sharedFowFlag,
        uMapSize: _sharedMapSize,
        uTitleScreen: _sharedTitleFlag,
        uSunLightFactor: _sharedSunLightFactor,
        uShaderStage: { value: 4.0 },
        uFowDebugMode: { value: 0.0 },
        uCreepCenter: { value: new THREE.Vector2(-74.0, -74.0) },
        uCreepRadius: { value: 0.0 },
        uCreepNodes: { value: _defaultCreepNodes },
        uCreepTex: { value: creepOverlayTex }
    },
    enableSafeMaterialFallbacks(reason = 'Shader compilation fallback') {
        if (this.safeFallbackMode) return;
        this.safeFallbackMode = true;
        if (typeof GRAPHICS_DIAGNOSTICS !== 'undefined') {
            GRAPHICS_DIAGNOSTICS.shaderValidation.fallbackMaterialsUsed++;
        }
        this.enhancedMaterials.forEach(mat => {
            if (mat) {
                mat.onBeforeCompile = () => {};
                mat._hasEnhancedShader = false;
                mat.customProgramCacheKey = () => 'safe_standard_fallback';
                mat.needsUpdate = true;
            }
        });
        if (window.terrainMat) {
            window.terrainMat.onBeforeCompile = () => {};
            window.terrainMat._hasEnhancedShader = false;
            window.terrainMat.color.setHex(0xffffff);
            window.terrainMat.vertexColors = true;
            window.terrainMat.customProgramCacheKey = () => 'safe_terrain_standard_fallback';
            window.terrainMat.needsUpdate = true;
        }
    },
    setTerrainShaderStage(stage = 4) {
        const s = Math.max(0, Math.min(4, Number(stage) || 0));
        this.terrainShaderStage = s;
        this.terrainUniforms.uShaderStage.value = s;
        if (window.terrainMat) {
            const tm = window.terrainMat;
            tm.color.setHex(0xffffff);
            tm.vertexColors = true;
            if (s === 0) {
                // Stage 0: Plain MeshStandardMaterial with neutral base color, vertex colors, no custom shader injection, no FOW
                tm.map = null;
                tm.normalMap = null;
                tm.onBeforeCompile = () => {};
                tm._hasEnhancedShader = false;
                tm.customProgramCacheKey = () => 'terrain_stage_0_plain';
                if (typeof fowMesh !== 'undefined' && fowMesh) fowMesh.visible = false;
            } else {
                tm.map = (s >= 1 && window.terrainDetailTex) ? window.terrainDetailTex : null;
                tm.normalMap = (s >= 2 && window.terrainNormalTex) ? window.terrainNormalTex : null;
                if (s >= 3) {
                    tm._hasEnhancedShader = false;
                    tm.customProgramCacheKey = () => `terrain_stage_${s}`;
                    this.enhanceTerrainMaterial(tm, false, false);
                } else {
                    tm.onBeforeCompile = () => {};
                    tm._hasEnhancedShader = false;
                    tm.customProgramCacheKey = () => `terrain_stage_${s}`;
                }
                if (typeof fowMesh !== 'undefined' && fowMesh) fowMesh.visible = (s >= 4);
            }
            tm.needsUpdate = true;
        }
        return s;
    },
    setBiomeId(biomeId = 0.0) {
        this.terrainUniforms.uBiomeId.value = biomeId;
        if (waterShaderMat && waterShaderMat.uniforms && waterShaderMat.uniforms.uBiomeId) {
            waterShaderMat.uniforms.uBiomeId.value = biomeId;
        }
    },
    setFogOfWarTexture(tex, mapSize = 260.0) {
        if (tex && tex.isTexture) {
            this.terrainUniforms.uFowMap.value = tex;
            fowCloudShaderMat.uniforms.uFowMap.value = tex;
            waterShaderMat.uniforms.uFowMap.value = tex;
            plasmaShaderMat.uniforms.uFowMap.value = tex;
            zergBioShaderMat.uniforms.uFowMap.value = tex;
            _sharedFowFlag.value = 1.0;
        } else {
            this.terrainUniforms.uFowMap.value = _fallbackFowTex;
            fowCloudShaderMat.uniforms.uFowMap.value = _fallbackFowTex;
            waterShaderMat.uniforms.uFowMap.value = _fallbackFowTex;
            plasmaShaderMat.uniforms.uFowMap.value = _fallbackFowTex;
            zergBioShaderMat.uniforms.uFowMap.value = _fallbackFowTex;
            _sharedFowFlag.value = 0.0;
        }
        _sharedMapSize.value = mapSize;
        this.terrainUniforms.uMapSize.value = mapSize;
        fowCloudShaderMat.uniforms.uMapSize.value = mapSize;
        waterShaderMat.uniforms.uMapSize.value = mapSize;
    },
    setFowTexture(tex, mapSize = 260.0) {
        this.setFogOfWarTexture(tex, mapSize);
    },
    setZergCreepUniforms(cx, cz, radius, extraNodes = null) {
        this.terrainUniforms.uCreepCenter.value.set(cx, cz);
        this.terrainUniforms.uCreepRadius.value = Math.max(0.0, radius);
        const nodesArr = this.terrainUniforms.uCreepNodes.value;
        nodesArr[0].set(cx, cz, Math.max(0.0, radius));
        for (let i = 1; i < MAX_CREEP_SHADER_NODES; i++) {
            if (Array.isArray(extraNodes) && extraNodes[i - 1]) {
                const n = extraNodes[i - 1];
                nodesArr[i].set(n.x, n.z, Math.max(0.0, n.r || 9.5));
            } else {
                nodesArr[i].set(-9999, -9999, 0.0);
            }
        }
    },
    applyTerrainShader(material, isRoadMaterial = false) {
        this.enhanceTerrainMaterial(material, isRoadMaterial, false);
    },
    applyRoadShader(material) {
        this.enhanceTerrainMaterial(material, true, false);
    },
    applyBuildingShader(material) {
        this.enhanceTerrainMaterial(material, false, true);
    },
    enhanceTerrainMaterial(material, isRoadMaterial = false, isBuildingMaterial = false) {
        if (!material || material.isShaderMaterial || material.type === 'ShaderMaterial' || material._hasEnhancedShader || this.safeFallbackMode) return;
        material._hasEnhancedShader = true;
        this.enhancedMaterials.add(material);
        if (!material.userData) material.userData = {};
        material.userData.fowEnhanced = true;
        material.userData.terrainEnhanced = true;
        const isMeadowGrass = !!(material.userData && material.userData.isMeadowGrass);
        material.onBeforeCompile = (shader) => {
            if (this.safeFallbackMode) return;
            if (shader.fragmentShader.includes('uniform sampler2D uFowMap;') || shader.vertexShader.includes('varying vec3 vCustomWorldPos;')) {
                return;
            }
            // Validate all required shader injection points before modifying shader code.
            const reqVertexAnchors = ['#include <begin_vertex>', '#include <worldpos_vertex>'];
            const reqFragAnchors = [
                '#include <color_fragment>',
                '#include <roughnessmap_fragment>',
                '#include <emissivemap_fragment>',
                '#include <dithering_fragment>'
            ];
            const missingAnchors = [];
            for (let i = 0; i < reqVertexAnchors.length; i++) {
                if (!shader.vertexShader.includes(reqVertexAnchors[i])) missingAnchors.push(`vertex:${reqVertexAnchors[i]}`);
            }
            for (let i = 0; i < reqFragAnchors.length; i++) {
                if (!shader.fragmentShader.includes(reqFragAnchors[i])) missingAnchors.push(`fragment:${reqFragAnchors[i]}`);
            }
            if (missingAnchors.length > 0) {
                if (typeof GRAPHICS_DIAGNOSTICS !== 'undefined') {
                    GRAPHICS_DIAGNOSTICS.recordShaderInjectionFailure(material.name || (isRoadMaterial ? 'RoadMaterial' : (isBuildingMaterial ? 'BuildingMaterial' : 'TerrainMaterial')), missingAnchors);
                }
                return;
            }
            if (typeof GRAPHICS_DIAGNOSTICS !== 'undefined') {
                GRAPHICS_DIAGNOSTICS.shaderValidation.validatedCount++;
                GRAPHICS_DIAGNOSTICS.shaderValidation.lastValidatedAt = new Date().toISOString();
            }

            shader.uniforms.uTime = this.terrainUniforms.uTime;
            shader.uniforms.uWetness = this.terrainUniforms.uWetness;
            shader.uniforms.uAcidRain = this.terrainUniforms.uAcidRain;
            shader.uniforms.uFogBoost = this.terrainUniforms.uFogBoost;
            shader.uniforms.uBiomeId = this.terrainUniforms.uBiomeId;
            shader.uniforms.uFowMap = this.terrainUniforms.uFowMap;
            shader.uniforms.uHasFow = this.terrainUniforms.uHasFow;
            shader.uniforms.uMapSize = this.terrainUniforms.uMapSize;
            shader.uniforms.uTitleScreen = this.terrainUniforms.uTitleScreen;
            shader.uniforms.uSunLightFactor = this.terrainUniforms.uSunLightFactor;
            shader.uniforms.uShaderStage = this.terrainUniforms.uShaderStage;
            shader.uniforms.uFowDebugMode = this.terrainUniforms.uFowDebugMode;
            shader.uniforms.uCreepCenter = this.terrainUniforms.uCreepCenter;
            shader.uniforms.uCreepRadius = this.terrainUniforms.uCreepRadius;
            shader.uniforms.uCreepNodes = this.terrainUniforms.uCreepNodes;
            shader.uniforms.uCreepTex = this.terrainUniforms.uCreepTex;
            shader.uniforms.uIsRoad = { value: isRoadMaterial ? 1.0 : 0.0 };
            shader.uniforms.uIsBuilding = { value: isBuildingMaterial ? 1.0 : 0.0 };
            shader.uniforms.uIsGrass = { value: isMeadowGrass ? 1.0 : 0.0 };

            shader.vertexShader = `
                uniform float uTime;
                uniform float uIsBuilding;
                uniform float uIsGrass;
                uniform float uSunLightFactor;
                uniform vec2 uCreepCenter;
                uniform float uCreepRadius;
                uniform vec3 uCreepNodes[${MAX_CREEP_SHADER_NODES}];
                varying vec3 vCustomWorldPos;
                varying vec3 vCustomWorldNormal;
                varying vec3 vVertexLighting;
            ` + shader.vertexShader.replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
                if (uIsGrass > 0.5 && position.y > 0.02) {
                    float bendFactor = clamp(position.y * 2.4, 0.0, 1.5);
                    float swayX = sin(uTime * 2.6 + position.x * 6.0 + position.z * 6.0) * 0.055 * bendFactor;
                    float swayZ = cos(uTime * 2.1 - position.z * 5.0 + position.x * 4.0) * 0.045 * bendFactor;
                    transformed.x += swayX;
                    transformed.z += swayZ;
                }`
            ).replace(
                '#include <worldpos_vertex>',
                `#include <worldpos_vertex>
                vec4 customWp = modelMatrix * vec4(transformed, 1.0);
                #ifdef USE_INSTANCING
                    customWp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
                #endif
                // Automatically collapse 3D meadow grass blades when taken over by Zerg Creep network!
                if (uIsGrass > 0.5 && uCreepRadius > 0.5) {
                    float minSignedDist = 999.0;
                    for (int cn = 0; cn < ${MAX_CREEP_SHADER_NODES}; cn++) {
                        vec3 cNode = uCreepNodes[cn];
                        if (cNode.z > 0.5) {
                            float dN = distance(customWp.xz, cNode.xy) - cNode.z;
                            minSignedDist = min(minSignedDist, dN);
                        }
                    }
                    if (minSignedDist < 1.15) {
                        transformed *= 0.0;
                        transformed.y = -20.0;
                        customWp.y = -20.0;
                        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                    }
                }
                vCustomWorldPos = customWp.xyz;
                vec3 safeObjNormal = vec3(0.0, 1.0, 0.0);
                #ifndef FLAT_SHADED
                    safeObjNormal = vec3(objectNormal);
                #endif
                vec3 rawN = mat3(modelMatrix) * safeObjNormal;
                #ifdef USE_INSTANCING
                    rawN = mat3(modelMatrix) * mat3(instanceMatrix) * safeObjNormal;
                #endif
                float nLen = length(rawN);
                vec3 safeWNormal = nLen > 1e-4 ? (rawN / nLen) : vec3(0.0, 1.0, 0.0);
                vCustomWorldNormal = safeWNormal;

                vec3 sunDirV = normalize(vec3(58.0, 96.0, 48.0));
                float nDotL = max(0.0, dot(safeWNormal, sunDirV));
                float hemiMix = safeWNormal.y * 0.5 + 0.5;
                vec3 hemiCol = mix(vec3(0.66, 0.72, 0.80), vec3(0.96, 0.98, 1.0), hemiMix);
                float aoHeight = uIsBuilding > 0.5 ? clamp(0.86 + customWp.y * 0.08, 0.86, 1.0) : 1.0;
                float sunScale = clamp(uSunLightFactor, 0.55, 1.15);
                vVertexLighting = clamp((hemiCol * (0.68 * sunScale) + vec3(0.42, 0.40, 0.38) * nDotL * sunScale) * aoHeight, vec3(0.68), vec3(1.05));`
            );

            shader.fragmentShader = `
                uniform float uTime;
                uniform float uWetness;
                uniform float uAcidRain;
                uniform float uFogBoost;
                uniform float uBiomeId;
                uniform sampler2D uFowMap;
                uniform float uHasFow;
                uniform float uMapSize;
                uniform float uTitleScreen;
                uniform float uSunLightFactor;
                uniform float uShaderStage;
                uniform float uFowDebugMode;
                uniform vec2 uCreepCenter;
                uniform float uCreepRadius;
                uniform vec3 uCreepNodes[${MAX_CREEP_SHADER_NODES}];
                uniform sampler2D uCreepTex;
                uniform float uIsRoad;
                uniform float uIsBuilding;
                uniform float uIsGrass;
                varying vec3 vCustomWorldPos;
                varying vec3 vCustomWorldNormal;
                varying vec3 vVertexLighting;
            ` + shader.fragmentShader.replace(
                '#include <color_fragment>',
                `#include <color_fragment>
                float lavaFissureGlow = 0.0;
                if (uIsGrass > 0.5 && uCreepRadius > 0.5) {
                    float minGDist = 999.0;
                    for (int cn = 0; cn < ${MAX_CREEP_SHADER_NODES}; cn++) {
                        vec3 cNode = uCreepNodes[cn];
                        if (cNode.z > 0.5) {
                            minGDist = min(minGDist, distance(vCustomWorldPos.xz, cNode.xy) - cNode.z);
                        }
                    }
                    if (minGDist < 1.15) {
                        discard;
                    }
                }

                // 0. Apply Per-Vertex AO, Directional Sun & Day/Night Shading without over-darkening metallic Terran armor!
                diffuseColor.rgb *= mix(vec3(1.0), vVertexLighting, uIsBuilding > 0.5 ? 0.18 : 0.26);

                // 1. Subtle wind-swept cloud shadow & botanical meadow shimmer
                float cloudWave = 0.95 + 0.05 * sin(vCustomWorldPos.x * 0.055 + uTime * 0.42) * cos(vCustomWorldPos.z * 0.055 - uTime * 0.31);
                diffuseColor.rgb *= mix(1.0, cloudWave, 1.0 - uIsBuilding * 0.75);

                // 2. Procedural tri-planar sedimentary rock strata + volcanic lava fissures on Lava Planet
                float terrainOnly = clamp(1.0 - uIsRoad - uIsBuilding - uIsGrass, 0.0, 1.0);
                float slopeFactor = clamp((1.0 - abs(vCustomWorldNormal.y)) * 2.8, 0.0, 1.0) * terrainOnly;
                if (slopeFactor > 0.10) {
                    float strataLayer = sin(vCustomWorldPos.y * 5.6 + sin(vCustomWorldPos.x * 0.75 + vCustomWorldPos.z * 0.65) * 1.5);
                    float fracture = cos(vCustomWorldPos.x * 2.8 - vCustomWorldPos.y * 3.2) * sin(vCustomWorldPos.z * 2.6 + vCustomWorldPos.y * 2.9);
                    float rockCreviceAO = smoothstep(-0.85, 0.45, strataLayer * 0.65 + fracture * 0.35);
                    vec3 rockWarmTint = mix(vec3(0.68, 0.70, 0.74), vec3(1.06, 1.03, 0.98), rockCreviceAO);
                    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * rockWarmTint, slopeFactor * 0.76);
                }
                if (abs(uBiomeId - 3.0) < 0.4 && terrainOnly > 0.5 && vCustomWorldPos.y < 2.2) {
                    // Lava Planet glowing ground cracks in low volcanic ash basins
                    float crack1 = 1.0 - abs(sin(vCustomWorldPos.x * 0.85 + sin(vCustomWorldPos.z * 0.65) * 1.8));
                    float crack2 = 1.0 - abs(cos(vCustomWorldPos.z * 0.92 - cos(vCustomWorldPos.x * 0.72) * 1.6));
                    float lavaCrack = smoothstep(0.90, 0.992, crack1 * crack2);
                    float pulse = 0.78 + 0.22 * sin(uTime * 2.4 + vCustomWorldPos.x * 0.5);
                    lavaFissureGlow = lavaCrack * pulse;
                    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.42, 0.06) * pulse, lavaCrack * 0.85);
                }
                if (uIsGrass > 0.5) {
                    float grassTip = clamp(vCustomWorldPos.y * 1.6, 0.0, 1.0);
                    diffuseColor.rgb *= mix(0.76, 1.12, grassTip);
                }

                // 3. Dynamic Acid Rain Wetness Sheen
                if (uWetness > 0.01) {
                    diffuseColor.rgb *= (1.0 - uWetness * (0.12 * (1.0 - uIsBuilding * 0.65)));
                    diffuseColor.rgb += vec3(0.01, 0.04, 0.01) * uAcidRain * uWetness * (1.0 - uIsRoad * 0.65 - uIsBuilding * 0.75);
                }

                // 4. Micro-aggregate asphalt grain on roads (mediump-safe hash math)
                if (uIsRoad > 0.5) {
                    vec2 roadCell = mod(floor(vCustomWorldPos.xz * 14.0), 64.0);
                    float grain = 0.94 + 0.06 * fract(sin(dot(roadCell, vec2(1.29898, 7.8233))) * 43.7585);
                    diffuseColor.rgb *= grain * 0.90;
                } else if (uIsBuilding < 0.5) {
                    float windGust = sin(vCustomWorldPos.x * 0.11 + vCustomWorldPos.z * 0.08 + uTime * 2.6) * 
                                     cos(vCustomWorldPos.x * 0.05 - vCustomWorldPos.z * 0.10 + uTime * 1.8);
                    diffuseColor.rgb *= (0.96 + 0.04 * windGust);
                }

                // 5. Organic Zerg Creep Biomass Membrane (Terrain-conforming, organic tendrils & veins, zero grid artifacts)
                float creepWetnessBoost = 0.0;
                float creepPulseGlow = 0.0;
                if (uIsBuilding < 0.5 && uIsGrass < 0.5 && uCreepRadius > 0.5) {
                    float creepField = 0.0;
                    float minCreepSignedDist = 999.0;
                    for (int cn = 0; cn < ${MAX_CREEP_SHADER_NODES}; cn++) {
                        vec3 cNode = uCreepNodes[cn];
                        if (cNode.z > 0.5) {
                            float d = distance(vCustomWorldPos.xz, cNode.xy);
                            float normD = d / max(1.0, cNode.z);
                            minCreepSignedDist = min(minCreepSignedDist, d - cNode.z);
                            if (normD < 1.38) {
                                float falloff = clamp(1.0 - normD * 0.78, 0.0, 1.0);
                                creepField += falloff * falloff * (3.0 - 2.0 * falloff);
                            }
                        }
                    }
                    if (creepField > 0.02 || minCreepSignedDist < 4.5) {
                        // Organic domain-warped UV coordinates (no grid lines)
                        vec2 warpOffset = vec2(
                            sin(vCustomWorldPos.z * 0.23 + uTime * 0.65) + cos(vCustomWorldPos.x * 0.17 - uTime * 0.45),
                            cos(vCustomWorldPos.x * 0.21 - uTime * 0.55) - sin(vCustomWorldPos.z * 0.19 + uTime * 0.50)
                        ) * 0.045;
                        vec2 creepUv1 = vCustomWorldPos.xz * 0.072 + warpOffset;
                        vec2 creepUv2 = vec2(
                            vCustomWorldPos.x * 0.051 - vCustomWorldPos.z * 0.064,
                            vCustomWorldPos.x * 0.064 + vCustomWorldPos.z * 0.051
                        ) - warpOffset * 0.75 + vec2(uTime * 0.012, -uTime * 0.009);
                        vec3 cSample1 = texture2D(uCreepTex, creepUv1).rgb;
                        vec3 cSample2 = texture2D(uCreepTex, creepUv2).rgb;
                        float bioNoise = dot(cSample1, vec3(0.45, 0.35, 0.20)) * 0.6 + dot(cSample2, vec3(0.30, 0.50, 0.20)) * 0.4;
                        float edgeDistort = (bioNoise - 0.48) * 4.2 + sin(atan(vCustomWorldPos.z - uCreepCenter.y, vCustomWorldPos.x - uCreepCenter.x) * 7.0 + bioNoise * 6.0) * 1.15;
                        float effectiveSignedDist = minCreepSignedDist - edgeDistort;
                        float creepMask = 1.0 - smoothstep(-2.4, 1.35, effectiveSignedDist);
                        // Keep creep above deep water level while conforming to slopes & hills
                        float waterCutoff = smoothstep(-0.32, 0.05, vCustomWorldPos.y);
                        creepMask *= waterCutoff;
                        if (creepMask > 0.01) {
                            float veinPattern = smoothstep(0.42, 0.76, abs(cSample1.r - cSample2.g) * 1.85 + cSample1.b * 0.45);
                            float peristalsis = 0.5 + 0.5 * sin(minCreepSignedDist * 0.85 - uTime * 2.3 + bioNoise * 5.0);
                            float edgeTendril = smoothstep(0.05, 0.45, creepMask) * (1.0 - smoothstep(0.68, 0.98, creepMask));
                            vec3 deepBiomass = vec3(0.19, 0.045, 0.24);
                            vec3 midMembrane = vec3(0.34, 0.08, 0.39);
                            vec3 arterialVein = vec3(0.56, 0.13, 0.49);
                            vec3 pustuleGlow = vec3(0.74, 0.22, 0.64);
                            vec3 creepCol = mix(deepBiomass, midMembrane, clamp(bioNoise * 1.35, 0.0, 1.0));
                            creepCol = mix(creepCol, arterialVein, veinPattern * (0.65 + 0.35 * peristalsis));
                            creepCol += pustuleGlow * (veinPattern * peristalsis * 0.22 + edgeTendril * 0.18);
                            diffuseColor.rgb = mix(diffuseColor.rgb, creepCol, creepMask * 0.90);
                            creepWetnessBoost = creepMask;
                            creepPulseGlow = creepMask * veinPattern * peristalsis;
                        }
                    }
                }`
            ).replace(
                '#include <roughnessmap_fragment>',
                `#include <roughnessmap_fragment>
                float creepFowVis = 1.0;
                if (uHasFow > 0.5 && uTitleScreen < 0.5) {
                    vec2 rFowUv = vec2((vCustomWorldPos.x / uMapSize) + 0.5, 0.5 - (vCustomWorldPos.z / uMapSize));
                    if (rFowUv.x >= 0.0 && rFowUv.x <= 1.0 && rFowUv.y >= 0.0 && rFowUv.y <= 1.0) {
                        creepFowVis = 1.0 - smoothstep(0.10, 0.75, texture2D(uFowMap, rFowUv).a);
                    }
                }
                if (uIsRoad > 0.5) {
                    roughnessFactor = mix(0.92, 0.22, creepWetnessBoost * creepFowVis * 0.82);
                } else {
                    roughnessFactor = mix(roughnessFactor, 0.34, uWetness * 0.55);
                    if (creepWetnessBoost > 0.01) {
                        roughnessFactor = mix(0.92, 0.16, creepWetnessBoost * creepFowVis * 0.88);
                    }
                }`
            ).replace(
                '#include <emissivemap_fragment>',
                `#include <emissivemap_fragment>
                totalEmissiveRadiance *= clamp(0.55 + 0.45 * uSunLightFactor, 0.50, 1.0);
                if (lavaFissureGlow > 0.01) {
                    totalEmissiveRadiance += vec3(1.0, 0.36, 0.04) * (lavaFissureGlow * 0.65);
                }
                if (creepPulseGlow > 0.01) {
                    totalEmissiveRadiance += vec3(0.46, 0.09, 0.42) * (creepPulseGlow * 0.42);
                }
                if (uHasFow > 0.5 && uTitleScreen < 0.5) {
                    vec2 eFowUv = vec2((vCustomWorldPos.x / uMapSize) + 0.5, 0.5 - (vCustomWorldPos.z / uMapSize));
                    if (eFowUv.x >= 0.0 && eFowUv.x <= 1.0 && eFowUv.y >= 0.0 && eFowUv.y <= 1.0) {
                        float eFa = texture2D(uFowMap, eFowUv).a;
                        // Keep lava fissures & emissive terrain clearly visible (retain >= 72% emissive radiance in fog)
                        totalEmissiveRadiance *= (1.0 - smoothstep(0.10, 0.85, eFa) * 0.28);
                    }
                }`
            ).replace(
                '#include <dithering_fragment>',
                `#include <dithering_fragment>
                // 6. Three-State Fog of War & Seamless Out-of-Bounds Horizon Shroud
                //    State 0 (Visible, fA < 0.12): 100% biome & structure lighting
                //    State 1 (Explored, fA ~ 0.45..0.60): Darkened cool memory state (~0.40 brightness)
                //    State 2 (Unexplored / Out-of-Bounds, fA > 0.80): Deep shroud (~0.13 brightness) with biome horizon blend
                if (uHasFow > 0.5 && uTitleScreen < 0.5 && uShaderStage > 3.5) {
                    vec2 fowUv = vec2((vCustomWorldPos.x / uMapSize) + 0.5, 0.5 - (vCustomWorldPos.z / uMapSize));
                    vec2 clampedUv = clamp(fowUv, vec2(0.004), vec2(0.996));
                    vec2 oobDelta = max(vec2(0.0), abs(fowUv - vec2(0.5)) - vec2(0.492));
                    float oobDist = length(oobDelta) * uMapSize;
                    float oobWeight = clamp(oobDist / 28.0, 0.0, 1.0);

                    vec2 tStep = vec2(1.25 / 160.0);
                    float fA = texture2D(uFowMap, clampedUv).a * 0.40
                             + texture2D(uFowMap, clamp(clampedUv + vec2(tStep.x, 0.0), vec2(0.002), vec2(0.998))).a * 0.15
                             + texture2D(uFowMap, clamp(clampedUv - vec2(tStep.x, 0.0), vec2(0.002), vec2(0.998))).a * 0.15
                             + texture2D(uFowMap, clamp(clampedUv + vec2(0.0, tStep.y), vec2(0.002), vec2(0.998))).a * 0.15
                             + texture2D(uFowMap, clamp(clampedUv - vec2(0.0, tStep.y), vec2(0.002), vec2(0.998))).a * 0.15;
                    fA = mix(fA, 0.96, oobWeight);

                    float fowIntensity = smoothstep(0.05, 0.92, fA);
                    vec3 baseCol = gl_FragColor.rgb;
                    float texLuma = dot(baseCol, vec3(0.299, 0.587, 0.114));
                    vec3 coolTint = mix(baseCol, vec3(texLuma) * vec3(0.68, 0.78, 0.94), 0.45);

                    // Explored memory state: clearly darkened (40% terrain, 36% static structures) so active vision stands out
                    vec3 exploredCol = coolTint * (uIsBuilding > 0.5 ? 0.36 : 0.40);
                    // Unexplored shroud state: deep tactical darkness while keeping faint terrain contour silhouette
                    vec3 fogAtmosphere = vec3(0.045, 0.065, 0.105);
                    if (uBiomeId > 3.5) fogAtmosphere = vec3(0.08, 0.035, 0.025);
                    else if (uBiomeId > 2.5) fogAtmosphere = vec3(0.035, 0.065, 0.095);
                    else if (uBiomeId > 1.5) fogAtmosphere = vec3(0.035, 0.065, 0.055);
                    else if (uBiomeId > 0.5) fogAtmosphere = vec3(0.075, 0.055, 0.040);

                    vec3 unexploredCol = mix(coolTint * 0.14, fogAtmosphere, 0.68);
                    float exploredBand = smoothstep(0.08, 0.46, fowIntensity);
                    float unexploredBand = smoothstep(0.60, 0.88, fowIntensity);

                    vec3 afterExplored = mix(baseCol, exploredCol, exploredBand);
                    vec3 finalFowCol = mix(afterExplored, unexploredCol, unexploredBand);

                    // Subtle rim highlight along active vision perimeter
                    float visionEdge = 4.0 * exploredBand * (1.0 - exploredBand);
                    finalFowCol += vec3(0.04, 0.08, 0.14) * visionEdge * (0.35 + 0.65 * texLuma);

                    // Far out-of-bounds horizon fade so distant skirt blends smoothly into biome skybox horizon
                    float farHorizonFade = smoothstep(26.0, 210.0, oobDist);
                    finalFowCol = mix(finalFowCol, fogAtmosphere * 0.85, farHorizonFade);

                    if (uFowDebugMode > 0.5) {
                        // Explicit FOW Debug Visualization: Green = Visible, Cyan = Explored, Deep Red/Purple = Unexplored
                        vec3 dbgVis = mix(baseCol, vec3(0.15, 0.95, 0.35), 0.35);
                        vec3 dbgExp = mix(exploredCol, vec3(0.12, 0.58, 0.96), 0.48);
                        vec3 dbgUnexp = mix(unexploredCol, vec3(0.45, 0.06, 0.28), 0.55);
                        vec3 dbgCol = mix(dbgVis, dbgExp, exploredBand);
                        dbgCol = mix(dbgCol, dbgUnexp, unexploredBand);
                        gl_FragColor.rgb = dbgCol;
                    } else {
                        float preserveLava = clamp(1.0 - lavaFissureGlow * 0.45, 0.35, 1.0);
                        gl_FragColor.rgb = mix(baseCol, finalFowCol, clamp(exploredBand * preserveLava, 0.0, 0.94));
                    }
                }`
            );
        };
        material.needsUpdate = true;
    },
    _savedTitleFlag: 0.0,
    setPortraitRenderPass(active) {
        if (active) {
            this._savedTitleFlag = _sharedTitleFlag.value;
            _sharedTitleFlag.value = 1.0;
            this.terrainUniforms.uTitleScreen.value = 1.0;
        } else {
            const restored = (window.titleScreenActive || window.loadingCameraSweep) ? 1.0 : (this._savedTitleFlag || 0.0);
            _sharedTitleFlag.value = restored;
            this.terrainUniforms.uTitleScreen.value = restored;
        }
    },
    update(timeSec, dt = 0.016) {
        plasmaShaderMat.uniforms.uTime.value = timeSec;
        zergBioShaderMat.uniforms.uTime.value = timeSec;
        waterShaderMat.uniforms.uTime.value = timeSec;
        const isTitle = (window.titleScreenActive || window.loadingCameraSweep) ? 1.0 : 0.0;
        this._savedTitleFlag = isTitle;
        _sharedTitleFlag.value = isTitle;
        waterShaderMat.uniforms.uTitleScreen.value = isTitle;
        shieldHexShaderMat.uniforms.uTime.value = timeSec;
        flameShaderMat.uniforms.uTime.value = timeSec;
        fowCloudShaderMat.uniforms.uTime.value = timeSec;
        this.terrainUniforms.uTime.value = timeSec;
        this.terrainUniforms.uTitleScreen.value = isTitle;
        if (typeof dirLight !== 'undefined' && dirLight) {
            _sharedSunLightFactor.value = THREE.MathUtils.clamp(dirLight.intensity / 1.15, 0.45, 1.15);
        }

        if (window.WEATHER_SYSTEM) {
            window.WEATHER_SYSTEM.update(dt, timeSec);
        }
        if (window.THRUST_FX_SYSTEM) {
            window.THRUST_FX_SYSTEM.update(dt, timeSec);
        }
    }
};
window.SHADER_ENGINE = SHADER_ENGINE;
window.fowDebugMode = false;
window.toggleFowDebugMode = function(forceState) {
    window.fowDebugMode = typeof forceState === 'boolean' ? forceState : !window.fowDebugMode;
    if (SHADER_ENGINE && SHADER_ENGINE.terrainUniforms && SHADER_ENGINE.terrainUniforms.uFowDebugMode) {
        SHADER_ENGINE.terrainUniforms.uFowDebugMode.value = window.fowDebugMode ? 1.0 : 0.0;
    }
    return window.fowDebugMode;
};

window.pushWaterShaderRipple = function(wx, wz, strength = 1.0) {
    if (typeof window.isOnRiverBridge === 'function' && window.isOnRiverBridge(wx, wz, 0.85)) return;
    const t = waterShaderMat.uniforms.uTime.value;
    waterRippleCenters[nextWaterRippleSlot].set(wx, wz);
    waterRippleTimes[nextWaterRippleSlot] = t;
    waterRippleStrengths[nextWaterRippleSlot] = Math.min(1.35, strength * 0.72);
    nextWaterRippleSlot = (nextWaterRippleSlot + 1) % MAX_WATER_RIPPLES;
};

window.updateCustomShaders = function(timeSec, dt = 0.016) {
    SHADER_ENGINE.update(timeSec, dt);
};

// ============================================================================
// 2C. DYNAMIC WEATHER, CANYON DUST STORM & ASH-FALL PARTICLE SYSTEM
//     (CLEAR -> DUST & ASH STORM -> ACID RAIN -> HEAVY FOG -> NIGHTFALL)
//     Dynamically intensifies 3D wind-driven canyon dust motes, swirling sand
//     squalls & falling charred/ember ash flakes when the weather changes!
// ============================================================================
const WEATHER_STATES = [
    {
        id: 'clear',
        name: 'CLEAR SKIES',
        shortLabel: 'CLEAR (FOW 100% · SPD 100%)',
        fowMult: 1.00,
        speedMult: 1.00,
        fogDensity: 0.00038,
        fogColor: 0x1c3044,
        skyColor: 0x98c6ec,
        groundColor: 0x2e422d,
        sunIntensity: 1.18,
        wetness: 0.0,
        acidRain: 0.0,
        dustIntensity: 0.24,
        ashIntensity: 0.20,
        windSpeed: 1.0,
        dotColor: '#00ff66',
        duration: 32.0
    },
    {
        id: 'dust_storm',
        name: 'CANYON DUST & ASH STORM',
        shortLabel: 'DUST & ASH (FOW 72% · SPD 88%)',
        fowMult: 0.72,
        speedMult: 0.88,
        fogDensity: 0.00096,
        fogColor: 0x4a3220,
        skyColor: 0xd49a6a,
        groundColor: 0x452d1c,
        sunIntensity: 0.92,
        wetness: 0.0,
        acidRain: 0.0,
        dustIntensity: 1.00,
        ashIntensity: 1.00,
        windSpeed: 3.15,
        dotColor: '#f59e0b',
        duration: 30.0
    },
    {
        id: 'acid_rain',
        name: 'LIGHT ACID RAIN & ASH',
        shortLabel: 'ACID RAIN (FOW 78% · SPD 82%)',
        fowMult: 0.78,
        speedMult: 0.82,
        fogDensity: 0.00072,
        fogColor: 0x1c3424,
        skyColor: 0x7ab480,
        groundColor: 0x243b28,
        sunIntensity: 0.86,
        wetness: 0.85,
        acidRain: 1.0,
        dustIntensity: 0.42,
        ashIntensity: 0.68,
        windSpeed: 1.85,
        dotColor: '#84cc16',
        duration: 30.0
    },
    {
        id: 'heavy_fog',
        name: 'ASHEN HEAVY FOG',
        shortLabel: 'HEAVY FOG (FOW 58% · SPD 88%)',
        fowMult: 0.58,
        speedMult: 0.88,
        fogDensity: 0.00125,
        fogColor: 0x243648,
        skyColor: 0x627c94,
        groundColor: 0x1d2935,
        sunIntensity: 0.72,
        wetness: 0.35,
        acidRain: 0.0,
        dustIntensity: 0.65,
        ashIntensity: 0.82,
        windSpeed: 1.45,
        dotColor: '#38bdf8',
        duration: 28.0
    },
    {
        id: 'nightfall',
        name: 'EMBER NIGHTFALL OPS',
        shortLabel: 'NIGHTFALL (FOW 68% · SPD 94%)',
        fowMult: 0.68,
        speedMult: 0.94,
        fogDensity: 0.00065,
        fogColor: 0x0b1524,
        skyColor: 0x354f73,
        groundColor: 0x111a26,
        sunIntensity: 0.52,
        wetness: 0.15,
        acidRain: 0.0,
        dustIntensity: 0.48,
        ashIntensity: 0.74,
        windSpeed: 1.55,
        dotColor: '#a855f7',
        duration: 32.0
    }
];

window.WEATHER_STATE = {
    id: 'clear',
    name: 'CLEAR SKIES',
    fowMult: 1.0,
    speedMult: 1.0,
    dustIntensity: 0.24,
    ashIntensity: 0.20
};

function createProceduralDustSpriteTexture() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0.0, 'rgba(255, 238, 205, 0.95)');
    g.addColorStop(0.38, 'rgba(232, 188, 132, 0.68)');
    g.addColorStop(0.75, 'rgba(184, 134, 82, 0.22)');
    g.addColorStop(1.0, 'rgba(140, 95, 50, 0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
}

function createProceduralAshFlakeTexture() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 64, 64);
    // Irregular jagged ash flake core + warm ember halo
    const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 26);
    g.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
    g.addColorStop(0.45, 'rgba(235, 220, 205, 0.85)');
    g.addColorStop(0.78, 'rgba(160, 140, 125, 0.30)');
    g.addColorStop(1.0, 'rgba(90, 80, 75, 0.0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(32, 8);
    ctx.lineTo(50, 18);
    ctx.lineTo(54, 36);
    ctx.lineTo(42, 54);
    ctx.lineTo(22, 52);
    ctx.lineTo(10, 36);
    ctx.lineTo(16, 16);
    ctx.closePath();
    ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
}

const WEATHER_SYSTEM = {
    currentIndex: 0,
    timer: 32.0,
    rainLines: null,
    rainPositions: null,
    rainCount: IS_MOBILE ? 240 : 480,
    fogBanks: [],
    dustPoints: null,
    dustPositions: null,
    dustVelocities: null,
    dustPhases: null,
    dustCount: IS_MOBILE ? 320 : 680,
    ashPoints: null,
    ashPositions: null,
    ashVelocities: null,
    ashPhases: null,
    ashCount: IS_MOBILE ? 240 : 520,
    dustSquallClouds: [],
    currentDustIntensity: 0.24,
    currentAshIntensity: 0.20,
    currentWindSpeed: 1.0,
    transitionBurstTimer: 0.0,
    splashTimer: 0,
    init() {
        // 1. Build 3D Falling Acid Rain Streak Particle System
        const positions = new Float32Array(this.rainCount * 6);
        for (let i = 0; i < this.rainCount; i++) {
            const rx = (Math.random() - 0.5) * 95;
            const ry = Math.random() * 38;
            const rz = (Math.random() - 0.5) * 95;
            const p = i * 6;
            positions[p] = rx;
            positions[p + 1] = ry;
            positions[p + 2] = rz;
            positions[p + 3] = rx - 0.35;
            positions[p + 4] = ry - 1.65;
            positions[p + 5] = rz - 0.2;
        }
        this.rainPositions = positions;
        const rainGeo = new THREE.BufferGeometry();
        rainGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const rainMat = new THREE.LineBasicMaterial({
            color: 0x9ef01a,
            transparent: true,
            opacity: 0.0,
            depthWrite: false
        });
        this.rainLines = new THREE.LineSegments(rainGeo, rainMat);
        this.rainLines.visible = false;
        this.rainLines.frustumCulled = false;
        scene.add(this.rainLines);

        // 2. Build Drifting Low-Altitude Volumetric-Style Heavy Fog Banks
        const fogBankGeo = createSculptedArmorDomeGeo(5.5, 12, 8);
        fogBankGeo.scale(2.4, 0.32, 1.8);
        const fogBankMat = new THREE.MeshBasicMaterial({
            color: 0x6c8ca8,
            transparent: true,
            opacity: 0.0,
            depthWrite: false
        });
        this.fogBankMat = fogBankMat;
        const bankCount = IS_MOBILE ? 10 : 18;
        for (let i = 0; i < bankCount; i++) {
            const m = new THREE.Mesh(fogBankGeo, fogBankMat);
            m.position.set((Math.random() - 0.5) * 110, 1.8 + Math.random() * 2.8, (Math.random() - 0.5) * 110);
            m.rotation.y = Math.random() * Math.PI * 2;
            m.visible = false;
            scene.add(m);
            this.fogBanks.push({
                mesh: m,
                vx: 1.4 + Math.random() * 1.2,
                vz: 0.6 + Math.random() * 0.9,
                baseY: m.position.y,
                phase: Math.random() * 10
            });
        }

        // 3. Build Particle-Based Canyon Dust Storm System (Wind-swept ochre/sandstone particulate motes)
        const dustPos = new Float32Array(this.dustCount * 3);
        const dustCol = new Float32Array(this.dustCount * 3);
        const dustVel = new Float32Array(this.dustCount * 3);
        const dustPhase = new Float32Array(this.dustCount);
        const dustPalette = [
            new THREE.Color(0xd99b56), // Warm canyon ochre
            new THREE.Color(0xc57d3e), // Reddish badlands sandstone
            new THREE.Color(0xe6be8a), // Sunlit desert silt
            new THREE.Color(0x9c673a)  // Deep canyon dust
        ];
        for (let i = 0; i < this.dustCount; i++) {
            const p = i * 3;
            dustPos[p]     = (Math.random() - 0.5) * 120;
            dustPos[p + 1] = 0.4 + Math.random() * 24.0;
            dustPos[p + 2] = (Math.random() - 0.5) * 120;
            dustVel[p]     = 5.5 + Math.random() * 7.5;   // Fast horizontal canyon wind
            dustVel[p + 1] = (Math.random() - 0.48) * 1.4; // Swirling updraft/downdraft
            dustVel[p + 2] = 2.0 + Math.random() * 3.8;
            dustPhase[i]   = Math.random() * Math.PI * 2;

            const c = dustPalette[i % dustPalette.length];
            const shade = 0.82 + Math.random() * 0.28;
            dustCol[p]     = Math.min(1, c.r * shade);
            dustCol[p + 1] = Math.min(1, c.g * shade);
            dustCol[p + 2] = Math.min(1, c.b * shade);
        }
        this.dustPositions = dustPos;
        this.dustVelocities = dustVel;
        this.dustPhases = dustPhase;
        const dustGeo = new THREE.BufferGeometry();
        dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
        dustGeo.setAttribute('color', new THREE.BufferAttribute(dustCol, 3));
        const dustMat = new THREE.PointsMaterial({
            size: IS_MOBILE ? 1.35 : 1.15,
            map: createProceduralDustSpriteTexture(),
            vertexColors: true,
            transparent: true,
            opacity: 0.28,
            depthWrite: false,
            blending: THREE.NormalBlending,
            sizeAttenuation: true
        });
        this.dustPoints = new THREE.Points(dustGeo, dustMat);
        this.dustPoints.frustumCulled = false;
        scene.add(this.dustPoints);

        // 4. Build Particle-Based Volcanic / Battlefield Ash-Fall System (Fluttering charcoal ash flakes & glowing cinders)
        const ashPos = new Float32Array(this.ashCount * 3);
        const ashCol = new Float32Array(this.ashCount * 3);
        const ashVel = new Float32Array(this.ashCount * 3);
        const ashPhase = new Float32Array(this.ashCount);
        for (let i = 0; i < this.ashCount; i++) {
            const p = i * 3;
            ashPos[p]     = (Math.random() - 0.5) * 110;
            ashPos[p + 1] = 0.5 + Math.random() * 32.0;
            ashPos[p + 2] = (Math.random() - 0.5) * 110;
            ashVel[p]     = 1.2 + Math.random() * 2.4;    // Lateral wind drift
            ashVel[p + 1] = -(1.8 + Math.random() * 2.6); // Gentle fluttering ash descent
            ashVel[p + 2] = 0.6 + Math.random() * 1.8;
            ashPhase[i]   = Math.random() * Math.PI * 2;

            // 22% glowing orange/amber volcanic cinders, 78% pale/charred ash flakes
            const isEmber = (i % 9 === 0) || (i % 13 === 0);
            if (isEmber) {
                ashCol[p]     = 1.0;
                ashCol[p + 1] = 0.45 + Math.random() * 0.35;
                ashCol[p + 2] = 0.12;
            } else {
                const gVal = 0.52 + Math.random() * 0.34;
                ashCol[p]     = gVal * 1.04;
                ashCol[p + 1] = gVal * 0.98;
                ashCol[p + 2] = gVal * 0.92;
            }
        }
        this.ashPositions = ashPos;
        this.ashVelocities = ashVel;
        this.ashPhases = ashPhase;
        const ashGeo = new THREE.BufferGeometry();
        ashGeo.setAttribute('position', new THREE.BufferAttribute(ashPos, 3));
        ashGeo.setAttribute('color', new THREE.BufferAttribute(ashCol, 3));
        const ashMat = new THREE.PointsMaterial({
            size: IS_MOBILE ? 0.85 : 0.72,
            map: createProceduralAshFlakeTexture(),
            vertexColors: true,
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
            sizeAttenuation: true
        });
        this.ashPoints = new THREE.Points(ashGeo, ashMat);
        this.ashPoints.frustumCulled = false;
        scene.add(this.ashPoints);

        // 5. Build Rolling Canyon Dust Squall Clouds (Low-altitude billowing sand/dust plumes)
        const squallGeo = createSculptedArmorDomeGeo(4.8, 10, 7);
        squallGeo.scale(2.6, 0.48, 1.65);
        const squallMat = new THREE.MeshBasicMaterial({
            color: 0xc88a4b,
            transparent: true,
            opacity: 0.0,
            depthWrite: false
        });
        this.dustSquallMat = squallMat;
        const squallCount = IS_MOBILE ? 8 : 14;
        for (let i = 0; i < squallCount; i++) {
            const sm = new THREE.Mesh(squallGeo, squallMat);
            sm.position.set((Math.random() - 0.5) * 115, 1.4 + Math.random() * 3.8, (Math.random() - 0.5) * 115);
            sm.rotation.y = Math.random() * Math.PI * 2;
            sm.visible = false;
            scene.add(sm);
            this.dustSquallClouds.push({
                mesh: sm,
                vx: 5.2 + Math.random() * 3.5,
                vz: 2.1 + Math.random() * 1.8,
                baseY: sm.position.y,
                phase: Math.random() * 10
            });
        }

        this.syncHUD();
    },
    setWeather(index) {
        this.currentIndex = ((index % WEATHER_STATES.length) + WEATHER_STATES.length) % WEATHER_STATES.length;
        const w = WEATHER_STATES[this.currentIndex];
        this.timer = w.duration;
        // Trigger a dynamic atmospheric gust surge whenever weather changes!
        this.transitionBurstTimer = 4.5;
        window.WEATHER_STATE.id = w.id;
        window.WEATHER_STATE.name = w.name;
        window.WEATHER_STATE.fowMult = w.fowMult;
        window.WEATHER_STATE.speedMult = w.speedMult;
        window.WEATHER_STATE.dustIntensity = w.dustIntensity;
        window.WEATHER_STATE.ashIntensity = w.ashIntensity;
        this.syncHUD();

        if (typeof updateFogOfWarVision === 'function') {
            updateFogOfWarVision();
        }
        if (typeof spawnCombatFloat === 'function' && controls && controls.target) {
            const col = w.dotColor || '#00ff66';
            spawnCombatFloat(controls.target, `WEATHER: ${w.name}`, col);
        }
    },
    cycleNext() {
        if (window.SFX) window.SFX.playClick();
        this.setWeather(this.currentIndex + 1);
    },
    getSpeedMultiplier() {
        const w = WEATHER_STATES[this.currentIndex];
        return w ? w.speedMult : 1.0;
    },
    syncHUD() {
        const w = WEATHER_STATES[this.currentIndex];
        const lbl = document.getElementById('ui-weather-label');
        const dot = document.getElementById('ui-weather-dot');
        const btn = document.getElementById('btn-weather-cycle');
        if (lbl) lbl.innerText = w.shortLabel;
        if (dot) {
            dot.style.background = w.dotColor;
            dot.style.boxShadow = `0 0 6px ${w.dotColor}`;
        }
        if (btn) {
            btn.style.borderColor = w.dotColor;
        }
    },
    update(dt, timeSec) {
        if (!this.rainLines) this.init();
        if (!window.titleScreenActive && !window.gamePaused) {
            this.timer -= dt;
            if (this.timer <= 0) {
                this.setWeather(this.currentIndex + 1);
            }
        }
        if (this.transitionBurstTimer > 0) {
            this.transitionBurstTimer = Math.max(0, this.transitionBurstTimer - dt);
        }

        const w = WEATHER_STATES[this.currentIndex];
        // Weather-change surge factor: temporarily intensifies dust & ash gusts during weather shifts
        const transitionSurge = this.transitionBurstTimer > 0
            ? Math.sin((this.transitionBurstTimer / 4.5) * Math.PI) * 0.38
            : 0.0;

        const targetDust = Math.min(1.25, (w.dustIntensity !== undefined ? w.dustIntensity : 0.25) + transitionSurge);
        const targetAsh  = Math.min(1.25, (w.ashIntensity !== undefined ? w.ashIntensity : 0.22) + transitionSurge * 0.85);
        const targetWind = (w.windSpeed !== undefined ? w.windSpeed : 1.0) + transitionSurge * 1.4;

        this.currentDustIntensity = THREE.MathUtils.lerp(this.currentDustIntensity, targetDust, dt * 1.8);
        this.currentAshIntensity  = THREE.MathUtils.lerp(this.currentAshIntensity, targetAsh, dt * 1.8);
        this.currentWindSpeed     = THREE.MathUtils.lerp(this.currentWindSpeed, targetWind, dt * 1.6);

        // Zoom-compensated fog density: automatically scales down fog density when zooming out so the battlefield always stays bright & visible!
        const camDist = (controls && controls.target) ? camera.position.distanceTo(controls.target) : 42.0;
        const zoomFogScale = Math.min(1.0, 36.0 / Math.max(36.0, camDist * 1.15));
        const targetFogDensity = w.fogDensity * zoomFogScale;
        scene.fog.density = THREE.MathUtils.lerp(scene.fog.density, targetFogDensity, dt * 3.5);
        scene.fog.color.lerp(new THREE.Color(w.fogColor), dt * 1.8);
        scene.background.lerp(new THREE.Color(w.fogColor), dt * 1.8);
        hemiLight.color.lerp(new THREE.Color(w.skyColor), dt * 1.8);
        hemiLight.groundColor.lerp(new THREE.Color(w.groundColor), dt * 1.8);
        dirLight.intensity = THREE.MathUtils.lerp(dirLight.intensity, w.sunIntensity, dt * 1.8);

        SHADER_ENGINE.terrainUniforms.uWetness.value = THREE.MathUtils.lerp(SHADER_ENGINE.terrainUniforms.uWetness.value, w.wetness, dt * 2.0);
        SHADER_ENGINE.terrainUniforms.uAcidRain.value = THREE.MathUtils.lerp(SHADER_ENGINE.terrainUniforms.uAcidRain.value, w.acidRain, dt * 2.0);
        waterShaderMat.uniforms.uRainIntensity.value = SHADER_ENGINE.terrainUniforms.uAcidRain.value;

        const cx = (controls && controls.target) ? controls.target.x : 0;
        const cz = (controls && controls.target) ? controls.target.z : 0;

        // 1. Animate 3D Acid Rain Streaks around camera target
        const rainAlpha = SHADER_ENGINE.terrainUniforms.uAcidRain.value * 0.68;
        this.rainLines.material.opacity = rainAlpha;
        this.rainLines.visible = rainAlpha > 0.02;
        if (this.rainLines.visible) {
            const pos = this.rainPositions;
            const fallStep = 36.0 * dt;
            const windStep = 7.5 * dt;
            for (let i = 0; i < this.rainCount; i++) {
                const p = i * 6;
                pos[p] -= windStep;
                pos[p + 1] -= fallStep;
                pos[p + 3] = pos[p] - 0.38;
                pos[p + 4] = pos[p + 1] - 1.75;
                if (pos[p + 1] < -1.0) {
                    pos[p] = cx + (Math.random() - 0.5) * 85;
                    pos[p + 1] = 28 + Math.random() * 14;
                    pos[p + 2] = cz + (Math.random() - 0.5) * 85;
                    pos[p + 3] = pos[p] - 0.38;
                    pos[p + 4] = pos[p + 1] - 1.75;
                    pos[p + 5] = pos[p + 2] - 0.2;
                }
            }
            this.rainLines.geometry.attributes.position.needsUpdate = true;

            this.splashTimer -= dt;
            if (this.splashTimer <= 0) {
                this.splashTimer = 0.22;
                window.pushWaterShaderRipple(
                    cx + (Math.random() - 0.5) * 45,
                    cz + (Math.random() - 0.5) * 45,
                    0.45
                );
            }
        }

        // 2. Animate 3D Canyon Dust Storm Particle System (Turbulent wind gusts around camera target)
        if (this.dustPoints) {
            const dustOpacity = THREE.MathUtils.clamp(this.currentDustIntensity * 0.72, 0.08, 0.85);
            this.dustPoints.material.opacity = dustOpacity;
            this.dustPoints.material.size = (IS_MOBILE ? 1.25 : 1.05) + this.currentDustIntensity * 0.65;
            this.dustPoints.visible = dustOpacity > 0.02;

            const dPos = this.dustPositions;
            const dVel = this.dustVelocities;
            const dPhs = this.dustPhases;
            const gustX = (1.0 + 0.35 * Math.sin(timeSec * 1.4)) * this.currentWindSpeed;
            const gustZ = (1.0 + 0.30 * Math.cos(timeSec * 1.1)) * this.currentWindSpeed;
            const halfSpan = 58.0;

            for (let i = 0; i < this.dustCount; i++) {
                const p = i * 3;
                const ph = dPhs[i];
                const swirlY = Math.sin(timeSec * 2.4 + ph) * 0.85 * this.currentDustIntensity;
                const swirlZ = Math.cos(timeSec * 1.9 + ph) * 1.35 * this.currentDustIntensity;

                dPos[p]     += dVel[p] * gustX * dt;
                dPos[p + 1] += (dVel[p + 1] + swirlY) * dt;
                dPos[p + 2] += (dVel[p + 2] * gustZ + swirlZ) * dt;

                // Wrap seamlessly inside the active camera frustum box so dust density is always rich
                if (dPos[p] - cx > halfSpan)  dPos[p] -= halfSpan * 2.0;
                if (dPos[p] - cx < -halfSpan) dPos[p] += halfSpan * 2.0;
                if (dPos[p + 2] - cz > halfSpan)  dPos[p + 2] -= halfSpan * 2.0;
                if (dPos[p + 2] - cz < -halfSpan) dPos[p + 2] += halfSpan * 2.0;
                if (dPos[p + 1] < 0.35) dPos[p + 1] = 22.0 + Math.random() * 4.0;
                if (dPos[p + 1] > 26.5) dPos[p + 1] = 0.5 + Math.random() * 2.5;
            }
            this.dustPoints.geometry.attributes.position.needsUpdate = true;
        }

        // 3. Animate 3D Falling Volcanic / Battlefield Ash-Fall Particle System
        if (this.ashPoints) {
            const ashOpacity = THREE.MathUtils.clamp(this.currentAshIntensity * 0.78, 0.10, 0.90);
            this.ashPoints.material.opacity = ashOpacity;
            this.ashPoints.material.size = (IS_MOBILE ? 0.78 : 0.64) + this.currentAshIntensity * 0.38;
            this.ashPoints.visible = ashOpacity > 0.02;

            const aPos = this.ashPositions;
            const aVel = this.ashVelocities;
            const aPhs = this.ashPhases;
            const halfSpan = 54.0;
            const windScale = 0.65 + this.currentWindSpeed * 0.55;

            for (let i = 0; i < this.ashCount; i++) {
                const p = i * 3;
                const ph = aPhs[i];
                // Fluttering leaf/ash curl motion as ash flakes descend
                const flutterX = Math.sin(timeSec * 2.8 + ph) * 1.45;
                const flutterZ = Math.cos(timeSec * 2.3 + ph * 1.3) * 1.45;

                aPos[p]     += (aVel[p] * windScale + flutterX) * dt;
                aPos[p + 1] += aVel[p + 1] * (0.75 + this.currentAshIntensity * 0.55) * dt;
                aPos[p + 2] += (aVel[p + 2] * windScale + flutterZ) * dt;

                if (aPos[p + 1] < 0.25) {
                    aPos[p]     = cx + (Math.random() - 0.5) * (halfSpan * 2.0);
                    aPos[p + 1] = 24.0 + Math.random() * 10.0;
                    aPos[p + 2] = cz + (Math.random() - 0.5) * (halfSpan * 2.0);
                } else {
                    if (aPos[p] - cx > halfSpan)  aPos[p] -= halfSpan * 2.0;
                    if (aPos[p] - cx < -halfSpan) aPos[p] += halfSpan * 2.0;
                    if (aPos[p + 2] - cz > halfSpan)  aPos[p + 2] -= halfSpan * 2.0;
                    if (aPos[p + 2] - cz < -halfSpan) aPos[p + 2] += halfSpan * 2.0;
                }
            }
            this.ashPoints.geometry.attributes.position.needsUpdate = true;
        }

        // 4. Animate Rolling Canyon Dust Squall Clouds (Intensifies during Dust Storm & Weather Transitions)
        const targetSquallOpacity = w.id === 'dust_storm'
            ? 0.22
            : (this.transitionBurstTimer > 0 ? 0.10 : 0.0);
        if (this.dustSquallMat) {
            this.dustSquallMat.opacity = THREE.MathUtils.lerp(this.dustSquallMat.opacity, targetSquallOpacity, dt * 2.0);
            const showSqualls = this.dustSquallMat.opacity > 0.012;
            for (let i = 0; i < this.dustSquallClouds.length; i++) {
                const sq = this.dustSquallClouds[i];
                sq.mesh.visible = showSqualls;
                if (showSqualls) {
                    sq.mesh.position.x += sq.vx * this.currentWindSpeed * 0.45 * dt;
                    sq.mesh.position.z += sq.vz * this.currentWindSpeed * 0.45 * dt;
                    sq.mesh.position.y = sq.baseY + Math.sin(timeSec * 1.5 + sq.phase) * 0.55;
                    if (sq.mesh.position.x > 75) sq.mesh.position.x = -75;
                    if (sq.mesh.position.z > 75) sq.mesh.position.z = -75;
                }
            }
        }

        // 5. Animate Low-Altitude Heavy Fog Banks
        const isFoggy = w.id === 'heavy_fog';
        const targetFogOpacity = isFoggy ? 0.24 : 0.0;
        this.fogBankMat.opacity = THREE.MathUtils.lerp(this.fogBankMat.opacity, targetFogOpacity, dt * 2.0);
        const showFogMeshes = this.fogBankMat.opacity > 0.015;
        for (let i = 0; i < this.fogBanks.length; i++) {
            const b = this.fogBanks[i];
            b.mesh.visible = showFogMeshes;
            if (showFogMeshes) {
                b.mesh.position.x += b.vx * dt;
                b.mesh.position.z += b.vz * dt;
                b.mesh.position.y = b.baseY + Math.sin(timeSec * 0.8 + b.phase) * 0.35;
                if (b.mesh.position.x > 65) b.mesh.position.x = -65;
                if (b.mesh.position.z > 65) b.mesh.position.z = -65;
            }
        }
    }
};
window.WEATHER_SYSTEM = WEATHER_SYSTEM;

// ============================================================================
// SCULPTED 3D GEOMETRY GENERATORS (Extrude, Lathe, CatmullRom Splines & Ribbed Bio-Mesh)
// Globally shared across textures-scene.js, terrain-fow.js, and models-fx.js
// ============================================================================
function createExtrudedArmorHullGeo(width, height, length, bevelSize, chamfer) {
    const minDim = Math.max(0.01, Math.min(width, height, length));
    const bSize = (typeof bevelSize === 'number') ? bevelSize : Math.min(0.06, minDim * 0.16);
    const cSize = (typeof chamfer === 'number') ? chamfer : Math.min(width, height) * 0.24;
    const hw = width * 0.5;
    const hh = height * 0.5;
    const cw = Math.min(hw * 0.45, cSize);
    const ch = Math.min(hh * 0.45, cSize);
    const shape = new THREE.Shape();
    shape.moveTo(-hw + cw, -hh);
    shape.lineTo(hw - cw, -hh);
    shape.lineTo(hw, -hh + ch);
    shape.lineTo(hw, hh - ch);
    shape.lineTo(hw - cw, hh);
    shape.lineTo(-hw + cw, hh);
    shape.lineTo(-hw, hh - ch);
    shape.lineTo(-hw, -hh + ch);
    shape.closePath();

    const safeBevel = Math.min(bSize, length * 0.28, hw * 0.35, hh * 0.35);
    const depth = Math.max(0.008, length - safeBevel * 2);
    const geo = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelThickness: safeBevel,
        bevelSize: safeBevel * 0.85,
        bevelSegments: 2,
        curveSegments: 3
    });
    geo.translate(0, 0, -depth * 0.5);
    geo.computeVertexNormals();
    const uvAttr = geo.attributes.uv;
    if (uvAttr) {
        const span = Math.max(width, height, length, 0.25);
        for (let i = 0; i < uvAttr.count; i++) {
            const u = uvAttr.getX(i);
            const v = uvAttr.getY(i);
            uvAttr.setXY(
                i,
                0.5 + THREE.MathUtils.clamp(u / (span * 1.35), -0.28, 0.28),
                0.5 + THREE.MathUtils.clamp(v / (span * 1.35), -0.28, 0.28)
            );
        }
        uvAttr.needsUpdate = true;
    }
    return geo;
}
window.createExtrudedArmorHullGeo = createExtrudedArmorHullGeo;

function createSculptedLatheBarrelGeo(rTop = 0.2, rBot = 0.2, height = 1.0, segs = 12, heightSegs = 1, openEnded = false) {
    const rt = Math.max(0.004, rTop);
    const rb = Math.max(0.004, rBot);
    const rm = (rt + rb) * 0.5;
    const hh = height * 0.5;
    const pts = [];
    if (!openEnded) {
        pts.push(new THREE.Vector2(0.0, -hh));
    }
    pts.push(
        new THREE.Vector2(rb * 0.86, -hh),
        new THREE.Vector2(rb * 1.03, -hh + height * 0.08),
        new THREE.Vector2(THREE.MathUtils.lerp(rb, rt, 0.26) * 0.96, -hh + height * 0.26),
        new THREE.Vector2(rm * 1.045, -hh + height * 0.44),
        new THREE.Vector2(rm * 1.045, -hh + height * 0.56),
        new THREE.Vector2(THREE.MathUtils.lerp(rb, rt, 0.74) * 0.96, -hh + height * 0.74),
        new THREE.Vector2(rt * 1.03, hh - height * 0.08),
        new THREE.Vector2(rt * 0.86, hh)
    );
    if (!openEnded) {
        pts.push(new THREE.Vector2(0.0, hh));
    }
    const geo = new THREE.LatheGeometry(pts, Math.max(6, Math.min(12, segs)));
    geo.computeVertexNormals();
    return geo;
}
window.createSculptedLatheBarrelGeo = createSculptedLatheBarrelGeo;

function createSculptedArmorDomeGeo(radius = 0.25, widthSegments = 12, heightSegments = 8, phiStart = 0, phiLength = Math.PI * 2, thetaStart = 0, thetaLength = Math.PI) {
    const wSegs = Math.max(6, Math.min(14, widthSegments));
    const hSegs = Math.max(5, Math.min(10, heightSegments));
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let iy = 0; iy <= hSegs; iy++) {
        const v = iy / hSegs;
        const theta = thetaStart + v * thetaLength;
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);
        const bandBevel = 1.0 + Math.sin(theta * 3.0) * 0.035;
        for (let ix = 0; ix <= wSegs; ix++) {
            const u = ix / wSegs;
            const phi = phiStart + u * phiLength;
            const facetMod = 1.0 + Math.cos(phi * 4.0) * 0.028 * sinTheta;
            const r = radius * bandBevel * facetMod;
            const x = -r * Math.cos(phi) * sinTheta;
            const y = radius * cosTheta * (cosTheta > 0 ? 1.04 : 0.96);
            const z = r * Math.sin(phi) * sinTheta;
            positions.push(x, y, z);
            uvs.push(u, 1 - v);
        }
    }

    for (let iy = 0; iy < hSegs; iy++) {
        for (let ix = 0; ix < wSegs; ix++) {
            const a = iy * (wSegs + 1) + (ix + 1);
            const b = iy * (wSegs + 1) + ix;
            const c = (iy + 1) * (wSegs + 1) + ix;
            const d = (iy + 1) * (wSegs + 1) + (ix + 1);
            if (iy !== 0 || thetaStart > 0) indices.push(a, b, d);
            if (iy !== hSegs - 1 || thetaStart + thetaLength < Math.PI) indices.push(b, c, d);
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
}
window.createSculptedArmorDomeGeo = createSculptedArmorDomeGeo;

function createSculptedOgiveSpireGeo(radius = 0.2, height = 0.6, radialSegments = 10) {
    const r = Math.max(0.005, radius);
    const hh = height * 0.5;
    const pts = [
        new THREE.Vector2(0.0, -hh),
        new THREE.Vector2(r * 0.90, -hh),
        new THREE.Vector2(r * 1.04, -hh + height * 0.10),
        new THREE.Vector2(r * 0.88, -hh + height * 0.24),
        new THREE.Vector2(r * 0.72, -hh + height * 0.50),
        new THREE.Vector2(r * 0.44, -hh + height * 0.76),
        new THREE.Vector2(r * 0.16, -hh + height * 0.93),
        new THREE.Vector2(0.0, hh)
    ];
    const geo = new THREE.LatheGeometry(pts, Math.max(5, Math.min(10, radialSegments)));
    geo.computeVertexNormals();
    return geo;
}
window.createSculptedOgiveSpireGeo = createSculptedOgiveSpireGeo;

function createSculptedFacetedCrystalGeo(radius = 0.3, detail = 0) {
    const r = Math.max(0.01, radius);
    const pts = [
        new THREE.Vector2(0.0, -r * 1.08),
        new THREE.Vector2(r * 0.48, -r * 0.62),
        new THREE.Vector2(r * 0.96, -r * 0.14),
        new THREE.Vector2(r * 1.04, 0.0),
        new THREE.Vector2(r * 0.96, r * 0.14),
        new THREE.Vector2(r * 0.48, r * 0.62),
        new THREE.Vector2(0.0, r * 1.08)
    ];
    const segs = detail > 1 ? 10 : (detail > 0 ? 8 : 6);
    const geo = new THREE.LatheGeometry(pts, segs);
    geo.computeVertexNormals();
    return geo;
}
window.createSculptedFacetedCrystalGeo = createSculptedFacetedCrystalGeo;

function createSculptedTorusCollarGeo(radius = 0.4, tube = 0.05, radialSegments = 8, tubularSegments = 16, arc = Math.PI * 2) {
    const rSegs = Math.max(6, Math.min(8, radialSegments));
    const tSegs = Math.max(8, Math.min(18, tubularSegments));
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let j = 0; j <= rSegs; j++) {
        const v = (j / rSegs) * Math.PI * 2;
        const bevelMod = 1.0 + Math.cos(v * 4.0) * 0.08;
        const cosV = Math.cos(v) * bevelMod;
        const sinV = Math.sin(v) * bevelMod;
        for (let i = 0; i <= tSegs; i++) {
            const u = (i / tSegs) * arc;
            const x = (radius + tube * cosV) * Math.cos(u);
            const y = (radius + tube * cosV) * Math.sin(u);
            const z = tube * sinV;
            positions.push(x, y, z);
            uvs.push(i / tSegs, j / rSegs);
        }
    }

    for (let j = 1; j <= rSegs; j++) {
        for (let i = 1; i <= tSegs; i++) {
            const a = (tSegs + 1) * j + i - 1;
            const b = (tSegs + 1) * (j - 1) + i - 1;
            const c = (tSegs + 1) * (j - 1) + i;
            const d = (tSegs + 1) * j + i;
            indices.push(a, b, d, b, c, d);
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
}
window.createSculptedTorusCollarGeo = createSculptedTorusCollarGeo;

function createCurvedScytheBladeGeo(length = 0.65, baseRadius = 0.08, curveBend = 0.22) {
    const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, curveBend * 0.35, length * 0.36),
        new THREE.Vector3(0, curveBend, length * 0.74),
        new THREE.Vector3(0, curveBend * 0.45, length)
    ]);
    const tubularSegments = 9;
    const radialSegments = 7;
    const frames = curve.computeFrenetFrames(tubularSegments, false);
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let i = 0; i <= tubularSegments; i++) {
        const u = i / tubularSegments;
        const pt = curve.getPointAt(u);
        const N = frames.normals[i];
        const B = frames.binormals[i];
        const r = baseRadius * Math.pow(1 - u, 0.72) * (1 + Math.sin(u * Math.PI) * 0.28);
        for (let j = 0; j <= radialSegments; j++) {
            const vFrac = j / radialSegments;
            const v = vFrac * Math.PI * 2;
            const sin = Math.sin(v);
            const cos = Math.cos(v);
            const vx = pt.x + (cos * N.x * 0.52 + sin * B.x * 1.25) * r;
            const vy = pt.y + (cos * N.y * 0.52 + sin * B.y * 1.25) * r;
            const vz = pt.z + (cos * N.z * 0.52 + sin * B.z * 1.25) * r;
            positions.push(vx, vy, vz);
            uvs.push(u, vFrac);
        }
    }
    for (let i = 0; i < tubularSegments; i++) {
        for (let j = 0; j < radialSegments; j++) {
            const a = i * (radialSegments + 1) + j;
            const b = (i + 1) * (radialSegments + 1) + j;
            const c = (i + 1) * (radialSegments + 1) + (j + 1);
            const d = i * (radialSegments + 1) + (j + 1);
            indices.push(a, b, d, b, c, d);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
}
window.createCurvedScytheBladeGeo = createCurvedScytheBladeGeo;

function createOrganicBioCarapaceGeo(rx = 0.3, ry = 0.26, rz = 0.44, ribCount = 6, ribDepth = 0.08) {
    const wSegs = 14;
    const hSegs = 10;
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let iy = 0; iy <= hSegs; iy++) {
        const v = iy / hSegs;
        const theta = v * Math.PI;
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);
        for (let ix = 0; ix <= wSegs; ix++) {
            const u = ix / wSegs;
            const phi = u * Math.PI * 2;
            let x = -Math.cos(phi) * sinTheta;
            let y = cosTheta;
            let z = Math.sin(phi) * sinTheta;
            const dorsalFactor = Math.max(0, y);
            const ventralFactor = Math.max(0, -y);
            const ribWave = Math.sin(z * Math.PI * ribCount) * ribDepth * dorsalFactor;
            const spineCrest = Math.exp(-Math.abs(x) * 4.8) * 0.125 * dorsalFactor;
            const lateralFlange = Math.exp(-Math.pow(Math.abs(y) - 0.15, 2) * 14.0) * 0.055;
            const taper = 1.0 - Math.max(0, -z) * 0.18;
            x *= rx * taper * (1 + ribWave * 0.55 + lateralFlange);
            y = y * ry + spineCrest + ribWave - ventralFactor * 0.04;
            z *= rz;
            positions.push(x, y, z);
            uvs.push(u, 1 - v);
        }
    }

    for (let iy = 0; iy < hSegs; iy++) {
        for (let ix = 0; ix < wSegs; ix++) {
            const a = iy * (wSegs + 1) + (ix + 1);
            const b = iy * (wSegs + 1) + ix;
            const c = (iy + 1) * (wSegs + 1) + ix;
            const d = (iy + 1) * (wSegs + 1) + (ix + 1);
            if (iy !== 0) indices.push(a, b, d);
            if (iy !== hSegs - 1) indices.push(b, c, d);
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
}
window.createOrganicBioCarapaceGeo = createOrganicBioCarapaceGeo;

function createBatWingMembraneGeo(span = 1.25, chord = 0.78) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(span * 0.42, chord * 0.55, span, chord * 0.32);
    shape.quadraticCurveTo(span * 0.82, -chord * 0.08, span * 0.68, -chord * 0.42);
    shape.quadraticCurveTo(span * 0.48, -chord * 0.18, span * 0.34, -chord * 0.52);
    shape.quadraticCurveTo(span * 0.16, -chord * 0.25, 0, -chord * 0.35);
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry(shape, {
        depth: 0.024,
        bevelEnabled: true,
        bevelThickness: 0.012,
        bevelSize: 0.015,
        bevelSegments: 2,
        curveSegments: 12
    });
    geo.rotateX(-Math.PI / 2);
    geo.computeVertexNormals();
    return geo;
}
window.createBatWingMembraneGeo = createBatWingMembraneGeo;

// ============================================================================
// GROUNDED STARCRAFT II PBR MATERIAL LIBRARY (Shadow, Night & FoW Reactive!)
// ============================================================================
const MAT = {
    gunmetal: new THREE.MeshStandardMaterial({ color: 0x9eb2c6, map: metalTex, roughnessMap: metalRoughnessTex, roughness: 0.48, metalness: 0.32 }),
    titanium: new THREE.MeshStandardMaterial({ color: 0xc8d8e8, map: metalTex, roughnessMap: metalRoughnessTex, roughness: 0.42, metalness: 0.34 }),
    charredSteel: new THREE.MeshStandardMaterial({ color: 0x2c2826, roughness: 0.84, metalness: 0.22 }),
    darkSteel: new THREE.MeshStandardMaterial({ color: 0x4b5c6e, map: metalTex, roughness: 0.54, metalness: 0.30 }),
    oliveArmor: new THREE.MeshStandardMaterial({ color: 0x68845c, map: metalTex, roughnessMap: metalRoughnessTex, roughness: 0.52, metalness: 0.24 }),
    sandArmor: new THREE.MeshStandardMaterial({ color: 0xc4ac86, map: metalTex, roughness: 0.56, metalness: 0.20 }),
    medicArmor: new THREE.MeshStandardMaterial({ color: 0xe6eef6, map: metalTex, roughness: 0.42, metalness: 0.22 }),
    medicCross: new THREE.MeshStandardMaterial({ color: 0xd6202e, roughness: 0.42, metalness: 0.24, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    hazard: new THREE.MeshStandardMaterial({ map: hazardTex, roughness: 0.55, metalness: 0.22, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    copper: new THREE.MeshStandardMaterial({ color: 0xd68232, roughness: 0.42, metalness: 0.40 }),
    crimsonTank: new THREE.MeshStandardMaterial({ color: 0xa42225, roughness: 0.46, metalness: 0.28 }),
    amberGlow: new THREE.MeshStandardMaterial({ color: 0xd99216, emissive: 0x8a4800, emissiveIntensity: 0.32, roughness: 0.36, metalness: 0.28 }),
    cyanGlow: new THREE.MeshStandardMaterial({ color: 0x28b8d8, emissive: 0x005577, emissiveIntensity: 0.32, roughness: 0.34, metalness: 0.30 }),
    healGlow: new THREE.MeshStandardMaterial({ color: 0x28c874, emissive: 0x006628, emissiveIntensity: 0.30, roughness: 0.36, metalness: 0.26 }),
    plasmaShader: plasmaShaderMat,
    zergBioShader: zergBioShaderMat,
    waterShader: waterShaderMat,
    flameShader: flameShaderMat,
    nanoWeldBeam: new THREE.MeshBasicMaterial({ color: 0x38e8ff, transparent: true, opacity: 0.88, blending: THREE.AdditiveBlending, depthWrite: false }),
    medicBioBeam: new THREE.MeshBasicMaterial({ color: 0x34f598, transparent: true, opacity: 0.88, blending: THREE.AdditiveBlending, depthWrite: false }),
    acidGlow: new THREE.MeshStandardMaterial({ color: 0x7ec812, emissive: 0x285400, emissiveIntensity: 0.30, roughness: 0.36, metalness: 0.14 }),
    volatileGlow: new THREE.MeshStandardMaterial({ color: 0xe0520c, emissive: 0x7a1c00, emissiveIntensity: 0.34, roughness: 0.36, metalness: 0.18 }),
    hiveVeinGlow: new THREE.MeshStandardMaterial({ color: 0x9c28b4, emissive: 0x420856, emissiveIntensity: 0.28, roughness: 0.38, metalness: 0.18 }),
    zergFlesh: new THREE.MeshStandardMaterial({ color: 0x6b1d40, map: zergChitinTex, normalMap: zergNormalTex, normalScale: new THREE.Vector2(0.45, 0.45), roughnessMap: zergRoughnessTex, roughness: 0.42, metalness: 0.12 }),
    chitinDark: new THREE.MeshStandardMaterial({ color: 0x34203c, map: zergChitinTex, normalMap: zergNormalTex, normalScale: new THREE.Vector2(0.55, 0.55), roughnessMap: zergRoughnessTex, roughness: 0.44, metalness: 0.24 }),
    chitinRed: new THREE.MeshStandardMaterial({ color: 0x8c223c, map: zergChitinTex, normalMap: zergNormalTex, normalScale: new THREE.Vector2(0.55, 0.55), roughnessMap: zergRoughnessTex, roughness: 0.42, metalness: 0.20 }),
    chitinGreen: new THREE.MeshStandardMaterial({ color: 0x466b20, map: zergChitinTex, normalMap: zergNormalTex, normalScale: new THREE.Vector2(0.50, 0.50), roughnessMap: zergRoughnessTex, roughness: 0.44, metalness: 0.16 }),
    chitinArmor: new THREE.MeshStandardMaterial({ color: 0x5c4432, map: zergChitinTex, normalMap: zergNormalTex, normalScale: new THREE.Vector2(0.55, 0.55), roughnessMap: zergRoughnessTex, roughness: 0.42, metalness: 0.28 }),
    goreMeat: new THREE.MeshStandardMaterial({ color: 0x6e0b0b, roughness: 0.30, metalness: 0.12 }),
    crimsonBlood: new THREE.MeshStandardMaterial({ color: 0x9e0814, roughness: 0.22, metalness: 0.14 }),
    xenoIchorGreen: new THREE.MeshStandardMaterial({ color: 0x68e004, emissive: 0x225500, emissiveIntensity: 0.28, roughness: 0.28, metalness: 0.14 }),
    xenoIchorViolet: new THREE.MeshStandardMaterial({ color: 0xa820ba, emissive: 0x3d084a, emissiveIntensity: 0.28, roughness: 0.28, metalness: 0.18 }),
    scaffoldWire: new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true, transparent: true, opacity: 0.55 }),
    humanHoloMat: new THREE.MeshBasicMaterial({ map: humanEmblemTex, transparent: true, opacity: 0.88, side: THREE.DoubleSide, depthWrite: false }),
    enemyHoloMat: new THREE.MeshBasicMaterial({ map: enemyEmblemTex, transparent: true, opacity: 0.88, side: THREE.DoubleSide, depthWrite: false }),
    terranBlue: new THREE.MeshStandardMaterial({ color: 0x346de0, map: metalTex, normalMap: metalNormalTex, normalScale: new THREE.Vector2(0.35, 0.35), roughnessMap: metalRoughnessTex, roughness: 0.44, metalness: 0.28, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    terranCobalt: new THREE.MeshStandardMaterial({ color: 0x208ecc, map: metalTex, normalMap: metalNormalTex, normalScale: new THREE.Vector2(0.35, 0.35), roughness: 0.42, metalness: 0.28, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    terranTrim: new THREE.MeshStandardMaterial({ color: 0x20bcd6, roughness: 0.36, metalness: 0.38, emissive: 0x00283d, emissiveIntensity: 0.22 }),
    terranPlating: new THREE.MeshStandardMaterial({ color: 0x7288a0, map: metalTex, normalMap: metalNormalTex, normalScale: new THREE.Vector2(0.35, 0.35), roughnessMap: metalRoughnessTex, roughness: 0.46, metalness: 0.30 }),
    zergTeamPurple: new THREE.MeshStandardMaterial({ color: 0x781c7c, map: zergChitinTex, normalMap: zergNormalTex, normalScale: new THREE.Vector2(0.45, 0.45), roughness: 0.40, metalness: 0.22, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    zergTeamCrimson: new THREE.MeshStandardMaterial({ color: 0x9c163c, map: zergChitinTex, normalMap: zergNormalTex, normalScale: new THREE.Vector2(0.45, 0.45), roughness: 0.40, metalness: 0.20, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    zergTeamGreen: new THREE.MeshStandardMaterial({ color: 0x4e7c12, map: zergChitinTex, normalMap: zergNormalTex, normalScale: new THREE.Vector2(0.45, 0.45), roughness: 0.42, metalness: 0.18, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    medicDecalCross: new THREE.MeshStandardMaterial({ color: 0xd61840, roughness: 0.38, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
};
MAT.bioGreen = MAT.acidGlow;
window.MAT = MAT;

// Apply Fog of War, Night/Sun Shading & Cloud Shadow Shader to ALL Standard Building/Structure & Accent Materials
[
    'gunmetal', 'titanium', 'charredSteel', 'darkSteel', 'oliveArmor', 'sandArmor', 'medicArmor', 'medicCross',
    'hazard', 'copper', 'crimsonTank', 'amberGlow', 'cyanGlow', 'healGlow',
    'acidGlow', 'volatileGlow', 'hiveVeinGlow', 'zergFlesh', 'chitinDark', 'chitinRed', 'chitinGreen', 'chitinArmor',
    'goreMeat', 'crimsonBlood', 'xenoIchorGreen', 'xenoIchorViolet',
    'terranBlue', 'terranCobalt', 'terranTrim', 'terranPlating',
    'zergTeamPurple', 'zergTeamCrimson', 'zergTeamGreen', 'medicDecalCross'
].forEach(matKey => {
    if (MAT[matKey] && SHADER_ENGINE && typeof SHADER_ENGINE.applyBuildingShader === 'function') {
        SHADER_ENGINE.applyBuildingShader(MAT[matKey]);
    }
});

// Verify and repair all Terran, Zerg, and Solaris faction materials so no unit or building ever renders black
window.verifyAndRepairFactionMaterials = function() {
    const factionSpecs = {
        terran: {
            keys: ['gunmetal', 'titanium', 'darkSteel', 'oliveArmor', 'sandArmor', 'medicArmor', 'terranBlue', 'terranCobalt', 'terranTrim', 'terranPlating'],
            fallbackColor: 0x6b88a8
        },
        zerg: {
            keys: ['zergFlesh', 'chitinDark', 'chitinRed', 'chitinGreen', 'chitinArmor', 'zergTeamPurple', 'zergTeamCrimson', 'zergTeamGreen', 'acidGlow', 'bioGreen', 'hiveVeinGlow'],
            fallbackColor: 0x7c2d5a
        },
        solaris: {
            keys: ['solarisGold', 'solarisDarkBlue', 'solarisWhite', 'solarisCore', 'solarisCrystal', 'solarisTeamCyan', 'solarisTeamGold'],
            fallbackColor: 0xd8b24c
        }
    };

    const issues = [];
    let totalChecked = 0;
    let repairedCount = 0;
    const statusByFaction = { terran: true, zerg: true, solaris: true };

    const checkTexValid = (tex) => {
        if (!tex) return true; // optional map slot
        const dim = window.TEXTURE_REGISTRY ? window.TEXTURE_REGISTRY.inspectTextureDimensions(tex) : { width: 1, height: 1, hasSource: true };
        return Boolean(tex.isTexture && dim.hasSource && dim.width > 0 && dim.height > 0);
    };

    Object.keys(factionSpecs).forEach(faction => {
        const spec = factionSpecs[faction];
        spec.keys.forEach(k => {
            const m = MAT[k];
            if (!m) {
                // Solaris materials are populated when models-fx.js loads; only flag if models-fx has loaded
                if (faction !== 'solaris' || MAT.solarisGold) {
                    statusByFaction[faction] = false;
                    issues.push(`Missing material MAT.${k}`);
                    MAT[k] = new THREE.MeshStandardMaterial({ color: spec.fallbackColor, roughness: 0.45, metalness: 0.25 });
                    repairedCount++;
                }
                return;
            }
            totalChecked++;
            let needsUpdate = false;
            if (m.color && (m.color.r + m.color.g + m.color.b) < 0.03) {
                m.color.setHex(spec.fallbackColor);
                repairedCount++;
                needsUpdate = true;
                issues.push(`Repaired near-black base color on MAT.${k}`);
            }
            if (m.map && !checkTexValid(m.map)) {
                m.map = _whiteFallbackTex;
                repairedCount++;
                needsUpdate = true;
                issues.push(`Replaced invalid map on MAT.${k}`);
            }
            if (m.normalMap && !checkTexValid(m.normalMap)) {
                m.normalMap = _neutralNormalTex;
                repairedCount++;
                needsUpdate = true;
                issues.push(`Replaced invalid normalMap on MAT.${k}`);
            }
            if (m.roughnessMap && !checkTexValid(m.roughnessMap)) {
                m.roughnessMap = _whiteFallbackTex;
                repairedCount++;
                needsUpdate = true;
                issues.push(`Replaced invalid roughnessMap on MAT.${k}`);
            }
            if (needsUpdate) m.needsUpdate = true;
        });
    });

    const result = {
        ok: statusByFaction.terran && statusByFaction.zerg && statusByFaction.solaris && issues.length === 0,
        terranOk: statusByFaction.terran,
        zergOk: statusByFaction.zerg,
        solarisOk: statusByFaction.solaris,
        totalChecked,
        repairedCount,
        issues
    };
    window._lastFactionMaterialVerification = result;
    return result;
};
window.verifyAndRepairFactionMaterials();

// Sculpted Bomb Impact Crater Rim Geometry (Lathe-turned raised blast lip + sunken pit)
const craterRimLathePts = [
    new THREE.Vector2(0.0, -0.06),
    new THREE.Vector2(0.52, -0.05),
    new THREE.Vector2(0.78, 0.22),
    new THREE.Vector2(0.95, 0.26),
    new THREE.Vector2(1.22, 0.08),
    new THREE.Vector2(1.42, 0.0)
];
const craterRimGeo = new THREE.LatheGeometry(craterRimLathePts, 20);
craterRimGeo.computeVertexNormals();

// DYNAMICALLY GENERATED IRREGULAR LIQUID SPLASH GORE GEOMETRY (Zero Circles — Multi-Lobed Splatter Tendrils!)
function createDynamicLiquidSplashGeo(baseRadius = 0.68, lobeCount = 9, spikeAmp = 0.48, stretchZ = 1.0, seedOffset = 0) {
    const pts = [];
    const totalSteps = lobeCount * 4;
    const phaseA = seedOffset * 1.7 + Math.random() * 6.28;
    const phaseB = seedOffset * 3.1 + Math.random() * 6.28;
    const phaseC = seedOffset * 5.3 + Math.random() * 6.28;

    for (let i = 0; i < totalSteps; i++) {
        const t = (i / totalSteps) * Math.PI * 2;
        const w1 = Math.sin(t * lobeCount + phaseA);
        const w2 = Math.cos(t * (lobeCount * 2 - 1) - phaseB);
        const w3 = Math.sin(t * 3 + phaseC);
        const tendril = Math.pow(Math.max(0, w1 * 0.65 + w2 * 0.35), 1.6) * spikeAmp * 1.35;
        const neckPinch = (w1 < -0.35) ? -0.24 * spikeAmp : 0;
        const asymm = 1.0 + 0.22 * w3;
        const r = Math.max(baseRadius * 0.26, baseRadius * asymm * (0.68 + tendril + neckPinch));
        const px = Math.cos(t) * r;
        const py = Math.sin(t) * r * stretchZ;
        pts.push(new THREE.Vector2(px, py));
    }

    const shape = new THREE.Shape();
    const firstMidX = (pts[pts.length - 1].x + pts[0].x) * 0.5;
    const firstMidY = (pts[pts.length - 1].y + pts[0].y) * 0.5;
    shape.moveTo(firstMidX, firstMidY);
    for (let i = 0; i < pts.length; i++) {
        const curr = pts[i];
        const next = pts[(i + 1) % pts.length];
        const midX = (curr.x + next.x) * 0.5;
        const midY = (curr.y + next.y) * 0.5;
        shape.quadraticCurveTo(curr.x, curr.y, midX, midY);
    }
    shape.closePath();

    const geo = new THREE.ShapeGeometry(shape, 6);
    geo.rotateX(-Math.PI / 2);
    geo.computeVertexNormals();
    return geo;
}

// Sculpted 120mm Tank APFSDS-HEAT Armor-Piercing Fin-Stabilized Shell Geometry
const tankShellLathePts = [
    new THREE.Vector2(0.0, -0.45),
    new THREE.Vector2(0.075, -0.42),
    new THREE.Vector2(0.095, -0.18),
    new THREE.Vector2(0.115, 0.05),
    new THREE.Vector2(0.085, 0.28),
    new THREE.Vector2(0.032, 0.52),
    new THREE.Vector2(0.0, 0.68)
];
const tankSabotShellGeo = new THREE.LatheGeometry(tankShellLathePts, 14);
tankSabotShellGeo.rotateX(Math.PI / 2);
tankSabotShellGeo.computeVertexNormals();

// Pre-build diverse pools of irregular dynamically generated liquid splash geometries
const LIQUID_SPLASH_POOL_BIG = [];
const LIQUID_SPLASH_POOL_SMALL = [];
const LIQUID_SPLASH_POOL_DROP = [];
for (let s = 0; s < 8; s++) {
    LIQUID_SPLASH_POOL_BIG.push(createDynamicLiquidSplashGeo(1.18, 9 + (s % 4), 0.56, 1.0 + (s % 3) * 0.22, s + 1));
    LIQUID_SPLASH_POOL_SMALL.push(createDynamicLiquidSplashGeo(0.72, 7 + (s % 4), 0.52, 1.0 + (s % 3) * 0.25, s + 11));
    LIQUID_SPLASH_POOL_DROP.push(createDynamicLiquidSplashGeo(0.36, 5 + (s % 4), 0.48, 1.15 + (s % 3) * 0.35, s + 23));
}

function getDynamicSplashGeo(sizeCategory = 'small') {
    if (sizeCategory === 'big') {
        return LIQUID_SPLASH_POOL_BIG[Math.floor(Math.random() * LIQUID_SPLASH_POOL_BIG.length)];
    }
    if (sizeCategory === 'drop') {
        return LIQUID_SPLASH_POOL_DROP[Math.floor(Math.random() * LIQUID_SPLASH_POOL_DROP.length)];
    }
    return LIQUID_SPLASH_POOL_SMALL[Math.floor(Math.random() * LIQUID_SPLASH_POOL_SMALL.length)];
}

// ============================================================================
// SIMULATED TURBULENT VOLUMETRIC COMBUSTION & EXPLOSIVE FLUID SHADER
// Replaces primitive 3D spheres/rings with FBM curl-noise raymarched-style
// soft-particle plumes that evolve along a Blackbody Temperature Curve:
// 6000K White-Hot Core -> 2400K Roaring Orange Fireball -> 400K Billowing Soot!
// ============================================================================
function createSimulatedExplosionPlumeMaterial(initialTemp = 1.0, seed = 0.0, hueMode = 0.0) {
    return new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
        uniforms: {
            uAge: { value: 0.0 },
            uLife: { value: 1.0 },
            uTemp: { value: initialTemp },
            uSeed: { value: seed },
            uHueMode: { value: hueMode } // 0.0 = Thermal Fire/Soot, 1.0 = Corrosive Zerg Acid/Spore, 2.0 = Protoss Plasma/Void
        },
        vertexShader: `
            varying vec2 vUv;
            varying vec3 vObjPos;
            varying vec3 vViewNormal;
            varying vec3 vViewDir;
            void main() {
                vUv = uv;
                vObjPos = position;
                vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                vViewNormal = normalize(normalMatrix * normal);
                vViewDir = normalize(-mvPos.xyz);
                gl_Position = projectionMatrix * mvPos;
            }
        `,
        fragmentShader: `
            uniform float uAge;
            uniform float uLife;
            uniform float uTemp;
            uniform float uSeed;
            uniform float uHueMode;
            varying vec2 vUv;
            varying vec3 vObjPos;
            varying vec3 vViewNormal;
            varying vec3 vViewDir;

            float hash2(vec2 p) {
                p = fract(p * vec2(127.1, 311.7) + uSeed * 17.3);
                p += dot(p, p + 34.5);
                return fract(p.x * p.y);
            }

            float noise2(vec2 p) {
                vec2 i = floor(p);
                vec2 f = fract(p);
                f = f * f * (3.0 - 2.0 * f);
                return mix(
                    mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x),
                    mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x),
                    f.y
                );
            }

            float fbmTurbulence(vec2 p) {
                float v = 0.0;
                float a = 0.52;
                mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
                for (int i = 0; i < 4; i++) {
                    v += a * noise2(p);
                    p = rot * p * 2.12 + vec2(1.7, 2.9);
                    a *= 0.48;
                }
                return v;
            }

            void main() {
                float ndv = clamp(dot(normalize(vViewNormal), normalize(vViewDir)), 0.0, 1.0);
                float r = 1.0 - ndv;
                float progress = clamp(uAge / max(0.05, uLife), 0.0, 1.0);

                vec2 flowUv = (vObjPos.xz + vec2(vObjPos.y * 0.75, -vObjPos.y * 0.65)) * (3.8 + progress * 1.4) + vec2(uSeed * 5.1, -uAge * 2.4);
                float n1 = fbmTurbulence(flowUv);
                float n2 = fbmTurbulence(flowUv * 1.85 - vec2(uAge * 1.8, -uAge * 2.2));
                float turb = n1 * 0.62 + n2 * 0.38;

                // Soft volumetric Fresnel edge erosion so 3D cloud puffs have zero hard edges or square borders
                float radialMask = smoothstep(0.08, 0.68, ndv + (turb - 0.46) * 0.45);
                if (radialMask <= 0.01) discard;

                float coreDensity = clamp(radialMask * (0.68 + turb * 0.65), 0.0, 1.0);
                float sunLit = clamp(0.55 + 0.45 * vViewNormal.y + (turb - 0.5) * 0.35, 0.18, 1.0);
                float heat = clamp(uTemp * (1.0 - progress * 0.85) * (0.55 + turb * 0.85) * (0.65 + ndv * 0.55), 0.0, 1.5);

                vec3 col;
                if (uHueMode > 1.5) {
                    vec3 sootVoid = vec3(0.05, 0.12, 0.24) * sunLit;
                    vec3 arcBlue = vec3(0.08, 0.68, 1.0);
                    vec3 whiteCore = vec3(0.92, 0.99, 1.0) * 1.8;
                    col = mix(sootVoid, arcBlue, smoothstep(0.12, 0.58, heat));
                    col = mix(col, whiteCore, smoothstep(0.58, 1.15, heat));
                } else if (uHueMode > 0.5) {
                    vec3 sporeSmoke = vec3(0.12, 0.20, 0.08) * sunLit;
                    vec3 acidLime = vec3(0.52, 0.94, 0.08);
                    vec3 bileCore = vec3(0.92, 1.0, 0.55) * 1.5;
                    col = mix(sporeSmoke, acidLime, smoothstep(0.12, 0.58, heat));
                    col = mix(col, bileCore, smoothstep(0.58, 1.15, heat));
                } else {
                    vec3 darkSoot = mix(vec3(0.08, 0.075, 0.07), vec3(0.28, 0.26, 0.24), sunLit);
                    vec3 emberRed = vec3(0.82, 0.16, 0.02);
                    vec3 roaringOrange = vec3(1.0, 0.54, 0.08) * 1.35;
                    vec3 whiteHot = vec3(1.0, 0.97, 0.86) * 2.1;

                    col = mix(darkSoot, emberRed, smoothstep(0.10, 0.36, heat));
                    col = mix(col, roaringOrange, smoothstep(0.36, 0.72, heat));
                    col = mix(col, whiteHot, smoothstep(0.72, 1.18, heat));
                }

                float fadeOut = pow(1.0 - progress, 0.72);
                float alpha = clamp(coreDensity * fadeOut * (0.86 - progress * 0.22), 0.0, 0.92);
                gl_FragColor = vec4(col, alpha);
            }
        `
    });
}
window.createSimulatedExplosionPlumeMaterial = createSimulatedExplosionPlumeMaterial;

// Simulated Soft Pressure Blast-Wave Shader (Replaces hard geometric RingGeometry shockwaves!)
function createSimulatedBlastWaveMaterial(colorHex = 0xff9f1c) {
    return new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
            uColor: { value: new THREE.Color(colorHex) },
            uOpacity: { value: 0.9 }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 uColor;
            uniform float uOpacity;
            varying vec2 vUv;
            void main() {
                vec2 p = (vUv - 0.5) * 2.0;
                float r = length(p);
                if (r > 1.0) discard;
                float ang = atan(p.y, p.x);
                float turb = sin(ang * 12.0 + r * 8.0) * 0.035 + cos(ang * 7.0 - r * 6.0) * 0.025;
                float dist = r + turb;
                // Soft Mach condensation wave profile (gradual inner compression + feathered outer front)
                float waveProfile = exp(-pow((dist - 0.76) * 6.2, 2.0)) * 0.85 + exp(-dist * dist * 3.2) * 0.25;
                float edgeFade = smoothstep(1.0, 0.82, r);
                float alpha = clamp(waveProfile * edgeFade * uOpacity, 0.0, 0.95);
                vec3 col = mix(uColor, vec3(1.0, 0.97, 0.90), waveProfile * 0.45);
                gl_FragColor = vec4(col, alpha);
            }
        `
    });
}
window.createSimulatedBlastWaveMaterial = createSimulatedBlastWaveMaterial;

// 3D Sculpted Volumetric Plume & Fireball Geometries (Zero flat PlaneGeometry squares!)
const _softPlumeVolGeo = createOrganicBioCarapaceGeo(0.34, 0.30, 0.34, 5, 0.065);
const _softFireballVolGeo = createSculptedOgiveSpireGeo(0.18, 0.44, 8);
_softFireballVolGeo.rotateX(Math.PI / 2);
const _softGroundWaveGeo = createSculptedTorusCollarGeo(0.48, 0.038, 8, 22);
_softGroundWaveGeo.rotateX(-Math.PI / 2);
const _sparkStreakGeo = createSculptedOgiveSpireGeo(0.032, 0.42, 6);
_sparkStreakGeo.rotateX(Math.PI / 2);

// PRE-ALLOCATED SHARED FX GEOMETRIES & MATERIALS (Prevents WebGL Memory Leak & Crashing!)
const SHARED_FX_GEO = {
    casing: createSculptedLatheBarrelGeo(0.02, 0.02, 0.08, 6),
    goreChunk: createOrganicBioCarapaceGeo(0.085, 0.065, 0.11, 4, 0.02),
    bloodDrop: createSculptedOgiveSpireGeo(0.055, 0.18, 6),
    xenoSac: createOrganicBioCarapaceGeo(0.11, 0.09, 0.13, 5, 0.025),
    spark: _sparkStreakGeo,
    shrapnel: createExtrudedArmorHullGeo(0.14, 0.045, 0.18, 0.01, 0.03),
    smoke: _softPlumeVolGeo,
    fireBall: _softFireballVolGeo,
    shockRing: _softGroundWaveGeo,
    waterRippleRing: new THREE.RingGeometry(0.32, 0.44, 32),
    healRing: _softGroundWaveGeo,
    medicRing: _softGroundWaveGeo,
    repairHex: _softGroundWaveGeo,
    medicPulse: _softGroundWaveGeo,
    weldSpark: _sparkStreakGeo,
    splatSmall: LIQUID_SPLASH_POOL_SMALL[0],
    splatBig: LIQUID_SPLASH_POOL_BIG[0],
    splatDrop: LIQUID_SPLASH_POOL_DROP[0],
    craterRim: craterRimGeo,
    craterCenter: createDynamicLiquidSplashGeo(0.76, 10, 0.28, 1.0, 99),
    bulletProj: createSculptedLatheBarrelGeo(0.018, 0.028, 0.82, 6),
    mortarProj: createSculptedOgiveSpireGeo(0.11, 0.52, 10),
    tankSabotShell: tankSabotShellGeo,
    tankFin: createExtrudedArmorHullGeo(0.34, 0.025, 0.22, 0.004, 0.02),
    acidProj: createOrganicBioCarapaceGeo(0.13, 0.12, 0.22, 5, 0.03),
    waterDropProj: createSculptedOgiveSpireGeo(0.055, 0.24, 7)
};
SHARED_FX_GEO.waterRippleRing.rotateX(-Math.PI / 2);
SHARED_FX_GEO.bulletProj.rotateX(Math.PI / 2);
SHARED_FX_GEO.mortarProj.rotateX(Math.PI / 2);
SHARED_FX_GEO.waterDropProj.rotateX(Math.PI / 2);

const SHARED_FX_MAT = {
    smokeDark: createSimulatedExplosionPlumeMaterial(0.18, 1.1, 0.0),
    smokeGrey: createSimulatedExplosionPlumeMaterial(0.28, 2.3, 0.0),
    smokeFire: createSimulatedExplosionPlumeMaterial(0.95, 3.7, 0.0),
    shockAmber: createSimulatedBlastWaveMaterial(0xff9f1c),
    shockCyan: createSimulatedBlastWaveMaterial(0x00e5ff),
    waterRipple: new THREE.MeshBasicMaterial({ color: 0x80f0ff, side: THREE.DoubleSide, transparent: true, opacity: 0.65, depthWrite: false }),
    waterDropMat: new THREE.MeshStandardMaterial({ color: 0xbaf6ff, roughness: 0.12, metalness: 0.2, transparent: true, opacity: 0.84 }),
    repairGrid: createSimulatedBlastWaveMaterial(0x00e5ff),
    droneWeldBeam: new THREE.MeshBasicMaterial({ color: 0x38e8ff, transparent: true, opacity: 0.88, blending: THREE.AdditiveBlending, depthWrite: false }),
    droneScanRing: createSimulatedBlastWaveMaterial(0x00e5ff),
    medicBioBeam: new THREE.MeshBasicMaterial({ color: 0x34f598, transparent: true, opacity: 0.88, blending: THREE.AdditiveBlending, depthWrite: false }),
    medicBioRing: createSimulatedBlastWaveMaterial(0x00ff66),
    creepSpore: createSimulatedExplosionPlumeMaterial(0.75, 5.2, 1.0),
    splatBlood: new THREE.MeshStandardMaterial({ color: 0x6e060b, roughness: 0.16, metalness: 0.12, transparent: true, opacity: 0.92, side: THREE.DoubleSide }),
    splatCrimsonBlood: new THREE.MeshStandardMaterial({ color: 0x990614, emissive: 0x220004, roughness: 0.14, metalness: 0.15, transparent: true, opacity: 0.94, side: THREE.DoubleSide }),
    splatXenoAcid: new THREE.MeshStandardMaterial({ color: 0x56d804, emissive: 0x1f4d00, emissiveIntensity: 0.45, roughness: 0.18, metalness: 0.15, transparent: true, opacity: 0.90, side: THREE.DoubleSide }),
    splatXenoViolet: new THREE.MeshStandardMaterial({ color: 0x8b14b8, emissive: 0x320547, emissiveIntensity: 0.45, roughness: 0.18, metalness: 0.18, transparent: true, opacity: 0.88, side: THREE.DoubleSide }),
    splatScorch: new THREE.MeshBasicMaterial({ color: 0x16110e, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    craterScorch: new THREE.MeshStandardMaterial({ color: 0x241f1c, roughness: 0.92, metalness: 0.08 }),
    projBullet: new THREE.MeshBasicMaterial({ color: 0xfff0a8 }),
    projMortar: new THREE.MeshStandardMaterial({ color: 0xff9f1c, emissive: 0xff5500, emissiveIntensity: 1.5, roughness: 0.2 }),
    projTankCore: new THREE.MeshBasicMaterial({ color: 0xff5500 }),
    projTankTip: new THREE.MeshBasicMaterial({ color: 0xfff7cc }),
    projAcid: new THREE.MeshStandardMaterial({ color: 0x9ef01a, emissive: 0x55a600, emissiveIntensity: 1.35, roughness: 0.18 }),
    projBehemoth: new THREE.MeshStandardMaterial({ color: 0xd946ef, emissive: 0x86198f, emissiveIntensity: 1.35, roughness: 0.2 }),
    projRocket: new THREE.MeshStandardMaterial({ color: 0xff3b5c, emissive: 0xc81e3a, emissiveIntensity: 1.35, roughness: 0.25 }),
    shieldDome: shieldHexShaderMat,
    shieldWire: new THREE.MeshBasicMaterial({ color: 0x00e5ff, wireframe: true, transparent: true, opacity: 0.035, depthWrite: false }),
    shieldDomeWire: new THREE.MeshBasicMaterial({ color: 0x00e5ff, wireframe: true, transparent: true, opacity: 0.035, depthWrite: false }),
    mindBeam: new THREE.MeshBasicMaterial({ color: 0xe879f9, transparent: true, opacity: 0.88, blending: THREE.AdditiveBlending, depthWrite: false }),
    mindControlBeam: new THREE.MeshBasicMaterial({ color: 0xe879f9, transparent: true, opacity: 0.88, blending: THREE.AdditiveBlending, depthWrite: false }),
    mindHalo: createSimulatedBlastWaveMaterial(0xf43f5e),
    mindControlRing: createSimulatedBlastWaveMaterial(0xe879f9)
};

// ============================================================================
// COMPLETE ENVIRONMENTAL & FACTION STRUCTURE MATERIALS (PREVENTS WHITE MESHES)
// ============================================================================
const terranPlateTex = window.registerGameTexture('terranPlateTex', metalTex, false);
const normalMap = window.registerGameTexture('normalMap', metalNormalTex, true);
const concreteTex = window.registerGameTexture('concreteTex', terrainDetailTex, false);
const zergSkinTex = window.registerGameTexture('zergSkinTex', zergChitinTex, false);
const woodTex = window.registerGameTexture('woodTex', makeProceduralTexture((ctx, w, h) => {
    ctx.fillStyle = '#5c4028';
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 8) {
        ctx.fillStyle = (y % 16 === 0) ? 'rgba(32,18,8,0.42)' : 'rgba(120,86,54,0.28)';
        ctx.fillRect(0, y, w, 3);
    }
    for (let i = 0; i < 180; i++) {
        ctx.fillStyle = (i % 2 === 0) ? 'rgba(24,14,6,0.25)' : 'rgba(150,110,72,0.20)';
        ctx.fillRect((i * 37) % w, (i * 19) % h, 24, 2);
    }
}, 2, 2, 128), false);
const trimGlowTex = window.registerGameTexture('trimGlowTex', makeProceduralTexture((ctx, w, h) => {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#0ea5e9');
    grad.addColorStop(0.5, '#38bdf8');
    grad.addColorStop(1, '#0284c7');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
}, 1, 1, 64), false);
window.REGISTER_RUNTIME_TEXTURE = window.registerGameTexture;

(function registerCompleteStructureMaterials() {
    if (typeof MAT === 'undefined' || !MAT) return;
    const extraMats = {
        ruinSteelDark: new THREE.MeshStandardMaterial({ color: 0x2a313b, map: terranPlateTex, bumpMap: normalMap, bumpScale: 0.05, roughness: 0.58, metalness: 0.72 }),
        bunkerMat: new THREE.MeshStandardMaterial({ color: 0x4b5563, map: terranPlateTex, bumpMap: normalMap, bumpScale: 0.05, roughness: 0.52, metalness: 0.65 }),
        woodPlankMat: new THREE.MeshStandardMaterial({ color: 0x6b4c35, map: woodTex, bumpMap: woodTex, bumpScale: 0.04, roughness: 0.86, metalness: 0.06 }),
        ruinConcrete: new THREE.MeshStandardMaterial({ color: 0x6c727a, map: concreteTex, bumpMap: concreteTex, bumpScale: 0.05, roughness: 0.88, metalness: 0.12 }),
        ruinPlaster: new THREE.MeshStandardMaterial({ color: 0x8a8275, map: concreteTex, bumpMap: concreteTex, bumpScale: 0.04, roughness: 0.85, metalness: 0.08 }),
        ruinBrick: new THREE.MeshStandardMaterial({ color: 0x7c4333, map: concreteTex, bumpMap: concreteTex, bumpScale: 0.05, roughness: 0.84, metalness: 0.10 }),
        ruinSteel: new THREE.MeshStandardMaterial({ color: 0x475361, map: terranPlateTex, bumpMap: normalMap, bumpScale: 0.05, roughness: 0.50, metalness: 0.74 }),
        steelMat: new THREE.MeshStandardMaterial({ color: 0x566373, map: terranPlateTex, bumpMap: normalMap, bumpScale: 0.04, roughness: 0.42, metalness: 0.78 }),
        obsidianMat: new THREE.MeshStandardMaterial({ color: 0x1e222d, map: terrainDetailTex, bumpMap: normalMap, bumpScale: 0.05, roughness: 0.28, metalness: 0.45 }),
        glassMat: new THREE.MeshStandardMaterial({ color: 0x5ab4d6, map: trimGlowTex, roughness: 0.18, metalness: 0.78, emissive: 0x0c2838, emissiveIntensity: 0.35 }),
        water: new THREE.MeshStandardMaterial({ color: 0x1e5c82, map: terrainDetailTex, roughness: 0.22, metalness: 0.35 }),
        mudBank: new THREE.MeshStandardMaterial({ color: 0x4a3b2c, map: terrainDetailTex, bumpMap: terrainDetailTex, bumpScale: 0.05, roughness: 0.92, metalness: 0.05 }),
        foliagePine: new THREE.MeshStandardMaterial({ color: 0x2d4c2b, map: terrainDetailTex, roughness: 0.86, metalness: 0.04 }),
        foliageBush: new THREE.MeshStandardMaterial({ color: 0x365b2d, map: terrainDetailTex, roughness: 0.88, metalness: 0.04 }),
        mossRock: new THREE.MeshStandardMaterial({ color: 0x4b5842, map: terrainDetailTex, bumpMap: terrainDetailTex, bumpScale: 0.06, roughness: 0.88, metalness: 0.08 }),
        hazardGlow: new THREE.MeshStandardMaterial({ color: 0xff8c1a, map: trimGlowTex, emissive: 0xd95f02, emissiveIntensity: 0.85, roughness: 0.28, metalness: 0.32 }),
        canyonRock: new THREE.MeshStandardMaterial({ color: 0x7c5840, map: terrainDetailTex, bumpMap: terrainDetailTex, bumpScale: 0.06, roughness: 0.90, metalness: 0.08 }),
        trunkMat: new THREE.MeshStandardMaterial({ color: 0x523a28, map: woodTex, bumpMap: woodTex, bumpScale: 0.05, roughness: 0.90, metalness: 0.05 }),
        voidBlack: new THREE.MeshStandardMaterial({ color: 0x12151c, map: terranPlateTex, roughness: 0.75, metalness: 0.45 }),
        silver: new THREE.MeshStandardMaterial({ color: 0x9aa6b5, map: terranPlateTex, bumpMap: normalMap, bumpScale: 0.03, roughness: 0.32, metalness: 0.84 }),
        chrome: new THREE.MeshStandardMaterial({ color: 0xb0bccb, map: terranPlateTex, bumpMap: normalMap, bumpScale: 0.03, roughness: 0.24, metalness: 0.88 }),
        terranWall: new THREE.MeshStandardMaterial({ color: 0x485464, map: terranPlateTex, bumpMap: normalMap, bumpScale: 0.05, roughness: 0.48, metalness: 0.72 }),
        fleshTendon: new THREE.MeshStandardMaterial({ color: 0x6e2236, map: zergSkinTex, bumpMap: zergSkinTex, bumpScale: 0.05, roughness: 0.55, metalness: 0.14, emissive: 0x1e050d, emissiveIntensity: 0.25 }),
        rock: new THREE.MeshStandardMaterial({ color: 0x5a5f66, map: terrainDetailTex, bumpMap: terrainDetailTex, bumpScale: 0.06, roughness: 0.88, metalness: 0.10 }),
        crimson: new THREE.MeshStandardMaterial({ color: 0xb81d2a, map: terranPlateTex, emissive: 0x4a0810, emissiveIntensity: 0.35, roughness: 0.42, metalness: 0.58 }),
        medivacHull: new THREE.MeshStandardMaterial({ color: 0xd8dee6, map: terranPlateTex, bumpMap: normalMap, bumpScale: 0.04, roughness: 0.38, metalness: 0.62 }),
        medivacRed: new THREE.MeshStandardMaterial({ color: 0xc81e2b, map: terranPlateTex, bumpMap: normalMap, bumpScale: 0.03, roughness: 0.36, metalness: 0.48, emissive: 0x3a0508, emissiveIntensity: 0.22 }),
        battlecruiserHull: new THREE.MeshStandardMaterial({ color: 0x3b4656, map: terranPlateTex, bumpMap: normalMap, bumpScale: 0.05, roughness: 0.42, metalness: 0.78 }),
        battlecruiserDark: new THREE.MeshStandardMaterial({ color: 0x222934, map: terranPlateTex, bumpMap: normalMap, bumpScale: 0.05, roughness: 0.48, metalness: 0.82 })
    };
    Object.keys(extraMats).forEach((k) => {
        const m = extraMats[k];
        m.name = `MAT_${k}`;
        MAT[k] = m;
        if (window.SHADER_ENGINE) {
            window.SHADER_ENGINE.applyBuildingShader(m);
        }
        if (window.REGISTER_RUNTIME_TEXTURE && m.map) {
            window.REGISTER_RUNTIME_TEXTURE(`MAT.${k}.map`, m.map);
        }
    });
})();

// ============================================================================
// WEBGL THRUST & PARTICLE EFFECT SYSTEM (Adapted from https://ics.media/en/entry/13973/)
// Layered UV-scrolling cone mesh + additive outer shell + nozzle flare sprite
// + delta-time pooled spark emitter for aircraft & missiles
// ============================================================================
(function initThrustFxSystem() {
    // 1. Procedural longitudinal gradient + cellular plasma noise texture for UV scrolling along cone V-axis
    const thrustPlumeTex = makeProceduralTexture((ctx, w, h) => {
        const img = ctx.createImageData(w, h);
        const d = img.data;
        for (let y = 0; y < h; y++) {
            const v = y / h; // 0 = nozzle tip, 1 = tail fadeout
            const axialFade = Math.pow(Math.max(0, 1.0 - v), 1.35) * Math.min(1.0, v * 8.5);
            for (let x = 0; x < w; x++) {
                const u = (x / w) * Math.PI * 2;
                const s1 = Math.sin(u * 3.0 + v * 18.0) * 0.5 + 0.5;
                const s2 = Math.cos(u * 5.0 - v * 28.0 + Math.sin(u * 2.0) * 1.4) * 0.5 + 0.5;
                const shockDiamond = Math.pow(Math.max(0, Math.cos(v * Math.PI * 6.0)), 2.2) * 0.38;
                const streak = Math.min(1.0, (s1 * 0.52 + s2 * 0.48) * 0.85 + shockDiamond + 0.25);
                const intensity = Math.min(1.0, axialFade * streak);
                const idx = (y * w + x) * 4;
                d[idx]     = Math.min(255, Math.round(intensity * 255));
                d[idx + 1] = Math.min(255, Math.round(Math.pow(intensity, 1.15) * 245));
                d[idx + 2] = Math.min(255, Math.round(Math.pow(intensity, 1.35) * 255));
                d[idx + 3] = Math.min(255, Math.round(intensity * 255));
            }
        }
        ctx.putImageData(img, 0, 0);
    }, 1, 2, 'thrustPlumeTex');

    // 2. Soft radial billboard flare texture for engine nozzle bloom
    const thrustFlareTex = makeProceduralTexture((ctx, w, h) => {
        const cx = w * 0.5, cy = h * 0.5, rMax = w * 0.5;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rMax);
        grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
        grad.addColorStop(0.28, 'rgba(190, 235, 255, 0.85)');
        grad.addColorStop(0.62, 'rgba(80, 175, 255, 0.32)');
        grad.addColorStop(1.0, 'rgba(0, 0, 0, 0.0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
    }, 1, 1, 'thrustFlareTex');

    const coreConeGeo = new THREE.CylinderGeometry(0.08, 0.24, 1.0, 12, 1, true);
    coreConeGeo.translate(0, -0.5, 0);
    coreConeGeo.rotateX(Math.PI / 2); // Extends along -Z local axis

    const outerConeGeo = new THREE.CylinderGeometry(0.13, 0.38, 1.28, 12, 1, true);
    outerConeGeo.translate(0, -0.64, 0);
    outerConeGeo.rotateX(Math.PI / 2);

    const activeAssemblies = new Set();

    const THRUST_FX_SYSTEM = {
        thrustPlumeTex,
        thrustFlareTex,
        activeAssemblies,
        createThrusterAssembly(opts = {}) {
            const coreColor = opts.coreColor !== undefined ? opts.coreColor : 0x7ce8ff;
            const glowColor = opts.glowColor !== undefined ? opts.glowColor : 0x1e88ff;
            const radius = opts.radius || 0.22;
            const length = opts.length || 0.95;
            const scrollSpeed = opts.scrollSpeed || 4.8;

            const group = new THREE.Group();
            group.name = opts.name || 'ThrusterPlumeAssembly';

            const clonedTex = thrustPlumeTex.clone();
            clonedTex.wrapS = THREE.RepeatWrapping;
            clonedTex.wrapT = THREE.RepeatWrapping;
            clonedTex.needsUpdate = true;

            const coreMat = new THREE.MeshBasicMaterial({
                color: coreColor,
                map: clonedTex,
                transparent: true,
                opacity: 0.92,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide
            });
            const outerMat = new THREE.MeshBasicMaterial({
                color: glowColor,
                map: clonedTex,
                transparent: true,
                opacity: 0.48,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide
            });

            const coreMesh = new THREE.Mesh(coreConeGeo, coreMat);
            coreMesh.scale.set(radius / 0.16, radius / 0.16, length);
            group.add(coreMesh);

            const outerMesh = new THREE.Mesh(outerConeGeo, outerMat);
            outerMesh.scale.set(radius / 0.16, radius / 0.16, length * 1.15);
            group.add(outerMesh);

            const flareMat = new THREE.SpriteMaterial({
                map: thrustFlareTex,
                color: coreColor,
                transparent: true,
                opacity: 0.85,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });
            const flareSprite = new THREE.Sprite(flareMat);
            flareSprite.scale.set(radius * 3.1, radius * 3.1, 1.0);
            group.add(flareSprite);

            group.userData.isThrustAssembly = true;
            group.userData.scrollTex = clonedTex;
            group.userData.coreMesh = coreMesh;
            group.userData.outerMesh = outerMesh;
            group.userData.flareSprite = flareSprite;
            group.userData.baseRadius = radius;
            group.userData.baseLength = length;
            group.userData.scrollSpeed = scrollSpeed;
            group.userData.throttle = 1.0;
            group.userData.phase = Math.random() * Math.PI * 2;

            activeAssemblies.add(group);
            return group;
        },
        setThrottle(group, throttle = 1.0) {
            if (!group || !group.userData || !group.userData.isThrustAssembly) return;
            group.userData.throttle = THREE.MathUtils.clamp(throttle, 0.25, 2.2);
        },
        update(dt = 0.016, timeSec = 0) {
            const safeDt = Math.min(0.05, Math.max(0.001, dt));
            activeAssemblies.forEach((grp) => {
                if (!grp || !grp.parent) {
                    activeAssemblies.delete(grp);
                    return;
                }
                if (!grp.visible) return;
                const ud = grp.userData;
                if (ud.scrollTex) {
                    ud.scrollTex.offset.y = (ud.scrollTex.offset.y - safeDt * ud.scrollSpeed * (0.8 + ud.throttle * 0.45)) % 1.0;
                }
                const pulse = 1.0 + 0.14 * Math.sin(timeSec * 28.0 + ud.phase) + 0.08 * Math.cos(timeSec * 43.0 - ud.phase);
                const rScale = (ud.baseRadius / 0.16) * (0.85 + 0.18 * ud.throttle) * (0.94 + 0.06 * pulse);
                const lScale = ud.baseLength * ud.throttle * pulse;
                if (ud.coreMesh) ud.coreMesh.scale.set(rScale, rScale, lScale);
                if (ud.outerMesh) ud.outerMesh.scale.set(rScale * 1.12, rScale * 1.12, lScale * 1.18);
                if (ud.flareSprite) {
                    const fs = ud.baseRadius * (2.8 + 0.55 * ud.throttle * pulse);
                    ud.flareSprite.scale.set(fs, fs, 1.0);
                }
            });
        }
    };

    window.THRUST_FX_SYSTEM = THRUST_FX_SYSTEM;
})();




