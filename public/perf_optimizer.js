// ============================================================================
// STARBLOCK — REAL-TIME PERFORMANCE PROFILER, ADAPTIVE QUALITY & MEMORY ENGINE
// Provides:
// 1. window.PERF_PROFILER: Subsystem execution timers, rolling p95/avg/max
//    frame telemetry, Three.js renderer memory/draw-call tracking, and F9 HUD.
// 2. window.PERF_MANAGER: Hysteresis-based Adaptive Quality & Frame-Pacing
//    engine (AUTO, ULTRA, HIGH, BALANCED, PERFORMANCE) for smooth mobile &
//    desktop Endless Mode battles with hundreds of active units.
// 3. window.disposeHierarchy: Safe recursive Three.js GPU resource disposal
//    that preserves shared material/geometry pools (MAT, SHARED_FX_GEO, etc.).
// ============================================================================
(function () {
    'use strict';

    const SUBSYSTEM_KEYS = [
        'unitAI',
        'enemyAI',
        'targetAcquisition',
        'pathfindingAStar',
        'collisionResolution',
        'airSeparation',
        'fogOfWar',
        'minimapRender',
        'unitAnimations',
        'domHealthBarProjection',
        'projectilesAndFX',
        'corpsesAndDebris',
        'weatherAndShaders',
        'portrait3D',
        'renderScene'
    ];

    const RING_SIZE = 120;
    const frameTimes = new Float32Array(RING_SIZE);
    let frameCursor = 0;
    let frameSamples = 0;

    const subsystemStarts = Object.create(null);
    const subsystemAccum = Object.create(null);
    const subsystemAvg = Object.create(null);

    for (let i = 0; i < SUBSYSTEM_KEYS.length; i++) {
        const k = SUBSYSTEM_KEYS[i];
        subsystemStarts[k] = 0;
        subsystemAccum[k] = 0;
        subsystemAvg[k] = 0;
    }

    const PERF_PROFILER = {
        enabled: true,
        hudVisible: false,
        hudEl: null,
        lastHudUpdate: 0,
        frameCount: 0,
        frameStartMs: 0,
        lastFrameMs: 16.6,
        avgFrameMs: 16.6,
        p95FrameMs: 16.6,
        maxFrameMs: 16.6,
        fps: 60,
        drawCalls: 0,
        triangles: 0,
        geometries: 0,
        textures: 0,
        counts: {
            units: 0,
            enemies: 0,
            buildings: 0,
            projectiles: 0,
            particles: 0
        },

        beginFrame(now) {
            this.frameCount = (this.frameCount + 1) | 0;
            this.frameStartMs = performance.now();
            for (let i = 0; i < SUBSYSTEM_KEYS.length; i++) {
                subsystemAccum[SUBSYSTEM_KEYS[i]] = 0;
            }
        },

        begin(name) {
            const key = name === 'unitAnimation' ? 'unitAnimations' : (name === 'groundNavigation' ? 'pathfindingAStar' : name);
            subsystemStarts[key] = performance.now();
        },

        end(name) {
            const key = name === 'unitAnimation' ? 'unitAnimations' : (name === 'groundNavigation' ? 'pathfindingAStar' : name);
            const st = subsystemStarts[key];
            if (st > 0) {
                subsystemAccum[key] = (subsystemAccum[key] || 0) + (performance.now() - st);
                subsystemStarts[key] = 0;
            }
        },

        addSample(name, durationMs) {
            const key = name === 'unitAnimation' ? 'unitAnimations' : (name === 'groundNavigation' ? 'pathfindingAStar' : name);
            subsystemAccum[key] = (subsystemAccum[key] || 0) + durationMs;
        },

        endFrame(renderer, entityCounts) {
            const now = performance.now();
            const dtMs = Math.max(0.1, now - (this.frameStartMs || now));
            this.lastFrameMs = dtMs;

            frameTimes[frameCursor] = dtMs;
            frameCursor = (frameCursor + 1) % RING_SIZE;
            if (frameSamples < RING_SIZE) frameSamples++;

            // Exponential moving average for subsystem timings
            for (let i = 0; i < SUBSYSTEM_KEYS.length; i++) {
                const k = SUBSYSTEM_KEYS[i];
                const cur = subsystemAccum[k] || 0;
                subsystemAvg[k] = subsystemAvg[k] * 0.88 + cur * 0.12;
            }

            // Compute rolling avg, max, and p95 every 12 frames to avoid sorting overhead
            if ((frameCursor & 15) === 0 && frameSamples > 4) {
                let sum = 0;
                let maxV = 0;
                const sorted = [];
                for (let i = 0; i < frameSamples; i++) {
                    const v = frameTimes[i];
                    sum += v;
                    if (v > maxV) maxV = v;
                    sorted.push(v);
                }
                sorted.sort((a, b) => a - b);
                const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
                this.avgFrameMs = sum / frameSamples;
                this.maxFrameMs = maxV;
                this.p95FrameMs = sorted[p95Idx];
                this.fps = Math.min(144, Math.round(1000 / Math.max(1, this.avgFrameMs)));
            } else {
                this.avgFrameMs = this.avgFrameMs * 0.92 + dtMs * 0.08;
                this.fps = Math.min(144, Math.round(1000 / Math.max(1, this.avgFrameMs)));
            }

            if (renderer && renderer.info) {
                if (renderer.info.render) {
                    this.drawCalls = renderer.info.render.calls || 0;
                    this.triangles = renderer.info.render.triangles || 0;
                }
                if (renderer.info.memory) {
                    this.geometries = renderer.info.memory.geometries || 0;
                    this.textures = renderer.info.memory.textures || 0;
                }
            }

            if (entityCounts) {
                this.counts.units = entityCounts.units || 0;
                this.counts.enemies = entityCounts.enemies || 0;
                this.counts.buildings = entityCounts.buildings || 0;
                this.counts.projectiles = entityCounts.projectiles || 0;
                this.counts.particles = entityCounts.particles || 0;
            }

            if (this.hudVisible && now - this.lastHudUpdate > 240) {
                this.lastHudUpdate = now;
                this.renderHUD();
            }
        },

        getReport() {
            const sub = {};
            for (let i = 0; i < SUBSYSTEM_KEYS.length; i++) {
                const k = SUBSYSTEM_KEYS[i];
                sub[k] = Number((subsystemAvg[k] || 0).toFixed(2));
            }
            return {
                fps: this.fps,
                avgFrameMs: Number(this.avgFrameMs.toFixed(2)),
                p95FrameMs: Number(this.p95FrameMs.toFixed(2)),
                maxFrameMs: Number(this.maxFrameMs.toFixed(2)),
                qualityPreset: window.PERF_MANAGER ? window.PERF_MANAGER.activePreset : 'HIGH',
                qualityMode: window.PERF_MANAGER ? window.PERF_MANAGER.mode : 'AUTO',
                drawCalls: this.drawCalls,
                triangles: this.triangles,
                geometries: this.geometries,
                textures: this.textures,
                counts: { ...this.counts },
                subsystems: sub
            };
        },

        ensureHUD() {
            if (this.hudEl) return this.hudEl;
            const el = document.createElement('div');
            el.id = 'starblock-perf-hud';
            el.style.cssText = [
                'position:fixed',
                'top:54px',
                'left:10px',
                'z-index:9999',
                'background:rgba(4,10,20,0.9)',
                'border:1px solid rgba(0,229,255,0.45)',
                'color:#e2f1ff',
                'font:600 10.5px/1.35 "JetBrains Mono",monospace',
                'padding:8px 10px',
                'pointer-events:none',
                'min-width:230px',
                'display:none',
                'box-shadow:0 6px 20px rgba(0,0,0,0.65)'
            ].join(';');
            document.body.appendChild(el);
            this.hudEl = el;
            return el;
        },

        toggleHUD(forceState) {
            const el = this.ensureHUD();
            this.hudVisible = typeof forceState === 'boolean' ? forceState : !this.hudVisible;
            el.style.display = this.hudVisible ? 'block' : 'none';
            if (this.hudVisible) this.renderHUD();
            return this.hudVisible;
        },

        renderHUD() {
            const el = this.ensureHUD();
            const r = this.getReport();
            const fpsColor = r.fps >= 52 ? '#00ff66' : (r.fps >= 35 ? '#ffaa00' : '#ff2a4b');
            el.innerHTML =
                `<div style="color:#00e5ff;font-weight:800;margin-bottom:3px;border-bottom:1px solid rgba(0,229,255,0.25);padding-bottom:2px;">` +
                `STARBLOCK TELEMETRY [F9] · ${r.qualityMode}/${r.qualityPreset}</div>` +
                `<div>FPS: <span style="color:${fpsColor};font-weight:800;">${r.fps}</span> ` +
                `(${r.avgFrameMs}ms avg · ${r.p95FrameMs}ms p95)</div>` +
                `<div>GPU: ${r.drawCalls} calls · ${(r.triangles / 1000).toFixed(1)}k tris · ${r.geometries} geo</div>` +
                `<div>ENT: ${r.counts.units} ally · ${r.counts.enemies} zerg · ${r.counts.projectiles} proj · ${r.counts.particles} fx</div>` +
                `<div style="margin-top:4px;color:#93b4d8;">` +
                `unitAI: ${r.subsystems.unitAI}ms | zergAI: ${r.subsystems.enemyAI}ms<br>` +
                `target: ${r.subsystems.targetAcquisition}ms | A*: ${r.subsystems.pathfindingAStar}ms<br>` +
                `collis: ${r.subsystems.collisionResolution}ms | anim: ${r.subsystems.unitAnimations}ms<br>` +
                `fow: ${r.subsystems.fogOfWar}ms | minimap: ${r.subsystems.minimapRender}ms<br>` +
                `domHP: ${r.subsystems.domHealthBarProjection}ms | render: ${r.subsystems.renderScene}ms` +
                `</div>`;
        }
    };

    // Keyboard shortcut F10 to toggle telemetry overlay (F9 is reserved for Error Monitor)
    window.addEventListener('keydown', (e) => {
        if (e.key === 'F10') {
            e.preventDefault();
            PERF_PROFILER.toggleHUD();
        }
    });

    // ============================================================================
    // ADAPTIVE QUALITY & FRAME-PACING ENGINE
    // Automatically scales pixel ratio, shadow updates, particle/corpse budgets,
    // A* path cache TTL, AI stride, and DOM projection stride on mobile & heavy
    // Endless Mode waves while preventing oscillation via hysteresis timers.
    // ============================================================================
    const isMobileDevice = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') || (window.innerWidth <= 900);

    const QUALITY_PRESETS = {
        ULTRA: {
            name: 'ULTRA',
            tierIndex: 0,
            dprCap: isMobileDevice ? 1.5 : 2.0,
            shadowsEnabled: true,
            shadowUpdateStride: 1,
            maxParticles: 165,
            maxSmoke: 55,
            maxCasings: 36,
            maxShockwaves: 32,
            maxCorpses: 60,
            maxDebris: 75,
            particleBudgetScale: 1.0,
            particleSpawnRateMult: 1.0,
            thrusterIntervalScale: 1.0,
            animCloseDistSq: 2800,
            animNormalDistSq: 7200,
            animFarDistSq: 16000,
            fowInterval: 0.085,
            minimapInterval: 0.14,
            portraitInterval: 0.055,
            pathRecomputeTTL: 0.55,
            aiDecisionStride: 1,
            animFarStride: 2,
            domProjectionStride: 1
        },
        HIGH: {
            name: 'HIGH',
            tierIndex: 0,
            dprCap: isMobileDevice ? 1.35 : 1.75,
            shadowsEnabled: !isMobileDevice,
            shadowUpdateStride: 2,
            maxParticles: 120,
            maxSmoke: 40,
            maxCasings: 24,
            maxShockwaves: 24,
            maxCorpses: 44,
            maxDebris: 55,
            particleBudgetScale: 0.85,
            particleSpawnRateMult: 0.82,
            thrusterIntervalScale: 1.35,
            animCloseDistSq: 2400,
            animNormalDistSq: 6200,
            animFarDistSq: 14500,
            fowInterval: 0.095,
            minimapInterval: 0.16,
            portraitInterval: 0.065,
            pathRecomputeTTL: 0.68,
            aiDecisionStride: 1,
            animFarStride: 2,
            domProjectionStride: 1
        },
        BALANCED: {
            name: 'BALANCED',
            tierIndex: 1,
            dprCap: isMobileDevice ? 1.15 : 1.4,
            shadowsEnabled: false,
            shadowUpdateStride: 3,
            maxParticles: 85,
            maxSmoke: 26,
            maxCasings: 14,
            maxShockwaves: 16,
            maxCorpses: 28,
            maxDebris: 36,
            particleBudgetScale: 0.65,
            particleSpawnRateMult: 0.62,
            thrusterIntervalScale: 1.85,
            animCloseDistSq: 1800,
            animNormalDistSq: 4800,
            animFarDistSq: 12000,
            fowInterval: 0.115,
            minimapInterval: 0.20,
            portraitInterval: 0.085,
            pathRecomputeTTL: 0.85,
            aiDecisionStride: 2,
            animFarStride: 3,
            domProjectionStride: 2
        },
        PERFORMANCE: {
            name: 'PERFORMANCE',
            tierIndex: 2,
            dprCap: 1.0,
            shadowsEnabled: false,
            shadowUpdateStride: 4,
            maxParticles: 55,
            maxSmoke: 16,
            maxCasings: 8,
            maxShockwaves: 10,
            maxCorpses: 16,
            maxDebris: 20,
            particleBudgetScale: 0.45,
            particleSpawnRateMult: 0.42,
            thrusterIntervalScale: 2.6,
            animCloseDistSq: 1200,
            animNormalDistSq: 3600,
            animFarDistSq: 9500,
            fowInterval: 0.14,
            minimapInterval: 0.25,
            portraitInterval: 0.11,
            pathRecomputeTTL: 1.05,
            aiDecisionStride: 3,
            animFarStride: 4,
            domProjectionStride: 3
        }
    };

    const TIER_ORDER = ['ULTRA', 'HIGH', 'BALANCED', 'PERFORMANCE'];
    const initialPresetObj = { ...(isMobileDevice ? QUALITY_PRESETS.BALANCED : QUALITY_PRESETS.HIGH) };

    const PERF_MANAGER = {
        mode: 'AUTO',
        activePreset: isMobileDevice ? 'BALANCED' : 'HIGH',
        currentConfig: initialPresetObj,
        current: initialPresetObj,
        frameNumber: 0,
        frameCounter: 0,
        lastSwitchTime: 0,
        highLoadAccum: 0,
        lowLoadAccum: 0,
        appliedDpr: 0,

        setPreset(presetName, renderer) {
            const upper = String(presetName || 'AUTO').toUpperCase();
            if (upper === 'AUTO') {
                this.mode = 'AUTO';
                this.applyTier(this.activePreset, renderer);
            } else if (QUALITY_PRESETS[upper]) {
                this.mode = upper;
                this.applyTier(upper, renderer);
            }
            return this.currentConfig;
        },

        applyTier(tierName, rendererArg) {
            const upper = String(tierName || 'HIGH').toUpperCase();
            const mappedKey = upper === 'LOW' || upper === 'LOW-END' ? 'PERFORMANCE' : (upper === 'MOBILE' ? 'BALANCED' : upper);
            const preset = QUALITY_PRESETS[mappedKey] || QUALITY_PRESETS.HIGH;
            this.activePreset = preset.name;
            this.currentConfig = { ...preset };
            this.current = this.currentConfig;

            const targetRenderer = rendererArg || (typeof renderer !== 'undefined' ? renderer : null);
            if (targetRenderer && typeof targetRenderer.setPixelRatio === 'function') {
                const rawDpr = window.devicePixelRatio || 1;
                const targetDpr = Math.min(rawDpr, preset.dprCap);
                if (Math.abs(targetDpr - this.appliedDpr) > 0.04) {
                    this.appliedDpr = targetDpr;
                    targetRenderer.setPixelRatio(targetDpr);
                }
                if (targetRenderer.shadowMap) {
                    const nextShadow = !!preset.shadowsEnabled;
                    const shadowChanged = (targetRenderer.shadowMap.enabled !== nextShadow)
                        || (typeof dirLight !== 'undefined' && dirLight && dirLight.castShadow !== nextShadow);
                    targetRenderer.shadowMap.enabled = nextShadow;
                    if (typeof dirLight !== 'undefined' && dirLight) {
                        dirLight.castShadow = nextShadow;
                    }
                    if (shadowChanged && typeof scene !== 'undefined' && scene) {
                        scene.traverse(obj => {
                            if (obj && obj.isMesh && obj.material) {
                                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                                mats.forEach(m => { if (m) m.needsUpdate = true; });
                            }
                        });
                    }
                }
            }
        },

        update(dt, arg2, arg3, arg4) {
            this.frameNumber = (this.frameNumber + 1) | 0;
            this.frameCounter = this.frameNumber;

            // Support both (dt, renderer, profiler) and (dt, now, renderer, totalCombatants)
            let renderer = null;
            let now = performance.now();
            let totalCombatants = 0;

            if (arg2 && typeof arg2.setPixelRatio === 'function') {
                renderer = arg2;
                if (arg3 && arg3.counts) {
                    totalCombatants = (arg3.counts.units || 0) + (arg3.counts.enemies || 0);
                }
            } else {
                if (typeof arg2 === 'number' && Number.isFinite(arg2)) now = arg2;
                if (arg3 && typeof arg3.setPixelRatio === 'function') renderer = arg3;
                if (typeof arg4 === 'number') totalCombatants = arg4;
            }

            if (this.appliedDpr === 0 && renderer) {
                this.applyTier(this.activePreset, renderer);
            }

            if (this.mode !== 'AUTO') return this.currentConfig;

            const avgMs = PERF_PROFILER.avgFrameMs;
            const combatLoadHigh = (totalCombatants || 0) > 130;

            if (avgMs > 20.5 || (combatLoadHigh && avgMs > 18.2)) {
                this.highLoadAccum += dt;
                this.lowLoadAccum = Math.max(0, this.lowLoadAccum - dt * 0.5);
            } else if (avgMs < 14.2 && !combatLoadHigh) {
                this.lowLoadAccum += dt;
                this.highLoadAccum = Math.max(0, this.highLoadAccum - dt * 0.5);
            } else {
                this.highLoadAccum = Math.max(0, this.highLoadAccum - dt * 0.25);
                this.lowLoadAccum = Math.max(0, this.lowLoadAccum - dt * 0.25);
            }

            const sinceSwitch = (now - this.lastSwitchTime) * 0.001;
            if (sinceSwitch < 2.5) return this.currentConfig;

            const curIdx = TIER_ORDER.indexOf(this.activePreset);
            if (this.highLoadAccum >= 1.6 && curIdx < TIER_ORDER.length - 1) {
                this.highLoadAccum = 0;
                this.lowLoadAccum = 0;
                this.lastSwitchTime = now;
                this.applyTier(TIER_ORDER[curIdx + 1], renderer);
            } else if (this.lowLoadAccum >= 4.5 && curIdx > (isMobileDevice ? 1 : 0)) {
                this.highLoadAccum = 0;
                this.lowLoadAccum = 0;
                this.lastSwitchTime = now;
                this.applyTier(TIER_ORDER[curIdx - 1], renderer);
            }

            return this.currentConfig;
        }
    };

    // Safe GPU hierarchy disposal helper that avoids disposing shared material/geometry pools
    function isSharedResource(res) {
        if (!res) return true;
        if (res.userData && res.userData.shared) return true;
        if (window.MAT) {
            for (const k in window.MAT) {
                if (window.MAT[k] === res) return true;
            }
        }
        if (window.SHARED_FX_GEO) {
            for (const k in window.SHARED_FX_GEO) {
                if (window.SHARED_FX_GEO[k] === res) return true;
            }
        }
        if (window.SHARED_FX_MAT) {
            for (const k in window.SHARED_FX_MAT) {
                if (window.SHARED_FX_MAT[k] === res) return true;
            }
        }
        return false;
    }

    function disposeHierarchy(rootObj, parentScene) {
        if (!rootObj) return;
        const sc = parentScene || window.scene;
        if (sc && rootObj.parent === sc) {
            sc.remove(rootObj);
        } else if (rootObj.parent) {
            rootObj.parent.remove(rootObj);
        }
        rootObj.traverse((child) => {
            if (child.geometry && !isSharedResource(child.geometry)) {
                try { child.geometry.dispose(); } catch (_) {}
            }
            if (child.material) {
                if (Array.isArray(child.material)) {
                    for (let i = 0; i < child.material.length; i++) {
                        const m = child.material[i];
                        if (m && !isSharedResource(m)) {
                            try { m.dispose(); } catch (_) {}
                        }
                    }
                } else if (!isSharedResource(child.material)) {
                    try { child.material.dispose(); } catch (_) {}
                }
            }
        });
    }

    // Preserve backwards-compatible methods expected by textures-scene.js and game.js callers
    if (typeof PERF_PROFILER.getSummary !== 'function') {
        PERF_PROFILER.getSummary = function getSummary() {
            const rep = this.getReport();
            return rep ? rep.subsystems : {};
        };
    }
    if (typeof PERF_MANAGER.applyTier !== 'function') {
        PERF_MANAGER.applyTier = function applyTier(tierName) {
            return this.setPreset(tierName);
        };
    }

    window.PERF_PROFILER = PERF_PROFILER;
    window.PERF_MANAGER = PERF_MANAGER;
    if (typeof window.disposeHierarchy !== 'function') {
        window.disposeHierarchy = disposeHierarchy;
    }
})();
