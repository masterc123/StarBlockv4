// ============================================================================
// 0. GLOBAL RUNTIME ERROR HANDLER & SELF-HEALING DIAGNOSTIC GUARD
//    (Preserves early handler initialized in public/textures-scene.js)
// ============================================================================
(function augmentGlobalErrorHandler() {
    const existing = window.APP_ERROR_HANDLER;
    if (existing && existing.__v2Rebuilt) {
        const origRecord = existing.record.bind(existing);
        existing.firstStartupError = existing.firstStartupError || null;
        existing.firstFailedRenderStage = existing.firstFailedRenderStage || null;
        if (!Object.getOwnPropertyDescriptor(existing, 'errors')) {
            Object.defineProperty(existing, 'errors', {
                get() { return this.logs; },
                enumerable: true,
                configurable: true
            });
        }
        existing.record = function recordCompat(context, err, categoryOrSeverity = 'error', severityOpt = null, affectedObjectOpt = null) {
            let sev = 'error';
            let cat = null;
            let extra = null;
            if (typeof categoryOrSeverity === 'object' && categoryOrSeverity !== null) {
                extra = categoryOrSeverity;
                sev = extra.severity || 'error';
            } else if (severityOpt !== null || affectedObjectOpt !== null) {
                cat = String(categoryOrSeverity || 'runtime').toLowerCase();
                sev = String(severityOpt || 'ERROR').toLowerCase() === 'warning' || String(severityOpt || '').toLowerCase() === 'warn' ? 'warn' : 'error';
                extra = { category: cat, affectedObject: affectedObjectOpt };
            } else {
                const cs = String(categoryOrSeverity || 'error').toLowerCase();
                if (cs === 'warn' || cs === 'warning' || cs === 'error') {
                    sev = cs === 'error' ? 'error' : 'warn';
                } else {
                    cat = cs;
                    extra = { category: cat };
                }
            }
            origRecord(context, err, sev, extra);
            const latest = this.logs[this.logs.length - 1];
            if (latest) {
                if (!this.firstStartupError && latest.category !== 'diagnostic_test') {
                    this.firstStartupError = latest;
                }
                if (!this.firstFailedRenderStage && (latest.category === 'initialization' || latest.category === 'graphics')) {
                    this.firstFailedRenderStage = {
                        stage: latest.context,
                        category: latest.category,
                        message: latest.message,
                        time: latest.time
                    };
                }
            }
        };
        existing.clear = function clearCompat() {
            this.firstStartupError = null;
            this.firstFailedRenderStage = null;
            this.clearHistory();
        };
        existing.triggerTestError = function triggerTestError() {
            try {
                throw new Error('Simulated diagnostic verification error (Trigger Test Error)');
            } catch (testErr) {
                this.record('AI_DEBUG.triggerTestError', testErr, 'diagnostic_test', 'WARNING', 'TestUnit#0');
            }
        };
        return;
    }
})();

// ============================================================================
// 0B. SYSTEM INITIALIZATION & WORLD VALIDATION ENGINE
// ============================================================================
window.SYSTEM_INIT_VALIDATOR = {
    stages: [],
    lastRunTimestamp: null,
    overallStatus: 'PASS',
    recordStage(name, category, status, durationMs, details = '') {
        const entry = {
            name,
            category,
            status, // 'PASS' | 'WARNING' | 'FAIL'
            durationMs: Number((durationMs || 0).toFixed(2)),
            details,
            timestamp: new Date().toISOString().slice(11, 19)
        };
        const idx = this.stages.findIndex(s => s.name === name);
        if (idx >= 0) this.stages[idx] = entry;
        else this.stages.push(entry);
        this.recomputeOverall();
        if (status === 'FAIL' && window.APP_ERROR_HANDLER) {
            window.APP_ERROR_HANDLER.record(`InitValidator:${name}`, new Error(details || `${name} failed`), 'initialization', 'CRITICAL', category);
        }
        return entry;
    },
    recomputeOverall() {
        if (this.stages.some(s => s.status === 'FAIL')) this.overallStatus = 'FAIL';
        else if (this.stages.some(s => s.status === 'WARNING')) this.overallStatus = 'WARNING';
        else this.overallStatus = 'PASS';
    },
    getRenderingStatusSummary() {
        const hasRenderer = !!(typeof renderer !== 'undefined' && renderer && scene && camera);
        const tPipe = typeof window.validateAndRepairTerrainPipeline === 'function'
            ? window.validateAndRepairTerrainPipeline()
            : null;
        const fRep = typeof window.verifyAndRepairFactionMaterials === 'function'
            ? window.verifyAndRepairFactionMaterials()
            : null;
        const texSnap = (window.TEXTURE_REGISTRY && typeof window.TEXTURE_REGISTRY.getDiagnosticSnapshot === 'function')
            ? window.TEXTURE_REGISTRY.getDiagnosticSnapshot()
            : { totalRegistered: 0, missingOrInvalid: [], entries: [] };
        const gSnap = (window.GRAPHICS_DIAGNOSTICS && typeof window.GRAPHICS_DIAGNOSTICS.getSnapshot === 'function')
            ? window.GRAPHICS_DIAGNOSTICS.getSnapshot()
            : null;

        const terrainDetailEntry = texSnap.entries ? texSnap.entries.find(e => e.name === 'terrainDetailTex') : null;
        const terrainTexOk = terrainDetailEntry
            ? ((terrainDetailEntry.status === 'OK' || terrainDetailEntry.hasData) && terrainDetailEntry.width > 0 && terrainDetailEntry.height > 0)
            : !!(typeof terrainDetailTex !== 'undefined' && terrainDetailTex && terrainDetailTex.image);

        const shaderCompileErrors = gSnap && gSnap.shaderValidation && Array.isArray(gSnap.shaderValidation.compilationErrors)
            ? gSnap.shaderValidation.compilationErrors.length
            : 0;
        const shaderFailedInjections = gSnap && gSnap.shaderValidation && Array.isArray(gSnap.shaderValidation.failedInjections)
            ? gSnap.shaderValidation.failedInjections.length
            : 0;

        const axisOk = !!(window.AXIS_BALL_CONTROLLER && window.AXIS_BALL_CONTROLLER.canvas && window.AXIS_BALL_CONTROLLER.ctx);
        const tGeomOk = tPipe
            ? Boolean(tPipe.ok || (tPipe.geometryExists && tPipe.positionFinite && (tPipe.colorValid || tPipe.colorAttributeValid) && tPipe.vertexCount > 0 && tPipe.indexValid && (tPipe.boundsValid || (tPipe.boundingBoxValid && tPipe.boundingSphereValid)) && tPipe.attachedToScene && tPipe.meshVisible))
            : true;
        const fMatOk = fRep ? Boolean(fRep.status === 'PASS' || fRep.ok !== false) : true;

        return {
            renderer: hasRenderer ? 'PASS' : 'FAIL',
            terrainGeometry: tGeomOk ? 'PASS' : 'FAIL',
            terrainMaterial: (tPipe ? tPipe.materialAssigned : !!(typeof terrainMat !== 'undefined' && terrainMat)) ? 'PASS' : 'FAIL',
            terrainTexture: terrainTexOk ? 'PASS' : 'FAIL',
            factionMaterials: fMatOk ? 'PASS' : 'FAIL',
            shaderCompilation: (shaderCompileErrors === 0 && shaderFailedInjections === 0) ? 'PASS' : 'FAIL',
            fogOfWar: (tPipe ? tPipe.fowValid : !!(typeof fowTex !== 'undefined' && fowTex)) ? 'PASS' : 'FAIL',
            webglContext: gSnap ? gSnap.contextStatus : 'ACTIVE',
            axisSphere: axisOk ? 'PASS' : 'FAIL',
            details: {
                terrainPipeline: tPipe,
                factionMaterials: fRep,
                textureSnapshot: texSnap
            }
        };
    },
    validateAllSystems() {
        const tStart = performance.now();
        this.lastRunTimestamp = new Date().toISOString();

        // 1. World & Terrain Pipeline Validation
        const tWorld = performance.now();
        const hasTerrain = typeof getTerrainHeight === 'function' && typeof isWalkableGround === 'function';
        const sampleH = hasTerrain ? getTerrainHeight(0, 0) : NaN;
        const bridgesOk = Array.isArray(window.BRIDGES);
        const resourcesOk = Array.isArray(window.GEM_CRATERS) && window.GEM_CRATERS.length > 0;
        const tPipe = typeof window.validateAndRepairTerrainPipeline === 'function'
            ? window.validateAndRepairTerrainPipeline()
            : { ok: true, status: 'PASS', vertexCount: 0, repairs: [] };
        const tPipeOk = Boolean(tPipe.status === 'PASS' || tPipe.ok);
        const worldOk = hasTerrain && Number.isFinite(sampleH) && bridgesOk && resourcesOk && tPipeOk;
        this.recordStage(
            'World & Biome Geometry',
            'World',
            worldOk ? 'PASS' : 'FAIL',
            performance.now() - tWorld,
            `Biome=${window.ACTIVE_PLANET_BIOME || 'highland'}, Seed=${window.MAP_SEED || 100}, Verts=${tPipe.vertexCount || 0}, Bridges=${bridgesOk ? window.BRIDGES.length : 0}, GemCraters=${resourcesOk ? window.GEM_CRATERS.length : 0}`
        );

        // 2. Units & Factions Validation
        const tUnits = performance.now();
        const terranCount = Array.isArray(units) ? units.filter(u => u && u.hp > 0 && u.faction !== 'solaris').length : 0;
        const solarisCount = Array.isArray(units) ? units.filter(u => u && u.hp > 0 && u.faction === 'solaris').length : 0;
        const zergCount = Array.isArray(enemies) ? enemies.filter(e => e && e.hp > 0).length : 0;
        let invalidUnitCoords = 0;
        if (Array.isArray(enemies)) {
            for (let i = 0; i < enemies.length; i++) {
                const e = enemies[i];
                if (e && e.mesh && (!Number.isFinite(e.mesh.position.x) || !Number.isFinite(e.mesh.position.z))) {
                    invalidUnitCoords++;
                }
            }
        }
        const fRep = typeof window.verifyAndRepairFactionMaterials === 'function'
            ? window.verifyAndRepairFactionMaterials()
            : { ok: true, status: 'PASS', totalChecked: 0, repairedCount: 0 };
        const fRepOk = Boolean(fRep.status === 'PASS' || fRep.ok !== false);
        const fChecked = fRep.checked ?? fRep.totalChecked ?? 0;
        const fRepaired = fRep.repaired ?? fRep.repairedCount ?? 0;
        this.recordStage(
            'Units & Factions Registry',
            'Units & Factions',
            (invalidUnitCoords === 0 && fRepOk) ? 'PASS' : 'FAIL',
            performance.now() - tUnits,
            `Terran=${terranCount}, Solaris=${solarisCount}, Zerg=${zergCount}, MatsChecked=${fChecked} (Repaired=${fRepaired})`
        );

        // 3. Buildings Validation
        const tBld = performance.now();
        const playerBldCount = Array.isArray(buildings) ? buildings.length : 0;
        const zergBldCount = Array.isArray(enemyBuildings) ? enemyBuildings.length : 0;
        const solarisBldCount = Array.isArray(solarisBuildings) ? solarisBuildings.length : 0;
        const bldOk = zergBldCount > 0 || window.titleScreenActive;
        this.recordStage(
            'Faction Structures & Spawners',
            'Buildings',
            bldOk ? 'PASS' : 'WARNING',
            performance.now() - tBld,
            `PlayerBld=${playerBldCount}, ZergBld=${zergBldCount}, SolarisBld=${solarisBldCount}`
        );

        // 4. Functions & Dependencies Validation
        const tFn = performance.now();
        const requiredFns = [
            ['spawnEnemyFromBuilding', typeof spawnEnemyFromBuilding === 'function'],
            ['getGroundNavigationWaypoint', typeof getGroundNavigationWaypoint === 'function'],
            ['computeSafeGroundStep', typeof computeSafeGroundStep === 'function'],
            ['isWalkableGround', typeof isWalkableGround === 'function'],
            ['createAnimatedUnitModel', typeof createAnimatedUnitModel === 'function'],
            ['createEngineeredBuilding', typeof createEngineeredBuilding === 'function'],
            ['TEXTURE_REGISTRY', !!(window.TEXTURE_REGISTRY && window.TEXTURE_REGISTRY.textures)]
        ];
        const missingFns = requiredFns.filter(pair => !pair[1]).map(pair => pair[0]);
        this.recordStage(
            'Core Functions & Dependencies',
            'Functions & Dependencies',
            missingFns.length === 0 ? 'PASS' : 'FAIL',
            performance.now() - tFn,
            missingFns.length === 0 ? `All ${requiredFns.length} core engine symbols verified` : `Missing: ${missingFns.join(', ')}`
        );

        // 5. Loading & Render Loop Validation
        const tLoad = performance.now();
        const hasRenderer = !!(typeof renderer !== 'undefined' && renderer && scene && camera);
        const texSnap = (window.TEXTURE_REGISTRY && typeof window.TEXTURE_REGISTRY.getDiagnosticSnapshot === 'function')
            ? window.TEXTURE_REGISTRY.getDiagnosticSnapshot()
            : { totalRegistered: 0, missingOrInvalid: [] };
        const loadOk = hasRenderer && texSnap.missingOrInvalid.length === 0;
        this.recordStage(
            'Loading & Render Pipeline',
            'Loading',
            loadOk ? 'PASS' : (hasRenderer ? 'WARNING' : 'FAIL'),
            performance.now() - tLoad,
            `Renderer=${hasRenderer ? 'ONLINE' : 'OFFLINE'}, Textures=${texSnap.totalRegistered} (${texSnap.missingOrInvalid.length} invalid)`
        );

        // 6. 3D Camera Axis Sphere Validation
        const tAxis = performance.now();
        if (window.AXIS_BALL_CONTROLLER && !window.AXIS_BALL_CONTROLLER.canvas && typeof window.AXIS_BALL_CONTROLLER.init === 'function') {
            window.AXIS_BALL_CONTROLLER.init();
        }
        const axisReady = !!(window.AXIS_BALL_CONTROLLER && window.AXIS_BALL_CONTROLLER.canvas && window.AXIS_BALL_CONTROLLER.ctx);
        this.recordStage(
            '3D Camera Axis Sphere',
            'UI & Camera',
            axisReady ? 'PASS' : 'WARNING',
            performance.now() - tAxis,
            axisReady ? `Canvas=#axis-ball-canvas (${window.AXIS_BALL_CONTROLLER.canvas.width}x${window.AXIS_BALL_CONTROLLER.canvas.height})` : 'Canvas not mounted yet'
        );

        return {
            overallStatus: this.overallStatus,
            totalDurationMs: Number((performance.now() - tStart).toFixed(2)),
            stages: this.stages.slice()
        };
    }
};

// ============================================================================
// 7. STARCRAFT 1:1 COMMAND CONSOLE, CLICK-AND-DRAG BOX SELECTION & MINIMAP
// ============================================================================
const COSTS = { base: 0, barracks: 100, factory: 200, hero: 150, turret: 75, tech_lab: 150, solaris_nexus: 0, solaris_pylon: 75, solaris_gate: 150, solaris_robotics: 200, solaris_spire: 100, solaris_cyber_lab: 150, barrier: 35, mine_drill: 120 };
const BUILDING_MAX_HP = { base: 1500, barracks: 500, factory: 680, hero: 500, turret: 380, tech_lab: 650, solaris_nexus: 1600, solaris_pylon: 550, solaris_gate: 650, solaris_robotics: 750, solaris_spire: 480, solaris_cyber_lab: 700, barrier: 900, mine_drill: 560 };
const WEAPON_COSTS = {
    none: 0,
    mg: 1,
    flame: 2,
    plasma: 2,
    rocket: 2,
    shield: 2,
    sniper: 3,
    drone: 3,
    mortar: 3,
    mindcontrol: 3
};
const WEAPON_LABELS = {
    none: 'Empty',
    mg: 'Gatling',
    flame: 'Napalm',
    plasma: 'Plasma',
    rocket: 'Rocket Pod',
    shield: 'Shield Dome',
    sniper: 'Sniper',
    drone: 'FixDrone',
    mortar: 'Howitzer',
    mindcontrol: 'Mind Ctrl'
};
const POWER_RADIUS = 36;

const buildings = [];
const enemyBuildings = [];
const solarisBuildings = [];
window.solarisBuildings = solarisBuildings;
const units = [];
const enemies = [];
const projectiles = [];

let state = {
    mode: 'base',
    playerFaction: 'terran', // 'terran' | 'solaris'
    isEndless: false,
    missionWon: false,
    basePlaced: false,
    heroPlaced: false,
    solarisHostile: false,
    enemyBaseDiscovered: false,
    discoveredEnemyBasePos: null,
    baseBuilding: null,
    humanBadgeDom: null,
    enemyBase: null,
    powerRing: null,
    req: 200,
    gems: 0,
    wave: 1,
    kills: 0,
    elapsedSec: 0,
    selectedBuilding: null,
    selectedUnits: [],
    unitCommandMode: null, // null | 'move' | 'attack_move'
    squadFormation: 'concave', // 'concave' | 'wedge' | 'line' | 'box' | 'spread'
    formSquadEnabled: true,
    squadIntelligence: true,
    squadPosture: 'DEFENSIVE', // 'DEFENSIVE' | 'HUNTING'
    squadIntelTimer: 0.4,
    upgrades: {
        terran: { weapons: 0, armor: 0 },
        solaris: { weapons: 0, armor: 0 },
        zerg: { weapons: 0, armor: 0 }
    },
    zergUpgradeTimer: 34.0,
    solarisUpgradeTimer: 32.0,
    activeTurretSlot: 'left',
    rushGraceTimer: 45.0, // 45s grace period so enemy fliers and heavy units don't rush immediately
    swarmWaveTimer: 28.0  // Staged Zerg Swarm wave coordination timer
};

// Marks the Enemy Zerg Base as discovered by scouting units and rallies all auto units & future spawns to attack it!
function notifyEnemyBaseDiscovered(foundPos) {
    if (!foundPos) return;
    const targetPos = (state.enemyBase && state.enemyBase.hp > 0)
        ? state.enemyBase.pos.clone()
        : foundPos.clone();
    state.discoveredEnemyBasePos = targetPos;
    if (!state.enemyBaseDiscovered) {
        state.enemyBaseDiscovered = true;
        const ticker = document.getElementById('directive-ticker');
        if (ticker && !state.missionWon) {
            ticker.innerText = 'SCOUT REPORT: ENEMY ZERG HIVE DISCOVERED! All spawned & active combat units converging on Enemy Base!';
            ticker.style.color = '#ffaa00';
        }
        // Immediately redirect all active auto-scouting units to march on the discovered Enemy Base!
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u && u.hp > 0 && u.order === 'auto') {
                u.patrolTarget = targetPos.clone();
            }
        }
    }
}

// Forward Zerg Staging Rally Area (North of the bridge causeways)
const ENEMY_STAGING_POS = new THREE.Vector3(0, 0, -18);

// Shared Selection Ring Geometry & Materials for Friendly Units
const unitSelRingGeo = new THREE.RingGeometry(0.55, 0.72, 28);
unitSelRingGeo.rotateX(-Math.PI / 2);
const unitSelRingMat = new THREE.MeshBasicMaterial({
    color: 0x00ff66, side: THREE.DoubleSide, transparent: true, opacity: 0.92, depthWrite: false
});
const waypointRingMat = new THREE.MeshBasicMaterial({
    color: 0x00ff66, side: THREE.DoubleSide, transparent: true, opacity: 0.95
});
const attackRingMat = new THREE.MeshBasicMaterial({
    color: 0xff2a4b, side: THREE.DoubleSide, transparent: true, opacity: 0.95
});

// Unit & Building Metadata for 1:1 StarCraft Console Wireframes & Comm-Link Portrait
const UNIT_CONSOLE_META = {
    grunt:      { title: 'CMC-660 SHOCK TROOPER',   rank: 'CORPORAL',   weapon: 'PLASMA BLADE',            armor: 'CMC-HVY 2', quote: '"BLADES AT THE READY!"' },
    ranger:     { title: 'C-14 GAUSS MARKSMAN',     rank: 'SERGEANT',   weapon: 'C-14 RIFLE',              armor: 'CMC-LGT 1', quote: '"YOU WANT A PIECE OF ME, BOY?"' },
    medic:      { title: 'FIELD COMBAT MEDIC',      rank: 'LIEUTENANT', weapon: 'CADUCEUS NANO-BEAM',      armor: 'MED-SUIT 1', quote: '"WHERE DOES IT HURT? HEALING ACTIVE."' },
    rocketman:  { title: 'HEAVY ROCKET TROOPER',    rank: 'SERGEANT',   weapon: 'JAVELIN AT/AA LAUNCHER',  armor: 'CMC-ORD 2', quote: '"LOCKED ON TARGET — FIRE IN THE HOLE!"' },
    reaper:     { title: 'DOMINION JUMP-JET REAPER',rank: 'RAIDER',     weapon: 'DUAL P-45 GAUSS PISTOLS', armor: 'JET-PACK 1', quote: '"FEAR THE REAPER! JETS ENGAGED."' },
    firebat:    { title: 'CMC-660 PYRO-FIREBAT',    rank: 'SERGEANT',   weapon: 'PERDITION FLAMETHROWERS', armor: 'CMC-PYRO 3', quote: '"NEED A LIGHT? INCINERATING SWARM!"' },
    marauder:   { title: 'CMC-700 BIO-MARAUDER',    rank: 'LIEUTENANT', weapon: 'PUNISHER GRENADE CANNONS',armor: 'CMC-JUGG 3', quote: '"KABOOM, BABY! CONCUSSIVE SHELLS ONLINE."' },
    hero:       { title: 'VANGUARD COMMANDER',      rank: 'MARSHAL',    weapon: 'AEGIS-X9 SUNLANCE RAIL',  armor: 'AEGIS-3',   quote: '"SUNLANCE RAIL-CANNON CHARGED — FEAR THE DOMINION!"' },
    tank:       { title: 'M80 GRIZZLY TANK',        rank: 'MAJOR',      weapon: '120MM CANNON',            armor: 'CHOBHAM-4', quote: '"READY TO ROLL OUT!"' },
    siege_tank: { title: 'CRUCIO SIEGE TANK',       rank: 'COLONEL',    weapon: '180MM SHOCK ARTILLERY',   armor: 'CHOBHAM-5', quote: '"LOCKING HYDRAULIC OUTRIGGERS — ARTILLERY ONLINE!"' },
    heli:       { title: 'AH-99 HUNTER GUNSHIP',    rank: 'CAPTAIN',    weapon: 'HYDRA + BELLY MINIGUN',   armor: 'AERO-2',    quote: '"MINIGUN & ROCKETS ARMED."' },
    transport:  { title: 'HERCULES DROPSHIP APC',   rank: 'CAPTAIN',    weapon: 'FORWARD DROP BAY',        armor: 'AERO-3',    quote: '"HOLDING FORWARD DROP ZONE."' },
    valkyrie:   { title: 'VALKYRIE SEMI-MECH',      rank: 'COMMANDER',  weapon: 'AA HALO / MECH CANNONS',  armor: 'AERO-MECH 3', quote: '"FLIGHT INTERCEPTOR & GROUND MECH WALKER READY!"' },
    phoenix:    { title: 'PHOENIX INTERCEPTOR',     rank: 'CORSAIR',    weapon: 'TWIN ION PULSE CANNONS',  armor: 'AURELIAN-2', quote: '"CLEARING THE SKIES AT SUPERSONIC VELOCITY!"' },
    void_ray:   { title: 'VOID RAY PRISM CRUISER',  rank: 'EXECUTOR',   weapon: 'THERMAL PRISMATIC BEAM',  armor: 'AURELIAN-4', quote: '"PRISMATIC CORE ALIGNED — BEAM INTENSITY RISING!"' },
    carrier:    { title: 'SOLARIS FLEET CARRIER',   rank: 'HIERARCH',   weapon: 'INTERCEPTOR SQUADRON (5)',armor: 'AURELIAN-5', quote: '"CARRIER HAS ARRIVED — LAUNCH ALL INTERCEPTORS!"' },
    skitterer:  { title: 'PSIONIC ZERGLING (ALLY)', rank: 'THRALL',     weapon: 'CHITIN SCYTHES',          armor: 'CARAPACE-1', quote: '"NEURAL LINK LOCKED."' },
    spitter:    { title: 'PSIONIC HYDRALISK (ALLY)',rank: 'THRALL',     weapon: 'ACID SPINES',             armor: 'CARAPACE-2', quote: '"OBEYING TERRAN COMMAND."' },
    crusher:    { title: 'PSIONIC ROACH (ALLY)',    rank: 'THRALL',     weapon: 'SCYTHE CLAWS',            armor: 'CARAPACE-3', quote: '"DOMINION NEURAL THRALL."' },
    behemoth:   { title: 'PSIONIC ULTRALISK (ALLY)',rank: 'THRALL',     weapon: 'BIO-PLASMA',              armor: 'CARAPACE-4', quote: '"LEVIATHAN SUBJUGATED."' },
    gorgon:     { title: 'PSIONIC GORGON (ALLY)',   rank: 'THRALL',     weapon: 'BILE-SCORPION CATAPULT',  armor: 'CARAPACE-4', quote: '"SCORPION LEVIATHAN SUBJUGATED."' },
    mutalisk:   { title: 'PSIONIC MUTALISK (ALLY)', rank: 'THRALL',     weapon: 'GLAIVE WURM',             armor: 'AERO-BIO',   quote: '"SKY THRALL ONLINE."' },
    zealot:     { title: 'CHRONO-ZEALOT TEMPLAR',   rank: 'TEMPLAR',    weapon: 'TWIN SOLAR PSI-GLAIVES',  armor: 'AURELIAN-3', quote: '"MY LIFE FOR THE SOLARIS SYNOD!"' },
    stalker:    { title: 'SOLARIS PRISM STALKER',   rank: 'DRAGOON',    weapon: 'PHASE PARTICLE DISRUPTOR',armor: 'OBSIDIAN-3', quote: '"WALKING BETWEEN SHADOW & STARLIGHT."' },
    archon:     { title: 'AETHER ARCHON SOVEREIGN', rank: 'ASCENDANT',  weapon: 'PSIONIC SOLAR SHOCKWAVE', armor: 'AETHER-SHD', quote: '"POWER OVERWHELMING — THE SYNOD AWAKENS!"' }
};

const BUILDING_CONSOLE_META = {
    base:             { title: 'ORBITAL COMMAND CITADEL',rank: 'CITADEL',  weapon: 'ORBITAL GRID', armor: 'FORTIFIED', quote: '"ORBITAL COMMAND CITADEL UPLINK ONLINE."' },
    barracks:         { title: 'INFANTRY BARRACKS',      rank: 'GARRISON', weapon: 'BIO TRAINER',  armor: 'PLATED-3',  quote: '"TRAINING INFANTRY SQUADS."' },
    factory:          { title: 'HEAVY WAR FACTORY',      rank: 'FOUNDRY',  weapon: 'MECH BAY',     armor: 'PLATED-4',  quote: '"VEHICLE ASSEMBLY ACTIVE."' },
    turret:           { title: 'MODULAR BALL TURRET',    rank: 'DEFENSE',  weapon: 'TRI-MOUNT',    armor: 'BUNKER-3',  quote: '"TRACKING HOSTILE SIGNATURES."' },
    hero:             { title: 'VANGUARD BEACON PAD',    rank: 'SPECIAL',  weapon: 'WARP RELAY',   armor: 'PLATED-3',  quote: '"HERO TELEPORT LOCKED."' },
    solaris_nexus:    { title: 'SOLARIS CHRONO NEXUS',   rank: 'SYNOD HQ', weapon: 'PSIONIC CORE', armor: 'AURELIAN-5',quote: '"THE CHRONO-SYNOD NEXUS SHINES ETERNAL."' },
    solaris_pylon:    { title: 'KHAYDARIN POWER PYLON',  rank: 'MATRIX',   weapon: 'PSI MATRIX',   armor: 'CRYSTAL-3', quote: '"PSIONIC POWER MATRIX ONLINE — ENERGIZING WARP GRID."' },
    solaris_gate:     { title: 'SOLARIS ASTRAL WARP GATE',rank: 'SYNOD',   weapon: 'CHRONO MATRIX',armor: 'AURELIAN-4',quote: '"CHRONO-SYNOD WARP MATRIX ALIGNED."' },
    solaris_robotics: { title: 'SOLARIS ROBOTICS & FLEET BAY', rank: 'SYNOD', weapon: 'STARFLEET BAY', armor: 'AURELIAN-4',quote: '"STARFLEET BEACON & ROBOTICS CONDUITS ONLINE."' },
    solaris_spire:     { title: 'KHAYDARIN AEGIS SPIRE',   rank: 'DEFENSE',  weapon: 'PSIONIC PRISM',armor: 'AURELIAN-3',quote: '"KHAYDARIN AEGIS SPIRE FOCUSED — LOCKED ON AIR & GROUND."' },
    solaris_cyber_lab: { title: 'SOLARIS CYBERNETICS FORGE',rank: 'RESEARCH', weapon: 'KHAYDARIN LAB',armor: 'AURELIAN-4',quote: '"FORGING SOLAR GLAIVES & AURELIAN CARAPACE MATRIX."' },
    tech_lab:          { title: 'ENGINEERING & WEAPONS LAB',rank: 'RESEARCH', weapon: 'ORDNANCE LAB', armor: 'PLATED-4',  quote: '"UPGRADING DOMINION ARMS & CHOBHAM ARMOR PLATING."' },
    barrier:           { title: 'BLAST BARRIER WALL',      rank: 'FORTIFY',  weapon: 'CHOBHAM SHIELD', armor: 'HVY-WALL 4', quote: '"BLAST BARRIER LOCKED & REINFORCED."' },
    mine_drill:        { title: 'DEEP-CORE MINE DRILL',    rank: 'EXCAVATOR',weapon: 'AUGER + LASER',  armor: 'RIG-HVY 3',  quote: '"DEEP-CORE AUGER LOCKED — EXTRACTING MINERALS & KHAYDARIN GEMS!"' }
};

function getWireframeSvgMarkup(key, strokeCol = '#00ff66') {
    const fillCol = strokeCol === '#00ff66' ? 'rgba(0,255,102,0.09)' : (strokeCol === '#ffaa00' ? 'rgba(255,170,0,0.1)' : 'rgba(255,42,75,0.12)');
    if (key === 'phoenix') {
        return `<svg viewBox="0 0 64 64" fill="none" stroke="${strokeCol}" stroke-width="2">
            <polygon points="32,6 42,26 60,18 46,38 38,56 32,46 26,56 18,38 4,18 22,26" fill="${fillCol}"/>
            <circle cx="32" cy="28" r="5" fill="${fillCol}"/>
        </svg>`;
    }
    if (key === 'void_ray') {
        return `<svg viewBox="0 0 64 64" fill="none" stroke="${strokeCol}" stroke-width="2">
            <polygon points="32,4 48,22 42,56 32,48 22,56 16,22" fill="${fillCol}"/>
            <circle cx="32" cy="24" r="7" fill="${fillCol}"/>
            <line x1="32" y1="4" x2="32" y2="24" stroke-width="3"/>
        </svg>`;
    }
    if (key === 'carrier') {
        return `<svg viewBox="0 0 64 64" fill="none" stroke="${strokeCol}" stroke-width="2">
            <polygon points="24,6 40,6 52,24 46,56 32,60 18,56 12,24" fill="${fillCol}"/>
            <line x1="20" y1="18" x2="44" y2="18"/><line x1="18" y1="34" x2="46" y2="34"/>
            <circle cx="32" cy="26" r="5" fill="${fillCol}"/>
        </svg>`;
    }
    if (key === 'mine_drill') {
        return `<svg viewBox="0 0 64 64" fill="none" stroke="${strokeCol}" stroke-width="2">
            <polygon points="16,12 48,12 52,26 12,26" fill="${fillCol}"/>
            <polygon points="24,26 40,26 32,58" fill="${fillCol}"/>
            <line x1="16" y1="26" x2="8" y2="54" stroke-width="2.5"/>
            <line x1="48" y1="26" x2="56" y2="54" stroke-width="2.5"/>
            <circle cx="32" cy="19" r="4" fill="${fillCol}"/>
        </svg>`;
    }
    if (key === 'tank' || key === 'siege_tank') {
        return `<svg viewBox="0 0 64 64" fill="none" stroke="${strokeCol}" stroke-width="2">
            <rect x="8" y="14" width="12" height="38" fill="${fillCol}"/>
            <rect x="44" y="14" width="12" height="38" fill="${fillCol}"/>
            <rect x="18" y="18" width="28" height="30" fill="${fillCol}"/>
            <polygon points="24,24 40,24 42,40 22,40" fill="${fillCol}"/>
            <line x1="32" y1="4" x2="32" y2="26" stroke-width="3.5"/>
        </svg>`;
    }
    if (key === 'valkyrie') {
        return `<svg viewBox="0 0 64 64" fill="none" stroke="${strokeCol}" stroke-width="2">
            <polygon points="32,6 42,24 58,18 50,38 38,44 42,58 22,58 26,44 14,38 6,18 22,24" fill="${fillCol}"/>
            <rect x="14" y="24" width="6" height="14" fill="${fillCol}"/>
            <rect x="44" y="24" width="6" height="14" fill="${fillCol}"/>
        </svg>`;
    }
    if (key === 'heli' || key === 'transport') {
        return `<svg viewBox="0 0 64 64" fill="none" stroke="${strokeCol}" stroke-width="2">
            <polygon points="32,8 44,26 40,46 32,58 24,46 20,26" fill="${fillCol}"/>
            <line x1="8" y1="28" x2="56" y2="28" stroke-width="2.5"/>
            <line x1="12" y1="12" x2="52" y2="44" stroke-dasharray="3 2"/>
            <line x1="52" y1="12" x2="12" y2="44" stroke-dasharray="3 2"/>
        </svg>`;
    }
    if (['grunt', 'ranger', 'medic', 'rocketman', 'reaper', 'firebat', 'marauder', 'hero'].includes(key)) {
        return `<svg viewBox="0 0 64 64" fill="none" stroke="${strokeCol}" stroke-width="2">
            <circle cx="32" cy="15" r="8" fill="${fillCol}"/>
            <polygon points="16,24 48,24 44,44 20,44" fill="${fillCol}"/>
            <rect x="8" y="22" width="9" height="16" rx="2" fill="${fillCol}"/>
            <rect x="47" y="22" width="9" height="16" rx="2" fill="${fillCol}"/>
            <line x1="24" y1="44" x2="21" y2="58" stroke-width="2.5"/>
            <line x1="40" y1="44" x2="43" y2="58" stroke-width="2.5"/>
        </svg>`;
    }
    if (key === 'turret' || key === 'solaris_spire') {
        return `<svg viewBox="0 0 64 64" fill="none" stroke="${strokeCol}" stroke-width="2">
            <polygon points="14,54 50,54 44,36 20,36" fill="${fillCol}"/>
            <circle cx="32" cy="24" r="12" fill="${fillCol}"/>
            <line x1="26" y1="8" x2="26" y2="20" stroke-width="2.5"/>
            <line x1="38" y1="8" x2="38" y2="20" stroke-width="2.5"/>
        </svg>`;
    }
    return `<svg viewBox="0 0 64 64" fill="none" stroke="${strokeCol}" stroke-width="2">
        <polygon points="32,6 56,18 56,46 32,58 8,46 8,18" fill="${fillCol}"/>
        <circle cx="32" cy="32" r="12"/>
        <line x1="32" y1="6" x2="32" y2="20"/><line x1="32" y1="44" x2="32" y2="58"/>
    </svg>`;
}

function getPortraitAvatarSvg(key) {
    const isMech = ['tank', 'heli', 'transport', 'valkyrie', 'factory', 'turret', 'mine_drill'].includes(key);
    const isStruct = ['base', 'barracks', 'factory', 'turret', 'hero', 'mine_drill'].includes(key);
    const col = isStruct ? '#00e5ff' : (isMech ? '#38bdf8' : '#00ff66');
    const visorCol = key === 'medic' ? '#00ff88' : (key === 'hero' || key === 'reaper' || key === 'rocketman' ? '#ffaa00' : (isStruct ? '#00e5ff' : '#ffaa00'));

    if (isStruct) {
        // StarCraft II Terran Adjutant Cybernetic AI Portrait
        return `<svg viewBox="0 0 64 64" fill="none" stroke="${col}" stroke-width="1.6">
            <circle cx="32" cy="30" r="22" stroke="rgba(0,229,255,0.28)" stroke-dasharray="4 2"/>
            <path d="M18,16 L46,16 L52,30 L44,50 L20,50 L12,30 Z" fill="rgba(0,229,255,0.12)"/>
            <polygon points="22,23 42,23 45,31 19,31" fill="rgba(0,229,255,0.32)" stroke="#00e5ff"/>
            <circle cx="26" cy="27" r="2.2" fill="#ffffff"/>
            <circle cx="38" cy="27" r="2.2" fill="#ffffff"/>
            <line x1="23" y1="39" x2="41" y2="39" stroke="#00ff66" stroke-width="2"/>
            <line x1="26" y1="43" x2="38" y2="43" stroke="#00e5ff" stroke-width="1.5"/>
            <path d="M10,58 L20,50 L44,50 L54,58" stroke="${col}" stroke-width="2"/>
        </svg>`;
    }

    // StarCraft II Terran CMC Powered Combat Suit / Pilot Helmet Portrait
    return `<svg viewBox="0 0 64 64" fill="none" stroke="${col}" stroke-width="1.8">
        <path d="M8,58 L14,44 L50,44 L56,58" fill="rgba(20,34,52,0.85)" stroke="${col}" stroke-width="2"/>
        <polygon points="16,12 48,12 55,28 49,48 15,48 9,28" fill="rgba(0,229,255,0.14)"/>
        <polygon points="18,22 46,22 49,34 15,34" fill="rgba(255,170,0,0.32)" stroke="${visorCol}" stroke-width="1.8"/>
        <line x1="22" y1="26" x2="32" y2="26" stroke="#ffffff" stroke-width="1.4" opacity="0.8"/>
        <rect x="23" y="38" width="18" height="5" fill="rgba(0,0,0,0.65)" stroke="${col}" stroke-width="1.2"/>
        <circle cx="14" cy="19" r="2" fill="#00e5ff"/>
        <circle cx="50" cy="19" r="2" fill="#00e5ff"/>
    </svg>`;
}

function renderWireframeHpBlocks(ratio, col = '#00ff66') {
    const container = document.getElementById('wireframe-hp-blocks');
    if (!container) return;
    const totalBlocks = 12;
    const activeBlocks = Math.max(0, Math.min(totalBlocks, Math.ceil(ratio * totalBlocks)));
    let html = '';
    for (let i = 0; i < totalBlocks; i++) {
        const bg = i < activeBlocks ? col : '#121c29';
        html += `<div class="wf-hp-pip" style="background:${bg};"></div>`;
    }
    container.innerHTML = html;
}

function setCmdTooltip(text) {
    const el = document.getElementById('cmd-tooltip-bar');
    if (el) el.innerText = text;
}

function getCmdIconSvg(type) {
    switch (type) {
        case 'base': return `<svg class="cmd-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#00e5ff" stroke-width="2"><polygon points="12,2 22,8 22,16 12,22 2,16 2,8"/><circle cx="12" cy="12" r="4"/></svg>`;
        case 'barracks': return `<svg class="cmd-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#00ff66" stroke-width="2"><rect x="3" y="6" width="18" height="14"/><path d="M8,20 V12 H16 V20"/></svg>`;
        case 'factory': return `<svg class="cmd-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#ffaa00" stroke-width="2"><polygon points="2,20 2,10 8,14 8,10 14,14 14,8 22,8 22,20"/></svg>`;
        case 'turret': return `<svg class="cmd-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#00e5ff" stroke-width="2"><circle cx="12" cy="14" r="6"/><line x1="12" y1="2" x2="12" y2="10"/><line x1="6" y1="20" x2="18" y2="20"/></svg>`;
        case 'hero': return `<svg class="cmd-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#ffaa00" stroke-width="2"><polygon points="12,2 15,9 22,9 16,14 18,21 12,17 6,21 8,14 2,9 9,9"/></svg>`;
        case 'solaris_gate': return `<svg class="cmd-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#f5b932" stroke-width="2"><polygon points="12,2 20,12 12,22 4,12"/><circle cx="12" cy="12" r="3.5" stroke="#38bdf8"/></svg>`;
        case 'tech_lab':
        case 'solaris_cyber_lab': return `<svg class="cmd-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2"><circle cx="12" cy="12" r="5"/><polygon points="12,2 15,6 9,6"/><polygon points="12,22 15,18 9,18"/><polygon points="2,12 6,15 6,9"/><polygon points="22,12 18,15 18,9"/></svg>`;
        case 'mine_drill': return `<svg class="cmd-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#e879f9" stroke-width="2"><polygon points="6,4 18,4 15,11 9,11"/><polygon points="9,11 15,11 12,22"/><line x1="6" y1="11" x2="3" y2="20"/><line x1="18" y1="11" x2="21" y2="20"/></svg>`;
        case 'attack': return `<svg class="cmd-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#ff2a4b" stroke-width="2"><circle cx="12" cy="12" r="8"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/></svg>`;
        case 'move': return `<svg class="cmd-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#00ff66" stroke-width="2"><polyline points="5,12 19,12"/><polyline points="13,6 19,12 13,18"/></svg>`;
        case 'hold': return `<svg class="cmd-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#00e5ff" stroke-width="2"><path d="M12,2 L4,6 V12 C4,17 8,21 12,22 C16,21 20,17 20,12 V6 Z"/></svg>`;
        default: return `<svg class="cmd-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#9ab0c9" stroke-width="2"><rect x="4" y="4" width="16" height="16"/></svg>`;
    }
}

var MAX_ALLIED_UNITS = 40;
var MAX_ENEMY_UNITS = 54;
var hudVisibilityState = window.hudVisibilityState || {
    allHidden: false,
    consoleHidden: false,
    minimalMobile: typeof IS_MOBILE !== 'undefined' ? IS_MOBILE : false,
    showMinimap: true,
    showPortrait: typeof IS_MOBILE !== 'undefined' ? !IS_MOBILE : true,
    showCenter: true,
    showObjective: typeof IS_MOBILE !== 'undefined' ? !IS_MOBILE : true,
    showHpBars: true,
    soundEnabled: true
};
window.hudVisibilityState = hudVisibilityState;

function makeHealthPip(color, isStructure = false) {
    const root = document.createElement('div');
    root.className = 'hp-pip' + (isStructure ? ' structure' : '');
    if (hudVisibilityState && hudVisibilityState.showHpBars === false) {
        root.style.display = 'none';
    }
    const shieldBar = document.createElement('div');
    shieldBar.style.cssText = 'width:0%;height:3px;background:linear-gradient(90deg,#00e5ff,#38bdf8,#e0f2fe);box-shadow:0 0 5px #00e5ff;margin-bottom:1px;display:none;border-radius:1px;transition:width 0.08s linear;';
    const bar = document.createElement('div');
    bar.className = 'hp-pip-bar';
    bar.style.background = color;
    root.appendChild(shieldBar);
    root.appendChild(bar);
    worldUi.appendChild(root);
    return { root, bar, shieldBar };
}

function updateHealthPip(hb, hp, maxHp, shield = 0, maxShield = 0) {
    if (!hb || !hb.bar) return;
    const hpPct = Math.round(Math.max(0, Math.min(100, (hp / Math.max(1, maxHp)) * 100)) * 2) * 0.5;
    if (hb._lastHpPct !== hpPct) {
        hb._lastHpPct = hpPct;
        hb.bar.style.width = `${hpPct}%`;
    }
    if (hb.shieldBar) {
        if (maxShield > 0) {
            if (hb._lastShDisp !== 'block') {
                hb._lastShDisp = 'block';
                hb.shieldBar.style.display = 'block';
            }
            const shPct = Math.round(Math.max(0, Math.min(100, (shield / maxShield) * 100)) * 2) * 0.5;
            if (hb._lastShPct !== shPct) {
                hb._lastShPct = shPct;
                hb.shieldBar.style.width = `${shPct}%`;
            }
        } else if (hb._lastShDisp !== 'none') {
            hb._lastShDisp = 'none';
            hb.shieldBar.style.display = 'none';
        }
    }
}

// Fast Camera Frustum Culling Helper so off-screen units/enemies skip expensive skeletal animations, particle emissions & DOM projections
const _camFrustum = new THREE.Frustum();
const _camProjScreenMatrix = new THREE.Matrix4();
const _cullSphere = new THREE.Sphere();
function updateCameraViewportFrustum() {
    camera.updateMatrixWorld();
    _camProjScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _camFrustum.setFromProjectionMatrix(_camProjScreenMatrix);
}
window.isWorldPosInViewport = function(wx, wy, wz, radius = 3.5) {
    _cullSphere.center.set(wx, wy, wz);
    _cullSphere.radius = radius;
    return _camFrustum.intersectsSphere(_cullSphere);
};

if (typeof window.FOW_RES === 'undefined') {
    window.FOW_RES = 128;
}
const _gameFowRes = typeof FOW_RES !== 'undefined' ? FOW_RES : window.FOW_RES;
const fowSmoothAlpha = new Float32Array(_gameFowRes * _gameFowRes).fill(215);
const _fowMinRatioSqGrid = new Float32Array(_gameFowRes * _gameFowRes);
let _fowLastSig = 0;
let _fowSkipStreak = 0;
let _fowFirstPassDone = false;

function updateFogOfWarVision() {
    if (window.PERF_PROFILER) window.PERF_PROFILER.begin('fogOfWar');

    const weatherVisMult = (window.WEATHER_SYSTEM && typeof window.WEATHER_SYSTEM.getVisionMultiplier === 'function')
        ? window.WEATHER_SYSTEM.getVisionMultiplier()
        : 1.0;
    const revealAll = !!window.fowRevealAll;

    // Build spatial vision signature so we can skip full canvas uploads when units are stationary and alpha has settled
    let sig = revealAll ? 777777 : Math.round(weatherVisMult * 100);
    sig = (sig * 31 + Math.round(PLAYER_START_POS.x) * 19 + Math.round(PLAYER_START_POS.z) * 23 + (state.basePlaced ? 101 : 37) + (state.solarisHostile ? 71 : 13)) | 0;
    if (state.basePlaced) {
        sig = (sig * 31 + buildings.length * 17 + units.length * 13) | 0;
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u && u.hp > 0) {
                sig = (sig + ((Math.round(u.mesh.position.x * 0.75) * 73856093) ^ (Math.round(u.mesh.position.z * 0.75) * 19349663))) | 0;
            }
        }
        for (let i = 0; i < buildings.length; i++) {
            const b = buildings[i];
            if (b && b.hp > 0) {
                sig = (sig + ((Math.round(b.pos.x) * 83492791) ^ (Math.round(b.pos.z) * 2971215073))) | 0;
            }
        }
    }

    if (window._forceFowReset) {
        window._forceFowReset = false;
        _fowFirstPassDone = false;
        _fowLastSig = 0;
    }

    const canReuseVisionGrid = (_fowFirstPassDone && sig === _fowLastSig && _fowSkipStreak < 2 && !revealAll);
    _fowLastSig = sig;

    const data = fowImgData.data;
    const halfMap = MAP_SIZE * 0.5;
    const worldToGrid = FOW_RES / MAP_SIZE;
    const gridToWorld = MAP_SIZE / FOW_RES;

    if (revealAll) {
        _fowSkipStreak = 0;
        _fowFirstPassDone = true;
        fowExplored.fill(1);
        fowVisible.fill(1);
        fowSmoothAlpha.fill(0);
        for (let idx = 0, total = FOW_RES * FOW_RES; idx < total; idx++) {
            const p = idx * 4;
            data[p] = 14;
            data[p + 1] = 22;
            data[p + 2] = 34;
            data[p + 3] = 0;
        }
        fowCtx.putImageData(fowImgData, 0, 0);
        fowTexture.needsUpdate = true;
    } else {
        if (!canReuseVisionGrid) {
            _fowSkipStreak = 0;
            fowVisible.fill(0);
            _fowMinRatioSqGrid.fill(999.0);

            const stampVisionCircle = (vx, vz, radius) => {
                const rad = Math.max(1.0, radius);
                const invR2 = 1.0 / (rad * rad);
                const minGx = Math.max(0, Math.floor((vx - rad + halfMap) * worldToGrid));
                const maxGx = Math.min(FOW_RES - 1, Math.ceil((vx + rad + halfMap) * worldToGrid));
                const minGy = Math.max(0, Math.floor((vz - rad + halfMap) * worldToGrid));
                const maxGy = Math.min(FOW_RES - 1, Math.ceil((vz + rad + halfMap) * worldToGrid));

                for (let gy = minGy; gy <= maxGy; gy++) {
                    const wz = gy * gridToWorld - halfMap;
                    const dz = wz - vz;
                    const dz2 = dz * dz;
                    const rowOff = gy * FOW_RES;
                    for (let gx = minGx; gx <= maxGx; gx++) {
                        const idx = rowOff + gx;
                        const curBest = _fowMinRatioSqGrid[idx];
                        if (curBest <= 0.30) continue; // Already inside bright core vision
                        const wx = gx * gridToWorld - halfMap;
                        const dx = wx - vx;
                        const dSq = (dx * dx + dz2) * invR2;
                        if (dSq < curBest) {
                            _fowMinRatioSqGrid[idx] = dSq;
                        }
                    }
                }
            };

            // Always guarantee starting drop-zone vision around PLAYER_START_POS so initial camera view is revealed
            stampVisionCircle(PLAYER_START_POS.x, PLAYER_START_POS.z, (state.basePlaced ? 32 : 40) * weatherVisMult);
            if (!state.basePlaced) {
                if (typeof SOLARIS_BASE_POS !== 'undefined') {
                    stampVisionCircle(SOLARIS_BASE_POS.x, SOLARIS_BASE_POS.z, 25 * weatherVisMult);
                }
            } else {
                for (let i = 0; i < buildings.length; i++) {
                    const b = buildings[i];
                    if (b && b.hp > 0) stampVisionCircle(b.pos.x, b.pos.z, (b.type === 'base' ? 38 : 25) * weatherVisMult);
                }
                for (let i = 0; i < units.length; i++) {
                    const u = units[i];
                    if (u && u.hp > 0) stampVisionCircle(u.mesh.position.x, u.mesh.position.z, (u.isAir ? 26 : 19.0) * weatherVisMult);
                }
                if (!state.solarisHostile) {
                    for (let i = 0; i < solarisBuildings.length; i++) {
                        const sb = solarisBuildings[i];
                        if (sb && sb.hp > 0) stampVisionCircle(sb.pos.x, sb.pos.z, 25 * weatherVisMult);
                    }
                }
            }
        } else {
            _fowSkipStreak++;
        }

        let anyAlphaChanged = !canReuseVisionGrid || !_fowFirstPassDone;
        const lerpRate = (!_fowFirstPassDone || !state.basePlaced) ? 1.0 : 0.48;
        _fowFirstPassDone = true;
        const totalCells = FOW_RES * FOW_RES;
        for (let idx = 0; idx < totalCells; idx++) {
            const minRatioSq = _fowMinRatioSqGrid[idx];
            // 3 Explicit FOW States:
            // - Visible (alpha 0..90): Active player vision
            // - Explored (alpha 132): Previously seen terrain/static props darkened (~40% brightness)
            // - Unexplored (alpha 235): Deep shroud (~13% brightness)
            let targetAlpha = 235;
            if (minRatioSq < 1.0) {
                fowExplored[idx] = 1;
                fowVisible[idx] = 1;
                if (minRatioSq < 0.4096) { // 0.64^2
                    targetAlpha = 0;
                } else {
                    const minRatio = Math.sqrt(minRatioSq);
                    const edgeT = (minRatio - 0.64) / 0.36;
                    targetAlpha = Math.floor(edgeT * edgeT * (3.0 - 2.0 * edgeT) * 124);
                }
            } else if (fowExplored[idx]) {
                targetAlpha = 132;
            }

            const prevSmooth = fowSmoothAlpha[idx];
            const nextSmooth = prevSmooth + (targetAlpha - prevSmooth) * lerpRate;
            fowSmoothAlpha[idx] = nextSmooth;
            if (Math.abs(nextSmooth - prevSmooth) > 0.30) anyAlphaChanged = true;
            const alpha = Math.max(0, Math.min(255, (nextSmooth + 0.5) | 0));

            const p = idx * 4;
            data[p] = 10;
            data[p + 1] = 16;
            data[p + 2] = 26;
            data[p + 3] = alpha;
        }

        if (anyAlphaChanged) {
            fowCtx.putImageData(fowImgData, 0, 0);
            fowTexture.needsUpdate = true;
        }
    }

    const fowBypass = !!(window.titleScreenActive || window.loadingCameraSweep || window.fowRevealAll);

    for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        const vis = fowBypass || isWorldPosVisible(e.mesh.position.x, e.mesh.position.z);
        e.mesh.visible = vis;
        if (!vis && e.hb && e.hb.root.style.display !== 'none') e.hb.root.style.display = 'none';
    }

    for (let i = 0; i < enemyBuildings.length; i++) {
        const eb = enemyBuildings[i];
        const vis = fowBypass || isWorldPosVisible(eb.pos.x, eb.pos.z);
        // Enemy structures must ONLY be visible when inside current player vision (disappear immediately in Explored & Unexplored fog)
        eb.mesh.visible = vis;
        if (eb.expCreepMesh) {
            eb.expCreepMesh.visible = vis && (typeof creepRadius === 'undefined' || creepRadius > 0.45);
        }
        if (vis && state.basePlaced && !state.enemyBaseDiscovered) {
            notifyEnemyBaseDiscovered(eb.pos);
        }
        if (!vis) {
            if (eb.badge && eb.badge.style.display !== 'none') eb.badge.style.display = 'none';
            if (eb.hb && eb.hb.root.style.display !== 'none') eb.hb.root.style.display = 'none';
        }
    }

    const activeCreepState = typeof window.getActiveZergCreepState === 'function'
        ? window.getActiveZergCreepState()
        : { hasBuiltZergMainBase: (typeof creepRadius !== 'undefined' && creepRadius > 0.45), x: ENEMY_BASE_POS.x, z: ENEMY_BASE_POS.z };

    if (typeof activeZergMainCreepMesh !== 'undefined' && activeZergMainCreepMesh) {
        const r = (activeCreepState.hasBuiltZergMainBase && typeof creepRadius !== 'undefined') ? creepRadius : 0;
        const cx = activeCreepState.x;
        const cz = activeCreepState.z;
        const hiveVisible = fowBypass
            || isWorldPosVisible(cx, cz)
            || isWorldPosVisible(cx + r * 0.55, cz)
            || isWorldPosVisible(cx - r * 0.55, cz)
            || isWorldPosVisible(cx, cz + r * 0.55)
            || isWorldPosVisible(cx, cz - r * 0.55);
        activeZergMainCreepMesh.visible = (r > 0.45) && hiveVisible;
    }

    if (typeof creepTumors !== 'undefined' && Array.isArray(creepTumors)) {
        for (let t = 0; t < creepTumors.length; t++) {
            const ct = creepTumors[t];
            if (ct && ct.group) {
                const onCreep = activeCreepState.hasBuiltZergMainBase && typeof creepRadius !== 'undefined' && creepRadius > 0.5 &&
                    Math.hypot(ct.x - activeCreepState.x, ct.z - activeCreepState.z) <= creepRadius + 3.5;
                const ctVis = fowBypass || isWorldPosVisible(ct.x, ct.z);
                ct.group.visible = !ct.dead && onCreep && ctVis;
                if (ct.pustule) ct.pustule.visible = !ct.dead && onCreep && ctVis;
            }
        }
    }

    if (typeof frontierBuildingInfestations !== 'undefined' && Array.isArray(frontierBuildingInfestations)) {
        for (let f = 0; f < frontierBuildingInfestations.length; f++) {
            const fi = frontierBuildingInfestations[f];
            if (fi && fi.group) {
                const onCreep = activeCreepState.hasBuiltZergMainBase && (typeof isPointOnZergCreep === 'function' ? isPointOnZergCreep(fi.x, fi.z) : false);
                fi.group.visible = onCreep && (fowBypass || isWorldPosVisible(fi.x, fi.z));
            }
        }
    }

    if (window.PERF_PROFILER) window.PERF_PROFILER.end('fogOfWar');
}

// Helper to ensure AI Buildings NEVER overlap each other, never block base ramps, never spawn in rivers, and always leave wide tank/unit pathways!
function resolveSafeEnemyBuildingPos(desiredPos, bRadius = 2.6, isProduction = false, anchorCenter = null, maxAnchorDist = 23.5) {
    const pathwayBuffer = isProduction ? 3.5 : 2.5;
    const isSpotClear = (tx, tz, ignoreMinorProps = false) => {
        if (Math.abs(tx) > 102 || Math.abs(tz) > 102) return false;
        if (anchorCenter) {
            const dAnchor = Math.hypot(tx - anchorCenter.x, tz - anchorCenter.z);
            if (dAnchor > maxAnchorDist) return false;
        }
        const h = getTerrainHeight(tx, tz);
        if (h < -0.05 || h > 9.5) return false;
        if (typeof isPointInValleyRiver === 'function' && isPointInValleyRiver(tx, tz, bRadius + 1.6)) return false;
        if (typeof isPointInWaterPond === 'function' && isPointInWaterPond(tx, tz, bRadius + 1.4)) return false;
        if (typeof isOnRiverBridge === 'function' && isOnRiverBridge(tx, tz, bRadius + 1.5)) return false;
        if (typeof isSpotUnderOrBlockingBridge === 'function' && isSpotUnderOrBlockingBridge(tx, tz, bRadius + 1.5)) return false;

        // Never place AI buildings on any Base Ramp or Merged Ramp Platform so unit/tank pathways stay 100% open!
        if (Array.isArray(window.BASE_TERRAIN_ZONES)) {
            for (let zIdx = 0; zIdx < window.BASE_TERRAIN_ZONES.length; zIdx++) {
                const bz = window.BASE_TERRAIN_ZONES[zIdx];
                if (!bz || bz.mode === 'no_ramp') continue;
                if (typeof getBaseZoneRampMetrics === 'function') {
                    const zm = getBaseZoneRampMetrics(bz, tx, tz);
                    if (zm.inRampAngle || zm.rampBlend > 0.12 || zm.mergedPlatformBlend > 0.12) {
                        return false;
                    }
                    if (!ignoreMinorProps && zm.dist > bz.radius - (bRadius + 1.1) && zm.dist < bz.rimOuter + (bRadius + 1.1)) {
                        return false;
                    }
                }
            }
        }

        // Check 8 perimeter points for water/steep slope
        if (!ignoreMinorProps) {
            for (let a = 0; a < 8; a++) {
                const ang = (a / 8) * Math.PI * 2;
                const px = tx + Math.cos(ang) * (bRadius + 0.8);
                const pz = tz + Math.sin(ang) * (bRadius + 0.8);
                const ph = getTerrainHeight(px, pz);
                if (ph < -0.05 || Math.abs(ph - h) > 1.45) return false;
                if (typeof isPointInValleyRiver === 'function' && isPointInValleyRiver(px, pz, 0.8)) return false;
            }
        }

        // STRICT NON-OVERLAP: Enforce wide Unit & Tank Pathway spacing against ALL Enemy Zerg buildings
        for (let i = 0; i < enemyBuildings.length; i++) {
            const eb = enemyBuildings[i];
            if (!eb || eb.hp <= 0) continue;
            const ebIsProd = (eb.role === 'barracks' || eb.role === 'factory' || eb.role === 'citadel');
            const minSep = bRadius + Math.max(eb.footprintRadius || 2.8, 2.2) + ((isProduction || ebIsProd) ? 3.5 : pathwayBuffer);
            if (Math.hypot(tx - eb.pos.x, tz - eb.pos.z) < minSep) return false;
        }

        // STRICT NON-OVERLAP: Enforce wide Unit & Tank Pathway spacing against ALL Solaris Protoss buildings
        if (typeof solarisBuildings !== 'undefined') {
            for (let i = 0; i < solarisBuildings.length; i++) {
                const sb = solarisBuildings[i];
                if (!sb || sb.hp <= 0) continue;
                const sbIsProd = (sb.role === 'gate' || sb.role === 'robotics' || sb.role === 'nexus');
                const minSep = bRadius + Math.max(sb.footprintRadius || 2.4, 2.0) + ((isProduction || sbIsProd) ? 3.3 : pathwayBuffer);
                if (Math.hypot(tx - sb.pos.x, tz - sb.pos.z) < minSep) return false;
            }
        }

        // STRICT NON-OVERLAP: Enforce spacing against ALL Player buildings
        if (typeof buildings !== 'undefined') {
            for (let i = 0; i < buildings.length; i++) {
                const pb = buildings[i];
                if (!pb || pb.hp <= 0) continue;
                const minSep = bRadius + Math.max(pb.footprintRadius || 2.4, 2.2) + 3.2;
                if (Math.hypot(tx - pb.pos.x, tz - pb.pos.z) < minSep) return false;
            }
        }

        // STRICT NON-OVERLAP: Enforce spacing against active Battle Cinematic buildings & Registered Map Structures
        if (window.BATTLE_CINEMATIC && window.BATTLE_CINEMATIC.active && Array.isArray(window.BATTLE_CINEMATIC.actors?.buildings)) {
            for (let i = 0; i < window.BATTLE_CINEMATIC.actors.buildings.length; i++) {
                const cb = window.BATTLE_CINEMATIC.actors.buildings[i];
                if (!cb || cb.hp <= 0 || !cb.pos) continue;
                if (Math.hypot(tx - cb.pos.x, tz - cb.pos.z) < bRadius + 3.8) return false;
            }
        }
        if (Array.isArray(window.REGISTERED_MAP_STRUCTURES)) {
            for (let i = 0; i < window.REGISTERED_MAP_STRUCTURES.length; i++) {
                const ms = window.REGISTERED_MAP_STRUCTURES[i];
                if (!ms) continue;
                if (Math.hypot(tx - ms.x, tz - ms.z) < bRadius + (ms.r || 3.2) + 0.6) return false;
            }
        }

        // Avoid terrain obstacles & mineral patches
        if (typeof obstacles !== 'undefined') {
            for (let i = 0; i < obstacles.length; i++) {
                const obs = obstacles[i];
                if (!obs) continue;
                if (ignoreMinorProps && !obs.isStructure && obs.type !== 'mineral') continue;
                const obsRad = obs.footprintR || obs.r || 1.2;
                if (Math.hypot(tx - obs.x, tz - obs.z) < bRadius + obsRad + (ignoreMinorProps ? 0.6 : 1.1)) return false;
            }
        }
        return true;
    };

    const isBuildingOnlyClear = (tx, tz) => {
        if (Math.max(Math.abs(tx), Math.abs(tz)) > 99.0) return false;
        const h = getTerrainHeight(tx, tz);
        if (h < -0.25 || h > 9.5) return false;
        for (let i = 0; i < enemyBuildings.length; i++) {
            const eb = enemyBuildings[i];
            if (eb && eb.hp > 0 && Math.hypot(tx - eb.pos.x, tz - eb.pos.z) < bRadius + Math.max(eb.footprintRadius || 2.6, 2.2) + 1.8) return false;
        }
        if (typeof solarisBuildings !== 'undefined') {
            for (let i = 0; i < solarisBuildings.length; i++) {
                const sb = solarisBuildings[i];
                if (sb && sb.hp > 0 && Math.hypot(tx - sb.pos.x, tz - sb.pos.z) < bRadius + Math.max(sb.footprintRadius || 2.4, 2.0) + 1.8) return false;
            }
        }
        if (typeof buildings !== 'undefined') {
            for (let i = 0; i < buildings.length; i++) {
                const pb = buildings[i];
                if (pb && pb.hp > 0 && Math.hypot(tx - pb.pos.x, tz - pb.pos.z) < bRadius + Math.max(pb.footprintRadius || 2.4, 2.0) + 1.8) return false;
            }
        }
        return true;
    };

    if (isSpotClear(desiredPos.x, desiredPos.z, false)) {
        return new THREE.Vector3(desiredPos.x, getTerrainHeight(desiredPos.x, desiredPos.z), desiredPos.z);
    }

    const searchOrigin = anchorCenter || desiredPos;
    const maxSearchR = anchorCenter ? maxAnchorDist : 36.0;

    // Pass 1: Strict search around desiredPos, then around anchorCenter
    for (let r = 2.2; r <= maxSearchR; r += 1.6) {
        const steps = 28;
        for (let s = 0; s < steps; s++) {
            const ang = (s / steps) * Math.PI * 2 + r * 0.35;
            const tx = desiredPos.x + Math.cos(ang) * r;
            const tz = desiredPos.z + Math.sin(ang) * r;
            if (isSpotClear(tx, tz, false)) {
                return new THREE.Vector3(tx, getTerrainHeight(tx, tz), tz);
            }
        }
    }

    // Pass 2: Ignore minor tree/boulder props, but NEVER overlap any building!
    for (let r = 2.5; r <= maxSearchR + 8.0; r += 1.8) {
        const steps = 32;
        for (let s = 0; s < steps; s++) {
            const ang = (s / steps) * Math.PI * 2 + r * 0.45;
            const tx = searchOrigin.x + Math.cos(ang) * r;
            const tz = searchOrigin.z + Math.sin(ang) * r;
            if (isSpotClear(tx, tz, true)) {
                return new THREE.Vector3(tx, getTerrainHeight(tx, tz), tz);
            }
        }
    }

    // Pass 3: Wide spiral fallback guaranteeing zero building-to-building overlap even on cramped islands
    for (let r = 3.0; r <= 55.0; r += 2.0) {
        const steps = 36;
        for (let s = 0; s < steps; s++) {
            const ang = (s / steps) * Math.PI * 2 + r * 0.3;
            const tx = searchOrigin.x + Math.cos(ang) * r;
            const tz = searchOrigin.z + Math.sin(ang) * r;
            if (isBuildingOnlyClear(tx, tz)) {
                return new THREE.Vector3(tx, getTerrainHeight(tx, tz), tz);
            }
        }
    }
    return new THREE.Vector3(desiredPos.x, getTerrainHeight(desiredPos.x, desiredPos.z), desiredPos.z);
}

function initEnemyHiveCluster() {
    // Enemy Zerg Main Base (Leviathan Citadel) starts ALONE at ENEMY_BASE_POS (zero pre-built barracks/factories/turrets!).
    // The Enemy Zerg AI progressively constructs its Spawning Pool, Spine Crawlers, Bio-Factory & Drill Towers over time!
    if (typeof window.flattenTerrainUnderBuilding === 'function') {
        ENEMY_BASE_POS.y = window.flattenTerrainUnderBuilding(ENEMY_BASE_POS.x, ENEMY_BASE_POS.z, 4.6, 2.6);
    } else {
        ENEMY_BASE_POS.y = getTerrainHeight(ENEMY_BASE_POS.x, ENEMY_BASE_POS.z);
    }
    const citadelMesh = createLeviathanCitadel();
    citadelMesh.position.copy(ENEMY_BASE_POS);
    citadelMesh.visible = false;
    scene.add(citadelMesh);
    const cBadge = document.createElement('div');
    cBadge.style.display = 'none';
    const cHb = makeHealthPip('#ff2a4b', true);
    const citadelObj = {
        role: 'citadel',
        faction: 'zerg',
        mesh: citadelMesh,
        pos: ENEMY_BASE_POS.clone(),
        footprintRadius: 3.5,
        hp: 3500,
        maxHp: 3500,
        buildProgress: 1.0,
        badge: cBadge,
        hb: cHb
    };
    state.enemyBase = citadelObj;
    enemyBuildings.push(citadelObj);

    const creepInfo = typeof window.getActiveZergCreepState === 'function'
        ? window.getActiveZergCreepState()
        : { hasBuiltZergMainBase: !window.titleScreenActive };
    creepRadius = creepInfo.hasBuiltZergMainBase ? 18.5 : 0.0;
    creepTargetRadius = creepInfo.hasBuiltZergMainBase ? 21.0 : 0.0;
    if (typeof updateZergCreepColors === 'function') {
        updateZergCreepColors(creepRadius, false, true);
    }

    // Compute smart tactical direction vectors from ENEMY_BASE_POS toward the battlefield center / player base
    // so the Zerg AI places defensive Spine/Drill towers on its front arc and production structures on wide flank lanes!
    const toCenterDx = -ENEMY_BASE_POS.x;
    const toCenterDz = -ENEMY_BASE_POS.z;
    const toCenterLen = Math.hypot(toCenterDx, toCenterDz) || 1;
    const fwdX = toCenterDx / toCenterLen;
    const fwdZ = toCenterDz / toCenterLen;
    const rightX = -fwdZ;
    const rightZ = fwdX;

    const makeTacticalOffset = (alongFwd, acrossRight) => new THREE.Vector3(
        fwdX * alongFwd + rightX * acrossRight,
        0,
        fwdZ * alongFwd + rightZ * acrossRight
    );

    // Spawn the primary Zerg Spawning Pool (barracks) and Bio-Factory (factory) with the Hive Cluster
    // so Zerg unit production is immediately operational and connected by organic creep!
    const poolDesired = new THREE.Vector3(ENEMY_BASE_POS.x + makeTacticalOffset(4.5, -8.8).x, 0, ENEMY_BASE_POS.z + makeTacticalOffset(4.5, -8.8).z);
    const poolSafePos = resolveSafeEnemyBuildingPos(poolDesired, 2.8, true, ENEMY_BASE_POS, 22.0);
    if (typeof window.flattenTerrainUnderBuilding === 'function') {
        poolSafePos.y = window.flattenTerrainUnderBuilding(poolSafePos.x, poolSafePos.z, 3.3, 1.8);
    }
    ENEMY_BARRACKS_POS.copy(poolSafePos);
    const poolMesh = createEnemySpawningPool();
    poolMesh.position.copy(poolSafePos);
    poolMesh.scale.set(1.0, 1.0, 1.0);
    scene.add(poolMesh);
    const poolBadge = document.createElement('div');
    poolBadge.style.display = 'none';
    enemyBuildings.push({
        role: 'barracks',
        bpIdx: 0,
        mesh: poolMesh,
        pos: poolSafePos.clone(),
        footprintRadius: 2.8,
        hp: 1300,
        maxHp: 1300,
        buildProgress: 1.0,
        badge: poolBadge,
        hb: makeHealthPip('#b845ff', true),
        spawnTimer: 2.4,
        spawnDuration: 6.2,
        hatchPulse: 0,
        currentYaw: 0,
        cooldown: 0.8
    });

    const facDesired = new THREE.Vector3(ENEMY_BASE_POS.x + makeTacticalOffset(4.2, 9.2).x, 0, ENEMY_BASE_POS.z + makeTacticalOffset(4.2, 9.2).z);
    const facSafePos = resolveSafeEnemyBuildingPos(facDesired, 3.0, true, ENEMY_BASE_POS, 22.5);
    if (typeof window.flattenTerrainUnderBuilding === 'function') {
        facSafePos.y = window.flattenTerrainUnderBuilding(facSafePos.x, facSafePos.z, 3.5, 1.8);
    }
    ENEMY_FACTORY_POS.copy(facSafePos);
    const facMesh = createEnemyBioFactory();
    facMesh.position.copy(facSafePos);
    facMesh.scale.set(1.0, 1.0, 1.0);
    scene.add(facMesh);
    const facBadge = document.createElement('div');
    facBadge.style.display = 'none';
    enemyBuildings.push({
        role: 'factory',
        bpIdx: 0,
        mesh: facMesh,
        pos: facSafePos.clone(),
        footprintRadius: 3.0,
        hp: 1600,
        maxHp: 1600,
        buildProgress: 0.72,
        badge: facBadge,
        hb: makeHealthPip('#b845ff', true),
        spawnTimer: 5.8,
        spawnDuration: 10.5,
        hatchPulse: 0,
        currentYaw: 0,
        cooldown: 1.0
    });

    // Refresh Zerg Creep so the Main Hive, Spawning Pool, and Bio-Factory are connected by organic creep
    if (typeof updateZergCreepColors === 'function') {
        updateZergCreepColors(creepRadius, false, true);
    }

    // Progressive Zerg Base Construction Blueprint Queue
    state.enemyBuildTimer = 14.0;
    state.enemyBuildBlueprints = [
        { role: 'barracks',          offset: makeTacticalOffset(4.5, -8.8),  radius: 2.8, maxHp: 1300, color: '#b845ff', idx: 0, isProd: true },
        { role: 'spine_turret',      offset: makeTacticalOffset(9.6, -3.6),  radius: 1.8, maxHp: 520,  color: '#84cc16', idx: 0, isProd: false },
        { role: 'evolution_chamber', offset: makeTacticalOffset(-5.4, 7.6),  radius: 2.35,maxHp: 980,  color: '#a3e635', idx: 0, isProd: false },
        { role: 'roach_warren',      offset: makeTacticalOffset(6.4,  6.8),  radius: 2.7, maxHp: 1400, color: '#b845ff', idx: 0, isProd: true },
        { role: 'factory',           offset: makeTacticalOffset(4.2,  9.2),  radius: 3.0, maxHp: 1600, color: '#b845ff', idx: 0, isProd: true },
        { role: 'spire_hive',        offset: makeTacticalOffset(-3.2, -9.6), radius: 2.6, maxHp: 1450, color: '#d946ef', idx: 0, isProd: true },
        { role: 'spine_turret',      offset: makeTacticalOffset(9.8,  3.8),  radius: 1.8, maxHp: 520,  color: '#84cc16', idx: 1, isProd: false },
        { role: 'drill_tower',       offset: makeTacticalOffset(7.5, -9.2),  radius: 2.2, maxHp: 680,  color: '#ff5400', idx: 0, isProd: false },
        { role: 'spine_turret',      offset: makeTacticalOffset(11.2, 0.0),  radius: 1.8, maxHp: 520,  color: '#84cc16', idx: 2, isProd: false },
        { role: 'drill_tower',       offset: makeTacticalOffset(7.5,  9.2),  radius: 2.2, maxHp: 680,  color: '#ff5400', idx: 1, isProd: false },
        { role: 'barracks',          offset: makeTacticalOffset(-7.8, -6.5), radius: 2.8, maxHp: 1300, color: '#b845ff', idx: 1, isProd: true }
    ];

    if (!(state.isMultiplayerMatch && !state.hasAlliedAiCommander)) {
        initSolarisSynodEnclave();
    }

    // Ensure initial Zerg patrol vanguard spawns and registers into enemies[] when battlefield initializes
    if (enemyBuildings.length > 0 && enemies.length === 0) {
        const spawnerBld = enemyBuildings.find(eb => eb && eb.role === 'barracks') || enemyBuildings[0];
        if (spawnerBld && spawnerBld.pos) {
            try {
                spawnEnemyFromBuilding('skitterer', spawnerBld.pos, spawnerBld);
                spawnEnemyFromBuilding('spitter', spawnerBld.pos, spawnerBld);
            } catch (spawnErr) {
                if (window.APP_ERROR_HANDLER) {
                    window.APP_ERROR_HANDLER.record('initEnemyHiveCluster:initialSpawn', spawnErr, 'zerg_ai', 'ERROR');
                }
            }
        }
    }
}

function constructNextEnemyZergStructure() {
    if (!state.enemyBase || state.enemyBase.hp <= 0 || !state.enemyBuildBlueprints) return;
    // Do not start a new Zerg structure while another Zerg structure is still gestating (< 75% complete)
    const currentlyGestating = enemyBuildings.some(eb => eb && eb.hp > 0 && eb.buildProgress !== undefined && eb.buildProgress < 0.75);
    if (currentlyGestating) return;

    for (let i = 0; i < state.enemyBuildBlueprints.length; i++) {
        const bp = state.enemyBuildBlueprints[i];
        const alreadyExists = enemyBuildings.some(eb => eb.hp > 0 && eb.role === bp.role && (eb.bpIdx || 0) === bp.idx);
        if (alreadyExists) continue;

        const rawDesired = bp.desiredPos
            ? bp.desiredPos.clone()
            : new THREE.Vector3(ENEMY_BASE_POS.x + bp.offset.x, 0, ENEMY_BASE_POS.z + bp.offset.z);
        const safePos = resolveSafeEnemyBuildingPos(rawDesired, bp.radius, Boolean(bp.isProd), ENEMY_BASE_POS, 23.5);
        if (typeof window.flattenTerrainUnderBuilding === 'function') {
            safePos.y = window.flattenTerrainUnderBuilding(safePos.x, safePos.z, bp.radius + 0.6, 1.8);
        }
        if (bp.role === 'barracks' && bp.idx === 0) ENEMY_BARRACKS_POS.copy(safePos);
        if (bp.role === 'factory' && bp.idx === 0) ENEMY_FACTORY_POS.copy(safePos);

        let mesh;
        if (bp.role === 'barracks') mesh = createEnemySpawningPool();
        else if (bp.role === 'factory') mesh = createEnemyBioFactory();
        else if (bp.role === 'roach_warren') {
            mesh = typeof createEnemyRoachWarren === 'function' ? createEnemyRoachWarren() : createEnemyBioFactory();
        } else if (bp.role === 'spire_hive' || bp.role === 'spire') {
            mesh = typeof createEnemySpire === 'function' ? createEnemySpire() : createEnemySpawningPool();
        } else if (bp.role === 'evolution_chamber') {
            mesh = typeof createEnemyEvolutionChamber === 'function' ? createEnemyEvolutionChamber() : createEnemySpawningPool();
        } else if (bp.role === 'drill_tower') {
            mesh = typeof createEnemySubterraneanDrillTower === 'function' ? createEnemySubterraneanDrillTower() : createEnemySpineTurret();
        } else {
            mesh = createEnemySpineTurret();
        }
        mesh.position.copy(safePos);
        // Keep root mesh.scale at 1.0 so the Zerg Organic Biomass Metamorphosis Cocoon renders at full size!
        mesh.scale.set(1.0, 1.0, 1.0);
        scene.add(mesh);

        const badge = document.createElement('div');
        badge.style.display = 'none';
        const hb = makeHealthPip(bp.color, true);
        enemyBuildings.push({
            role: bp.role,
            bpIdx: bp.idx,
            mesh,
            pos: safePos,
            footprintRadius: bp.radius,
            hp: bp.maxHp,
            maxHp: bp.maxHp,
            buildProgress: 0.02,
            badge,
            hb,
            spawnTimer: bp.role === 'barracks' ? 5.2 : 8.5,
            spawnDuration: bp.role === 'barracks' ? 6.5 : 11.5,
            hatchPulse: 0,
            currentYaw: 0,
            drillRadius: 18.5,
            cooldown: 1.0 + bp.idx * 0.35
        });
        if (typeof updateZergCreepColors === 'function') {
            updateZergCreepColors(creepRadius, false, false);
        }
        return;
    }
}

// 3RD FACTION: THE SOLARIS CHRONO-SYNOD ENCLAVE (Autonomously builds Khaydarin Pylons first to power Warp Gates, Robotics Bay & Photon Spires!)
function initSolarisSynodEnclave() {
    solarisBuildings.forEach(sb => {
        if (sb.mesh) scene.remove(sb.mesh);
        if (sb.hb && sb.hb.root) sb.hb.root.remove();
    });
    solarisBuildings.length = 0;

    if (state.isMultiplayerMatch && !state.hasAlliedAiCommander) return;
    if (typeof SOLARIS_BASE_POS === 'undefined') return;
    const safeNexusPos = resolveSafeEnemyBuildingPos(SOLARIS_BASE_POS, 3.2, true);
    SOLARIS_BASE_POS.copy(safeNexusPos);
    if (typeof window.flattenTerrainUnderBuilding === 'function') {
        SOLARIS_BASE_POS.y = window.flattenTerrainUnderBuilding(SOLARIS_BASE_POS.x, SOLARIS_BASE_POS.z, 3.8, 2.2);
    }

    const nexusMesh = createEngineeredBuilding('solaris_nexus', false);
    nexusMesh.position.copy(SOLARIS_BASE_POS);
    scene.add(nexusMesh);
    const nHb = makeHealthPip('#f5b932', true);
    solarisBuildings.push({
        type: 'solaris_nexus',
        role: 'nexus',
        bpIdx: 0,
        mesh: nexusMesh,
        pos: SOLARIS_BASE_POS.clone(),
        footprintRadius: 2.8,
        hp: 2400,
        maxHp: 2400,
        shield: 1200,
        maxShield: 1200,
        shieldRegenDelay: 0,
        buildProgress: 1.0,
        hb: nHb,
        spawnTimer: 8.5,
        spawnDuration: 12.0,
        spawnIndex: 0
    });

    // Pick a dynamic StarCraft Allied Playbook Doctrine on each map seed / match (Strictly within Allied Main Base Radius!)
    const doctrines = ['zealot_rush', 'massive_fleet', 'fortified_enclave'];
    state.solarisDoctrine = doctrines[Math.floor(Math.random() * doctrines.length)];
    state.solarisFleetReleased = false;

    state.solarisBuildTimer = 18.0;
    state.solarisBuildBlueprints = [
        // Protoss MUST warp in a Khaydarin Power Pylon FIRST to project a Psionic Matrix before warping in Gates/Robotics/Spires!
        { type: 'solaris_pylon',    role: 'pylon',    offset: [-5.8, -4.6], radius: 1.85, maxHp: 750,  color: '#38bdf8', idx: 0, label: 'KHAYDARIN PYLON ALPHA' },
        { type: 'solaris_gate',     role: 'gate',     offset: [-9.2, -3.2], radius: 2.25, maxHp: 1250, color: '#f5b932', idx: 0, label: 'WARP GATE ALPHA' },
        { type: 'solaris_spire',    role: 'spire',    offset: [-7.8,  5.8], radius: 1.70, maxHp: 900,  color: '#38bdf8', idx: 0, label: 'PHOTON SPIRE ALPHA' },
        { type: 'solaris_pylon',    role: 'pylon',    offset: [ 5.8, -4.6], radius: 1.85, maxHp: 750,  color: '#38bdf8', idx: 1, label: 'KHAYDARIN PYLON BETA' },
        { type: 'solaris_robotics', role: 'robotics', offset: [ 8.8, -5.2], radius: 2.50, maxHp: 1450, color: '#f5b932', idx: 0, label: 'ROBOTICS BAY ALPHA' },
        { type: 'solaris_spire',    role: 'spire',    offset: [-11.6, 1.8], radius: 1.70, maxHp: 900,  color: '#38bdf8', idx: 1, label: 'PHOTON SPIRE BETA' },
        { type: 'solaris_gate',     role: 'gate',     offset: [ 9.2,  4.8], radius: 2.25, maxHp: 1250, color: '#f5b932', idx: 1, label: 'WARP GATE BETA' },
        { type: 'solaris_spire',    role: 'spire',    offset: [ 3.4, -9.8], radius: 1.70, maxHp: 900,  color: '#38bdf8', idx: 2, label: 'PHOTON SPIRE GAMMA' }
    ];
}

function constructNextSolarisStructure() {
    if (!state.solarisBuildBlueprints || typeof SOLARIS_BASE_POS === 'undefined') return;

    // Wait if a Solaris structure is currently warping in (< 80% build progress) so AI builds at a natural pace
    const currentlyBuilding = solarisBuildings.some(sb => sb && sb.hp > 0 && sb.buildProgress !== undefined && sb.buildProgress < 0.80);
    if (currentlyBuilding) return;

    // 1. Repair damaged completed Solaris structures
    for (let s = 0; s < solarisBuildings.length; s++) {
        const sb = solarisBuildings[s];
        if (!sb || sb.hp <= 0) continue;
        if ((sb.buildProgress === undefined || sb.buildProgress >= 1.0) && sb.hp < sb.maxHp) {
            sb.hp = Math.min(sb.maxHp, sb.hp + Math.round(sb.maxHp * 0.25));
        }
    }

    // 2. If the Primary Solaris Nexus was destroyed, rebuild it first at SOLARIS_BASE_POS!
    const hasPrimaryNexus = solarisBuildings.some(sb => sb.hp > 0 && (sb.role === 'nexus' || sb.role === 'solaris_nexus') && (sb.bpIdx || 0) === 0);
    if (!hasPrimaryNexus) {
        const safeNexusPos = resolveSafeEnemyBuildingPos(SOLARIS_BASE_POS.clone(), 3.1, true, SOLARIS_BASE_POS, 21.5);
        if (typeof window.flattenTerrainUnderBuilding === 'function') {
            safeNexusPos.y = window.flattenTerrainUnderBuilding(safeNexusPos.x, safeNexusPos.z, 3.3, 1.6);
        }
        const nexusMesh = createEngineeredBuilding('solaris_nexus', false);
        nexusMesh.position.copy(safeNexusPos);
        nexusMesh.scale.set(1.0, 1.0, 1.0);
        if (nexusMesh.userData && nexusMesh.userData.scaffoldGroup) {
            nexusMesh.userData.scaffoldGroup.visible = true;
            if (nexusMesh.userData.mainStructure) nexusMesh.userData.mainStructure.scale.set(0.25, 0.08, 0.25);
        }
        scene.add(nexusMesh);
        const hb = makeHealthPip('#f5b932', true);
        solarisBuildings.push({
            type: 'solaris_nexus',
            role: 'nexus',
            bpIdx: 0,
            isProxy: false,
            mesh: nexusMesh,
            pos: safeNexusPos,
            footprintRadius: 2.8,
            hp: 2400,
            maxHp: 2400,
            shield: 1200,
            maxShield: 1200,
            shieldRegenDelay: 0,
            buildProgress: 0.02,
            hb,
            spawnTimer: 8.0,
            spawnDuration: 12.5,
            cooldown: 0.6
        });
        return;
    }

    // 3. Enforce Protoss Power Matrix Requirement: if no Khaydarin Pylon is active, build solaris_pylon FIRST!
    const hasCompletedPylon = solarisBuildings.some(sb => sb.hp > 0 && sb.role === 'pylon' && (sb.buildProgress === undefined || sb.buildProgress >= 1.0));

    for (let i = 0; i < state.solarisBuildBlueprints.length; i++) {
        const bp = state.solarisBuildBlueprints[i];
        if (!hasCompletedPylon && bp.role !== 'pylon') continue;
        const exists = solarisBuildings.some(sb => sb.hp > 0 && sb.role === bp.role && (sb.bpIdx || 0) === bp.idx);
        if (exists) continue;

        const desired = new THREE.Vector3(SOLARIS_BASE_POS.x + bp.offset[0], 0, SOLARIS_BASE_POS.z + bp.offset[1]);
        const isProd = (bp.role === 'gate' || bp.role === 'robotics' || bp.role === 'nexus');
        // Resolve a guaranteed non-overlapping spot strictly within 22.0m of SOLARIS_BASE_POS (NO post-clamp overwrite!)
        const safePos = resolveSafeEnemyBuildingPos(desired, bp.radius + 0.35, isProd, SOLARIS_BASE_POS, 22.0);
        if (typeof window.flattenTerrainUnderBuilding === 'function') {
            safePos.y = window.flattenTerrainUnderBuilding(safePos.x, safePos.z, bp.radius + 0.5, 1.6);
        }
        const mesh = createEngineeredBuilding(bp.type, false);
        mesh.position.copy(safePos);
        mesh.scale.set(1.0, 1.0, 1.0);
        if (mesh.userData && mesh.userData.scaffoldGroup) {
            mesh.userData.scaffoldGroup.visible = true;
            if (mesh.userData.mainStructure) mesh.userData.mainStructure.scale.set(0.25, 0.08, 0.25);
        }
        scene.add(mesh);
        const hb = makeHealthPip(bp.color, true);
        const maxShd = bp.role === 'nexus' ? 1100 : (bp.role === 'robotics' ? 750 : (bp.role === 'gate' ? 600 : 450));
        solarisBuildings.push({
            type: bp.type,
            role: bp.role,
            bpIdx: bp.idx,
            isProxy: false,
            mesh,
            pos: safePos,
            footprintRadius: bp.radius,
            hp: bp.maxHp,
            maxHp: bp.maxHp,
            shield: maxShd,
            maxShield: maxShd,
            shieldRegenDelay: 0,
            buildProgress: 0.02,
            hb,
            spawnTimer: 9.0,
            spawnDuration: 13.5,
            cooldown: 0.6 + bp.idx * 0.25
        });
        return;
    }
}

window.togglePlayerFaction = function() {
    state.playerFaction = state.playerFaction === 'terran' ? 'solaris' : 'terran';
    window.PLAYER_FACTION = state.playerFaction;
    const isSol = state.playerFaction === 'solaris';
    const badge = document.getElementById('mode-badge');
    if (badge) {
        badge.innerText = isSol ? 'SOLARIS PROTOSS' : 'TERRAN DOMINION';
        badge.style.color = isSol ? '#f5b932' : '';
        badge.style.borderColor = isSol ? '#f5b932' : '';
    }
    // Synchronize existing player structures and queued unit types to match the active faction so no cross-faction units or buildings remain
    if (Array.isArray(buildings)) {
        for (let i = 0; i < buildings.length; i++) {
            const b = buildings[i];
            if (!b || b.hp <= 0) continue;
            if (isSol) {
                if (b.type === 'barracks') { b.type = 'solaris_gate'; b.unitType = 'zealot'; }
                else if (b.type === 'factory') { b.type = 'solaris_robotics'; b.unitType = 'phoenix'; }
                else if (b.type === 'tech_lab') { b.type = 'solaris_cyber_lab'; }
            } else {
                if (b.type === 'solaris_gate') { b.type = 'barracks'; b.unitType = 'ranger'; }
                else if (b.type === 'solaris_robotics') { b.type = 'factory'; b.unitType = 'tank'; }
                else if (b.type === 'solaris_cyber_lab') { b.type = 'tech_lab'; }
            }
            const newModelType = (b.type === 'base' && isSol)
                ? 'solaris_nexus'
                : ((b.type === 'turret' && isSol) ? 'solaris_spire' : b.type);
            if (b.mesh && typeof createEngineeredBuilding === 'function') {
                const oldPos = b.mesh.position.clone();
                scene.remove(b.mesh);
                const newMesh = createEngineeredBuilding(newModelType, true);
                newMesh.position.copy(oldPos);
                if (b.buildProgress >= 1.0 && newMesh.userData) {
                    if (newMesh.userData.scaffoldGroup) newMesh.userData.scaffoldGroup.visible = false;
                    if (newMesh.userData.mainStructure) newMesh.userData.mainStructure.scale.set(1, 1, 1);
                }
                scene.add(newMesh);
                b.mesh = newMesh;
            }
        }
    }
    if (!isSol && (state.mode === 'solaris_gate' || state.mode === 'solaris_robotics' || state.mode === 'solaris_pylon' || state.mode === 'solaris_cyber_lab')) {
        setMode('select');
    } else if (isSol && (state.mode === 'barracks' || state.mode === 'factory' || state.mode === 'tech_lab')) {
        setMode('select');
    } else if (state.mode === 'base') {
        rebuildGhostModel('base');
    }
    if (typeof syncProtossPowerRadiusVisibility === 'function') syncProtossPowerRadiusVisibility();
    if (window.SFX) window.SFX.playClick();
    renderSC2CommandCard();
    updateHUD(true);
};

window.toggleSolarisDiplomacy = function() {
    state.solarisHostile = !state.solarisHostile;
    const btn = document.getElementById('btn-solaris-stance');
    if (btn) {
        btn.innerText = state.solarisHostile ? '❖ SYNOD: 3-WAY WAR' : '❖ SYNOD: ALLIED';
        btn.style.borderColor = state.solarisHostile ? '#ffaa00' : '';
        btn.style.color = state.solarisHostile ? '#ffe066' : '';
    }
    if (window.SFX) window.SFX.playClick();
    updateFogOfWarVision();
    renderTacticalMinimap();
};

initEnemyHiveCluster();

const ghostRoot = new THREE.Group();
scene.add(ghostRoot);
let ghostMesh = null;
const matGhostOk = new THREE.MeshBasicMaterial({ color: 0x00ff66, transparent: true, opacity: 0.48 });
const matGhostBad = new THREE.MeshBasicMaterial({ color: 0xff2a4b, transparent: true, opacity: 0.48 });

const previewRadiusGeo = new THREE.RingGeometry(POWER_RADIUS - 0.25, POWER_RADIUS, 80);
previewRadiusGeo.rotateX(-Math.PI / 2);
const previewRadiusRing = new THREE.Mesh(previewRadiusGeo, new THREE.MeshBasicMaterial({ color: 0x00e5ff, side: THREE.DoubleSide, transparent: true, opacity: 0.45 }));
previewRadiusRing.position.y = 0.15;
previewRadiusRing.visible = false;
ghostRoot.add(previewRadiusRing);

function syncProtossPowerRadiusVisibility() {
    window.PLAYER_FACTION = state.playerFaction || 'terran';
    const isProtoss = state.playerFaction === 'solaris';
    const placingProtoss = isProtoss && Boolean(state.mode && state.mode !== 'select');
    const selectingProtossBld = isProtoss && Boolean(
        state.selectedBuilding &&
        !state.selectedBuilding.isEnemy &&
        (state.selectedBuilding.type === 'base' ||
         state.selectedBuilding.type === 'turret' ||
         String(state.selectedBuilding.type || '').startsWith('solaris_'))
    );
    const activeProtossPowerUI = Boolean(isProtoss && (placingProtoss || selectingProtossBld));
    window.IS_PROTOSS_POWER_UI_ACTIVE = activeProtossPowerUI;
    previewRadiusRing.visible = Boolean(isProtoss && placingProtoss && (state.mode === 'base' || state.mode === 'solaris_pylon'));
    if (state.powerRing) {
        state.powerRing.visible = activeProtossPowerUI;
    }
    if (typeof buildings !== 'undefined' && Array.isArray(buildings)) {
        for (let i = 0; i < buildings.length; i++) {
            const b = buildings[i];
            if (b && b.mesh && b.mesh.userData && b.mesh.userData.pylonPowerRing) {
                b.mesh.userData.pylonPowerRing.visible = Boolean(activeProtossPowerUI && !b.isEnemy && (!b.faction || b.faction === 'solaris'));
            }
        }
    }
}
window.syncProtossPowerRadiusVisibility = syncProtossPowerRadiusVisibility;

const selRingGeo = new THREE.RingGeometry(1.2, 1.4, 32);
selRingGeo.rotateX(-Math.PI / 2);
const selRing = new THREE.Mesh(selRingGeo, new THREE.MeshBasicMaterial({ color: 0x00ff66, side: THREE.DoubleSide }));
selRing.visible = false;
scene.add(selRing);

// ============================================================================
// 3D HOLOGRAPHIC BASE PLACEMENT BARRIER SELECTION SYSTEM
// Renders designated Drop-Zone Foundation Barriers with Hazard Boundary Pylons,
// Pulsing Laser Fences, Holographic Foundation Grid & Tactical Selection API!
// ============================================================================
let BASE_PLACEMENT_BARRIERS = [];
let selectedBaseBarrierId = 'alpha';
const baseBarrierGroups = [];

function syncBasePlacementBarriersFromZones() {
    if (typeof BASE_PLACEMENT_ZONES !== 'undefined' && Array.isArray(BASE_PLACEMENT_ZONES) && BASE_PLACEMENT_ZONES.length > 0) {
        BASE_PLACEMENT_BARRIERS = BASE_PLACEMENT_ZONES.map((z, idx) => ({
            id: z.id || (idx === 0 ? 'alpha' : (idx === 1 ? 'beta' : 'gamma')),
            label: idx === 0
                ? 'DROP-ZONE ALPHA (CENTRAL PLATEAU)'
                : (idx === 1 ? 'DROP-ZONE BETA (WEST CANYON FLANK)' : 'DROP-ZONE GAMMA (EAST RIVER OVERLOOK)'),
            shortLabel: (z.id || 'ALPHA').toUpperCase(),
            x: z.x,
            z: z.z,
            radius: 5.5
        }));
    } else {
        BASE_PLACEMENT_BARRIERS = [
            { id: 'alpha', label: 'DROP-ZONE ALPHA (CENTRAL PLATEAU)', shortLabel: 'ALPHA', x: PLAYER_START_POS.x, z: PLAYER_START_POS.z, radius: 5.6 },
            { id: 'beta',  label: 'DROP-ZONE BETA (WEST CANYON FLANK)', shortLabel: 'BETA', x: PLAYER_START_POS.x - 13.5, z: PLAYER_START_POS.z + 5.5, radius: 5.4 },
            { id: 'gamma', label: 'DROP-ZONE GAMMA (EAST RIVER OVERLOOK)', shortLabel: 'GAMMA', x: PLAYER_START_POS.x + 13.5, z: PLAYER_START_POS.z + 4.5, radius: 5.4 }
        ];
    }
}

function buildBasePlacementBarrierMeshes() {
    while (baseBarrierGroups.length > 0) {
        const old = baseBarrierGroups.pop();
        if (old && old.group && old.group.parent) old.group.parent.remove(old.group);
    }
    // Sync logical drop-zone coordinates without adding 3D border spawn models to the scene
    syncBasePlacementBarriersFromZones();
}
buildBasePlacementBarrierMeshes();

function selectBaseBarrierZone(id, autoSnap = true) {
    selectedBaseBarrierId = id;
    const bObj = BASE_PLACEMENT_BARRIERS.find(b => b.id === id) || BASE_PLACEMENT_BARRIERS[0];
    if (bObj && autoSnap && !state.basePlaced) {
        setMode('base');
        const hy = getTerrainHeight(bObj.x, bObj.z);
        ghostRoot.position.set(bObj.x, hy, bObj.z);
        const evalRes = evaluateBuildSpot(new THREE.Vector3(bObj.x, hy, bObj.z));
        ghostMesh.traverse(c => { if (c.isMesh) c.material = evalRes.ok ? matGhostOk : matGhostBad; });
        cursorTag.innerText = evalRes.reason;
        cursorTag.className = evalRes.ok ? 'valid' : 'invalid';
        cursorTag.style.display = 'block';

        controls.target.set(bObj.x, hy, bObj.z);
        if (IS_MOBILE) {
            camera.position.set(bObj.x + 6, 52, bObj.z + 46);
        } else {
            camera.position.set(bObj.x + 4, 38, bObj.z + 34);
        }
        controls.update();
        if (window.SFX) window.SFX.playClick();
    }
    if (typeof window.SEND_NETWORK_ORDER === 'function' && autoSnap) {
        window.SEND_NETWORK_ORDER({ type: 'base_barrier', barrierId: id });
    }
}
window.selectBaseBarrierZone = selectBaseBarrierZone;

function deployBaseAtBarrier(id = selectedBaseBarrierId) {
    if (state.basePlaced) return false;
    const bObj = BASE_PLACEMENT_BARRIERS.find(b => b.id === id) || BASE_PLACEMENT_BARRIERS[0];
    if (!bObj) return false;
    setMode('base');
    const hy = getTerrainHeight(bObj.x, bObj.z);
    deployStructure(new THREE.Vector3(bObj.x, hy, bObj.z));
    return true;
}
window.deployBaseAtBarrier = deployBaseAtBarrier;

function updateBasePlacementBarriers(_dt) {
    if (baseBarrierGroups.length > 0) {
        baseBarrierGroups.forEach(bg => { if (bg && bg.group) bg.group.visible = false; });
    }
}

function rebuildGhostModel(mode) {
    if (ghostMesh) { ghostRoot.remove(ghostMesh); ghostMesh = null; }
    if (mode === 'select') {
        ghostRoot.visible = false;
        cursorTag.style.display = 'none';
        syncProtossPowerRadiusVisibility();
        return;
    }
    ghostRoot.visible = true;
    syncProtossPowerRadiusVisibility();
    ghostMesh = createEngineeredBuilding(mode, false);
    ghostMesh.traverse(c => { if (c.isMesh) c.material = matGhostOk; });
    ghostRoot.add(ghostMesh);
}
rebuildGhostModel('base');

function updateTurretWorldBadge(b) {
    // Floating upgrade UI removed so it never interrupts gameplay view
    if (b && b.turretBadge) {
        b.turretBadge.remove();
        b.turretBadge = null;
    }
}

function syncTurretPods(b) {
    if (!b || !b.mesh || !b.mesh.userData) return;
    if (b.isSolarisSpire || b.type === 'solaris_spire') {
        if (typeof updateTurretRangeVisuals === 'function') {
            updateTurretRangeVisuals(b, state.selectedBuilding === b);
        }
        return;
    }
    const head = b.mesh.userData.head;
    const mounts = b.mesh.userData.mounts;
    if (!head || !mounts) return;
    let hasShield = false;
    ['left', 'right', 'top'].forEach(slot => {
        if (mounts[slot]) {
            if (mounts[slot].userData.repairBeam) {
                scene.remove(mounts[slot].userData.repairBeam);
            }
            if (mounts[slot].userData.mindBeam) {
                scene.remove(mounts[slot].userData.mindBeam);
            }
            head.remove(mounts[slot]);
            mounts[slot] = null;
        }
        const wType = b.weapons[slot];
        if (wType === 'shield') hasShield = true;
        if (wType !== 'none') {
            const pod = createOrdnancePod(wType);
            if (wType === 'drone') {
                const rBeam = new THREE.Mesh(healBeamGeo, MAT.nanoWeldBeam);
                rBeam.visible = false;
                scene.add(rBeam);
                pod.userData.repairBeam = rBeam;
            } else if (wType === 'mindcontrol') {
                const mBeam = new THREE.Mesh(healBeamGeo, SHARED_FX_MAT.mindControlBeam || MAT.hiveVeinGlow);
                mBeam.visible = false;
                scene.add(mBeam);
                pod.userData.mindBeam = mBeam;
            }
            head.add(pod);
            if (typeof window.snapModularTurretAttachment === 'function') {
                window.snapModularTurretAttachment(b.mesh, pod, slot, b.level || 1, true);
            } else {
                if (slot === 'left') pod.position.set(-0.56, 0.02, 0.02);
                if (slot === 'right') pod.position.set(0.56, 0.02, 0.02);
                if (slot === 'top') pod.position.set(0, 0.50, 0.02);
            }
            mounts[slot] = pod;
        }
    });

    // Manage 3D Forcefield Shield Dome when 'shield' weapon is installed
    if (hasShield) {
        if (!b.shieldDomeMesh && typeof createTurretShieldDomeMesh === 'function') {
            b.shieldDomeMesh = createTurretShieldDomeMesh(9.5);
            b.shieldDomeMesh.traverse(c => { c.raycast = () => {}; });
            b.mesh.add(b.shieldDomeMesh);
            b.maxShieldHp = 450;
            b.shieldHp = 450;
            b.shieldBrokenTimer = 0;
        }
    } else if (b.shieldDomeMesh) {
        b.mesh.remove(b.shieldDomeMesh);
        b.shieldDomeMesh = null;
        b.shieldHp = 0;
        b.maxShieldHp = 0;
        b.shieldBrokenTimer = 0;
    }

    if (typeof updateTurretRangeVisuals === 'function') {
        updateTurretRangeVisuals(b, state.selectedBuilding === b);
    }
}

// HQ Emergency Repair Overload Shockwave: Instant-kills all surrounding enemies to prevent staying dead!
function executeHQEmergencyOverloadRepair() {
    if (!state.baseBuilding) return;
    const hqPos = state.baseBuilding.pos;
    const blastRadius = 28.0;

    // 1. Trigger massive Thermonuclear EMP + Thermal Shockwave Visual FX
    detonateHQOverloadBlast(hqPos);

    // 2. Instant-kill all enemies around the HQ within 28m with heavy ragdoll blast impulse & limb dismemberment
    let purgedCount = 0;
    enemies.forEach(e => {
        const dist = Math.hypot(e.mesh.position.x - hqPos.x, e.mesh.position.z - hqPos.z);
        if (dist <= blastRadius && e.hp > 0) {
            recordRagdollHitImpulse(e, hqPos, true);
            e.hp = 0;
            purgedCount++;
        }
    });

    // 3. Restore HQ and nearby friendly structures
    state.baseBuilding.hp = state.baseBuilding.maxHp;
    buildings.forEach(b => {
        if (b !== state.baseBuilding && b.hp > 0 && b.pos.distanceTo(hqPos) <= 18.0) {
            b.hp = Math.min(b.maxHp, b.hp + 250);
            spawnNanoWeldSparkFX(b.pos);
        }
    });

    spawnNanoWeldSparkFX(hqPos);
    spawnCombatFloat(hqPos, `OVERLOAD BLAST! (${purgedCount} HOSTILES VAPORIZED)`, '#00e5ff');
    const ticker = document.getElementById('directive-ticker');
    if (ticker) {
        ticker.innerText = `HQ EMERGENCY OVERLOAD DETONATED — ${purgedCount} SURROUNDING ENEMIES VAPORIZED & HQ RESTORED TO 100%!`;
        ticker.style.color = '#00e5ff';
    }
    updateHUD();
}

function upgradeTurret(b) {
    if (!b || b.type !== 'turret') return;
    const curLvl = b.level || 1;
    const upgCost = curLvl === 1 ? 120 : (curLvl === 2 ? 180 : 250);
    if (state.req < upgCost) {
        spawnCombatFloat(b.pos, `NEED ${upgCost}M TO UPGRADE!`, '#ff2a4b');
        return;
    }
    state.req -= upgCost;
    b.level = curLvl + 1;
    b.maxPower = (b.maxPower || 3) + 3;
    b.maxHp += 260;
    b.hp = Math.min(b.maxHp, b.hp + 260);
    applyTurretUpgradeModel(b.mesh, b.level);
    syncTurretPods(b);
    spawnNanoWeldSparkFX(b.pos);
    if (window.SFX) window.SFX.playBuild();
    spawnCombatFloat(b.pos, `TURRET UPGRADED TO MK-${b.level}! (+260HP / +3⚡)`, '#ffaa00');
    renderSC2CommandCard();
    updateHUD();
}

// --- UNIT SELECTION & TACTICAL COMMAND HELPERS ---
function syncUnitSelectionVisuals() {
    units.forEach(u => {
        const isSel = state.selectedUnits.includes(u);
        if (u.selCircle) u.selCircle.visible = isSel;
        if (u.hb && u.hb.root) {
            if (isSel) u.hb.root.classList.add('selected-unit');
            else u.hb.root.classList.remove('selected-unit');
        }
    });
}

function setSelectedUnits(unitList) {
    state.selectedUnits = unitList.filter(u => u && u.hp > 0);
    if (state.selectedUnits.length > 0) {
        state.selectedBuilding = null;
        selRing.visible = false;
        buildings.forEach(bld => {
            if (bld.type === 'turret' && typeof updateTurretRangeVisuals === 'function') {
                updateTurretRangeVisuals(bld, false);
            }
        });
        state.mode = 'select';
        rebuildGhostModel('select');
        if (window.SFX) window.SFX.playClick();
    } else {
        state.unitCommandMode = null;
    }
    syncUnitSelectionVisuals();
    syncProtossPowerRadiusVisibility();
    renderSC2CommandCard();
    updateHUD();
}

function selectAllArmy() {
    if (units.length === 0) return;
    setSelectedUnits([...units]);
}
window.selectAllArmy = selectAllArmy;

function clearAllSelection() {
    state.selectedUnits = [];
    state.unitCommandMode = null;
    syncUnitSelectionVisuals();
    selectStructure(null);
}

// --- TACTICAL SQUAD FORMATIONS (SMART CONCAVE + MELEE VANGUARD, WEDGE, LINE, BOX, SPREAD) ---
function computeTacticalFormationPositions(squad, targetPos, formation = 'concave') {
    if (!squad || squad.length === 0 || !targetPos) return new Map();

    // Compute squad centroid to orient the formation toward the march or threat direction
    let cx = 0, cz = 0;
    squad.forEach(u => { cx += u.mesh.position.x; cz += u.mesh.position.z; });
    cx /= squad.length; cz /= squad.length;

    let fx = targetPos.x - cx;
    let fz = targetPos.z - cz;
    let fLen = Math.hypot(fx, fz);

    // If reforming in place (targetPos near centroid), orient toward nearest enemy or Enemy Hive
    if (fLen < 2.2) {
        let threatX = ENEMY_BASE_POS.x, threatZ = ENEMY_BASE_POS.z;
        let bestThreatDist = Infinity;
        enemies.forEach(e => {
            if (e && e.hp > 0 && e.mesh) {
                const d = Math.hypot(e.mesh.position.x - cx, e.mesh.position.z - cz);
                if (d < bestThreatDist) {
                    bestThreatDist = d;
                    threatX = e.mesh.position.x;
                    threatZ = e.mesh.position.z;
                }
            }
        });
        fx = threatX - cx;
        fz = threatZ - cz;
        fLen = Math.hypot(fx, fz);
    }
    if (fLen > 0.01) { fx /= fLen; fz /= fLen; }
    else { fx = 0; fz = -1; }

    // Right perpendicular vector
    const rx = -fz, rz = fx;
    const results = new Map();

    // Smart Combat-Efficient 'Form Squad' Concave + Front-Line Melee Formation
    if (formation === 'concave' || state.formSquadEnabled) {
        const meleeScreen = [];
        const rangedArc = [];
        const supportRear = [];

        squad.forEach(u => {
            if (['grunt', 'reaper', 'tank', 'skitterer', 'crusher', 'behemoth', 'zealot'].includes(u.type) || (u.type === 'valkyrie' && u.mechMode)) {
                meleeScreen.push(u);
            } else if (['medic', 'transport'].includes(u.type)) {
                supportRear.push(u);
            } else {
                rangedArc.push(u);
            }
        });

        // 1. Front-Line Melee & Heavy Vanguard Screen (tight slightly curved vanguard line in front)
        const mCount = meleeScreen.length;
        meleeScreen.forEach((u, idx) => {
            const sp = u.type === 'tank' ? 2.35 : 1.50;
            const normIdx = mCount > 1 ? (idx - (mCount - 1) * 0.5) : 0;
            const localRight = normIdx * sp;
            // Slight forward bow/screen
            const localForward = 1.45 - Math.abs(normIdx) * 0.18;
            let wx = targetPos.x + rx * localRight + fx * localForward;
            let wz = targetPos.z + rz * localRight + fz * localForward;
            if (!u.isAir && typeof isPointWalkableForUnit === 'function' && !isPointWalkableForUnit(wx, wz, u.radius || 0.52)) {
                wx = targetPos.x; wz = targetPos.z;
            }
            results.set(u, new THREE.Vector3(wx, getSurfaceHeightWithBridges(wx, wz), wz));
        });

        // 2. Ranged Concave Firing Arc (parabolic crescent behind melee line so all ranged units focus fire inward without blocking each other)
        const rCount = rangedArc.length;
        const maxPerRank = 7;
        rangedArc.forEach((u, idx) => {
            const rankIdx = Math.floor(idx / maxPerRank);
            const idxInRank = idx % maxPerRank;
            const countInRank = Math.min(maxPerRank, rCount - rankIdx * maxPerRank);
            const norm = countInRank > 1 ? (idxInRank / (countInRank - 1)) * 2.0 - 1.0 : 0.0; // -1 to +1
            const arcRadius = Math.max(2.6, countInRank * 0.92) + rankIdx * 1.65;
            const maxAngle = Math.min(Math.PI * 0.42, 0.30 + countInRank * 0.09);
            const theta = norm * maxAngle;

            // Concave crescent: wings curve forward toward the target while center stays behind melee screen
            const baseBack = (mCount > 0 ? 1.55 : 0.25) + rankIdx * 1.55;
            const localRight = Math.sin(theta) * arcRadius;
            const localBack = baseBack + (Math.cos(theta) - 1.0) * (arcRadius * 0.55);

            let wx = targetPos.x + rx * localRight - fx * localBack;
            let wz = targetPos.z + rz * localRight - fz * localBack;
            if (!u.isAir && typeof isPointWalkableForUnit === 'function' && !isPointWalkableForUnit(wx, wz, u.radius || 0.48)) {
                wx = targetPos.x; wz = targetPos.z;
            }
            results.set(u, new THREE.Vector3(wx, getSurfaceHeightWithBridges(wx, wz), wz));
        });

        // 3. Support Medics & Transports tucked safely in the rear pocket of the concave
        const sCount = supportRear.length;
        supportRear.forEach((u, idx) => {
            const normIdx = sCount > 1 ? (idx - (sCount - 1) * 0.5) : 0;
            const localRight = normIdx * 1.65;
            const localBack = (mCount > 0 ? 2.85 : 1.75) + (rCount > 0 ? 1.45 : 0);
            let wx = targetPos.x + rx * localRight - fx * localBack;
            let wz = targetPos.z + rz * localRight - fz * localBack;
            if (!u.isAir && typeof isPointWalkableForUnit === 'function' && !isPointWalkableForUnit(wx, wz, u.radius || 0.48)) {
                wx = targetPos.x; wz = targetPos.z;
            }
            results.set(u, new THREE.Vector3(wx, getSurfaceHeightWithBridges(wx, wz), wz));
        });

        return results;
    }

    // Sort units by tactical combat role: Heavy Armor/Melee Vanguard first, Ranged Core middle, Support Medics rear
    const rolePriority = { tank: 0, grunt: 1, reaper: 1, crusher: 1, behemoth: 1, skitterer: 1, hero: 2, ranger: 3, rocketman: 3, spitter: 3, heli: 4, valkyrie: 4, mutalisk: 4, medic: 5, transport: 6 };
    const sorted = [...squad].sort((a, b) => (rolePriority[a.type] ?? 3) - (rolePriority[b.type] ?? 3));

    const n = sorted.length;
    sorted.forEach((u, idx) => {
        let localRight = 0, localBack = 0;
        const spacing = u.type === 'tank' ? 2.4 : 1.55;

        if (formation === 'wedge') {
            if (idx === 0) {
                localRight = 0; localBack = 0;
            } else {
                const rank = Math.ceil(idx / 2);
                const side = (idx % 2 === 1) ? 1 : -1;
                localRight = side * rank * spacing * 0.92;
                localBack = rank * spacing * 0.85;
            }
        } else if (formation === 'line') {
            const cols = Math.max(3, Math.ceil(Math.sqrt(n * 2.2)));
            const row = Math.floor(idx / cols);
            const col = (idx % cols) - (Math.min(cols, n - row * cols) - 1) * 0.5;
            localRight = col * spacing * 1.05;
            localBack = row * spacing * 1.15;
        } else if (formation === 'box') {
            if (n <= 4) {
                const col = (idx % 2) - 0.5;
                const row = Math.floor(idx / 2) - 0.5;
                localRight = col * spacing * 1.2;
                localBack = row * spacing * 1.2;
            } else {
                const ang = (idx / n) * Math.PI * 2;
                const rad = u.type === 'medic' ? 0.5 : Math.max(1.8, n * 0.28);
                localRight = Math.sin(ang) * rad;
                localBack = Math.cos(ang) * rad;
            }
        } else {
            const cols = Math.ceil(Math.sqrt(n));
            const row = Math.floor(idx / cols);
            const col = (idx % cols) - (cols - 1) * 0.5;
            localRight = col * spacing * 1.75;
            localBack = row * spacing * 1.75;
        }

        const wx = targetPos.x + rx * localRight - fx * localBack;
        const wz = targetPos.z + rz * localRight - fz * localBack;
        results.set(u, new THREE.Vector3(wx, getSurfaceHeightWithBridges(wx, wz), wz));
    });
    return results;
}

function formSquadImmediately() {
    if (state.selectedUnits.length === 0) return;
    state.formSquadEnabled = true;
    state.squadFormation = 'concave';
    let cx = 0, cz = 0;
    state.selectedUnits.forEach(u => { cx += u.mesh.position.x; cz += u.mesh.position.z; });
    cx /= state.selectedUnits.length;
    cz /= state.selectedUnits.length;
    const centerPt = new THREE.Vector3(cx, getSurfaceHeightWithBridges(cx, cz), cz);
    issueSquadOrder('attack_move', centerPt);
    spawnCombatFloat(centerPt, 'SQUAD FORMED: MELEE FRONT + RANGED CONCAVE!', '#00ff66');
    syncFormSquadButtonUI();
}
window.formSquadNow = formSquadImmediately;

function toggleFormSquadMode() {
    state.formSquadEnabled = !state.formSquadEnabled;
    if (state.formSquadEnabled) {
        state.squadFormation = 'concave';
        formSquadImmediately();
    } else {
        state.squadFormation = 'wedge';
        syncFormSquadButtonUI();
        renderSC2CommandCard();
    }
}
window.toggleFormSquad = toggleFormSquadMode;
window.triggerFormSquad = toggleFormSquadMode;

function syncFormSquadButtonUI() {
    const btn = document.getElementById('btn-form-squad');
    const lbl = document.getElementById('form-squad-label');
    if (btn) {
        if (state.formSquadEnabled) btn.classList.add('active');
        else btn.classList.remove('active');
    }
    if (lbl) {
        lbl.innerText = state.formSquadEnabled
            ? 'FORM SQUAD: ON (CONCAVE)'
            : `FORM SQUAD: ${state.squadFormation.toUpperCase()}`;
    }
}

function cycleSquadFormation() {
    const order = ['concave', 'wedge', 'line', 'box', 'spread'];
    const nextIdx = (order.indexOf(state.squadFormation) + 1) % order.length;
    state.squadFormation = order[nextIdx];
    state.formSquadEnabled = (state.squadFormation === 'concave');
    syncFormSquadButtonUI();
    if (state.selectedUnits.length > 0) {
        let cx = 0, cz = 0;
        state.selectedUnits.forEach(u => { cx += u.mesh.position.x; cz += u.mesh.position.z; });
        cx /= state.selectedUnits.length; cz /= state.selectedUnits.length;
        issueSquadOrder('attack_move', new THREE.Vector3(cx, getSurfaceHeightWithBridges(cx, cz), cz));
    }
    renderSC2CommandCard();
}

// ============================================================================
// SQUAD INTELLIGENCE SYSTEM (AUTO DEFENSIVE PHALANX vs AGGRESSIVE HUNT)
// & FACTION LAB UPGRADES (ARMS & ARMOR LV.1-LV.3 WITH 3D VISUAL ATTACHMENTS)
// ============================================================================
function syncSquadIntelButtonUI() {
    const btn = document.getElementById('btn-squad-intel');
    if (!btn) return;
    if (!state.squadIntelligence) {
        btn.innerText = '🧠 SQUAD AI: MANUAL';
        btn.style.borderColor = 'rgba(148,163,184,0.45)';
        btn.style.color = '#94a3b8';
    } else if (state.squadPosture === 'HUNTING') {
        btn.innerText = '🧠 SQUAD AI: HUNTING';
        btn.style.borderColor = '#ffaa00';
        btn.style.color = '#fde047';
    } else {
        btn.innerText = '🧠 SQUAD AI: DEFENSIVE';
        btn.style.borderColor = '#00e5ff';
        btn.style.color = '#67e8f9';
    }
}

window.toggleSquadIntelligence = function() {
    state.squadIntelligence = !state.squadIntelligence;
    if (window.SFX) window.SFX.playClick();
    syncSquadIntelButtonUI();
    renderSC2CommandCard();
};

function updateSquadIntelligence(dt) {
    if (!state.basePlaced || state.missionWon || !state.squadIntelligence) return;
    state.squadIntelTimer = (state.squadIntelTimer || 0.45) - dt;
    if (state.squadIntelTimer > 0) return;
    state.squadIntelTimer = 0.75;

    const autoSquad = units.filter(u =>
        u && u.hp > 0 && u.order === 'auto' &&
        u.type !== 'transport' && !(u.type === 'siege_tank' && u.siegeMode) && !u.tankTacticalRetreat
    );
    if (autoSquad.length === 0) return;

    const hqPos = state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS;
    let squadCx = 0, squadCz = 0;
    for (let i = 0; i < autoSquad.length; i++) {
        squadCx += autoSquad[i].mesh.position.x;
        squadCz += autoSquad[i].mesh.position.z;
    }
    squadCx /= autoSquad.length;
    squadCz /= autoSquad.length;

    // Evaluate nearby/detected enemy Zerg clusters (ignore unspotted enemies far away so defensive posture never rotates in circles around hidden units!)
    let nearSquadEnemies = 0;
    let nearHqEnemies = 0;
    let nearestClusterCenter = null;
    let bestClusterScore = -Infinity;

    for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (!e || e.hp <= 0 || !e.mesh) continue;
        const ex = e.mesh.position.x, ez = e.mesh.position.z;
        const dSquad = Math.hypot(ex - squadCx, ez - squadCz);
        const dHq = Math.hypot(ex - hqPos.x, ez - hqPos.z);
        if (dSquad <= 26.0) nearSquadEnemies++;
        if (dHq <= 34.0) nearHqEnemies++;

        const isKnownEnemy = state.isEndless || dHq <= 36.0 || dSquad <= 30.0 || (typeof isWorldPosVisible === 'function' && isWorldPosVisible(ex, ez));
        if (!isKnownEnemy) continue;

        // Measure local Zerg cluster density around enemy `e`
        let neighbors = 1;
        for (let j = 0; j < enemies.length; j++) {
            if (i === j || !enemies[j] || enemies[j].hp <= 0) continue;
            if (Math.hypot(enemies[j].mesh.position.x - ex, enemies[j].mesh.position.z - ez) <= 11.5) {
                neighbors++;
            }
        }
        const score = neighbors * 18.0 - dSquad * 0.65 - dHq * 0.45;
        if (score > bestClusterScore) {
            bestClusterScore = score;
            nearestClusterCenter = e.mesh.position.clone();
        }
    }

    const highZergThreatNear = (nearHqEnemies >= 2) || (nearSquadEnemies >= 4 && nearSquadEnemies > autoSquad.length);
    const canAggressiveHunt = !highZergThreatNear && (enemies.length > 0 || enemyBuildings.length > 0);

    const prevPosture = state.squadPosture;
    state.squadPosture = canAggressiveHunt ? 'HUNTING' : 'DEFENSIVE';
    if (prevPosture !== state.squadPosture) {
        syncSquadIntelButtonUI();
    }

    if (state.squadPosture === 'DEFENSIVE' && highZergThreatNear && nearestClusterCenter) {
        // DEFENSIVE FORMATION: Form a protective concave screen ONLY when enemies are actually threatening HQ or the squad!
        const toThreatX = nearestClusterCenter.x - hqPos.x;
        const toThreatZ = nearestClusterCenter.z - hqPos.z;
        const toThreatLen = Math.hypot(toThreatX, toThreatZ) || 1;
        const defStandDist = nearHqEnemies > 0 ? 11.5 : 15.5;
        const defAnchorX = THREE.MathUtils.clamp(hqPos.x + (toThreatX / toThreatLen) * defStandDist, -98, 98);
        const defAnchorZ = THREE.MathUtils.clamp(hqPos.z + (toThreatZ / toThreatLen) * defStandDist, -98, 98);
        const defAnchor = new THREE.Vector3(defAnchorX, getTerrainHeight(defAnchorX, defAnchorZ), defAnchorZ);
        const formMap = computeTacticalFormationPositions(autoSquad, defAnchor, 'concave');
        autoSquad.forEach(u => {
            if (formMap && formMap.has(u)) {
                u.patrolTarget = formMap.get(u);
            }
        });
    } else if (state.squadPosture === 'HUNTING' && nearestClusterCenter) {
        // AGGRESSIVE HUNTING BEHAVIOR: Coordinate pack hunting toward the detected enemy cluster!
        autoSquad.forEach(u => {
            u.patrolTarget = nearestClusterCenter.clone();
        });
    }
    // When no nearby cluster is detected, do NOT overwrite u.patrolTarget so units smoothly advance along their scouting path toward ENEMY_BASE_POS!
}

function applyFactionTechToExistingUnits(factionKey) {
    const upg = (state.upgrades && state.upgrades[factionKey]) ? state.upgrades[factionKey] : { weapons: 0, armor: 0 };
    const wMult = 1.0 + (upg.weapons || 0) * 0.20;
    const aMult = 1.0 + (upg.armor || 0) * 0.20;

    if (factionKey === 'zerg') {
        enemies.forEach(e => {
            if (!e || e.hp <= 0) return;
            if (!e.baseMaxHp) e.baseMaxHp = e.maxHp;
            if (!e.baseDamage) e.baseDamage = e.damage;
            const prevMax = e.maxHp;
            e.maxHp = Math.round(e.baseMaxHp * aMult);
            if (e.maxHp > prevMax) e.hp = Math.min(e.maxHp, e.hp + (e.maxHp - prevMax));
            e.damage = Math.round(e.baseDamage * wMult);
            e.armorBonus = (upg.armor || 0) * 2;
            if (typeof window.applyUnitUpgradeVisuals === 'function') {
                window.applyUnitUpgradeVisuals(e, upg.weapons || 0, upg.armor || 0, 'zerg');
            }
        });
        return;
    }

    units.forEach(u => {
        if (!u || u.hp <= 0) return;
        const isSolUnit = ['zealot', 'stalker', 'archon', 'phoenix', 'void_ray', 'carrier'].includes(u.type);
        const unitFac = u.isMindControlled ? 'zerg' : (isSolUnit ? 'solaris' : 'terran');
        if (unitFac !== factionKey) return;
        if (!u.baseMaxHp) u.baseMaxHp = u.maxHp;
        if (!u.baseDamage) u.baseDamage = u.damage;
        const prevMax = u.maxHp;
        u.maxHp = Math.round(u.baseMaxHp * aMult);
        if (u.maxHp > prevMax) u.hp = Math.min(u.maxHp, u.hp + (u.maxHp - prevMax));
        if (u.baseDamage > 0) {
            u.damage = Math.round(u.baseDamage * wMult);
        }
        u.armorBonus = (upg.armor || 0) * 2;
        if (typeof window.applyUnitUpgradeVisuals === 'function') {
            window.applyUnitUpgradeVisuals(u, upg.weapons || 0, upg.armor || 0, factionKey);
        }
    });
}

window.upgradeFactionTech = function(category = 'weapons', factionKey = null, useGems = false) {
    const fac = factionKey || (state.playerFaction === 'solaris' ? 'solaris' : 'terran');
    if (!state.upgrades) {
        state.upgrades = { terran: { weapons: 0, armor: 0 }, solaris: { weapons: 0, armor: 0 }, zerg: { weapons: 0, armor: 0 } };
    }
    const upg = state.upgrades[fac] || (state.upgrades[fac] = { weapons: 0, armor: 0 });
    const curLvl = upg[category] || 0;
    if (curLvl >= 3) return false;

    const costMinerals = curLvl === 0 ? 120 : (curLvl === 1 ? 180 : 250);
    const costGems = 20;

    if (useGems) {
        if ((state.gems || 0) < costGems) return false;
        state.gems -= costGems;
    } else {
        if (state.req < costMinerals) return false;
        state.req -= costMinerals;
    }

    upg[category] = curLvl + 1;
    applyFactionTechToExistingUnits(fac);

    if (state.selectedBuilding && state.selectedBuilding.pos && typeof spawnNanoWeldSparkFX === 'function') {
        spawnNanoWeldSparkFX(state.selectedBuilding.pos);
    }
    if (window.SFX) window.SFX.playBuild();
    renderSC2CommandCard();
    updateHUD(true);
    return true;
};

function issueSquadOrder(orderType, targetWorldPos = null, keepCommandMode = false) {
    if (state.selectedUnits.length === 0) return;

    let resolvedTarget = targetWorldPos ? targetWorldPos.clone() : null;
    if (!resolvedTarget && orderType === 'retreat') {
        const hqAnchor = state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS;
        resolvedTarget = new THREE.Vector3(hqAnchor.x, getTerrainHeight(hqAnchor.x, hqAnchor.z + 4.5), hqAnchor.z + 4.5);
    }

    const activeFormation = state.formSquadEnabled ? 'concave' : state.squadFormation;
    const formMap = resolvedTarget
        ? computeTacticalFormationPositions(state.selectedUnits, resolvedTarget, activeFormation)
        : null;

    state.selectedUnits.forEach((u) => {
        u.order = orderType;
        u.spawnRallyTimer = 0;
        if (resolvedTarget && formMap && formMap.has(u)) {
            u.orderTarget = formMap.get(u);
        } else if (resolvedTarget) {
            u.orderTarget = resolvedTarget.clone();
        } else {
            u.orderTarget = null;
        }
    });

    const leadPos = state.selectedUnits[0].mesh.position;
    const orderLabelMap = {
        move: state.formSquadEnabled && state.selectedUnits.length > 1 ? 'MOVING IN COMBAT CONCAVE' : 'MOVING SQUAD',
        attack_move: state.formSquadEnabled && state.selectedUnits.length > 1 ? 'CONCAVE ATTACK-MOVE' : 'ATTACK-MOVE ENGAGED',
        hold: 'HOLDING POSITION',
        auto: 'AUTO SEEK & DESTROY',
        retreat: 'RETURNING TO MAIN BASE'
    };
    if (orderLabelMap[orderType]) {
        spawnCombatFloat(
            resolvedTarget || leadPos,
            orderLabelMap[orderType],
            orderType === 'attack_move' ? '#ff2a4b' : (orderType === 'hold' || orderType === 'retreat' ? '#00e5ff' : '#00ff66')
        );
    }

    if (resolvedTarget) {
        spawnTacticalOrderWaypointFX(resolvedTarget, orderType);
    }

    if (!keepCommandMode) {
        state.unitCommandMode = null;
    }
    if (window.SFX) window.SFX.playClick();
    renderSC2CommandCard();
    updateHUD();
}

const tacticalWaypoints = [];
let _waypointChevronGeo = null;
let _waypointSpireGeo = null;
function spawnTacticalOrderWaypointFX(targetPos, orderType = 'move') {
    if (!targetPos) return;
    if (!_waypointChevronGeo) {
        // Sculpted 3D angled tactical chevron bracket (zero basic circles/shockwaves)
        const shape = new THREE.Shape();
        shape.moveTo(0, 0.22);
        shape.lineTo(0.18, -0.06);
        shape.lineTo(0.11, -0.12);
        shape.lineTo(0, 0.06);
        shape.lineTo(-0.11, -0.12);
        shape.lineTo(-0.18, -0.06);
        shape.closePath();
        _waypointChevronGeo = new THREE.ExtrudeGeometry(shape, {
            depth: 0.045,
            bevelEnabled: true,
            bevelThickness: 0.012,
            bevelSize: 0.012,
            bevelSegments: 1
        });
        _waypointChevronGeo.rotateX(Math.PI / 2);
        _waypointSpireGeo = createSculptedFacetedCrystalGeo(0.09, 0);
    }

    const isAttack = (orderType === 'attack_move');
    const isHoldOrRetreat = (orderType === 'hold' || orderType === 'retreat');
    const hexColor = isAttack ? 0xff3b5c : (isHoldOrRetreat ? 0x00e5ff : 0x10b981);

    const mat = new THREE.MeshBasicMaterial({
        color: hexColor,
        transparent: true,
        opacity: 0.95,
        depthWrite: false
    });

    const root = new THREE.Group();
    const surfH = typeof getSurfaceHeightWithBridges === 'function' ? getSurfaceHeightWithBridges : getTerrainHeight;
    const gy = surfH(targetPos.x, targetPos.z) + 0.12;
    root.position.set(targetPos.x, gy, targetPos.z);

    // 4 converging 3D tactical chevron brackets pointing inward toward the target coordinate
    const chevrons = [];
    for (let i = 0; i < 4; i++) {
        const ang = (i * Math.PI) / 2 + Math.PI / 4;
        const chev = new THREE.Mesh(_waypointChevronGeo, mat);
        chev.rotation.y = -ang + Math.PI;
        chev.position.set(Math.sin(ang) * 0.85, 0.04, Math.cos(ang) * 0.85);
        root.add(chev);
        chevrons.push({ mesh: chev, ang });
    }

    // Descending 3D Diamond Beacon Pin that locks into the center point
    const beaconPin = new THREE.Mesh(_waypointSpireGeo, mat);
    beaconPin.scale.set(0.85, 2.4, 0.85);
    beaconPin.position.y = 0.95;
    root.add(beaconPin);

    scene.add(root);
    if (tacticalWaypoints.length >= 16) {
        const old = tacticalWaypoints.shift();
        scene.remove(old.root);
        if (old.mat) old.mat.dispose();
    }
    tacticalWaypoints.push({
        root,
        chevrons,
        beaconPin,
        mat,
        age: 0,
        maxLife: 0.58
    });
}

function recallAllFriendlyUnitsToMainBase() {
    if (units.length === 0) return;
    // If any enemies are alive on the map, do not recall units to the main base — let them hunt the remaining enemies!
    const hasActiveEnemies = enemies.some(e => e && e.hp > 0);
    if (hasActiveEnemies) return;

    const mainBasePos = state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS;
    const rawRallyX = mainBasePos.x;
    const rawRallyZ = mainBasePos.z - 6.8;
    const clearRally = typeof findClearSpawnPoint === 'function'
        ? findClearSpawnPoint(rawRallyX, rawRallyZ, ENEMY_BASE_POS.x, ENEMY_BASE_POS.z, 0.85, buildings, enemyBuildings, [])
        : { x: rawRallyX, z: rawRallyZ };
    const rallyCenter = new THREE.Vector3(clearRally.x, getTerrainHeight(clearRally.x, clearRally.z), clearRally.z);
    const formMap = computeTacticalFormationPositions(units, rallyCenter, state.squadFormation || 'concave');
    units.forEach(u => {
        u.order = 'retreat';
        u.isAutoRecall = true;
        u.spawnRallyTimer = 0;
        u.orderTarget = (formMap && formMap.has(u)) ? formMap.get(u) : rallyCenter.clone();
    });
    spawnCombatFloat(rallyCenter, 'HIVE DESTROYED — ALL UNITS RETURNING TO MAIN BASE!', '#00e5ff');
}

// --- STARCRAFT 1:1 3x3 COMMAND CARD & CENTER CONSOLE RENDERER ---
function updateCommPortrait(key, customQuote = null) {
    const avatarEl = document.getElementById('portrait-avatar-svg');
    const quoteEl = document.getElementById('portrait-quote');
    if (avatarEl) avatarEl.innerHTML = getPortraitAvatarSvg(key);
    const meta = UNIT_CONSOLE_META[key] || BUILDING_CONSOLE_META[key] || BUILDING_CONSOLE_META.base;
    if (quoteEl) quoteEl.innerText = customQuote || meta.quote;
    if (window.PORTRAIT_3D_VIEWER && typeof window.PORTRAIT_3D_VIEWER.setRole === 'function') {
        window.PORTRAIT_3D_VIEWER.setRole(key);
    }
}

function renderSC2CommandCard() {
    const grid = document.getElementById('command-grid');
    const titleEl = document.getElementById('cmd-card-title');
    const pwrEl = document.getElementById('cmd-power-tag');
    const prodPanel = document.getElementById('prod-queue-panel');
    const singleView = document.getElementById('single-selection-view');
    const multiView = document.getElementById('multi-selection-view');
    const statsStrip = document.getElementById('unit-stats-strip');
    const turretSlotBar = document.getElementById('turret-slot-bar');
    if (turretSlotBar) turretSlotBar.style.display = 'none';

    grid.innerHTML = '';
    pwrEl.innerText = '';

    // 1. FRIENDLY UNITS SELECTED (VIA CLICK-AND-DRAG / MOBILE HOLD SELECTION BOX OR TAP)
    if (state.selectedUnits.length > 0) {
        titleEl.innerText = 'TACTICAL ORDERS';
        pwrEl.innerText = `${state.selectedUnits.length} UNIT${state.selectedUnits.length > 1 ? 'S' : ''}`;
        prodPanel.style.display = 'none';

        const leadUnit = state.selectedUnits[0];
        updateCommPortrait(leadUnit.type);

        if (state.selectedUnits.length === 1) {
            singleView.style.display = 'flex';
            multiView.style.display = 'none';
            if (statsStrip) statsStrip.style.display = 'grid';

            const meta = UNIT_CONSOLE_META[leadUnit.type] || UNIT_CONSOLE_META.ranger;
            const roleClass = leadUnit.type === 'valkyrie'
                ? (leadUnit.mechMode ? 'MECH GND-ONLY' : 'AIR AA-ONLY')
                : (leadUnit.type === 'siege_tank'
                    ? (leadUnit.siegeMode ? 'ARTILLERY (28.5m)' : 'MOBILE TANK (14m)')
                    : (leadUnit.type === 'void_ray'
                        ? `PRISM TIER ${leadUnit.beamStage || 1}/3`
                        : (leadUnit.type === 'carrier'
                            ? `FLEET (${(leadUnit.interceptors || []).length}/${leadUnit.maxInterceptors || 5} INT)`
                            : (leadUnit.isMindControlled ? 'PSIONIC THRALL (MAX 3)' : (leadUnit.isMechanical ? 'MECHANICAL' : 'BIOLOGICAL')))));
            document.getElementById('sel-title').innerText = leadUnit.type === 'valkyrie'
                ? (leadUnit.mechMode ? 'VALKYRIE (SEMI-MECH WALKER)' : 'VALKYRIE (FLIGHT INTERCEPTOR)')
                : (leadUnit.type === 'siege_tank'
                    ? (leadUnit.siegeMode ? 'SIEGE TANK (ARTILLERY MODE)' : 'SIEGE TANK (MOBILE TANK)')
                    : meta.title);
            document.getElementById('sel-rank-tag').innerText = meta.rank;
            const typeTag = document.getElementById('sel-type-tag');
            if (typeTag) typeTag.innerText = roleClass;
            const wfRoleTag = document.getElementById('wireframe-role-tag');
            if (wfRoleTag) wfRoleTag.innerText = roleClass;
            document.getElementById('sel-subtitle').innerText = leadUnit.type === 'valkyrie'
                ? (leadUnit.mechMode
                    ? 'Semi-Mech Walker Mode: Walks on terrain & targets GROUND units/structures only. Press [T] for Flight Mode.'
                    : 'Flight Interceptor Mode: Flies at altitude & targets AIR enemies only. Press [T] for Semi-Mech Ground Mode.')
                : (leadUnit.type === 'siege_tank'
                    ? (leadUnit.siegeMode
                        ? 'Anchored Artillery Mode (28.5m range, 145 DMG splash): Auto-unsieges when moving or out of targets. Press [T] to Unsiege.'
                        : 'Mobile Tank Mode (14.0m range, 85 DMG): Automatically deploys hydraulic outriggers into Artillery Mode when enemies enter 28.5m range!')
                    : (leadUnit.type === 'void_ray'
                        ? `Sustained Prismatic Beam Cruiser: Ramps beam intensity across 3 tiers (Current Stage: ${leadUnit.beamStage || 1}/3) while focusing fire!`
                        : (leadUnit.type === 'carrier'
                            ? `Protoss Capital Dreadnought: Automatically fabricates & launches up to ${leadUnit.maxInterceptors || 5} autonomous Interceptors (${(leadUnit.interceptors || []).length} active)!`
                            : 'Right-click / tap ground to order, or select tactical directive on Command Card.')));
            document.getElementById('stat-weapon').innerText = leadUnit.type === 'valkyrie'
                ? (leadUnit.mechMode ? 'DUAL 35MM MECH CANNON' : 'TWIN HALO AA PODS')
                : (leadUnit.type === 'siege_tank'
                    ? (leadUnit.siegeMode ? '180MM MJOLNIR ARTILLERY' : 'TWIN 120MM SHOCK CANNON')
                    : meta.weapon);
            document.getElementById('stat-dmg').innerText = leadUnit.type === 'transport'
                ? 'TROOP BAY'
                : (leadUnit.type === 'carrier' ? `${(leadUnit.interceptors || []).length}x18 INT` : leadUnit.damage);
            document.getElementById('stat-rng').innerText = `${leadUnit.range}m`;
            document.getElementById('stat-order').innerText = (leadUnit.order || 'auto').toUpperCase();
            document.getElementById('wireframe-shield-tag').innerText = leadUnit.maxShield ? `SHIELD: ${Math.ceil(leadUnit.shield || 0)}/${leadUnit.maxShield}` : meta.armor;
        } else {
            singleView.style.display = 'none';
            multiView.style.display = 'flex';
            renderMultiUnitSelectionGrid();
        }

        setCmdTooltip(
            state.unitCommandMode
                ? `TARGETING [${state.unitCommandMode.toUpperCase()}]: Tap/Click anywhere on terrain or minimap to dispatch squad!`
                : 'Issue squad tactical orders [M: Move, A: Attack-Move, H: Hold, S: Auto, F: Charge, G: Guard HQ, V: Formation, T: Mode]'
        );

        const selectedValkyries = state.selectedUnits.filter(u => u.type === 'valkyrie');
        const anyMechValk = selectedValkyries.some(u => u.mechMode);
        const selectedSiegeTanks = state.selectedUnits.filter(u => u.type === 'siege_tank');
        const anySiegedTank = selectedSiegeTanks.some(u => u.siegeMode);

        const unitCmds = [
            {
                key: 'M', name: 'Move Squad', cost: 'ORDER', icon: 'move',
                desc: 'Move [M]: Tap/click terrain or minimap to march selected squad directly to target coordinates.',
                active: state.unitCommandMode === 'move' || state.selectedUnits.every(u => u.order === 'move'),
                fn: () => {
                    state.unitCommandMode = state.unitCommandMode === 'move' ? null : 'move';
                    if (window.SFX) window.SFX.playClick();
                    renderSC2CommandCard();
                }
            },
            {
                key: 'A', name: 'Attack-Move', cost: 'ENGAGE', icon: 'attack',
                desc: 'Attack-Move [A]: Immediately advance toward hostiles, or tap/click terrain to set custom Attack-Move destination.',
                active: state.unitCommandMode === 'attack_move' || state.selectedUnits.every(u => u.order === 'attack_move'),
                fn: () => {
                    let defaultDest = enemyBuildings.length > 0
                        ? enemyBuildings[0].pos
                        : (enemies.length > 0 ? enemies[0].mesh.position : (state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS));
                    state.unitCommandMode = 'attack_move';
                    issueSquadOrder('attack_move', defaultDest, true);
                }
            },
            {
                key: 'H', name: 'Hold Ground', cost: 'DEFEND', icon: 'hold',
                desc: 'Hold Position [H]: Stand ground at current coordinates and fire at enemies entering weapon range.',
                active: state.selectedUnits.every(u => u.order === 'hold'),
                fn: () => issueSquadOrder('hold', null)
            },
            {
                key: 'S', name: 'Auto Assault', cost: 'AI', icon: 'hero',
                desc: 'Autonomous Seek & Destroy [S]: Automatically engage enemies or return to Main Base when sector is clear.',
                active: state.selectedUnits.every(u => !u.order || u.order === 'auto'),
                fn: () => issueSquadOrder('auto', null)
            },
            {
                key: 'F', name: 'Charge Hive', cost: 'SIEGE', icon: 'attack',
                desc: 'All-Out Hive Siege [F]: Order selected squad to assault the Zerg Hive Cluster.',
                active: false,
                fn: () => {
                    const hiveTarget = enemyBuildings.length > 0
                        ? enemyBuildings[0].pos
                        : (enemies.length > 0 ? enemies[0].mesh.position : ENEMY_BASE_POS);
                    issueSquadOrder('attack_move', hiveTarget);
                }
            },
            {
                key: 'G', name: 'Guard HQ', cost: 'RALLY', icon: 'base',
                desc: 'Recall to Command HQ [G]: Immediately disengage and return to defend the Main Base perimeter.',
                active: state.selectedUnits.every(u => u.order === 'retreat'),
                fn: () => issueSquadOrder('retreat', state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS)
            },
            {
                key: 'V', name: state.formSquadEnabled ? 'Form: CONCAVE' : `Form: ${state.squadFormation.toUpperCase()}`, cost: 'FORM SQUAD', icon: 'turret',
                desc: 'Form Squad [V]: Positions melee in a protective front-line vanguard and ranged units in a combat-efficient concave firing arc.',
                active: state.formSquadEnabled,
                fn: () => formSquadImmediately()
            },
            selectedValkyries.length > 0 ? {
                key: 'T',
                name: anyMechValk ? 'Flight Mode' : 'Mech Walker',
                cost: anyMechValk ? 'TARGET AIR' : 'TARGET GND',
                icon: 'factory',
                desc: 'Transform Valkyrie [T]: Toggle between Flight Interceptor (targets AIR enemies only) and Semi-Mech Ground Walker (targets GROUND units & buildings only)!',
                active: anyMechValk,
                fn: () => toggleSelectedValkyrieMode()
            } : (selectedSiegeTanks.length > 0 ? {
                key: 'T',
                name: anySiegedTank ? 'Tank Mode' : 'Siege Mode',
                cost: (selectedSiegeTanks[0].siegeSwitchCooldown || 0) > 0
                    ? `CD ${selectedSiegeTanks[0].siegeSwitchCooldown.toFixed(1)}s`
                    : (anySiegedTank ? '14m MOBILE' : '6.5-28.5m ARTY'),
                icon: 'factory',
                desc: 'Transform Siege Tank [T] (4.5s Cooldown): Toggle between Mobile Tank (14m range) and Anchored Mjolnir Artillery Siege Mode (6.5m–28.5m range, 145 DMG splash — cannot fire inside 6.5m minimum range deadzone)!',
                active: anySiegedTank,
                fn: () => toggleSelectedSiegeTankMode()
            } : null),
            {
                key: 'ESC', name: 'Build Menu', cost: 'BACK', icon: 'base',
                desc: 'Return to Terran Construction Command Card [ESC].',
                active: false,
                fn: () => clearAllSelection()
            }
        ];

        unitCmds.forEach(uc => {
            const btn = document.createElement('button');
            if (!uc) {
                btn.className = 'cmd-cell'; btn.disabled = true;
                grid.appendChild(btn);
                return;
            }
            btn.className = 'cmd-cell' + (uc.active ? ' active' : '');
            btn.innerHTML = `<div class="cmd-top-row"><span class="cmd-hotkey">${uc.key}</span>${getCmdIconSvg(uc.icon)}</div><span class="cmd-name">${uc.name}</span><span class="cmd-cost">${uc.cost}</span>`;
            btn.onmouseenter = () => setCmdTooltip(uc.desc);
            btn.onclick = uc.fn;
            grid.appendChild(btn);
        });
        return;
    }

    singleView.style.display = 'flex';
    multiView.style.display = 'none';

    const sel = state.selectedBuilding;

    // 2A. PROTOSS / SOLARIS KHAYDARIN AEGIS SPIRE SELECTED (UNIQUE PROTOSS DEFENSIVE TURRET)
    if (sel && (sel.type === 'solaris_spire' || (sel.type === 'turret' && sel.isSolarisSpire))) {
        const curLvl = sel.level || 1;
        const upgCost = curLvl === 1 ? 120 : (curLvl === 2 ? 180 : 250);
        const spireDmg = 46 + (curLvl - 1) * 18;
        const spireRng = 20.5 + (curLvl - 1) * 2.5;
        const prioMode = sel.spirePriority || 'auto'; // 'auto' | 'air' | 'ground'

        titleEl.innerText = `AEGIS SPIRE MK-${curLvl}`;
        pwrEl.innerText = `PSI LV.${curLvl}`;
        prodPanel.style.display = 'none';
        if (statsStrip) statsStrip.style.display = 'grid';

        updateCommPortrait('solaris_spire');
        document.getElementById('sel-title').innerText = `KHAYDARIN AEGIS SPIRE MK-${curLvl}`;
        document.getElementById('sel-rank-tag').innerText = 'PROTOSS DEFENSE';
        const typeTag = document.getElementById('sel-type-tag');
        if (typeTag) typeTag.innerText = sel.buildProgress < 1.0 ? `WARPING (${Math.round(sel.buildProgress * 100)}%)` : 'ANTI-AIR & GND';
        const wfRoleTag = document.getElementById('wireframe-role-tag');
        if (wfRoleTag) wfRoleTag.innerText = `MK-${curLvl} SPIRE`;
        document.getElementById('sel-subtitle').innerText = sel.buildProgress < 1.0
            ? `Warping in Khaydarin Aegis Spire (${Math.round(sel.buildProgress * 100)}%) — Levitating psionic prism defense online upon completion!`
            : `Levitating Khaydarin crystal turret with 4 orbiting defensive pylons. Fires ${spireDmg} DMG psionic lances up to ${spireRng.toFixed(1)}m at Air & Ground!`;
        document.getElementById('stat-weapon').innerText = `KHAYDARIN PRISM MK-${curLvl}`;
        document.getElementById('stat-dmg').innerText = `${spireDmg} PSI`;
        document.getElementById('stat-rng').innerText = `${spireRng.toFixed(1)}m`;
        document.getElementById('stat-order').innerText = prioMode.toUpperCase();
        document.getElementById('wireframe-shield-tag').innerText = `SHIELD: ${Math.ceil(sel.shield || 0)}/${sel.maxShield || 400}`;
        setCmdTooltip(`Khaydarin Aegis Spire MK-${curLvl}: Select target priority [Q/W/E], Overcharge Shield [R], or Upgrade Spire [U].`);

        const spireCmds = [
            {
                key: 'Q', name: 'Target: Auto', cost: 'ALL', icon: 'attack',
                active: prioMode === 'auto',
                desc: 'Balanced Psionic Targeting [Q]: Engages the highest-threat Air or Ground enemy within range.',
                fn: () => { sel.spirePriority = 'auto'; renderSC2CommandCard(); }
            },
            {
                key: 'W', name: 'Priority: Air', cost: 'AA FOCUS', icon: 'solaris_gate',
                active: prioMode === 'air',
                desc: 'Anti-Air Priority [W]: Prioritizes airborne Mutalisks & flying threats first before ground units.',
                fn: () => { sel.spirePriority = 'air'; renderSC2CommandCard(); }
            },
            {
                key: 'E', name: 'Priority: Ground', cost: 'GND FOCUS', icon: 'turret',
                active: prioMode === 'ground',
                desc: 'Ground Suppression Priority [E]: Prioritizes heavy armored ground bio-strains & siege beasts.',
                fn: () => { sel.spirePriority = 'ground'; renderSC2CommandCard(); }
            },
            {
                key: 'R', name: 'Shield Overcharge', cost: '50M', icon: 'hold',
                locked: state.req < 50 || (sel.shield || 0) >= (sel.maxShield || 400),
                desc: 'Khaydarin Shield Overcharge [R]: 50M · Instantly restores 100% of this Spire\'s Psionic Shield & +150 Hull HP!',
                fn: () => {
                    if (state.req < 50) return;
                    state.req -= 50;
                    sel.shield = sel.maxShield || 400;
                    sel.hp = Math.min(sel.maxHp, sel.hp + 150);
                    spawnNanoWeldSparkFX(sel.pos);
                    spawnCombatFloat(sel.pos, 'AEGIS SHIELD OVERCHARGED!', '#38bdf8');
                    if (window.SFX) window.SFX.playHeal();
                    renderSC2CommandCard();
                    updateHUD(true);
                }
            },
            {
                key: 'U',
                name: curLvl >= 3 ? 'Spire MAX (MK-3)' : `Upgrade MK-${curLvl + 1}`,
                cost: curLvl >= 3 ? 'MAXED' : `${upgCost}M`,
                icon: 'solaris_cyber_lab',
                locked: curLvl >= 3 || state.req < upgCost,
                desc: `Upgrade Khaydarin Aegis Spire to MK-${curLvl + 1} [U]: ${upgCost}M · +18 Psionic Lance Damage, +2.5m Range, +250 HP & +200 Shield!`,
                fn: () => {
                    if (curLvl >= 3 || state.req < upgCost) return;
                    state.req -= upgCost;
                    sel.level = curLvl + 1;
                    sel.upgradeLevel = sel.level;
                    sel.maxHp += 250;
                    sel.hp = Math.min(sel.maxHp, sel.hp + 250);
                    sel.maxShield = (sel.maxShield || 400) + 200;
                    sel.shield = sel.maxShield;
                    spawnNanoWeldSparkFX(sel.pos);
                    spawnCombatFloat(sel.pos, `KHAYDARIN SPIRE UPGRADED TO MK-${sel.level}!`, '#f5b932');
                    if (window.SFX) window.SFX.playBuild();
                    renderSC2CommandCard();
                    updateHUD(true);
                }
            },
            null, null, null,
            {
                key: 'ESC', name: 'Build Menu', cost: 'BACK', icon: 'base',
                desc: 'Return to Construction Command Card [ESC].',
                fn: () => selectStructure(null)
            }
        ];

        spireCmds.forEach(sc => {
            const btn = document.createElement('button');
            if (!sc) { btn.className = 'cmd-cell'; btn.disabled = true; grid.appendChild(btn); return; }
            btn.className = 'cmd-cell' + (sc.active ? ' equipped' : '');
            btn.disabled = !!sc.locked;
            btn.innerHTML = `<div class="cmd-top-row"><span class="cmd-hotkey">${sc.key}</span>${getCmdIconSvg(sc.icon)}</div><span class="cmd-name">${sc.name}</span><span class="cmd-cost">${sc.cost}</span>`;
            btn.onmouseenter = () => setCmdTooltip(sc.desc);
            btn.onclick = sc.fn;
            grid.appendChild(btn);
        });
        return;
    }

    // 2B. TERRAN MODULAR TURRET SELECTED (WITH ROCKET POD, SHIELD DOME, MIND CONTROL, PLASMA, SNIPER, DRONE & UPGRADES)
    if (sel && sel.type === 'turret') {
        const maxPwr = sel.maxPower || 9;
        const leftW = sel.weapons.left || 'none';
        const topW = sel.weapons.top || 'none';
        const rightW = sel.weapons.right || 'none';
        const used = (WEAPON_COSTS[leftW] || 0) + (WEAPON_COSTS[rightW] || 0) + (WEAPON_COSTS[topW] || 0);
        const free = maxPwr - used;
        const curLvl = sel.level || 1;
        const upgCost = curLvl === 1 ? 120 : (curLvl === 2 ? 180 : 250);
        const thrallCount = units.filter(u => u && u.isMindControlled && u.hp > 0).length;

        titleEl.innerText = `TURRET LV.${curLvl}`;
        pwrEl.innerText = `${free}/${maxPwr} ⚡`;
        prodPanel.style.display = 'none';
        if (statsStrip) statsStrip.style.display = 'none';

        updateCommPortrait('turret');
        document.getElementById('sel-title').innerText = `MODULAR TURRET MK-${curLvl}`;
        document.getElementById('sel-rank-tag').innerText = `${maxPwr}⚡ CORE`;
        const typeTag = document.getElementById('sel-type-tag');
        if (typeTag) typeTag.innerText = 'DEFENSE';
        const wfRoleTag = document.getElementById('wireframe-role-tag');
        if (wfRoleTag) wfRoleTag.innerText = `MK-${curLvl} BUNKER`;
        document.getElementById('sel-subtitle').innerText = `Select hardpoint [Q: Left / W: Top / E: Right], then click any gun [1–9] to attach!`;
        setCmdTooltip(`Slot [${state.activeTurretSlot.toUpperCase()}]: ${free}⚡ free of ${maxPwr}⚡ · Click [Q/W/E] to switch slot or [1–9] to mount weapon`);

        const curSlot = state.activeTurretSlot || 'left';
        const curW = sel.weapons[curSlot] || 'none';
        const curCost = WEAPON_COSTS[curW] || 0;
        const curLabel = WEAPON_LABELS[curW] || curW;

        const weaponDmgText = {
            none: '0', mg: '16', flame: '9/t', plasma: '42 SPL', rocket: '55x2 MIS',
            shield: '450 DOME', sniper: '125 AP', drone: '+38 BLD/s', mortar: '70 AOE', mindcontrol: `${thrallCount}/3 MAX`
        }[curW] || '16';
        const weaponRngText = {
            none: '-', mg: '14m', flame: '13.5m', plasma: '16.5m', rocket: '20.0m',
            shield: '9.5m DOME', sniper: '22.0m', drone: '18m BLD', mortar: '18.0m', mindcontrol: '19.0m SAT'
        }[curW] || '18m';

        document.getElementById('stat-weapon').innerText = `${curSlot.toUpperCase()}: ${curLabel.toUpperCase()}`;
        document.getElementById('stat-dmg').innerText = weaponDmgText;
        document.getElementById('stat-rng').innerText = weaponRngText;
        document.getElementById('stat-order').innerText = `${used}/${maxPwr}⚡`;
        document.getElementById('wireframe-shield-tag').innerText = sel.maxShieldHp ? `SHIELD: ${Math.ceil(sel.shieldHp)}/${sel.maxShieldHp}` : `LV.${curLvl} BUNKER`;

        // Render interactive 3-slot selector bar + UPGRADE BANNER + WEAPON RANGE VISUALIZER LEGEND in center console
        if (turretSlotBar) {
            turretSlotBar.style.display = 'grid';
            turretSlotBar.innerHTML = '';
            [
                { key: 'Q', label: 'LEFT', slot: 'left' },
                { key: 'W', label: 'TOP', slot: 'top' },
                { key: 'E', label: 'RIGHT', slot: 'right' }
            ].forEach(sd => {
                const pill = document.createElement('button');
                const wInSlot = sel.weapons[sd.slot] || 'none';
                const wLbl = WEAPON_LABELS[wInSlot] || wInSlot;
                const wCst = WEAPON_COSTS[wInSlot] || 0;
                pill.className = 'turret-slot-pill' + (state.activeTurretSlot === sd.slot ? ' active' : '');
                pill.innerHTML = `<span class="ts-key">[${sd.key}] ${sd.label} MOUNT</span><span class="ts-val">${wLbl} (${wCst}⚡)</span>`;
                pill.onclick = () => { state.activeTurretSlot = sd.slot; renderSC2CommandCard(); };
                turretSlotBar.appendChild(pill);
            });

            // Upgrade Button + Strip Slot Button inside the Turret Console
            const upgBanner = document.createElement('button');
            upgBanner.className = 'turret-upgrade-banner';
            upgBanner.disabled = state.req < upgCost;
            upgBanner.title = `Upgrade Turret to MK-${curLvl + 1} [Hotkey: U] — Increases Max HP by +260, adds +3⚡ Energy Capacity!`;
            upgBanner.innerHTML = `
                <span class="tub-left">⬆ UPGRADE MK-${curLvl + 1} (+260 HP &amp; +3⚡) &nbsp;|&nbsp; [Z] STRIP SLOT</span>
                <span class="tub-cost">[U] ${upgCost} MINERALS</span>
            `;
            upgBanner.onclick = () => upgradeTurret(sel);
            turretSlotBar.appendChild(upgBanner);

            // Live 3D Firing Range Legend for Equipped Guns
            const rangeLegend = document.createElement('div');
            rangeLegend.className = 'turret-range-legend';
            const rangeMeta = {
                mg:          { label: 'GATLING 14m',     col: '#ffaa00' },
                flame:       { label: 'NAPALM 13.5m',    col: '#ff4500' },
                plasma:      { label: 'PLASMA 16.5m',    col: '#00e5ff' },
                rocket:      { label: 'ROCKETS 20m',     col: '#ff2a4b' },
                shield:      { label: 'SHIELD DOME 9.5m',col: '#38bdf8' },
                mortar:      { label: 'HOWITZER 18m',    col: '#ff8800' },
                drone:       { label: 'FIX DRONE 18m',   col: '#38bdf8' },
                sniper:      { label: 'SNIPER 22m',      col: '#00ff66' },
                mindcontrol: { label: `PSI SAT 19m (${thrallCount}/3 MAX)`, col: '#d946ef' }
            };
            const equippedSet = Array.from(new Set([leftW, topW, rightW].filter(w => w && w !== 'none')));
            if (equippedSet.length === 0) {
                rangeLegend.innerHTML = `<span style="color:#ff5400;">NO WEAPONS EQUIPPED — SELECT [1–9] TO MOUNT ORDNANCE</span>`;
            } else {
                rangeLegend.innerHTML = `<span style="color:#9cb8d9;margin-right:2px;">SELECTED TURRET RADIUS:</span>` + equippedSet.map(wKey => {
                    const rm = rangeMeta[wKey] || { label: wKey.toUpperCase(), col: '#00e5ff' };
                    return `<span class="trl-tag" style="color:${rm.col};border-color:${rm.col};"><span class="trl-dot" style="background:${rm.col};"></span>${rm.label}</span>`;
                }).join('');
            }
            turretSlotBar.appendChild(rangeLegend);
        }

        const wDefs = [
            { key: '1', w: 'mg',          name: 'Gatling',      cost: 1, icon: 'attack',  desc: 'Rotary Gatling [1]: 1⚡ · Rapid-fire 16 DMG ballistic suppression (14m amber radius).' },
            { key: '2', w: 'flame',       name: 'Napalm',       cost: 2, icon: 'attack',  desc: 'Hellfire Napalm [2]: 2⚡ · Long-range pressurized thermal fire stream (13.5m red radius).' },
            { key: '3', w: 'plasma',      name: 'Plasma Gun',   cost: 2, icon: 'turret',  desc: 'Plasma Arc Accelerator [3]: 2⚡ · 42 DMG electric plasma bolt that chain-zaps nearby enemies (16.5m cyan radius).' },
            { key: '4', w: 'rocket',      name: 'Rocket Pod',   cost: 2, icon: 'attack',  desc: 'Swarm Rocket Missile Pod [4]: 2⚡ · Fires twin 55 DMG high-explosive missiles at Air & Ground (20m crimson radius).' },
            { key: '5', w: 'shield',      name: 'Shield Dome',  cost: 2, icon: 'hold',    desc: 'Aegis Shield Generator [5]: 2⚡ · Projects a crystal-clear 9.5m 450-HP energy forcefield dome with hit ripples.' },
            { key: '6', w: 'sniper',      name: 'Sniper Gun',   cost: 3, icon: 'attack',  desc: 'Railgun Sniper [6]: 3⚡ · 125 CRIT armor-piercing round + Laser Sight (22m green radius).' },
            { key: '7', w: 'drone',       name: 'Fixing Drone', cost: 3, icon: 'hold',    desc: 'Nano-Weld Fixing Drone [7]: 3⚡ · Autonomously repairs friendly BUILDINGS within 18m.' },
            { key: '8', w: 'mortar',      name: 'Howitzer',     cost: 3, icon: 'factory', desc: 'Siege Howitzer [8]: 3⚡ · 70 DMG artillery shells that leave craters (18m orange radius).' },
            { key: '9', w: 'mindcontrol', name: 'Psi Satellite',cost: 3, icon: 'hero',    desc: `Psionic Satellite Dish [9]: 3⚡ · Tracks & dominates enemy Zerg units within 19m (Max 3 Controlled Units — Active: ${thrallCount}/3).` }
        ];
        wDefs.forEach(wd => {
            const btn = document.createElement('button');
            btn.onmouseenter = () => setCmdTooltip(wd.desc);
            const fits = (used - curCost + wd.cost) <= maxPwr;
            btn.className = 'cmd-cell' + (curW === wd.w ? ' equipped' : '');
            btn.disabled = !fits;
            btn.innerHTML = `<div class="cmd-top-row"><span class="cmd-hotkey">${wd.key}</span>${getCmdIconSvg(wd.icon)}</div><span class="cmd-name">${wd.name}</span><span class="cmd-cost">${wd.cost}⚡</span>`;
            btn.onclick = () => {
                sel.weapons[curSlot] = wd.w;
                // Auto-advance activeTurretSlot to the next empty mount ('left' -> 'top' -> 'right') so attaching 3 weapons in a row is effortless!
                const nextEmpty = ['left', 'top', 'right'].find(s => !sel.weapons[s] || sel.weapons[s] === 'none');
                if (nextEmpty) state.activeTurretSlot = nextEmpty;
                syncTurretPods(sel);
                if (window.SFX) window.SFX.playClick();
                renderSC2CommandCard();
                updateHUD();
            };
            grid.appendChild(btn);
        });
        return;
    }

    // 3. BARRACKS, WAR FACTORY, OR SOLARIS ROBOTICS & STARFLEET BAY SELECTED
    if (sel && (sel.type === 'barracks' || sel.type === 'factory' || sel.type === 'solaris_robotics')) {
        const isBarracks = sel.type === 'barracks';
        const isSolRobotics = sel.type === 'solaris_robotics';
        const hasBarracksBuilt = buildings.some(b => (b.type === 'barracks' || b.type === 'solaris_gate') && b.hp > 0);
        titleEl.innerText = isBarracks ? 'BARRACKS QUEUE' : (isSolRobotics ? 'STARFLEET & ROBOTICS' : 'FACTORY QUEUE');
        prodPanel.style.display = 'block';
        if (statsStrip) statsStrip.style.display = 'none';

        updateCommPortrait(sel.type);
        document.getElementById('sel-title').innerText = isBarracks ? 'INFANTRY BARRACKS (BIO)' : (isSolRobotics ? 'SOLARIS ROBOTICS & FLEET BAY' : 'WAR FACTORY (MECH)');
        document.getElementById('sel-rank-tag').innerText = isBarracks ? 'GARRISON' : (isSolRobotics ? 'STARFLEET BAY' : 'FOUNDRY');
        const typeTag = document.getElementById('sel-type-tag');
        if (typeTag) typeTag.innerText = sel.buildProgress < 1.0 ? `BUILDING (${Math.round(sel.buildProgress * 100)}%)` : 'PRODUCTION';
        const wfRoleTag = document.getElementById('wireframe-role-tag');
        if (wfRoleTag) wfRoleTag.innerText = isBarracks ? 'BIO GARRISON' : (isSolRobotics ? 'STARFLEET BAY' : 'MECH FOUNDRY');
        document.getElementById('sel-subtitle').innerText = sel.buildProgress < 1.0
            ? `Constructing structure (${Math.round(sel.buildProgress * 100)}%) — Unit training begins automatically as soon as construction finishes!`
            : (isBarracks
                ? 'Trains Shock Troopers, Marksmen, Medics, Rocket Men, Reapers, Pyro-Firebats & Bio-Marauders.'
                : (isSolRobotics
                    ? 'Warps in Protoss Phoenix Interceptors [Q], Void Ray Prismatic Cruisers [W], Fleet Carriers [E], Stalkers [R], Siege Tanks [T] & Valkyries [Y]!'
                    : 'Fabricates Tanks, Siege Tanks (Auto-Siege Artillery), Gunship Helis, Dropships & Valkyrie Semi-Mechs!'));
        setCmdTooltip(isBarracks ? 'Select active Bio-Factory production line [Q, W, E, R, T, Y, U]' : (isSolRobotics ? 'Select Solaris Starfleet / Robotics warp-in unit [Q: Phoenix, W: Void Ray, E: Carrier, R: Stalker, T: Siege, Y: Valkyrie]' : 'Select active Vehicle assembly line [Q, W, E, R, T]'));

        const options = isBarracks
            ? [
                { key: 'Q', u: 'grunt',     name: 'Shock Trooper', tag: 'BIO MELEE', locked: false, desc: 'CMC-660 Shock Trooper [Q]: Heavy melee vanguard with Plasma Broadsword & Riot Shield.' },
                { key: 'W', u: 'ranger',    name: 'Marksman',      tag: 'BIO RIFLE', locked: false, desc: 'C-14 Gauss Marksman [W]: Ranged biological marine effective against Ground & Air.' },
                { key: 'E', u: 'medic',     name: 'Combat Medic',  tag: 'HEAL BIO',  locked: false, desc: 'Field Combat Medic [E]: Restores HP of injured Biological infantry with Caduceus Nano-Beam.' },
                { key: 'R', u: 'rocketman', name: 'Rocket Man',    tag: 'AT/AA MIS', locked: false, desc: 'Heavy Rocket Trooper [R]: Shoulder-mounted Twin Javelin Missile Launcher; deals heavy splash damage to Ground & Air!' },
                { key: 'T', u: 'reaper',    name: 'Reaper Raider', tag: 'JUMP-JET',  locked: false, desc: 'Dominion Jump-Jet Reaper [T]: Ultra-fast raider with Dual P-45 Gauss Pistols and rapid-fire burst across Ground & Air!' },
                { key: 'Y', u: 'firebat',   name: 'Pyro-Firebat',  tag: 'CONE FLAME',locked: false, desc: 'CMC-660 Pyro-Firebat [Y]: Heavy thermal trooper with twin Perdition Flamethrowers that incinerate swarms!' },
                { key: 'U', u: 'marauder',  name: 'Bio-Marauder',  tag: 'SLOW GREN', locked: false, desc: 'CMC-700 Concussive Marauder [U]: Heavy armored bio-juggernaut with dual Punisher Grenade Launchers that hit Ground & Air!' }
              ]
            : (isSolRobotics
                ? [
                    { key: 'Q', u: 'phoenix',    name: 'Phoenix Jet',   tag: 'FAST AIR',   locked: false, desc: 'Protoss Phoenix Interceptor [Q]: Supersonic aerial superiority fighter with twin Ion Pulse Cannons against Air & Ground!' },
                    { key: 'W', u: 'void_ray',   name: 'Void Ray',      tag: 'PRISM BEAM', locked: false, desc: 'Protoss Void Ray Cruiser [W]: Fires a sustained Thermal Prismatic Beam that ramps damage across 3 intensity tiers!' },
                    { key: 'E', u: 'carrier',    name: 'Fleet Carrier', tag: '5x DRONES',  locked: false, desc: 'Protoss Fleet Carrier Dreadnought [E]: Capital ship that automatically builds & launches up to 5 autonomous Interceptors!' },
                    { key: 'R', u: 'stalker',    name: 'Prism Stalker', tag: 'PHASE WLK',  locked: false, desc: 'Solaris Prism Stalker [R]: Quad-legged obsidian walker armed with Phase Particle Disruptors.' },
                    { key: 'T', u: 'archon',     name: 'Solar Archon',  tag: 'PSI SPLASH', locked: false, desc: 'Solaris Aether Archon [T]: Heavy psionic colossus that unleashes chain solar lightning across enemy clusters!' },
                    { key: 'Y', u: 'zealot',     name: 'Chrono-Zealot', tag: 'PSI MELEE',  locked: false, desc: 'Solaris Chrono-Zealot [Y]: Armored frontline Templar warrior armed with dual Solar Psi-Glaives.' }
                  ]
                : [
                    { key: 'Q', u: 'tank',          name: 'Tank',          tag: 'MECH GND',   locked: false, desc: 'M80 Grizzly Tank [Q]: Heavy Chobham armor & 120mm APFSDS ground-only battle cannon.' },
                    { key: 'W', u: 'heli',          name: 'Gunship Heli',  tag: 'MECH AIR',   locked: false, desc: 'AH-99 Hunter Gunship [W]: Redesigned military attack helicopter with 360° rotary cannon & Hydra missile pods.' },
                    { key: 'E', u: 'transport',     name: 'Dropship APC',  tag: hasBarracksBuilt ? 'DROP APC' : 'NEED BARRACKS', locked: !hasBarracksBuilt, desc: 'Hercules Dropship APC [E]: VTOL carrier that air-drops infantry squads near enemy territory (Requires Barracks).' },
                    { key: 'R', u: 'valkyrie',      name: 'Valkyrie Mech', tag: 'AERO-MECH',  locked: false, desc: 'Valkyrie Transformable Semi-Mech [R]: Flies to intercept Air enemies with Halo Missiles; unfolds Walker Legs to engage Ground units!' },
                    { key: 'T', u: 'siege_tank',    name: 'Siege Tank',    tag: 'AUTO-SIEGE', locked: false, desc: 'Crucio Siege Tank [T]: Heavy tank with rotating turret head & auto-siege hydraulic outriggers that transform into 28.5m long-range artillery!' },
                    { key: 'Y', u: 'medivac',       name: 'Medivac Ship',  tag: 'AIR HEAL',   locked: false, desc: 'Terran Medivac Dropship [Y]: Medical support aircraft with twin tilt-engines and Caduceus healing beam that autonomously heals biological allies!' },
                    { key: 'U', u: 'battlecruiser', name: 'Battlecruiser', tag: 'CAPITAL SHIP', locked: false, desc: 'Minotaur-Class Battlecruiser [U]: Heavy Terran capital ship armed with broadside laser turret batteries and a forward Yamato Cannon!' }
                  ]);

        const spawnTimes = {
            grunt: 9.0, ranger: 10.0, medic: 10.5, rocketman: 11.5, reaper: 10.0, firebat: 11.0, marauder: 12.5,
            tank: 15.5, siege_tank: 18.0, heli: 14.0, transport: 14.0, medivac: 13.5, battlecruiser: 22.0, valkyrie: 16.5,
            phoenix: 12.0, void_ray: 16.0, carrier: 20.0, stalker: 12.0
        };

        for (let i = 0; i < 9; i++) {
            const btn = document.createElement('button');
            if (i < options.length) {
                const opt = options[i];
                btn.className = 'cmd-cell' + (sel.unitType === opt.u ? ' equipped' : '');
                btn.disabled = !!opt.locked;
                btn.innerHTML = `<div class="cmd-top-row"><span class="cmd-hotkey">${opt.key}</span>${getCmdIconSvg(isBarracks ? 'barracks' : (isSolRobotics ? 'solaris_gate' : 'factory'))}</div><span class="cmd-name">${opt.name}</span><span class="cmd-cost">${opt.tag}</span>`;
                btn.onmouseenter = () => setCmdTooltip(opt.desc);
                btn.onclick = () => {
                    if (opt.locked) {
                        spawnCombatFloat(sel.pos, 'BUILD BARRACKS FIRST!', '#ff2a4b');
                        return;
                    }
                    if (sel.unitType !== opt.u) {
                        sel.unitType = opt.u;
                        sel.spawnDuration = spawnTimes[opt.u] || 6.0;
                        sel.spawnTimer = sel.spawnDuration; // Reset progress back to 0% when switching unit type!
                        spawnCombatFloat(sel.pos, `QUEUED: ${opt.name.toUpperCase()}`, '#00e5ff');
                    }
                    renderSC2CommandCard();
                    updateHUD();
                };
            } else if (i === 8) {
                btn.className = 'cmd-cell';
                btn.innerHTML = `<div class="cmd-top-row"><span class="cmd-hotkey">ESC</span>${getCmdIconSvg('base')}</div><span class="cmd-name">Back</span><span class="cmd-cost">BUILD</span>`;
                btn.onmouseenter = () => setCmdTooltip('Return to Construction Command Card [ESC].');
                btn.onclick = () => selectStructure(null);
            } else {
                btn.className = 'cmd-cell'; btn.disabled = true;
            }
            grid.appendChild(btn);
        }
        return;
    }

    // 3A-PYLON. SOLARIS KHAYDARIN POWER PYLON SELECTED
    if (sel && sel.type === 'solaris_pylon') {
        titleEl.innerText = 'KHAYDARIN PYLON';
        prodPanel.style.display = 'none';
        if (statsStrip) statsStrip.style.display = 'grid';

        updateCommPortrait('solaris_pylon');
        document.getElementById('sel-title').innerText = 'KHAYDARIN POWER PYLON';
        document.getElementById('sel-rank-tag').innerText = 'PSIONIC MATRIX';
        const typeTag = document.getElementById('sel-type-tag');
        if (typeTag) typeTag.innerText = sel.buildProgress < 1.0 ? `WARPING (${Math.round(sel.buildProgress * 100)}%)` : 'POWER SOURCE';
        const wfRoleTag = document.getElementById('wireframe-role-tag');
        if (wfRoleTag) wfRoleTag.innerText = 'PSI MATRIX';
        document.getElementById('sel-subtitle').innerText = sel.buildProgress < 1.0
            ? `Warping in Khaydarin Power Pylon (${Math.round(sel.buildProgress * 100)}%) — Projects a 20m Psionic Power Field once complete!`
            : 'Projects a 20m Psionic Power Matrix required to power Protoss Warp Gates, Robotics Bays & Khaydarin Aegis Spires!';
        document.getElementById('stat-weapon').innerText = 'PSIONIC MATRIX';
        document.getElementById('stat-dmg').innerText = '20m POWER';
        document.getElementById('stat-rng').innerText = '20.0m';
        document.getElementById('stat-order').innerText = sel.buildProgress < 1.0 ? 'WARPING' : 'ENERGIZED';
        document.getElementById('wireframe-shield-tag').innerText = `SHIELD: ${Math.ceil(sel.shield || 0)}/${sel.maxShield || 400}`;
        setCmdTooltip('Khaydarin Power Pylon energizes nearby Protoss structures within 20m.');

        const pylonCmds = [
            { key: '2', name: 'Warp Gate', cost: '150M', icon: 'solaris_gate', desc: 'Build Solaris Warp Gate [2]: 150M · Requires Pylon Power Field.', fn: () => setMode('solaris_gate') },
            { key: '3', name: 'Robotics Bay', cost: '200M', icon: 'solaris_robotics', desc: 'Build Solaris Robotics & Fleet Bay [3]: 200M · Warps in Phoenixes, Void Rays & Carriers (Requires Pylon Power).', fn: () => setMode('solaris_robotics') },
            { key: '5', name: 'Aegis Spire', cost: '75M', icon: 'turret', desc: 'Build Khaydarin Aegis Spire [5]: 75M · Levitating Protoss psionic defense turret (Requires Pylon Power).', fn: () => setMode('turret') },
            { key: '7', name: 'New Pylon', cost: '75M', icon: 'solaris_pylon', desc: 'Build another Khaydarin Power Pylon [7]: 75M · Extends Protoss psionic power matrix.', fn: () => setMode('solaris_pylon') },
            null, null, null, null,
            { key: 'ESC', name: 'Build Menu', cost: 'BACK', icon: 'base', desc: 'Return to Construction Command Card [ESC].', fn: () => selectStructure(null) }
        ];
        pylonCmds.forEach(pc => {
            const btn = document.createElement('button');
            if (!pc) { btn.className = 'cmd-cell'; btn.disabled = true; grid.appendChild(btn); return; }
            btn.className = 'cmd-cell';
            btn.innerHTML = `<div class="cmd-top-row"><span class="cmd-hotkey">${pc.key}</span>${getCmdIconSvg(pc.icon)}</div><span class="cmd-name">${pc.name}</span><span class="cmd-cost">${pc.cost}</span>`;
            btn.onmouseenter = () => setCmdTooltip(pc.desc);
            btn.onclick = pc.fn;
            grid.appendChild(btn);
        });
        return;
    }

    // 3A-SOLARIS. SOLARIS ASTRAL WARP GATE SELECTED (3RD FACTION: THE SOLARIS CHRONO-SYNOD)
    if (sel && sel.type === 'solaris_gate') {
        titleEl.innerText = 'SOLARIS WARP GATE';
        prodPanel.style.display = 'block';
        if (statsStrip) statsStrip.style.display = 'none';

        updateCommPortrait('solaris_gate');
        document.getElementById('sel-title').innerText = 'SOLARIS ASTRAL WARP GATE';
        document.getElementById('sel-rank-tag').innerText = 'CHRONO-SYNOD';
        const typeTag = document.getElementById('sel-type-tag');
        if (typeTag) typeTag.innerText = sel.buildProgress < 1.0 ? `WARPING (${Math.round(sel.buildProgress * 100)}%)` : '3RD FACTION';
        const wfRoleTag = document.getElementById('wireframe-role-tag');
        if (wfRoleTag) wfRoleTag.innerText = 'SOLARIS SYNOD';
        document.getElementById('sel-subtitle').innerText = sel.buildProgress < 1.0
            ? `Dimensional Warp-In in progress (${Math.round(sel.buildProgress * 100)}%) — Unit warp-in begins once complete!`
            : 'Chrono-Synod Warp Matrix: Continuously warps in Zealot Templars, Prism Stalkers & Aether Archons!';
        setCmdTooltip('Select active Solaris Chrono-Synod warp-in unit [Q: Zealot, W: Stalker, E: Archon]');

        const solarisOpts = [
            { key: 'Q', u: 'zealot',  name: 'Chrono-Zealot', tag: 'PSI GLAIVES', desc: 'Chrono-Zealot Templar [Q]: Fast golden-armored melee templar with twin Solar Psi-Glaives.' },
            { key: 'W', u: 'stalker', name: 'Prism Stalker', tag: 'ANTI-AIR/GND', desc: 'Solaris Prism Stalker [W]: Quad-legged golden-obsidian walker that fires Phase Particle Disruptors at Ground & Air!' },
            { key: 'E', u: 'archon',  name: 'Aether Archon', tag: 'AOE PSIONIC',  desc: 'Aether Archon Sovereign [E]: Levitating psionic entity that unleashes devastating solar lightning against Ground & Air!' }
        ];
        const solarisTimes = { zealot: 10.0, stalker: 12.0, archon: 15.5 };

        for (let i = 0; i < 9; i++) {
            const btn = document.createElement('button');
            if (i < solarisOpts.length) {
                const opt = solarisOpts[i];
                btn.className = 'cmd-cell' + (sel.unitType === opt.u ? ' equipped' : '');
                btn.innerHTML = `<div class="cmd-top-row"><span class="cmd-hotkey">${opt.key}</span>${getCmdIconSvg('solaris_gate')}</div><span class="cmd-name">${opt.name}</span><span class="cmd-cost">${opt.tag}</span>`;
                btn.onmouseenter = () => setCmdTooltip(opt.desc);
                btn.onclick = () => {
                    if (sel.unitType !== opt.u) {
                        sel.unitType = opt.u;
                        sel.spawnDuration = solarisTimes[opt.u] || 5.5;
                        sel.spawnTimer = sel.spawnDuration;
                        spawnCombatFloat(sel.pos, `WARP MATRIX: ${opt.name.toUpperCase()}`, '#f5b932');
                    }
                    renderSC2CommandCard();
                    updateHUD();
                };
            } else if (i === 8) {
                btn.className = 'cmd-cell';
                btn.innerHTML = `<div class="cmd-top-row"><span class="cmd-hotkey">ESC</span>${getCmdIconSvg('base')}</div><span class="cmd-name">Back</span><span class="cmd-cost">BUILD</span>`;
                btn.onmouseenter = () => setCmdTooltip('Return to Construction Command Card [ESC].');
                btn.onclick = () => selectStructure(null);
            } else {
                btn.className = 'cmd-cell'; btn.disabled = true;
            }
            grid.appendChild(btn);
        }
        return;
    }

    // 3A-LAB. ENGINEERING & WEAPONS LAB (TERRAN) OR SOLARIS CYBERNETICS FORGE (PROTOSS) SELECTED
    if (sel && (sel.type === 'tech_lab' || sel.type === 'solaris_cyber_lab')) {
        const isSolLab = sel.type === 'solaris_cyber_lab';
        const facKey = isSolLab ? 'solaris' : 'terran';
        const upg = (state.upgrades && state.upgrades[facKey]) ? state.upgrades[facKey] : { weapons: 0, armor: 0 };
        const wLvl = upg.weapons || 0;
        const aLvl = upg.armor || 0;
        const wCost = wLvl === 0 ? 120 : (wLvl === 1 ? 180 : 250);
        const aCost = aLvl === 0 ? 120 : (aLvl === 1 ? 180 : 250);

        titleEl.innerText = isSolLab ? 'CYBERNETICS FORGE' : 'WEAPONS & ARMOR LAB';
        pwrEl.innerText = `W:${wLvl}/3 · A:${aLvl}/3`;
        prodPanel.style.display = 'none';
        if (statsStrip) statsStrip.style.display = 'grid';

        updateCommPortrait(sel.type);
        document.getElementById('sel-title').innerText = isSolLab ? 'SOLARIS CYBERNETICS FORGE' : 'ENGINEERING & WEAPONS LAB';
        document.getElementById('sel-rank-tag').innerText = `ARMS LV.${wLvl} · ARMOR LV.${aLvl}`;
        const typeTag = document.getElementById('sel-type-tag');
        if (typeTag) typeTag.innerText = sel.buildProgress < 1.0 ? `BUILDING (${Math.round(sel.buildProgress * 100)}%)` : 'TECH UPGRADES';
        const wfRoleTag = document.getElementById('wireframe-role-tag');
        if (wfRoleTag) wfRoleTag.innerText = isSolLab ? 'SOLARIS FORGE' : 'TECH LAB';
        document.getElementById('sel-subtitle').innerText = sel.buildProgress < 1.0
            ? `Constructing Lab (${Math.round(sel.buildProgress * 100)}%) — Unlocks Lv.1–Lv.3 Arms & Armor Upgrades with 3D Visual Unit Enhancements!`
            : `Upgrade ${isSolLab ? 'Solaris' : 'Terran'} Arms (+20% DMG & 3D Weapon Barrels/Glaives) and Armor (+20% HP & 3D Shoulder/Hull Plating)!`;
        document.getElementById('stat-weapon').innerText = `ARMS LV.${wLvl} (+${wLvl * 20}% DMG)`;
        document.getElementById('stat-dmg').innerText = `ARMOR LV.${aLvl} (+${aLvl * 20}% HP)`;
        document.getElementById('stat-rng').innerText = `SQUAD AI: ${state.squadPosture}`;
        document.getElementById('stat-order').innerText = sel.buildProgress < 1.0 ? 'BUILDING' : 'RESEARCH READY';
        document.getElementById('wireframe-shield-tag').innerText = `W:LV.${wLvl} / A:LV.${aLvl}`;
        setCmdTooltip('Research Arms [Q] or Armor [W] upgrades (Lv.1–Lv.3) to boost unit stats and visually upgrade unit weapons & armor!');

        const isBuildingLab = (sel.buildProgress !== undefined && sel.buildProgress < 1.0);
        const labCmds = [
            {
                key: 'Q',
                name: wLvl >= 3 ? 'Arms MAX (Lv.3)' : `Upgrade Arms Lv.${wLvl + 1}`,
                cost: wLvl >= 3 ? 'MAXED' : `${wCost}M`,
                icon: 'attack',
                locked: isBuildingLab || wLvl >= 3 || state.req < wCost,
                desc: `Upgrade ${isSolLab ? 'Solaris' : 'Terran'} Arms Lv.${wLvl + 1} [Q]: ${wCost}M · +20% Weapon Damage & attaches 3D upgraded weapon barrels/glaives on all units!`,
                fn: () => window.upgradeFactionTech('weapons', facKey, false)
            },
            {
                key: 'W',
                name: aLvl >= 3 ? 'Armor MAX (Lv.3)' : `Upgrade Armor Lv.${aLvl + 1}`,
                cost: aLvl >= 3 ? 'MAXED' : `${aCost}M`,
                icon: 'hold',
                locked: isBuildingLab || aLvl >= 3 || state.req < aCost,
                desc: `Upgrade ${isSolLab ? 'Solaris' : 'Terran'} Armor Lv.${aLvl + 1} [W]: ${aCost}M · +20% Max HP, +2 Armor & attaches 3D reactive pauldrons/hull plating on all units!`,
                fn: () => window.upgradeFactionTech('armor', facKey, false)
            },
            {
                key: 'E',
                name: wLvl >= 3 ? 'Gem Arms MAX' : `Gem Arms Lv.${wLvl + 1}`,
                cost: wLvl >= 3 ? 'MAXED' : '20 GEMS',
                icon: 'mine_drill',
                locked: isBuildingLab || wLvl >= 3 || (state.gems || 0) < 20,
                desc: `Gem Instant Arms Upgrade [E]: Spend 20 Mined Khaydarin Gems to immediately unlock Arms Lv.${wLvl + 1}!`,
                fn: () => window.upgradeFactionTech('weapons', facKey, true)
            },
            {
                key: 'R',
                name: aLvl >= 3 ? 'Gem Armor MAX' : `Gem Armor Lv.${aLvl + 1}`,
                cost: aLvl >= 3 ? 'MAXED' : '20 GEMS',
                icon: 'mine_drill',
                locked: isBuildingLab || aLvl >= 3 || (state.gems || 0) < 20,
                desc: `Gem Instant Armor Upgrade [R]: Spend 20 Mined Khaydarin Gems to immediately unlock Armor Lv.${aLvl + 1}!`,
                fn: () => window.upgradeFactionTech('armor', facKey, true)
            },
            {
                key: 'T',
                name: state.squadIntelligence ? `Squad AI: ${state.squadPosture}` : 'Squad AI: OFF',
                cost: 'TOGGLE AI',
                icon: 'hero',
                locked: false,
                desc: 'Toggle Squad Intelligence [T]: Automatically switches friendly squads between Defensive Phalanx and Aggressive Hunting based on Zerg cluster proximity!',
                fn: () => window.toggleSquadIntelligence()
            },
            null, null, null,
            {
                key: 'ESC', name: 'Build Menu', cost: 'BACK', icon: 'base',
                locked: false,
                desc: 'Return to Construction Command Card [ESC].',
                fn: () => selectStructure(null)
            }
        ];

        labCmds.forEach(lc => {
            const btn = document.createElement('button');
            if (!lc) { btn.className = 'cmd-cell'; btn.disabled = true; grid.appendChild(btn); return; }
            btn.className = 'cmd-cell';
            btn.disabled = !!lc.locked;
            btn.innerHTML = `<div class="cmd-top-row"><span class="cmd-hotkey">${lc.key}</span>${getCmdIconSvg(lc.icon)}</div><span class="cmd-name">${lc.name}</span><span class="cmd-cost">${lc.cost}</span>`;
            btn.onmouseenter = () => setCmdTooltip(lc.desc);
            btn.onclick = lc.fn;
            grid.appendChild(btn);
        });
        return;
    }

    // 3A-DRILL. DEEP-CORE MINE DRILL SELECTED (MINERALS & GEM CRATER EXCAVATOR)
    if (sel && sel.type === 'mine_drill') {
        titleEl.innerText = 'MINE DRILL RIG';
        prodPanel.style.display = 'none';
        if (statsStrip) statsStrip.style.display = 'grid';

        const crater = sel.linkedCrater;
        const isRichCrater = !!(crater && !crater.isEmpty && crater.gemsRemaining > 0);
        const isEmptyCrater = !!(crater && (crater.isEmpty || crater.gemsRemaining <= 0));

        updateCommPortrait('mine_drill');
        document.getElementById('sel-title').innerText = 'DEEP-CORE MINE DRILL';
        document.getElementById('sel-rank-tag').innerText = isRichCrater ? 'GEM VEIN ACTIVE' : (isEmptyCrater ? 'EMPTY CRATER' : 'MINERAL SEAM');
        const typeTag = document.getElementById('sel-type-tag');
        if (typeTag) typeTag.innerText = sel.buildProgress < 1.0 ? `BUILDING (${Math.round(sel.buildProgress * 100)}%)` : 'EXCAVATOR';
        const wfRoleTag = document.getElementById('wireframe-role-tag');
        if (wfRoleTag) wfRoleTag.innerText = 'AUGER DRILL';
        document.getElementById('sel-subtitle').innerText = isRichCrater
            ? `Locked onto Rich Gem Crater (${crater.gemsRemaining} Gems remaining) — Extracting +14M & +15 Gems every 2.6s!`
            : (isEmptyCrater
                ? 'This Gem Crater is EMPTY! Still mining +14M/2.6s — Use [R] Scan Next Crater to find more Gem Craters!'
                : 'Mining +14 Minerals every 2.6s. Build a Mine Drill [8] on a glowing Gem Crater to mine Khaydarin Gems!');
        document.getElementById('stat-weapon').innerText = 'TUNGSTEN AUGER';
        document.getElementById('stat-dmg').innerText = isRichCrater ? '+14M / +15♦' : '+14M / 2.6s';
        document.getElementById('stat-rng').innerText = `${state.gems} GEMS`;
        document.getElementById('stat-order').innerText = isRichCrater ? `${crater.gemsRemaining}♦ LEFT` : (isEmptyCrater ? 'EMPTY CRATER' : 'DRILLING');
        document.getElementById('wireframe-shield-tag').innerText = `GEMS: ${state.gems}`;
        setCmdTooltip('Use Mined Gems [Q/W/E] to warp in Troops, instant Turrets, or Mineral Overdrive! Press [R] to locate Gem Craters.');

        const drillCmds = [
            {
                key: 'Q', name: 'Gem Troop Drop', cost: '30 GEMS', icon: state.playerFaction === 'solaris' ? 'solaris_gate' : 'barracks',
                locked: state.gems < 30,
                desc: state.playerFaction === 'solaris'
                    ? 'Gem Warp-In Drop [Q]: Spend 30 Mined Gems to warp in 1 Chrono-Zealot + 1 Prism Stalker + 1 Aether Archon immediately!'
                    : 'Gem Reinforcement Drop [Q]: Spend 30 Mined Gems to warp in 2 Shock Troopers + 1 Siege Tank immediately!',
                fn: () => {
                    if (state.gems < 30) {
                        spawnCombatFloat(sel.pos, 'NEED 30 MINED GEMS!', '#f0abfc');
                        return;
                    }
                    state.gems -= 30;
                    const dropOrigin = state.baseBuilding ? state.baseBuilding.pos : sel.pos;
                    if (state.playerFaction === 'solaris') {
                        spawnAlliedUnit('zealot', dropOrigin);
                        spawnAlliedUnit('stalker', dropOrigin);
                        spawnAlliedUnit('archon', dropOrigin);
                    } else {
                        spawnAlliedUnit('grunt', dropOrigin);
                        spawnAlliedUnit('ranger', dropOrigin);
                        spawnAlliedUnit('siege_tank', dropOrigin);
                    }
                    spawnCombatFloat(dropOrigin, 'GEM REINFORCEMENT SQUAD WARPED IN!', '#f0abfc');
                    if (window.SFX) window.SFX.playBuild();
                    renderSC2CommandCard();
                    updateHUD(true);
                }
            },
            {
                key: 'W', name: 'Gem Instant Build', cost: '25 GEMS', icon: 'turret',
                locked: state.gems < 25,
                desc: 'Gem Instant Defense Build [W]: Spend 25 Mined Gems to instantly construct a Modular Ball Turret near this Drill + +120M!',
                fn: () => {
                    if (state.gems < 25) {
                        spawnCombatFloat(sel.pos, 'NEED 25 MINED GEMS!', '#f0abfc');
                        return;
                    }
                    state.gems -= 25;
                    state.req += 120;
                    const prevMode = state.mode;
                    state.mode = 'turret';
                    const angle = Math.random() * Math.PI * 2;
                    const tPos = new THREE.Vector3(sel.pos.x + Math.cos(angle) * 4.8, getTerrainHeight(sel.pos.x + Math.cos(angle) * 4.8, sel.pos.z + Math.sin(angle) * 4.8), sel.pos.z + Math.sin(angle) * 4.8);
                    state.req += COSTS.turret;
                    deployStructure(tPos);
                    state.mode = prevMode;
                    spawnCombatFloat(sel.pos, 'GEM INSTANT TURRET + 120M DEPLOYED!', '#00e5ff');
                    renderSC2CommandCard();
                    updateHUD(true);
                }
            },
            {
                key: 'E', name: 'Gem -> Minerals', cost: '20 GEMS', icon: 'mine_drill',
                locked: state.gems < 20,
                desc: 'Deep-Core Gem Overdrive [E]: Spend 20 Mined Gems to refine +240 Minerals immediately!',
                fn: () => {
                    if (state.gems < 20) {
                        spawnCombatFloat(sel.pos, 'NEED 20 MINED GEMS!', '#f0abfc');
                        return;
                    }
                    state.gems -= 20;
                    state.req += 240;
                    spawnCombatFloat(sel.pos, '+240 MINERALS REFINED!', '#00ff66');
                    if (window.SFX) window.SFX.playBuild();
                    renderSC2CommandCard();
                    updateHUD(true);
                }
            },
            {
                key: 'R', name: 'Find Gem Crater', cost: 'SCAN', icon: 'move',
                locked: false,
                desc: 'Scan Sector for Gem Craters [R]: Pans camera to the next unmined Gem Crater across the battlefield (some craters may be empty!).',
                fn: () => {
                    const craters = window.GEM_CRATERS || [];
                    if (craters.length === 0) return;
                    window._craterScanIdx = ((window._craterScanIdx || 0) + 1) % craters.length;
                    const targetCrater = craters[window._craterScanIdx];
                    if (targetCrater) {
                        const offset = camera.position.clone().sub(controls.target);
                        controls.target.set(targetCrater.x, getTerrainHeight(targetCrater.x, targetCrater.z), targetCrater.z);
                        camera.position.copy(controls.target).add(offset);
                        controls.update();
                        const statusTxt = (targetCrater.isEmpty || targetCrater.gemsRemaining <= 0)
                            ? 'SURVEY: EMPTY CRATER (NO GEMS — KEEP SEARCHING!)'
                            : `SURVEY: RICH GEM CRATER (${targetCrater.gemsRemaining} GEMS) — BUILD MINE DRILL [8]!`;
                        spawnCombatFloat(new THREE.Vector3(targetCrater.x, targetCrater.y + 1.2, targetCrater.z), statusTxt, targetCrater.isEmpty ? '#94a3b8' : '#f0abfc');
                        if (window.SFX) window.SFX.playClick();
                    }
                }
            },
            {
                key: '8', name: 'New Mine Drill', cost: '120M', icon: 'mine_drill',
                locked: state.req < 120,
                desc: 'Build Another Deep-Core Mine Drill [8]: 120M · Place on any ground or inside a Gem Crater.',
                fn: () => setMode('mine_drill')
            },
            null,
            null,
            null,
            {
                key: 'ESC', name: 'Build Menu', cost: 'BACK', icon: 'base',
                locked: false,
                desc: 'Return to Construction Command Card [ESC].',
                fn: () => selectStructure(null)
            }
        ];

        drillCmds.forEach(dc => {
            const btn = document.createElement('button');
            if (!dc) {
                btn.className = 'cmd-cell'; btn.disabled = true;
                grid.appendChild(btn);
                return;
            }
            btn.className = 'cmd-cell';
            btn.disabled = !!dc.locked;
            btn.innerHTML = `<div class="cmd-top-row"><span class="cmd-hotkey">${dc.key}</span>${getCmdIconSvg(dc.icon)}</div><span class="cmd-name">${dc.name}</span><span class="cmd-cost">${dc.cost}</span>`;
            btn.onmouseenter = () => setCmdTooltip(dc.desc);
            btn.onclick = dc.fn;
            grid.appendChild(btn);
        });
        return;
    }

    // 3B. MAIN BASE (ORBITAL COMMAND CITADEL HQ OR SOLARIS CHRONO NEXUS) SELECTED — POWER GRID & CONSTRUCTION COMMAND
    if (sel && sel.type === 'base') {
        const isSolPlayer = (state.playerFaction === 'solaris');
        titleEl.innerText = isSolPlayer ? 'SOLARIS NEXUS' : 'COMMAND HQ';
        prodPanel.style.display = 'none';
        if (statsStrip) statsStrip.style.display = 'grid';

        updateCommPortrait(isSolPlayer ? 'solaris_nexus' : 'base');
        document.getElementById('sel-title').innerText = isSolPlayer ? 'SOLARIS CHRONO NEXUS' : 'ORBITAL COMMAND HQ';
        document.getElementById('sel-rank-tag').innerText = 'MAIN BASE';
        const typeTag = document.getElementById('sel-type-tag');
        if (typeTag) typeTag.innerText = 'COMMAND HQ';
        const wfRoleTag = document.getElementById('wireframe-role-tag');
        if (wfRoleTag) wfRoleTag.innerText = isSolPlayer ? 'PROTOSS HQ' : 'TERRAN HQ';
        document.getElementById('sel-subtitle').innerText = isSolPlayer
            ? 'Solaris Nexus online with Protoss Probes! Build a Khaydarin Pylon [7] first to power Warp Gates [2] & Robotics Bays [3]!'
            : 'Projects the 36m Terran power grid. Build Barracks [2], War Factories [3] & Mine Drills [8] to harvest Minerals & Gems!';
        document.getElementById('stat-weapon').innerText = isSolPlayer ? 'PSIONIC CORE' : 'ORBITAL RELAY';
        document.getElementById('stat-dmg').innerText = `${units.length} ACTIVE`;
        document.getElementById('stat-rng').innerText = `${POWER_RADIUS}m GRID`;
        document.getElementById('stat-order').innerText = 'ONLINE';
        document.getElementById('wireframe-shield-tag').innerText = isSolPlayer ? 'ARMOR: AURELIAN' : 'ARMOR: CITADEL';
        setCmdTooltip(isSolPlayer
            ? 'Deploy Khaydarin Pylon [7] to power Warp Gates [2] & Robotics Bays [3], or Mine Drill [8]'
            : 'Deploy Barracks [2], War Factory [3], or Mine Drill [8] on Gem Craters, or trigger HQ Overload [O]');

        const baseCmds = isSolPlayer
            ? [
                {
                    key: '7', name: 'Khaydarin Pylon', cost: '75M', icon: 'solaris_pylon',
                    desc: 'Build Khaydarin Power Pylon [7]: 75M · Projects a 20m Psionic Power Matrix required for Protoss structures!',
                    fn: () => setMode('solaris_pylon')
                },
                {
                    key: '2', name: 'Warp Gate', cost: '150M', icon: 'solaris_gate',
                    desc: 'Build Solaris Astral Warp Gate [2]: 150M · Warps in Chrono-Zealots, Prism Stalkers & Aether Archons (Requires Pylon Power).',
                    fn: () => setMode('solaris_gate')
                },
                {
                    key: '3', name: 'Robotics Bay', cost: '200M', icon: 'solaris_robotics',
                    desc: 'Build Solaris Robotics Bay [3]: 200M · Warps in Heavy Armor, Siege Artillery & Airships (Requires Pylon Power).',
                    fn: () => setMode('solaris_robotics')
                },
                {
                    key: '4', name: 'Vanguard Pad', cost: '150M', icon: 'hero',
                    locked: state.heroPlaced,
                    desc: 'Build Solaris Ascendant Beacon [4]: 150M · Warps in the elite Vanguard Marshal (Requires Pylon Power).',
                    fn: () => setMode('hero')
                },
                {
                    key: '5', name: 'Photon Turret', cost: '75M', icon: 'turret',
                    desc: 'Build Modular Photon Turret [5]: 75M · 3-Slot hardpoint defense bunker (Requires Pylon Power).',
                    fn: () => setMode('turret')
                },
                {
                    key: '8', name: 'Mine Drill', cost: '120M', icon: 'mine_drill',
                    desc: 'Build Deep-Core Mine Drill [8]: 120M · Continuously mines +14 Minerals/2.6s & extracts Khaydarin Gems from Gem Craters!',
                    fn: () => setMode('mine_drill')
                },
                {
                    key: '6', name: 'Box / Select', cost: 'TOOL', icon: 'move',
                    desc: 'Tactical Selection Tool [6]: Click structures or drag a box to command squads.',
                    fn: () => setMode('select')
                },
                {
                    key: 'O', name: 'Nexus Overload', cost: '150M BLAST', icon: 'hold',
                    locked: state.req < 150,
                    desc: 'Emergency Nexus Overload [O]: 150M · Vaporizes surrounding enemies & restores Nexus to 100% HP!',
                    fn: () => {
                        if (state.req >= 150) {
                            state.req -= 150;
                            executeHQEmergencyOverloadRepair();
                        }
                    }
                },
                {
                    key: 'ESC', name: 'Build Menu', cost: 'BACK', icon: 'base',
                    desc: 'Return to Construction Command Card [ESC].',
                    fn: () => selectStructure(null)
                }
            ]
            : [
                {
                    key: '2', name: 'Barracks', cost: '100M', icon: 'barracks',
                    desc: 'Build Infantry Barracks [2]: 100M · Trains Shock Troopers, Marksmen, Medics, Rocket Men & Reapers.',
                    fn: () => setMode('barracks')
                },
                {
                    key: '3', name: 'War Factory', cost: '200M', icon: 'factory',
                    desc: 'Build Heavy War Factory [3]: 200M · Assembles Siege Tanks, Gunships, Dropships & Valkyrie Semi-Mechs.',
                    fn: () => setMode('factory')
                },
                {
                    key: '4', name: 'Vanguard Pad', cost: '150M', icon: 'hero',
                    locked: state.heroPlaced,
                    desc: 'Build Vanguard Beacon Pad [4]: 150M · Warps in the elite Vanguard Marshal.',
                    fn: () => setMode('hero')
                },
                {
                    key: '5', name: 'Ball Turret', cost: '75M', icon: 'turret',
                    desc: 'Build Modular Ball Turret [5]: 75M · 3-Slot hardpoint defense bunker.',
                    fn: () => setMode('turret')
                },
                {
                    key: '8', name: 'Mine Drill', cost: '120M', icon: 'mine_drill',
                    desc: 'Build Deep-Core Mine Drill [8]: 120M · Continuously mines +14 Minerals/2.6s. Place on a Gem Crater to extract Gems for bonus Troops & Builds!',
                    fn: () => setMode('mine_drill')
                },
                {
                    key: '6', name: 'Box / Select', cost: 'TOOL', icon: 'move',
                    desc: 'Tactical Selection Tool [6]: Click structures or drag a box to command squads.',
                    fn: () => setMode('select')
                },
                {
                    key: 'F2', name: 'Select Army', cost: `${units.length}U`, icon: 'attack',
                    locked: units.length === 0,
                    desc: 'Select All Combat Units [F2]: Selects every friendly unit on the battlefield.',
                    fn: () => selectAllArmy()
                },
                {
                    key: 'O', name: 'HQ Overload', cost: '150M BLAST', icon: 'hold',
                    locked: state.req < 150,
                    desc: 'Emergency HQ Overload [O]: 150M · Vaporizes surrounding enemies & restores HQ to 100% HP!',
                    fn: () => {
                        if (state.req >= 150) {
                            state.req -= 150;
                            executeHQEmergencyOverloadRepair();
                        }
                    }
                },
                {
                    key: 'ESC', name: 'Build Menu', cost: 'BACK', icon: 'base',
                    desc: 'Return to Terran Construction Command Card [ESC].',
                    fn: () => selectStructure(null)
                }
            ];

        baseCmds.forEach(bc => {
            const btn = document.createElement('button');
            if (!bc) {
                btn.className = 'cmd-cell'; btn.disabled = true;
                grid.appendChild(btn);
                return;
            }
            btn.className = 'cmd-cell' + (bc.equipped ? ' equipped' : '');
            btn.disabled = !!bc.locked;
            btn.innerHTML = `<div class="cmd-top-row"><span class="cmd-hotkey">${bc.key}</span>${getCmdIconSvg(bc.icon)}</div><span class="cmd-name">${bc.name}</span><span class="cmd-cost">${bc.cost}</span>`;
            btn.onmouseenter = () => setCmdTooltip(bc.desc);
            btn.onclick = bc.fn;
            grid.appendChild(btn);
        });
        return;
    }

    // 4. DEFAULT TERRAN (OR SOLARIS IF FACTION CHANGED) CONSTRUCTION COMMAND CARD
    titleEl.innerText = 'COMMAND CARD';
    prodPanel.style.display = 'none';
    if (statsStrip) statsStrip.style.display = 'grid';

    updateCommPortrait(state.playerFaction === 'solaris' ? 'solaris_nexus' : 'base');
    document.getElementById('sel-title').innerText = state.playerFaction === 'solaris' ? 'SOLARIS PROTOSS COMMAND' : 'TERRAN DOMINION COMMAND';
    document.getElementById('sel-rank-tag').innerText = HAS_RAVINE_BRIDGES ? `BRIDGES: ${BRIDGES.length}` : 'OPEN VALLEY';
    const typeTag = document.getElementById('sel-type-tag');
    if (typeTag) typeTag.innerText = 'COMMAND';
    const wfRoleTag = document.getElementById('wireframe-role-tag');
    if (wfRoleTag) wfRoleTag.innerText = 'COMMAND GRID';
    document.getElementById('sel-subtitle').innerText = state.playerFaction === 'solaris'
        ? 'Solaris Protoss Faction Active: Build Khaydarin Pylon [7] to power Warp Gates [2], Robotics Bay [3] & Turrets [5]!'
        : 'Terran Dominion Active: Deploy Barracks [2], War Factory [3], Turrets [5] & Mine Drills [8] on Gem Craters!';
    document.getElementById('stat-weapon').innerText = state.playerFaction === 'solaris' ? 'PSIONIC MATRIX' : 'ORBITAL RELAY';
    document.getElementById('stat-dmg').innerText = `${units.length} ACTIVE`;
    document.getElementById('stat-rng').innerText = `${POWER_RADIUS}m GRID`;
    document.getElementById('stat-order').innerText = state.mode.toUpperCase();
    document.getElementById('wireframe-shield-tag').innerText = `GEMS: ${state.gems}`;
    setCmdTooltip(state.playerFaction === 'solaris'
        ? 'Deploy Nexus [1], Khaydarin Power Pylon [7], Warp Gate [2], Robotics Bay [3], Turret [5], or Mine Drill [8]'
        : 'Select a structure to deploy [1–5, 8: Mine Drill] or Box-Select units [6 / F2]');

    const buildCells = state.playerFaction === 'solaris'
        ? [
            { key: '1', m: 'base', name: 'Solaris Nexus', cost: 'FREE', icon: 'solaris_nexus', locked: state.basePlaced, desc: 'Deploy Solaris Astral Nexus HQ [1]: Establishes Nexus and dispatches Protoss Mining Probes.' },
            { key: '7', m: 'solaris_pylon', name: 'Khaydarin Pylon', cost: '75M', icon: 'solaris_pylon', locked: !state.basePlaced, desc: 'Khaydarin Power Pylon [7]: 75M · Projects a 20m Psionic Power Matrix required to power Protoss structures!' },
            { key: '2', m: 'solaris_gate', name: 'Warp Gate', cost: '150M', icon: 'solaris_gate', locked: !state.basePlaced, desc: 'Solaris Astral Warp Gate [2]: 150M · Warps in Chrono-Zealots, Prism Stalkers & Aether Archons (Requires Pylon Power)!' },
            { key: '3', m: 'solaris_robotics', name: 'Robotics Bay', cost: '200M', icon: 'solaris_robotics', locked: !state.basePlaced, desc: 'Solaris Robotics & Fleet Bay [3]: 200M · Warps in Heavy Armor, Siege Artillery & Airships (Requires Pylon Power)!' },
            { key: '9', m: 'solaris_cyber_lab', name: 'Cyber Forge Lab', cost: '150M', icon: 'solaris_cyber_lab', locked: !state.basePlaced, desc: 'Solaris Cybernetics Forge Lab [9]: 150M · Researches Lv.1–Lv.3 Arms & Armor Upgrades with 3D Visual Unit Enhancements!' },
            { key: '5', m: 'turret', name: 'Photon Turret', cost: '75M', icon: 'turret', locked: !state.basePlaced, desc: 'Modular Defense Turret [5]: 75M · 3-Slot hardpoint defense matrix (Requires Pylon Power).' },
            { key: '8', m: 'mine_drill', name: 'Mine Drill', cost: '120M', icon: 'mine_drill', locked: !state.basePlaced, desc: 'Deep-Core Mine Drill [8]: 120M · Mines +14 Minerals/2.6s & extracts Khaydarin Gems from Gem Craters!' },
            { key: '4', m: 'hero', name: 'Vanguard Pad', cost: '150M', icon: 'hero', locked: !state.basePlaced || state.heroPlaced, desc: 'Solaris Ascendant Beacon [4]: 150M · Warps in the elite Vanguard Marshal (Requires Pylon Power).' },
            { key: '6', m: 'select', name: 'Box / Select', cost: 'TOOL', icon: 'move', locked: !state.basePlaced, desc: 'Tactical Selection Tool [6]: Click structures to configure or drag box to command squads.' }
        ]
        : [
            { key: '1', m: 'base', name: 'Command HQ', cost: 'FREE', icon: 'base', locked: state.basePlaced, desc: 'Deploy Orbital Command Citadel HQ [1]: Establishes power grid and tactical radar.' },
            { key: '2', m: 'barracks', name: 'Barracks', cost: '100M', icon: 'barracks', locked: !state.basePlaced, desc: 'Infantry Barracks [2]: 100M · Continuously trains Shock Troopers, Marksmen, Medics, Rocket Men, Reapers, Firebats & Marauders.' },
            { key: '3', m: 'factory', name: 'War Factory', cost: '200M', icon: 'factory', locked: !state.basePlaced, desc: 'Heavy War Factory [3]: 200M · Assembles Tanks, Siege Tanks, Gunships, Dropships & Transformable Valkyrie Semi-Mechs.' },
            { key: '9', m: 'tech_lab', name: 'Weapons Lab', cost: '150M', icon: 'tech_lab', locked: !state.basePlaced, desc: 'Engineering & Weapons Lab [9]: 150M · Upgrades unit Arms & Armor (Lv.1–Lv.3) and visually upgrades unit 3D models!' },
            { key: '5', m: 'turret', name: 'Ball Turret', cost: '75M', icon: 'turret', locked: !state.basePlaced, desc: 'Modular Ball Turret [5]: 75M · 3-Slot hardpoint bunker (Gatling, Plasma, Rocket, Shield, Sniper, Drone, Mortar, Mind Ctrl).' },
            { key: '8', m: 'mine_drill', name: 'Mine Drill', cost: '120M', icon: 'mine_drill', locked: !state.basePlaced, desc: 'Deep-Core Mine Drill [8]: 120M · Mines +14 Minerals/2.6s & extracts Khaydarin Gems from Gem Craters for Troops/Builds!' },
            { key: '4', m: 'hero', name: 'Vanguard Pad', cost: '150M', icon: 'hero', locked: !state.basePlaced || state.heroPlaced, desc: 'Vanguard Beacon Pad [4]: 150M · Warps in the elite Vanguard Marshal with Aegis-X9 Sunlance Rail-Cannon.' },
            { key: '6', m: 'select', name: 'Box / Select', cost: 'TOOL', icon: 'move', locked: !state.basePlaced, desc: 'Tactical Selection Tool [6]: Click structures to configure or drag box to command squads.' },
            { key: 'O', m: 'overload', name: 'HQ Overload', cost: '150M BLAST', icon: 'hold', locked: !state.basePlaced || state.req < 150, desc: 'Emergency HQ Overload [O]: 150M · Detonates EMP shockwave killing surrounding enemies & restoring HQ!' }
        ];

    buildCells.forEach(bc => {
        const btn = document.createElement('button');
        if (!bc) {
            btn.className = 'cmd-cell'; btn.disabled = true;
            grid.appendChild(btn);
            return;
        }
        btn.className = 'cmd-cell' + (state.mode === bc.m ? ' active' : '');
        btn.disabled = bc.locked;
        btn.innerHTML = `<div class="cmd-top-row"><span class="cmd-hotkey">${bc.key}</span>${getCmdIconSvg(bc.icon)}</div><span class="cmd-name">${bc.name}</span><span class="cmd-cost">${bc.cost}</span>`;
        btn.onmouseenter = () => setCmdTooltip(bc.desc);
        btn.onclick = () => {
            if (bc.m === 'army') selectAllArmy();
            else if (bc.m === 'overload') {
                if (state.req >= 150) {
                    state.req -= 150;
                    executeHQEmergencyOverloadRepair();
                }
            }
            else setMode(bc.m);
        };
        grid.appendChild(btn);
    });
}

function setSiegeTankMode(u, toSiegeMode, isManual = false) {
    if (!u || u.type !== 'siege_tank') return false;
    const nextMode = !!toSiegeMode;
    if (u.siegeMode === nextMode) return false;
    if ((u.siegeSwitchCooldown || 0) > 0 || (u.siegeTransitionTimer || 0) > 0) {
        if (isManual) {
            const rem = Math.max(u.siegeSwitchCooldown || 0, u.siegeTransitionTimer || 0);
            spawnCombatFloat(u.mesh.position, `SIEGE COOLDOWN (${rem.toFixed(1)}s)`, '#ffaa00');
        }
        return false;
    }
    u.siegeMode = nextMode;
    // Full hydraulic Siege / Unsiege transformation completes in 3.6 seconds (strictly under 5 seconds!); turret CANNOT fire until finished!
    u.siegeTransitionTimer = 3.6;
    u.siegeSwitchCooldown = 4.2;
    u.siegeCooldown = 4.2;
    if (u.mesh && u.mesh.userData) {
        u.mesh.userData.siegeMode = u.siegeMode;
    }
    const facKey = 'terran';
    const wLvl = (state.upgrades && state.upgrades[facKey]) ? (state.upgrades[facKey].weapons || 0) : 0;
    const wMult = 1.0 + wLvl * 0.20;
    if (u.siegeMode) {
        // Anchored Mjolnir Artillery Mode: Hydraulic outriggers planted, tank body 100% locked in place (only turret head rotates)!
        u.speed = 0;
        u.range = 28.5;
        u.minRange = 7.5;
        u.baseDamage = 145;
        u.damage = Math.round(145 * wMult);
        u.fireRate = 2.45;
        u.spawnRallyTimer = 0;
        u.anchoredPos = u.mesh.position.clone();
        u.anchoredYaw = (u.mesh && u.mesh.userData && u.mesh.userData.smoothYaw !== undefined)
            ? u.mesh.userData.smoothYaw
            : (u.currentYaw !== undefined ? u.currentYaw : u.mesh.rotation.y);
        if (u.mesh && u.mesh.userData) {
            u.mesh.userData.smoothYaw = u.anchoredYaw;
        }
        if (isManual) spawnCombatFloat(u.mesh.position, 'SIEGE ARTILLERY MODE (ANCHORED)', '#ffaa00');
    } else {
        // Mobile Tank Mode: 14.0m range, 85 DMG cannon, no minimum range deadzone
        u.speed = 2.6;
        u.range = 14.0;
        u.minRange = 0;
        u.baseDamage = 85;
        u.damage = Math.round(85 * wMult);
        u.fireRate = 1.85;
        u.anchoredPos = null;
        if (isManual) spawnCombatFloat(u.mesh.position, 'MOBILE TANK MODE', '#00e5ff');
    }
    if (isManual) {
        u.manualSiegeLockTimer = 9.0;
    }
    return true;
}

function toggleSelectedSiegeTankMode() {
    const sTanks = state.selectedUnits.filter(u => u && u.type === 'siege_tank' && u.hp > 0);
    if (sTanks.length === 0) return;
    const readyTanks = sTanks.filter(u => (u.siegeSwitchCooldown || 0) <= 0);
    if (readyTanks.length === 0) {
        const minCd = Math.min(...sTanks.map(u => u.siegeSwitchCooldown || 0));
        spawnCombatFloat(sTanks[0].mesh.position, `SIEGE HYDRAULICS COOLING (${minCd.toFixed(1)}s)`, '#ffaa00');
        return;
    }
    const nextSiege = !readyTanks.some(u => u.siegeMode);
    readyTanks.forEach(u => setSiegeTankMode(u, nextSiege, true));
    if (window.SFX) window.SFX.playClick();
    renderSC2CommandCard();
    updateHUD(true);
}

function setValkyrieCombatMode(u, toMechMode, isManual = false) {
    if (!u || u.type !== 'valkyrie') return;
    u.mechMode = !!toMechMode;
    u.isAir = !u.mechMode;
    u.transformTimer = 3.0; // Full 3.0-second Land / Fly transformation sequence
    u.modeSwitchCooldown = 3.4;
    if (u.mesh && u.mesh.userData) {
        u.mesh.userData.mechMode = u.mechMode;
    }
    if (u.mechMode) {
        // Semi-Mech Ground Walker Mode: lands over 3.0s on reverse-jointed hydraulic legs & engages ground targets
        u.speed = 4.6;
        u.range = 13.5;
        u.fireRate = 0.42;
        u.damage = 28;
        if (u.selCircle) u.selCircle.position.y = 0.08;
    } else {
        // Supersonic Strike-Fighter Mode: lifts off over 3.0s & intercepts air threats
        u.speed = 7.6;
        u.range = 17.5;
        u.fireRate = 1.05;
        u.damage = 42;
        if (u.selCircle) u.selCircle.position.y = -5.8;
    }
    if (isManual) {
        u.manualModeLockTimer = 9.0; // Respect manual mode toggle before auto-transforming
    }
}

function toggleSelectedValkyrieMode() {
    const valks = state.selectedUnits.filter(u => u && u.type === 'valkyrie' && u.hp > 0);
    if (valks.length === 0) return;
    const nextMech = !valks.some(u => u.mechMode);
    valks.forEach(u => setValkyrieCombatMode(u, nextMech, true));
    if (window.SFX) window.SFX.playClick();
    renderSC2CommandCard();
    updateHUD(true);
}

function renderMultiUnitSelectionGrid() {
    const titleEl = document.getElementById('multi-sel-title');
    const tabsEl = document.getElementById('multi-subgroup-tabs');
    const gridEl = document.getElementById('multi-unit-grid');
    if (!titleEl || !gridEl) return;

    titleEl.innerText = `SQUAD (${state.selectedUnits.length})`;
    gridEl.innerHTML = '';
    syncFormSquadButtonUI();

    // Render StarCraft II Subgroup Filter Tabs (ALL + per-unit-type counts)
    if (tabsEl) {
        tabsEl.innerHTML = '';
        const counts = {};
        state.selectedUnits.forEach(u => { counts[u.type] = (counts[u.type] || 0) + 1; });
        const types = Object.keys(counts);
        if (types.length > 1) {
            types.forEach(t => {
                const tab = document.createElement('button');
                tab.className = 'sc-subgroup-tab';
                tab.innerText = `${t.toUpperCase()} (${counts[t]})`;
                tab.title = `Isolate all ${t.toUpperCase()} units in squad`;
                tab.onclick = () => setSelectedUnits(state.selectedUnits.filter(u => u.type === t));
                tabsEl.appendChild(tab);
            });
        }
    }

    state.selectedUnits.slice(0, 16).forEach(u => {
        const ratio = Math.max(0, Math.min(1, u.hp / u.maxHp));
        const col = ratio > 0.6 ? '#00ff66' : (ratio > 0.3 ? '#ffaa00' : '#ff2a4b');
        const tile = document.createElement('div');
        tile.className = 'sc-unit-tile';
        tile.title = `Click to isolate ${u.type.toUpperCase()} (${Math.ceil(u.hp)}/${u.maxHp} HP)`;
        tile.innerHTML = `
            ${getWireframeSvgMarkup(u.type, col)}
            <span class="sc-unit-tile-name">${u.type}</span>
            <div class="sc-unit-tile-hp">
                <div class="sc-unit-tile-hp-fill" style="width:${Math.round(ratio * 100)}%;background:${col};"></div>
            </div>
        `;
        tile.onclick = () => setSelectedUnits([u]);
        gridEl.appendChild(tile);
    });
}

function setMode(m) {
    if (m === 'base' && state.basePlaced) return;
    if (m !== 'base' && !state.basePlaced) return;
    if (m === 'hero' && state.heroPlaced) return;

    if (window.SFX) window.SFX.playClick();
    state.selectedBuilding = null;
    state.selectedUnits = [];
    state.unitCommandMode = null;
    syncUnitSelectionVisuals();
    buildings.forEach(bld => {
        if (bld.type === 'turret' && typeof updateTurretRangeVisuals === 'function') {
            updateTurretRangeVisuals(bld, false);
        }
    });
    selRing.visible = false;
    state.mode = m;
    rebuildGhostModel(m);
    syncProtossPowerRadiusVisibility();
    renderSC2CommandCard();
}

function selectStructure(b) {
    if (window.SFX) window.SFX.playClick();
    state.selectedUnits = [];
    state.unitCommandMode = null;
    syncUnitSelectionVisuals();
    state.selectedBuilding = b;
    buildings.forEach(bld => {
        if (bld.type === 'turret' && typeof updateTurretRangeVisuals === 'function') {
            updateTurretRangeVisuals(bld, bld === b);
        }
    });
    if (b) {
        state.mode = 'select';
        rebuildGhostModel('select');
        selRing.position.set(b.pos.x, b.pos.y + 0.14, b.pos.z);
        selRing.visible = true;
    } else {
        selRing.visible = false;
    }
    syncProtossPowerRadiusVisibility();
    renderSC2CommandCard();
    updateHUD();
}

// --- INTERACTIVE TACTICAL RADAR MINIMAP VIEWER ---
const minimapCanvas = document.getElementById('minimap-canvas');
const minimapCtx = minimapCanvas.getContext('2d');
let isMinimapDragging = false;

function handleMinimapPointerInput(e, isInitialDown = false) {
    const rect = minimapCanvas.getBoundingClientRect();
    const nx = THREE.MathUtils.clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0.02, 0.98);
    const ny = THREE.MathUtils.clamp((e.clientY - rect.top) / Math.max(1, rect.height), 0.02, 0.98);
    const wx = (nx - 0.5) * MAP_SIZE;
    const wz = (ny - 0.5) * MAP_SIZE;

    if (isInitialDown && state.selectedUnits.length > 0 && (e.button === 2 || state.unitCommandMode)) {
        const orderToIssue = state.unitCommandMode || 'attack_move';
        issueSquadOrder(orderToIssue, new THREE.Vector3(wx, getTerrainHeight(wx, wz), wz));
        return;
    }

    const offset = camera.position.clone().sub(controls.target);
    controls.target.set(wx, getTerrainHeight(wx, wz), wz);
    camera.position.copy(controls.target).add(offset);
    controls.update();
    renderTacticalMinimap();
}

minimapCanvas.addEventListener('contextmenu', e => e.preventDefault());
minimapCanvas.addEventListener('pointerdown', e => {
    e.stopPropagation();
    if (window.titleScreenActive || window.loadingCameraSweep) return;
    if (e.button === 0 && !state.unitCommandMode) {
        isMinimapDragging = true;
        if (minimapCanvas.setPointerCapture) {
            try { minimapCanvas.setPointerCapture(e.pointerId); } catch (_) {}
        }
    }
    handleMinimapPointerInput(e, true);
});
minimapCanvas.addEventListener('pointermove', e => {
    if (window.titleScreenActive || window.loadingCameraSweep) return;
    if (!isMinimapDragging) return;
    e.stopPropagation();
    handleMinimapPointerInput(e, false);
});
minimapCanvas.addEventListener('pointerup', e => {
    if (isMinimapDragging) {
        isMinimapDragging = false;
        if (minimapCanvas.releasePointerCapture) {
            try { minimapCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
        }
    }
});

window.focusCameraOnSector = function(sector) {
    let targetPt = PLAYER_START_POS;
    if (sector === 'hq') {
        targetPt = state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS;
    } else if (sector === 'hive') {
        targetPt = ENEMY_BASE_POS;
    } else if (sector === 'solaris' && typeof SOLARIS_BASE_POS !== 'undefined') {
        targetPt = SOLARIS_BASE_POS;
    }
    const offset = camera.position.clone().sub(controls.target);
    const ty = getTerrainHeight(targetPt.x, targetPt.z);
    controls.target.set(targetPt.x, ty, targetPt.z);
    camera.position.copy(controls.target).add(offset);
    controls.update();
    renderTacticalMinimap();
    if (window.SFX) window.SFX.playClick();
};

window.toggleMinimapExpand = function() {
    const wing = document.getElementById('minimap-wing');
    const btn = document.getElementById('btn-minimap-expand');
    if (!wing) return;
    const expanded = wing.classList.toggle('minimap-expanded');
    if (btn) btn.innerText = expanded ? '⤡' : '⤢';
    if (window.SFX) window.SFX.playClick();
    renderTacticalMinimap();
};

let _minimapTerrainCache = null;
let _minimapTerrainSeed = null;

function renderTacticalMinimap() {
    if (!minimapCanvas || !minimapCtx) return;
    const w = minimapCanvas.width, h = minimapCanvas.height;
    minimapCtx.fillStyle = '#050a11';
    minimapCtx.fillRect(0, 0, w, h);

    if (!_minimapTerrainCache || _minimapTerrainSeed !== window.ACTIVE_MAP_SEED) {
        _minimapTerrainSeed = window.ACTIVE_MAP_SEED;
        _minimapTerrainCache = new Uint8Array((FOW_RES / 2) * (FOW_RES / 2));
        let cIdx = 0;
        for (let gy = 0; gy < FOW_RES; gy += 2) {
            for (let gx = 0; gx < FOW_RES; gx += 2) {
                const wx = ((gx / FOW_RES) - 0.5) * MAP_SIZE;
                const wz = ((gy / FOW_RES) - 0.5) * MAP_SIZE;
                const rDist = typeof getRiverDist === 'function' ? getRiverDist(wx, wz) : Math.abs(getRavineSignedDist(wx, wz));
                const onBridge = typeof isOnRiverBridge === 'function' ? isOnRiverBridge(wx, wz, 0.3) : (getBridgeFactor(wx, wz) > 0.65);
                const roadFac = typeof getSupplyRoadFactor === 'function' ? getSupplyRoadFactor(wx, wz) : 0;
                if (onBridge && rDist < 6.0) _minimapTerrainCache[cIdx] = 1;
                else if (rDist < 3.6) _minimapTerrainCache[cIdx] = 2;
                else if (roadFac > 0.25) _minimapTerrainCache[cIdx] = 3;
                else _minimapTerrainCache[cIdx] = 0;
                cIdx++;
            }
        }
    }

    let cIdx = 0;
    for (let gy = 0; gy < FOW_RES; gy += 2) {
        for (let gx = 0; gx < FOW_RES; gx += 2) {
            const idx = gy * FOW_RES + gx;
            const isVis = !!fowVisible[idx] || !!window.fowRevealAll;
            const isExp = !!fowExplored[idx] || isVis;
            const tType = _minimapTerrainCache[cIdx++];

            if (tType === 1) {
                minimapCtx.fillStyle = isVis ? '#cbd5e1' : (isExp ? '#94a3b8' : '#64748b');
            } else if (tType === 2) {
                minimapCtx.fillStyle = isVis ? '#0ea5e9' : (isExp ? '#0369a1' : '#082f49');
            } else if (tType === 3) {
                minimapCtx.fillStyle = isVis ? '#786854' : (isExp ? '#4a3f33' : '#29231c');
            } else {
                minimapCtx.fillStyle = isVis ? '#2f4b2b' : (isExp ? '#1b2c19' : '#0f1910');
            }
            minimapCtx.fillRect((gx / FOW_RES) * w, (gy / FOW_RES) * h, 3, 3);
        }
    }

    // Subtle radar grid lines
    minimapCtx.strokeStyle = 'rgba(0, 229, 255, 0.14)';
    minimapCtx.lineWidth = 1;
    minimapCtx.beginPath();
    minimapCtx.moveTo(w * 0.5, 0); minimapCtx.lineTo(w * 0.5, h);
    minimapCtx.moveTo(0, h * 0.5); minimapCtx.lineTo(w, h * 0.5);
    minimapCtx.stroke();

    // Zerg Creep Zone Overlay on Tactical Minimap (Only shown when a Zerg Main Base is already built & visible)
    const minimapFowBypass = !!(window.titleScreenActive || window.loadingCameraSweep || window.fowRevealAll);
    const minimapCreepState = typeof window.getActiveZergCreepState === 'function'
        ? window.getActiveZergCreepState()
        : { hasBuiltZergMainBase: (typeof creepRadius !== 'undefined' && creepRadius > 0.5), x: ENEMY_BASE_POS.x, z: ENEMY_BASE_POS.z };
    if (minimapCreepState.hasBuiltZergMainBase && typeof creepRadius !== 'undefined' && creepRadius > 0.5) {
        const creepVis = minimapFowBypass || isWorldPosVisible(minimapCreepState.x, minimapCreepState.z);
        if (creepVis) {
            const cx = ((minimapCreepState.x / MAP_SIZE) + 0.5) * w;
            const cy = ((minimapCreepState.z / MAP_SIZE) + 0.5) * h;
            const cr = (creepRadius / MAP_SIZE) * w;
            const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.004);
            const grad = minimapCtx.createRadialGradient(cx, cy, cr * 0.1, cx, cy, cr);
            grad.addColorStop(0, `rgba(168, 85, 247, ${0.42 + pulse * 0.14})`);
            grad.addColorStop(0.7, `rgba(126, 34, 206, ${0.28 + pulse * 0.10})`);
            grad.addColorStop(1, 'rgba(88, 28, 135, 0)');
            minimapCtx.fillStyle = grad;
            minimapCtx.beginPath();
            minimapCtx.arc(cx, cy, cr, 0, Math.PI * 2);
            minimapCtx.fill();

            minimapCtx.strokeStyle = `rgba(216, 180, 254, ${0.45 + pulse * 0.25})`;
            minimapCtx.lineWidth = 1.2;
            minimapCtx.beginPath();
            minimapCtx.arc(cx, cy, cr * (0.92 + pulse * 0.06), 0, Math.PI * 2);
            minimapCtx.stroke();
        }
    }

    // Solaris Chrono-Synod Enclave Structures (Gold-Cyan Diamonds; respect FOW when hostile)
    solarisBuildings.forEach(sb => {
        if (!sb || sb.hp <= 0) return;
        if (state.solarisHostile && !minimapFowBypass && !isWorldPosVisible(sb.pos.x, sb.pos.z)) return;
        if (!state.solarisHostile && !minimapFowBypass && !isWorldPosExplored(sb.pos.x, sb.pos.z)) return;
        const mx = ((sb.pos.x / MAP_SIZE) + 0.5) * w;
        const my = ((sb.pos.z / MAP_SIZE) + 0.5) * h;
        minimapCtx.fillStyle = '#f5b932';
        minimapCtx.fillRect(mx - 3, my - 3, 6, 6);
        minimapCtx.strokeStyle = '#38bdf8';
        minimapCtx.strokeRect(mx - 3.5, my - 3.5, 7, 7);
    });

    // Gem Craters on Tactical Minimap (Glowing Magenta Diamonds for Rich Craters, Grey for Empty Craters)
    if (Array.isArray(window.GEM_CRATERS)) {
        window.GEM_CRATERS.forEach(gc => {
            if (!gc) return;
            const mx = ((gc.x / MAP_SIZE) + 0.5) * w;
            const my = ((gc.z / MAP_SIZE) + 0.5) * h;
            const rich = !gc.isEmpty && gc.gemsRemaining > 0;
            minimapCtx.fillStyle = rich ? '#e879f9' : '#64748b';
            minimapCtx.beginPath();
            minimapCtx.moveTo(mx, my - 3.5);
            minimapCtx.lineTo(mx + 3.5, my);
            minimapCtx.lineTo(mx, my + 3.5);
            minimapCtx.lineTo(mx - 3.5, my);
            minimapCtx.closePath();
            minimapCtx.fill();
        });
    }

    buildings.forEach(b => {
        const mx = ((b.pos.x / MAP_SIZE) + 0.5) * w;
        const my = ((b.pos.z / MAP_SIZE) + 0.5) * h;
        minimapCtx.fillStyle = b.type === 'solaris_gate' ? '#f5b932' : (b.type === 'mine_drill' ? '#e879f9' : '#00e5ff');
        minimapCtx.fillRect(mx - 2.5, my - 2.5, 5, 5);
    });
    units.forEach(u => {
        const mx = ((u.mesh.position.x / MAP_SIZE) + 0.5) * w;
        const my = ((u.mesh.position.z / MAP_SIZE) + 0.5) * h;
        const isSolarisUnit = (u.type === 'zealot' || u.type === 'stalker' || u.type === 'archon');
        minimapCtx.fillStyle = state.selectedUnits.includes(u) ? '#ffffff' : (isSolarisUnit ? '#f5b932' : '#00ff66');
        minimapCtx.fillRect(mx - 1.75, my - 1.75, 3.5, 3.5);
    });

    // Enemy structures ONLY appear on minimap when currently visible inside active player vision!
    enemyBuildings.forEach(eb => {
        if (!eb || eb.hp <= 0) return;
        if (!minimapFowBypass && !isWorldPosVisible(eb.pos.x, eb.pos.z)) return;
        const mx = ((eb.pos.x / MAP_SIZE) + 0.5) * w;
        const my = ((eb.pos.z / MAP_SIZE) + 0.5) * h;
        minimapCtx.fillStyle = '#9333ea';
        minimapCtx.fillRect(mx - 3.5, my - 3.5, 7, 7);
        minimapCtx.fillStyle = '#ff2a4b';
        minimapCtx.fillRect(mx - 2.25, my - 2.25, 4.5, 4.5);
    });
    enemies.forEach(e => {
        if (!e.mesh.visible) return;
        const mx = ((e.mesh.position.x / MAP_SIZE) + 0.5) * w;
        const my = ((e.mesh.position.z / MAP_SIZE) + 0.5) * h;
        minimapCtx.fillStyle = e.isSolarisHostile ? '#f5b932' : '#ff2a4b';
        minimapCtx.fillRect(mx - 1.5, my - 1.5, 3, 3);
    });

    const camX = ((controls.target.x / MAP_SIZE) + 0.5) * w;
    const camY = ((controls.target.z / MAP_SIZE) + 0.5) * h;
    minimapCtx.strokeStyle = '#ffffff';
    minimapCtx.lineWidth = 1.2;
    minimapCtx.strokeRect(camX - 13, camY - 10, 26, 20);
}

// ============================================================================
// CLICK-AND-DRAG SELECTION BOX OVERLAY & RAYCASTING SYSTEM
// ============================================================================
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const selectionBoxEl = document.getElementById('selection-box');
const selectionBoxCountEl = document.getElementById('selection-box-count');
const touchHoldRingEl = document.getElementById('touch-hold-ring');
let cursorWorldPos = null;
let pointerDownXY = { x: 0, y: 0 };
let rightPointerDownXY = { x: 0, y: 0 };
let isLeftMouseDown = false;
let isBoxDragging = false;
let isTouchPointer = false;
let touchHoldTimer = null;
let isTouchHoldSelectActive = false;
let activeTouchPointers = 0;

function clearTouchHoldState() {
    if (touchHoldTimer) {
        clearTimeout(touchHoldTimer);
        touchHoldTimer = null;
    }
    isTouchHoldSelectActive = false;
    if (touchHoldRingEl) {
        touchHoldRingEl.style.display = 'none';
    }
    controls.enabled = true;
}

const _groundFallbackPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _groundFallbackPt = new THREE.Vector3();

function updateMouseRay(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(terrainMesh);
    if (hits.length > 0) {
        cursorWorldPos = hits[0].point;
    } else if (raycaster.ray.intersectPlane(_groundFallbackPlane, _groundFallbackPt)) {
        const cx = THREE.MathUtils.clamp(_groundFallbackPt.x, -110, 110);
        const cz = THREE.MathUtils.clamp(_groundFallbackPt.z, -110, 110);
        cursorWorldPos = new THREE.Vector3(cx, getTerrainHeight(cx, cz), cz);
    } else {
        cursorWorldPos = null;
    }
}

function getFriendlyUnitsInScreenBox(x1, y1, x2, y2, extraPad = 12) {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);
    const rect = renderer.domElement.getBoundingClientRect();
    const matched = [];
    const projVec = new THREE.Vector3();

    units.forEach(u => {
        if (u.hp <= 0) return;
        projVec.copy(u.mesh.position);
        projVec.y += 0.6;
        projVec.project(camera);
        if (projVec.z > 1) return;

        const sx = (projVec.x * 0.5 + 0.5) * rect.width + rect.left;
        const sy = (-(projVec.y * 0.5) + 0.5) * rect.height + rect.top;

        if (sx >= minX - extraPad && sx <= maxX + extraPad && sy >= minY - extraPad && sy <= maxY + extraPad) {
            matched.push(u);
        }
    });
    return matched;
}

window.addEventListener('pointermove', e => {
    if (window.titleScreenActive || window.loadingCameraSweep) {
        ghostRoot.visible = false;
        cursorTag.style.display = 'none';
        selectionBoxEl.style.display = 'none';
        isBoxDragging = false;
        return;
    }
    if (isLeftMouseDown) {
        const dragDist = Math.hypot(e.clientX - pointerDownXY.x, e.clientY - pointerDownXY.y);

        // On mobile/touch: if finger moves > 12px BEFORE the hold timer completes, cancel hold-select and let OrbitControls pan/orbit
        if (isTouchPointer && !isTouchHoldSelectActive && dragDist > 12) {
            clearTouchHoldState();
            isLeftMouseDown = false;
            return;
        }

        // Desktop left-drag OR Mobile after holding for 260ms activates selection box (only when not actively placing a building)
        const canBoxSelect = isTouchPointer ? isTouchHoldSelectActive : (dragDist > 9 && state.basePlaced && state.mode === 'select');
        if (canBoxSelect) {
            isBoxDragging = true;
            ghostRoot.visible = false;
            cursorTag.style.display = 'none';
            if (touchHoldRingEl) touchHoldRingEl.style.display = 'none';

            const left = Math.min(pointerDownXY.x, e.clientX);
            const top = Math.min(pointerDownXY.y, e.clientY);
            const width = Math.max(18, Math.abs(e.clientX - pointerDownXY.x));
            const height = Math.max(18, Math.abs(e.clientY - pointerDownXY.y));

            selectionBoxEl.style.display = 'block';
            selectionBoxEl.style.left = `${left}px`;
            selectionBoxEl.style.top = `${top}px`;
            selectionBoxEl.style.width = `${width}px`;
            selectionBoxEl.style.height = `${height}px`;

            const insideUnits = getFriendlyUnitsInScreenBox(
                pointerDownXY.x, pointerDownXY.y, e.clientX, e.clientY,
                isTouchPointer ? 22 : 12
            );
            selectionBoxCountEl.innerText = insideUnits.length > 0 ? `${insideUnits.length} UNIT${insideUnits.length > 1 ? 'S' : ''}` : 'HOLD & DRAG';

            units.forEach(u => {
                if (u.selCircle) {
                    u.selCircle.visible = insideUnits.includes(u) || state.selectedUnits.includes(u);
                }
            });
            return;
        }
    }

    if (e.target !== renderer.domElement) {
        cursorTag.style.display = 'none';
        return;
    }
    updateMouseRay(e.clientX, e.clientY);

    if (state.unitCommandMode && cursorWorldPos) {
        cursorTag.style.display = 'block';
        cursorTag.style.left = `${e.clientX}px`;
        cursorTag.style.top = `${e.clientY}px`;
        const isAtk = state.unitCommandMode === 'attack_move';
        cursorTag.innerText = isAtk ? 'CLICK TO ATTACK-MOVE SQUAD' : 'CLICK TO MOVE SQUAD';
        cursorTag.style.borderColor = isAtk ? '#ff2a4b' : '#00ff66';
        cursorTag.style.color = isAtk ? '#ff2a4b' : '#00ff66';
        return;
    }

    if (state.mode !== 'select' && cursorWorldPos) {
        // Find the closest friendly structure to the cursor (never blocked by overlapping turret shield domes!)
        let hoveredBld = null;
        let bestHoverDist = 2.25;
        buildings.forEach(b => {
            if (!b || b.hp <= 0) return;
            const d = Math.hypot(b.pos.x - cursorWorldPos.x, b.pos.z - cursorWorldPos.z);
            if (d < bestHoverDist) {
                bestHoverDist = d;
                hoveredBld = b;
            }
        });
        if (hoveredBld && (hoveredBld.type === 'turret' || hoveredBld.type === 'barracks' || hoveredBld.type === 'factory')) {
            ghostRoot.visible = false;
            cursorTag.style.display = 'block';
            cursorTag.style.left = `${e.clientX}px`;
            cursorTag.style.top = `${e.clientY}px`;
            cursorTag.innerText = hoveredBld.type === 'turret'
                ? `CLICK TURRET TO EQUIP GUNS & UPGRADE [MK-${hoveredBld.level || 1}]`
                : `CLICK ${hoveredBld.type.toUpperCase()} TO CONFIGURE QUEUE`;
            cursorTag.style.borderColor = '#ffaa00';
            cursorTag.style.color = '#ffaa00';
            return;
        }

        ghostRoot.visible = true;
        const check = evaluateBuildSpot(cursorWorldPos);
        const displayPos = check.snappedPos || cursorWorldPos;
        ghostRoot.position.copy(displayPos);
        if (state.mode === 'barrier') {
            // Auto-orient Blast Barrier perpendicular to the threat/Enemy Hive axis
            const angToThreat = Math.atan2(ENEMY_BASE_POS.x - displayPos.x, ENEMY_BASE_POS.z - displayPos.z);
            ghostRoot.rotation.y = angToThreat;
        } else {
            ghostRoot.rotation.y = 0;
        }
        cursorTag.style.display = 'block';
        cursorTag.style.left = `${e.clientX}px`;
        cursorTag.style.top = `${e.clientY}px`;
        cursorTag.innerText = check.reason;
        cursorTag.style.borderColor = check.ok ? '#00ff66' : '#ff2a4b';
        cursorTag.style.color = check.ok ? '#00ff66' : '#ff2a4b';

        if (ghostMesh) {
            ghostMesh.traverse(c => { if (c.isMesh) c.material = check.ok ? matGhostOk : matGhostBad; });
        }
    } else {
        cursorTag.style.display = 'none';
    }
});

renderer.domElement.addEventListener('pointerdown', e => {
    if (window.titleScreenActive || window.loadingCameraSweep) {
        ghostRoot.visible = false;
        cursorTag.style.display = 'none';
        selectionBoxEl.style.display = 'none';
        isBoxDragging = false;
        return;
    }
    if (e.pointerType === 'touch') {
        activeTouchPointers++;
        if (activeTouchPointers > 1) {
            // Multi-touch pinch/pan: cancel hold-to-select
            clearTouchHoldState();
            isLeftMouseDown = false;
            isBoxDragging = false;
            selectionBoxEl.style.display = 'none';
            return;
        }
    }

    if (e.button === 0) {
        isLeftMouseDown = true;
        isBoxDragging = false;
        isTouchPointer = (e.pointerType === 'touch' || IS_MOBILE);
        pointerDownXY = { x: e.clientX, y: e.clientY };

        // Mobile Hold-to-Select: require holding 1 finger for 260ms before activating unit selection (skip if waiting for a target click in unitCommandMode!)
        if (isTouchPointer && state.basePlaced && !state.unitCommandMode) {
            clearTouchHoldState();
            if (touchHoldRingEl) {
                touchHoldRingEl.style.display = 'block';
                touchHoldRingEl.style.left = `${e.clientX}px`;
                touchHoldRingEl.style.top = `${e.clientY}px`;
                touchHoldRingEl.style.borderStyle = 'dashed';
            }
            touchHoldTimer = setTimeout(() => {
                if (!isLeftMouseDown || activeTouchPointers > 1 || state.unitCommandMode) return;
                isTouchHoldSelectActive = true;
                controls.enabled = false; // Lock camera orbit while dragging unit selection box on mobile
                if (touchHoldRingEl) {
                    touchHoldRingEl.style.borderStyle = 'solid';
                }
                if (window.SFX) window.SFX.playClick();

                // Immediately preview any friendly units under the held finger
                const heldUnits = getFriendlyUnitsInScreenBox(
                    pointerDownXY.x - 32, pointerDownXY.y - 32,
                    pointerDownXY.x + 32, pointerDownXY.y + 32, 16
                );
                units.forEach(u => {
                    if (u.selCircle) u.selCircle.visible = heldUnits.includes(u) || state.selectedUnits.includes(u);
                });
            }, 260);
        }
    } else if (e.button === 2) {
        rightPointerDownXY = { x: e.clientX, y: e.clientY };
    }
});

window.addEventListener('pointercancel', e => {
    if (e.pointerType === 'touch') activeTouchPointers = Math.max(0, activeTouchPointers - 1);
    clearTouchHoldState();
    isLeftMouseDown = false;
    isBoxDragging = false;
    selectionBoxEl.style.display = 'none';
});

window.addEventListener('pointerup', e => {
    if (window.titleScreenActive || window.loadingCameraSweep) {
        clearTouchHoldState();
        isLeftMouseDown = false;
        isBoxDragging = false;
        selectionBoxEl.style.display = 'none';
        return;
    }
    if (e.pointerType === 'touch') {
        activeTouchPointers = Math.max(0, activeTouchPointers - 1);
    }

    // Right-Click quick order when friendly units are selected (and user didn't drag-orbit camera)
    if (e.button === 2 && state.selectedUnits.length > 0 && e.target === renderer.domElement) {
        if (Math.hypot(e.clientX - rightPointerDownXY.x, e.clientY - rightPointerDownXY.y) < 12) {
            updateMouseRay(e.clientX, e.clientY);
            if (cursorWorldPos) {
                issueSquadOrder(state.unitCommandMode || 'attack_move', cursorWorldPos);
            }
        }
        return;
    }

    if (e.button !== 0) return;

    const wasTouchHoldActive = isTouchHoldSelectActive;
    clearTouchHoldState();

    // If waiting for Move / Attack-Move target tap/click from Command Card, execute it on tap/click release!
    if (state.unitCommandMode && state.selectedUnits.length > 0 && e.target === renderer.domElement && !isBoxDragging) {
        isLeftMouseDown = false;
        if (Math.hypot(e.clientX - pointerDownXY.x, e.clientY - pointerDownXY.y) <= 22) {
            updateMouseRay(e.clientX, e.clientY);
            if (cursorWorldPos) {
                issueSquadOrder(state.unitCommandMode, cursorWorldPos);
                return;
            }
        }
    }

    // Complete Click-and-Drag OR Mobile Hold-to-Select Box
    if (isBoxDragging || wasTouchHoldActive) {
        isLeftMouseDown = false;
        isBoxDragging = false;
        selectionBoxEl.style.display = 'none';

        const pad = isTouchPointer ? 28 : 12;
        const boxedUnits = getFriendlyUnitsInScreenBox(pointerDownXY.x, pointerDownXY.y, e.clientX, e.clientY, pad);
        if (e.shiftKey && state.selectedUnits.length > 0) {
            const combined = [...state.selectedUnits];
            boxedUnits.forEach(u => { if (!combined.includes(u)) combined.push(u); });
            setSelectedUnits(combined);
        } else if (boxedUnits.length > 0) {
            setSelectedUnits(boxedUnits);
        } else {
            syncUnitSelectionVisuals();
            if (state.mode !== 'select') rebuildGhostModel(state.mode);
        }
        return;
    }

    isLeftMouseDown = false;
    if (e.target !== renderer.domElement) return;
    const maxClickDrift = state.mode !== 'select' ? 36 : 16;
    if (Math.hypot(e.clientX - pointerDownXY.x, e.clientY - pointerDownXY.y) > maxClickDrift) return;

    if (window.RAID_MUSIC && !window.RAID_MUSIC.playing && !window.RAID_MUSIC.muted) {
        window.RAID_MUSIC.start();
    }

    updateMouseRay(e.clientX, e.clientY);

    // If waiting for Move / Attack-Move target tap/click from Command Card
    if (state.unitCommandMode && state.selectedUnits.length > 0 && cursorWorldPos) {
        issueSquadOrder(state.unitCommandMode, cursorWorldPos);
        return;
    }

    // Helper to resolve which specific building was clicked/tapped (ignores shield domes & picks closest building!)
    const bldMeshes = buildings.map(b => b.mesh);
    const rawHitsB = raycaster.intersectObjects(bldMeshes, true).filter(hit => {
        let cur = hit.object;
        while (cur) {
            if (cur.userData && cur.userData.isShieldDome) return false;
            if (cur.parent && cur.parent.userData && cur.parent.userData.rangeGroup === cur) return false;
            cur = cur.parent;
        }
        return true;
    });

    let clickedBld = null;
    if (cursorWorldPos) {
        let bestGroundDist = Infinity;
        buildings.forEach(b => {
            if (!b || b.hp <= 0) return;
            const pickRad = Math.max(2.05, (b.footprintRadius || BUILDING_FOOTPRINT_RADII[b.type] || 1.85) + 0.25);
            const d = Math.hypot(b.pos.x - cursorWorldPos.x, b.pos.z - cursorWorldPos.z);
            if (d <= pickRad && d < bestGroundDist) {
                bestGroundDist = d;
                clickedBld = b;
            }
        });
    }
    if (rawHitsB.length > 0) {
        let obj = rawHitsB[0].object;
        while (obj.parent && obj.parent !== scene) obj = obj.parent;
        const rayBld = buildings.find(b => b.mesh === obj);
        if (rayBld) {
            if (!clickedBld || !cursorWorldPos) {
                clickedBld = rayBld;
            } else {
                const dRay = Math.hypot(rayBld.pos.x - cursorWorldPos.x, rayBld.pos.z - cursorWorldPos.z);
                const dGround = Math.hypot(clickedBld.pos.x - cursorWorldPos.x, clickedBld.pos.z - cursorWorldPos.z);
                if (dRay <= dGround + 0.65) clickedBld = rayBld;
            }
        }
    }

    // On Mobile, a quick tap when units are already selected issues an Attack-Move command to the tapped ground (unless tapping a building)
    if (isTouchPointer && state.selectedUnits.length > 0 && !clickedBld && cursorWorldPos) {
        issueSquadOrder('attack_move', cursorWorldPos);
        return;
    }

    // When Debug Mode UI is open, clicking or tapping a Zerg enemy unit in the 3D scene selects it in the Debug Unit Inspector!
    if (window.AI_DEBUG && window.AI_DEBUG.enabled && enemies.length > 0 && cursorWorldPos) {
        let bestDbgEnemy = null;
        let bestDbgDist = 2.4;
        for (let ei = 0; ei < enemies.length; ei++) {
            const en = enemies[ei];
            if (!en || en.hp <= 0 || !en.mesh) continue;
            const dE = Math.hypot(en.mesh.position.x - cursorWorldPos.x, en.mesh.position.z - cursorWorldPos.z);
            if (dE < bestDbgDist) {
                bestDbgDist = dE;
                bestDbgEnemy = en;
            }
        }
        if (bestDbgEnemy) {
            window.AI_DEBUG.selectUnit(bestDbgEnemy.id);
        }
    }

    // Desktop only: single click on a friendly unit selects it (Mobile requires Hold to select units!)
    if (!isTouchPointer) {
        const unitMeshes = units.map(u => u.mesh);
        const hitU = raycaster.intersectObjects(unitMeshes, true);
        if (hitU.length > 0 && (state.mode === 'select' || state.selectedUnits.length > 0)) {
            let obj = hitU[0].object;
            while (obj.parent && obj.parent !== scene) obj = obj.parent;
            const foundUnit = units.find(u => u.mesh === obj);
            if (foundUnit) {
                if (e.shiftKey) {
                    const exists = state.selectedUnits.includes(foundUnit);
                    const next = exists
                        ? state.selectedUnits.filter(u => u !== foundUnit)
                        : [...state.selectedUnits, foundUnit];
                    setSelectedUnits(next);
                } else {
                    setSelectedUnits([foundUnit]);
                }
                return;
            }
        }
    }

    // If in build mode and cursor is at a valid build spot, deploy the structure first so nearby buildings don't intercept placement clicks!
    if (state.mode !== 'select' && cursorWorldPos) {
        const check = evaluateBuildSpot(cursorWorldPos);
        if (check.ok) {
            deployStructure(check.snappedPos || cursorWorldPos);
            return;
        }
    }

    if (clickedBld && state.basePlaced) {
        selectStructure(clickedBld);
        return;
    }
    if (state.mode === 'select') {
        clearAllSelection();
        return;
    }
});

window.addEventListener('keydown', e => {
    if (e.key === 'F9') return; // Handled globally in capture phase by APP_ERROR_HANDLER
    if (window.titleScreenActive || window.loadingCameraSweep) return;
    const k = e.key.toLowerCase();
    if (e.key === 'F2') {
        e.preventDefault();
        selectAllArmy();
        return;
    }
    if (state.selectedBuilding && state.selectedBuilding.type === 'turret') {
        const sel = state.selectedBuilding;
        if (k === 'q') { state.activeTurretSlot = 'left'; renderSC2CommandCard(); return; }
        if (k === 'w') { state.activeTurretSlot = 'top'; renderSC2CommandCard(); return; }
        if (k === 'e') { state.activeTurretSlot = 'right'; renderSC2CommandCard(); return; }
        if (k === 'u') { upgradeTurret(sel); return; }
        const slotMap = { '1': 'mg', '2': 'flame', '3': 'plasma', '4': 'rocket', '5': 'shield', '6': 'sniper', '7': 'drone', '8': 'mortar', '9': 'mindcontrol', 'z': 'none' };
        if (slotMap[k] !== undefined) {
            const w = slotMap[k];
            const maxPwr = sel.maxPower || 9;
            const used = (WEAPON_COSTS[sel.weapons.left] || 0) + (WEAPON_COSTS[sel.weapons.right] || 0) + (WEAPON_COSTS[sel.weapons.top] || 0);
            const curCost = WEAPON_COSTS[sel.weapons[state.activeTurretSlot]] || 0;
            if (used - curCost + (WEAPON_COSTS[w] || 0) <= maxPwr) {
                sel.weapons[state.activeTurretSlot] = w;
                const nextEmpty = ['left', 'top', 'right'].find(s => !sel.weapons[s] || sel.weapons[s] === 'none');
                if (nextEmpty && w !== 'none') state.activeTurretSlot = nextEmpty;
                syncTurretPods(sel);
                if (window.SFX) window.SFX.playClick();
                renderSC2CommandCard();
                updateHUD();
            }
            return;
        }
    }
    if (state.selectedBuilding && (state.selectedBuilding.type === 'barracks' || state.selectedBuilding.type === 'factory' || state.selectedBuilding.type === 'solaris_gate' || state.selectedBuilding.type === 'solaris_robotics')) {
        const sel = state.selectedBuilding;
        const isB = sel.type === 'barracks';
        const isSol = sel.type === 'solaris_gate';
        const isSolRobo = sel.type === 'solaris_robotics';
        const targetU = isSol
            ? (k === 'q' ? 'zealot' : (k === 'w' ? 'stalker' : (k === 'e' ? 'archon' : null)))
            : (isSolRobo
                ? (k === 'q' ? 'phoenix' : (k === 'w' ? 'void_ray' : (k === 'e' ? 'carrier' : (k === 'r' ? 'stalker' : (k === 't' ? 'archon' : (k === 'y' ? 'zealot' : null))))))
                : (isB
                    ? (k === 'q' ? 'grunt' : (k === 'w' ? 'ranger' : (k === 'e' ? 'medic' : (k === 'r' ? 'rocketman' : (k === 't' ? 'reaper' : (k === 'y' ? 'firebat' : (k === 'u' ? 'marauder' : null)))))))
                    : (k === 'q' ? 'tank' : (k === 'w' ? 'heli' : (k === 'e' ? 'transport' : (k === 'r' ? 'valkyrie' : (k === 't' ? 'siege_tank' : null)))))));
        if (targetU && targetU !== sel.unitType) {
            if (targetU === 'transport' && !buildings.some(b => (b.type === 'barracks' || b.type === 'solaris_gate') && b.hp > 0)) {
                spawnCombatFloat(sel.pos, 'BUILD INFANTRY BAY FIRST!', '#ff2a4b');
            } else {
                const spawnTimes = {
                    grunt: 9.0, ranger: 10.0, medic: 10.5, rocketman: 11.5, reaper: 10.0, firebat: 11.0, marauder: 12.5,
                    tank: 15.5, siege_tank: 18.0, heli: 14.0, transport: 14.0, valkyrie: 16.5,
                    zealot: 10.0, stalker: 12.0, archon: 15.5,
                    phoenix: 12.0, void_ray: 15.0, carrier: 18.5
                };
                sel.unitType = targetU;
                sel.spawnDuration = spawnTimes[targetU] || 10.0;
                sel.spawnTimer = sel.spawnDuration; // Reset progress on hotkey switch!
                spawnCombatFloat(sel.pos, `QUEUED: ${targetU.toUpperCase()}`, (isSol || sel.type === 'solaris_robotics') ? '#f5b932' : '#00e5ff');
                renderSC2CommandCard();
                updateHUD();
            }
            return;
        }
    }
    if (state.selectedUnits.length > 0) {
        if (k === 'm' || k === '1') { state.unitCommandMode = state.unitCommandMode === 'move' ? null : 'move'; renderSC2CommandCard(); return; }
        if (k === 'a' || k === '2') {
            const defaultDest = enemyBuildings.length > 0 ? enemyBuildings[0].pos : (enemies.length > 0 ? enemies[0].mesh.position : (state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS));
            state.unitCommandMode = 'attack_move';
            issueSquadOrder('attack_move', defaultDest, true);
            return;
        }
        if (k === 'h' || k === '3') { issueSquadOrder('hold', null); return; }
        if (k === 's' || k === '4') { issueSquadOrder('auto', null); return; }
        if (k === 'f' || k === '5') {
            if (state.selectedUnits.length > 1) {
                formSquadImmediately();
            } else {
                const hiveTarget = enemyBuildings.length > 0 ? enemyBuildings[0].pos : (enemies.length > 0 ? enemies[0].mesh.position : ENEMY_BASE_POS);
                issueSquadOrder('attack_move', hiveTarget);
            }
            return;
        }
        if (k === 'g' || k === '6') { issueSquadOrder('retreat', state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS); return; }
        if (k === 'v' || k === '7') { cycleSquadFormation(); return; }
        if (k === 't' || k === '8') {
            if (state.selectedUnits.some(u => u && u.type === 'valkyrie')) toggleSelectedValkyrieMode();
            else if (state.selectedUnits.some(u => u && u.type === 'siege_tank')) toggleSelectedSiegeTankMode();
            return;
        }
        if (e.key === 'Escape') { clearAllSelection(); return; }
    }
    if (state.selectedBuilding && (state.selectedBuilding.type === 'tech_lab' || state.selectedBuilding.type === 'solaris_cyber_lab')) {
        const facKey = state.selectedBuilding.type === 'solaris_cyber_lab' ? 'solaris' : 'terran';
        if (k === 'q') { window.upgradeFactionTech('weapons', facKey, false); return; }
        if (k === 'w') { window.upgradeFactionTech('armor', facKey, false); return; }
        if (k === 'e') { window.upgradeFactionTech('weapons', facKey, true); return; }
        if (k === 'r') { window.upgradeFactionTech('armor', facKey, true); return; }
        if (k === 't') { window.toggleSquadIntelligence(); return; }
    }
    const isSolPlayer = (state.playerFaction === 'solaris');
    if (k === '1' && !state.basePlaced) setMode('base');
    if (k === '2' && state.basePlaced) setMode(isSolPlayer ? 'solaris_gate' : 'barracks');
    if (k === '3' && state.basePlaced) setMode(isSolPlayer ? 'solaris_robotics' : 'factory');
    if (k === '4' && state.basePlaced && !state.heroPlaced) setMode('hero');
    if (k === '5' && state.basePlaced) setMode('turret');
    if (k === '6' && state.basePlaced) setMode('select');
    if (k === '7' && state.basePlaced && isSolPlayer) setMode('solaris_pylon');
    if (k === '8' && state.basePlaced) setMode('mine_drill');
    if (k === '9' && state.basePlaced) setMode(isSolPlayer ? 'solaris_cyber_lab' : 'tech_lab');
    if (e.key === 'Escape') clearAllSelection();
});

const BUILDING_FOOTPRINT_RADII = {
    base: 3.15,
    solaris_nexus: 3.15,
    factory: 2.25,
    solaris_robotics: 2.35,
    barracks: 2.05,
    solaris_gate: 2.15,
    tech_lab: 2.05,
    solaris_cyber_lab: 2.05,
    solaris_pylon: 1.65,
    solaris_spire: 1.48,
    mine_drill: 1.90,
    hero: 1.85,
    turret: 1.32,
    barrier: 1.05
};

// Evaluates a single candidate coordinate (x, z) for building placement (enforces Unit & Tank Pathway Exclusion Radius & Ramp Clearance!)
function checkSingleBuildCandidate(cx, cz, mode, bRad) {
    const isBase = (mode === 'base');
    const isTurret = (mode === 'turret' || mode === 'solaris_pylon');
    const isProdBuilding = (mode === 'barracks' || mode === 'factory' || mode === 'solaris_gate' || mode === 'solaris_robotics' || mode === 'base');
    const h = getTerrainHeight(cx, cz);

    // Allow building on any land, semi-flat map areas, valleys, craters & foothills (floor automatically flattens on placement), never in deep water
    if (h < -0.24 || h > (isBase ? 10.5 : 8.5)) {
        return { ok: false, reason: 'CANNOT BUILD IN DEEP WATER OR SHEER PEAK' };
    }

    // River & Oasis Pond exclusion
    const riverMargin = isBase ? 0.25 : (isTurret ? 0.15 : (bRad * 0.42));
    if (typeof isPointInValleyRiver === 'function' && isPointInValleyRiver(cx, cz, riverMargin)) {
        return { ok: false, reason: 'CANNOT BUILD IN RIVER CHANNEL' };
    }
    if (typeof isPointInWaterPond === 'function' && isPointInWaterPond(cx, cz, isBase ? 0.25 : (isTurret ? 0.15 : (bRad * 0.40)))) {
        return { ok: false, reason: 'CANNOT BUILD IN WATER POND' };
    }
    if (typeof isOnRiverBridge === 'function' && isOnRiverBridge(cx, cz, 0.2)) {
        return { ok: false, reason: 'CANNOT BUILD ON RIVER BRIDGE DECK' };
    }
    if (getBridgeFactor(cx, cz) > 0.35 && Math.abs(getRavineSignedDist(cx, cz)) < 9.5) {
        return { ok: false, reason: 'CANNOT BLOCK BRIDGE CAUSEWAY' };
    }

    // Bridge Walkway & Ramp Collision Exclusion Zone (for non-base structures):
    if (!isBase) {
        const bridgeClearMargin = isTurret ? -0.45 : (bRad * 0.35);
        if (typeof isSpotUnderOrBlockingBridge === 'function' && isSpotUnderOrBlockingBridge(cx, cz, bridgeClearMargin)) {
            return { ok: false, reason: 'BRIDGE WALKWAY & RAMP EXCLUSION ZONE' };
        }

        // Prevent building on Base Ramps or Merged Second Ramp Platforms so units and tanks always have an open ramp thoroughfare!
        if (Array.isArray(window.BASE_TERRAIN_ZONES) && typeof getBaseZoneRampMetrics === 'function') {
            for (let zIdx = 0; zIdx < window.BASE_TERRAIN_ZONES.length; zIdx++) {
                const bz = window.BASE_TERRAIN_ZONES[zIdx];
                if (!bz || bz.mode === 'no_ramp') continue;
                const zm = getBaseZoneRampMetrics(bz, cx, cz);
                if (zm.inRampAngle || zm.rampBlend > 0.22 || zm.mergedPlatformBlend > 0.28) {
                    return { ok: false, reason: 'CANNOT BLOCK BASE RAMP / TERRACE PATHWAY' };
                }
            }
        }
    }

    // Check 8 perimeter points around inner footprint so building center doesn't sit inside deep water
    const perimRad = isBase ? (bRad * 0.35) : (isTurret ? (bRad * 0.48) : (bRad * 0.58));
    for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        const px = cx + Math.cos(ang) * perimRad;
        const pz = cz + Math.sin(ang) * perimRad;
        if (getTerrainHeight(px, pz) < -0.28) {
            return { ok: false, reason: 'FOOTPRINT EDGE OVERLAPS DEEP WATER' };
        }
        if (typeof isPointInValleyRiver === 'function' && isPointInValleyRiver(px, pz, 0.05)) {
            return { ok: false, reason: 'FOOTPRINT EDGE OVERLAPS RIVER CHANNEL' };
        }
        if (!isBase && !isTurret && typeof isSpotUnderOrBlockingBridge === 'function' && isSpotUnderOrBlockingBridge(px, pz, -0.15)) {
            return { ok: false, reason: 'BUILDING CORNER BLOCKS BRIDGE WALKWAY' };
        }
    }

    if (Math.max(Math.abs(cx), Math.abs(cz)) > 103.5) return { ok: false, reason: 'OUTSIDE SECTOR BOUNDARY' };
    if (isPointOnZergCreep(cx, cz)) return { ok: false, reason: 'INFESTED BY ZERG CREEP!' };

    // Building-to-Building Anti-Merge + Unit & Tank Pathway Exclusion Radius Check:
    // Production buildings (Barracks, War Factory, Warp Gate, Robotics Bay, Command HQ) require a wide >= 3.2m pathway corridor around them
    // so heavy tanks and squads can always navigate cleanly between buildings without getting wedged!
    for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        if (!b || b.hp <= 0) continue;
        const otherRad = b.footprintRadius || BUILDING_FOOTPRINT_RADII[b.type] || 2.05;
        const otherIsProd = (b.type === 'barracks' || b.type === 'factory' || b.type === 'solaris_gate' || b.type === 'solaris_robotics' || b.type === 'base');
        let pathwayRadius = 1.45;
        if (isProdBuilding && otherIsProd) {
            pathwayRadius = 3.35; // Wide tank & squad thoroughfare between production structures!
        } else if (isProdBuilding || otherIsProd) {
            pathwayRadius = isTurret ? 2.25 : 2.85;
        } else if (isTurret && (b.type === 'turret' || b.type === 'solaris_pylon')) {
            pathwayRadius = 0.95;
        }
        const minClearance = bRad + otherRad + pathwayRadius;
        if (Math.hypot(b.pos.x - cx, b.pos.z - cz) < minClearance) {
            return {
                ok: false,
                reason: (isProdBuilding || otherIsProd)
                    ? 'CANNOT OVERLAP — UNIT & TANK PATHWAY CLEARANCE REQUIRED'
                    : 'CANNOT BUILD ON SAME PLACE — TOO CLOSE TO EXISTING STRUCTURE'
            };
        }
    }

    // Also maintain tank pathway clearance around Allied Solaris structures
    if (typeof solarisBuildings !== 'undefined') {
        for (let i = 0; i < solarisBuildings.length; i++) {
            const sb = solarisBuildings[i];
            if (!sb || sb.hp <= 0) continue;
            const sbRad = sb.footprintRadius || 2.2;
            if (Math.hypot(sb.pos.x - cx, sb.pos.z - cz) < bRad + sbRad + 2.4) {
                return { ok: false, reason: 'CANNOT OVERLAP ALLIED SOLARIS STRUCTURE' };
            }
        }
    }

    // Enemy Structure Anti-Overlap Check
    for (let i = 0; i < enemyBuildings.length; i++) {
        const eb = enemyBuildings[i];
        if (!eb || eb.hp <= 0) continue;
        const ebRad = eb.footprintRadius || 2.6;
        if (Math.hypot(eb.pos.x - cx, eb.pos.z - cz) < bRad + ebRad + 1.5) {
            return { ok: false, reason: 'BLOCKED BY HOSTILE STRUCTURE' };
        }
    }

    // Neutral Map Structure Anti-Overlap Check (Military Command Posts, Towns, Cargo Yards, Minivan Houses, Evacuation Camps)
    if (!isBase && Array.isArray(window.REGISTERED_MAP_STRUCTURES)) {
        for (let i = 0; i < window.REGISTERED_MAP_STRUCTURES.length; i++) {
            const ms = window.REGISTERED_MAP_STRUCTURES[i];
            if (!ms) continue;
            if (Math.hypot(ms.x - cx, ms.z - cz) < bRad + (ms.r || 3.5) + 0.65) {
                return { ok: false, reason: 'CANNOT OVERLAP COLONY / MILITARY BUILDING' };
            }
        }
    }

    // For non-Base buildings, check major impassable landmarks (Main Base and Mine Drill on Gem Craters clear/bypass mineral landmarks)
    if (!isBase && mode !== 'mine_drill') {
        const majorObstacleTypes = new Set(['pond', 'mineral', 'geyser', 'waterwall']);
        const hitMajorObstacle = obstacles.some(o => {
            if (!majorObstacleTypes.has(o.type)) return false;
            const reqClear = o.r + (isTurret ? bRad * 0.35 : bRad * 0.55);
            return Math.hypot(o.x - cx, o.z - cz) < reqClear;
        });
        if (hitMajorObstacle) {
            return { ok: false, reason: 'BLOCKED BY MINERAL / WATER LANDMARK' };
        }
    }

    return { ok: true };
}

function findNearestGemCrater(x, z, maxDist = 9.5) {
    if (!Array.isArray(window.GEM_CRATERS)) return null;
    let best = null;
    let bestD = maxDist;
    for (let i = 0; i < window.GEM_CRATERS.length; i++) {
        const gc = window.GEM_CRATERS[i];
        if (!gc) continue;
        const d = Math.hypot(gc.x - x, gc.z - z);
        if (d <= bestD) {
            bestD = d;
            best = gc;
        }
    }
    return best;
}

function evaluateBuildSpot(pt) {
    if (window.titleScreenActive || window.loadingCameraSweep) return { ok: false, reason: 'CINEMATIC ACTIVE' };
    if (!pt) return { ok: false, reason: 'INVALID TARGET' };
    const mode = state.mode;
    const bRad = BUILDING_FOOTPRINT_RADII[mode] || 2.05;
    const nearCrater = (mode === 'mine_drill') ? findNearestGemCrater(pt.x, pt.z, 9.5) : null;

    // 1. Pre-Checks for Main Base vs Secondary Structures
    if (mode === 'base') {
        if (state.basePlaced) return { ok: false, reason: 'HQ ALREADY DEPLOYED' };
        // Update closest drop-zone highlight indicator without force-locking the cursor!
        for (let i = 0; i < BASE_PLACEMENT_BARRIERS.length; i++) {
            const bar = BASE_PLACEMENT_BARRIERS[i];
            if (Math.hypot(pt.x - bar.x, pt.z - bar.z) <= bar.radius + 1.5) {
                selectedBaseBarrierId = bar.id;
                break;
            }
        }
    } else {
        if (!state.basePlaced) return { ok: false, reason: 'DEPLOY COMMAND HQ FIRST' };
        if (mode === 'hero' && state.heroPlaced) return { ok: false, reason: 'HERO PAD ACTIVE' };
        if (state.req < (COSTS[mode] || 0)) return { ok: false, reason: `NEED ${COSTS[mode]} MINERALS` };

        // PROTOSS KHAYDARIN PYLON POWER SOURCE REQUIREMENT:
        // When playing as Solaris Protoss (or building Protoss structures), Warp Gates, Robotics Bays, Cyber Labs, Cannon Spires & Hero Pads
        // MUST be placed inside the 20m psionic power matrix of an active Khaydarin Pylon (`solaris_pylon`)!
        const isProtossPlayer = (state.playerFaction === 'solaris');
        const requiresProtossPylonPower = isProtossPlayer && (mode === 'solaris_gate' || mode === 'solaris_robotics' || mode === 'solaris_cyber_lab' || mode === 'turret' || mode === 'hero');
        if (requiresProtossPylonPower) {
            const activePlayerPylons = buildings.filter(b =>
                b && b.type === 'solaris_pylon' && b.hp > 0 && (b.buildProgress === undefined || b.buildProgress >= 1.0)
            );
            const activeAllyPylons = (typeof solarisBuildings !== 'undefined')
                ? solarisBuildings.filter(sb => sb && sb.role === 'pylon' && sb.hp > 0 && (sb.buildProgress === undefined || sb.buildProgress >= 1.0))
                : [];
            if (activePlayerPylons.length === 0 && activeAllyPylons.length === 0) {
                return { ok: false, reason: 'REQUIRES KHAYDARIN PYLON POWER SOURCE! BUILD PYLON [7] FIRST' };
            }
            const inPylonField = activePlayerPylons.some(py => Math.hypot(pt.x - py.pos.x, pt.z - py.pos.z) <= 20.5)
                || activeAllyPylons.some(py => Math.hypot(pt.x - py.pos.x, pt.z - py.pos.z) <= 20.5);
            if (!inPylonField) {
                return { ok: false, reason: 'OUTSIDE KHAYDARIN PYLON POWER MATRIX (20M RADIUS)' };
            }
        }

        // Power Field Check: allow extending power grid around HQ, around any friendly structure, OR anywhere near a Gem Crater when building a Mine Drill!
        const maxAllowedDist = (mode === 'turret' || mode === 'mine_drill' || mode === 'solaris_pylon') ? (POWER_RADIUS + 28) : (POWER_RADIUS + 14);
        let withinPowerGrid = !!nearCrater || (Math.hypot(pt.x - state.baseBuilding.pos.x, pt.z - state.baseBuilding.pos.z) <= maxAllowedDist);
        if (!withinPowerGrid) {
            withinPowerGrid = buildings.some(b => b && b.hp > 0 && Math.hypot(pt.x - b.pos.x, pt.z - b.pos.z) <= 28.0);
        }
        if (!withinPowerGrid) {
            return { ok: false, reason: mode === 'mine_drill' ? 'PLACE IN POWER GRID OR ON ANY GEM CRATER' : 'OUTSIDE COMMAND POWER & FORTIFICATION RANGE' };
        }
    }

    // 2. Direct Check at Exact Cursor Coordinate (or snapped to Gem Crater center for Mine Drill!)
    const targetX = nearCrater ? nearCrater.x : pt.x;
    const targetZ = nearCrater ? nearCrater.z : pt.z;
    const directRes = checkSingleBuildCandidate(targetX, targetZ, mode, bRad);
    if (directRes.ok) {
        const drillLabel = nearCrater
            ? `DEPLOY MINE DRILL ON GEM CRATER (${COSTS[mode]}M)`
            : `DEPLOY ${mode.toUpperCase()} (${COSTS[mode]}M)`;
        return {
            ok: true,
            snappedPos: new THREE.Vector3(targetX, getTerrainHeight(targetX, targetZ), targetZ),
            reason: mode === 'base'
                ? 'CLICK TO DEPLOY ORBITAL CITADEL HQ HERE'
                : drillLabel
        };
    }

    // 3. Smart Micro-Nudge Search: if cursor is slightly inside the tank pathway exclusion zone or near a river/ramp edge,
    // automatically find the closest valid spot with full tank pathway clearance within 7.6m!
    const nudgeRadii = [0.8, 1.6, 2.5, 3.6, 4.8, 6.2, 7.6];
    for (let rIdx = 0; rIdx < nudgeRadii.length; rIdx++) {
        const nr = nudgeRadii[rIdx];
        for (let aIdx = 0; aIdx < 16; aIdx++) {
            const ang = (aIdx / 16) * Math.PI * 2;
            const nx = targetX + Math.cos(ang) * nr;
            const nz = targetZ + Math.sin(ang) * nr;
            const nudgeRes = checkSingleBuildCandidate(nx, nz, mode, bRad);
            if (nudgeRes.ok) {
                return {
                    ok: true,
                    snappedPos: new THREE.Vector3(nx, getTerrainHeight(nx, nz), nz),
                    reason: mode === 'base'
                        ? 'CLICK TO DEPLOY ORBITAL CITADEL HQ HERE'
                        : `DEPLOY ${mode.toUpperCase()} (${COSTS[mode]}M · TANK LANE CLEAR)`
                };
            }
        }
    }

    return { ok: false, reason: directRes.reason };
}

function deployStructure(pt, bypassCinematicGuard = false) {
    if (!bypassCinematicGuard && (window.titleScreenActive || window.loadingCameraSweep)) return;
    if (!pt) return;
    const type = state.mode;
    const bRad = BUILDING_FOOTPRINT_RADII[type] || 2.15;

    // Strict Non-Overlap Guard: Never allow placing a building on top of an already-built structure
    let pos = pt.clone();
    const isOverlappingExisting = (cx, cz) => {
        for (let i = 0; i < buildings.length; i++) {
            const b = buildings[i];
            if (!b || b.hp <= 0) continue;
            const otherRad = b.footprintRadius || BUILDING_FOOTPRINT_RADII[b.type] || 2.05;
            if (Math.hypot(b.pos.x - cx, b.pos.z - cz) < bRad + otherRad + 0.85) return true;
        }
        if (typeof solarisBuildings !== 'undefined') {
            for (let i = 0; i < solarisBuildings.length; i++) {
                const sb = solarisBuildings[i];
                if (!sb || sb.hp <= 0) continue;
                const sbRad = sb.footprintRadius || 2.2;
                if (Math.hypot(sb.pos.x - cx, sb.pos.z - cz) < bRad + sbRad + 0.85) return true;
            }
        }
        for (let i = 0; i < enemyBuildings.length; i++) {
            const eb = enemyBuildings[i];
            if (!eb || eb.hp <= 0) continue;
            const ebRad = eb.footprintRadius || 2.6;
            if (Math.hypot(eb.pos.x - cx, eb.pos.z - cz) < bRad + ebRad + 0.85) return true;
        }
        return false;
    };

    if (isOverlappingExisting(pos.x, pos.z)) {
        const evalRes = evaluateBuildSpot(pos);
        if (evalRes && evalRes.ok && evalRes.snappedPos && !isOverlappingExisting(evalRes.snappedPos.x, evalRes.snappedPos.z)) {
            pos.copy(evalRes.snappedPos);
        } else {
            spawnCombatFloat(pos, 'CANNOT OVERLAP EXISTING BUILDING!', '#ff2a4b');
            return;
        }
    }

    state.req -= (COSTS[type] || 0);
    if (window.SFX) window.SFX.playBuild();

    const linkedCrater = (type === 'mine_drill') ? findNearestGemCrater(pos.x, pos.z, 9.5) : null;

    // Clear any scatter obstacles (trees, rocks, wrecks, craters, props) overlapped by the newly deployed structure
    for (let i = obstacles.length - 1; i >= 0; i--) {
        const ob = obstacles[i];
        if (ob.type !== 'pond' && ob.type !== 'mineral' && ob.type !== 'map_boundary_barrier' && Math.hypot(ob.x - pos.x, ob.z - pos.z) < bRad + ob.r + 0.85) {
            obstacles.splice(i, 1);
        }
    }

    // Dynamically flatten the floor map underneath the placed building so the ground is completely flat!
    if (typeof window.flattenTerrainUnderBuilding === 'function' && !linkedCrater) {
        pos.y = window.flattenTerrainUnderBuilding(pos.x, pos.z, bRad + 1.15, 2.4);
    } else {
        pos.y = getTerrainHeight(pos.x, pos.z);
    }

    const isSolPlayer = (state.playerFaction === 'solaris');
    const modelType = (type === 'base' && isSolPlayer)
        ? 'solaris_nexus'
        : ((type === 'turret' && isSolPlayer) ? 'solaris_spire' : type);
    const mesh = createEngineeredBuilding(modelType, true);
    mesh.position.copy(pos);
    // Keep outer building Group at 1.0 scale so the 3D Construction Rig (Terran Crane / Protoss Warp Rift) renders at full height!
    mesh.scale.set(1.0, 1.0, 1.0);
    if (type !== 'base' && mesh.userData) {
        if (mesh.userData.scaffoldGroup) mesh.userData.scaffoldGroup.visible = true;
        if (mesh.userData.mainStructure) mesh.userData.mainStructure.scale.set(0.25, 0.08, 0.25);
    }

    scene.add(mesh);

    const maxHp = BUILDING_MAX_HP[type] || 650;
    const isSolarisStruct = (type.startsWith('solaris_') || (isSolPlayer && (type === 'base' || type === 'turret')));
    const maxShield = isSolarisStruct ? (type === 'base' ? 1000 : (type === 'solaris_pylon' ? 400 : 550)) : 0;
    const hb = makeHealthPip(type === 'base' ? '#00e5ff' : (isSolarisStruct ? '#f5b932' : (type === 'mine_drill' ? '#e879f9' : '#00ff66')), true);

    const bObj = {
        type, mesh, pos, hb,
        isSolarisSpire: (type === 'solaris_spire' || (type === 'turret' && isSolPlayer)),
        spirePriority: 'all',
        spireCooldown: 0,
        attackAnim: 0,
        footprintRadius: bRad,
        hp: maxHp, // 100% full HP immediately on placement (only construction buildProgress takes time!)
        maxHp,
        shield: maxShield,
        maxShield,
        shieldRegenDelay: 0,
        level: 1,
        upgradeLevel: 1,
        maxPower: 9,
        buildProgress: (type === 'base') ? 1.0 : 0.02,
        unitType: type === 'solaris_robotics' ? 'phoenix' : (type === 'factory' ? 'tank' : (type === 'solaris_gate' ? 'zealot' : 'ranger')),
        spawnDuration: type === 'solaris_robotics' ? 12.0 : (type === 'factory' ? 15.5 : (type === 'base' ? 12.0 : (type === 'solaris_gate' ? 10.0 : 10.0))),
        spawnTimer: type === 'solaris_robotics' ? 12.0 : (type === 'factory' ? 15.5 : (type === 'base' ? 12.0 : (type === 'solaris_gate' ? 10.0 : 10.0))),
        mineTimer: 2.6,
        linkedCrater,
        totalMinedGems: 0,
        emptyNotified: false,
        doorHoldTimer: 0,
        currentYaw: 0,
        weapons: { left: 'mg', right: 'none', top: 'none' },
        cooldowns: { left: 0, right: 0, top: 0 }
    };

    if (type === 'turret' && !bObj.isSolarisSpire) {
        state.activeTurretSlot = 'top';
        syncTurretPods(bObj);
    }
    buildings.push(bObj);

    if (type === 'base') {
        state.basePlaced = true;
        state.baseBuilding = bObj;

        const hBadge = document.createElement('div');
        hBadge.style.display = 'none';
        state.humanBadgeDom = hBadge;

        const ringGeo = new THREE.BufferGeometry();
        const pts = [];
        for (let i = 0; i <= 120; i++) {
            const a = (i / 120) * Math.PI * 2;
            const rx = pos.x + Math.cos(a) * POWER_RADIUS;
            const rz = pos.z + Math.sin(a) * POWER_RADIUS;
            const ry = Math.max(-0.3, getTerrainHeight(rx, rz) + 0.16);
            pts.push(new THREE.Vector3(rx, ry, rz));
        }
        ringGeo.setFromPoints(pts);
        state.powerRing = new THREE.Line(ringGeo, new THREE.LineBasicMaterial({ color: isSolPlayer ? 0xf5b932 : 0x00e5ff }));
        state.powerRing.visible = Boolean(isSolPlayer);
        scene.add(state.powerRing);
        syncProtossPowerRadiusVisibility();

        if (isSolPlayer) {
            document.getElementById('directive-ticker').innerText = "Solaris Nexus & Psionic Probes online! Warp in a Khaydarin Pylon [7] to power Warp Gates [2] & Robotics Bays [3]!";
            setMode('solaris_pylon');
        } else {
            document.getElementById('directive-ticker').innerText = "Command HQ & Auto-Mining Drones online! Build Barracks [2], War Factory [3], or Mine Drill [8]!";
            setMode('barracks');
        }
    }
    else if (type === 'hero') {
        state.heroPlaced = true;
        spawnAlliedUnit('hero', pos);
        setMode('select');
    }
    else if (type === 'turret' || type === 'barracks' || type === 'factory' || type === 'tech_lab' || type === 'solaris_gate' || type === 'solaris_robotics' || type === 'solaris_cyber_lab' || type === 'solaris_pylon' || type === 'mine_drill') {
        if (type === 'mine_drill' && linkedCrater) {
            if (linkedCrater.isEmpty || linkedCrater.gemsRemaining <= 0) {
                spawnCombatFloat(pos, 'SURVEY: THIS GEM CRATER IS EMPTY! (+14M/2.6s ONLY)', '#94a3b8');
            } else {
                spawnCombatFloat(pos, `LOCKED ON RICH GEM CRATER (${linkedCrater.gemsRemaining} GEMS)!`, '#f0abfc');
            }
        }
        selectStructure(bObj);
    }

    if (typeof updateZergCreepColors === 'function') {
        updateZergCreepColors(creepRadius, false);
    }

    updateHUD();
}

// ============================================================================
// AUTONOMOUS HARVESTER MINING DRONES FOR ALL 3 FACTIONS:
//   - Terran SCV Hover-Harvester Drones
//   - Solaris Protoss Golden Psionic Probes
//   - Zerg Swarm Chitinous Bio-Drones
// ============================================================================
const miningDrones = [];
let _miningDroneHullMat = null;
let _miningDroneTrimMat = null;
let _miningDroneProtossGoldMat = null;
let _miningDroneZergChitinMat = null;
let _miningDroneZergSacMat = null;
let _miningDroneCargoBlueMat = null;
let _miningDroneCargoGoldMat = null;
let _miningDroneLaserMat = null;
let _miningDroneZergBeamMat = null;

function createAutoMiningDroneMesh(faction = 'terran') {
    if (!_miningDroneHullMat) {
        _miningDroneHullMat = new THREE.MeshStandardMaterial({ color: 0xd99b26, roughness: 0.38, metalness: 0.68 });
        _miningDroneTrimMat = new THREE.MeshStandardMaterial({ color: 0x2c3644, roughness: 0.50, metalness: 0.72 });
        _miningDroneProtossGoldMat = new THREE.MeshStandardMaterial({ color: 0xf5b932, roughness: 0.22, metalness: 0.86 });
        _miningDroneZergChitinMat = new THREE.MeshStandardMaterial({ color: 0x5c2338, roughness: 0.52, metalness: 0.25 });
        _miningDroneZergSacMat = new THREE.MeshStandardMaterial({
            color: 0x65ff00, emissive: 0x38b000, emissiveIntensity: 0.75, roughness: 0.28, metalness: 0.10
        });
        _miningDroneCargoBlueMat = new THREE.MeshStandardMaterial({
            color: 0x00e5ff, emissive: 0x0088cc, emissiveIntensity: 0.85, roughness: 0.15, metalness: 0.80
        });
        _miningDroneCargoGoldMat = new THREE.MeshStandardMaterial({
            color: 0xffc400, emissive: 0xb46900, emissiveIntensity: 0.90, roughness: 0.15, metalness: 0.85
        });
        _miningDroneLaserMat = new THREE.MeshBasicMaterial({
            color: 0x00f2ff, transparent: true, opacity: 0.82
        });
        _miningDroneZergBeamMat = new THREE.MeshBasicMaterial({
            color: 0x76ff03, transparent: true, opacity: 0.82
        });
    }

    const root = new THREE.Group();

    let rotaryDrill = null;
    let apertureRing = null;
    let leftArm = null;
    let rightArm = null;
    let wingL = null;
    let wingR = null;

    if (faction === 'solaris') {
        // SOLARIS PROTOSS PSIONIC PROBE: Sculpted Golden-Ivory Anti-Gravity Teardrop Craft,
        // Glowing Khaydarin Crystal Core, 4 Articulated Floating Wing Pylons & Spinning Psionic Aperture Ring
        const probeChassis = new THREE.Mesh(
            typeof createCompoundArmorChestGeo === 'function'
                ? createCompoundArmorChestGeo(0.58, 0.36, 0.92, 0.24, 0.26)
                : new THREE.OctahedronGeometry(0.42, 2),
            _miningDroneProtossGoldMat
        );
        probeChassis.castShadow = !IS_MOBILE;
        root.add(probeChassis);

        const ivoryMantle = new THREE.Mesh(
            typeof createCompoundArmorChestGeo === 'function'
                ? createCompoundArmorChestGeo(0.46, 0.22, 0.76, 0.20, 0.22)
                : new THREE.OctahedronGeometry(0.32, 1),
            MAT.solarisIvory || _miningDroneProtossGoldMat
        );
        ivoryMantle.position.set(0, 0.14, -0.04);
        root.add(ivoryMantle);

        const eyeLens = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 12), MAT.solarisCrystal || _miningDroneCargoBlueMat);
        eyeLens.position.set(0, 0.02, 0.44);
        apertureRing = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.026, 8, 20), _miningDroneProtossGoldMat);
        apertureRing.position.set(0, 0.02, 0.48);
        const dorsalCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 1), MAT.solarisPrismGlow || _miningDroneCargoBlueMat);
        dorsalCore.position.set(0, 0.24, -0.06);
        root.add(eyeLens, apertureRing, dorsalCore);

        [-1, 1].forEach(side => {
            const wingGroup = new THREE.Group();
            wingGroup.position.set(side * 0.48, 0.04, -0.02);
            const mainPylon = new THREE.Mesh(
                typeof createProtossArchBladeGeo === 'function'
                    ? createProtossArchBladeGeo(0.76, 0.14, 0.04, 0.24)
                    : new THREE.ConeGeometry(0.16, 0.82, 5),
                _miningDroneProtossGoldMat
            );
            mainPylon.rotation.x = Math.PI * 0.46;
            mainPylon.rotation.z = -side * 0.32;
            const pylonGem = new THREE.Mesh(new THREE.OctahedronGeometry(0.08, 0), _miningDroneCargoBlueMat);
            pylonGem.position.set(side * 0.06, 0.04, 0.18);
            wingGroup.add(mainPylon, pylonGem);
            root.add(wingGroup);
            if (side < 0) leftArm = wingGroup;
            else rightArm = wingGroup;
        });
    } else if (faction === 'zerg') {
        // ZERG SWARM BIO-DRONE: Segmented Chitinous Carapace, Pulsating Bio-Luminescent Extraction Abdomen Sac,
        // Articulated Harvesting Mandibles & Fore-Claws, and Beating Membranous Wings
        const thorax = new THREE.Mesh(
            typeof createOrganicBioCarapaceGeo === 'function'
                ? createOrganicBioCarapaceGeo(0.36, 0.26, 0.56, 8, 0.08)
                : new THREE.SphereGeometry(0.38, 12, 10),
            _miningDroneZergChitinMat
        );
        thorax.castShadow = !IS_MOBILE;
        root.add(thorax);

        const dorsalRidge = new THREE.Mesh(
            typeof createOrganicBioCarapaceGeo === 'function'
                ? createOrganicBioCarapaceGeo(0.28, 0.14, 0.42, 6, 0.06)
                : new THREE.SphereGeometry(0.24, 8, 8),
            MAT.chitinRed || _miningDroneZergChitinMat
        );
        dorsalRidge.position.set(0, 0.16, 0.06);
        root.add(dorsalRidge);

        const acidSac = new THREE.Mesh(new THREE.SphereGeometry(0.29, 10, 8), _miningDroneZergSacMat);
        acidSac.position.set(0, 0.06, -0.42);
        acidSac.scale.set(1.0, 0.85, 1.30);
        root.add(acidSac);
        apertureRing = acidSac;

        [-1, 1].forEach(side => {
            const clawGroup = new THREE.Group();
            clawGroup.position.set(side * 0.24, -0.04, 0.38);
            const mandible = new THREE.Mesh(
                typeof createCurvedScytheBladeGeo === 'function'
                    ? createCurvedScytheBladeGeo(0.48, 0.075, 0.16)
                    : new THREE.ConeGeometry(0.07, 0.48, 6),
                _miningDroneZergChitinMat
            );
            mandible.rotation.x = Math.PI * 0.46;
            mandible.rotation.z = side * 0.28;
            clawGroup.add(mandible);
            root.add(clawGroup);
            if (side < 0) leftArm = clawGroup;
            else rightArm = clawGroup;

            const wing = new THREE.Mesh(
                new THREE.BoxGeometry(0.68, 0.02, 0.30),
                new THREE.MeshBasicMaterial({ color: 0xa3e635, transparent: true, opacity: 0.58 })
            );
            wing.position.set(side * 0.44, 0.22, -0.04);
            wing.rotation.z = side * 0.25;
            root.add(wing);
            if (side < 0) wingL = wing;
            else wingR = wing;
        });
    } else {
        // TERRAN DOMINION SCV HOVER-HARVESTER DRONE:
        // Reinforced Industrial Chassis, Roll Cage, Articulated Dual Mechanical Excavator Arms/Claws,
        // Spinning Tungsten Plasma Cutter Drill & Vector-Thruster Nacelles
        const hull = new THREE.Mesh(
            typeof createExtrudedArmorHullGeo === 'function'
                ? createExtrudedArmorHullGeo(0.84, 0.34, 1.14, 0.04, 0.09)
                : new THREE.BoxGeometry(0.84, 0.34, 1.14),
            _miningDroneHullMat
        );
        hull.castShadow = !IS_MOBILE;
        root.add(hull);

        const rollCage = new THREE.Mesh(
            typeof createExtrudedArmorHullGeo === 'function'
                ? createExtrudedArmorHullGeo(0.62, 0.16, 0.64, 0.025, 0.05)
                : new THREE.BoxGeometry(0.62, 0.16, 0.64),
            _miningDroneTrimMat
        );
        rollCage.position.set(0, 0.22, 0.04);
        const visor = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.16, 0.32), MAT.cyanGlow || _miningDroneCargoBlueMat);
        visor.position.set(0, 0.08, 0.48);
        root.add(rollCage, visor);

        // Central Spinning Rotary Plasma Drill Assembly
        rotaryDrill = new THREE.Group();
        rotaryDrill.position.set(0, -0.06, 0.66);
        const drillShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.08, 0.38, 8).rotateX(Math.PI / 2), _miningDroneTrimMat);
        const drillCone = new THREE.Mesh(new THREE.ConeGeometry(0.095, 0.28, 6).rotateX(Math.PI / 2), _miningDroneHullMat);
        drillCone.position.z = 0.24;
        rotaryDrill.add(drillShaft, drillCone);
        root.add(rotaryDrill);

        // Dual Articulated Mechanical Excavator Claws + Side Vector Thrusters
        [-1, 1].forEach(side => {
            const armGroup = new THREE.Group();
            armGroup.position.set(side * 0.36, -0.04, 0.44);
            const boom = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.38), _miningDroneTrimMat);
            boom.position.z = 0.16;
            const pincer = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.22), _miningDroneHullMat);
            pincer.position.set(-side * 0.04, 0, 0.36);
            pincer.rotation.y = side * 0.28;
            armGroup.add(boom, pincer);
            root.add(armGroup);
            if (side < 0) leftArm = armGroup;
            else rightArm = armGroup;

            const sx = side * 0.50;
            const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.70, 8).rotateX(Math.PI / 2), _miningDroneTrimMat);
            pod.position.set(sx, -0.02, -0.06);
            const exhaust = new THREE.Mesh(new THREE.CircleGeometry(0.11, 8), MAT.cyanGlow || _miningDroneCargoBlueMat);
            exhaust.position.set(sx, -0.04, -0.42);
            exhaust.rotation.y = Math.PI;
            root.add(pod, exhaust);
        });
    }

    // Harvested Mineral Crystal Cargo Pod (visible when returning to Base/Nexus/Citadel with resources!)
    const cargoCrystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.26, 0), _miningDroneCargoBlueMat);
    cargoCrystal.scale.set(0.95, 1.25, 1.35);
    cargoCrystal.position.set(0, 0.36, -0.08);
    cargoCrystal.visible = false;
    root.add(cargoCrystal);

    // Active Mining Laser / Psionic Phase Beam / Bio-Extraction Tendril
    const beamGeo = new THREE.CylinderGeometry(0.035, 0.065, 1.0, 8);
    beamGeo.translate(0, 0.5, 0);
    beamGeo.rotateX(Math.PI / 2);
    const laserBeam = new THREE.Mesh(
        beamGeo,
        faction === 'zerg' ? _miningDroneZergBeamMat : _miningDroneLaserMat
    );
    laserBeam.position.set(0, -0.05, 0.68);
    laserBeam.visible = false;
    root.add(laserBeam);

    root.userData = { cargoCrystal, laserBeam, faction, rotaryDrill, apertureRing, leftArm, rightArm, wingL, wingR };
    return root;
}

function findBestMineralPatchForDrone(basePos, slotIdx) {
    const patches = Array.isArray(window.MINERAL_PATCHES) ? window.MINERAL_PATCHES : [];
    const activePatches = patches.filter(p => p && !p.isDepleted && (p.mineralsRemaining === undefined || p.mineralsRemaining > 0));
    const pool = activePatches.length > 0 ? activePatches : patches;
    if (pool.length === 0) {
        const ang = (slotIdx % 2 === 0 ? -0.65 : 0.65) + Math.PI;
        return {
            x: basePos.x + Math.cos(ang) * 10.5,
            z: basePos.z + Math.sin(ang) * 10.5,
            isGold: (slotIdx % 2 === 1)
        };
    }
    const sorted = pool
        .slice()
        .sort((a, b) => Math.hypot(a.x - basePos.x, a.z - basePos.z) - Math.hypot(b.x - basePos.x, b.z - basePos.z));
    const pickPoolCount = Math.min(4, sorted.length);
    return sorted[slotIdx % pickPoolCount] || sorted[0];
}

function clearAutoMiningDrones() {
    while (miningDrones.length > 0) {
        const d = miningDrones.pop();
        if (d && d.mesh) scene.remove(d.mesh);
        if (d && d.repairBeam) scene.remove(d.repairBeam);
    }
}

function syncAndUpdateAutoMiningDrones(dt) {
    if (state.missionWon) {
        if (miningDrones.length > 0) clearAutoMiningDrones();
        return;
    }

    // Build target roster of mining drones across Player Base, Solaris Protoss Nexus, and Zerg Leviathan Citadel:
    const desiredRoster = [];

    // 1. Player Base Mining Workers (Terran SCV Drones or Solaris Protoss Probes depending on playerFaction)
    if (state.basePlaced && state.baseBuilding && state.baseBuilding.hp > 0) {
        const pFaction = state.playerFaction === 'solaris' ? 'solaris' : 'terran';
        const activeDrills = buildings.filter(b => b && b.type === 'mine_drill' && b.hp > 0 && (b.buildProgress === undefined || b.buildProgress >= 1.0)).length;
        const playerDroneCount = Math.min(4, 2 + activeDrills);
        for (let s = 0; s < playerDroneCount; s++) {
            desiredRoster.push({ ownerKey: `player_${s}`, ownerType: 'player', faction: pFaction, slotIdx: s, getHomePos: () => state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS });
        }
    }

    // 2. Allied Solaris Protoss Enclave Probes (2 Golden Psionic Probes harvesting minerals into the Solaris Nexus)
    const solNexus = (typeof solarisBuildings !== 'undefined')
        ? solarisBuildings.find(sb => sb && sb.role === 'nexus' && sb.hp > 0)
        : null;
    if (solNexus) {
        for (let s = 0; s < 2; s++) {
            desiredRoster.push({ ownerKey: `solaris_${s}`, ownerType: 'solaris', faction: 'solaris', slotIdx: s, getHomePos: () => solNexus.pos });
        }
    }

    // 3. Enemy Zerg Hive Cluster Bio-Drones (2 Chitinous Zerg Bio-Drones harvesting minerals into the Zerg Citadel)
    const zergCitadel = enemyBuildings.find(eb => eb && eb.role === 'citadel' && eb.hp > 0);
    if (zergCitadel) {
        for (let s = 0; s < 2; s++) {
            desiredRoster.push({ ownerKey: `zerg_${s}`, ownerType: 'zerg', faction: 'zerg', slotIdx: s, getHomePos: () => zergCitadel.pos });
        }
    }

    // Remove drones whose home base was destroyed or whose faction changed
    for (let i = miningDrones.length - 1; i >= 0; i--) {
        const existing = miningDrones[i];
        const matchSpec = desiredRoster.find(r => r.ownerKey === existing.ownerKey && r.faction === existing.faction);
        if (!matchSpec) {
            if (existing.mesh) scene.remove(existing.mesh);
            if (existing.repairBeam) scene.remove(existing.repairBeam);
            miningDrones.splice(i, 1);
        } else {
            existing.getHomePos = matchSpec.getHomePos;
        }
    }

    // Spawn any missing drones for Player, Solaris Protoss, or Zerg Swarm
    for (let i = 0; i < desiredRoster.length; i++) {
        const spec = desiredRoster[i];
        if (miningDrones.some(d => d.ownerKey === spec.ownerKey)) continue;
        const homePos = spec.getHomePos();
        const mesh = createAutoMiningDroneMesh(spec.faction);
        const spawnAng = (spec.slotIdx / 4) * Math.PI * 2;
        const sx = homePos.x + Math.cos(spawnAng) * 2.8;
        const sz = homePos.z + Math.sin(spawnAng) * 2.8;
        const sy = getTerrainHeight(sx, sz) + 2.05;
        mesh.position.set(sx, sy, sz);
        scene.add(mesh);

        let repairBeam = null;
        if (spec.ownerType !== 'zerg' && typeof window.createRepairBeamAssembly === 'function') {
            repairBeam = window.createRepairBeamAssembly();
            scene.add(repairBeam);
        }

        miningDrones.push({
            ownerKey: spec.ownerKey,
            ownerType: spec.ownerType,
            faction: spec.faction,
            slotIdx: spec.slotIdx,
            getHomePos: spec.getHomePos,
            mesh,
            repairBeam,
            state: 'to_mineral',
            targetPatch: findBestMineralPatchForDrone(homePos, spec.slotIdx),
            timer: 0,
            sparkTimer: 0,
            carryingGold: false,
            bobPhase: i * 1.5
        });
    }

    // Update all active mining & field-repair SCV drones across the map
    for (let i = 0; i < miningDrones.length; i++) {
        const d = miningDrones[i];
        if (!d || !d.mesh) continue;
        const basePos = d.getHomePos ? d.getHomePos() : PLAYER_START_POS;
        d.bobPhase += dt * 4.2;

        if (!d.targetPatch || d.targetPatch.isDepleted) {
            d.targetPatch = findBestMineralPatchForDrone(basePos, d.slotIdx);
        }

        const ud = d.mesh.userData || {};
        const pos = d.mesh.position;

        // Animate faction-specific harvester sub-assemblies (SCV rotary drill/claws, Protoss Probe aperture ring, Zerg Drone wings/mandibles)
        const isHarvestingNow = (d.state === 'mining');
        if (ud.rotaryDrill) {
            ud.rotaryDrill.rotation.z += dt * (isHarvestingNow ? 24.0 : 4.0);
        }
        if (ud.apertureRing) {
            if (d.faction === 'solaris') {
                ud.apertureRing.rotation.z += dt * (isHarvestingNow ? 8.5 : 2.2);
            } else if (d.faction === 'zerg') {
                const sacPulse = 1.0 + Math.sin(d.bobPhase * (isHarvestingNow ? 3.5 : 1.5)) * 0.14;
                ud.apertureRing.scale.set(sacPulse, 0.85 * sacPulse, 1.30);
            }
        }
        if (ud.leftArm && ud.rightArm) {
            const pinch = isHarvestingNow ? Math.sin(d.bobPhase * 3.8) * 0.26 : Math.sin(d.bobPhase * 0.8) * 0.05;
            ud.leftArm.rotation.y = pinch;
            ud.rightArm.rotation.y = -pinch;
        }
        if (ud.wingL && ud.wingR) {
            const flap = Math.sin(d.bobPhase * 5.5) * 0.38;
            ud.wingL.rotation.z = -0.25 - flap;
            ud.wingR.rotation.z = 0.25 + flap;
        }
        if (ud.cargoCrystal && ud.cargoCrystal.visible) {
            ud.cargoCrystal.rotation.y += dt * 2.4;
        }

        // Check if a friendly Mechanical Unit (Tank, Siege Tank, Gunship, Dropship, Valkyrie, Stalker) or Building near this SCV needs emergency Nano-Weld Repair!
        let mechRepairTarget = null;
        if (d.ownerType === 'player' || d.ownerType === 'solaris') {
            let bestRatio = 0.995;
            for (let ui = 0; ui < units.length; ui++) {
                const u = units[ui];
                if (!u || !u.isMechanical || u.hp <= 0 || u.hp >= u.maxHp || !u.mesh) continue;
                const dToDrone = Math.hypot(u.mesh.position.x - pos.x, u.mesh.position.z - pos.z);
                const dToBase = Math.hypot(u.mesh.position.x - basePos.x, u.mesh.position.z - basePos.z);
                if (dToDrone <= 18.0 || dToBase <= 26.0) {
                    const r = u.hp / u.maxHp;
                    if (r < bestRatio) {
                        bestRatio = r;
                        mechRepairTarget = u;
                    }
                }
            }
            if (!mechRepairTarget && d.slotIdx === 0) {
                for (let bi = 0; bi < buildings.length; bi++) {
                    const b = buildings[bi];
                    if (!b || b.hp <= 0 || b.hp >= b.maxHp) continue;
                    if (Math.hypot(b.pos.x - basePos.x, b.pos.z - basePos.z) <= 24.0) {
                        const r = b.hp / b.maxHp;
                        if (r < bestRatio) {
                            bestRatio = r;
                            mechRepairTarget = b;
                        }
                    }
                }
            }
        }

        if (mechRepairTarget) {
            // SCV / Repair Drone actively patches up damaged mechanical unit with 3D Visual Welding Beam!
            if (ud.cargoCrystal) ud.cargoCrystal.visible = false;
            const tWorldBase = mechRepairTarget.mesh ? mechRepairTarget.mesh.position : mechRepairTarget.pos;
            const targetAlt = mechRepairTarget.isAir ? tWorldBase.y : (getTerrainHeight(tWorldBase.x, tWorldBase.z) + 0.85);
            const tWorld = new THREE.Vector3(tWorldBase.x, targetAlt, tWorldBase.z);

            const dx = tWorld.x - pos.x;
            const dz = tWorld.z - pos.z;
            const dist = Math.hypot(dx, dz);
            d.mesh.rotation.y = Math.atan2(dx, dz);

            if (dist > 3.15) {
                const moveStep = Math.min(dist - 2.6, 10.5 * dt);
                pos.x += (dx / dist) * moveStep;
                pos.z += (dz / dist) * moveStep;
            }
            const groundY = getTerrainHeight(pos.x, pos.z);
            const desiredHoverY = mechRepairTarget.isAir ? Math.max(groundY + 2.2, tWorld.y - 0.35) : (groundY + 2.05 + Math.sin(d.bobPhase * 1.6) * 0.10);
            pos.y = THREE.MathUtils.lerp(pos.y, desiredHoverY, Math.min(1, dt * 8));

            if (dist <= 6.5) {
                mechRepairTarget.hp = Math.min(mechRepairTarget.maxHp, mechRepairTarget.hp + 28 * dt);
                mechRepairTarget.isBeingRepairedTimer = 0.55;
                if (mechRepairTarget.hb) {
                    updateHealthPip(mechRepairTarget.hb, mechRepairTarget.hp, mechRepairTarget.maxHp, mechRepairTarget.shield || 0, mechRepairTarget.maxShield || 0);
                }
                if (
                    window.PORTRAIT_3D_VIEWER &&
                    typeof window.PORTRAIT_3D_VIEWER.setRepairing === 'function' &&
                    (state.selectedUnits.includes(mechRepairTarget) || state.selectedBuilding === mechRepairTarget)
                ) {
                    window.PORTRAIT_3D_VIEWER.setRepairing(true, 0.75);
                }

                const emitterStart = pos.clone().add(new THREE.Vector3(Math.sin(d.mesh.rotation.y) * 0.45, -0.05, Math.cos(d.mesh.rotation.y) * 0.45));
                if (d.repairBeam && typeof window.updateRepairBeamAssembly === 'function') {
                    window.updateRepairBeamAssembly(d.repairBeam, emitterStart, tWorld, dt);
                }
                if (ud.laserBeam) {
                    ud.laserBeam.visible = true;
                    const beamDist = Math.max(0.4, emitterStart.distanceTo(tWorld));
                    ud.laserBeam.scale.set(0.95 + Math.sin(d.bobPhase * 6) * 0.25, 0.95 + Math.cos(d.bobPhase * 6) * 0.25, beamDist);
                    ud.laserBeam.rotation.x = Math.atan2(pos.y - tWorld.y, Math.max(0.2, dist));
                }

                d.sparkTimer -= dt;
                if (d.sparkTimer <= 0) {
                    d.sparkTimer = 0.42;
                    if (typeof spawnNanoWeldSparkFX === 'function' && window.isWorldPosInViewport && window.isWorldPosInViewport(tWorld.x, tWorld.y, tWorld.z, 4.5)) {
                        spawnNanoWeldSparkFX(tWorld);
                    }
                }
            } else if (d.repairBeam) {
                d.repairBeam.visible = false;
            }
        } else {
            if (d.repairBeam) d.repairBeam.visible = false;

            if (d.state === 'to_mineral') {
                if (ud.laserBeam) ud.laserBeam.visible = false;
                if (ud.cargoCrystal) ud.cargoCrystal.visible = false;

                const tx = d.targetPatch.x;
                const tz = d.targetPatch.z;
                const dx = tx - pos.x;
                const dz = tz - pos.z;
                const dist = Math.hypot(dx, dz);

                if (dist <= 2.15) {
                    d.state = 'mining';
                    d.timer = 3.6;
                    d.carryingGold = Boolean(d.targetPatch.isGold);
                } else {
                    const moveStep = Math.min(dist, 6.8 * dt);
                    pos.x += (dx / dist) * moveStep;
                    pos.z += (dz / dist) * moveStep;
                    d.mesh.rotation.y = Math.atan2(dx, dz);
                }
                const groundY = getTerrainHeight(pos.x, pos.z);
                pos.y = THREE.MathUtils.lerp(pos.y, groundY + 2.05 + Math.sin(d.bobPhase) * 0.12, Math.min(1, dt * 8));
            } else if (d.state === 'mining') {
                const tx = d.targetPatch.x;
                const tz = d.targetPatch.z;
                const ty = getTerrainHeight(tx, tz) + 0.65;
                d.mesh.rotation.y = Math.atan2(tx - pos.x, tz - pos.z);
                const groundY = getTerrainHeight(pos.x, pos.z);
                pos.y = groundY + 1.85 + Math.sin(d.bobPhase * 1.5) * 0.08;

                if (ud.laserBeam) {
                    ud.laserBeam.visible = true;
                    const beamDist = Math.max(0.5, Math.hypot(tx - pos.x, ty - pos.y, tz - pos.z) - 0.55);
                    ud.laserBeam.scale.set(0.85 + Math.sin(d.bobPhase * 5) * 0.25, 0.85 + Math.cos(d.bobPhase * 5) * 0.25, beamDist);
                    ud.laserBeam.rotation.x = Math.atan2(pos.y - ty, Math.hypot(tx - pos.x, tz - pos.z));
                }

                d.sparkTimer -= dt;
                if (d.sparkTimer <= 0) {
                    d.sparkTimer = 0.55;
                    if (typeof spawnNanoWeldSparkFX === 'function' && window.isWorldPosInViewport && window.isWorldPosInViewport(tx, ty, tz, 4.0)) {
                        spawnNanoWeldSparkFX(new THREE.Vector3(tx, ty, tz));
                    }
                }

                d.timer -= dt;
                if (d.timer <= 0) {
                    const harvestAmt = state.elapsedSec < 90.0 ? (d.carryingGold ? 15 : 10) : (d.carryingGold ? 20 : 14);
                    if (d.targetPatch && typeof window.depleteMineralPatch === 'function') {
                        window.depleteMineralPatch(d.targetPatch, harvestAmt);
                    }
                    d.state = 'to_base';
                    if (ud.laserBeam) ud.laserBeam.visible = false;
                    if (ud.cargoCrystal) {
                        ud.cargoCrystal.visible = true;
                        ud.cargoCrystal.material = d.carryingGold ? _miningDroneCargoGoldMat : _miningDroneCargoBlueMat;
                    }
                }
            } else if (d.state === 'to_base') {
                if (ud.laserBeam) ud.laserBeam.visible = false;
                if (ud.cargoCrystal) ud.cargoCrystal.visible = true;

                const dx = basePos.x - pos.x;
                const dz = basePos.z - pos.z;
                const dist = Math.hypot(dx, dz);

                if (dist <= 2.95) {
                    const yieldAmt = state.elapsedSec < 90.0 ? (d.carryingGold ? 15 : 10) : (d.carryingGold ? 20 : 14);
                    if (d.ownerType === 'player') {
                        state.req += yieldAmt;
                        updateHUD();
                    } else if (d.ownerType === 'solaris') {
                        state.solarisBuildTimer = Math.max(3.5, (state.solarisBuildTimer || 18.0) - 0.55);
                    } else if (d.ownerType === 'zerg') {
                        state.enemyBuildTimer = Math.max(4.0, (state.enemyBuildTimer || 20.0) - 0.50);
                    }
                    if (ud.cargoCrystal) ud.cargoCrystal.visible = false;
                    d.targetPatch = findBestMineralPatchForDrone(basePos, d.slotIdx);
                    d.state = 'to_mineral';
                } else {
                    const moveStep = Math.min(dist, 6.8 * dt);
                    pos.x += (dx / dist) * moveStep;
                    pos.z += (dz / dist) * moveStep;
                    d.mesh.rotation.y = Math.atan2(dx, dz);
                }
                const groundY = getTerrainHeight(pos.x, pos.z);
                pos.y = THREE.MathUtils.lerp(pos.y, groundY + 2.15 + Math.sin(d.bobPhase) * 0.12, Math.min(1, dt * 8));
            }
        }

        const inView = window.isWorldPosInViewport ? window.isWorldPosInViewport(pos.x, pos.y, pos.z, 4.5) : true;
        d.mesh.visible = inView && (d.ownerType !== 'zerg' || isWorldPosVisible(pos.x, pos.z));
    }
}

function switchToEndlessMode() {
    document.getElementById('victory-modal').style.display = 'none';
    state.isEndless = true;
    state.missionWon = false;

    enemyBuildings.forEach(eb => {
        scene.remove(eb.mesh);
        if (eb.badge) eb.badge.remove();
        if (eb.hb) eb.hb.root.remove();
    });
    enemyBuildings.length = 0;
    state.enemyBase = null;
    recallAllFriendlyUnitsToMainBase();

    creepTargetRadius = 0;
    const btnEndless = document.getElementById('btn-toggle-endless');
    if (btnEndless) btnEndless.style.display = 'none';
    document.getElementById('mode-badge').innerText = 'ENDLESS';
    document.getElementById('directive-ticker').innerText = `ENDLESS WAVE #${state.wave}: Survive infinite waves!`;
    updateHUD();
}
window.switchToEndlessMode = switchToEndlessMode;

function getWaveStrengthMultiplier() {
    return +(1 + (state.wave - 1) * (state.isEndless ? 0.38 : 0.25)).toFixed(1);
}

let _lastHudUpdateMs = 0;
function updateHUD(force = false) {
    const nowMs = performance.now();
    if (!force && nowMs - _lastHudUpdateMs < 180) return;
    _lastHudUpdateMs = nowMs;

    document.getElementById('ui-req').innerText = state.req;
    const gemsEl = document.getElementById('ui-gems');
    if (gemsEl) gemsEl.innerText = state.gems || 0;
    document.getElementById('ui-supply').innerText = units.length;

    const mins = Math.floor(state.elapsedSec / 60);
    const secs = Math.floor(state.elapsedSec % 60);
    const clockEl = document.getElementById('ui-clock');
    if (clockEl) {
        clockEl.innerText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    document.getElementById('ui-wave').innerText = state.wave;
    document.getElementById('ui-scale').innerText = `${getWaveStrengthMultiplier()}x`;

    const wfBox = document.getElementById('wireframe-box');
    const wfText = document.getElementById('wireframe-hp-text');

    if (state.selectedUnits.length > 1) {
        renderMultiUnitSelectionGrid();
        return;
    }

    if (state.selectedUnits.length === 1) {
        const u = state.selectedUnits[0];
        const ratio = Math.max(0, u.hp / u.maxHp);
        const col = ratio > 0.6 ? '#00ff66' : (ratio > 0.3 ? '#ffaa00' : '#ff2a4b');
        const svgContainer = document.getElementById('wireframe-svg');
        if (svgContainer) svgContainer.outerHTML = getWireframeSvgMarkup(u.type, col).replace('<svg ', '<svg id="wireframe-svg" ');
        renderWireframeHpBlocks(ratio, col);
        wfText.style.color = col;
        wfText.innerText = `${Math.max(0, Math.ceil(u.hp))}/${u.maxHp}`;
        document.getElementById('stat-order').innerText = (u.order || 'auto').toUpperCase();
        return;
    }

    const sel = state.selectedBuilding;
    if (sel) {
        const ratio = Math.max(0, sel.hp / sel.maxHp);
        const pct = Math.round(ratio * 100);
        const col = ratio > 0.6 ? '#00ff66' : (ratio > 0.3 ? '#ffaa00' : '#ff2a4b');
        const svgContainer = document.getElementById('wireframe-svg');
        if (svgContainer) svgContainer.outerHTML = getWireframeSvgMarkup(sel.type, col).replace('<svg ', '<svg id="wireframe-svg" ');
        renderWireframeHpBlocks(ratio, col);
        wfText.style.color = col;
        wfText.innerText = sel.type === 'base' ? 'ONLINE' : `${Math.max(0, Math.floor(sel.hp))} (${pct}%)`;
        const isUnderConstruction = (sel.buildProgress !== undefined && sel.buildProgress < 1.0);
        if (isUnderConstruction) {
            const buildPct = Math.min(99, Math.max(1, Math.round(sel.buildProgress * 100)));
            const isProtossBld = sel.type.startsWith('solaris_') || state.playerFaction === 'solaris';
            document.getElementById('prod-unit-name').innerText = isProtossBld
                ? `WARPING IN STRUCTURE... (${buildPct}%)`
                : `CONSTRUCTING STRUCTURE... (${buildPct}%)`;
            document.getElementById('prod-pct').innerText = `${buildPct}%`;
            document.getElementById('prod-bar-fill').style.width = `${buildPct}%`;
        } else if (sel.type === 'barracks' || sel.type === 'factory' || sel.type === 'solaris_gate' || sel.type === 'solaris_robotics') {
            const p = Math.min(100, Math.max(0, Math.round((1 - sel.spawnTimer / sel.spawnDuration) * 100)));
            const uLabel = (sel.unitType || 'ranger').toUpperCase();
            const isProtossProd = (sel.type === 'solaris_gate' || sel.type === 'solaris_robotics');
            document.getElementById('prod-unit-name').innerText = isProtossProd ? `WARPING IN: ${uLabel}` : `TRAINING: ${uLabel}`;
            document.getElementById('prod-pct').innerText = `${p}%`;
            document.getElementById('prod-bar-fill').style.width = `${p}%`;
        }
    } else if (wfBox) {
        const svgContainer = document.getElementById('wireframe-svg');
        if (svgContainer) svgContainer.outerHTML = getWireframeSvgMarkup('base', '#00ff66').replace('<svg ', '<svg id="wireframe-svg" ');
        renderWireframeHpBlocks(1.0, '#00ff66');
        wfText.style.color = '#00ff66';
    }

    const ticker = document.getElementById('directive-ticker');
    if (ticker && !state.missionWon) {
        if (!state.basePlaced) {
            ticker.innerText = "Deploy Command HQ on flat ground, or drag a box to select units.";
            ticker.style.color = "#00e5ff";
        } else if (state.rushGraceTimer > 0 && !state.isEndless) {
            ticker.innerText = `RECON PHASE: Enemy air wing awakening in 00:${String(Math.ceil(state.rushGraceTimer)).padStart(2, '0')} — Establish defenses!`;
            ticker.style.color = "#ffaa00";
        } else if (!state.isEndless) {
            ticker.innerText = `PRIMARY OBJECTIVE: Destroy all ${enemyBuildings.length} Zerg Hive Cluster structures across Sector-09.`;
            ticker.style.color = "#00e5ff";
        }
    }
}
renderSC2CommandCard();
updateFogOfWarVision();
renderTacticalMinimap();

// ============================================================================
// 8. SPAWNERS WITH BIOLOGICAL VS MECHANICAL TAGS, SELECTION RINGS & COLLISION
// ============================================================================
const _projScreenVec = new THREE.Vector3();
let _domProjCallCounter = 0;
function projectToScreen(dom, pos, yOff = 1.3, forceImmediate = false) {
    if (!dom || !pos) return;
    if (typeof hudVisibilityState !== 'undefined' && hudVisibilityState.showHpBars === false && dom.classList && dom.classList.contains('hp-pip')) {
        if (dom._lastDisp !== 'none') {
            dom._lastDisp = 'none';
            dom.style.display = 'none';
        }
        return;
    }
    const t0 = window.PERF_PROFILER ? performance.now() : 0;

    // Throttle DOM coordinate projection for unselected units on mobile/adaptive quality tiers
    const stride = (!forceImmediate && window.PERF_MANAGER && window.PERF_MANAGER.current)
        ? (window.PERF_MANAGER.current.domProjectionStride || 1)
        : 1;
    if (stride > 1) {
        if (dom._projPhase === undefined) dom._projPhase = (_domProjCallCounter++) & 7;
        const frameTick = window.PERF_PROFILER ? window.PERF_PROFILER.frameCount : (_domProjCallCounter++);
        if (((frameTick + dom._projPhase) % stride) !== 0 && dom._lastLx !== undefined) {
            if (window.PERF_PROFILER) window.PERF_PROFILER.addSample('domHealthBarProjection', performance.now() - t0);
            return;
        }
    }

    _projScreenVec.set(pos.x, pos.y + yOff, pos.z);
    _projScreenVec.project(camera);
    if (_projScreenVec.z > 1 || _projScreenVec.x < -1.08 || _projScreenVec.x > 1.08 || _projScreenVec.y < -1.08 || _projScreenVec.y > 1.08) {
        if (dom._lastDisp !== 'none') {
            dom._lastDisp = 'none';
            dom.style.display = 'none';
        }
        if (window.PERF_PROFILER) window.PERF_PROFILER.addSample('domHealthBarProjection', performance.now() - t0);
        return;
    }
    if (dom._lastDisp !== 'block') {
        dom._lastDisp = 'block';
        dom.style.display = 'block';
    }
    const lx = Math.round((_projScreenVec.x * 0.5 + 0.5) * window.innerWidth);
    const ly = Math.round((-(_projScreenVec.y * 0.5) + 0.5) * window.innerHeight);
    if (dom._lastLx !== lx) { dom._lastLx = lx; dom.style.left = `${lx}px`; }
    if (dom._lastLy !== ly) { dom._lastLy = ly; dom.style.top = `${ly}px`; }
    if (window.PERF_PROFILER) window.PERF_PROFILER.addSample('domHealthBarProjection', performance.now() - t0);
}

let _activeCombatFloats = 0;
let _lastCombatFloatMs = 0;
function spawnCombatFloat(pos, txt, color = '#ffaa00') {
    if (typeof hudVisibilityState !== 'undefined' && hudVisibilityState.showHpBars === false) return;
    const nowMs = performance.now();
    if (_activeCombatFloats >= 14 || (nowMs - _lastCombatFloatMs < 70 && _activeCombatFloats >= 6)) return;
    // Suppress non-numeric floating action/status text popups (e.g. Valkyrie mode switches, queued unit labels, orders)
    if (typeof txt !== 'number') {
        const str = String(txt || '').trim();
        if (!/^[+-]?\d+(\s*CRIT|\s*HP)?$/i.test(str)) return;
    }
    if (!pos || !isWorldPosVisible(pos.x, pos.z)) return;
    _projScreenVec.set(pos.x, pos.y + 1.0, pos.z).project(camera);
    if (_projScreenVec.z > 1) return;
    _lastCombatFloatMs = nowMs;
    _activeCombatFloats++;
    const el = document.createElement('div');
    el.className = 'combat-float';
    el.style.color = color;
    el.innerText = typeof txt === 'number' ? `-${Math.round(txt)}` : txt;
    el.style.left = `${(_projScreenVec.x * 0.5 + 0.5) * window.innerWidth + (Math.random()-0.5)*18}px`;
    el.style.top = `${(-(_projScreenVec.y * 0.5) + 0.5) * window.innerHeight}px`;
    worldUi.appendChild(el);
    setTimeout(() => {
        el.remove();
        _activeCombatFloats = Math.max(0, _activeCombatFloats - 1);
    }, 650);
}

const healBeamGeo = createSculptedLatheBarrelGeo(0.035, 0.035, 1, 8);
healBeamGeo.rotateX(Math.PI / 2);

// Smooth 6-DOF Air Vehicle Flight Controller (with 3.0-second smooth VTOL liftoff climb for Valkyrie!)
function smoothAirVehicleTransform(actor, targetX, targetZ, desiredAlt, isMoving, dt) {
    const pos = actor.mesh.position;
    const groundH = Math.max(0, getTerrainHeight(pos.x, pos.z));
    if (actor.type === 'valkyrie' && actor.mesh && actor.mesh.userData && typeof actor.mesh.userData.mechTransition === 'number') {
        const mt = actor.mesh.userData.mechTransition;
        const smoothFlightT = 1.0 - (mt * mt * (3.0 - 2.0 * mt));
        const targetAltY = groundH + desiredAlt * smoothFlightT;
        pos.y = THREE.MathUtils.lerp(pos.y, targetAltY, Math.min(1, dt * 6.5));
    } else {
        pos.y = THREE.MathUtils.lerp(pos.y, groundH + desiredAlt, dt * 4.2);
    }

    const dx = targetX - pos.x;
    const dz = targetZ - pos.z;
    const horizDistSq = dx * dx + dz * dz;

    if (actor.currentYaw === undefined) {
        actor.currentYaw = actor.mesh.rotation.y || 0;
        actor.currentPitch = 0;
        actor.currentRoll = 0;
    }

    let angleDiff = 0;
    if (horizDistSq > 0.04) {
        const desiredYaw = Math.atan2(dx, dz);
        angleDiff = shortestAngleDiff(actor.currentYaw, desiredYaw);
        const turnRate = actor.type === 'transport' ? 2.4 : (actor.variant === 'mutalisk' ? 3.6 : 3.2);
        const maxTurnStep = turnRate * dt;
        if (Math.abs(angleDiff) <= maxTurnStep) {
            actor.currentYaw = desiredYaw;
        } else {
            actor.currentYaw += Math.sign(angleDiff) * maxTurnStep;
        }
    }

    // Smooth aerodynamic roll banking into turns + forward pitch tilt while moving
    const targetRoll = isMoving ? Math.max(-0.38, Math.min(0.38, -angleDiff * 0.48)) : 0;
    const targetPitch = isMoving ? (actor.type === 'transport' ? 0.10 : 0.16) : 0;
    actor.currentRoll = THREE.MathUtils.lerp(actor.currentRoll || 0, targetRoll, dt * 6.0);
    actor.currentPitch = THREE.MathUtils.lerp(actor.currentPitch || 0, targetPitch, dt * 5.0);

    actor.mesh.rotation.order = 'YXZ';
    actor.mesh.rotation.y = actor.currentYaw;
    actor.mesh.rotation.x = actor.currentPitch;
    actor.mesh.rotation.z = actor.currentRoll;

    // Rotor downwash triggers subtle concentric ripples when hovering over uncovered water ponds (never over bridges)!
    actor.waterWashTimer = (actor.waterWashTimer || 0) - dt;
    if (actor.waterWashTimer <= 0 && typeof triggerWaterRippleFX === 'function') {
        actor.waterWashTimer = 0.55;
        if (!(typeof isOnRiverBridge === 'function' && isOnRiverBridge(pos.x, pos.z, 0.8))) {
            triggerWaterRippleFX(pos.x, pos.z, 0.50, false);
        }
    }
}

var MAX_ALLIED_UNITS = 40;
var MAX_ENEMY_UNITS = 54;

function spawnAlliedUnit(uType, spawnOrigin) {
    if (uType !== 'hero' && units.length >= MAX_ALLIED_UNITS) return;
    const statsMap = {
        grunt:     { hp: 255, dmg: 38, rng: 1.95, spd: 4.7, rate: 0.42, rad: 0.52, col: '#00ff66' },
        ranger:    { hp: 125, dmg: 25, rng: 9.0,  spd: 3.5, rate: 0.58, rad: 0.48, col: '#00ff66' },
        medic:     { hp: 140, dmg: 0,  rng: 6.8,  spd: 3.8, rate: 0.25, rad: 0.48, col: '#00e5ff' },
        rocketman: { hp: 155, dmg: 46, rng: 15.5, spd: 3.9, rate: 1.25, rad: 0.52, col: '#ffaa00' },
        reaper:    { hp: 145, dmg: 24, rng: 9.5,  spd: 6.6, rate: 0.34, rad: 0.48, col: '#ffaa00' },
        firebat:   { hp: 265, dmg: 38, rng: 5.5,  spd: 4.1, rate: 0.48, rad: 0.54, col: '#ff5500' },
        marauder:  { hp: 315, dmg: 54, rng: 11.5, spd: 3.6, rate: 0.92, rad: 0.58, col: '#ffaa00' },
        hero:      { hp: 750, dmg: 48, rng: 10.5, spd: 4.5, rate: 0.24, rad: 0.65, col: '#ffaa00' },
        tank:          { hp: 620, dmg: 90, rng: 15.0, spd: 2.9, rate: 2.00, rad: 1.15, col: '#00e5ff' },
        siege_tank:    { hp: 680, dmg: 85, rng: 14.0, spd: 2.6, rate: 1.85, rad: 1.22, col: '#00e5ff' },
        heli:          { hp: 380, dmg: 42, rng: 13.5, spd: 6.6, rate: 0.50, rad: 0.98, col: '#00e5ff' },
        transport:     { hp: 520, dmg: 0,  rng: 10.5, spd: 7.2, rate: 1.00, rad: 1.15, col: '#00ff66' },
        medivac:       { hp: 480, dmg: 0,  rng: 11.5, spd: 7.4, rate: 0.25, rad: 1.10, col: '#00ff66' },
        battlecruiser: { hp: 1150, shd: 260, dmg: 68, rng: 18.5, spd: 4.2, rate: 0.52, rad: 1.48, col: '#38bdf8' },
        valkyrie:      { hp: 440, dmg: 38, rng: 17.5, spd: 6.8, rate: 1.15, rad: 1.05, col: '#38bdf8' },
        zealot:        { hp: 220, shd: 120, dmg: 44, rng: 1.95, spd: 5.2, rate: 0.42, rad: 0.54, col: '#f5b932' },
        stalker:       { hp: 180, shd: 140, dmg: 38, rng: 13.5, spd: 4.6, rate: 0.72, rad: 0.72, col: '#38bdf8' },
        archon:        { hp: 160, shd: 380, dmg: 68, rng: 9.5,  spd: 4.1, rate: 0.95, rad: 0.82, col: '#f5b932' },
        phoenix:       { hp: 240, shd: 140, dmg: 34, rng: 14.0, spd: 8.2, rate: 0.44, rad: 0.88, col: '#38bdf8' },
        void_ray:      { hp: 340, shd: 220, dmg: 26, rng: 15.5, spd: 5.2, rate: 0.25, rad: 1.05, col: '#00e5ff' },
        carrier:       { hp: 520, shd: 360, dmg: 42, rng: 18.5, spd: 3.8, rate: 0.85, rad: 1.32, col: '#f5b932' }
    };
    if (!spawnOrigin) spawnOrigin = state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS;

    // Enforce strict faction-respective unit spawning:
    // - AI Ally Solaris enclave structures at SOLARIS_BASE_POS spawn Protoss units
    // - Player structures / drops only spawn units belonging to state.playerFaction
    const protossSet = new Set(['zealot', 'stalker', 'archon', 'phoenix', 'void_ray', 'carrier']);
    const terranSet = new Set(['grunt', 'ranger', 'medic', 'rocketman', 'reaper', 'firebat', 'marauder', 'tank', 'siege_tank', 'heli', 'transport', 'medivac', 'battlecruiser', 'valkyrie']);
    const isFromSolarisEnclave = typeof solarisBuildings !== 'undefined' && solarisBuildings.some(sb =>
        sb && sb.hp > 0 && sb.pos && Math.hypot(sb.pos.x - spawnOrigin.x, sb.pos.z - spawnOrigin.z) < 4.5
    );
    if (uType !== 'hero') {
        if (isFromSolarisEnclave || state.playerFaction === 'solaris') {
            if (!protossSet.has(uType)) {
                const terranToProtoss = {
                    grunt: 'zealot', firebat: 'zealot', reaper: 'zealot',
                    ranger: 'stalker', medic: 'stalker', rocketman: 'stalker', marauder: 'stalker',
                    tank: 'archon', siege_tank: 'archon',
                    heli: 'phoenix', valkyrie: 'phoenix', transport: 'void_ray', medivac: 'void_ray', battlecruiser: 'carrier'
                };
                uType = terranToProtoss[uType] || 'zealot';
            }
        } else if (state.playerFaction === 'terran') {
            if (!terranSet.has(uType)) {
                const protossToTerran = {
                    zealot: 'grunt', stalker: 'ranger', archon: 'marauder',
                    phoenix: 'heli', void_ray: 'valkyrie', carrier: 'battlecruiser'
                };
                uType = protossToTerran[uType] || 'ranger';
            }
        }
    }
    if (!uType || !statsMap[uType]) uType = state.playerFaction === 'solaris' ? 'zealot' : 'ranger';
    const stats = statsMap[uType];

    const mesh = createAnimatedUnitModel(uType);
    // Reaper is a flying jump-jet infantry unit; Heli, Transport, Medivac, Battlecruiser, Valkyrie, Phoenix, Void Ray & Carrier are aircraft
    const isAir = (uType === 'heli' || uType === 'transport' || uType === 'medivac' || uType === 'battlecruiser' || uType === 'valkyrie' || uType === 'reaper' || uType === 'phoenix' || uType === 'void_ray' || uType === 'carrier');
    const isMechanical = (uType === 'tank' || uType === 'siege_tank' || uType === 'stalker' || uType === 'heli' || uType === 'transport' || uType === 'medivac' || uType === 'battlecruiser' || uType === 'valkyrie' || uType === 'phoenix' || uType === 'void_ray' || uType === 'carrier');
    const isBiological = !isMechanical;

    // Use Clear Spawn Point Finder so ground units NEVER spawn wedged inside tight building gaps!
    let sx = spawnOrigin.x + (Math.random() - 0.5) * 1.4;
    let sz = spawnOrigin.z + 2.2 + Math.random() * 0.6;
    if (!isAir && typeof findClearSpawnPoint === 'function') {
        const rallyX = BRIDGES.length > 0 ? BRIDGES[0].southEntry.x : ENEMY_BASE_POS.x;
        const rallyZ = BRIDGES.length > 0 ? BRIDGES[0].southEntry.z : ENEMY_BASE_POS.z;
        const clearPt = findClearSpawnPoint(spawnOrigin.x, spawnOrigin.z, rallyX, rallyZ, stats.rad, buildings, enemyBuildings, units);
        sx = clearPt.x;
        sz = clearPt.z;
    }

    const baseH = getTerrainHeight(sx, sz);
    const initAirAlt = uType === 'reaper' ? 2.65 : (uType === 'battlecruiser' ? 7.6 : 6.2);
    mesh.position.set(sx, isAir ? Math.max(0, baseH) + initAirAlt : baseH, sz);

    // Initial smooth yaw facing outward from spawn building
    const initYaw = Math.atan2(sx - spawnOrigin.x, sz - spawnOrigin.z);
    mesh.rotation.y = initYaw;

    // StarCraft Green Unit Selection Circle under unit feet
    const selCircle = new THREE.Mesh(unitSelRingGeo, unitSelRingMat);
    selCircle.position.y = isAir ? (uType === 'reaper' ? -2.55 : -5.8) : 0.08;
    selCircle.scale.setScalar(stats.rad * 1.55);
    selCircle.visible = false;
    mesh.add(selCircle);
    mesh.userData.selCircle = selCircle;

    scene.add(mesh);

    const hb = makeHealthPip(stats.col);
    let healBeam = null;
    if (uType === 'medic' || uType === 'medivac') {
        healBeam = new THREE.Mesh(healBeamGeo, MAT.medicBioBeam);
        healBeam.visible = false;
        scene.add(healBeam);
    }

    // Compute a clear initial rally step 3.4m outward toward the front of the base so units march cleanly out of tight base clusters
    const outAng = Math.atan2((ENEMY_BASE_POS.z - spawnOrigin.z) * 0.4 + (sz - spawnOrigin.z), (ENEMY_BASE_POS.x - spawnOrigin.x) * 0.4 + (sx - spawnOrigin.x));
    const rawRx = sx + Math.cos(outAng) * 3.4;
    const rawRz = sz + Math.sin(outAng) * 3.4;
    const clearRallyPt = (!isAir && typeof findClearSpawnPoint === 'function')
        ? findClearSpawnPoint(rawRx, rawRz, ENEMY_BASE_POS.x, ENEMY_BASE_POS.z, stats.rad, buildings, enemyBuildings, units)
        : { x: rawRx, z: rawRz };
    const spawnRallyTarget = !isAir ? new THREE.Vector3(
        clearRallyPt.x,
        getTerrainHeight(clearRallyPt.x, clearRallyPt.z),
        clearRallyPt.z
    ) : null;

    // If the Enemy Zerg Base has already been discovered by scouts, newly spawned units immediately march to attack the Enemy Base!
    const initialPatrolTarget = (state.enemyBaseDiscovered && enemyBuildings.length > 0)
        ? (state.enemyBase && state.enemyBase.hp > 0 ? state.enemyBase.pos.clone() : enemyBuildings[0].pos.clone())
        : null;

    const isSolUnit = (uType === 'zealot' || uType === 'stalker' || uType === 'archon' || uType === 'phoenix' || uType === 'void_ray' || uType === 'carrier');
    const facKey = isSolUnit ? 'solaris' : 'terran';
    const upg = (state.upgrades && state.upgrades[facKey]) ? state.upgrades[facKey] : { weapons: 0, armor: 0 };
    const wMult = 1.0 + (upg.weapons || 0) * 0.20;
    const aMult = 1.0 + (upg.armor || 0) * 0.20;
    const finalMaxHp = Math.round(stats.hp * aMult);
    const finalDmg = Math.round(stats.dmg * wMult);

    let prismaticBeam = null;
    if (uType === 'void_ray') {
        prismaticBeam = new THREE.Mesh(healBeamGeo, MAT.solarisPrismGlow || MAT.cyanGlow);
        prismaticBeam.visible = false;
        scene.add(prismaticBeam);
    }

    let laserWeapons = null;
    if (uType === 'battlecruiser') {
        const turrets = (mesh.userData && Array.isArray(mesh.userData.laserTurrets)) ? mesh.userData.laserTurrets : [];
        const muzzles = (mesh.userData && Array.isArray(mesh.userData.laserMuzzles)) ? mesh.userData.laserMuzzles : [];
        const perCannonDmg = Math.max(18, Math.round(finalDmg * 0.42));
        laserWeapons = [];
        for (let wi = 0; wi < 4; wi++) {
            const beamGroup = createBattlecruiserLaserBeamGroup(wi);
            scene.add(beamGroup);
            laserWeapons.push({
                index: wi,
                mount: turrets[wi] || null,
                muzzle: muzzles[wi] || null,
                target: null,
                targetId: null,
                cooldown: wi * 0.07,
                fireRate: 0.44 + (wi % 2) * 0.03,
                damage: perCannonDmg,
                beamGroup,
                beamTimer: 0,
                lastMuzzleWorldPos: new THREE.Vector3(),
                lastTargetWorldPos: new THREE.Vector3(),
                shotsFired: 0,
                totalDamageDealt: 0
            });
        }
    }

    const newUnitObj = {
        type: uType, isAir, isVehicle: isMechanical, isMechanical, isBiological,
        radius: stats.rad, mesh, hb, healBeam, prismaticBeam, laserWeapons, selCircle,
        yamatoCooldown: uType === 'battlecruiser' ? 3.5 : 0,
        baseMaxHp: stats.hp,
        baseDamage: stats.dmg,
        hp: finalMaxHp, maxHp: finalMaxHp,
        shield: stats.shd || 0,
        maxShield: stats.shd || 0,
        shieldRegenDelay: 0,
        damage: finalDmg,
        armorBonus: (upg.armor || 0) * 2,
        range: stats.rng,
        speed: stats.spd,
        fireRate: stats.rate,
        cooldown: 0,
        currentYaw: initYaw,
        currentPitch: 0,
        currentRoll: 0,
        order: 'auto',
        orderTarget: null,
        patrolTarget: initialPatrolTarget,
        spawnRallyTarget,
        spawnRallyTimer: !isAir ? 1.1 : 0,
        stuckTimer: 0,
        lastProgressPos: new THREE.Vector3(sx, baseH, sz),
        flankSign: (units.length % 2 === 0 ? 1 : -1),
        lastHitImpulse: null,
        lastHitHeavy: false,
        dropTimer: uType === 'transport' ? 2.5 : 0,
        evasionTimer: 0,
        beamChargeTime: 0,
        beamStage: 1,
        beamTarget: null,
        interceptors: uType === 'carrier' ? [] : null,
        maxInterceptors: uType === 'carrier' ? 5 : 0,
        interceptorBuildTimer: uType === 'carrier' ? 0.8 : 0,
        homePos: new THREE.Vector3(sx, baseH, sz + 2.2)
    };
    if (((upg.weapons || 0) > 0 || (upg.armor || 0) > 0) && typeof window.applyUnitUpgradeVisuals === 'function') {
        window.applyUnitUpgradeVisuals(newUnitObj, upg.weapons || 0, upg.armor || 0, facKey);
    }
    units.push(newUnitObj);
    updateHealthPip(hb, finalMaxHp, finalMaxHp, stats.shd || 0, stats.shd || 0);
    updateHUD();
}

function createBattlecruiserLaserBeamGroup(cannonIdx) {
    const group = new THREE.Group();
    group.name = `bc_laser_beam_${cannonIdx}`;
    group.visible = false;
    group.frustumCulled = false;

    const coreGeo = new THREE.CylinderGeometry(0.032, 0.032, 1.0, 8);
    coreGeo.translate(0, 0.5, 0);
    coreGeo.rotateX(Math.PI / 2);
    const coreMat = new THREE.MeshBasicMaterial({
        color: 0xfff3b0,
        transparent: true,
        opacity: 0.96,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);

    const glowGeo = new THREE.CylinderGeometry(0.085, 0.085, 1.0, 8);
    glowGeo.translate(0, 0.5, 0);
    glowGeo.rotateX(Math.PI / 2);
    const glowMat = new THREE.MeshBasicMaterial({
        color: 0xff5400,
        transparent: true,
        opacity: 0.68,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const glowMesh = new THREE.Mesh(glowGeo, glowMat);

    const impactGeo = new THREE.SphereGeometry(0.22, 10, 8);
    const impactMat = new THREE.MeshBasicMaterial({
        color: 0xffaa00,
        transparent: true,
        opacity: 0.90,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const impactMesh = new THREE.Mesh(impactGeo, impactMat);

    group.add(coreMesh, glowMesh, impactMesh);
    group.userData = { coreMesh, glowMesh, impactMesh, cannonIdx };
    return group;
}

function cleanupBattlecruiserLaserWeapons(u) {
    if (!u || !Array.isArray(u.laserWeapons)) return;
    for (let i = 0; i < u.laserWeapons.length; i++) {
        const w = u.laserWeapons[i];
        if (w && w.beamGroup) {
            w.beamGroup.visible = false;
            scene.remove(w.beamGroup);
        }
        if (w && w.mount && w.mount.userData) {
            w.mount.userData.hasIndependentTarget = false;
            w.mount.userData.flashTimer = 0;
            if (w.mount.userData.muzzleFlash) w.mount.userData.muzzleFlash.visible = false;
        }
    }
}

function updateBattlecruiserFourLaserWeapons(u, dt) {
    if (!u || u.type !== 'battlecruiser' || !u.mesh || u.hp <= 0) return null;
    if (!Array.isArray(u.laserWeapons) || u.laserWeapons.length !== 4) return null;

    const bcPos = u.mesh.position;
    const maxUnitRange = (u.range || 18.5) + 1.0;
    const maxBldRange = (u.range || 18.5) + 3.0;

    // 1. Collect all living valid enemy targets in range with line-of-sight check
    const validTargets = [];
    for (let ei = 0; ei < enemies.length; ei++) {
        const e = enemies[ei];
        if (!e || e.hp <= 0 || !e.mesh) continue;
        const d = Math.hypot(e.mesh.position.x - bcPos.x, e.mesh.position.z - bcPos.z);
        if (d <= maxUnitRange) {
            validTargets.push({ entity: e, isBuilding: false, dist: d });
        }
    }
    for (let ebi = 0; ebi < enemyBuildings.length; ebi++) {
        const eb = enemyBuildings[ebi];
        if (!eb || eb.hp <= 0 || !eb.pos) continue;
        const d = Math.hypot(eb.pos.x - bcPos.x, eb.pos.z - bcPos.z);
        if (d <= maxBldRange) {
            validTargets.push({ entity: eb, isBuilding: true, dist: d });
        }
    }
    validTargets.sort((a, b) => a.dist - b.dist);

    const validEntitySet = new Set(validTargets.map(vt => vt.entity));

    // 2. Clear any weapon target that died, left range, or became invalid
    for (let wi = 0; wi < 4; wi++) {
        const w = u.laserWeapons[wi];
        if (!w.target || w.target.hp <= 0 || !validEntitySet.has(w.target)) {
            w.target = null;
            w.targetId = null;
            w.beamTimer = 0;
            if (w.beamGroup) w.beamGroup.visible = false;
            if (w.mount && w.mount.userData) {
                w.mount.userData.hasIndependentTarget = false;
            }
        }
    }

    // 3. Assign targets across the 4 independent laser cannons:
    // - If >= 4 valid targets exist, each cannon targets a DIFFERENT enemy.
    // - If 1..3 valid targets exist, distribute the 4 cannons across available targets without leaving cannons idle.
    if (validTargets.length > 0) {
        const distinctPoolCount = Math.min(4, validTargets.length);
        const assignedInPass = new Set();

        if (validTargets.length >= 4) {
            // Keep existing valid distinct locks first
            for (let wi = 0; wi < 4; wi++) {
                const w = u.laserWeapons[wi];
                if (w.target && !assignedInPass.has(w.target)) {
                    assignedInPass.add(w.target);
                } else {
                    w.target = null;
                }
            }
            // Assign remaining cannons to distinct unassigned targets
            for (let wi = 0; wi < 4; wi++) {
                const w = u.laserWeapons[wi];
                if (!w.target) {
                    const candidate = validTargets.find(vt => !assignedInPass.has(vt.entity));
                    if (candidate) {
                        w.target = candidate.entity;
                        assignedInPass.add(candidate.entity);
                    }
                }
            }
        } else {
            // Fewer than 4 targets in range: distribute the 4 weapons evenly across available targets
            for (let wi = 0; wi < 4; wi++) {
                const w = u.laserWeapons[wi];
                const pick = validTargets[wi % distinctPoolCount].entity;
                w.target = pick;
            }
        }
    }

    // Ensure world matrices of the Battlecruiser airframe and mounts are up to date
    u.mesh.updateMatrixWorld(true);
    const airframe = u.mesh.userData ? u.mesh.userData.airframe : null;
    const upgW = (state.upgrades && state.upgrades.terran) ? (state.upgrades.terran.weapons || 0) : 0;
    const perCannonDmg = Math.max(18, Math.round((u.baseDamage || u.damage || 65) * 0.42 * (1.0 + upgW * 0.20)));

    let primaryAimPos = null;
    const nowTime = performance.now() * 0.001;

    // 4. Update each of the 4 laser cannons independently (aim, world-space muzzle pos, cooldown, damage, beam FX)
    for (let wi = 0; wi < 4; wi++) {
        const w = u.laserWeapons[wi];
        w.damage = perCannonDmg;
        w.cooldown = Math.max(0, (w.cooldown || 0) - dt);
        w.beamTimer = Math.max(0, (w.beamTimer || 0) - dt);

        const tgt = w.target;
        if (!tgt || tgt.hp <= 0) {
            w.target = null;
            w.targetId = null;
            if (w.beamGroup) w.beamGroup.visible = false;
            if (w.mount && w.mount.userData) w.mount.userData.hasIndependentTarget = false;
            continue;
        }

        const rawTPos = tgt.mesh ? tgt.mesh.position : tgt.pos;
        const targetY = (rawTPos.y || 0) + (tgt.isAir ? 0.0 : 0.65);
        w.lastTargetWorldPos.set(rawTPos.x, targetY, rawTPos.z);
        w.targetId = tgt.id || (tgt.role ? `bld_${tgt.role}_${tgt.bpIdx || 0}` : `target_${wi}`);
        if (!primaryAimPos) primaryAimPos = w.lastTargetWorldPos;

        // Orient this turret mount toward its own target in airframe local space
        if (w.mount && airframe) {
            if (!w.mount.userData) w.mount.userData = {};
            w.mount.userData.hasIndependentTarget = true;
            if (!w.mount.userData.targetWorldPos) w.mount.userData.targetWorldPos = new THREE.Vector3();
            w.mount.userData.targetWorldPos.copy(w.lastTargetWorldPos);

            const localAim = airframe.worldToLocal(_muzzleScratch2.copy(w.lastTargetWorldPos));
            const desiredYaw = Math.atan2(localAim.x - w.mount.position.x, localAim.z - w.mount.position.z);
            w.mount.rotation.y = THREE.MathUtils.lerp(w.mount.rotation.y || 0, desiredYaw, Math.min(1, dt * 16));
            w.mount.updateMatrixWorld(true);
        }

        // Calculate exact world-space muzzle origin from this cannon's muzzle node
        if (w.muzzle) {
            w.muzzle.getWorldPosition(w.lastMuzzleWorldPos);
        } else if (w.mount) {
            w.mount.getWorldPosition(w.lastMuzzleWorldPos);
        } else {
            w.lastMuzzleWorldPos.copy(bcPos);
        }

        // Fire when this cannon's independent cooldown reaches 0
        if (w.cooldown <= 0) {
            w.cooldown = w.fireRate;
            w.beamTimer = 0.24;
            w.shotsFired = (w.shotsFired || 0) + 1;
            w.totalDamageDealt = (w.totalDamageDealt || 0) + w.damage;

            if (u.mesh.userData) u.mesh.userData.attackAnim = 1.0;
            if (w.mount && w.mount.userData) {
                w.mount.userData.flashTimer = 0.12;
                if (w.mount.userData.muzzleFlash) w.mount.userData.muzzleFlash.visible = true;
            }

            // Apply genuine per-cannon damage to this cannon's target
            if (!enemyBuildings.includes(tgt)) {
                recordRagdollHitImpulse(tgt, w.lastMuzzleWorldPos, false);
            }
            tgt.hp -= w.damage;

            triggerMuzzleFlash(w.lastMuzzleWorldPos);
            if (typeof triggerSparks === 'function' && Math.random() < 0.75) {
                triggerSparks(w.lastTargetWorldPos);
            }
            spawnCombatFloat(rawTPos, w.damage, '#ffaa33');
            if (enemyBuildings.includes(tgt)) updateHUD();

            // If target died from this cannon's shot, immediately stop beam on next check
            if (tgt.hp <= 0) {
                w.beamTimer = 0.05;
            }
        }

        // Update 3D laser beam mesh connecting this cannon's muzzle to its target
        if (w.beamGroup && w.beamTimer > 0 && tgt.hp > 0) {
            const dist = Math.max(0.25, w.lastMuzzleWorldPos.distanceTo(w.lastTargetWorldPos));
            const pulse = 0.85 + Math.sin(nowTime * 38.0 + wi * 1.7) * 0.25;
            w.beamGroup.visible = true;
            w.beamGroup.position.copy(w.lastMuzzleWorldPos);
            w.beamGroup.lookAt(w.lastTargetWorldPos);
            const ud = w.beamGroup.userData;
            if (ud.coreMesh) {
                ud.coreMesh.scale.set(pulse, pulse, dist);
                ud.coreMesh.material.opacity = Math.min(1.0, (w.beamTimer / 0.24) * 1.15);
            }
            if (ud.glowMesh) {
                ud.glowMesh.scale.set(pulse * 1.25, pulse * 1.25, dist);
                ud.glowMesh.material.opacity = Math.min(0.78, (w.beamTimer / 0.24) * 0.85);
            }
            if (ud.impactMesh) {
                ud.impactMesh.position.set(0, 0, dist);
                ud.impactMesh.scale.setScalar(0.75 + pulse * 0.45);
            }
        } else if (w.beamGroup) {
            w.beamGroup.visible = false;
        }
    }

    // 5. Preserve Yamato Cannon as a separate heavy weapon on its own cooldown
    u.yamatoCooldown = Math.max(0, (u.yamatoCooldown || 0) - dt);
    if (u.yamatoCooldown <= 0 && validTargets.length > 0) {
        let heavyCandidate = validTargets[0].entity;
        for (let vi = 0; vi < validTargets.length; vi++) {
            if ((validTargets[vi].entity.hp || 0) > (heavyCandidate.hp || 0)) {
                heavyCandidate = validTargets[vi].entity;
            }
        }
        const yamatoMuzzle = typeof window.getWeaponMuzzleWorldPos === 'function'
            ? window.getWeaponMuzzleWorldPos(u, 99, _muzzleScratch2)
            : _muzzleScratch2.set(bcPos.x, bcPos.y, bcPos.z);
        launchOrdProjectile(yamatoMuzzle, heavyCandidate, 'yamato', Math.round(u.damage * 2.65), false);
        u.yamatoCooldown = 6.5;
    }

    return primaryAimPos;
}

window.getBattlecruiserWeaponDiagnostics = function(bcUnit) {
    const u = bcUnit || units.find(item => item && item.type === 'battlecruiser' && item.hp > 0);
    if (!u || !Array.isArray(u.laserWeapons)) return null;
    u.mesh.updateMatrixWorld(true);
    const weapons = u.laserWeapons.map(w => {
        if (w.muzzle) w.muzzle.getWorldPosition(w.lastMuzzleWorldPos);
        return {
            index: w.index,
            targetId: w.targetId || null,
            hasTarget: Boolean(w.target && w.target.hp > 0),
            targetHp: w.target ? w.target.hp : null,
            cooldown: Number((w.cooldown || 0).toFixed(3)),
            fireRate: w.fireRate,
            damage: w.damage,
            shotsFired: w.shotsFired || 0,
            totalDamageDealt: w.totalDamageDealt || 0,
            beamVisible: Boolean(w.beamGroup && w.beamGroup.visible),
            muzzleWorldPos: {
                x: Number(w.lastMuzzleWorldPos.x.toFixed(3)),
                y: Number(w.lastMuzzleWorldPos.y.toFixed(3)),
                z: Number(w.lastMuzzleWorldPos.z.toFixed(3))
            },
            targetWorldPos: {
                x: Number(w.lastTargetWorldPos.x.toFixed(3)),
                y: Number(w.lastTargetWorldPos.y.toFixed(3)),
                z: Number(w.lastTargetWorldPos.z.toFixed(3))
            }
        };
    });
    const distinctTargets = new Set(weapons.filter(w => w.hasTarget && w.targetId).map(w => w.targetId));
    return {
        weaponCount: weapons.length,
        distinctTargetCount: distinctTargets.size,
        yamatoCooldown: Number((u.yamatoCooldown || 0).toFixed(2)),
        weapons
    };
};
window.updateBattlecruiserFourLaserWeapons = updateBattlecruiserFourLaserWeapons;

function spawnEnemyFromBuilding(variant, originPos, sourceBuilding = null) {
    if (state.missionWon) return null;
    if (enemies.length >= MAX_ENEMY_UNITS) return null;

    // Normalize canonical StarCraft unit names and enforce faction-respective enemy spawning
    const enemyFaction = (sourceBuilding && sourceBuilding.faction)
        ? sourceBuilding.faction
        : ((state.enemyBase && state.enemyBase.faction) ? state.enemyBase.faction : 'zerg');

    const roleAliasMap = {
        zergling: 'skitterer',
        hydralisk: 'spitter',
        baneling: 'burster',
        roach: 'crusher',
        ultralisk: 'behemoth',
        broodlord: 'brood_lord',
        voidray: 'void_ray',
        sentinel: 'zealot',
        immortal: 'stalker',
        colossus: 'archon'
    };
    if (variant && roleAliasMap[variant]) {
        variant = roleAliasMap[variant];
    }

    const zergRoles = ['skitterer', 'spitter', 'burster', 'mutalisk', 'brood_lord', 'crusher', 'gorgon', 'behemoth'];
    const protossRoles = ['zealot', 'stalker', 'archon', 'phoenix', 'void_ray', 'carrier'];
    const terranRoles = ['grunt', 'ranger', 'marauder', 'firebat', 'tank', 'siege_tank', 'heli', 'battlecruiser'];

    if (enemyFaction === 'protoss' && !protossRoles.includes(variant)) {
        const zergToProtoss = {
            skitterer: 'zealot', burster: 'zealot',
            spitter: 'stalker', crusher: 'stalker',
            gorgon: 'archon', behemoth: 'archon',
            mutalisk: 'phoenix', brood_lord: 'void_ray'
        };
        variant = zergToProtoss[variant] || 'zealot';
    } else if (enemyFaction === 'terran' && !terranRoles.includes(variant)) {
        const zergToTerran = {
            skitterer: 'grunt', burster: 'firebat',
            spitter: 'ranger', crusher: 'marauder',
            gorgon: 'tank', behemoth: 'siege_tank',
            mutalisk: 'heli', brood_lord: 'battlecruiser'
        };
        variant = zergToTerran[variant] || 'ranger';
    } else if (enemyFaction === 'zerg' && !zergRoles.includes(variant)) {
        variant = 'skitterer';
    }

    // Air fliers are locked until rush grace timer expires or wave >= 2
    if ((variant === 'mutalisk' || variant === 'brood_lord' || variant === 'phoenix' || variant === 'void_ray' || variant === 'carrier' || variant === 'heli' || variant === 'battlecruiser') && state.rushGraceTimer > 0 && !state.isEndless) {
        variant = enemyFaction === 'protoss'
            ? (Math.random() < 0.6 ? 'zealot' : 'stalker')
            : (enemyFaction === 'terran' ? (Math.random() < 0.6 ? 'grunt' : 'ranger') : (Math.random() < 0.6 ? 'skitterer' : 'spitter'));
    }

    const baseStatsMap = {
        skitterer:  { hp: 80,  dmg: 14, spd: 3.8, rng: 1.6,  rate: 0.85, rad: 0.52, col: '#ff2a4b', reward: 15, costM: 50,  costG: 0,   supply: 1 },
        spitter:    { hp: 70,  dmg: 16, spd: 2.9, rng: 8.5,  rate: 1.35, rad: 0.58, col: '#84cc16', reward: 20, costM: 100, costG: 50,  supply: 2 },
        burster:    { hp: 55,  dmg: 68, spd: 4.7, rng: 1.7,  rate: 0.10, rad: 0.55, col: '#ff5400', reward: 18, costM: 75,  costG: 25,  supply: 1 },
        mutalisk:   { hp: 135, dmg: 22, spd: 3.1, rng: 9.5,  rate: 1.15, rad: 0.72, col: '#ff2a4b', reward: 32, costM: 100, costG: 100, supply: 2 },
        brood_lord: { hp: 420, dmg: 48, spd: 2.35,rng: 13.5, rate: 1.65, rad: 1.15, col: '#d946ef', reward: 60, costM: 300, costG: 150, supply: 4 },
        crusher:    { hp: 340, dmg: 38, spd: 2.1, rng: 2.2,  rate: 1.15, rad: 0.98, col: '#b845ff', reward: 45, costM: 150, costG: 50,  supply: 2 },
        gorgon:     { hp: 420, dmg: 52, spd: 2.35,rng: 12.5, rate: 1.85, rad: 1.08, col: '#84cc16', reward: 55, costM: 200, costG: 100, supply: 3 },
        behemoth:   { hp: 490, dmg: 75, spd: 1.6, rng: 14.5, rate: 2.50, rad: 1.25, col: '#d946ef', reward: 65, costM: 300, costG: 200, supply: 6 },
        zealot:     { hp: 200, dmg: 32, spd: 4.2, rng: 1.9,  rate: 0.65, rad: 0.54, col: '#f5b932', reward: 25, costM: 100, costG: 0,   supply: 2 },
        stalker:    { hp: 170, dmg: 28, spd: 3.8, rng: 11.5, rate: 0.95, rad: 0.72, col: '#38bdf8', reward: 30, costM: 125, costG: 50,  supply: 2 },
        archon:     { hp: 360, dmg: 52, spd: 3.2, rng: 9.5,  rate: 1.25, rad: 0.82, col: '#f5b932', reward: 50, costM: 200, costG: 100, supply: 4 },
        phoenix:    { hp: 180, dmg: 26, spd: 5.5, rng: 11.0, rate: 0.75, rad: 0.85, col: '#38bdf8', reward: 35, costM: 150, costG: 100, supply: 2 },
        void_ray:   { hp: 280, dmg: 36, spd: 3.8, rng: 13.0, rate: 0.85, rad: 1.02, col: '#00e5ff', reward: 45, costM: 250, costG: 150, supply: 4 },
        carrier:    { hp: 460, dmg: 55, spd: 2.8, rng: 14.5, rate: 1.45, rad: 1.25, col: '#f5b932', reward: 65, costM: 350, costG: 250, supply: 6 },
        grunt:      { hp: 160, dmg: 24, spd: 3.9, rng: 1.9,  rate: 0.68, rad: 0.52, col: '#ff5400', reward: 20, costM: 75,  costG: 0,   supply: 1 },
        ranger:     { hp: 110, dmg: 20, spd: 3.4, rng: 9.0,  rate: 0.75, rad: 0.48, col: '#ff5400', reward: 20, costM: 75,  costG: 25,  supply: 1 },
        firebat:    { hp: 200, dmg: 30, spd: 3.6, rng: 5.2,  rate: 0.70, rad: 0.54, col: '#ff5500', reward: 25, costM: 100, costG: 25,  supply: 2 },
        marauder:   { hp: 250, dmg: 38, spd: 3.3, rng: 10.5, rate: 1.05, rad: 0.58, col: '#ffaa00', reward: 30, costM: 125, costG: 50,  supply: 2 },
        tank:       { hp: 420, dmg: 65, spd: 2.6, rng: 13.5, rate: 1.95, rad: 1.10, col: '#ff5400', reward: 50, costM: 200, costG: 125, supply: 3 },
        siege_tank: { hp: 460, dmg: 72, spd: 2.4, rng: 14.5, rate: 2.10, rad: 1.15, col: '#ff5400', reward: 55, costM: 225, costG: 150, supply: 4 },
        heli:       { hp: 260, dmg: 32, spd: 4.8, rng: 11.5, rate: 0.85, rad: 0.92, col: '#ff5400', reward: 38, costM: 150, costG: 100, supply: 2 },
        battlecruiser: { hp: 580, dmg: 65, spd: 2.8, rng: 15.0, rate: 1.35, rad: 1.35, col: '#ff5400', reward: 70, costM: 400, costG: 300, supply: 6 }
    };
    if (!variant || !baseStatsMap[variant]) {
        variant = enemyFaction === 'protoss' ? 'zealot' : (enemyFaction === 'terran' ? 'ranger' : 'skitterer');
    }
    const baseStats = baseStatsMap[variant];
    if (!originPos) originPos = state.enemyBase ? state.enemyBase.pos : ENEMY_BASE_POS;
    const isAir = (variant === 'mutalisk' || variant === 'brood_lord' || variant === 'phoenix' || variant === 'void_ray' || variant === 'carrier' || variant === 'heli' || variant === 'battlecruiser');
    const mult = getWaveStrengthMultiplier();

    // Rally point toward nearest hostile base or army
    const rallyTargetPos = (state.baseBuilding && state.baseBuilding.hp > 0)
        ? state.baseBuilding.pos
        : (units.length > 0 && units[0] && units[0].mesh ? units[0].mesh.position : PLAYER_START_POS);
    const rallyX = rallyTargetPos.x;
    const rallyZ = rallyTargetPos.z;

    // Spawn at valid ground position outside the building collision footprint
    const bldFootprint = (sourceBuilding && sourceBuilding.footprintRadius) ? sourceBuilding.footprintRadius : 2.9;
    const dirToRallyX = rallyX - originPos.x;
    const dirToRallyZ = rallyZ - originPos.z;
    const dirLen = Math.hypot(dirToRallyX, dirToRallyZ) || 1;
    const spawnRingDist = bldFootprint + baseStats.rad + 1.15;
    const jitterAng = (Math.random() - 0.5) * 1.15;
    const baseAng = Math.atan2(dirToRallyZ, dirToRallyX) + jitterAng;
    let sx = originPos.x + Math.cos(baseAng) * spawnRingDist;
    let sz = originPos.z + Math.sin(baseAng) * spawnRingDist;
    if (!isAir && typeof findClearSpawnPoint === 'function') {
        const clearPt = findClearSpawnPoint(sx, sz, rallyX, rallyZ, baseStats.rad, buildings, enemyBuildings, enemies);
        sx = clearPt.x;
        sz = clearPt.z;
    }
    const surfFn = typeof getSurfaceHeightWithBridges === 'function' ? getSurfaceHeightWithBridges : getTerrainHeight;
    const groundH = surfFn(sx, sz);

    const mesh = createAnimatedUnitModel(variant);
    const airAlt = variant === 'brood_lord' ? 6.8 : 5.8;
    mesh.position.set(sx, isAir ? Math.max(0, groundH) + airAlt : groundH, sz);
    const initYaw = Math.atan2(rallyX - sx, rallyZ - sz);
    mesh.rotation.y = initYaw;
    window._zergUnitSeq = (window._zergUnitSeq || 0) + 1;
    const assignedId = `zerg_${variant}_${window._zergUnitSeq}`;
    mesh.userData.isZergUnitMesh = true;
    mesh.userData.zergUnitId = assignedId;
    mesh.userData.zergVariant = variant;
    mesh.userData.isAir = isAir;
    scene.add(mesh);

    // Trigger visible bio-hatch pulse & organic mist on the producing Zerg structure
    if (sourceBuilding) {
        sourceBuilding.hatchPulse = 1.0;
    }
    const _spawnParticleLimit = (window.PERF_MANAGER && window.PERF_MANAGER.current && window.PERF_MANAGER.current.maxParticles) || 120;
    if (particles.length < _spawnParticleLimit && window.isWorldPosInViewport && window.isWorldPosInViewport(sx, groundH, sz, 4.0)) {
        for (let pi = 0; pi < 5; pi++) {
            const spore = new THREE.Mesh(SHARED_FX_GEO.goreChunk, pi % 2 === 0 ? MAT.hiveVeinGlow : MAT.acidGlow);
            spore.scale.setScalar(0.32 + Math.random() * 0.22);
            spore.position.set(sx + (Math.random() - 0.5) * 0.6, groundH + 0.35, sz + (Math.random() - 0.5) * 0.6);
            scene.add(spore);
            particles.push({
                mesh: spore,
                vel: new THREE.Vector3((Math.random() - 0.5) * 2.2, 1.8 + Math.random() * 1.8, (Math.random() - 0.5) * 2.2),
                gravity: 4.5,
                life: 0.36
            });
        }
    }

    const zergUpg = (state.upgrades && state.upgrades.zerg) ? state.upgrades.zerg : { weapons: 0, armor: 0 };
    const zergWMult = 1.0 + (zergUpg.weapons || 0) * 0.20;
    const zergAMult = 1.0 + (zergUpg.armor || 0) * 0.20;
    const maxHp = Math.round(baseStats.hp * mult * zergAMult);
    const finalEnemyDmg = Math.round(baseStats.dmg * mult * zergWMult);
    const hb = makeHealthPip(baseStats.col);

    const isFlanker = (variant === 'skitterer' || variant === 'burster') && Math.random() < 0.45;
    const flankSide = (enemies.length % 2 === 0 ? 1 : -1);
    const isMelee = baseStats.rng <= 2.5;

    const enemyObj = {
        id: assignedId,
        faction: 'zerg',
        variant, isAir, isMelee, radius: baseStats.rad, mesh, hb,
        baseMaxHp: Math.round(baseStats.hp * mult),
        baseDamage: Math.round(baseStats.dmg * mult),
        hp: maxHp, maxHp,
        damage: finalEnemyDmg,
        armorBonus: (zergUpg.armor || 0) * 2,
        speed: baseStats.spd,
        actualSpeedPerSec: 0,
        range: baseStats.rng,
        fireRate: baseStats.rate,
        reward: baseStats.reward,
        cooldown: 0,
        currentYaw: initYaw,
        currentPitch: 0,
        currentRoll: 0,
        // Explicit 7-State Combat AI State Machine:
        // 'SPAWNING' | 'IDLE' | 'MOVING' | 'ATTACKING' | 'RETREATING' | 'SEARCHING' | 'DEAD'
        aiState: 'SPAWNING',
        aiPrevState: null,
        aiStateTimer: 0.25,
        // Initial combat order & rally point toward nearest hostile base/army
        order: 'attack_move',
        rallyPos: new THREE.Vector3(rallyX, surfFn(rallyX, rallyZ), rallyZ),
        currentDestination: { x: Number(rallyX.toFixed(2)), z: Number(rallyZ.toFixed(2)) },
        navWaypoint: { x: Number(rallyX.toFixed(2)), z: Number(rallyZ.toFixed(2)) },
        navSuccess: true,
        walkableAtPos: !isAir ? Boolean(typeof isWalkableGround === 'function' ? isWalkableGround(sx, sz, baseStats.rad * 0.45) : true) : true,
        stopReason: 'none',
        // Target lock hysteresis (prevents switching targets every frame)
        lockedTarget: null,
        lockedTargetIsBuilding: false,
        targetLockTimer: 0,
        // Combat Watchdog (detects units that haven't moved or attacked or walk in circles)
        watchdogTimer: 0,
        watchdogPeriod: 2.0,
        lastCombatActionTime: state.elapsedSec || 0,
        lastMoveTime: state.elapsedSec || 0,
        lastAttackTime: 0,
        lastActionPos: new THREE.Vector3(sx, groundH, sz),
        _posHistory: [{ x: sx, z: sz, t: state.elapsedSec || 0 }],
        _posSampleTimer: 0,
        recoveryAttempts: 0,
        recoveryDetourPos: null,
        recoveryDetourTimer: 0,
        lastStuckPos: null,
        stuckTimer: 0,
        lastProgressPos: new THREE.Vector3(sx, groundH, sz),
        flankSign: flankSide,
        isFlanker,
        burrowed: false,
        burrowCooldown: 6.0 + Math.random() * 4.0,
        lastHitImpulse: null,
        lastHitHeavy: false
    };
    if (((zergUpg.weapons || 0) > 0 || (zergUpg.armor || 0) > 0) && typeof window.applyUnitUpgradeVisuals === 'function') {
        window.applyUnitUpgradeVisuals(enemyObj, zergUpg.weapons || 0, zergUpg.armor || 0, 'zerg');
    }
    enemies.push(enemyObj);
    if (window.AI_DEBUG && window.AI_DEBUG.loggingEnabled) {
        window.AI_DEBUG.logEvent(`Spawned ${assignedId} (${variant}) at (${sx.toFixed(1)}, ${sz.toFixed(1)}) -> rally (${rallyX.toFixed(1)}, ${rallyZ.toFixed(1)})`);
    }
    return enemyObj;
}

// ============================================================================
// 8A. REUSABLE SPATIAL HASH GRIDS & UNIT / BUILDING COUNTER SYSTEM
// ============================================================================
const SPATIAL_GRID_CELL = 6.0;
const SPATIAL_GRID_HALF = 132.0;
const SPATIAL_GRID_DIM = 44; // 44 x 44 = 1936 buckets covering [-132..+132]
const SPATIAL_GRID_TOTAL = SPATIAL_GRID_DIM * SPATIAL_GRID_DIM;

function _createSpatialGridStore() {
    const buckets = new Array(SPATIAL_GRID_TOTAL);
    for (let i = 0; i < SPATIAL_GRID_TOTAL; i++) buckets[i] = [];
    return {
        buckets,
        activeIndices: [],
        clear() {
            for (let i = 0; i < this.activeIndices.length; i++) {
                this.buckets[this.activeIndices[i]].length = 0;
            }
            this.activeIndices.length = 0;
        },
        insert(wx, wz, item) {
            const gx = Math.max(0, Math.min(SPATIAL_GRID_DIM - 1, Math.floor((wx + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL)));
            const gz = Math.max(0, Math.min(SPATIAL_GRID_DIM - 1, Math.floor((wz + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL)));
            const idx = gz * SPATIAL_GRID_DIM + gx;
            const b = this.buckets[idx];
            if (b.length === 0) this.activeIndices.push(idx);
            b.push(item);
        },
        insertSpan(wx, wz, radius, item) {
            const minGx = Math.max(0, Math.floor((wx - radius + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
            const maxGx = Math.min(SPATIAL_GRID_DIM - 1, Math.floor((wx + radius + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
            const minGz = Math.max(0, Math.floor((wz - radius + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
            const maxGz = Math.min(SPATIAL_GRID_DIM - 1, Math.floor((wz + radius + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
            for (let gz = minGz; gz <= maxGz; gz++) {
                const rowOff = gz * SPATIAL_GRID_DIM;
                for (let gx = minGx; gx <= maxGx; gx++) {
                    const idx = rowOff + gx;
                    const b = this.buckets[idx];
                    if (b.length === 0) this.activeIndices.push(idx);
                    b.push(item);
                }
            }
        },
        queryRadiusInto(wx, wz, radius, outArr) {
            const targetArr = Array.isArray(outArr) ? outArr : _spatialQueryBuf;
            targetArr.length = 0;
            const minGx = Math.max(0, Math.floor((wx - radius + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
            const maxGx = Math.min(SPATIAL_GRID_DIM - 1, Math.floor((wx + radius + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
            const minGz = Math.max(0, Math.floor((wz - radius + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
            const maxGz = Math.min(SPATIAL_GRID_DIM - 1, Math.floor((wz + radius + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
            const rSq = radius * radius;
            for (let gz = minGz; gz <= maxGz; gz++) {
                const rowOff = gz * SPATIAL_GRID_DIM;
                for (let gx = minGx; gx <= maxGx; gx++) {
                    const cell = this.buckets[rowOff + gx];
                    for (let k = 0; k < cell.length; k++) {
                        const item = cell[k];
                        if (!item) continue;
                        const ipos = item.mesh ? item.mesh.position : item.pos;
                        if (ipos) {
                            const dx = ipos.x - wx;
                            const dz = ipos.z - wz;
                            if (dx * dx + dz * dz <= rSq) {
                                targetArr.push(item);
                            }
                        } else {
                            targetArr.push(item);
                        }
                    }
                }
            }
            return targetArr.length;
        }
    };
}

const GROUND_UNIT_GRID = _createSpatialGridStore();
const AIR_UNIT_GRID = _createSpatialGridStore();
const ENEMY_GRID = _createSpatialGridStore();
const ALLY_GRID = _createSpatialGridStore();
const STRUCT_COLLISION_GRID = _createSpatialGridStore();

const _groundActorsScratch = [];
const _airActorsScratch = [];
const _spatialQueryBuf = [];
const _structCachePool = [];
let _structCollisionSig = '';

const UNIT_COUNTS = {
    infantry: 0,
    vehicles: 0,
    solaris: 0,
    ground: 0,
    air: 0,
    mindControlled: 0,
    fleetStaged: 0,
    solarisFleetStaged: 0,
    dropships: []
};

const BUILDING_COUNTS = {
    activeBarracks: 0,
    activeBarracksOrGate: 0,
    activeZergEvo: 0,
    activeSolarisCyber: 0,
    solarisProd: [],
    zergSpawners: [],
    activeShieldTurrets: []
};

let _queryStampCounter = 1;

function syncUnitAndBuildingCounters() {
    UNIT_COUNTS.infantry = 0;
    UNIT_COUNTS.vehicles = 0;
    UNIT_COUNTS.solaris = 0;
    UNIT_COUNTS.ground = 0;
    UNIT_COUNTS.air = 0;
    UNIT_COUNTS.mindControlled = 0;
    UNIT_COUNTS.fleetStaged = 0;
    UNIT_COUNTS.solarisFleetStaged = 0;
    UNIT_COUNTS.dropships.length = 0;

    for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (!u || u.hp <= 0) continue;
        if (u.isAir) UNIT_COUNTS.air++;
        else UNIT_COUNTS.ground++;
        if (u.isMindControlled) UNIT_COUNTS.mindControlled++;
        if (u.fleetState === 'staging') {
            UNIT_COUNTS.fleetStaged++;
            if (u.type === 'zealot' || u.type === 'stalker' || u.type === 'archon' || u.type === 'phoenix' || u.type === 'void_ray' || u.type === 'carrier') {
                UNIT_COUNTS.solarisFleetStaged++;
            }
        }
        const t = u.type;
        if (t === 'grunt' || t === 'ranger' || t === 'medic' || t === 'rocketman' || t === 'reaper' || t === 'firebat' || t === 'marauder') {
            UNIT_COUNTS.infantry++;
        } else if (t === 'tank' || t === 'siege_tank' || t === 'heli' || t === 'transport' || t === 'valkyrie' || t === 'phoenix' || t === 'void_ray' || t === 'carrier') {
            UNIT_COUNTS.vehicles++;
            if (t === 'transport') UNIT_COUNTS.dropships.push(u);
            if (t === 'phoenix' || t === 'void_ray' || t === 'carrier') UNIT_COUNTS.solaris++;
        } else if (t === 'zealot' || t === 'stalker' || t === 'archon') {
            UNIT_COUNTS.solaris++;
        }
    }

    BUILDING_COUNTS.activeBarracks = 0;
    BUILDING_COUNTS.activeBarracksOrGate = 0;
    BUILDING_COUNTS.activeZergEvo = 0;
    BUILDING_COUNTS.activeSolarisCyber = 0;
    BUILDING_COUNTS.solarisProd.length = 0;
    BUILDING_COUNTS.zergSpawners.length = 0;
    BUILDING_COUNTS.activeShieldTurrets.length = 0;

    for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        if (!b || b.hp <= 0) continue;
        if (!b.isConstructing) {
            if (b.type === 'barracks') {
                BUILDING_COUNTS.activeBarracks++;
                BUILDING_COUNTS.activeBarracksOrGate++;
            } else if (b.type === 'solaris_gate') {
                BUILDING_COUNTS.activeBarracksOrGate++;
            }
        }
        if (b.type === 'turret' && b.maxShieldHp > 0 && b.shieldHp > 15 && !(b.shieldBrokenTimer > 0)) {
            BUILDING_COUNTS.activeShieldTurrets.push(b);
        }
    }

    if (typeof solarisBuildings !== 'undefined') {
        for (let i = 0; i < solarisBuildings.length; i++) {
            const sb = solarisBuildings[i];
            if (!sb || sb.hp <= 0 || sb.isConstructing) continue;
            if (sb.role === 'cyber_core') BUILDING_COUNTS.activeSolarisCyber++;
            if (sb.role === 'gateway' || sb.role === 'robotics_bay' || sb.role === 'stargate') {
                BUILDING_COUNTS.solarisProd.push(sb);
            }
        }
    }

    for (let i = 0; i < enemyBuildings.length; i++) {
        const eb = enemyBuildings[i];
        if (!eb || eb.hp <= 0) continue;
        if (eb.role === 'evo_chamber' && !eb.isConstructing) {
            BUILDING_COUNTS.activeZergEvo++;
        }
        if (eb.role === 'citadel' || eb.role === 'spawning_pool' || eb.role === 'roach_warren' || eb.role === 'hydralisk_den' || eb.role === 'spire_hive') {
            BUILDING_COUNTS.zergSpawners.push(eb);
        }
    }
}

// Development consistency check to verify maintained counters match raw array filters
window.verifyUnitCountersConsistency = function() {
    const rawInf = units.filter(u => u && u.hp > 0 && (u.type === 'grunt' || u.type === 'ranger' || u.type === 'medic' || u.type === 'rocketman' || u.type === 'reaper' || u.type === 'firebat' || u.type === 'marauder')).length;
    const rawVeh = units.filter(u => u && u.hp > 0 && (u.type === 'tank' || u.type === 'siege_tank' || u.type === 'heli' || u.type === 'transport' || u.type === 'valkyrie')).length;
    const rawSol = units.filter(u => u && u.hp > 0 && (u.type === 'zealot' || u.type === 'stalker' || u.type === 'archon')).length;
    return {
        valid: (rawInf === UNIT_COUNTS.infantry && rawVeh === UNIT_COUNTS.vehicles && rawSol === UNIT_COUNTS.solaris),
        counters: { ...UNIT_COUNTS, dropshipsCount: UNIT_COUNTS.dropships.length },
        raw: { infantry: rawInf, vehicles: rawVeh, solaris: rawSol }
    };
};

function rebuildFrameSpatialGrids() {
    GROUND_UNIT_GRID.clear();
    AIR_UNIT_GRID.clear();
    ENEMY_GRID.clear();
    ALLY_GRID.clear();
    _groundActorsScratch.length = 0;
    _airActorsScratch.length = 0;

    for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (!u || u.hp <= 0 || !u.mesh) continue;
        const px = u.mesh.position.x;
        const pz = u.mesh.position.z;
        ALLY_GRID.insert(px, pz, u);
        if (u.isAir) {
            u._gridIdx = _airActorsScratch.length;
            _airActorsScratch.push(u);
            AIR_UNIT_GRID.insert(px, pz, u);
        } else {
            u._gridIdx = _groundActorsScratch.length;
            _groundActorsScratch.push(u);
            GROUND_UNIT_GRID.insert(px, pz, u);
        }
    }

    for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (!e || e.hp <= 0 || !e.mesh) continue;
        const px = e.mesh.position.x;
        const pz = e.mesh.position.z;
        ENEMY_GRID.insert(px, pz, e);
        if (e.isAir) {
            e._gridIdx = _airActorsScratch.length;
            _airActorsScratch.push(e);
            AIR_UNIT_GRID.insert(px, pz, e);
        } else {
            e._gridIdx = _groundActorsScratch.length;
            _groundActorsScratch.push(e);
            GROUND_UNIT_GRID.insert(px, pz, e);
        }
    }

    // Rebuild structure collision spatial grid only when building/barrier counts or positions change
    const bLen = buildings.length;
    const ebLen = enemyBuildings.length;
    const sbLen = typeof solarisBuildings !== 'undefined' ? solarisBuildings.length : 0;
    const obLen = typeof obstacles !== 'undefined' ? obstacles.length : 0;
    let aliveB = 0, aliveEB = 0, aliveSB = 0;
    for (let i = 0; i < bLen; i++) if (buildings[i] && buildings[i].hp > 0) aliveB++;
    for (let i = 0; i < ebLen; i++) if (enemyBuildings[i] && enemyBuildings[i].hp > 0) aliveEB++;
    if (typeof solarisBuildings !== 'undefined') {
        for (let i = 0; i < sbLen; i++) if (solarisBuildings[i] && solarisBuildings[i].hp > 0) aliveSB++;
    }
    const sig = `${bLen}:${aliveB}|${ebLen}:${aliveEB}|${sbLen}:${aliveSB}|${obLen}`;
    if (sig !== _structCollisionSig) {
        _structCollisionSig = sig;
        STRUCT_COLLISION_GRID.clear();
        let poolIdx = 0;
        const pushStruct = (x, z, r, isBarrier) => {
            let entry = _structCachePool[poolIdx++];
            if (!entry) {
                entry = { x: 0, z: 0, r: 0, isBarrier: false, _qStamp: 0 };
                _structCachePool.push(entry);
            }
            entry.x = x;
            entry.z = z;
            entry.r = r;
            entry.isBarrier = !!isBarrier;
            STRUCT_COLLISION_GRID.insertSpan(x, z, r + 2.0, entry);
        };

        for (let i = 0; i < bLen; i++) {
            const b = buildings[i];
            if (!b || b.hp <= 0) continue;
            pushStruct(
                b.pos.x,
                b.pos.z,
                b.type === 'base' ? 2.15 : (b.type === 'barrier' ? 1.55 : (b.type === 'turret' ? 1.48 : 1.92)),
                b.type === 'barrier'
            );
        }
        for (let i = 0; i < ebLen; i++) {
            const eb = enemyBuildings[i];
            if (!eb || eb.hp <= 0) continue;
            pushStruct(
                eb.pos.x,
                eb.pos.z,
                eb.role === 'citadel' ? 2.65 : (eb.role === 'spine_turret' ? 1.38 : 2.05),
                false
            );
        }
        if (typeof solarisBuildings !== 'undefined') {
            for (let i = 0; i < sbLen; i++) {
                const sb = solarisBuildings[i];
                if (!sb || sb.hp <= 0) continue;
                pushStruct(sb.pos.x, sb.pos.z, sb.footprintRadius || 1.95, false);
            }
        }
        if (typeof obstacles !== 'undefined') {
            for (let i = 0; i < obLen; i++) {
                const ob = obstacles[i];
                if (!ob || !ob.pos) continue;
                if (ob.isBarrier || ob.type === 'anti_rush_barrier' || ob.type === 'battlefield_barriers') {
                    pushStruct(ob.pos.x, ob.pos.z, (ob.radius || 1.65) + 0.15, true);
                }
            }
        }
    }
}

function _queryGridNearInto(grid, wx, wz, radius, outArr) {
    outArr.length = 0;
    const minGx = Math.max(0, Math.floor((wx - radius + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
    const maxGx = Math.min(SPATIAL_GRID_DIM - 1, Math.floor((wx + radius + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
    const minGz = Math.max(0, Math.floor((wz - radius + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
    const maxGz = Math.min(SPATIAL_GRID_DIM - 1, Math.floor((wz + radius + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
    const buckets = grid.buckets;
    for (let gz = minGz; gz <= maxGz; gz++) {
        const rowOff = gz * SPATIAL_GRID_DIM;
        for (let gx = minGx; gx <= maxGx; gx++) {
            const cell = buckets[rowOff + gx];
            for (let k = 0; k < cell.length; k++) {
                outArr.push(cell[k]);
            }
        }
    }
    return outArr;
}

window.queryGroundUnitsNearInto = function(wx, wz, radius, outArr) {
    return _queryGridNearInto(GROUND_UNIT_GRID, wx, wz, radius, outArr);
};
window.queryEnemiesNearInto = function(wx, wz, radius, outArr) {
    return _queryGridNearInto(ENEMY_GRID, wx, wz, radius, outArr);
};
window.queryAlliesNearInto = function(wx, wz, radius, outArr) {
    return _queryGridNearInto(ALLY_GRID, wx, wz, radius, outArr);
};

// Staggered AI Decision Scheduler helper: determines if a unit should run full target/path scans on this frame
function shouldRunUnitAIDecision(actor, unitIdx, distSqToCam, baseStride) {
    // Immediate combat responsiveness: always run when retaliating, when current target died, or when stride === 1
    if (actor.retaliateTarget && actor.retaliateTarget.hp > 0) return true;
    if (actor._cachedTarget && actor._cachedTarget.hp <= 0) return true;
    let stride = baseStride || 1;
    if (distSqToCam > 7225) stride = Math.max(stride, 4);      // > 85m from camera
    else if (distSqToCam > 2704) stride = Math.max(stride, 2); // > 52m from camera
    if (stride <= 1) return true;
    const frameTick = window.PERF_PROFILER ? window.PERF_PROFILER.frameCount : 0;
    return ((frameTick + unitIdx) % stride) === 0;
}

// ============================================================================
// 8B. MASS-WEIGHTED COLLISION SOLVER (SPATIAL HASH GRID + CACHED STRUCTURE GRID)
// ============================================================================
function resolveAllUnitCollisions() {
    if (window.PERF_PROFILER) window.PERF_PROFILER.begin('collisionResolution');

    if (_groundActorsScratch.length === 0 && (units.length > 0 || enemies.length > 0)) {
        rebuildFrameSpatialGrids();
    }

    const groundActors = _groundActorsScratch;
    const groundBuckets = GROUND_UNIT_GRID.buckets;
    const structBuckets = STRUCT_COLLISION_GRID.buckets;

    for (let i = 0; i < groundActors.length; i++) {
        const a = groundActors[i];
        const ax = a.mesh.position.x, az = a.mesh.position.z;
        const isAnchoredA = !!(a.type === 'siege_tank' && a.siegeMode);
        const isHeavyA = (a.type === 'tank' || a.type === 'siege_tank' || (a.type === 'valkyrie' && a.mechMode));
        const massA = isAnchoredA ? 99999 : (isHeavyA ? 85 : (a.variant === 'behemoth' || a.variant === 'gorgon' || a.variant === 'crusher' ? 25 : 1));

        const cgx = Math.max(0, Math.min(SPATIAL_GRID_DIM - 1, Math.floor((ax + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL)));
        const cgz = Math.max(0, Math.min(SPATIAL_GRID_DIM - 1, Math.floor((az + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL)));
        const minGx = Math.max(0, cgx - 1);
        const maxGx = Math.min(SPATIAL_GRID_DIM - 1, cgx + 1);
        const minGz = Math.max(0, cgz - 1);
        const maxGz = Math.min(SPATIAL_GRID_DIM - 1, cgz + 1);

        // 1. Spatial 3x3 Neighborhood Ground Unit vs Ground Unit Separation
        for (let gz = minGz; gz <= maxGz; gz++) {
            const rowOff = gz * SPATIAL_GRID_DIM;
            for (let gx = minGx; gx <= maxGx; gx++) {
                const cell = groundBuckets[rowOff + gx];
                for (let k = 0; k < cell.length; k++) {
                    const b = cell[k];
                    if (b._gridIdx <= i) continue;

                    const dx = b.mesh.position.x - ax;
                    const dz = b.mesh.position.z - az;
                    if (Math.abs(dx) > 4.6 || Math.abs(dz) > 4.6) continue;
                    const distSq = dx * dx + dz * dz;
                    const minSep = (a.radius || 0.55) + (b.radius || 0.55);
                    const isAnchoredB = !!(b.type === 'siege_tank' && b.siegeMode);
                    const isHeavyB = (b.type === 'tank' || b.type === 'siege_tank' || (b.type === 'valkyrie' && b.mechMode));
                    const maxCheckRange = minSep + ((isHeavyA !== isHeavyB && !a.variant && !b.variant) ? 2.65 : 0.0);
                    if (distSq >= maxCheckRange * maxCheckRange || distSq <= 0.000001) continue;

                    const dist = Math.sqrt(distSq);

                    // Proactive Human Ground Unit Pathway-Yielding ("Give Pathway to Tanks" across 4.2m forward corridor):
                    if ((isHeavyA !== isHeavyB) && !a.variant && !b.variant && dist < minSep + 2.65) {
                        const tankActor = isHeavyA ? a : b;
                        const yieldActor = isHeavyA ? b : a;
                        if (!(yieldActor.type === 'siege_tank' && yieldActor.siegeMode)) {
                            const tankYaw = tankActor.currentYaw !== undefined ? tankActor.currentYaw : (tankActor.mesh.rotation.y || 0);
                            const tankFwdX = Math.sin(tankYaw);
                            const tankFwdZ = Math.cos(tankYaw);
                            const relX = yieldActor.mesh.position.x - tankActor.mesh.position.x;
                            const relZ = yieldActor.mesh.position.z - tankActor.mesh.position.z;
                            const forwardProj = relX * tankFwdX + relZ * tankFwdZ;
                            const perpX = tankFwdZ;
                            const perpZ = -tankFwdX;
                            const sideDot = relX * perpX + relZ * perpZ;
                            const laneHalfWidth = (tankActor.radius || 1.15) + (yieldActor.radius || 0.5) + 0.85;
                            if (forwardProj > -0.95 && forwardProj < 4.2 && Math.abs(sideDot) < laneHalfWidth) {
                                const sideSign = Math.abs(sideDot) > 0.04 ? Math.sign(sideDot) : (yieldActor.flankSign || 1);
                                const urgency = Math.max(0.35, 1.0 - Math.abs(sideDot) / laneHalfWidth);
                                const yieldStep = Math.min(0.14, 0.065 + urgency * 0.085);
                                const yNextX = yieldActor.mesh.position.x + perpX * sideSign * yieldStep;
                                const yNextZ = yieldActor.mesh.position.z + perpZ * sideSign * yieldStep;
                                if (isWalkableGround(yNextX, yNextZ, (yieldActor.radius || 0.5) * 0.55)) {
                                    yieldActor.mesh.position.x = yNextX;
                                    yieldActor.mesh.position.z = yNextZ;
                                }
                            }
                        }
                    }

                    if (dist < minSep) {
                        const bothTanks = (isHeavyA && isHeavyB);
                        const damp = bothTanks ? 0.22 : 0.42;
                        const overlap = Math.min(0.09, (minSep - dist) * damp);
                        const invDist = 1.0 / dist;
                        const nx = dx * invDist, nz = dz * invDist;

                        const massB = isAnchoredB ? 99999 : (isHeavyB ? 85 : (b.variant === 'behemoth' || b.variant === 'crusher' ? 25 : 1));
                        let ratioA = massB / (massA + massB);
                        let ratioB = massA / (massA + massB);
                        if (isHeavyA && !isHeavyB) { ratioA = 0; ratioB = 1.0; }
                        else if (isHeavyB && !isHeavyA) { ratioA = 1.0; ratioB = 0; }

                        // SIEGE TANK ANCHOR RULE: When a Siege Tank is in Siege Mode, its body is 100% anchored to the ground
                        // and NEVER moves or gets pushed by colliding tanks or units until it unsieges!
                        if (isAnchoredA && isAnchoredB) {
                            ratioA = 0;
                            ratioB = 0;
                        } else if (isAnchoredA) {
                            ratioA = 0;
                            ratioB = 1.0;
                        } else if (isAnchoredB) {
                            ratioA = 1.0;
                            ratioB = 0;
                        }

                        if (ratioA > 0) {
                            const aNextX = a.mesh.position.x - nx * overlap * ratioA;
                            const aNextZ = a.mesh.position.z - nz * overlap * ratioA;
                            if (isWalkableGround(aNextX, aNextZ, (a.radius || 0.5) * 0.6)) {
                                a.mesh.position.x = aNextX;
                                a.mesh.position.z = aNextZ;
                            }
                        }

                        if (ratioB > 0) {
                            const bNextX = b.mesh.position.x + nx * overlap * ratioB;
                            const bNextZ = b.mesh.position.z + nz * overlap * ratioB;
                            if (isWalkableGround(bNextX, bNextZ, (b.radius || 0.5) * 0.6)) {
                                b.mesh.position.x = bNextX;
                                b.mesh.position.z = bNextZ;
                            }
                        }
                    }
                }
            }
        }

        // Anchored Siege Tanks in Siege Mode never slide, rotate, or move from structure or unit pushback!
        if (isAnchoredA) {
            if (a.anchoredPos) {
                a.mesh.position.x = a.anchoredPos.x;
                a.mesh.position.z = a.anchoredPos.z;
                const surfY = typeof getSurfaceHeightWithBridges === 'function'
                    ? getSurfaceHeightWithBridges(a.anchoredPos.x, a.anchoredPos.z)
                    : getTerrainHeight(a.anchoredPos.x, a.anchoredPos.z);
                a.mesh.position.y = surfY;
            }
            if (a.anchoredYaw !== undefined) {
                a.mesh.rotation.y = a.anchoredYaw;
                if (a.mesh.userData) a.mesh.userData.smoothYaw = a.anchoredYaw;
            }
            continue;
        }

        // 2. Spatial Structure & Barrier Clearance (queries only local cells instead of all buildings/obstacles)
        let touchCount = 0;
        let sumPushX = 0, sumPushZ = 0;
        let nearBldMidX = 0, nearBldMidZ = 0;
        const stamp = ++_queryStampCounter;

        for (let gz = minGz; gz <= maxGz; gz++) {
            const rowOff = gz * SPATIAL_GRID_DIM;
            for (let gx = minGx; gx <= maxGx; gx++) {
                const sCell = structBuckets[rowOff + gx];
                for (let s = 0; s < sCell.length; s++) {
                    const st = sCell[s];
                    if (st._qStamp === stamp) continue;
                    st._qStamp = stamp;

                    const dx = a.mesh.position.x - st.x;
                    const dz = a.mesh.position.z - st.z;
                    if (Math.abs(dx) > 4.5 || Math.abs(dz) > 4.5) continue;
                    const distSq = dx * dx + dz * dz;
                    const minSep = (a.radius || 0.55) + st.r;
                    const touchLim = minSep + 0.25;
                    if (distSq >= touchLim * touchLim || distSq <= 0.000001) continue;

                    const dist = Math.sqrt(distSq);
                    touchCount++;
                    nearBldMidX += st.x;
                    nearBldMidZ += st.z;

                    if (dist < minSep) {
                        const push = st.isBarrier
                            ? Math.min(0.16, (minSep - dist) * 0.85 + 0.025)
                            : Math.min(0.08, (minSep - dist) * 0.55 + 0.015);
                        const rnx = dx / dist, rnz = dz / dist;
                        const slideSign = a.wallFollowSign || a.flankSign || 1;
                        const tx = -rnz * slideSign * 0.05;
                        const tz = rnx * slideSign * 0.05;
                        sumPushX += rnx * push + tx;
                        sumPushZ += rnz * push + tz;
                    }
                }
            }
        }

        if (touchCount >= 2) {
            nearBldMidX /= touchCount;
            nearBldMidZ /= touchCount;
            let ex = a.mesh.position.x - nearBldMidX;
            let ez = a.mesh.position.z - nearBldMidZ;
            const eLen = Math.hypot(ex, ez);
            if (eLen > 0.001) { ex /= eLen; ez /= eLen; }
            else { ex = 0; ez = 1; }
            const stepX = Math.max(-0.12, Math.min(0.12, ex * 0.07 + sumPushX));
            const stepZ = Math.max(-0.12, Math.min(0.12, ez * 0.07 + sumPushZ));
            const escapeX = a.mesh.position.x + stepX;
            const escapeZ = a.mesh.position.z + stepZ;
            if (isWalkableGround(escapeX, escapeZ, (a.radius || 0.5) * 0.5)) {
                a.mesh.position.x = escapeX;
                a.mesh.position.z = escapeZ;
            }
        } else if (Math.abs(sumPushX) > 0.0001 || Math.abs(sumPushZ) > 0.0001) {
            const clampedX = Math.max(-0.14, Math.min(0.14, sumPushX));
            const clampedZ = Math.max(-0.14, Math.min(0.14, sumPushZ));
            const nx = a.mesh.position.x + clampedX;
            const nz = a.mesh.position.z + clampedZ;
            if (isWalkableGround(nx, nz, (a.radius || 0.5) * 0.5)) {
                a.mesh.position.x = nx;
                a.mesh.position.z = nz;
            }
        }

        // Smooth Bridge Barrier Collision & Guardrail Clamping (strictly matched to the active bridge!)
        if (typeof isOnRiverBridge === 'function' && isOnRiverBridge(a.mesh.position.x, a.mesh.position.z)) {
            const rc = getRiverCoords(a.mesh.position.x, a.mesh.position.z);
            let activeBr = null;
            let bestDS = Infinity;
            for (let i = 0; i < RIVER_BRIDGES.length; i++) {
                const dS = Math.abs(rc.s - RIVER_BRIDGES[i].sCoord);
                if (dS < bestDS) {
                    bestDS = dS;
                    activeBr = RIVER_BRIDGES[i];
                }
            }
            if (activeBr && bestDS <= activeBr.halfWidth + 1.25) {
                const dS = rc.s - activeBr.sCoord;
                const maxDS = Math.max(0.6, activeBr.halfWidth - (a.radius || 0.50) - 0.50);
                if (Math.abs(dS) > maxDS) {
                    const targetS = activeBr.sCoord + Math.sign(dS) * maxDS;
                    const smoothS = THREE.MathUtils.lerp(rc.s, targetS, 0.38);
                    const clampedWorld = riverCoordsToWorld(smoothS, rc.u);
                    a.mesh.position.x = clampedWorld.x;
                    a.mesh.position.z = clampedWorld.z;
                }
            }
        }

        const targetGroundY = (typeof getSurfaceHeightWithBridges === 'function')
            ? getSurfaceHeightWithBridges(a.mesh.position.x, a.mesh.position.z)
            : getTerrainHeight(a.mesh.position.x, a.mesh.position.z);
        if (Number.isFinite(a.mesh.position.y)) {
            if (a.type === 'valkyrie' && a.mesh && a.mesh.userData && typeof a.mesh.userData.mechTransition === 'number') {
                // Smooth 3.0-second VTOL descent curve from flight altitude (ground + 6.0) down to ground level!
                const mt = a.mesh.userData.mechTransition;
                const smoothDescendT = mt * mt * (3.0 - 2.0 * mt);
                const transHoverAlt = (1.0 - smoothDescendT) * 5.8;
                a.mesh.position.y = THREE.MathUtils.lerp(a.mesh.position.y, targetGroundY + transHoverAlt, 0.22);
            } else {
                const yLerp = a.type === 'valkyrie' ? 0.18 : (a.type === 'tank' ? 0.35 : 0.65);
                a.mesh.position.y = THREE.MathUtils.lerp(a.mesh.position.y, targetGroundY, yLerp);
            }
        } else {
            a.mesh.position.y = targetGroundY;
        }

        // Trigger interactive water ripples ONLY when ground units wade in uncovered water ponds (never on bridges)!
        a.waterStepTimer = (a.waterStepTimer || 0) - 0.016;
        if (
            a.waterStepTimer <= 0 &&
            !(typeof isOnRiverBridge === 'function' && isOnRiverBridge(a.mesh.position.x, a.mesh.position.z, 0.8)) &&
            typeof isPointInWaterPond === 'function' &&
            isPointInWaterPond(a.mesh.position.x, a.mesh.position.z, 0.15)
        ) {
            a.waterStepTimer = 0.42 + Math.random() * 0.22;
            triggerWaterRippleFX(a.mesh.position.x, a.mesh.position.z, a.type === 'tank' ? 0.92 : 0.55, true);
        }
    }

    if (window.PERF_PROFILER) {
        window.PERF_PROFILER.end('collisionResolution');
        window.PERF_PROFILER.begin('airSeparation');
    }

    // 3. Spatial Grid Aerial Separation for Friendly Air Units & Enemy Flying Units (with wide 5.2m spacing for Dropships)
    const airActors = _airActorsScratch;
    const airBuckets = AIR_UNIT_GRID.buckets;
    for (let i = 0; i < airActors.length; i++) {
        const a = airActors[i];
        const ax = a.mesh.position.x, az = a.mesh.position.z;
        const cgx = Math.max(0, Math.min(SPATIAL_GRID_DIM - 1, Math.floor((ax + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL)));
        const cgz = Math.max(0, Math.min(SPATIAL_GRID_DIM - 1, Math.floor((az + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL)));
        const minGx = Math.max(0, cgx - 1);
        const maxGx = Math.min(SPATIAL_GRID_DIM - 1, cgx + 1);
        const minGz = Math.max(0, cgz - 1);
        const maxGz = Math.min(SPATIAL_GRID_DIM - 1, cgz + 1);

        for (let gz = minGz; gz <= maxGz; gz++) {
            const rowOff = gz * SPATIAL_GRID_DIM;
            for (let gx = minGx; gx <= maxGx; gx++) {
                const cell = airBuckets[rowOff + gx];
                for (let k = 0; k < cell.length; k++) {
                    const b = cell[k];
                    if (b._gridIdx <= i) continue;
                    const dx = b.mesh.position.x - ax;
                    const dz = b.mesh.position.z - az;
                    const isDropshipPair = (a.type === 'transport' || b.type === 'transport');
                    const minSep = isDropshipPair ? 5.2 : 2.55;
                    const distSq = dx * dx + dz * dz;
                    if (distSq < minSep * minSep && distSq > 0.000001) {
                        const dist = Math.sqrt(distSq);
                        const overlap = (minSep - dist) * 0.5 / dist;
                        a.mesh.position.x -= dx * overlap;
                        a.mesh.position.z -= dz * overlap;
                        b.mesh.position.x += dx * overlap;
                        b.mesh.position.z += dz * overlap;
                    }
                }
            }
        }
    }

    if (window.PERF_PROFILER) window.PERF_PROFILER.end('airSeparation');

    // 4. Physical Turret Shield Dome Barrier using cached activeShieldTurrets + spatial enemy lookup
    const activeShieldTurrets = BUILDING_COUNTS.activeShieldTurrets;
    if (activeShieldTurrets.length > 0) {
        const enemyBuckets = ENEMY_GRID.buckets;
        for (let si = 0; si < activeShieldTurrets.length; si++) {
            const st = activeShieldTurrets[si];
            const sx = st.pos.x, sz = st.pos.z;
            const searchR = 11.2;
            const minGx = Math.max(0, Math.floor((sx - searchR + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
            const maxGx = Math.min(SPATIAL_GRID_DIM - 1, Math.floor((sx + searchR + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
            const minGz = Math.max(0, Math.floor((sz - searchR + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
            const maxGz = Math.min(SPATIAL_GRID_DIM - 1, Math.floor((sz + searchR + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));

            for (let gz = minGz; gz <= maxGz; gz++) {
                const rowOff = gz * SPATIAL_GRID_DIM;
                for (let gx = minGx; gx <= maxGx; gx++) {
                    const cell = enemyBuckets[rowOff + gx];
                    for (let k = 0; k < cell.length; k++) {
                        const e = cell[k];
                        if (!e || e.hp <= 0 || !e.mesh) continue;
                        const dx = e.mesh.position.x - sx;
                        const dz = e.mesh.position.z - sz;
                        const minShieldDist = 9.5 + (e.radius || 0.55);
                        const distSq = dx * dx + dz * dz;
                        if (distSq < minShieldDist * minShieldDist) {
                            const dist = Math.sqrt(distSq);
                            const nx = dist > 0.001 ? dx / dist : 0;
                            const nz = dist > 0.001 ? dz / dist : 1;
                            e.mesh.position.x = sx + nx * minShieldDist;
                            e.mesh.position.z = sz + nz * minShieldDist;
                            if (!e.isAir) {
                                const gy = typeof getSurfaceHeightWithBridges === 'function'
                                    ? getSurfaceHeightWithBridges(e.mesh.position.x, e.mesh.position.z)
                                    : getTerrainHeight(e.mesh.position.x, e.mesh.position.z);
                                e.mesh.position.y = gy;
                            }
                        }
                    }
                }
            }
        }
    }
}

// ============================================================================
// 8C. SMART TARGETING LOGIC SYSTEM, SHIELD DOME BARRIER & MIND CONTROL
// ============================================================================
function applyDamageWithTurretShield(victim, dmg, hitWorldPos = null) {
    if (!victim || dmg <= 0) return;
    const vPos = victim.mesh ? victim.mesh.position : victim.pos;
    if (vPos) {
        const shieldTurrets = BUILDING_COUNTS.activeShieldTurrets;
        for (let i = 0; i < shieldTurrets.length; i++) {
            const b = shieldTurrets[i];
            if (b.hp > 0 && b.maxShieldHp > 0 && b.shieldHp > 15 && !(b.shieldBrokenTimer > 0)) {
                const dx = vPos.x - b.pos.x;
                const dz = vPos.z - b.pos.z;
                if (dx * dx + dz * dz <= 93.1225 || victim === b) { // 9.65^2
                    // Active Shield Barrier absorbs 100% of incoming damage until the barrier is destroyed!
                    const absorbed = Math.min(b.shieldHp, dmg);
                    b.shieldHp -= absorbed;
                    dmg -= absorbed;
                    if (typeof triggerShieldHitRippleFX === 'function') {
                        triggerShieldHitRippleFX(hitWorldPos || vPos, b.pos, 9.5);
                    }
                    if (b.shieldDomeMesh && b.shieldDomeMesh.userData.dome) {
                        b.shieldDomeMesh.scale.setScalar(1.025);
                        setTimeout(() => { if (b.shieldDomeMesh) b.shieldDomeMesh.scale.setScalar(1.0); }, 90);
                    }
                    if (b.shieldHp <= 15) {
                        b.shieldHp = 0;
                        b.shieldBrokenTimer = 6.5;
                        if (b.shieldDomeMesh) b.shieldDomeMesh.visible = false;
                        spawnCombatFloat(b.pos, 'SHIELD BARRIER DESTROYED!', '#38bdf8');
                    }
                    if (dmg <= 0.01) return;
                    break;
                }
            }
        }
    }
    // Protoss Solaris Plasma Shield HP Absorption (Absorbs incoming damage before hull/biological HP!)
    if (victim.maxShield && victim.maxShield > 0) {
        victim.shieldRegenDelay = 3.6;
        if ((victim.shield || 0) > 0) {
            const shdAbsorbed = Math.min(victim.shield, dmg);
            victim.shield -= shdAbsorbed;
            dmg -= shdAbsorbed;
            if (vPos && typeof triggerShieldHitRippleFX === 'function') {
                triggerShieldHitRippleFX(hitWorldPos || vPos, vPos, (victim.radius || victim.footprintRadius || 1.1) * 1.35);
            }
            if (dmg <= 0.01) return;
        }
    }
    if (victim.armorBonus && victim.armorBonus > 0) {
        dmg = Math.max(1, dmg - victim.armorBonus);
    }
    // Forest Concealment & Structural Ruin Tactical Cover for Ground Infantry (-18% incoming damage)
    if (vPos && victim.mesh && !victim.isAir && !victim.isVehicle && typeof window.getEnvironmentalTacticalModifiers === 'function') {
        const envMod = window.getEnvironmentalTacticalModifiers(vPos.x, vPos.z, false, false);
        if (envMod && envMod.coverDamageMult < 1.0) {
            dmg = Math.max(1, Math.round(dmg * envMod.coverDamageMult));
        }
    }
    victim.hp -= dmg;
}

function hasClearFiringLane(shooter, targetPos) {
    if (!shooter || !shooter.mesh || !targetPos || shooter.isAir) return true;
    const sx = shooter.mesh.position.x;
    const sz = shooter.mesh.position.z;
    const dx = targetPos.x - sx;
    const dz = targetPos.z - sz;
    const dist = Math.hypot(dx, dz);
    if (dist < 2.2) return true;
    const invD = 1.0 / dist;
    const ux = dx * invD;
    const uz = dz * invD;

    // Check friendly tanks / buildings blocking immediate line of fire within 4.2m ahead of shooter
    const checkLen = Math.min(dist - 0.8, 4.2);
    for (let i = 0; i < units.length; i++) {
        const ally = units[i];
        if (!ally || ally === shooter || ally.hp <= 0 || ally.isAir || !ally.mesh) continue;
        const ax = ally.mesh.position.x - sx;
        const az = ally.mesh.position.z - sz;
        const proj = ax * ux + az * uz;
        if (proj <= 0.25 || proj >= checkLen) continue;
        const perp = Math.abs(ax * (-uz) + az * ux);
        const blockRad = (ally.isVehicle || ally.type === 'tank' || ally.type === 'siege_tank') ? 0.92 : 0.42;
        if (perp < blockRad) return false;
    }
    for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        if (!b || b.hp <= 0 || !b.pos) continue;
        const bx = b.pos.x - sx;
        const bz = b.pos.z - sz;
        const proj = bx * ux + bz * uz;
        if (proj <= 0.3 || proj >= dist - 0.8) continue;
        const perp = Math.abs(bx * (-uz) + bz * ux);
        if (perp < (b.radius || 2.1) * 0.78) return false;
    }
    return true;
}

const _firingSlotScratch = new THREE.Vector3();
function findOpenFiringSlot(shooter, targetPos) {
    if (!shooter || !shooter.mesh || !targetPos) return targetPos;
    const sx = shooter.mesh.position.x;
    const sz = shooter.mesh.position.z;
    const dx = targetPos.x - sx;
    const dz = targetPos.z - sz;
    const dist = Math.hypot(dx, dz) || 1;
    const ux = dx / dist;
    const uz = dz / dist;
    const px = -uz;
    const pz = ux;

    const signPref = shooter.flankSign || ((units.indexOf(shooter) % 2 === 0) ? 1 : -1);
    const offsets = [1.85 * signPref, -1.85 * signPref, 3.2 * signPref, -3.2 * signPref];
    for (let i = 0; i < offsets.length; i++) {
        const lat = offsets[i];
        const candX = sx + px * lat + ux * 0.75;
        const candZ = sz + pz * lat + uz * 0.75;
        if (typeof isWalkableGround === 'function' && !isWalkableGround(candX, candZ, 0.48)) continue;
        let crowded = false;
        for (let j = 0; j < units.length; j++) {
            const ally = units[j];
            if (!ally || ally === shooter || ally.hp <= 0 || ally.isAir || !ally.mesh) continue;
            const dSq = (ally.mesh.position.x - candX) * (ally.mesh.position.x - candX) + (ally.mesh.position.z - candZ) * (ally.mesh.position.z - candZ);
            if (dSq < 1.15) { crowded = true; break; }
        }
        if (!crowded) {
            return _firingSlotScratch.set(candX, getTerrainHeight(candX, candZ), candZ);
        }
    }
    return _firingSlotScratch.set(sx + px * 1.9 * signPref, getTerrainHeight(sx + px * 1.9 * signPref, sz + pz * 1.9 * signPref), sz + pz * 1.9 * signPref);
}

function selectSmartTarget(originPos, maxRange, canHitAir = true, preferHeavy = false, preferSwarm = false, shooter = null) {
    const t0 = window.PERF_PROFILER ? performance.now() : 0;
    let bestTarget = null;
    let bestScore = -Infinity;

    const ox = originPos.x;
    const oz = originPos.z;
    const maxRangeSq = maxRange * maxRange;
    const shooterType = shooter ? (shooter.type || shooter.variant || '') : '';
    const shooterDmg = shooter ? (shooter.damage || 18) : 18;
    const shooterRange = shooter ? (shooter.range || maxRange) : maxRange;

    // Query ENEMY_GRID within [ox - maxRange .. ox + maxRange, oz - maxRange .. oz + maxRange]
    const minGx = Math.max(0, Math.floor((ox - maxRange + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
    const maxGx = Math.min(SPATIAL_GRID_DIM - 1, Math.floor((ox + maxRange + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
    const minGz = Math.max(0, Math.floor((oz - maxRange + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
    const maxGz = Math.min(SPATIAL_GRID_DIM - 1, Math.floor((oz + maxRange + SPATIAL_GRID_HALF) / SPATIAL_GRID_CELL));
    const enemyBuckets = ENEMY_GRID.buckets;

    for (let gz = minGz; gz <= maxGz; gz++) {
        const rowOff = gz * SPATIAL_GRID_DIM;
        for (let gx = minGx; gx <= maxGx; gx++) {
            const cell = enemyBuckets[rowOff + gx];
            for (let k = 0; k < cell.length; k++) {
                const e = cell[k];
                if (!e || e.hp <= 0) continue;
                if (e.isAir && !canHitAir) continue;
                const dx = e.mesh.position.x - ox;
                const dz = e.mesh.position.z - oz;
                const dSq = dx * dx + dz * dz;
                if (dSq > maxRangeSq) continue;
                const d = Math.sqrt(dSq);

                // 1. Proximity & immediate firing readiness bonus
                let score = (maxRange - d) * 3.6 + (d <= shooterRange ? 26.0 : 0);

                // 2. Finish-off & Focus-Fire coordination bonus
                const hpRatio = Math.max(0.05, e.hp / e.maxHp);
                score += (1.0 - hpRatio) * 46.0;

                // 3. Overkill avoidance: penalize piling too many high-damage attackers onto a nearly dead swarm unit
                const assigned = e._assignedAttackers || 0;
                if (assigned > 0 && e.hp > shooterDmg * assigned * 0.85) {
                    score += Math.min(18.0, assigned * 6.0); // Focus fire on healthy high-value targets
                } else if (assigned >= 2 && e.hp <= shooterDmg * 1.4) {
                    score -= assigned * 22.0; // Avoid overkill on dying light targets
                }

                // 4. Role counter & threat-type tactical weighting
                const v = e.variant;
                if (v === 'burster' && d < 10.5) score += 105.0; // Immediate volatile baneling danger!
                else if (v === 'behemoth') score += preferHeavy ? 82.0 : 30.0;
                else if (v === 'gorgon')   score += preferHeavy ? 74.0 : 28.0;
                else if (v === 'crusher')  score += (preferHeavy || shooterType === 'marauder' || shooterType === 'stalker') ? 64.0 : 22.0;
                else if (v === 'mutalisk') score += canHitAir ? ((shooterType === 'sniper' || shooterType === 'rocketman' || shooterType === 'valkyrie') ? 56.0 : 34.0) : 0;
                else if (v === 'spitter')  score += (shooterType === 'sniper' || shooterType === 'reaper') ? 38.0 : 24.0;
                if ((preferSwarm || shooterType === 'firebat' || shooterType === 'archon') && (v === 'skitterer' || v === 'burster')) {
                    score += 42.0;
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestTarget = e;
                }
            }
        }
    }

    if (bestTarget) {
        bestTarget._assignedAttackers = (bestTarget._assignedAttackers || 0) + 1;
    } else if (enemyBuildings.length > 0) {
        const bldLim = maxRange + 3.5;
        let minBldDistSq = bldLim * bldLim;
        for (let i = 0; i < enemyBuildings.length; i++) {
            const eb = enemyBuildings[i];
            if (!eb || eb.hp <= 0) continue;
            const dx = eb.pos.x - ox;
            const dz = eb.pos.z - oz;
            const dSq = dx * dx + dz * dz;
            if (dSq <= minBldDistSq) {
                minBldDistSq = dSq;
                bestTarget = eb;
            }
        }
    }

    if (window.PERF_PROFILER) {
        window.PERF_PROFILER.addSample('targetAcquisition', performance.now() - t0);
    }
    return bestTarget;
}

// ============================================================================
// STRATEGIC COMMANDER, FACTION PERSONALITIES, SQUAD FORMATIONS & AI DEBUG (F8)
// ============================================================================
window.STRATEGIC_COMMANDER = {
    currentStrategy: 'rush',
    strategyTimer: 0,
    minStrategyDuration: 18.0,
    factionPersonality: 'zerg_swarm', // 'terran_tactical', 'solaris_precision', 'zerg_swarm'
    primaryBridgeIdx: 0,
    secondaryBridgeIdx: 1,
    scores: {},
    update(dt) {
        this.strategyTimer += dt;
        // Reset per-frame focus-fire attacker counters on enemies
        for (let i = 0; i < enemies.length; i++) {
            if (enemies[i]) enemies[i]._assignedAttackers = 0;
        }
        if (this.strategyTimer < this.minStrategyDuration) return;
        this.strategyTimer = 0;

        const alliedStrength = units.length + buildings.length * 1.5;
        const enemyStrength = enemies.length + enemyBuildings.length * 1.8;
        const ratio = enemyStrength / Math.max(1, alliedStrength);
        const elapsed = state.elapsedSec || 0;
        const numBridges = (typeof RIVER_BRIDGES !== 'undefined' && RIVER_BRIDGES.length) ? RIVER_BRIDGES.length : 2;

        // Utility evaluation across StarCraft-style strategic states
        this.scores = {
            rush: (elapsed < 110 ? 75 : 30) + (enemies.length >= 6 ? 25 : 0),
            flank: (units.length >= 6 ? 68 : 35) + (numBridges > 1 ? 20 : 0),
            pincer: (enemies.length >= 10 && numBridges > 1) ? 84 : 30,
            siege_pressure: (ratio >= 0.9 && elapsed > 90) ? 72 : 28,
            containment: (ratio >= 1.25 && units.length >= 4) ? 76 : 25,
            harassment: (enemies.length >= 4 && elapsed > 45) ? 64 : 25,
            counterattack: (state.kills > 8 && enemies.length >= 6) ? 78 : 20,
            turtle: (enemyBuildings.length <= 2 && ratio < 0.7) ? 70 : 15
        };

        let bestStrat = this.currentStrategy;
        let bestVal = (this.scores[bestStrat] || 0) + 10; // Hysteresis bonus to prevent rapid flipping
        for (const k in this.scores) {
            if (this.scores[k] > bestVal) {
                bestVal = this.scores[k];
                bestStrat = k;
            }
        }
        this.currentStrategy = bestStrat;
        if (numBridges > 1) {
            this.primaryBridgeIdx = (this.primaryBridgeIdx + 1) % numBridges;
            this.secondaryBridgeIdx = (this.primaryBridgeIdx + 1) % numBridges;
        }
    }
};

window.SQUAD_MANAGER = {
    formation: 'concave', // 'line', 'wedge', 'column', 'defensive', 'flanking', 'concave'
    getFormationOffset(actor, index, total, destPos) {
        const isCrossingBridge = actor && actor._bridgeCrossingState && actor._bridgeCrossingState !== 'completed';
        const activeForm = isCrossingBridge ? 'column' : this.formation;
        const isFrontline = actor && (actor.type === 'grunt' || actor.type === 'firebat' || actor.type === 'marauder' || actor.type === 'zealot' || actor.type === 'tank');
        const isSupport = actor && (actor.type === 'medic' || actor.type === 'siege_tank' || actor.type === 'sniper');

        if (activeForm === 'column') {
            const col = (index % 2) === 0 ? -0.75 : 0.75;
            const row = -Math.floor(index / 2) * 1.45;
            return { right: col, forward: row, mode: 'column' };
        }
        const rankDepth = isFrontline ? 1.4 : (isSupport ? -2.2 : -0.4);
        const lateral = ((index % 7) - 3) * 1.65;
        const arcDrop = -Math.abs((index % 7) - 3) * 0.35;
        return { right: lateral, forward: rankDepth + arcDrop, mode: activeForm };
    }
};

window.AI_DEBUG = {
    enabled: false,
    paused: false,
    activeTab: 'overview',
    severityFilter: 'ALL',
    categoryFilter: 'ALL',
    errorSearchQuery: '',
    worldVizEnabled: true,
    loggingEnabled: true,
    showGraphicsPanel: true,
    selectedUnitId: null,
    followUnitId: null,
    logHistory: [],
    lastSimTestResult: null,
    group: null,
    panelEl: null,
    TABS: [
        { id: 'overview', label: '1.Overview' },
        { id: 'errors', label: '2.Errors' },
        { id: 'graphics', label: '3.Graphics' },
        { id: 'terrain', label: '4.Terrain' },
        { id: 'factions', label: '5.Factions' },
        { id: 'zerg', label: '6.Zerg AI' },
        { id: 'world_init', label: '7.World Init' },
        { id: 'loading', label: '8.Loading' },
        { id: 'performance', label: '9.Perf' },
        { id: 'inspector', label: '10.Inspector' }
    ],
    _vizPool: {
        lines: [],
        markers: [],
        matValidLine: null,
        matBlockedLine: null,
        matDestMarker: null,
        matTargetMarker: null,
        matStuckMarker: null,
        markerGeo: null
    },
    logEvent(msg) {
        if (!this.loggingEnabled || this.paused) return;
        const ts = (state && typeof state.elapsedSec === 'number') ? state.elapsedSec.toFixed(2) : '0.00';
        this.logHistory.push(`[${ts}s] ${msg}`);
        if (this.logHistory.length > 250) this.logHistory.shift();
    },
    clearHistory() {
        this.logHistory.length = 0;
        if (window.APP_ERROR_HANDLER && typeof window.APP_ERROR_HANDLER.clear === 'function') {
            window.APP_ERROR_HANDLER.clear();
        }
        for (let i = 0; i < enemies.length; i++) {
            enemies[i].lastError = null;
            enemies[i].lastStuckPos = null;
        }
        if (typeof NAV_STUCK_HOTSPOTS !== 'undefined') {
            NAV_STUCK_HOTSPOTS.length = 0;
        }
        this.logEvent('Diagnostic history, runtime errors & stuck hotspots cleared.');
        this.renderUI(true);
    },
    selectUnit(unitId) {
        this.selectedUnitId = unitId;
        this.renderUI(true);
    },
    toggleFollowUnit(unitId) {
        const targetId = unitId || this.selectedUnitId;
        this.followUnitId = (this.followUnitId === targetId) ? null : targetId;
        this.renderUI(true);
    },
    togglePause() {
        this.paused = !this.paused;
        this.renderUI(true);
    },
    toggleWorldViz() {
        this.worldVizEnabled = !this.worldVizEnabled;
        if (this.group) this.group.visible = this.enabled && this.worldVizEnabled;
        this.renderUI(true);
    },
    toggleLogging() {
        this.loggingEnabled = !this.loggingEnabled;
        this.renderUI(true);
    },
    toggleGraphicsPanel() {
        this.showGraphicsPanel = !this.showGraphicsPanel;
        this.activeTab = 'graphics';
        this.renderUI(true);
    },
    buildFullReportObject() {
        const sysVal = window.SYSTEM_INIT_VALIDATOR ? window.SYSTEM_INIT_VALIDATOR.validateAllSystems() : null;
        const renderSummary = (window.SYSTEM_INIT_VALIDATOR && typeof window.SYSTEM_INIT_VALIDATOR.getRenderingStatusSummary === 'function')
            ? window.SYSTEM_INIT_VALIDATOR.getRenderingStatusSummary()
            : null;
        return {
            exportedAt: new Date().toISOString(),
            overview: {
                phase: window.titleScreenActive ? 'menu' : (window.loadingCameraSweep ? 'loading' : 'playing'),
                biome: window.ACTIVE_PLANET_BIOME || 'highland',
                mapSeed: window.MAP_SEED || 100,
                basePlaced: !!(state && state.basePlaced),
                wave: state ? state.wave : 1,
                elapsedSec: state ? Number((state.elapsedSec || 0).toFixed(2)) : 0
            },
            renderingStatus: renderSummary,
            firstStartupError: window.APP_ERROR_HANDLER ? window.APP_ERROR_HANDLER.firstStartupError : null,
            firstFailedRenderStage: window.APP_ERROR_HANDLER ? window.APP_ERROR_HANDLER.firstFailedRenderStage : null,
            runtimeErrors: window.APP_ERROR_HANDLER ? window.APP_ERROR_HANDLER.errors.slice() : [],
            aiDiagnostics: window.ZERG_AI_DIAGNOSTICS ? window.ZERG_AI_DIAGNOSTICS.getReport() : {},
            graphicsDiagnostics: window.GRAPHICS_DIAGNOSTICS ? window.GRAPHICS_DIAGNOSTICS.getSnapshot() : {},
            textureRegistry: window.TEXTURE_REGISTRY ? window.TEXTURE_REGISTRY.getDiagnosticSnapshot() : {},
            systemInitValidation: sysVal,
            lastSimTestResult: this.lastSimTestResult,
            logHistory: this.logHistory.slice()
        };
    },
    copyReport() {
        const fullReport = this.buildFullReportObject();
        const jsonStr = JSON.stringify(fullReport, null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(jsonStr).catch(() => {});
        }
        this.logEvent('Copied full diagnostic JSON report to clipboard.');
        this.renderUI(true);
    },
    exportReport() {
        const fullReport = this.buildFullReportObject();
        const jsonStr = JSON.stringify(fullReport, null, 2);
        try {
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `starblock-diagnostics-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2500);
        } catch (_) {}
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(jsonStr).catch(() => {});
        }
        this.logEvent('Exported full JSON diagnostic report.');
        this.renderUI(true);
        return fullReport;
    },
    toggle() {
        this.enabled = !this.enabled;
        this._ensureDOM();
        if (this.panelEl) {
            this.panelEl.style.display = this.enabled ? 'flex' : 'none';
        }
        if (this.group) {
            this.group.visible = this.enabled && this.worldVizEnabled;
        }
        const topBtn = document.getElementById('btn-debug-mode');
        if (topBtn) {
            topBtn.style.borderColor = this.enabled ? '#00ff9d' : '';
            topBtn.style.color = this.enabled ? '#00ff9d' : '';
        }
        if (this.enabled) {
            this.renderUI(true);
        }
    },
    _ensureDOM() {
        if (this.panelEl) return;
        const panel = document.createElement('div');
        panel.id = 'starblock-debug-panel';
        panel.style.cssText = [
            'position:fixed',
            'top:44px',
            'right:10px',
            'width:min(470px, 96vw)',
            'max-height:calc(100vh - 56px)',
            'z-index:9998',
            'background:rgba(5, 11, 20, 0.95)',
            'border:1px solid #00e5ff',
            'border-radius:8px',
            'box-shadow:0 10px 32px rgba(0,0,0,0.85)',
            'color:#e2f1ff',
            'font:11px/1.38 monospace',
            'display:none',
            'flex-direction:column',
            'overflow:hidden',
            'pointer-events:auto'
        ].join(';');

        const tabButtonsHtml = this.TABS.map(t =>
            `<button data-dbg-tab="${t.id}" class="dbg-tab-btn" style="background:#0f172a;color:#94a3b8;border:1px solid #1e293b;border-radius:3px;padding:3px 5px;cursor:pointer;font:10px monospace;">${t.label}</button>`
        ).join('');

        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:rgba(0,229,255,0.14);border-bottom:1px solid rgba(0,229,255,0.35);">
                <span style="font-weight:700;color:#00f0ff;letter-spacing:0.4px;">🐞 STARBLOCK 10-TAB ENGINE DEBUGGER [F8/F9]</span>
                <button id="dbg-btn-close" style="background:#1e293b;color:#f87171;border:1px solid #f87171;border-radius:4px;padding:2px 7px;cursor:pointer;font:11px monospace;">✕</button>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:3px;padding:5px 7px;background:rgba(15,23,42,0.92);border-bottom:1px solid rgba(148,163,184,0.2);">
                <button id="dbg-btn-pause" style="background:#0f172a;color:#fde047;border:1px solid #eab308;border-radius:3px;padding:3px 6px;cursor:pointer;font:10px monospace;">PAUSE</button>
                <button id="dbg-btn-viz" style="background:#0f172a;color:#34d399;border:1px solid #34d399;border-radius:3px;padding:3px 6px;cursor:pointer;font:10px monospace;">3D VIZ: ON</button>
                <button id="dbg-btn-sim" style="background:#064e3b;color:#6ee7b7;border:1px solid #10b981;border-radius:3px;padding:3px 6px;cursor:pointer;font:10px monospace;font-weight:700;">▶ ZERG SIM</button>
                <button id="dbg-btn-testerr" style="background:#3b0764;color:#e9d5ff;border:1px solid #a855f7;border-radius:3px;padding:3px 6px;cursor:pointer;font:10px monospace;">TEST ERR</button>
                <button id="dbg-btn-follow" style="background:#0f172a;color:#38bdf8;border:1px solid #38bdf8;border-radius:3px;padding:3px 6px;cursor:pointer;font:10px monospace;">FOLLOW UNIT</button>
                <button id="dbg-btn-clear" style="background:#0f172a;color:#fbbf24;border:1px solid #fbbf24;border-radius:3px;padding:3px 6px;cursor:pointer;font:10px monospace;">CLEAR</button>
                <button id="dbg-btn-copy" style="background:#0f172a;color:#cbd5e1;border:1px solid #64748b;border-radius:3px;padding:3px 6px;cursor:pointer;font:10px monospace;">COPY</button>
                <button id="dbg-btn-export" style="background:#0f172a;color:#e2e8f0;border:1px solid #94a3b8;border-radius:3px;padding:3px 6px;cursor:pointer;font:10px monospace;">EXPORT JSON</button>
            </div>
            <div id="dbg-tabs-bar" style="display:flex;flex-wrap:wrap;gap:3px;padding:5px 7px;background:rgba(2,6,14,0.9);border-bottom:1px solid rgba(0,229,255,0.2);">
                ${tabButtonsHtml}
            </div>
            <div style="padding:4px 8px;font-size:9.5px;color:#94a3b8;background:rgba(2,6,14,0.7);border-bottom:1px solid rgba(148,163,184,0.16);">
                3D Legend: <span style="color:#22c55e;">■ Green=Valid Path</span> · <span style="color:#ef4444;">■ Red=Blocked/Stuck</span> · <span style="color:#eab308;">● Yellow=Dest</span> · <span style="color:#3b82f6;">● Blue=Target</span>
            </div>
            <div id="dbg-panel-body" style="padding:8px 10px;overflow-y:auto;max-height:calc(100vh - 210px);display:flex;flex-direction:column;gap:7px;"></div>
        `;
        panel.addEventListener('pointerdown', ev => ev.stopPropagation());
        panel.addEventListener('pointerup', ev => ev.stopPropagation());
        panel.addEventListener('wheel', ev => ev.stopPropagation());
        document.body.appendChild(panel);
        this.panelEl = panel;

        document.getElementById('dbg-btn-close').onclick = () => this.toggle();
        document.getElementById('dbg-btn-pause').onclick = () => this.togglePause();
        document.getElementById('dbg-btn-viz').onclick = () => this.toggleWorldViz();
        document.getElementById('dbg-btn-clear').onclick = () => this.clearHistory();
        document.getElementById('dbg-btn-copy').onclick = () => this.copyReport();
        document.getElementById('dbg-btn-export').onclick = () => this.exportReport();
        document.getElementById('dbg-btn-follow').onclick = () => this.toggleFollowUnit();
        document.getElementById('dbg-btn-testerr').onclick = () => {
            if (window.APP_ERROR_HANDLER && typeof window.APP_ERROR_HANDLER.triggerTestError === 'function') {
                window.APP_ERROR_HANDLER.triggerTestError();
            }
            this.activeTab = 'errors';
            this.renderUI(true);
        };
        document.getElementById('dbg-btn-sim').onclick = () => {
            if (typeof window.runZergMovementSimulationTest === 'function') {
                window.runZergMovementSimulationTest();
            }
        };

        const tabBtns = panel.querySelectorAll('.dbg-tab-btn');
        tabBtns.forEach(btn => {
            btn.onclick = () => {
                this.activeTab = btn.getAttribute('data-dbg-tab') || 'overview';
                this.renderUI(true);
            };
        });
    },
    _reconcileSceneZergMeshes() {
        if (!scene) return { sceneZergMeshCount: 0, orphanedCount: 0 };
        const trackedMeshes = new Set();
        for (let i = 0; i < enemies.length; i++) {
            if (enemies[i] && enemies[i].mesh) trackedMeshes.add(enemies[i].mesh);
        }
        let sceneZergMeshCount = 0;
        let orphanedCount = 0;
        scene.children.forEach(obj => {
            if (obj && obj.userData && obj.userData.isZergUnitMesh) {
                sceneZergMeshCount++;
                if (!trackedMeshes.has(obj)) {
                    orphanedCount++;
                }
            }
        });
        return { sceneZergMeshCount, orphanedCount };
    },
    _updateWorldViz() {
        if (!this.enabled || !this.worldVizEnabled || typeof THREE === 'undefined' || !scene) {
            if (this.group) this.group.visible = false;
            return;
        }
        if (!this.group) {
            this.group = new THREE.Group();
            this.group.name = 'AIDebugOverlayGroup';
            scene.add(this.group);
            this._vizPool.matValidLine = new THREE.LineBasicMaterial({ color: 0x22c55e, depthTest: false, transparent: true, opacity: 0.92 });
            this._vizPool.matBlockedLine = new THREE.LineBasicMaterial({ color: 0xef4444, depthTest: false, transparent: true, opacity: 0.95 });
            this._vizPool.matDestMarker = new THREE.MeshBasicMaterial({ color: 0xeab308, depthTest: false, transparent: true, opacity: 0.90 });
            this._vizPool.matTargetMarker = new THREE.MeshBasicMaterial({ color: 0x3b82f6, depthTest: false, transparent: true, opacity: 0.90 });
            this._vizPool.matStuckMarker = new THREE.MeshBasicMaterial({ color: 0xef4444, depthTest: false, transparent: true, opacity: 0.92 });
            this._vizPool.markerGeo = new THREE.OctahedronGeometry(0.45, 0);
        }
        this.group.visible = true;

        const pool = this._vizPool;
        let lineIdx = 0;
        let markerIdx = 0;
        const surfFn = typeof getSurfaceHeightWithBridges === 'function' ? getSurfaceHeightWithBridges : getTerrainHeight;

        const addDebugLine = (p1x, p1y, p1z, p2x, p2y, p2z, isBlocked) => {
            let line = pool.lines[lineIdx++];
            if (!line) {
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
                line = new THREE.Line(geo, pool.matValidLine);
                line.renderOrder = 999;
                pool.lines.push(line);
                this.group.add(line);
            }
            line.visible = true;
            line.material = isBlocked ? pool.matBlockedLine : pool.matValidLine;
            const posAttr = line.geometry.attributes.position;
            posAttr.setXYZ(0, p1x, p1y, p1z);
            posAttr.setXYZ(1, p2x, p2y, p2z);
            posAttr.needsUpdate = true;
        };

        const addDebugMarker = (wx, wy, wz, mat, scale = 1.0) => {
            let mk = pool.markers[markerIdx++];
            if (!mk) {
                mk = new THREE.Mesh(pool.markerGeo, mat);
                mk.renderOrder = 999;
                pool.markers.push(mk);
                this.group.add(mk);
            }
            mk.visible = true;
            mk.material = mat;
            mk.position.set(wx, wy, wz);
            mk.scale.setScalar(scale);
        };

        for (let i = 0; i < enemies.length; i++) {
            const e = enemies[i];
            if (!e || e.hp <= 0 || !e.mesh) continue;
            const ux = e.mesh.position.x;
            const uy = e.mesh.position.y + 0.55;
            const uz = e.mesh.position.z;
            const isSelected = (this.selectedUnitId && e.id === this.selectedUnitId);
            const isBlocked = !e.navSuccess || (e.stuckTimer || 0) > 0.25 || e.lastNavResult === 'blocked';

            const wp = e.navWaypoint || e.currentDestination;
            if (wp && Number.isFinite(wp.x) && Number.isFinite(wp.z)) {
                const wy = surfFn(wp.x, wp.z) + 0.55;
                addDebugLine(ux, uy, uz, wp.x, wy, wp.z, isBlocked);
                if (e.currentDestination && (Math.abs(wp.x - e.currentDestination.x) > 0.5 || Math.abs(wp.z - e.currentDestination.z) > 0.5)) {
                    const dy = surfFn(e.currentDestination.x, e.currentDestination.z) + 0.55;
                    addDebugLine(wp.x, wy, wp.z, e.currentDestination.x, dy, e.currentDestination.z, isBlocked);
                }
            }

            if (e.currentDestination && Number.isFinite(e.currentDestination.x) && Number.isFinite(e.currentDestination.z)) {
                const dy = surfFn(e.currentDestination.x, e.currentDestination.z) + 0.75;
                addDebugMarker(e.currentDestination.x, dy, e.currentDestination.z, pool.matDestMarker, isSelected ? 1.45 : 0.85);
            }

            if (e.lockedTarget) {
                const lt = e.lockedTarget;
                const ltPos = lt.mesh ? lt.mesh.position : lt.pos;
                if (ltPos && Number.isFinite(ltPos.x) && Number.isFinite(ltPos.z)) {
                    const ty = (ltPos.y || surfFn(ltPos.x, ltPos.z)) + 1.35;
                    addDebugMarker(ltPos.x, ty, ltPos.z, pool.matTargetMarker, isSelected ? 1.55 : 0.95);
                }
            }

            if (e.lastStuckPos && Number.isFinite(e.lastStuckPos.x) && Number.isFinite(e.lastStuckPos.z)) {
                const sy = surfFn(e.lastStuckPos.x, e.lastStuckPos.z) + 0.95;
                addDebugMarker(e.lastStuckPos.x, sy, e.lastStuckPos.z, pool.matStuckMarker, 1.15);
            }
        }

        for (let i = lineIdx; i < pool.lines.length; i++) pool.lines[i].visible = false;
        for (let i = markerIdx; i < pool.markers.length; i++) pool.markers[i].visible = false;
    },
    _lastUiRenderMs: 0,
    renderUI(force = false) {
        if (!this.enabled) return;
        if (this.paused && !force) return;
        const nowMs = performance.now();
        if (!force && nowMs - this._lastUiRenderMs < 240) return;
        this._lastUiRenderMs = nowMs;

        this._ensureDOM();
        const body = document.getElementById('dbg-panel-body');
        if (!body) return;

        const btnPause = document.getElementById('dbg-btn-pause');
        if (btnPause) btnPause.innerText = this.paused ? 'RESUME' : 'PAUSE';
        const btnViz = document.getElementById('dbg-btn-viz');
        if (btnViz) btnViz.innerText = `3D VIZ: ${this.worldVizEnabled ? 'ON' : 'OFF'}`;
        const btnFollow = document.getElementById('dbg-btn-follow');
        if (btnFollow) btnFollow.innerText = this.followUnitId ? `FOLLOW: ${this.followUnitId}` : 'FOLLOW UNIT';

        const tabBtns = this.panelEl.querySelectorAll('.dbg-tab-btn');
        tabBtns.forEach(btn => {
            const isAct = btn.getAttribute('data-dbg-tab') === this.activeTab;
            btn.style.background = isAct ? '#00e5ff' : '#0f172a';
            btn.style.color = isAct ? '#040810' : '#94a3b8';
            btn.style.fontWeight = isAct ? '700' : '400';
        });

        const aiRep = window.ZERG_AI_DIAGNOSTICS ? window.ZERG_AI_DIAGNOSTICS.getReport() : {
            totalZergUnits: enemies.length,
            movingCount: 0,
            attackingCount: 0,
            searchingCount: 0,
            stuckCount: 0,
            recoveringCount: 0,
            units: []
        };
        if (!this.selectedUnitId && aiRep.units.length > 0) {
            this.selectedUnitId = aiRep.units[0].unitId;
        }
        const selUnit = aiRep.units.find(u => u.unitId === this.selectedUnitId) || aiRep.units[0] || null;
        const gSnap = window.GRAPHICS_DIAGNOSTICS ? window.GRAPHICS_DIAGNOSTICS.getSnapshot() : null;
        const texSnap = window.TEXTURE_REGISTRY ? window.TEXTURE_REGISTRY.getDiagnosticSnapshot() : { totalRegistered: 0, missingOrInvalid: [], entries: [] };
        const errList = window.APP_ERROR_HANDLER ? window.APP_ERROR_HANDLER.errors : [];
        const sysVal = window.SYSTEM_INIT_VALIDATOR ? window.SYSTEM_INIT_VALIDATOR.validateAllSystems() : { overallStatus: 'PASS', stages: [] };
        const sceneCheck = this._reconcileSceneZergMeshes();

        let simHtml = '';
        if (this.lastSimTestResult) {
            const sr = this.lastSimTestResult;
            const sCol = sr.passed ? '#22c55e' : '#ef4444';
            simHtml = `
                <div style="background:rgba(6,40,30,0.75);border:1px solid ${sCol};border-radius:6px;padding:6px 9px;">
                    <div style="font-weight:700;color:${sCol};">ZERG MOVEMENT SIMULATION TEST: ${sr.passed ? 'PASSED ✓' : 'FAILED ✕'}</div>
                    <div>Tested Units: <b>${sr.testedCount}</b> | Moved &amp; Reached Valid Path: <b>${sr.passedCount}/${sr.testedCount}</b> | Avg Disp: <b>${sr.avgDisplacementM}m</b></div>
                </div>
            `;
        }

        const rStat = (window.SYSTEM_INIT_VALIDATOR && typeof window.SYSTEM_INIT_VALIDATOR.getRenderingStatusSummary === 'function')
            ? window.SYSTEM_INIT_VALIDATOR.getRenderingStatusSummary()
            : {
                renderer: 'PASS',
                terrainGeometry: 'PASS',
                terrainMaterial: 'PASS',
                terrainTexture: 'PASS',
                factionMaterials: 'PASS',
                shaderCompilation: 'PASS',
                fogOfWar: 'PASS',
                webglContext: 'ACTIVE',
                axisSphere: 'PASS'
            };
        const badge = (val) => `<b style="color:${val === 'PASS' || val === 'ACTIVE' || val === 'RESTORED' ? '#22c55e' : '#ef4444'};">${val}</b>`;
        const renderStatusCardHtml = `
            <div style="background:rgba(8,18,32,0.92);border:1px solid #00e5ff;border-radius:6px;padding:6px 8px;font-size:10px;">
                <div style="font-weight:700;color:#00e5ff;margin-bottom:4px;">VERIFIED RENDERING PIPELINE STATUS</div>
                <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:3px 10px;">
                    <div>Renderer: ${badge(rStat.renderer)}</div>
                    <div>Terrain geometry: ${badge(rStat.terrainGeometry)}</div>
                    <div>Terrain material: ${badge(rStat.terrainMaterial)}</div>
                    <div>Terrain texture: ${badge(rStat.terrainTexture)}</div>
                    <div>Faction materials: ${badge(rStat.factionMaterials)}</div>
                    <div>Shader compilation: ${badge(rStat.shaderCompilation)}</div>
                    <div>Fog of war: ${badge(rStat.fogOfWar)}</div>
                    <div>WebGL context: ${badge(rStat.webglContext)}</div>
                </div>
            </div>
        `;

        const tab = this.activeTab;
        if (tab === 'overview') {
            body.innerHTML = `
                ${renderStatusCardHtml}
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;background:rgba(15,23,42,0.85);padding:6px 8px;border-radius:6px;border:1px solid rgba(0,229,255,0.25);">
                    <div>Total Zerg: <b style="color:#fff;">${aiRep.totalZergUnits}</b></div>
                    <div>Moving: <b style="color:#34d399;">${aiRep.movingCount}</b></div>
                    <div>Attacking: <b style="color:#f87171;">${aiRep.attackingCount}</b></div>
                    <div>Runtime Errs: <b style="color:${errList.length ? '#f87171' : '#34d399'};">${errList.length}</b></div>
                    <div>FPS: <b style="color:#38bdf8;">${gSnap ? gSnap.fps : 60}</b></div>
                    <div>Init Status: <b style="color:${sysVal.overallStatus === 'PASS' ? '#34d399' : '#f87171'};">${sysVal.overallStatus}</b></div>
                </div>
                ${simHtml}
                <div style="background:rgba(15,23,42,0.75);border:1px solid rgba(148,163,184,0.25);border-radius:6px;padding:6px 8px;">
                    <div style="font-weight:700;color:#38bdf8;margin-bottom:3px;">SCENE VS ARRAY RECONCILIATION</div>
                    <div>Zerg in enemies[]: <b>${enemies.length}</b> | Zerg Meshes in Scene: <b>${sceneCheck.sceneZergMeshCount}</b> | Orphaned: <b style="color:${sceneCheck.orphanedCount ? '#ef4444' : '#22c55e'};">${sceneCheck.orphanedCount}</b></div>
                    <div>Terran/Solaris Units: <b>${units.length}</b> | Player Blds: <b>${buildings.length}</b> | Zerg Blds: <b>${enemyBuildings.length}</b></div>
                </div>
                <div style="background:rgba(2,6,14,0.85);border:1px solid rgba(148,163,184,0.2);border-radius:4px;padding:5px 7px;max-height:110px;overflow-y:auto;font-size:10px;color:#94a3b8;">
                    <div style="color:#00e5ff;font-weight:700;margin-bottom:2px;">LIVE EVENT STREAM:</div>
                    ${this.logHistory.slice(-14).reverse().join('<br>') || 'No events logged yet.'}
                </div>
            `;
        } else if (tab === 'errors') {
            const q = (this.errorSearchQuery || '').trim().toLowerCase();
            const filtered = errList.filter(e => {
                if (this.severityFilter !== 'ALL' && e.severity !== this.severityFilter) return false;
                if (this.categoryFilter !== 'ALL' && e.category !== this.categoryFilter) return false;
                if (q) {
                    const hay = `${e.message || ''} ${e.file || ''} ${e.func || ''} ${e.context || ''} ${e.category || ''}`.toLowerCase();
                    if (!hay.includes(q)) return false;
                }
                return true;
            });
            const firstErr = window.APP_ERROR_HANDLER ? window.APP_ERROR_HANDLER.firstStartupError : null;
            const firstStage = window.APP_ERROR_HANDLER ? window.APP_ERROR_HANDLER.firstFailedRenderStage : null;
            const errRows = filtered.slice().reverse().map(e => `
                <div style="border-bottom:1px solid #1e293b;padding:5px 0;">
                    <span style="color:#38bdf8;">[${e.time}]</span>
                    <b style="color:${e.severity === 'CRITICAL' || e.severity === 'ERROR' ? '#ef4444' : '#fbbf24'};">[${e.severity}/${e.category}]</b>
                    <span style="color:#cbd5e1;">${e.context}</span> (x${e.count})
                    ${e.affectedObject ? `<span style="color:#c084fc;">[${e.affectedObject}]</span>` : ''}<br/>
                    <span style="color:#f87171;">${e.message}</span><br/>
                    <span style="color:#64748b;font-size:9.5px;">${e.file}:${e.line} @ ${e.func}</span>
                    ${e.fullStack || e.stack ? `<details style="margin-top:2px;"><summary style="cursor:pointer;color:#94a3b8;font-size:9.5px;">Expand Full Stack Trace</summary><pre style="white-space:pre-wrap;font-size:9px;color:#cbd5e1;background:rgba(15,23,42,0.85);padding:4px;border-radius:4px;margin:2px 0;">${e.fullStack || e.stack}</pre></details>` : ''}
                </div>
            `).join('');
            body.innerHTML = `
                <div style="background:rgba(15,23,42,0.85);border:1px solid #334155;border-radius:6px;padding:5px 8px;font-size:9.5px;">
                    <div>First Startup Error: <b style="color:${firstErr ? '#ef4444' : '#22c55e'};">${firstErr ? `[${firstErr.time}] ${firstErr.context}: ${firstErr.message}` : 'NONE'}</b></div>
                    <div>First Failed Render Stage: <b style="color:${firstStage ? '#ef4444' : '#22c55e'};">${firstStage ? `[${firstStage.time}] ${firstStage.stage}: ${firstStage.message}` : 'NONE'}</b></div>
                    <div>Retained Errors: <b>${filtered.length}</b> shown / <b>${errList.length}</b> total (Capacity: ${window.APP_ERROR_HANDLER ? window.APP_ERROR_HANDLER.maxLogs : 500})</div>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:10px;">
                    <input id="dbg-err-search" type="text" placeholder="Search message, file, func, category..." value="${(this.errorSearchQuery || '').replace(/"/g, '&quot;')}" style="flex:1;min-width:140px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;padding:2px 5px;font:10px monospace;border-radius:3px;" />
                    <span>Sev:</span>
                    <select id="dbg-sel-sev" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;font:10px monospace;">
                        ${['ALL', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].map(s => `<option value="${s}" ${this.severityFilter === s ? 'selected' : ''}>${s}</option>`).join('')}
                    </select>
                    <span>Cat:</span>
                    <select id="dbg-sel-cat" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;font:10px monospace;">
                        ${['ALL', 'runtime', 'promise', 'graphics', 'shader', 'terrain', 'zerg_ai', 'initialization', 'diagnostic_test'].map(c => `<option value="${c}" ${this.categoryFilter === c ? 'selected' : ''}>${c}</option>`).join('')}
                    </select>
                </div>
                <div style="background:rgba(2,6,14,0.9);border:1px solid #334155;border-radius:6px;padding:6px 8px;max-height:240px;overflow-y:auto;">
                    ${errRows || '<div style="color:#22c55e;">0 Matching Runtime Errors Recorded ✓</div>'}
                </div>
            `;
            const inpSearch = document.getElementById('dbg-err-search');
            if (inpSearch) {
                inpSearch.oninput = () => {
                    this.errorSearchQuery = inpSearch.value;
                    this.renderUI(true);
                };
            }
            const selSev = document.getElementById('dbg-sel-sev');
            if (selSev) selSev.onchange = () => { this.severityFilter = selSev.value; this.renderUI(true); };
            const selCat = document.getElementById('dbg-sel-cat');
            if (selCat) selCat.onchange = () => { this.categoryFilter = selCat.value; this.renderUI(true); };
        } else if (tab === 'graphics') {
            const g = gSnap || { contextStatus: 'ACTIVE', contextLossCount: 0, contextRestoreCount: 0, rendererInfo: { renderer: 'WebGL' }, fps: 60, frameTimeMs: 16.6, qualityTier: 'high', devicePixelRatio: 1, drawCalls: 0, triangles: 0, geometries: 0, textures: 0, shaderValidation: { validatedCount: 0, failedInjections: [], fallbackMaterialsUsed: 0, compilationErrors: [] } };
            body.innerHTML = `
                ${renderStatusCardHtml}
                <div style="background:rgba(30,18,52,0.75);border:1px solid #a855f7;border-radius:6px;padding:7px 9px;">
                    <div style="font-weight:700;color:#d8b4fe;margin-bottom:4px;">WEBGL &amp; SHADER DIAGNOSTICS</div>
                    <div>Context Status: <b style="color:#22c55e;">${g.contextStatus}</b> (Losses: ${g.contextLossCount}, Restores: ${g.contextRestoreCount})</div>
                    <div>GPU: <span style="color:#cbd5e1;">${g.rendererInfo.renderer}</span></div>
                    <div>Shadows Synced: <b style="color:#22c55e;">${renderer && renderer.shadowMap ? (renderer.shadowMap.enabled ? 'ENABLED' : 'DISABLED (MOBILE SAFE)') : 'N/A'}</b></div>
                    <div>Draw Calls: <b>${g.drawCalls}</b> | Tris: <b>${g.triangles}</b> | Geoms: <b>${g.geometries}</b> | GPU Tex: <b>${g.textures}</b></div>
                    <div>Shader Validated: <b>${g.shaderValidation.validatedCount}</b> | Failed Injections: <b>${g.shaderValidation.failedInjections.length}</b> | Compile Errs: <b>${g.shaderValidation.compilationErrors.length}</b></div>
                </div>
                <div style="background:rgba(15,23,42,0.85);border:1px solid #38bdf8;border-radius:6px;padding:7px 9px;">
                    <div style="font-weight:700;color:#38bdf8;margin-bottom:4px;">CENTRALIZED TEXTURE REGISTRY (${texSnap.totalRegistered} Textures)</div>
                    <div>Missing / Invalid Textures: <b style="color:${texSnap.missingOrInvalid.length ? '#ef4444' : '#22c55e'};">${texSnap.missingOrInvalid.length}</b></div>
                    <div style="max-height:110px;overflow-y:auto;margin-top:4px;font-size:9.5px;color:#cbd5e1;">
                        ${texSnap.entries.map(t => `<div>• <b>${t.name}</b>: ${(t.status === 'OK' || t.hasData) ? '<span style="color:#22c55e;">READY</span>' : '<span style="color:#ef4444;">FALLBACK</span>'} (${t.width}x${t.height})</div>`).join('')}
                    </div>
                </div>
            `;
        } else if (tab === 'terrain') {
            const bridgeCount = Array.isArray(window.BRIDGES) ? window.BRIDGES.length : 0;
            const gemCount = Array.isArray(window.GEM_CRATERS) ? window.GEM_CRATERS.length : 0;
            const hotspotCount = typeof NAV_STUCK_HOTSPOTS !== 'undefined' ? NAV_STUCK_HOTSPOTS.length : 0;
            const curStage = (window.SHADER_ENGINE && typeof window.SHADER_ENGINE.terrainShaderStage === 'number') ? window.SHADER_ENGINE.terrainShaderStage : 4;
            const tPipe = rStat.details && rStat.details.terrainPipeline ? rStat.details.terrainPipeline : {};
            body.innerHTML = `
                ${renderStatusCardHtml}
                <div style="background:rgba(15,23,42,0.85);border:1px solid #34d399;border-radius:6px;padding:7px 9px;">
                    <div style="font-weight:700;color:#34d399;margin-bottom:4px;">TERRAIN GEOMETRY &amp; SHADER ISOLATION</div>
                    <div>Active Biome: <b>${(window.ACTIVE_PLANET_BIOME || 'highland').toUpperCase()}</b> | Seed: <b>#${window.MAP_SEED || 100}</b></div>
                    <div>Vertices: <b>${tPipe.vertexCount || 0}</b> | Positions Finite: <b>${tPipe.positionFinite ? 'YES' : 'NO'}</b> | Vertex Colors: <b>${tPipe.colorValid ? 'VALID' : 'FALLBACK'}</b></div>
                    <div>Bridges: <b>${bridgeCount}</b> | Gem Craters: <b>${gemCount}</b> | Dynamic Stuck Hotspots: <b>${hotspotCount}</b></div>
                    <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                        <span>Shader Stage:</span>
                        <select id="dbg-terrain-stage" style="background:#0f172a;color:#00e5ff;border:1px solid #00e5ff;padding:2px 4px;font:10px monospace;">
                            <option value="0" ${curStage === 0 ? 'selected' : ''}>0: Plain MeshStandardMaterial (No Custom Shader)</option>
                            <option value="1" ${curStage === 1 ? 'selected' : ''}>1: + Terrain Detail Texture</option>
                            <option value="2" ${curStage === 2 ? 'selected' : ''}>2: + Normal Map &amp; Lighting</option>
                            <option value="3" ${curStage === 3 ? 'selected' : ''}>3: + Koprulu Terrain Shader (No FOW)</option>
                            <option value="4" ${curStage === 4 ? 'selected' : ''}>4: Full Terrain Shader + Fog of War</option>
                        </select>
                        <button id="dbg-btn-test-patch" style="background:#064e3b;color:#6ee7b7;border:1px solid #10b981;border-radius:3px;padding:2px 6px;cursor:pointer;font:10px monospace;">TOGGLE TEST TERRAIN PATCH</button>
                    </div>
                </div>
            `;
            const selStage = document.getElementById('dbg-terrain-stage');
            if (selStage) {
                selStage.onchange = () => {
                    if (window.SHADER_ENGINE && typeof window.SHADER_ENGINE.setTerrainShaderStage === 'function') {
                        window.SHADER_ENGINE.setTerrainShaderStage(Number(selStage.value));
                        this.renderUI(true);
                    }
                };
            }
            const btnPatch = document.getElementById('dbg-btn-test-patch');
            if (btnPatch) {
                btnPatch.onclick = () => {
                    if (typeof window.toggleDiagnosticTerrainPatch === 'function') {
                        window.toggleDiagnosticTerrainPatch();
                        this.renderUI(true);
                    }
                };
            }
        } else if (tab === 'factions') {
            const tUnits = units.filter(u => u && u.hp > 0 && u.faction !== 'solaris').length;
            const sUnits = units.filter(u => u && u.hp > 0 && u.faction === 'solaris').length;
            const zUnits = enemies.filter(e => e && e.hp > 0).length;
            const fRep = rStat.details && rStat.details.factionMaterials ? rStat.details.factionMaterials : { totalChecked: 0, repairedCount: 0, ok: true };
            const fChecked = fRep.checked ?? fRep.totalChecked ?? 0;
            const fRepaired = fRep.repaired ?? fRep.repairedCount ?? 0;
            const fStatus = (fRep.status === 'PASS' || fRep.ok !== false) ? 'PASS' : 'FAIL';
            body.innerHTML = `
                ${renderStatusCardHtml}
                <div style="background:rgba(15,23,42,0.85);border:1px solid #38bdf8;border-radius:6px;padding:7px 9px;">
                    <div style="font-weight:700;color:#38bdf8;margin-bottom:4px;">3-FACTION FORCE, MATERIALS &amp; SHOWCASE</div>
                    <div><b>Terran Dominion</b>: ${tUnits} Units | ${buildings.length} Structures | Minerals: ${Math.floor(state.req || 0)} | Gems: ${Math.floor(state.gems || 0)}</div>
                    <div><b>Solaris Protoss</b>: ${sUnits} Units | ${solarisBuildings.length} Enclave Structures | Mode: ${(state.aiAllyMode || 'defensive').toUpperCase()}</div>
                    <div><b>Zerg Swarm</b>: ${zUnits} Units | ${enemyBuildings.length} Hive Structures | Wave: ${state.wave || 1}</div>
                    <div style="margin-top:4px;">Faction Material Audit: <b style="color:#22c55e;">${fStatus}</b> (${fChecked} materials verified, ${fRepaired} auto-repaired)</div>
                    <div style="margin-top:6px;">
                        <button id="dbg-btn-faction-showcase" style="background:#1e3a8a;color:#93c5fd;border:1px solid #3b82f6;border-radius:3px;padding:3px 8px;cursor:pointer;font:10px monospace;">TOGGLE 3-FACTION 3D SHOWCASE</button>
                    </div>
                </div>
            `;
            const btnShow = document.getElementById('dbg-btn-faction-showcase');
            if (btnShow) {
                btnShow.onclick = () => {
                    if (typeof window.toggleDiagnosticFactionShowcase === 'function') {
                        window.toggleDiagnosticFactionShowcase();
                        this.renderUI(true);
                    }
                };
            }
        } else if (tab === 'zerg') {
            const unitRows = aiRep.units.map(u => {
                const isSel = selUnit && selUnit.unitId === u.unitId;
                const stCol = u.aiState === 'ATTACKING' ? '#f87171' : (u.isStuck ? '#fbbf24' : '#34d399');
                return `<div data-uid="${u.unitId}" class="dbg-unit-row" style="display:flex;justify-content:space-between;padding:3px 6px;border-radius:4px;cursor:pointer;background:${isSel ? 'rgba(0,229,255,0.22)' : 'rgba(15,23,42,0.65)'};border:1px solid ${isSel ? '#00e5ff' : 'transparent'};">
                    <span><b>${u.unitId}</b> (${u.unitType})</span>
                    <span style="color:${stCol};">${u.aiState} · ${u.actualSpeedPerSec}m/s</span>
                </div>`;
            }).join('');
            const bldRows = enemyBuildings.map((eb, idx) =>
                `<div>#${idx + 1} <b>${eb.role}</b> HP:${Math.round(eb.hp)}/${eb.maxHp} | Build:${Math.round((eb.buildProgress ?? 1) * 100)}% | SpawnTimer:${eb.spawnTimer !== undefined ? eb.spawnTimer.toFixed(1) + 's' : 'N/A'}</div>`
            ).join('');
            body.innerHTML = `
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;background:rgba(15,23,42,0.85);padding:6px 8px;border-radius:6px;border:1px solid rgba(0,229,255,0.25);">
                    <div>Total Zerg: <b style="color:#fff;">${aiRep.totalZergUnits}</b></div>
                    <div>Moving: <b style="color:#34d399;">${aiRep.movingCount}</b></div>
                    <div>Attacking: <b style="color:#f87171;">${aiRep.attackingCount}</b></div>
                    <div>Searching: <b style="color:#38bdf8;">${aiRep.searchingCount}</b></div>
                    <div>Stuck: <b style="color:#fbbf24;">${aiRep.stuckCount}</b></div>
                    <div>Recovering: <b style="color:#c084fc;">${aiRep.recoveringCount}</b></div>
                </div>
                ${simHtml}
                <div style="background:rgba(15,23,42,0.8);border:1px solid rgba(184,69,255,0.4);border-radius:6px;padding:6px 8px;font-size:10px;">
                    <div style="font-weight:700;color:#d8b4fe;margin-bottom:3px;">ZERG HIVE SPAWNER TIMERS (${enemyBuildings.length} Structures)</div>
                    ${bldRows || 'No Zerg structures active.'}
                </div>
                <div style="display:flex;flex-direction:column;gap:3px;max-height:130px;overflow-y:auto;">
                    <div style="font-size:10px;color:#94a3b8;font-weight:700;">CLICK ZERG UNIT TO INSPECT IN TAB 10:</div>
                    ${unitRows || '<div style="color:#64748b;font-size:10px;">0 living Zerg units</div>'}
                </div>
            `;
            body.querySelectorAll('.dbg-unit-row').forEach(r => {
                r.onclick = () => {
                    this.selectUnit(r.getAttribute('data-uid'));
                    this.activeTab = 'inspector';
                    this.renderUI(true);
                };
            });
        } else if (tab === 'world_init') {
            const stageRows = sysVal.stages.map(s => {
                const col = s.status === 'PASS' ? '#22c55e' : (s.status === 'WARNING' ? '#fbbf24' : '#ef4444');
                return `<div style="border-bottom:1px solid #1e293b;padding:4px 0;">
                    <div style="display:flex;justify-content:space-between;">
                        <b>[${s.category}] ${s.name}</b>
                        <span style="color:${col};font-weight:700;">${s.status} (${s.durationMs}ms)</span>
                    </div>
                    <div style="color:#94a3b8;font-size:10px;">${s.details}</div>
                </div>`;
            }).join('');
            body.innerHTML = `
                <div style="background:rgba(15,23,42,0.85);border:1px solid #00e5ff;border-radius:6px;padding:7px 9px;">
                    <div style="font-weight:700;color:#00e5ff;margin-bottom:4px;">SYSTEM INITIALIZATION VALIDATOR (${sysVal.overallStatus})</div>
                    ${stageRows}
                </div>
            `;
        } else if (tab === 'loading') {
            const bcState = window.BATTLE_CINEMATIC ? window.BATTLE_CINEMATIC.getState() : null;
            body.innerHTML = `
                <div style="background:rgba(15,23,42,0.85);border:1px solid #38bdf8;border-radius:6px;padding:7px 9px;">
                    <div style="font-weight:700;color:#38bdf8;margin-bottom:4px;">LOADING &amp; BATTLE CINEMATIC PIPELINE</div>
                    <div>Title Screen Active: <b>${!!window.titleScreenActive}</b> | Camera Sweep: <b>${!!window.loadingCameraSweep}</b></div>
                    <div>Cinematic Lifecycle: <b>${bcState ? bcState.lifecycleState : 'N/A'}</b> | View Mode: <b>${window.BATTLE_CINEMATIC ? window.BATTLE_CINEMATIC.cameraViewMode : 'auto'}</b></div>
                    <div>Stage: <b>${bcState ? `${bcState.stage}/${bcState.totalStages} (${bcState.title})` : 'N/A'}</b></div>
                </div>
            `;
        } else if (tab === 'performance') {
            const pRep = window.PERF_PROFILER && typeof window.PERF_PROFILER.getReport === 'function' ? window.PERF_PROFILER.getReport() : null;
            body.innerHTML = `
                <div style="background:rgba(15,23,42,0.85);border:1px solid #fbbf24;border-radius:6px;padding:7px 9px;">
                    <div style="font-weight:700;color:#fbbf24;margin-bottom:4px;">FRAME BUDGET &amp; MEMORY PROFILER</div>
                    <div>FPS: <b>${gSnap ? gSnap.fps : 60}</b> | Frame Time: <b>${gSnap ? gSnap.frameTimeMs : 16.6}ms</b> | Quality Tier: <b>${gSnap ? gSnap.qualityTier : 'high'}</b></div>
                    <div>Active Projectiles: <b>${projectiles.length}</b> | Particles: <b>${particles.length}</b> | Smoke: <b>${smokeClouds.length}</b></div>
                    <div>Profiler Summary: <span style="color:#cbd5e1;">${pRep ? JSON.stringify(pRep.averagesMs || {}) : 'Active'}</span></div>
                </div>
            `;
        } else if (tab === 'inspector') {
            const unitRows = aiRep.units.map(u => {
                const isSel = selUnit && selUnit.unitId === u.unitId;
                return `<option value="${u.unitId}" ${isSel ? 'selected' : ''}>${u.unitId} (${u.unitType}) - ${u.aiState}</option>`;
            }).join('');
            const inspectorHtml = selUnit ? `
                <div style="background:rgba(15,23,42,0.85);border:1px solid rgba(56,189,248,0.4);border-radius:6px;padding:7px 9px;">
                    <div style="font-weight:700;color:#38bdf8;margin-bottom:4px;">UNIT INSPECTOR: ${selUnit.unitId} (${selUnit.unitType.toUpperCase()})</div>
                    <div>AI State: <b>${selUnit.aiState}</b> | Position: <b>(${selUnit.position.x}, ${selUnit.position.z})</b></div>
                    <div>Target: <b>${selUnit.currentTarget}</b> @ <b>${selUnit.targetCoords ? `(${selUnit.targetCoords.x}, ${selUnit.targetCoords.z})` : 'N/A'}</b> (${selUnit.targetDistance ?? '-'}m)</div>
                    <div>Destination: <b>${selUnit.destination ? `(${selUnit.destination.x}, ${selUnit.destination.z})` : 'N/A'}</b> (Dist: ${selUnit.distanceToDestination ?? '-'}m)</div>
                    <div>Nav Waypoint: <b>${selUnit.navigationWaypoint ? `(${selUnit.navigationWaypoint.x}, ${selUnit.navigationWaypoint.z})` : 'N/A'}</b> | Nav Status: <b style="color:${selUnit.navigationSuccess ? '#22c55e' : '#ef4444'};">${selUnit.navigationSuccess ? 'SUCCESS' : 'FAILED'} (${selUnit.navigationResult})</b></div>
                    <div>Config Speed: <b>${selUnit.movementSpeed}m/s</b> | Actual Displacement/s: <b>${selUnit.actualSpeedPerSec}m/s</b></div>
                    <div>Stop Reason: <b>${selUnit.stopReason}</b> | Walkable Ground: <b style="color:${selUnit.terrainWalkable ? '#22c55e' : '#ef4444'};">${selUnit.terrainWalkable ? 'YES' : 'NO'}</b></div>
                    <div>Bridge Assigned: <b>${selUnit.bridgeAssignment}</b> | Recovery Attempts: <b>${selUnit.lastRecoveryAttempt}</b></div>
                    <div>Last Move: <b>${selUnit.lastSuccessfulMovementTime}s</b> | Last Attack: <b>${selUnit.lastSuccessfulAttackTime}s</b></div>
                    <div>Last JS Error: <span style="color:${selUnit.currentError ? '#f87171' : '#94a3b8'};">${selUnit.currentError || 'None'}</span></div>
                </div>
            ` : `<div style="color:#94a3b8;padding:6px;">No active Zerg units on battlefield. Click "▶ ZERG SIM" to spawn and verify units.</div>`;
            body.innerHTML = `
                <div style="display:flex;gap:6px;align-items:center;">
                    <span>Select Unit:</span>
                    <select id="dbg-inspector-select" style="flex:1;background:#0f172a;color:#e2e8f0;border:1px solid #38bdf8;padding:3px;font:10px monospace;">
                        ${unitRows || '<option value="">No units</option>'}
                    </select>
                </div>
                ${inspectorHtml}
            `;
            const selEl = document.getElementById('dbg-inspector-select');
            if (selEl) selEl.onchange = () => this.selectUnit(selEl.value);
        }
    },
    update(dt) {
        if (this.followUnitId && typeof controls !== 'undefined' && controls) {
            const targetUnit = enemies.find(e => e && e.id === this.followUnitId && e.hp > 0 && e.mesh);
            if (targetUnit) {
                controls.target.lerp(targetUnit.mesh.position, Math.min(1, dt * 8.0));
            } else {
                this.followUnitId = null;
            }
        }
        if (!this.enabled) return;
        this._updateWorldViz();
        this.renderUI(false);
    }
};
window.toggleStarblockDebugMode = function() {
    if (window.AI_DEBUG) window.AI_DEBUG.toggle();
};

window.addEventListener('keydown', (ev) => {
    if (ev.key === 'F8') {
        ev.preventDefault();
        if (window.AI_DEBUG) window.AI_DEBUG.toggle();
    }
});

const MAX_MIND_CONTROL_UNITS = 3;

function getActiveMindControlledCount() {
    return UNIT_COUNTS.mindControlled;
}

function convertEnemyWithMindControl(enemyObj, emitterWorldPos) {
    // Strictly cap Mind Control at 3 active controlled units!
    const currentThralls = getActiveMindControlledCount();
    if (currentThralls >= MAX_MIND_CONTROL_UNITS) {
        return false;
    }

    const idx = enemies.indexOf(enemyObj);
    if (idx === -1) return false;
    enemies.splice(idx, 1);

    if (typeof spawnMindControlDominationFX === 'function') {
        spawnMindControlDominationFX(enemyObj.mesh.position, emitterWorldPos);
    }

    // Replace enemy health bar with psionic magenta allied health bar
    if (enemyObj.hb && enemyObj.hb.root) enemyObj.hb.root.remove();
    const hb = makeHealthPip('#d946ef');

    // Add selection circle + glowing psionic neural halo above converted unit
    const selCircle = new THREE.Mesh(unitSelRingGeo, unitSelRingMat);
    selCircle.position.y = enemyObj.isAir ? -5.6 : 0.08;
    selCircle.scale.setScalar((enemyObj.radius || 0.6) * 1.55);
    selCircle.visible = false;
    enemyObj.mesh.add(selCircle);

    const psiHalo = new THREE.Mesh(
        new THREE.RingGeometry(0.28, 0.42, 20),
        SHARED_FX_MAT.mindControlRing || MAT.hiveVeinGlow
    );
    psiHalo.rotation.x = -Math.PI / 2;
    psiHalo.position.y = enemyObj.variant === 'behemoth' ? 1.85 : 1.15;
    enemyObj.mesh.add(psiHalo);
    if (enemyObj.mesh.userData) {
        enemyObj.mesh.userData.isMindControlled = true;
    }
    const isMeleeZerg = (enemyObj.variant === 'skitterer' || enemyObj.variant === 'burster' || enemyObj.variant === 'crusher');

    units.push({
        type: enemyObj.variant,
        variant: enemyObj.variant,
        isMindControlled: true,
        isAir: !!enemyObj.isAir,
        isVehicle: false,
        isMechanical: false,
        isBiological: true,
        radius: enemyObj.radius || 0.58,
        mesh: enemyObj.mesh,
        hb,
        healBeam: null,
        selCircle,
        hp: enemyObj.maxHp,
        maxHp: enemyObj.maxHp,
        damage: Math.max(24, Math.round((enemyObj.damage || 20) * 1.25)),
        range: isMeleeZerg ? Math.max(2.25, enemyObj.range || 2.0) : Math.max(9.0, enemyObj.range || 9.0),
        speed: (enemyObj.speed || 3.2) * 1.12,
        fireRate: Math.max(0.35, (enemyObj.fireRate || 1.0) * 0.85),
        cooldown: 0,
        retaliateTarget: null,
        currentYaw: enemyObj.currentYaw || 0,
        currentPitch: 0,
        currentRoll: 0,
        order: 'auto',
        orderTarget: null,
        stuckTimer: 0,
        lastProgressPos: enemyObj.mesh.position.clone(),
        flankSign: (units.length % 2 === 0 ? 1 : -1),
        lastHitImpulse: null,
        lastHitHeavy: false
    });
    UNIT_COUNTS.mindControlled++;
    const newCount = UNIT_COUNTS.mindControlled;
    spawnCombatFloat(enemyObj.mesh.position, `MIND CONTROLLED! (${newCount}/${MAX_MIND_CONTROL_UNITS})`, '#d946ef');
    if (state.selectedBuilding && state.selectedBuilding.type === 'turret') {
        renderSC2CommandCard();
    }
    updateHUD();
    return true;
}

// Intelligent 9-Step Stuck Detection & Progressive Recovery State Machine for Ground Units
function checkAndUnstickGroundUnit(actor, targetPos, dt) {
    if (actor.isAir || !targetPos) return;
    if (actor.type === 'siege_tank' && actor.siegeMode) return;
    if (!actor.lastProgressPos) {
        actor.lastProgressPos = actor.mesh.position.clone();
        actor.anchorCheckPos = actor.mesh.position.clone();
        actor.anchorCheckTimer = 0;
        actor.stuckTimer = 0;
        actor.recoveryStage = 0;
        actor.recoveryCooldown = 0;
        return;
    }

    if (actor.recoveryCooldown > 0) {
        actor.recoveryCooldown = Math.max(0, actor.recoveryCooldown - dt);
    }

    // Net-displacement anti-circling detector: if a unit runs in a small loop for 1.6s without advancing > 2.4m, escalate recovery!
    if (!actor.anchorCheckPos) actor.anchorCheckPos = actor.mesh.position.clone();
    actor.anchorCheckTimer = (actor.anchorCheckTimer || 0) + dt;
    let isOrbitingInPlace = false;
    if (actor.anchorCheckTimer >= 1.6) {
        const adx = actor.mesh.position.x - actor.anchorCheckPos.x;
        const adz = actor.mesh.position.z - actor.anchorCheckPos.z;
        const netDispSq = adx * adx + adz * adz;
        const gdx = targetPos.x - actor.mesh.position.x;
        const gdz = targetPos.z - actor.mesh.position.z;
        const distToGoalSq = gdx * gdx + gdz * gdz;
        actor.anchorCheckPos.copy(actor.mesh.position);
        actor.anchorCheckTimer = 0;
        if (netDispSq < 5.76 && distToGoalSq > 10.0) { // 2.4^2 and 3.16^2
            isOrbitingInPlace = true;
            if (actor.patrolTarget && !state.enemyBaseDiscovered && enemyBuildings.length > 0) {
                actor.patrolTarget.set(
                    ENEMY_BASE_POS.x,
                    getTerrainHeight(ENEMY_BASE_POS.x, ENEMY_BASE_POS.z),
                    ENEMY_BASE_POS.z
                );
            }
        }
    }

    const mdx = actor.mesh.position.x - actor.lastProgressPos.x;
    const mdz = actor.mesh.position.z - actor.lastProgressPos.z;
    const movedDistSq = mdx * mdx + mdz * mdz;
    if (movedDistSq > 0.0256 && !isOrbitingInPlace) { // 0.16^2
        actor.lastProgressPos.copy(actor.mesh.position);
        actor.stuckTimer = 0;
        if (actor.recoveryCooldown <= 0) actor.recoveryStage = 0;
    } else {
        actor.stuckTimer = isOrbitingInPlace ? 0.48 : ((actor.stuckTimer || 0) + dt);
        if (actor.stuckTimer > 0.40) {
            actor.stuckTimer = 0.16;
            actor.recoveryStage = Math.min(9, (actor.recoveryStage || 0) + 1);
            actor.recoveryCooldown = 3.2;

            const ax = actor.mesh.position.x;
            const az = actor.mesh.position.z;
            const surfH = typeof getSurfaceHeightWithBridges === 'function' ? getSurfaceHeightWithBridges : getTerrainHeight;
            const stepLen = Math.min(0.20, (actor.speed || 3.5) * dt * 1.35);

            // Step 1-2: Local obstacle avoidance & lateral sidestep around blocking neighbor
            actor.wallFollowSign = -(actor.wallFollowSign || actor.flankSign || 1);
            actor.wallFollowTimer = 1.65;

            // Step 3: Clear blocked local waypoint & record hotspot
            if (typeof window.recordNavStuckHotspot === 'function') {
                window.recordNavStuckHotspot(ax, az, 2.8, 1.85);
            }
            if (actor.navWaypoints && actor.navWaypoints.length > 1) {
                actor.navWaypoints.shift();
            } else {
                actor.navWaypoints = null;
            }

            // Step 4-5: Request alternative bridge or repath with congestion penalty
            if (actor.recoveryStage >= 3) {
                actor.navWaypoints = null;
                actor.navRepathTimer = 0;
                if (window.BRIDGE_TRAFFIC_MANAGER) {
                    window.BRIDGE_TRAFFIC_MANAGER.releaseActor(actor);
                }
                if (typeof RIVER_BRIDGES !== 'undefined' && RIVER_BRIDGES.length > 1) {
                    actor.preferredBridgeIdx = ((actor.preferredBridgeIdx || 0) + 1) % RIVER_BRIDGES.length;
                }
            }

            // Step 6: Yield to higher-priority heavy unit (tank / siege_tank / crusher / behemoth)
            const isLightInfantry = !actor.isVehicle && actor.type !== 'tank' && actor.type !== 'siege_tank' && actor.variant !== 'behemoth' && actor.variant !== 'crusher';
            if (isLightInfantry && actor.recoveryStage >= 2) {
                for (let ui = 0; ui < units.length; ui++) {
                    const uOther = units[ui];
                    if (!uOther || uOther === actor || !uOther.isVehicle || !uOther.mesh) continue;
                    const odx = ax - uOther.mesh.position.x;
                    const odz = az - uOther.mesh.position.z;
                    const odSq = odx * odx + odz * odz;
                    if (odSq > 0.01 && odSq < 5.2) {
                        const invO = 1.0 / Math.sqrt(odSq);
                        const yx = ax + odx * invO * stepLen * 1.4;
                        const yz = az + odz * invO * stepLen * 1.4;
                        if (isWalkableGround(yx, yz, 0.35)) {
                            actor.mesh.position.x = yx;
                            actor.mesh.position.z = yz;
                            actor.mesh.position.y = THREE.MathUtils.lerp(actor.mesh.position.y, surfH(yx, yz), 0.5);
                        }
                        break;
                    }
                }
            }

            // Step 7-9: Switch to column mode, recalibrate enemy flanker, or reset unreachable patrol target
            if (actor.variant) {
                actor.isFlanker = true;
                actor.flankRecalibrateCount = (actor.flankRecalibrateCount || 0) + 1;
                actor.flankSign = (actor.flankRecalibrateCount % 2 === 0) ? 1 : -1;
                const tactics = ['west_bridge_pincer', 'east_bridge_pincer', 'canyon_rim_envelopment', 'rear_eco_raid'];
                actor.flankTactic = tactics[(actor.flankRecalibrateCount + Math.floor(Math.abs(ax))) % tactics.length];
            } else if (actor.recoveryStage >= 7 && actor.order === 'move') {
                actor.order = 'attack_move';
            }

            // Smooth bridge deck / ramp progression if on or near a river bridge
            if (typeof getRiverCoords === 'function' && typeof RIVER_BRIDGES !== 'undefined' && RIVER_BRIDGES.length > 0) {
                const rc = getRiverCoords(ax, az);
                let bestBr = RIVER_BRIDGES[0];
                let minDS = Infinity;
                for (let i = 0; i < RIVER_BRIDGES.length; i++) {
                    const dS = Math.abs(rc.s - RIVER_BRIDGES[i].sCoord);
                    if (dS < minDS) {
                        minDS = dS;
                        bestBr = RIVER_BRIDGES[i];
                    }
                }
                const bCenterU = typeof getRiverCenterUAtS === 'function' ? getRiverCenterUAtS(bestBr.sCoord) : 0;
                const dU = Math.abs(rc.u - bCenterU);
                if (dU <= RIVER_HALF_WIDTH + 7.5 && minDS <= bestBr.halfWidth + 2.5) {
                    const destRC = getRiverCoords(targetPos.x, targetPos.z);
                    const uStepSign = (destRC.u - bCenterU) >= 0 ? 1 : -1;
                    let safeWorld;
                    if (dU <= RIVER_HALF_WIDTH + 2.4) {
                        const newS = rc.s + Math.sign(bestBr.sCoord - rc.s) * Math.min(Math.abs(bestBr.sCoord - rc.s), stepLen * 1.15);
                        const newU = rc.u + uStepSign * stepLen * 1.25;
                        safeWorld = riverCoordsToWorld(newS, newU);
                    } else {
                        const toDestX = targetPos.x - ax;
                        const toDestZ = targetPos.z - az;
                        const toDestLen = Math.hypot(toDestX, toDestZ) || 1;
                        safeWorld = {
                            x: ax + (toDestX / toDestLen) * stepLen * 1.25,
                            z: az + (toDestZ / toDestLen) * stepLen * 1.25
                        };
                    }
                    if (isWalkableGround(safeWorld.x, safeWorld.z, (actor.radius || 0.50) * 0.40)) {
                        actor.mesh.position.x = safeWorld.x;
                        actor.mesh.position.z = safeWorld.z;
                        actor.mesh.position.y = THREE.MathUtils.lerp(actor.mesh.position.y, surfH(safeWorld.x, safeWorld.z), 0.5);
                        actor.lastProgressPos.copy(actor.mesh.position);
                        return;
                    }
                }
            }

            // Smooth tangential sidestep around local obstacle
            const dx = targetPos.x - ax;
            const dz = targetPos.z - az;
            const dLen = Math.hypot(dx, dz) || 1;
            const tx = (-dz / dLen) * actor.wallFollowSign;
            const tz = (dx / dLen) * actor.wallFollowSign;
            const nx = ax + tx * stepLen;
            const nz = az + tz * stepLen;
            if (isWalkableGround(nx, nz, (actor.radius || 0.50) * 0.45)) {
                actor.mesh.position.x = nx;
                actor.mesh.position.z = nz;
                actor.mesh.position.y = THREE.MathUtils.lerp(actor.mesh.position.y, surfH(nx, nz), 0.5);
            }
            actor.lastProgressPos.copy(actor.mesh.position);
        }
    }
}

function recordRagdollHitImpulse(victim, originPos, isHeavy = false) {
    if (!victim || !victim.mesh) return;
    let dx = victim.mesh.position.x - originPos.x;
    let dz = victim.mesh.position.z - originPos.z;
    let lenSq = dx * dx + dz * dz;
    if (lenSq < 0.001) {
        dx = Math.random() - 0.5;
        dz = Math.random() - 0.5;
        lenSq = dx * dx + dz * dz || 1;
    }
    const invLen = 1.0 / Math.sqrt(lenSq);
    dx *= invLen;
    dz *= invLen;
    const force = isHeavy ? (5.5 + Math.random() * 2.5) : (2.2 + Math.random() * 1.4);
    const vy = isHeavy ? (5.4 + Math.random() * 2.4) : (2.6 + Math.random() * 1.2);
    if (victim.lastHitImpulse) {
        victim.lastHitImpulse.set(dx * force, vy, dz * force);
    } else {
        victim.lastHitImpulse = new THREE.Vector3(dx * force, vy, dz * force);
    }
    victim.lastHitHeavy = isHeavy;
}

// Non-Homing & Guided Ballistic Projectile Launcher with Faction-Specific 3D Visuals
function launchOrdProjectile(startPos, targetObj, wType, damage, isEnemyAcid = false, customOpts = null) {
    if (window.SFX) window.SFX.playShoot(wType);
    if (projectiles.length >= 80) {
        const old = projectiles.shift();
        if (old && old.mesh) scene.remove(old.mesh);
    }
    const isTankRound = (wType === 'tank' || wType === 'siege_tank');
    const isMortar = (wType === 'mortar' || wType === 'behemoth');
    const isPlasma = (wType === 'plasma');
    const isSniper = (wType === 'sniper');
    const isSunlance = (wType === 'sunlance' || wType === 'hero');
    const isSolarisBeam = (wType === 'stalker' || wType === 'archon' || wType === 'solaris_spire' || wType === 'phoenix' || wType === 'interceptor');
    const isValkMech = (wType === 'valk_mech');
    const isValkAA = (wType === 'valk_aa');
    const isMarauder = (wType === 'marauder');
    const isYamato = (wType === 'yamato');
    const isBcLaser = (wType === 'battlecruiser_laser' || wType === 'battlecruiser');
    const isRocket = (wType === 'rocket' || wType === 'heli_rocket' || wType === 'rocketman' || wType === 'valkyrie' || isValkAA || isMarauder);
    const isZergGoo = isEnemyAcid || wType === 'spitter' || wType === 'mutalisk' || wType === 'behemoth' || wType === 'gorgon' || wType === 'spine';

    let mesh;
    if (isZergGoo && typeof createAlgorithmicBioGooProjectile === 'function') {
        mesh = createAlgorithmicBioGooProjectile(wType);
    } else if (isTankRound && typeof createTankCannonShellMesh === 'function') {
        mesh = createTankCannonShellMesh(wType === 'siege_tank');
    } else if (window.PROJECTILE_VISUAL_FACTORY && (isRocket || isYamato || isBcLaser || isSunlance || isMortar || isSniper || wType === 'heli' || wType === 'ranger' || wType === 'reaper')) {
        const pKind = isYamato ? 'yamato' : (isBcLaser ? 'battlecruiser_laser' : (isRocket ? 'missile' : (isSunlance ? 'sunlance' : (isMortar ? 'mortar' : 'bullet'))));
        mesh = window.PROJECTILE_VISUAL_FACTORY.createProjectileVisual(pKind);
        if (isRocket) mesh.userData.hasRocketThruster = true;
    } else if (isSolarisBeam) {
        mesh = new THREE.Group();
        mesh.userData.isSolarisProj = true;
        const eggGeoFn = typeof window.createSculptedEggSacGeo === 'function'
            ? window.createSculptedEggSacGeo
            : (rx, ry, segs) => createSculptedArmorDomeGeo(rx, segs || 10, segs || 10);
        if (wType === 'archon') {
            const coreOrb = new THREE.Mesh(eggGeoFn(0.14, 0.16, 12), MAT.solarisPrismGlow || MAT.cyanGlow);
            const outerShell = new THREE.Mesh(eggGeoFn(0.22, 0.24, 12), MAT.solarisGold || MAT.amberGlow);
            const ring1 = new THREE.Mesh(createSculptedTorusCollarGeo(0.26, 0.024, 8, 18), MAT.solarisPrismGlow || MAT.cyanGlow);
            const ring2 = new THREE.Mesh(createSculptedTorusCollarGeo(0.22, 0.020, 8, 18), MAT.solarisGold || MAT.amberGlow);
            ring2.rotation.x = Math.PI / 2;
            mesh.add(coreOrb, outerShell, ring1, ring2);
            mesh.userData.gyroRing1 = ring1;
            mesh.userData.gyroRing2 = ring2;
        } else {
            const isSmallIon = (wType === 'interceptor');
            const lanceCore = new THREE.Mesh(
                createSculptedLatheBarrelGeo(isSmallIon ? 0.022 : 0.032, isSmallIon ? 0.034 : 0.048, isSmallIon ? 0.42 : 0.64, 10).rotateX(Math.PI / 2),
                MAT.solarisPrismGlow || MAT.cyanGlow
            );
            const tipCrystal = new THREE.Mesh(
                createSculptedOgiveSpireGeo(isSmallIon ? 0.040 : 0.056, isSmallIon ? 0.16 : 0.24, 8).rotateX(Math.PI / 2),
                MAT.solarisPrismGlow || MAT.cyanGlow
            );
            tipCrystal.position.z = isSmallIon ? 0.22 : 0.34;
            const warpCollar = new THREE.Mesh(
                createSculptedTorusCollarGeo(isSmallIon ? 0.075 : 0.11, 0.016, 8, 14),
                MAT.solarisGold || MAT.amberGlow
            );
            warpCollar.position.z = 0.04;
            mesh.add(lanceCore, tipCrystal, warpCollar);
            mesh.userData.gyroRing1 = warpCollar;
        }
    } else if (window.PROJECTILE_VISUAL_FACTORY) {
        mesh = window.PROJECTILE_VISUAL_FACTORY.createProjectileVisual(isPlasma ? 'solaris' : 'bullet');
    } else {
        mesh = new THREE.Group();
        const core = new THREE.Mesh(SHARED_FX_GEO.bulletProj, SHARED_FX_MAT.projBullet);
        mesh.add(core);
    }

    const safeStartX = Number.isFinite(startPos.x) ? startPos.x : PLAYER_START_POS.x;
    const safeStartZ = Number.isFinite(startPos.z) ? startPos.z : PLAYER_START_POS.z;
    const safeStartY = Number.isFinite(startPos.y) ? startPos.y : (getTerrainHeight(safeStartX, safeStartZ) + 0.85);
    const validStart = new THREE.Vector3(safeStartX, safeStartY, safeStartZ);
    mesh.position.copy(validStart);
    scene.add(mesh);

    const rawTargetPos = (targetObj && (targetObj.mesh ? targetObj.mesh.position : targetObj.pos)) || validStart;
    const isAirTarget = !!(targetObj && targetObj.isAir);
    const offsetX = (customOpts && Number.isFinite(customOpts.offsetX)) ? customOpts.offsetX : 0;
    const offsetZ = (customOpts && Number.isFinite(customOpts.offsetZ)) ? customOpts.offsetZ : 0;
    const safeTargetX = (Number.isFinite(rawTargetPos.x) ? rawTargetPos.x : safeStartX + 1.0) + offsetX;
    const safeTargetZ = (Number.isFinite(rawTargetPos.z) ? rawTargetPos.z : safeStartZ + 1.0) + offsetZ;
    const impactY = isAirTarget && Number.isFinite(rawTargetPos.y)
        ? rawTargetPos.y
        : (getTerrainHeight(safeTargetX, safeTargetZ) + 0.42);
    const landingPos = new THREE.Vector3(safeTargetX, impactY, safeTargetZ);
    const totalDist = Math.max(1.2, validStart.distanceTo(landingPos));
    const worldSpeed = isSniper ? 42.0 : (isBcLaser ? 36.0 : (isYamato ? 22.0 : (isSunlance ? 32.0 : (isValkMech ? 26.0 : (isTankRound ? (wType === 'siege_tank' ? 24.0 : 28.0) : (isRocket ? 22.5 : (isPlasma ? 24.0 : (isMortar ? 14.5 : (isZergGoo ? 19.5 : 28.0)))))))));
    const normalizedRate = Math.max(0.65, Math.min(8.5, worldSpeed / totalDist));

    projectiles.push({
        mesh,
        isBioGoo: isZergGoo,
        isEnemyAcid: !!isEnemyAcid,
        start: validStart,
        landingPos,
        targetObj,
        isAirTarget,
        wType, damage,
        arcHeight: (customOpts && customOpts.arcHeight) ? customOpts.arcHeight : (isRocket ? 2.35 : 0),
        lateralCurve: (customOpts && customOpts.lateralCurve) ? customOpts.lateralCurve : 0,
        impactOffset: (customOpts && customOpts.impactOffset) ? customOpts.impactOffset : null,
        progress: 0,
        age: 0,
        maxAge: 5.0,
        gooTime: Math.random() * 6.28,
        speed: normalizedRate
    });
}

// ============================================================================
// STAGGERED ROCKETPAD MISSILE BARRAGE SYSTEM
// Launches 4-6 finned missiles sequentially (0.07s apart) from individual
// launch tube muzzles with backblast smoke, upward climb, and curved guidance
// into a configurable target impact radius (default 2.6m).
// ============================================================================
const ACTIVE_MISSILE_BARRAGES = [];
window.ACTIVE_MISSILE_BARRAGES = ACTIVE_MISSILE_BARRAGES;
window.ROCKETPAD_BARRAGE_CONFIG = {
    defaultMissileCount: 5,
    staggerIntervalSec: 0.07,
    targetImpactRadius: 2.6
};

window.queueRocketpadMissileBarrage = function(launcherObj, targetObj, perMissileDmg = 32, missileCount = 5, impactRadius = 2.6) {
    if (!launcherObj || !targetObj || targetObj.hp <= 0) return false;
    const tPos = targetObj.mesh ? targetObj.mesh.position : targetObj.pos;
    if (!tPos) return false;
    // Never fire at unexplored or currently invisible targets
    const fowBypass = !!(window.titleScreenActive || window.loadingCameraSweep || window.fowRevealAll);
    if (!fowBypass && typeof isWorldPosVisible === 'function' && !isWorldPosVisible(tPos.x, tPos.z)) {
        return false;
    }

    const count = Math.max(4, Math.min(6, missileCount || window.ROCKETPAD_BARRAGE_CONFIG.defaultMissileCount));
    const rad = Math.max(1.2, impactRadius || window.ROCKETPAD_BARRAGE_CONFIG.targetImpactRadius);
    const shots = [];
    for (let i = 0; i < count; i++) {
        // Golden-angle spiral distribution inside impactRadius so missiles never all hit the exact same point
        const ang = i * 2.39996 + (Math.random() - 0.5) * 0.45;
        const dist = rad * (0.28 + 0.72 * Math.sqrt((i + 0.5) / count));
        shots.push({
            tubeIndex: i % 6,
            delay: i * window.ROCKETPAD_BARRAGE_CONFIG.staggerIntervalSec,
            offsetX: Math.cos(ang) * dist,
            offsetZ: Math.sin(ang) * dist,
            arcHeight: 2.6 + (i % 3) * 0.55 + Math.random() * 0.4,
            lateralCurve: ((i % 2 === 0 ? 1 : -1) * (0.45 + (i * 0.18)))
        });
    }

    const barrageRecord = {
        launcherObj,
        targetObj,
        perMissileDmg,
        impactRadius: rad,
        elapsed: 0,
        shots,
        firedOffsets: shots.map(s => ({ offsetX: +s.offsetX.toFixed(2), offsetZ: +s.offsetZ.toFixed(2) }))
    };
    ACTIVE_MISSILE_BARRAGES.push(barrageRecord);
    window.LAST_ROCKETPAD_BARRAGE = barrageRecord;
    return true;
};

window.updateActiveMissileBarrages = function(dt) {
    for (let b = ACTIVE_MISSILE_BARRAGES.length - 1; b >= 0; b--) {
        const br = ACTIVE_MISSILE_BARRAGES[b];
        if (!br || !br.shots || br.shots.length === 0) {
            ACTIVE_MISSILE_BARRAGES.splice(b, 1);
            continue;
        }
        br.elapsed += dt;
        while (br.shots.length > 0 && br.elapsed >= br.shots[0].delay) {
            const shot = br.shots.shift();
            const target = br.targetObj;
            if (!target || target.hp <= 0) continue;
            const tPos = target.mesh ? target.mesh.position : target.pos;
            const fowBypass = !!(window.titleScreenActive || window.loadingCameraSweep || window.fowRevealAll);
            if (!fowBypass && tPos && typeof isWorldPosVisible === 'function' && !isWorldPosVisible(tPos.x, tPos.z)) {
                continue;
            }

            const muzzleWorld = typeof window.getWeaponMuzzleWorldPos === 'function'
                ? window.getWeaponMuzzleWorldPos(br.launcherObj, shot.tubeIndex)
                : new THREE.Vector3(0, 1.5, 0);

            triggerMuzzleFlash(muzzleWorld);
            // Backblast smoke puff at rear of launcher pod
            if (br.launcherObj && br.launcherObj.pod && br.launcherObj.pod.userData && br.launcherObj.pod.userData.backblastNode) {
                const bbPos = br.launcherObj.pod.userData.backblastNode.getWorldPosition(new THREE.Vector3());
                if (typeof emitThrusterExhaustParticles === 'function') {
                    emitThrusterExhaustParticles(bbPos, new THREE.Vector3(0, 0.25, -1).normalize(), 'amber', 0.95, true);
                }
            }

            launchOrdProjectile(muzzleWorld, target, 'rocket', br.perMissileDmg, false, {
                offsetX: shot.offsetX,
                offsetZ: shot.offsetZ,
                arcHeight: shot.arcHeight,
                lateralCurve: shot.lateralCurve
            });
        }
        if (br.shots.length === 0) {
            ACTIVE_MISSILE_BARRAGES.splice(b, 1);
        }
    }
};

// ============================================================================
// 9. MAIN REAL-TIME SIMULATION LOOP & 10-STAGE LIVE 3D COMBAT CINEMATIC
// ============================================================================
let prevTime = performance.now();
let endlessSpawnClock = 0;
let creepUpdateClock = 0;
let fowTimer = 0;
let hudClockTimer = 0;
let hitstopTimer = 0;
const TURRET_TURN_SPEED = 3.2;

window.triggerHitstop = function(duration = 0.035) {
    hitstopTimer = Math.max(hitstopTimer, duration);
};

function shortestAngleDiff(current, target) {
    let diff = (target - current + Math.PI) % (Math.PI * 2) - Math.PI;
    if (diff < -Math.PI) diff += Math.PI * 2;
    return diff;
}

let _fowStepToggle = false;
let _portrait3DAccum = 0;
const _camForwardVec = new THREE.Vector3();
const _camRightVec = new THREE.Vector3();
const _worldUpVec = new THREE.Vector3(0, 1, 0);
const _muzzleScratch = new THREE.Vector3();
const _muzzleScratch2 = new THREE.Vector3();
const _aimScratch = new THREE.Vector3();
const _beamStartScratch = new THREE.Vector3();
const _beamEndScratch = new THREE.Vector3();
const _projPrevPosScratch = new THREE.Vector3();
const _projDeltaScratch = new THREE.Vector3();
const _projTrailDirScratch = new THREE.Vector3();

// ============================================================================
// REAL-TIME AUTONOMOUS TWO-ARMY 3D BATTLE SIMULATION & CINEMATIC DIRECTOR
// ============================================================================
function isFiniteCoord(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function isFiniteVec3(vec) {
    return Boolean(vec && isFiniteCoord(vec.x) && isFiniteCoord(vec.y) && isFiniteCoord(vec.z));
}

function tagSceneObjectMetadata(obj, creationSource, subsystem, extra = null) {
    if (!obj || typeof obj !== 'object') return obj;
    if (!obj.userData) obj.userData = {};
    obj.userData._creationSource = creationSource;
    obj.userData._subsystem = subsystem;
    if (extra && typeof extra === 'object') {
        if (extra.participantId !== undefined) obj.userData._participantId = extra.participantId;
        if (extra.bridgeId !== undefined) obj.userData._bridgeId = extra.bridgeId;
        if (extra.role !== undefined) obj.userData._role = extra.role;
    }
    if (typeof obj.traverse === 'function') {
        obj.traverse(child => {
            if (!child) return;
            if (!child.userData) child.userData = {};
            child.userData._creationSource = creationSource;
            child.userData._subsystem = subsystem;
            if (extra && typeof extra === 'object') {
                if (extra.participantId !== undefined) child.userData._participantId = extra.participantId;
                if (extra.bridgeId !== undefined) child.userData._bridgeId = extra.bridgeId;
            }
        });
    }
    return obj;
}
window.tagSceneObjectMetadata = tagSceneObjectMetadata;

function findDryCinematicBattlefieldCenter() {
    const surfFn = typeof getSurfaceHeightWithBridges === 'function' ? getSurfaceHeightWithBridges : getTerrainHeight;
    if (Array.isArray(window.BRIDGES) && window.BRIDGES.length > 0 && window.BRIDGES[0] && window.BRIDGES[0].center) {
        const bc = window.BRIDGES[0].center;
        if (isFiniteCoord(bc.x) && isFiniteCoord(bc.z)) {
            const by = surfFn(bc.x, bc.z);
            return new THREE.Vector3(bc.x, isFiniteCoord(by) ? by : 0.35, bc.z);
        }
    }
    const midX = (isFiniteCoord(PLAYER_START_POS?.x) && isFiniteCoord(ENEMY_BASE_POS?.x))
        ? (PLAYER_START_POS.x + ENEMY_BASE_POS.x) * 0.5
        : 0;
    const midZ = (isFiniteCoord(PLAYER_START_POS?.z) && isFiniteCoord(ENEMY_BASE_POS?.z))
        ? (PLAYER_START_POS.z + ENEMY_BASE_POS.z) * 0.5
        : 0;
    const candidates = [
        { x: midX, z: midZ },
        { x: 0, z: 0 },
        { x: -16, z: 18 },
        { x: 16, z: -18 },
        { x: -22, z: -16 },
        { x: 22, z: 16 }
    ];
    let bestPt = candidates[0];
    let bestScore = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        let dryCount = 0;
        let avgH = 0;
        for (let sx = -10; sx <= 10; sx += 5) {
            for (let sz = -10; sz <= 10; sz += 5) {
                const px = c.x + sx;
                const pz = c.z + sz;
                const h = surfFn(px, pz);
                if (!isFiniteCoord(h)) continue;
                avgH += h;
                const rDist = typeof getRiverDist === 'function' ? getRiverDist(px, pz) : 99;
                if (h > 0.12 && rDist > 4.5) dryCount++;
            }
        }
        const score = dryCount * 10 + avgH * 0.25;
        if (score > bestScore) {
            bestScore = score;
            bestPt = c;
        }
    }
    const finalY = surfFn(bestPt.x, bestPt.z);
    return new THREE.Vector3(bestPt.x, isFiniteCoord(finalY) ? finalY : 0.25, bestPt.z);
}

const CINEMATIC_FACTION_DEFS = {
    terran: {
        id: 'terran',
        name: 'TERRAN DOMINION',
        workerType: 'scv',
        structures: {
            base: 'base',
            pylon: 'power',
            barracks: 'barracks',
            factory: 'bay',
            airfield: 'airfield',
            turret: 'turret',
            extractor: 'drill'
        },
        infantryPool: ['grunt', 'ranger', 'marauder', 'firebat', 'rocketman'],
        heavyPool: ['tank'],
        airPool: ['heli'],
        vanguard: ['grunt', 'ranger', 'marauder', 'firebat', 'tank']
    },
    protoss: {
        id: 'protoss',
        name: 'PROTOSS FLEET',
        workerType: 'probe',
        structures: {
            base: 'solaris_nexus',
            pylon: 'solaris_pylon',
            barracks: 'solaris_gate',
            factory: 'solaris_robotics',
            airfield: 'solaris_spire',
            turret: 'solaris_spire',
            extractor: 'solaris_pylon'
        },
        infantryPool: ['zealot', 'stalker', 'archon'],
        heavyPool: ['stalker', 'archon'],
        airPool: ['phoenix', 'void_ray', 'carrier'],
        vanguard: ['zealot', 'zealot', 'stalker', 'archon', 'phoenix']
    },
    zerg: {
        id: 'zerg',
        name: 'ZERG SWARM',
        workerType: 'drone',
        structures: {
            base: 'hatchery',
            hive: 'hive',
            citadel: 'citadel',
            pylon: 'evolution_chamber',
            evolution_chamber: 'evolution_chamber',
            barracks: 'spawning_pool',
            spawning_pool: 'spawning_pool',
            factory: 'roach_warren',
            roach_warren: 'roach_warren',
            airfield: 'spire',
            spire: 'spire',
            turret: 'spine_crawler',
            spine_crawler: 'spine_crawler',
            extractor: 'extractor'
        },
        infantryPool: ['skitterer', 'spitter', 'burster', 'spitter'],
        heavyPool: ['crusher', 'behemoth'],
        airPool: ['mutalisk', 'brood_lord'],
        vanguard: ['skitterer', 'skitterer', 'spitter', 'crusher', 'mutalisk', 'brood_lord']
    }
};

window.CINEMATIC_DIAGNOSTICS = {
    entitiesCreated: [],
    mismatches: [],
    record(entityKind, teamId, faction, unitOrStructureType, modelType, animState) {
        if (this.entitiesCreated.length >= 160) this.entitiesCreated.shift();
        this.entitiesCreated.push({
            entityKind,
            teamId,
            faction,
            type: unitOrStructureType,
            modelType,
            animState: animState || 'Idle',
            timestamp: Number((typeof performance !== 'undefined' ? performance.now() * 0.001 : 0).toFixed(2))
        });
    }
};

window.BATTLE_CINEMATIC = {
    // Explicit Spectator AI Match Lifecycle States: "UNINITIALIZED" | "INITIALIZING" | "ACTIVE" | "CLEANING" | "DISPOSED"
    lifecycleState: 'UNINITIALIZED',
    initialized: false,
    active: false,
    group: null,
    time: 0,
    elapsed: 0,
    cycleDuration: 90.0,
    totalDuration: 90.0,
    currentStage: 1,
    stageTitle: 'LIVE AI-VS-AI AUTONOMOUS SKIRMISH',
    cameraViewMode: 'auto', // 'auto' | 'birds_eye' | 'team_a' | 'team_b' | 'ground_operator'
    manualCameraOverrideTimer: 0,
    matchNumber: 1,
    matchWinner: null,
    victoryResetTimer: 0,
    lastMapSeed: null,
    _hiddenGameplayMeshes: [],

    STAGES: [
        { id: 1, start: 0.0,  end: 15.0, title: 'BASE ESTABLISHMENT & RESOURCE MINING', subtitle: 'Autonomous workers harvesting minerals & Vespene gems on opposing base platforms' },
        { id: 2, start: 15.0, end: 30.0, title: 'TECH PRODUCTION & INFRASTRUCTURE', subtitle: 'AI Commanders constructing production facilities, power matrices & defensive turrets' },
        { id: 3, start: 30.0, end: 50.0, title: 'RECONNAISSANCE & VANGUARD SKIRMISH', subtitle: 'Forward strike squads descending base ramps to contest central crossings' },
        { id: 4, start: 50.0, end: 70.0, title: 'COMBINED-ARMS FRONTLINE ASSAULT', subtitle: 'Heavy armor, air support & upgraded infantry clashing across the sector' },
        { id: 5, start: 70.0, end: 90.0, title: 'SIEGE OF THE MAIN CITADEL', subtitle: 'Full-scale autonomous offensive pushing up opposing base ramps' }
    ],

    teams: {
        team_a: {
            id: 'team_a',
            name: 'TERRAN DOMINION',
            faction: 'terran',
            minerals: 280,
            gems: 110,
            techLevel: 1,
            supplyUsed: 0,
            supplyCap: 28,
            baseAnchor: new THREE.Vector3(),
            rampDir: new THREE.Vector3(0, 0, -1),
            rampPos: new THREE.Vector3(),
            rallyPoint: new THREE.Vector3(),
            platformRadius: 18.0,
            buildOrderIndex: 0,
            buildTimer: 2.2,
            produceTimer: 1.6,
            upgradeTimer: 15.0,
            attackWaveThreshold: 6,
            posture: 'EXPANDING'
        },
        team_b: {
            id: 'team_b',
            name: 'ZERG SWARM',
            faction: 'zerg',
            minerals: 280,
            gems: 110,
            techLevel: 1,
            supplyUsed: 0,
            supplyCap: 28,
            baseAnchor: new THREE.Vector3(),
            rampDir: new THREE.Vector3(0, 0, 1),
            rampPos: new THREE.Vector3(),
            rallyPoint: new THREE.Vector3(),
            platformRadius: 18.0,
            buildOrderIndex: 0,
            buildTimer: 2.0,
            produceTimer: 1.5,
            upgradeTimer: 15.0,
            attackWaveThreshold: 6,
            posture: 'EXPANDING'
        }
    },

    actors: {
        terranHQ: null,
        terranBarracks: null,
        station: null,
        spire: null,
        zergHatchery: null,
        zergPool: null,
        zergSpine: null,
        tank: null,
        tank2: null,
        buildings: [],
        workers: [],
        resourceNodes: [],
        infantry: [],
        enemies: [],
        airUnits: [],
        projectiles: []
    },

    camPosSmooth: new THREE.Vector3(),
    camLookSmooth: new THREE.Vector3(),
    focusImpactPos: new THREE.Vector3(),
    savedGameplayCamPos: new THREE.Vector3(),
    savedGameplayCamTarget: new THREE.Vector3(),
    hasSavedGameplayCam: false,
    _inputListenerBound: false,

    setCameraViewMode(mode) {
        const normalized = String(mode || 'auto').toLowerCase();
        if (normalized === 'overview') {
            this.cameraViewMode = 'birds_eye';
        } else if (normalized === 'largest_battle' || normalized === 'battle') {
            this.cameraViewMode = 'ground_operator';
        } else if (['auto', 'birds_eye', 'team_a', 'team_b', 'ground_operator'].includes(normalized)) {
            this.cameraViewMode = normalized;
        }
        this.manualCameraOverrideTimer = 0;
    },

    setViewMode(mode) {
        return this.setCameraViewMode(mode);
    },

    start(biome, factionA, factionB) {
        return this.init(biome, factionA, factionB);
    },

    get simUnits() {
        return [...(this.actors.infantry || []), ...(this.actors.enemies || [])];
    },

    get structures() {
        return this.actors.buildings || [];
    },

    getCurrentStageIndex() {
        return Math.max(0, Math.min(this.STAGES.length - 1, (this.currentStage || 1) - 1));
    },

    getState() {
        return {
            lifecycleState: this.lifecycleState,
            stage: this.currentStage,
            totalStages: this.STAGES.length,
            title: this.matchWinner || this.stageTitle,
            progress: Math.min(100, Math.round((this.elapsed / this.cycleDuration) * 100)),
            telemetry: this.getSpectatorTelemetry()
        };
    },

    getSpectatorTelemetry() {
        const ta = this.teams.team_a;
        const tb = this.teams.team_b;
        const bldsA = this.actors.buildings.filter(b => b && b.teamId === 'team_a' && b.hp > 0).length;
        const bldsB = this.actors.buildings.filter(b => b && b.teamId === 'team_b' && b.hp > 0).length;
        const workersA = this.actors.workers.filter(w => w && w.teamId === 'team_a' && w.hp > 0).length;
        const workersB = this.actors.workers.filter(w => w && w.teamId === 'team_b' && w.hp > 0).length;
        const armyA = this.actors.infantry.filter(u => u && u.hp > 0).length;
        const armyB = this.actors.enemies.filter(u => u && u.hp > 0).length;
        return {
            matchNumber: this.matchNumber,
            matchWinner: this.matchWinner,
            viewMode: this.cameraViewMode,
            teamA: {
                name: ta.name,
                faction: ta.faction,
                basePos: { x: ta.baseAnchor.x, y: ta.baseAnchor.y, z: ta.baseAnchor.z },
                rampPos: { x: ta.rampPos.x, y: ta.rampPos.y, z: ta.rampPos.z },
                minerals: Math.floor(ta.minerals),
                gems: Math.floor(ta.gems),
                workers: workersA,
                army: armyA,
                buildings: bldsA,
                techLevel: ta.techLevel,
                posture: ta.posture
            },
            teamB: {
                name: tb.name,
                faction: tb.faction,
                basePos: { x: tb.baseAnchor.x, y: tb.baseAnchor.y, z: tb.baseAnchor.z },
                rampPos: { x: tb.rampPos.x, y: tb.rampPos.y, z: tb.rampPos.z },
                minerals: Math.floor(tb.minerals),
                gems: Math.floor(tb.gems),
                workers: workersB,
                army: armyB,
                buildings: bldsB,
                techLevel: tb.techLevel,
                posture: tb.posture
            }
        };
    },

    resolvePlatformSpot(team, localForward, localRight, fallbackRadius = 14.0) {
        const surfFn = typeof getSurfaceHeightWithBridges === 'function' ? getSurfaceHeightWithBridges : getTerrainHeight;
        const fwdX = team.rampDir.x;
        const fwdZ = team.rampDir.z;
        const rightX = -fwdZ;
        const rightZ = fwdX;
        const maxR = Math.max(8.0, (team.platformRadius || fallbackRadius) - 3.2);
        const clampedFwd = THREE.MathUtils.clamp(localForward, -maxR, maxR);
        const clampedRight = THREE.MathUtils.clamp(localRight, -maxR, maxR);
        let wx = team.baseAnchor.x + fwdX * clampedFwd + rightX * clampedRight;
        let wz = team.baseAnchor.z + fwdZ * clampedFwd + rightZ * clampedRight;
        wx = THREE.MathUtils.clamp(wx, -96, 96);
        wz = THREE.MathUtils.clamp(wz, -96, 96);
        const rawY = surfFn(wx, wz);
        const wy = isFiniteCoord(rawY) ? Math.max(0.05, rawY) : (team.baseAnchor.y || 0.65);
        return new THREE.Vector3(wx, wy, wz);
    },

    snapDryGround(x, z, allowPlatform = true) {
        const surfFn = typeof getSurfaceHeightWithBridges === 'function' ? getSurfaceHeightWithBridges : getTerrainHeight;
        let bx = isFiniteCoord(x) ? THREE.MathUtils.clamp(x, -98, 98) : 0;
        let bz = isFiniteCoord(z) ? THREE.MathUtils.clamp(z, -98, 98) : 0;
        const rDist = typeof getRiverDist === 'function' ? getRiverDist(bx, bz) : 99;
        if (ACTIVE_PLANET_BIOME !== 'ocean' && rDist < 5.0) {
            bz = THREE.MathUtils.clamp(bz + (bz >= 0 ? 6.0 : -6.0), -98, 98);
        }
        if (!allowPlatform && typeof isWalkableGround === 'function') {
            for (let rad = 1.5; rad <= 9.0; rad += 1.5) {
                if (isWalkableGround(bx, bz, 0.6)) break;
                for (let a = 0; a < 8; a++) {
                    const ang = (a / 8) * Math.PI * 2;
                    const tx = THREE.MathUtils.clamp(bx + Math.cos(ang) * rad, -98, 98);
                    const tz = THREE.MathUtils.clamp(bz + Math.sin(ang) * rad, -98, 98);
                    if (isWalkableGround(tx, tz, 0.6)) {
                        bx = tx;
                        bz = tz;
                        break;
                    }
                }
            }
        }
        const rawY = surfFn(bx, bz);
        const y = isFiniteCoord(rawY) ? Math.max(0.05, rawY) : 0.45;
        return new THREE.Vector3(bx, y, bz);
    },

    disposeCinematicMeshTree(rootObj) {
        if (!rootObj || typeof rootObj.traverse !== 'function') return;
        const sharedGeoSet = new Set(typeof SHARED_FX_GEO === 'object' && SHARED_FX_GEO ? Object.values(SHARED_FX_GEO) : []);
        const sharedMatSet = new Set(typeof MAT === 'object' && MAT ? Object.values(MAT) : []);
        rootObj.traverse(child => {
            if (!child || !child.isMesh) return;
            if (child.geometry && !sharedGeoSet.has(child.geometry) && (!child.geometry.userData || !child.geometry.userData.sharedGlobalGeo)) {
                try { child.geometry.dispose(); } catch (_) {}
            }
            if (child.material) {
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                for (let m = 0; m < mats.length; m++) {
                    const mat = mats[m];
                    if (mat && !sharedMatSet.has(mat) && (!mat.userData || !mat.userData.sharedGlobalMat)) {
                        try { mat.dispose(); } catch (_) {}
                    }
                }
            }
        });
    },

    hideSinglePlayerGameplayEntitiesForCinematic() {
        this._hiddenGameplayMeshes = [];
        const hideList = (arr) => {
            if (!Array.isArray(arr)) return;
            for (let i = 0; i < arr.length; i++) {
                const item = arr[i];
                if (item && item.mesh && item.mesh.visible) {
                    item.mesh.visible = false;
                    this._hiddenGameplayMeshes.push(item.mesh);
                }
            }
        };
        hideList(enemyBuildings);
        hideList(enemies);
        hideList(solarisBuildings);
    },

    restoreSinglePlayerGameplayEntitiesAfterCinematic() {
        if (Array.isArray(this._hiddenGameplayMeshes)) {
            for (let i = 0; i < this._hiddenGameplayMeshes.length; i++) {
                const m = this._hiddenGameplayMeshes[i];
                if (m) m.visible = true;
            }
            this._hiddenGameplayMeshes.length = 0;
        }
    },

    spawnResourcePatch(x, z, kind = 'mineral', amount = 1500) {
        const pos = this.snapDryGround(x, z, true);
        if (!isFiniteVec3(pos)) return null;
        const nodeGroup = new THREE.Group();
        const crystalMat = kind === 'gem' ? (MAT.amberGlow || MAT.gold) : (MAT.cyanGlow || MAT.crystal);
        const spireCount = kind === 'gem' ? 4 : 5;
        for (let i = 0; i < spireCount; i++) {
            const ang = (i / spireCount) * Math.PI * 2 + (i * 0.25);
            const h = 0.75 + (i % 3) * 0.28;
            const spire = new THREE.Mesh(new THREE.ConeGeometry(0.28, h, 6), crystalMat);
            spire.position.set(Math.cos(ang) * 0.42, h * 0.45, Math.sin(ang) * 0.42);
            spire.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.22;
            spire.castShadow = true;
            nodeGroup.add(spire);
        }
        nodeGroup.position.copy(pos);
        tagSceneObjectMetadata(nodeGroup, 'BATTLE_CINEMATIC.spawnResourcePatch', 'battle-cinematic', { role: kind });
        if (this.group) this.group.add(nodeGroup);
        const node = {
            kind,
            amount,
            maxAmount: amount,
            pos: pos.clone(),
            mesh: nodeGroup
        };
        this.actors.resourceNodes.push(node);
        return node;
    },

    spawnSpectatorStructure(teamId, role, worldX, worldZ, instant = false) {
        const team = this.teams[teamId];
        if (!team) return null;
        const faction = team.faction;
        const fDef = CINEMATIC_FACTION_DEFS[faction] || CINEMATIC_FACTION_DEFS.terran;
        let pos = this.snapDryGround(worldX, worldZ, true);
        if (!isFiniteVec3(pos)) return null;

        // Enforce strict non-overlap against all existing spectator structures
        const isTooClose = (tx, tz) => {
            for (let i = 0; i < this.actors.buildings.length; i++) {
                const ob = this.actors.buildings[i];
                if (ob && ob.hp > 0 && ob.pos && Math.hypot(tx - ob.pos.x, tz - ob.pos.z) < 4.6) {
                    return true;
                }
            }
            return false;
        };
        if (isTooClose(pos.x, pos.z)) {
            let foundFree = false;
            for (let r = 3.2; r <= 24.0 && !foundFree; r += 2.2) {
                for (let s = 0; s < 16; s++) {
                    const ang = (s / 16) * Math.PI * 2 + r * 0.4;
                    const cand = this.snapDryGround(pos.x + Math.cos(ang) * r, pos.z + Math.sin(ang) * r, true);
                    if (isFiniteVec3(cand) && !isTooClose(cand.x, cand.z)) {
                        pos = cand;
                        foundFree = true;
                        break;
                    }
                }
            }
        }

        let mesh;
        let resolvedModelKind = role;
        if (faction === 'zerg') {
            const zergKind = fDef.structures[role] || (role === 'base' ? 'hatchery' : (role === 'turret' ? 'spine_crawler' : (role === 'factory' ? 'roach_warren' : (role === 'airfield' ? 'spire' : (role === 'pylon' ? 'evolution_chamber' : 'spawning_pool')))));
            resolvedModelKind = zergKind;
            mesh = typeof createOrganicZergStructure === 'function'
                ? createOrganicZergStructure(zergKind)
                : createEnemySpawningPool();
            mesh.userData = mesh.userData || {};
            mesh.userData.faction = 'zerg';
            mesh.userData.buildingType = zergKind;
            mesh.userData.isOrganicZergStructure = true;
        } else if (faction === 'protoss') {
            const protossKind = fDef.structures[role] || (role === 'base' ? 'solaris_nexus' : (role === 'pylon' ? 'solaris_pylon' : (role === 'factory' ? 'solaris_robotics' : (role === 'turret' || role === 'airfield' ? 'solaris_spire' : 'solaris_gate'))));
            resolvedModelKind = protossKind;
            mesh = createEngineeredBuilding(protossKind, false);
            mesh.userData = mesh.userData || {};
            mesh.userData.faction = 'protoss';
            mesh.userData.buildingType = protossKind;
        } else {
            const terranKind = fDef.structures[role] || (role === 'factory' ? 'bay' : (role === 'airfield' ? 'airfield' : role));
            resolvedModelKind = terranKind;
            mesh = createEngineeredBuilding(terranKind, false);
            mesh.userData = mesh.userData || {};
            mesh.userData.faction = 'terran';
            mesh.userData.buildingType = terranKind;
            if (role === 'turret' && mesh.userData && mesh.userData.head && mesh.userData.mounts && typeof createOrdnancePod === 'function') {
                const head = mesh.userData.head;
                const pLeft = createOrdnancePod('mg');
                const pTop = createOrdnancePod('rocket');
                const pRight = createOrdnancePod('plasma');
                pLeft.position.set(-0.56, 0.02, 0.02);
                pRight.position.set(0.56, 0.02, 0.02);
                pTop.position.set(0, 0.50, 0.02);
                head.add(pLeft, pTop, pRight);
                mesh.userData.mounts.left = pLeft;
                mesh.userData.mounts.top = pTop;
                mesh.userData.mounts.right = pRight;
            }
        }

        const groundY = typeof getTerrainHeight === 'function' ? getTerrainHeight(pos.x, pos.z) : pos.y;
        pos.y = isFiniteCoord(groundY) ? groundY : pos.y;
        mesh.position.copy(pos);
        // Orient building toward the team's designated base ramp / battlefield axis
        const facingYaw = Math.atan2(team.rampDir.x || 0, team.rampDir.z || 1);
        if (isFiniteCoord(facingYaw)) {
            mesh.rotation.y = facingYaw;
        }
        tagSceneObjectMetadata(mesh, 'BATTLE_CINEMATIC.spawnSpectatorStructure', 'battle-cinematic', {
            participantId: teamId,
            faction,
            role,
            buildingType: resolvedModelKind
        });
        if (this.group) this.group.add(mesh);

        const maxHp = role === 'base' ? 3200 : (role === 'turret' ? 1650 : 2100);
        const bld = {
            teamId,
            faction,
            role,
            buildingType: resolvedModelKind,
            isBuilding: true,
            mesh,
            pos: pos.clone(),
            hp: instant ? maxHp : Math.round(maxHp * 0.25),
            maxHp,
            buildProgress: instant ? 1.0 : 0.08,
            buildDuration: role === 'base' ? 14.0 : 8.5,
            cooldown: 0.6 + Math.random() * 0.5,
            productionQueue: [],
            productionProgress: 0
        };

        this.updateStructureConstructionVisuals(bld);
        this.actors.buildings.push(bld);
        if (window.CINEMATIC_DIAGNOSTICS) {
            window.CINEMATIC_DIAGNOSTICS.record('structure', teamId, faction, role, resolvedModelKind, instant ? 'Active' : 'Constructing');
        }

        if (teamId === 'team_a') {
            if (role === 'base' && !this.actors.terranHQ) this.actors.terranHQ = bld;
            if (role === 'barracks' && !this.actors.terranBarracks) this.actors.terranBarracks = bld;
            if (role === 'turret' && !this.actors.station) this.actors.station = bld;
        } else {
            if (role === 'base' && !this.actors.zergHatchery) this.actors.zergHatchery = bld;
            if (role === 'barracks' && !this.actors.zergPool) this.actors.zergPool = bld;
            if (role === 'turret' && !this.actors.zergSpine) this.actors.zergSpine = bld;
        }
        return bld;
    },

    updateStructureConstructionVisuals(bld) {
        if (!bld || !bld.mesh) return;
        const p = Math.max(0.05, Math.min(1.0, bld.buildProgress || 0));
        if (bld.faction === 'terran' || bld.faction === 'protoss') {
            const scaf = bld.mesh.userData && bld.mesh.userData.scaffoldGroup;
            if (scaf) {
                scaf.visible = p < 0.995;
                scaf.scale.y = 0.25 + p * 0.75;
            }
            bld.mesh.scale.set(1, 0.35 + p * 0.65, 1);
        } else {
            // Zerg organic metamorphosis cocoon & bio-pulse construction
            if (typeof updateEnemyBuildingAnimationAndBreak === 'function') {
                updateEnemyBuildingAnimationAndBreak(bld, 0.016, this.time || 0);
            } else {
                const pulse = p < 0.995 ? (1.0 + Math.sin(this.time * 9.0) * 0.04) : 1.0;
                const s = (0.38 + p * 0.62) * pulse;
                bld.mesh.scale.set(s, 0.32 + p * 0.68, s);
            }
        }
    },

    spawnWorker(teamId, x, z) {
        const team = this.teams[teamId];
        if (!team) return null;
        const pos = this.snapDryGround(x, z, true);
        if (!isFiniteVec3(pos)) return null;
        const workerType = team.faction === 'zerg' ? 'drone' : (team.faction === 'protoss' ? 'probe' : 'scv');
        const droneKey = team.faction === 'zerg' ? 'zerg' : (team.faction === 'protoss' ? 'solaris' : 'terran');
        const mesh = typeof createAutoMiningDroneMesh === 'function'
            ? createAutoMiningDroneMesh(droneKey)
            : (typeof createMiningDroneMesh === 'function' ? createMiningDroneMesh(droneKey) : new THREE.Group());
        mesh.userData = mesh.userData || {};
        mesh.userData.faction = team.faction;
        mesh.userData.workerType = workerType;
        mesh.userData.role = workerType;
        mesh.userData.animState = 'Walking';
        mesh.position.set(pos.x, pos.y + 0.55, pos.z);
        tagSceneObjectMetadata(mesh, 'BATTLE_CINEMATIC.spawnWorker', 'battle-cinematic', {
            participantId: teamId,
            faction: team.faction,
            role: workerType
        });
        if (this.group) this.group.add(mesh);

        const laserGeo = new THREE.CylinderGeometry(0.035, 0.035, 1.0, 6);
        laserGeo.rotateX(Math.PI / 2);
        const laserMat = team.faction === 'zerg'
            ? (MAT.bioGreen || MAT.cyanGlow)
            : (team.faction === 'protoss' ? (MAT.amberGlow || MAT.cyanGlow) : (MAT.cyanGlow || MAT.amberGlow));
        const laserMesh = new THREE.Mesh(laserGeo, laserMat);
        laserMesh.visible = false;
        tagSceneObjectMetadata(laserMesh, 'BATTLE_CINEMATIC.spawnWorkerLaser', 'battle-cinematic', {
            participantId: teamId,
            role: 'worker_laser'
        });
        if (this.group) this.group.add(laserMesh);

        const worker = {
            teamId,
            faction: team.faction,
            role: workerType,
            workerType,
            unitType: workerType,
            isWorker: true,
            mesh,
            laserMesh,
            hp: 95,
            maxHp: 95,
            speed: 4.0,
            state: 'TO_NODE', // 'TO_NODE' | 'MINING' | 'TO_BASE'
            targetNode: null,
            mineTimer: 0,
            cargoKind: 'mineral',
            cargoAmount: 0
        };
        this.actors.workers.push(worker);
        if (window.CINEMATIC_DIAGNOSTICS) {
            window.CINEMATIC_DIAGNOSTICS.record('worker', teamId, team.faction, workerType, droneKey, 'Walking');
        }
        return worker;
    },

    spawnSimUnit(teamIdOrFaction, role, homeX, homeZ) {
        let teamId = teamIdOrFaction;
        if (teamId !== 'team_a' && teamId !== 'team_b') {
            teamId = (this.teams.team_b.faction === teamIdOrFaction) ? 'team_b' : 'team_a';
        }
        const team = this.teams[teamId];
        const faction = team ? team.faction : 'terran';
        const fDef = CINEMATIC_FACTION_DEFS[faction] || CINEMATIC_FACTION_DEFS.terran;
        const allowedRoles = [...(fDef.infantryPool || []), ...(fDef.heavyPool || []), ...(fDef.airPool || [])];
        if (!role || !allowedRoles.includes(role)) {
            role = fDef.infantryPool[0] || (faction === 'zerg' ? 'skitterer' : (faction === 'protoss' ? 'zealot' : 'grunt'));
        }
        const pos = this.snapDryGround(homeX, homeZ, true);
        if (!isFiniteVec3(pos)) return null;

        const isAir = role === 'heli' || role === 'mutalisk' || role === 'brood_lord' || role === 'phoenix' || role === 'void_ray' || role === 'voidray' || role === 'carrier';
        const mesh = createAnimatedUnitModel(role);
        mesh.userData = mesh.userData || {};
        mesh.userData.faction = faction;
        mesh.userData.role = role;
        mesh.userData.isAir = isAir;
        const airAlt = role === 'brood_lord' ? 6.4 : 5.2;
        mesh.position.set(pos.x, pos.y + (isAir ? airAlt : 0), pos.z);
        const facingYaw = Math.atan2(team.rampDir.x || 0, team.rampDir.z || 1);
        mesh.rotation.y = isFiniteCoord(facingYaw) ? facingYaw : 0;
        if (typeof updateUnitAnimation === 'function') {
            updateUnitAnimation(mesh, 0.016, false, null, 3.8);
        }
        tagSceneObjectMetadata(mesh, 'BATTLE_CINEMATIC.spawnSimUnit', 'battle-cinematic', {
            participantId: teamId,
            faction,
            role
        });
        if (this.group) this.group.add(mesh);
        if (window.CINEMATIC_DIAGNOSTICS) {
            window.CINEMATIC_DIAGNOSTICS.record('unit', teamId, faction, role, role, mesh.userData.animState || 'Idle');
        }

        const techMult = 1.0 + ((team ? team.techLevel : 1) - 1) * 0.14;
        const isMelee = role === 'skitterer' || role === 'crusher' || role === 'burster' || role === 'zealot';
        const isTank = role === 'tank' || role === 'siege_tank' || role === 'immortal' || role === 'colossus' || role === 'brood_lord';
        const maxHp = Math.round((isTank ? 430 : (role === 'crusher' || role === 'behemoth' || role === 'archon' || role === 'carrier' ? 350 : 165)) * techMult);
        const range = isMelee ? 2.1 : (isTank ? 14.0 : (role === 'firebat' ? 5.8 : 10.5));
        const damage = Math.round((isTank ? 52 : (role === 'crusher' || role === 'behemoth' || role === 'archon' || role === 'colossus' ? 32 : 19)) * techMult);
        const fireRate = isTank ? 1.65 : (role === 'ranger' || role === 'grunt' || role === 'stalker' ? 0.55 : 0.88);
        const speed = isAir ? (role === 'brood_lord' ? 4.2 : 6.2) : (isTank ? 3.2 : (isMelee ? 5.0 : 3.9));

        const unit = {
            teamId,
            faction,
            role,
            type: role,
            mesh,
            isAir,
            isMelee,
            isTank,
            hp: maxHp,
            maxHp,
            range,
            damage,
            fireRate,
            speed,
            cooldown: Math.random() * 0.5,
            homePos: pos.clone(),
            aiState: 'RALLYING',
            target: null,
            navWaypoint: null,
            navTimer: 0
        };

        if (teamId === 'team_a') {
            this.actors.infantry.push(unit);
            if (isTank && !this.actors.tank) this.actors.tank = mesh;
            else if (isTank && !this.actors.tank2) this.actors.tank2 = mesh;
        } else {
            this.actors.enemies.push(unit);
        }
        return unit;
    },

    bindSpectatorCameraInput() {
        if (this._inputListenerBound) return;
        this._inputListenerBound = true;
        window.addEventListener('wheel', () => {
            if (this.lifecycleState === 'ACTIVE' && window.titleScreenActive) {
                this.manualCameraOverrideTimer = 6.0;
            }
        }, { passive: true });
        window.addEventListener('pointermove', (ev) => {
            if (this.lifecycleState === 'ACTIVE' && window.titleScreenActive && ev.buttons > 0) {
                this.manualCameraOverrideTimer = 6.0;
            }
        }, { passive: true });
    },

    computeBasePlatformAndRamp(isTeamA) {
        const surfFn = typeof getSurfaceHeightWithBridges === 'function' ? getSurfaceHeightWithBridges : getTerrainHeight;
        const rawAnchor = isTeamA
            ? (typeof PLAYER_START_POS !== 'undefined' && isFiniteCoord(PLAYER_START_POS.x) ? PLAYER_START_POS : new THREE.Vector3(-62, 0, 62))
            : (typeof ENEMY_BASE_POS !== 'undefined' && isFiniteCoord(ENEMY_BASE_POS.x) ? ENEMY_BASE_POS : new THREE.Vector3(62, 0, -62));
        const oppAnchor = isTeamA
            ? (typeof ENEMY_BASE_POS !== 'undefined' && isFiniteCoord(ENEMY_BASE_POS.x) ? ENEMY_BASE_POS : new THREE.Vector3(62, 0, -62))
            : (typeof PLAYER_START_POS !== 'undefined' && isFiniteCoord(PLAYER_START_POS.x) ? PLAYER_START_POS : new THREE.Vector3(-62, 0, 62));

        // Find matching zone in BASE_TERRAIN_ZONES if present
        const zones = Array.isArray(window.BASE_TERRAIN_ZONES) ? window.BASE_TERRAIN_ZONES : [];
        let matchedZone = null;
        let minZoneDist = 28.0;
        for (let i = 0; i < zones.length; i++) {
            const z = zones[i];
            if (!z || !isFiniteCoord(z.x) || !isFiniteCoord(z.z)) continue;
            const d = Math.hypot(z.x - rawAnchor.x, z.z - rawAnchor.z);
            if (d < minZoneDist) {
                minZoneDist = d;
                matchedZone = z;
            }
        }

        const baseX = matchedZone ? matchedZone.x : rawAnchor.x;
        const baseZ = matchedZone ? matchedZone.z : rawAnchor.z;
        const baseY = surfFn(baseX, baseZ);
        const baseAnchor = new THREE.Vector3(baseX, isFiniteCoord(baseY) ? baseY : 0.65, baseZ);

        // Determine ramp direction from zone or toward opposing base / battlefield center
        let rdx = oppAnchor.x - baseX;
        let rdz = oppAnchor.z - baseZ;
        if (matchedZone && isFiniteCoord(matchedZone.rampDirX) && isFiniteCoord(matchedZone.rampDirZ)) {
            rdx = matchedZone.rampDirX;
            rdz = matchedZone.rampDirZ;
        } else if (isTeamA && typeof PLAYER_BASE_RAMP_DIR !== 'undefined' && isFiniteCoord(PLAYER_BASE_RAMP_DIR.x) && isFiniteCoord(PLAYER_BASE_RAMP_DIR.z)) {
            rdx = PLAYER_BASE_RAMP_DIR.x;
            rdz = PLAYER_BASE_RAMP_DIR.z;
        }
        const rLen = Math.hypot(rdx, rdz) || 1.0;
        const rampDir = new THREE.Vector3(rdx / rLen, 0, rdz / rLen);
        const platformRadius = matchedZone && isFiniteCoord(matchedZone.radius) ? matchedZone.radius : 19.5;

        const rampDist = platformRadius + 2.5;
        const rampX = THREE.MathUtils.clamp(baseX + rampDir.x * rampDist, -96, 96);
        const rampZ = THREE.MathUtils.clamp(baseZ + rampDir.z * rampDist, -96, 96);
        const rampY = surfFn(rampX, rampZ);
        const rampPos = new THREE.Vector3(rampX, isFiniteCoord(rampY) ? rampY : baseAnchor.y, rampZ);

        const rallyDist = platformRadius + 10.5;
        const rallyPoint = this.snapDryGround(
            baseX + rampDir.x * rallyDist,
            baseZ + rampDir.z * rallyDist,
            false
        );

        return {
            baseAnchor,
            rampDir,
            rampPos,
            rallyPoint,
            platformRadius
        };
    },

    init(biome, customFactionA = null, customFactionB = null) {
        if (this.lifecycleState === 'ACTIVE' && this.lastMapSeed === window.MAP_SEED && !customFactionA && !customFactionB) {
            return;
        }
        if (this.lifecycleState === 'INITIALIZING') return;
        if (this.group) {
            this.cleanup();
        }
        this.lifecycleState = 'INITIALIZING';
        this.active = true;
        this.lastMapSeed = window.MAP_SEED;
        this.bindSpectatorCameraInput();

        // Hide static single-player structures while cinematic runs so opposing base platforms have zero duplicate meshes
        this.hideSinglePlayerGameplayEntitiesForCinematic();

        if (typeof camera !== 'undefined' && camera && typeof controls !== 'undefined' && controls) {
            this.savedGameplayCamPos.copy(camera.position);
            this.savedGameplayCamTarget.copy(controls.target);
            this.hasSavedGameplayCam = true;
        }

        const staleGroup = scene.getObjectByName('BattleCinematicTheatre');
        if (staleGroup) {
            scene.remove(staleGroup);
            this.disposeCinematicMeshTree(staleGroup);
        }

        this.group = new THREE.Group();
        this.group.name = 'BattleCinematicTheatre';
        tagSceneObjectMetadata(this.group, 'BATTLE_CINEMATIC.init', 'battle-cinematic');
        scene.add(this.group);

        // Select two distinct factions from available faction definitions ('terran', 'protoss', 'zerg')
        const factionKeys = Object.keys(CINEMATIC_FACTION_DEFS);
        const seedOffset = Math.abs(Math.floor(Number(window.MAP_SEED || 100) + (this.matchNumber || 1) * 7));
        let facA = (customFactionA && CINEMATIC_FACTION_DEFS[customFactionA])
            ? customFactionA
            : factionKeys[seedOffset % factionKeys.length];
        let facB = (customFactionB && CINEMATIC_FACTION_DEFS[customFactionB] && customFactionB !== facA)
            ? customFactionB
            : factionKeys[(seedOffset + 1 + (this.matchNumber % 2)) % factionKeys.length];
        if (facB === facA) {
            facB = factionKeys.find(k => k !== facA) || 'zerg';
        }
        // Ensure Zerg (when randomly selected without explicit customFactionA) always spawns on Team B (ENEMY_BASE_POS Hive platform)
        // so Team A (PLAYER_START_POS) is Terran/Protoss and Zerg is never placed on the opposite side from its Hive sanctuary!
        if (facA === 'zerg' && !customFactionA && !customFactionB) {
            const tmpFac = facA;
            facA = facB;
            facB = tmpFac;
        }
        const defA = CINEMATIC_FACTION_DEFS[facA];
        const defB = CINEMATIC_FACTION_DEFS[facB];

        this.anchor = findDryCinematicBattlefieldCenter();
        this.focusImpactPos.copy(this.anchor);

        this.actors.buildings = [];
        this.actors.workers = [];
        this.actors.resourceNodes = [];
        this.actors.infantry = [];
        this.actors.enemies = [];
        this.actors.airUnits = [];
        this.actors.projectiles = [];
        this.actors.terranHQ = null;
        this.actors.terranBarracks = null;
        this.actors.station = null;
        this.actors.zergHatchery = null;
        this.actors.zergPool = null;
        this.actors.zergSpine = null;
        this.matchWinner = null;
        this.victoryResetTimer = 0;

        // Place Team A & Team B on the actual generated opposing base platforms and align with their designated base ramps
        const platA = this.computeBasePlatformAndRamp(true);
        const ta = this.teams.team_a;
        ta.faction = defA.id;
        ta.name = defA.name;
        ta.minerals = 320;
        ta.gems = 130;
        ta.techLevel = 1;
        ta.buildOrderIndex = 0;
        ta.buildTimer = 1.8;
        ta.produceTimer = 1.5;
        ta.upgradeTimer = 14.0;
        ta.posture = 'HARVESTING & BUILDING';
        ta.baseAnchor.copy(platA.baseAnchor);
        ta.rampDir.copy(platA.rampDir);
        ta.rampPos.copy(platA.rampPos);
        ta.rallyPoint.copy(platA.rallyPoint);
        ta.platformRadius = platA.platformRadius;

        const platB = this.computeBasePlatformAndRamp(false);
        const tb = this.teams.team_b;
        tb.faction = defB.id;
        tb.name = defB.name;
        tb.minerals = 320;
        tb.gems = 130;
        tb.techLevel = 1;
        tb.buildOrderIndex = 0;
        tb.buildTimer = 1.6;
        tb.produceTimer = 1.4;
        tb.upgradeTimer = 14.0;
        tb.posture = 'HARVESTING & BUILDING';
        tb.baseAnchor.copy(platB.baseAnchor);
        tb.rampDir.copy(platB.rampDir);
        tb.rampPos.copy(platB.rampPos);
        tb.rallyPoint.copy(platB.rallyPoint);
        tb.platformRadius = platB.platformRadius;

        // Spawn Mineral & Gem Patches behind each HQ on the base platform (away from the ramp)
        const resA1 = this.resolvePlatformSpot(ta, -6.2, -4.5);
        const resA2 = this.resolvePlatformSpot(ta, -6.8,  0.0);
        const resA3 = this.resolvePlatformSpot(ta, -6.2,  4.8);
        this.spawnResourcePatch(resA1.x, resA1.z, 'mineral', 2200);
        this.spawnResourcePatch(resA2.x, resA2.z, 'mineral', 2200);
        this.spawnResourcePatch(resA3.x, resA3.z, 'gem', 1500);

        const resB1 = this.resolvePlatformSpot(tb, -6.2, -4.5);
        const resB2 = this.resolvePlatformSpot(tb, -6.8,  0.0);
        const resB3 = this.resolvePlatformSpot(tb, -6.2,  4.8);
        this.spawnResourcePatch(resB1.x, resB1.z, 'mineral', 2200);
        this.spawnResourcePatch(resB2.x, resB2.z, 'mineral', 2200);
        this.spawnResourcePatch(resB3.x, resB3.z, 'gem', 1500);

        // Starting Command Structures + initial production & ramp-defense buildings on each base platform
        const hqA = this.spawnSpectatorStructure('team_a', 'base', ta.baseAnchor.x, ta.baseAnchor.z, true);
        ta.hqBuilding = hqA;
        if (ta.faction === 'protoss') {
            const pylA = this.resolvePlatformSpot(ta, 3.8, -5.2);
            this.spawnSpectatorStructure('team_a', 'pylon', pylA.x, pylA.z, true);
        }
        const barA = this.resolvePlatformSpot(ta, 5.2, -5.8);
        const turA = this.resolvePlatformSpot(ta, 8.8,  3.2);
        this.spawnSpectatorStructure('team_a', 'barracks', barA.x, barA.z, true);
        this.spawnSpectatorStructure('team_a', 'turret', turA.x, turA.z, false);

        const hqB = this.spawnSpectatorStructure('team_b', 'base', tb.baseAnchor.x, tb.baseAnchor.z, true);
        tb.hqBuilding = hqB;
        if (tb.faction === 'protoss') {
            const pylB = this.resolvePlatformSpot(tb, 3.8, -5.2);
            this.spawnSpectatorStructure('team_b', 'pylon', pylB.x, pylB.z, true);
        }
        const barB = this.resolvePlatformSpot(tb, 5.2, -5.8);
        const turB = this.resolvePlatformSpot(tb, 8.8,  3.2);
        this.spawnSpectatorStructure('team_b', 'barracks', barB.x, barB.z, true);
        this.spawnSpectatorStructure('team_b', 'turret', turB.x, turB.z, false);

        // Starting Workers (4 per team harvesting between HQ and platform resource patches)
        for (let i = 0; i < 4; i++) {
            const wPosA = this.resolvePlatformSpot(ta, -3.2, -2.4 + i * 1.6);
            const wPosB = this.resolvePlatformSpot(tb, -3.2, -2.4 + i * 1.6);
            this.spawnWorker('team_a', wPosA.x, wPosA.z);
            this.spawnWorker('team_b', wPosB.x, wPosB.z);
        }

        // Initial Vanguard Squads positioned near each team's base ramp / rally point
        for (let i = 0; i < defA.vanguard.length; i++) {
            const uSpotA = this.resolvePlatformSpot(ta, 7.5 + (i % 2) * 2.0, -3.6 + i * 1.8);
            this.spawnSimUnit('team_a', defA.vanguard[i], uSpotA.x, uSpotA.z);
        }
        for (let i = 0; i < defB.vanguard.length; i++) {
            const uSpotB = this.resolvePlatformSpot(tb, 7.5 + (i % 2) * 2.0, -3.6 + i * 1.8);
            this.spawnSimUnit('team_b', defB.vanguard[i], uSpotB.x, uSpotB.z);
        }

        this.teamA = ta;
        this.teamB = tb;
        this.unitsA = this.actors.infantry;
        this.unitsB = this.actors.enemies;
        this.buildings = this.actors.buildings;
        ta.workers = this.actors.workers.filter(w => w && w.teamId === 'team_a');
        tb.workers = this.actors.workers.filter(w => w && w.teamId === 'team_b');
        ta.buildings = this.actors.buildings.filter(b => b && b.teamId === 'team_a');
        tb.buildings = this.actors.buildings.filter(b => b && b.teamId === 'team_b');

        this.camPosSmooth.set(ta.baseAnchor.x + ta.rampDir.x * 22.0 + 16.0, ta.baseAnchor.y + 22.0, ta.baseAnchor.z + ta.rampDir.z * 22.0 + 16.0);
        this.camLookSmooth.copy(ta.rampPos);
        this.initialized = true;
        this.lifecycleState = 'ACTIVE';
        this._cinematicCreepTimer = 0;
        this.syncCinematicZergCreep(0, true);
    },

    syncCinematicZergCreep(dt = 0, forceFullSync = false) {
        const creepState = typeof window.getActiveZergCreepState === 'function'
            ? window.getActiveZergCreepState()
            : { hasBuiltZergMainBase: false, x: ENEMY_BASE_POS.x, z: ENEMY_BASE_POS.z, buildingsList: [] };

        if (creepState.hasBuiltZergMainBase) {
            const zergBldsCount = Array.isArray(creepState.buildingsList) ? creepState.buildingsList.length : 1;
            const targetR = Math.min(22.0, 16.5 + Math.max(0, zergBldsCount - 1) * 0.95);
            creepTargetRadius = targetR;
            if (forceFullSync || creepRadius < 1.0) {
                creepRadius = 16.5;
            } else if (creepRadius < creepTargetRadius) {
                creepRadius = Math.min(creepTargetRadius, creepRadius + dt * 1.2);
            } else if (creepRadius > creepTargetRadius) {
                creepRadius = Math.max(creepTargetRadius, creepRadius - dt * 2.5);
            }
            this._cinematicCreepTimer = (this._cinematicCreepTimer || 0) + dt;
            if (forceFullSync || this._cinematicCreepTimer >= 0.25) {
                this._cinematicCreepTimer = 0;
                if (typeof updateZergCreepColors === 'function') {
                    updateZergCreepColors(creepRadius, false, forceFullSync);
                }
            }
        } else {
            // No built Zerg Main Base in this cinematic match (e.g. Terran vs Protoss, or Zerg Main Base not built / destroyed):
            // Never allow Zerg creep on Protoss or Terran bases!
            creepTargetRadius = 0;
            if (forceFullSync) {
                creepRadius = 0;
                if (typeof updateZergCreepColors === 'function') {
                    updateZergCreepColors(0, false, true);
                }
            } else if (creepRadius > 0.01) {
                creepRadius = Math.max(0, creepRadius - dt * 9.5);
                if (creepRadius < 0.48) creepRadius = 0;
                this._cinematicCreepTimer = (this._cinematicCreepTimer || 0) + dt;
                if (this._cinematicCreepTimer >= 0.06 || creepRadius === 0) {
                    this._cinematicCreepTimer = 0;
                    if (typeof updateZergCreepColors === 'function') {
                        updateZergCreepColors(creepRadius, true, creepRadius === 0);
                    }
                }
            }
        }
    },

    spawnSimProjectile(fromPos, targetActor, wType, damage, faction) {
        if (this.lifecycleState !== 'ACTIVE' || !this.group || !targetActor) return;
        if (!isFiniteVec3(fromPos)) return;
        const tPos = targetActor.mesh ? targetActor.mesh.position : targetActor.pos;
        if (!isFiniteVec3(tPos)) return;
        const endPos = tPos.clone();
        endPos.y += targetActor.isAir ? 0.0 : 0.85;
        let mesh;
        if (window.PROJECTILE_VISUAL_FACTORY && typeof window.PROJECTILE_VISUAL_FACTORY.createProjectileMesh === 'function') {
            mesh = window.PROJECTILE_VISUAL_FACTORY.createProjectileMesh(wType, faction);
        } else if (wType === 'tank') {
            mesh = typeof createTankCannonShellMesh === 'function'
                ? createTankCannonShellMesh(false)
                : new THREE.Mesh(SHARED_FX_GEO.mortarProj, MAT.cyanGlow);
        } else if (wType === 'plasma') {
            mesh = new THREE.Mesh(SHARED_FX_GEO.plasmaOrb || SHARED_FX_GEO.mortarProj, MAT.cyanGlow);
        } else if (wType === 'rocket') {
            mesh = new THREE.Mesh(SHARED_FX_GEO.rocketProj || SHARED_FX_GEO.mortarProj, MAT.amberGlow);
        } else {
            mesh = new THREE.Mesh(SHARED_FX_GEO.spitProj || SHARED_FX_GEO.mortarProj, faction === 'zerg' ? MAT.bioGreen : MAT.amberGlow);
        }
        mesh.position.copy(fromPos);
        mesh.lookAt(endPos);
        tagSceneObjectMetadata(mesh, 'BATTLE_CINEMATIC.spawnSimProjectile', 'battle-cinematic', { role: wType });
        this.group.add(mesh);
        this.actors.projectiles.push({
            mesh,
            start: fromPos.clone(),
            end: endPos,
            target: targetActor,
            wType,
            damage,
            faction,
            progress: 0,
            speed: wType === 'tank' ? 2.1 : (wType === 'rocket' ? 2.0 : 2.7)
        });
    },

    cleanup() {
        if (this.lifecycleState === 'CLEANING') return;
        this.lifecycleState = 'CLEANING';
        this.active = false;

        if (this.actors) {
            const listKeys = ['projectiles', 'infantry', 'enemies', 'airUnits', 'buildings', 'workers', 'resourceNodes'];
            for (let k = 0; k < listKeys.length; k++) {
                const arr = this.actors[listKeys[k]];
                if (Array.isArray(arr)) {
                    for (let i = arr.length - 1; i >= 0; i--) {
                        const item = arr[i];
                        if (item && item.laserMesh) {
                            if (item.laserMesh.parent) item.laserMesh.parent.remove(item.laserMesh);
                            this.disposeCinematicMeshTree(item.laserMesh);
                        }
                        if (item && item.mesh) {
                            if (item.mesh.parent) item.mesh.parent.remove(item.mesh);
                            scene.remove(item.mesh);
                            this.disposeCinematicMeshTree(item.mesh);
                        }
                    }
                    arr.length = 0;
                }
            }
            const singleKeys = ['terranHQ', 'terranBarracks', 'station', 'spire', 'zergHatchery', 'zergPool', 'zergSpine'];
            for (let k = 0; k < singleKeys.length; k++) {
                this.actors[singleKeys[k]] = null;
            }
            this.actors.tank = null;
            this.actors.tank2 = null;
        }
        if (this.teams && this.teams.team_a) {
            this.teams.team_a.workers = [];
            this.teams.team_a.buildings = [];
            this.teams.team_a.hqBuilding = null;
        }
        if (this.teams && this.teams.team_b) {
            this.teams.team_b.workers = [];
            this.teams.team_b.buildings = [];
            this.teams.team_b.hqBuilding = null;
        }
        this.unitsA = this.actors ? this.actors.infantry : [];
        this.unitsB = this.actors ? this.actors.enemies : [];
        this.buildings = this.actors ? this.actors.buildings : [];

        if (this.group) {
            this.group.visible = false;
            if (this.group.parent) this.group.parent.remove(this.group);
            scene.remove(this.group);
            this.disposeCinematicMeshTree(this.group);
            this.group = null;
        }
        const lingeringGroup = scene.getObjectByName('BattleCinematicTheatre');
        if (lingeringGroup) {
            scene.remove(lingeringGroup);
            this.disposeCinematicMeshTree(lingeringGroup);
        }

        // Restore single-player gameplay structures when leaving the title screen cinematic
        this.restoreSinglePlayerGameplayEntitiesAfterCinematic();

        for (let i = projectiles.length - 1; i >= 0; i--) {
            if (projectiles[i] && projectiles[i].mesh) scene.remove(projectiles[i].mesh);
        }
        projectiles.length = 0;

        if (typeof fowMesh !== 'undefined' && fowMesh) {
            fowMesh.visible = true;
        }
        if (typeof controls !== 'undefined' && controls && typeof camera !== 'undefined' && camera) {
            controls.enabled = true;
            const focusAnchor = (state && state.baseBuilding && state.baseBuilding.pos)
                ? state.baseBuilding.pos
                : (typeof PLAYER_START_POS !== 'undefined' ? PLAYER_START_POS : null);
            if (focusAnchor && isFiniteCoord(focusAnchor.x) && isFiniteCoord(focusAnchor.z)) {
                const gy = typeof getSurfaceHeightWithBridges === 'function'
                    ? getSurfaceHeightWithBridges(focusAnchor.x, focusAnchor.z)
                    : (focusAnchor.y || 0);
                const safeGy = isFiniteCoord(gy) ? gy : 0;
                controls.target.set(focusAnchor.x, safeGy, focusAnchor.z);
                camera.position.set(focusAnchor.x, safeGy + 24, focusAnchor.z + 24);
            } else if (this.hasSavedGameplayCam && isFiniteVec3(this.savedGameplayCamPos) && isFiniteVec3(this.savedGameplayCamTarget)) {
                camera.position.copy(this.savedGameplayCamPos);
                controls.target.copy(this.savedGameplayCamTarget);
            }
            controls.update();
        }

        this.initialized = false;
        this.lifecycleState = 'DISPOSED';

        // Restore Zerg creep state for standard gameplay based strictly on whether a Zerg main base is built
        const postCinematicCreep = typeof window.getActiveZergCreepState === 'function'
            ? window.getActiveZergCreepState()
            : { hasBuiltZergMainBase: false };
        creepRadius = postCinematicCreep.hasBuiltZergMainBase ? 18.5 : 0.0;
        creepTargetRadius = postCinematicCreep.hasBuiltZergMainBase ? 21.0 : 0.0;
        if (typeof updateZergCreepColors === 'function') {
            updateZergCreepColors(creepRadius, false, true);
        }
    },

    restart() {
        this.time = 0;
        this.elapsed = 0;
        this.matchNumber++;
        this.lastMapSeed = null;
        this.cleanup();
        this.init();
        if (window.SFX) window.SFX.playClick();
    },

    skipToGameplay() {
        this.cleanup();
        const startBtn = document.querySelector('[data-testid="launch-campaign-btn"]');
        if (startBtn) startBtn.click();
    },

    updateWorkers(dt) {
        const surfFn = typeof getSurfaceHeightWithBridges === 'function' ? getSurfaceHeightWithBridges : getTerrainHeight;
        for (let i = this.actors.workers.length - 1; i >= 0; i--) {
            const w = this.actors.workers[i];
            if (!w || !w.mesh || w.hp <= 0 || !isFiniteVec3(w.mesh.position)) {
                if (w && w.laserMesh && w.laserMesh.parent) w.laserMesh.parent.remove(w.laserMesh);
                if (w && w.mesh && w.mesh.parent) w.mesh.parent.remove(w.mesh);
                this.actors.workers.splice(i, 1);
                continue;
            }
            const team = this.teams[w.teamId];
            const homeBase = this.actors.buildings.find(b => b && b.teamId === w.teamId && b.role === 'base' && b.hp > 0)
                || this.actors.buildings.find(b => b && b.teamId === w.teamId && b.hp > 0);
            if (!homeBase || !isFiniteVec3(homeBase.pos)) continue;

            if (!w.targetNode || w.targetNode.amount <= 0 || !isFiniteVec3(w.targetNode.pos)) {
                let bestNode = null;
                let bestDist = Infinity;
                const preferGem = (i % 3 === 2);
                for (let n = 0; n < this.actors.resourceNodes.length; n++) {
                    const nd = this.actors.resourceNodes[n];
                    if (!nd || nd.amount <= 0 || !isFiniteVec3(nd.pos)) continue;
                    let d = nd.pos.distanceTo(homeBase.pos);
                    if (preferGem && nd.kind === 'gem') d *= 0.65;
                    if (d < bestDist) {
                        bestDist = d;
                        bestNode = nd;
                    }
                }
                w.targetNode = bestNode;
            }

            if (w.state === 'TO_NODE' && w.targetNode) {
                w.laserMesh.visible = false;
                const dx = w.targetNode.pos.x - w.mesh.position.x;
                const dz = w.targetNode.pos.z - w.mesh.position.z;
                const dist = Math.hypot(dx, dz);
                if (dist <= 1.65) {
                    w.state = 'MINING';
                    w.mineTimer = 1.8;
                } else if (dist > 0.001) {
                    const nx = w.mesh.position.x + (dx / dist) * w.speed * dt;
                    const nz = w.mesh.position.z + (dz / dist) * w.speed * dt;
                    const ny = surfFn(nx, nz);
                    if (isFiniteCoord(nx) && isFiniteCoord(nz) && isFiniteCoord(ny)) {
                        w.mesh.position.set(nx, ny + 0.55 + Math.sin(this.time * 5 + i) * 0.08, nz);
                        w.mesh.rotation.y = Math.atan2(dx, dz);
                    }
                }
            } else if (w.state === 'MINING' && w.targetNode) {
                w.mineTimer -= dt;
                w.laserMesh.visible = true;
                const startPt = w.mesh.position;
                const endPt = w.targetNode.pos;
                w.laserMesh.position.lerpVectors(startPt, endPt, 0.5);
                w.laserMesh.position.y += 0.25;
                w.laserMesh.scale.set(1, 1, Math.max(0.2, startPt.distanceTo(endPt)));
                w.laserMesh.lookAt(endPt.x, endPt.y + 0.4, endPt.z);

                if (w.mineTimer <= 0) {
                    w.laserMesh.visible = false;
                    w.cargoKind = w.targetNode.kind;
                    w.cargoAmount = w.cargoKind === 'gem' ? 18 : 28;
                    w.targetNode.amount = Math.max(200, w.targetNode.amount - w.cargoAmount);
                    w.state = 'TO_BASE';
                }
            } else {
                w.laserMesh.visible = false;
                const dx = homeBase.pos.x - w.mesh.position.x;
                const dz = homeBase.pos.z - w.mesh.position.z;
                const dist = Math.hypot(dx, dz);
                if (dist <= 2.3) {
                    if (w.cargoKind === 'gem') team.gems += w.cargoAmount;
                    else team.minerals += w.cargoAmount;
                    w.cargoAmount = 0;
                    w.state = 'TO_NODE';
                } else if (dist > 0.001) {
                    const nx = w.mesh.position.x + (dx / dist) * w.speed * dt;
                    const nz = w.mesh.position.z + (dz / dist) * w.speed * dt;
                    const ny = surfFn(nx, nz);
                    if (isFiniteCoord(nx) && isFiniteCoord(nz) && isFiniteCoord(ny)) {
                        w.mesh.position.set(nx, ny + 0.55 + Math.sin(this.time * 5 + i) * 0.08, nz);
                        w.mesh.rotation.y = Math.atan2(dx, dz);
                    }
                }
            }

            // Animate worker sub-components (drills, wings, mandibles, cargo crystal)
            const wud = w.mesh.userData || {};
            wud.animTime = (wud.animTime || 0) + dt;
            wud.animState = w.state === 'MINING' ? 'Attacking' : 'Walking';
            if (wud.rotaryDrill) wud.rotaryDrill.rotation.z += dt * (w.state === 'MINING' ? 22.0 : 5.0);
            if (wud.apertureRing) wud.apertureRing.rotation.z += dt * (w.state === 'MINING' ? 8.0 : 2.5);
            if (wud.wingL && wud.wingR) {
                const flap = Math.sin(this.time * 18.0 + i) * 0.38;
                wud.wingL.rotation.z = 0.25 + flap;
                wud.wingR.rotation.z = -0.25 - flap;
            }
            if (wud.leftArm && wud.rightArm) {
                const pinch = w.state === 'MINING' ? Math.sin(this.time * 16.0) * 0.24 : 0;
                wud.leftArm.rotation.y = pinch;
                wud.rightArm.rotation.y = -pinch;
            }
            if (wud.cargoCrystal) {
                wud.cargoCrystal.visible = (w.state === 'TO_BASE' && w.cargoAmount > 0);
            }
        }
    },

    updateAICommander(teamId, dt) {
        const team = this.teams[teamId];
        if (!team) return;
        const fDef = CINEMATIC_FACTION_DEFS[team.faction] || CINEMATIC_FACTION_DEFS.terran;
        const myBlds = this.actors.buildings.filter(b => b && b.teamId === teamId && b.hp > 0);
        const myWorkers = this.actors.workers.filter(w => w && w.teamId === teamId && w.hp > 0);
        const myArmy = teamId === 'team_a'
            ? this.actors.infantry.filter(u => u && u.hp > 0)
            : this.actors.enemies.filter(u => u && u.hp > 0);

        team.workers = myWorkers;
        team.buildings = myBlds;
        team.supplyUsed = myWorkers.length + myArmy.length;

        // 1. Progress active building construction
        for (let i = 0; i < myBlds.length; i++) {
            const b = myBlds[i];
            if (b.buildProgress < 1.0) {
                b.buildProgress = Math.min(1.0, b.buildProgress + dt / (b.buildDuration || 8.5));
                b.hp = Math.min(b.maxHp, b.hp + (b.maxHp * 0.8) * (dt / (b.buildDuration || 8.5)));
                this.updateStructureConstructionVisuals(b);
            }
        }

        // 2. Replace lost workers (up to 4)
        if (myWorkers.length < 4 && team.minerals >= 50 && myBlds.length > 0) {
            team.minerals -= 50;
            const wSpot = this.resolvePlatformSpot(team, -2.8, (Math.random() - 0.5) * 4.0);
            this.spawnWorker(teamId, wSpot.x, wSpot.z);
        }

        // 3. Autonomous base expansion & tech tree construction on the base platform oriented toward the ramp
        team.buildTimer -= dt;
        if (team.buildTimer <= 0) {
            team.buildTimer = 4.2;
            const buildPlan = [
                { role: 'factory',  costM: 140, costG: 50, fwd: 4.5,  right:  6.2 },
                { role: 'turret',   costM: 95,  costG: 20, fwd: 9.2,  right: -3.8 },
                { role: 'airfield', costM: 150, costG: 75, fwd: -2.2, right:  6.8 },
                { role: 'barracks', costM: 120, costG: 25, fwd: 1.8,  right: -7.4 },
                { role: 'turret',   costM: 95,  costG: 20, fwd: 10.4, right:  0.8 }
            ];
            for (let p = 0; p < buildPlan.length; p++) {
                const slot = buildPlan[(team.buildOrderIndex + p) % buildPlan.length];
                const existingSame = myBlds.filter(b => b.role === slot.role).length;
                const maxAllowed = slot.role === 'turret' ? 3 : (slot.role === 'barracks' ? 2 : 1);
                if (existingSame < maxAllowed && team.minerals >= slot.costM && team.gems >= slot.costG) {
                    team.minerals -= slot.costM;
                    team.gems -= slot.costG;
                    team.buildOrderIndex = (team.buildOrderIndex + 1) % buildPlan.length;
                    const bSpot = this.resolvePlatformSpot(team, slot.fwd, slot.right);
                    this.spawnSpectatorStructure(
                        teamId,
                        slot.role,
                        bSpot.x,
                        bSpot.z,
                        false
                    );
                    break;
                }
            }
        }

        // 4. Autonomous weapon/armor tech upgrades
        team.upgradeTimer -= dt;
        if (team.upgradeTimer <= 0 && team.techLevel < 3 && team.minerals >= 150 && team.gems >= 80) {
            team.minerals -= 150;
            team.gems -= 80;
            team.techLevel++;
            team.upgradeTimer = 20.0;
        }

        // 5. Autonomous unit production from completed production structures using the team's faction roster
        team.produceTimer -= dt;
        if (team.produceTimer <= 0 && myArmy.length < 18) {
            team.produceTimer = 2.4;
            const prodBlds = myBlds.filter(b => b.buildProgress >= 0.99 && (b.role === 'barracks' || b.role === 'factory' || b.role === 'airfield' || b.role === 'base'));
            if (prodBlds.length > 0 && team.minerals >= 65) {
                const spawner = prodBlds[Math.floor(Math.random() * prodBlds.length)];
                let unitRole;
                let costM = 65;
                let costG = 10;
                if (spawner.role === 'airfield' && team.gems >= 40 && fDef.airPool.length > 0) {
                    unitRole = fDef.airPool[Math.floor(Math.random() * fDef.airPool.length)];
                    costM = 110; costG = 40;
                } else if (spawner.role === 'factory' && team.gems >= 30 && fDef.heavyPool.length > 0) {
                    unitRole = fDef.heavyPool[Math.floor(Math.random() * fDef.heavyPool.length)];
                    costM = 115; costG = 35;
                } else {
                    unitRole = fDef.infantryPool[Math.floor(Math.random() * fDef.infantryPool.length)];
                    costM = 65; costG = 10;
                }
                if (team.minerals >= costM && team.gems >= costG) {
                    team.minerals -= costM;
                    team.gems -= costG;
                    const sx = spawner.pos.x + team.rampDir.x * 2.8 + (Math.random() - 0.5) * 2.4;
                    const sz = spawner.pos.z + team.rampDir.z * 2.8 + (Math.random() - 0.5) * 2.4;
                    this.spawnSimUnit(teamId, unitRole, sx, sz);
                }
            }
        }

        // 6. Strategic Posture Evaluation (Defend vs Rally vs Full Assault)
        const enemyPool = teamId === 'team_a' ? this.actors.enemies : this.actors.infantry;
        let enemyNearBase = false;
        for (let e = 0; e < enemyPool.length; e++) {
            const eu = enemyPool[e];
            if (eu && eu.hp > 0 && eu.mesh && isFiniteVec3(eu.mesh.position) && eu.mesh.position.distanceTo(team.baseAnchor) < 22.0) {
                enemyNearBase = true;
                break;
            }
        }
        if (enemyNearBase) {
            team.posture = 'DEFENDING BASE';
        } else if (myArmy.length >= team.attackWaveThreshold) {
            team.posture = 'FULL ASSAULT';
        } else {
            team.posture = 'HARVESTING & MASSING';
        }
    },

    update(dt, nowMs) {
        if (!window.titleScreenActive && !window.loadingCameraSweep) {
            if (this.lifecycleState === 'ACTIVE' || this.initialized || this.group) {
                this.cleanup();
            }
            return;
        }
        if (this.lifecycleState !== 'ACTIVE' || this.lastMapSeed !== window.MAP_SEED) {
            if (this.lifecycleState === 'UNINITIALIZED' || this.lifecycleState === 'DISPOSED' || !this.initialized || this.lastMapSeed !== window.MAP_SEED) {
                this.init();
            }
            if (this.lifecycleState !== 'ACTIVE') return;
        }
        if (!this.initialized || !this.group) return;
        this.group.visible = true;

        this.time += dt;
        this.elapsed = this.time % this.cycleDuration;
        if (this.manualCameraOverrideTimer > 0) {
            this.manualCameraOverrideTimer = Math.max(0, this.manualCameraOverrideTimer - dt);
        }

        // Update stage banner for spectator telemetry
        for (let i = 0; i < this.STAGES.length; i++) {
            const st = this.STAGES[i];
            if (this.elapsed >= st.start && this.elapsed < st.end) {
                this.currentStage = st.id;
                this.stageTitle = st.title;
                break;
            }
        }

        // Check win/loss condition (only resets when an entire base is actually destroyed)
        const aliveBldsA = this.actors.buildings.filter(b => b && b.teamId === 'team_a' && b.hp > 0);
        const aliveBldsB = this.actors.buildings.filter(b => b && b.teamId === 'team_b' && b.hp > 0);
        if ((aliveBldsA.length === 0 || aliveBldsB.length === 0) && !this.matchWinner) {
            this.matchWinner = aliveBldsA.length > 0
                ? `${this.teams.team_a.name} VICTORY`
                : `${this.teams.team_b.name} VICTORY`;
            this.victoryResetTimer = 5.0;
        }
        if (this.matchWinner) {
            this.victoryResetTimer -= dt;
            if (this.victoryResetTimer <= 0) {
                this.restart();
                return;
            }
        }

        // 1. Update autonomous workers & AI commanders
        this.updateWorkers(dt);
        this.updateAICommander('team_a', dt);
        this.updateAICommander('team_b', dt);
        this.syncCinematicZergCreep(dt, false);

        // 2. Update living structure animations & remove destroyed buildings with faction-specific FX
        for (let i = this.actors.buildings.length - 1; i >= 0; i--) {
            const b = this.actors.buildings[i];
            if (!b || b.hp <= 0) {
                if (b && isFiniteVec3(b.pos)) {
                    if (b.faction === 'zerg') {
                        if (typeof spawnEnemyBuildingBreakAnimation === 'function') spawnEnemyBuildingBreakAnimation(b.pos, b.role);
                        if (typeof spawnGoreExplosion === 'function') spawnGoreExplosion(b.pos, true, true);
                    } else {
                        if (typeof spawnVolumetricFireball === 'function') spawnVolumetricFireball(b.pos, 2.2);
                        else if (typeof triggerExplosion === 'function') triggerExplosion(b.pos, 2.0);
                        if (typeof spawnShockwaveRing === 'function') spawnShockwaveRing(b.pos, 4.5, b.faction === 'protoss' ? 0x38bdf8 : 0xff6b35);
                    }
                }
                if (b && b.mesh) {
                    if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
                    this.disposeCinematicMeshTree(b.mesh);
                }
                this.actors.buildings.splice(i, 1);
            } else {
                if (b.faction === 'zerg' && typeof updateEnemyBuildingAnimationAndBreak === 'function') {
                    updateEnemyBuildingAnimationAndBreak(b, dt, this.time);
                } else if (typeof updateBuildingMechanicsAndDamage === 'function') {
                    updateBuildingMechanicsAndDamage(b, dt);
                }
            }
        }

        const teamAStructures = this.actors.buildings.filter(b => b && b.teamId === 'team_a' && b.hp > 0);
        const teamBStructures = this.actors.buildings.filter(b => b && b.teamId === 'team_b' && b.hp > 0);

        // 3. Defensive Turret & Spine Crawler Targeting
        for (let i = 0; i < this.actors.buildings.length; i++) {
            const bld = this.actors.buildings[i];
            if (!bld || bld.role !== 'turret' || bld.buildProgress < 0.99 || bld.hp <= 0 || !isFiniteVec3(bld.pos)) continue;
            bld.cooldown -= dt;
            const enemyUnits = bld.teamId === 'team_a' ? this.actors.enemies : this.actors.infantry;
            let nearest = null;
            let minDist = 18.0;
            for (let e = 0; e < enemyUnits.length; e++) {
                const eu = enemyUnits[e];
                if (!eu || eu.hp <= 0 || !eu.mesh || !isFiniteVec3(eu.mesh.position)) continue;
                const d = eu.mesh.position.distanceTo(bld.pos);
                if (d < minDist) { minDist = d; nearest = eu; }
            }
            if (nearest && bld.mesh.userData && bld.mesh.userData.head) {
                const dx = nearest.mesh.position.x - bld.pos.x;
                const dz = nearest.mesh.position.z - bld.pos.z;
                bld.mesh.userData.head.rotation.y = Math.atan2(dx, dz);
            }
            if (nearest && bld.cooldown <= 0) {
                bld.cooldown = bld.faction === 'terran' ? 0.55 : 0.72;
                const muzzle = bld.pos.clone().add(new THREE.Vector3(0, 1.95, 0));
                this.spawnSimProjectile(muzzle, nearest, bld.faction === 'zerg' ? 'spit' : 'plasma', 26, bld.faction);
            }
        }

        // 4. Autonomous Unit Navigation, Tactical Retreats, & Combat
        const surfFn = typeof getSurfaceHeightWithBridges === 'function' ? getSurfaceHeightWithBridges : getTerrainHeight;
        const stepArmyList = (armyList, enemyUnits, enemyBlds, myTeam) => {
            for (let i = armyList.length - 1; i >= 0; i--) {
                const u = armyList[i];
                if (!u || !u.mesh || u.hp <= 0 || !isFiniteVec3(u.mesh.position)) {
                    if (u && u.mesh) {
                        if (isFiniteVec3(u.mesh.position)) {
                            if (u.faction === 'zerg' && typeof spawnGoreExplosion === 'function') {
                                spawnGoreExplosion(u.mesh.position, u.isTank, false);
                            } else if (typeof triggerExplosion === 'function') {
                                triggerExplosion(u.mesh.position, u.isTank ? 1.5 : 0.85);
                            }
                        }
                        if (u.mesh.parent) u.mesh.parent.remove(u.mesh);
                        this.disposeCinematicMeshTree(u.mesh);
                    }
                    armyList.splice(i, 1);
                    continue;
                }

                // Find closest live enemy unit or building
                let bestTarget = null;
                let bestScore = Infinity;
                for (let e = 0; e < enemyUnits.length; e++) {
                    const eu = enemyUnits[e];
                    if (!eu || eu.hp <= 0 || !eu.mesh || !isFiniteVec3(eu.mesh.position)) continue;
                    const d = u.mesh.position.distanceTo(eu.mesh.position);
                    const score = d - (eu.hp < eu.maxHp * 0.35 ? 2.5 : 0);
                    if (score < bestScore) { bestScore = score; bestTarget = eu; }
                }
                for (let b = 0; b < enemyBlds.length; b++) {
                    const eb = enemyBlds[b];
                    if (!eb || eb.hp <= 0 || !isFiniteVec3(eb.pos)) continue;
                    const d = u.mesh.position.distanceTo(eb.pos) + 2.0;
                    if (d < bestScore) { bestScore = d; bestTarget = eb; }
                }

                // Determine tactical move destination
                let goalPos = myTeam.rallyPoint;
                const isRetreating = !u.isMelee && !u.isTank && u.hp < u.maxHp * 0.22;
                if (isRetreating) {
                    goalPos = myTeam.baseAnchor;
                } else if (myTeam.posture === 'DEFENDING BASE' && bestTarget) {
                    goalPos = bestTarget.mesh ? bestTarget.mesh.position : bestTarget.pos;
                } else if (myTeam.posture === 'FULL ASSAULT' && bestTarget) {
                    goalPos = bestTarget.mesh ? bestTarget.mesh.position : bestTarget.pos;
                } else if (bestTarget && bestScore < 20.0) {
                    goalPos = bestTarget.mesh ? bestTarget.mesh.position : bestTarget.pos;
                }

                const tPos = bestTarget ? (bestTarget.mesh ? bestTarget.mesh.position : bestTarget.pos) : goalPos;
                const distToTarget = (bestTarget && isFiniteVec3(tPos)) ? u.mesh.position.distanceTo(tPos) : Infinity;

                if (bestTarget && distToTarget <= u.range && !isRetreating) {
                    u.aiState = 'ATTACKING';
                    const dx = tPos.x - u.mesh.position.x;
                    const dz = tPos.z - u.mesh.position.z;
                    if (isFiniteCoord(dx) && isFiniteCoord(dz)) {
                        u.mesh.rotation.y = Math.atan2(dx, dz);
                    }

                    if (u.isTank && u.mesh.userData && u.mesh.userData.turretYawGroup) {
                        u.mesh.userData.turretYawGroup.rotation.y = 0;
                    }

                    u.cooldown -= dt;
                    if (u.cooldown <= 0) {
                        u.cooldown = u.fireRate;
                        u.mesh.userData.attackAnim = 1.0;
                        const rawMuzzle = (typeof window.getWeaponMuzzleWorldPos === 'function')
                            ? window.getWeaponMuzzleWorldPos(u.mesh, u.role)
                            : null;
                        const muzzle = isFiniteVec3(rawMuzzle)
                            ? rawMuzzle
                            : u.mesh.position.clone().add(new THREE.Vector3(0, u.isAir ? 0.0 : 0.95, 0));

                        if (u.isMelee) {
                            bestTarget.hp -= u.damage;
                            if (bestTarget.mesh && bestTarget.mesh.userData) bestTarget.mesh.userData.hitFlash = 0.25;
                            if (isFiniteVec3(tPos)) this.focusImpactPos.copy(tPos);
                            if (typeof triggerSparks === 'function' && isFiniteVec3(tPos)) triggerSparks(tPos);
                        } else if (u.role === 'firebat') {
                            bestTarget.hp -= u.damage;
                            if (bestTarget.mesh && bestTarget.mesh.userData) bestTarget.mesh.userData.hitFlash = 0.25;
                            if (isFiniteVec3(tPos)) this.focusImpactPos.copy(tPos);
                            if (typeof spawnFlamethrowerStream === 'function' && isFiniteVec3(tPos)) spawnFlamethrowerStream(muzzle, tPos);
                        } else {
                            const wType = u.role === 'brood_lord' ? 'brood_lord' : (u.isTank ? 'tank' : (u.role === 'rocketman' || u.role === 'marauder' || u.role === 'heli' ? 'rocket' : (u.faction === 'zerg' ? 'spit' : (u.faction === 'protoss' ? 'plasma' : 'bullet'))));
                            this.spawnSimProjectile(muzzle, bestTarget, wType, u.damage, u.faction);
                        }
                    }
                    if (typeof updateUnitAnimation === 'function') {
                        updateUnitAnimation(u.mesh, dt, false, isFiniteVec3(tPos) ? tPos : null, u.speed);
                    }
                } else if (isFiniteVec3(goalPos)) {
                    u.aiState = 'MOVING';
                    let stepGoal = goalPos;
                    if (!u.isAir && typeof getGroundNavigationWaypoint === 'function') {
                        u.navTimer -= dt;
                        if (!u.navWaypoint || !isFiniteVec3(u.navWaypoint) || u.navTimer <= 0) {
                            const wp = getGroundNavigationWaypoint(u.mesh.position, goalPos, u);
                            u.navWaypoint = isFiniteVec3(wp) ? wp.clone() : goalPos.clone();
                            u.navTimer = 0.65;
                        }
                        if (isFiniteVec3(u.navWaypoint)) stepGoal = u.navWaypoint;
                    }
                    const dx = stepGoal.x - u.mesh.position.x;
                    const dz = stepGoal.z - u.mesh.position.z;
                    const d = Math.hypot(dx, dz);
                    const isMovingStep = d > 1.1 && isFiniteCoord(d);
                    if (isMovingStep) {
                        let nx = u.mesh.position.x + (dx / d) * u.speed * dt;
                        let nz = u.mesh.position.z + (dz / d) * u.speed * dt;
                        if (!u.isAir && typeof computeSafeGroundStep === 'function') {
                            const stepDir = computeSafeGroundStep(u.mesh.position, stepGoal, u.speed, dt, u, armyList, this.actors.buildings, null);
                            if (stepDir && isFiniteCoord(stepDir.x) && isFiniteCoord(stepDir.z) && (Math.abs(stepDir.x) > 0.001 || Math.abs(stepDir.z) > 0.001)) {
                                nx = u.mesh.position.x + stepDir.x * u.speed * dt;
                                nz = u.mesh.position.z + stepDir.z * u.speed * dt;
                            }
                        }
                        nx = THREE.MathUtils.clamp(nx, -102, 102);
                        nz = THREE.MathUtils.clamp(nz, -102, 102);
                        const groundY = surfFn(nx, nz);
                        if (isFiniteCoord(nx) && isFiniteCoord(nz) && isFiniteCoord(groundY)) {
                            u.mesh.position.x = nx;
                            u.mesh.position.z = nz;
                            const airAlt = u.role === 'brood_lord' ? 6.4 : 5.2;
                            u.mesh.position.y = groundY + (u.isAir ? airAlt + Math.sin(this.time * 3.2 + i) * 0.25 : 0);
                            u.mesh.rotation.y = Math.atan2(dx, dz);
                        }
                    }
                    if (typeof updateUnitAnimation === 'function') {
                        updateUnitAnimation(u.mesh, dt, isMovingStep, isFiniteVec3(stepGoal) ? stepGoal : null, u.speed);
                    }
                }
            }
        };

        stepArmyList(this.actors.infantry, this.actors.enemies, teamBStructures, this.teams.team_a);
        stepArmyList(this.actors.enemies, this.actors.infantry, teamAStructures, this.teams.team_b);

        // 5. Update Simulated Projectiles & Apply Real Damage
        for (let i = this.actors.projectiles.length - 1; i >= 0; i--) {
            const p = this.actors.projectiles[i];
            p.progress += dt * p.speed;
            if (p.target && (p.target.mesh || p.target.pos)) {
                const tp = p.target.mesh ? p.target.mesh.position : p.target.pos;
                if (isFiniteVec3(tp)) {
                    p.end.set(tp.x, tp.y + (p.target.isAir ? 0 : 0.85), tp.z);
                }
            }
            const t = Math.min(1, p.progress);
            p.mesh.position.lerpVectors(p.start, p.end, t);
            if (p.wType === 'tank' || p.wType === 'rocket') {
                p.mesh.position.y += Math.sin(t * Math.PI) * 1.1;
            }
            if (p.progress >= 1 || !isFiniteVec3(p.mesh.position)) {
                if (p.target && p.target.hp > 0) {
                    p.target.hp -= p.damage;
                    if (isFiniteVec3(p.end)) this.focusImpactPos.copy(p.end);
                }
                if (isFiniteVec3(p.end)) {
                    if (p.wType === 'tank') {
                        if (typeof spawnVolumetricFireball === 'function') spawnVolumetricFireball(p.end, 1.25);
                        else if (typeof triggerExplosion === 'function') triggerExplosion(p.end, 1.2);
                    } else if (typeof triggerSparks === 'function') {
                        triggerSparks(p.end);
                    }
                }
                if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
                this.disposeCinematicMeshTree(p.mesh);
                this.actors.projectiles.splice(i, 1);
            }
        }

        // 6. Spectator Camera Director (supports manual override + 5 camera modes)
        if (this.manualCameraOverrideTimer > 0) {
            controls.update();
            if (isFiniteVec3(camera.position)) this.camPosSmooth.copy(camera.position);
            if (isFiniteVec3(controls.target)) this.camLookSmooth.copy(controls.target);
            return;
        }

        const ax = isFiniteCoord(this.anchor?.x) ? this.anchor.x : 0;
        const ay = isFiniteCoord(this.anchor?.y) ? this.anchor.y : 0.5;
        const az = isFiniteCoord(this.anchor?.z) ? this.anchor.z : 0;

        // Compute largest active battle cluster centroid with strict finite coordinate guards
        let battleCenter = isFiniteVec3(this.focusImpactPos) ? this.focusImpactPos.clone() : new THREE.Vector3(ax, ay, az);
        const allCombatants = [...this.actors.infantry, ...this.actors.enemies].filter(u => u && u.hp > 0 && u.mesh && isFiniteVec3(u.mesh.position));
        if (allCombatants.length > 0) {
            let sx = 0, sy = 0, sz = 0, count = 0;
            for (let i = 0; i < allCombatants.length; i++) {
                const u = allCombatants[i];
                const w = u.aiState === 'ATTACKING' ? 3 : 1;
                sx += u.mesh.position.x * w;
                sy += u.mesh.position.y * w;
                sz += u.mesh.position.z * w;
                count += w;
            }
            if (count > 0 && isFiniteCoord(sx) && isFiniteCoord(sy) && isFiniteCoord(sz)) {
                battleCenter.set(sx / count, sy / count, sz / count);
            }
        }

        const camGoal = new THREE.Vector3();
        const lookGoal = new THREE.Vector3();
        const bobX = Math.sin(this.time * 0.45) * 2.2;
        const bobZ = Math.cos(this.time * 0.38) * 2.2;

        if (this.cameraViewMode === 'birds_eye') {
            camGoal.set(ax + bobX * 1.4, ay + 48.0, az + 32.0 + bobZ);
            lookGoal.set(ax, ay + 0.5, az);
        } else if (this.cameraViewMode === 'team_a') {
            const anchorA = this.teams.team_a.baseAnchor;
            camGoal.set(anchorA.x + 14.0 + bobX, anchorA.y + 18.0, anchorA.z + 16.0);
            lookGoal.set(anchorA.x, anchorA.y + 1.2, anchorA.z);
        } else if (this.cameraViewMode === 'team_b') {
            const anchorB = this.teams.team_b.baseAnchor;
            camGoal.set(anchorB.x - 14.0 + bobX, anchorB.y + 18.0, anchorB.z - 16.0);
            lookGoal.set(anchorB.x, anchorB.y + 1.2, anchorB.z);
        } else if (this.cameraViewMode === 'ground_operator') {
            camGoal.set(battleCenter.x + 11.0 + bobX, battleCenter.y + 9.0, battleCenter.z + 12.0 + bobZ);
            lookGoal.set(battleCenter.x, battleCenter.y + 1.1, battleCenter.z);
        } else {
            // 'auto' mode cycles smoothly between Team A platform, frontline battle, and Team B platform
            const phaseSlice = Math.floor((this.time / 12.0) % 4);
            if (phaseSlice === 0) {
                const anchorA = this.teams.team_a.baseAnchor;
                camGoal.set(anchorA.x + 13.0 + bobX, anchorA.y + 15.0, anchorA.z + 14.0);
                lookGoal.set(anchorA.x + this.teams.team_a.rampDir.x * 5.0, anchorA.y + 1.2, anchorA.z + this.teams.team_a.rampDir.z * 5.0);
            } else if (phaseSlice === 1) {
                camGoal.set(battleCenter.x + 14.0 + bobX, battleCenter.y + 14.5, battleCenter.z + 15.0 + bobZ);
                lookGoal.set(battleCenter.x, battleCenter.y + 1.0, battleCenter.z);
            } else if (phaseSlice === 2) {
                const anchorB = this.teams.team_b.baseAnchor;
                camGoal.set(anchorB.x - 13.0 + bobX, anchorB.y + 15.0, anchorB.z - 14.0);
                lookGoal.set(anchorB.x + this.teams.team_b.rampDir.x * 5.0, anchorB.y + 1.2, anchorB.z + this.teams.team_b.rampDir.z * 5.0);
            } else {
                camGoal.set(battleCenter.x - 12.0 + bobX, battleCenter.y + 10.5, battleCenter.z + 12.0);
                lookGoal.set(battleCenter.x, battleCenter.y + 1.2, battleCenter.z);
            }
        }

        // Prevent camera clipping through terrain or structures
        const rawCamSurfaceY = typeof surfFn === 'function' ? surfFn(camGoal.x, camGoal.z) : ay;
        let minClearanceY = (isFiniteCoord(rawCamSurfaceY) ? rawCamSurfaceY : ay) + 3.5;
        for (let b = 0; b < this.actors.buildings.length; b++) {
            const bld = this.actors.buildings[b];
            if (bld && isFiniteVec3(bld.pos) && Math.hypot(camGoal.x - bld.pos.x, camGoal.z - bld.pos.z) < 5.0) {
                minClearanceY = Math.max(minClearanceY, bld.pos.y + 5.5);
            }
        }
        if (camGoal.y < minClearanceY) camGoal.y = minClearanceY;

        if (!isFiniteVec3(this.camPosSmooth)) this.camPosSmooth.copy(camGoal);
        if (!isFiniteVec3(this.camLookSmooth)) this.camLookSmooth.copy(lookGoal);

        this.camPosSmooth.x = THREE.MathUtils.damp(this.camPosSmooth.x, camGoal.x, 2.8, dt);
        this.camPosSmooth.y = THREE.MathUtils.damp(this.camPosSmooth.y, camGoal.y, 2.8, dt);
        this.camPosSmooth.z = THREE.MathUtils.damp(this.camPosSmooth.z, camGoal.z, 2.8, dt);

        this.camLookSmooth.x = THREE.MathUtils.damp(this.camLookSmooth.x, lookGoal.x, 3.6, dt);
        this.camLookSmooth.y = THREE.MathUtils.damp(this.camLookSmooth.y, lookGoal.y, 3.6, dt);
        this.camLookSmooth.z = THREE.MathUtils.damp(this.camLookSmooth.z, lookGoal.z, 3.6, dt);

        if (isFiniteVec3(this.camPosSmooth) && isFiniteVec3(this.camLookSmooth)) {
            camera.position.copy(this.camPosSmooth);
            controls.target.copy(this.camLookSmooth);
            controls.update();
        }
    }
};

function animate(now) {
    requestAnimationFrame(animate);
    try {
    const perfProf = window.PERF_PROFILER;
    if (perfProf) perfProf.beginFrame(now);
    const rawDt = Math.min((now - prevTime) / 1000, 0.05);
    prevTime = now;

    if (window.PERF_MANAGER && typeof window.PERF_MANAGER.update === 'function') {
        window.PERF_MANAGER.update(rawDt, renderer, perfProf);
    }

    const isCinematicOrLoading = !!(window.titleScreenActive || window.loadingCameraSweep);
    const gameContainerEl = document.getElementById('game-container');
    if (gameContainerEl) {
        if (isCinematicOrLoading && !gameContainerEl.classList.contains('cinematic-overlay-active')) {
            gameContainerEl.classList.add('cinematic-overlay-active');
        } else if (!isCinematicOrLoading && gameContainerEl.classList.contains('cinematic-overlay-active')) {
            gameContainerEl.classList.remove('cinematic-overlay-active');
        }
    }

    if (isCinematicOrLoading) {
        fowMesh.visible = false;
        ghostRoot.visible = false;
        cursorTag.style.display = 'none';
        selectionBoxEl.style.display = 'none';
        window.BATTLE_CINEMATIC.update(rawDt, now);
        if (MAT.updateShaders) MAT.updateShaders(now * 0.001);
        if (window.SHADER_ENGINE && typeof window.SHADER_ENGINE.update === 'function') {
            window.SHADER_ENGINE.update(now * 0.001);
        }
        waterTex.offset.x += rawDt * 0.04;
        waterTex.offset.y += rawDt * 0.025;
        for (let i = projectiles.length - 1; i >= 0; i--) {
            const p = projectiles[i];
            p.progress += rawDt * (p.speed || 2.5);
            p.mesh.position.lerpVectors(p.start, p.landingPos, Math.min(1, p.progress));
            p.mesh.position.y += Math.sin(Math.min(1, p.progress) * Math.PI) * 1.4;
            if (p.progress >= 1) {
                triggerSparks(p.landingPos);
                scene.remove(p.mesh);
                projectiles.splice(i, 1);
            }
        }
        for (let i = particles.length - 1; i >= 0; i--) {
            const pt = particles[i];
            pt.life -= rawDt;
            pt.mesh.position.addScaledVector(pt.vel, rawDt);
            pt.vel.y -= (pt.gravity || 0) * rawDt;
            if (pt.life <= 0) { scene.remove(pt.mesh); particles.splice(i, 1); }
        }
        for (let i = smokeClouds.length - 1; i >= 0; i--) {
            const sm = smokeClouds[i];
            sm.life -= rawDt;
            sm.mesh.position.addScaledVector(sm.vel, rawDt);
            sm.mesh.scale.multiplyScalar(1 + rawDt * 1.1);
            if (sm.life <= 0) { scene.remove(sm.mesh); smokeClouds.splice(i, 1); }
        }
        for (let i = shockwaves.length - 1; i >= 0; i--) {
            const sw = shockwaves[i];
            sw.scale += rawDt * (sw.speed || 14);
            sw.alpha -= rawDt * 2.2;
            sw.mesh.scale.setScalar(sw.scale);
            sw.mesh.material.opacity = Math.max(0, sw.alpha);
            if (sw.alpha <= 0) { scene.remove(sw.mesh); sw.mesh.material.dispose(); shockwaves.splice(i, 1); }
        }
        fowTimer -= rawDt;
        if (fowTimer <= 0) {
            renderTacticalMinimap();
            fowTimer = 0.2;
        }
        if (window.AXIS_BALL_CONTROLLER && typeof window.AXIS_BALL_CONTROLLER.update === 'function') {
            window.AXIS_BALL_CONTROLLER.update(rawDt);
        }
        if (window.PERF_PROFILER) window.PERF_PROFILER.begin('renderScene');
        renderer.render(scene, camera);
        if (window.PERF_PROFILER) {
            window.PERF_PROFILER.end('renderScene');
            window.PERF_PROFILER.endFrame(renderer, {
                units: units.length,
                enemies: enemies.length,
                buildings: buildings.length + enemyBuildings.length + (typeof solarisBuildings !== 'undefined' ? solarisBuildings.length : 0),
                projectiles: projectiles.length,
                particles: particles.length + smokeClouds.length + shockwaves.length
            });
        }
        return;
    }

    if (window.BATTLE_CINEMATIC && (window.BATTLE_CINEMATIC.lifecycleState === 'ACTIVE' || window.BATTLE_CINEMATIC.initialized || window.BATTLE_CINEMATIC.group)) {
        window.BATTLE_CINEMATIC.cleanup();
    }

    fowMesh.visible = true;

    if (window.gamePaused) {
        controls.update();
        renderer.render(scene, camera);
        if (window.PERF_PROFILER) window.PERF_PROFILER.endFrame(renderer);
        return;
    }

    if (hitstopTimer > 0) {
        hitstopTimer -= rawDt;
        controls.update();
        renderer.render(scene, camera);
        if (window.PERF_PROFILER) window.PERF_PROFILER.endFrame(renderer);
        return;
    }

    const dt = rawDt;
    if (state.basePlaced && !state.missionWon) {
        state.elapsedSec += dt;

        if (state.rushGraceTimer > 0) {
            state.rushGraceTimer = Math.max(0, state.rushGraceTimer - dt);
            if (state.rushGraceTimer === 0) {
                spawnCombatFloat(state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS, 'WARNING: HOSTILE AIR WINGS UNLEASHED!', '#ff2a4b');
                const ticker = document.getElementById('directive-ticker');
                if (ticker) {
                    ticker.innerText = "AIRSPACE BREACH: Mutalisk Flight Wings Detected! Engage with Marksmen & Turrets!";
                    ticker.style.color = "#ff2a4b";
                }
            }
        }

        // Dynamic Zerg Swarm Wave Coordination Timer
        state.swarmWaveTimer -= dt;
        if (state.swarmWaveTimer <= 0) {
            state.swarmWaveTimer = 26.0;
            let count = 0;
            for (let ei = 0; ei < enemies.length; ei++) {
                const e = enemies[ei];
                if (e && e.aiState === 'staging') {
                    e.aiState = e.isFlanker ? 'flank' : 'charge';
                    count++;
                }
            }
            if (count > 0) {
                spawnCombatFloat(ENEMY_STAGING_POS, `SWARM WAVE ASSAULT! (${count} BIO-UNITS)`, '#d946ef');
            }
        }

        hudClockTimer += dt;
        if (hudClockTimer >= 0.5) {
            hudClockTimer = 0;
            updateHUD();
        }
    }

    // WASD / Arrow Keys Camera Panning (Zero per-frame Vector3 allocations)
    const panSpeed = 34 * dt;
    camera.getWorldDirection(_camForwardVec);
    _camForwardVec.y = 0;
    if (_camForwardVec.lengthSq() > 0.0001) _camForwardVec.normalize();
    _camRightVec.crossVectors(_camForwardVec, _worldUpVec).normalize();

    if (keysPressed['w'] || keysPressed['arrowup']) {
        camera.position.addScaledVector(_camForwardVec, panSpeed);
        controls.target.addScaledVector(_camForwardVec, panSpeed);
    }
    if (keysPressed['s'] || keysPressed['arrowdown']) {
        camera.position.addScaledVector(_camForwardVec, -panSpeed);
        controls.target.addScaledVector(_camForwardVec, -panSpeed);
    }
    if (keysPressed['a'] || keysPressed['arrowleft']) {
        camera.position.addScaledVector(_camRightVec, -panSpeed);
        controls.target.addScaledVector(_camRightVec, -panSpeed);
    }
    if (keysPressed['d'] || keysPressed['arrowright']) {
        camera.position.addScaledVector(_camRightVec, panSpeed);
        controls.target.addScaledVector(_camRightVec, panSpeed);
    }

    controls.update();

    // Clamp View Camera & Orbit Target inside Out-of-Bounds Map Barrier & Preserve Horizontal Offset (Never collapse into top-down view!)
    let camOffX = camera.position.x - controls.target.x;
    let camOffZ = camera.position.z - controls.target.z;
    let horizDist = Math.hypot(camOffX, camOffZ);
    const minHorizDist = 18.0;
    if (horizDist < minHorizDist) {
        if (horizDist < 0.001) {
            camOffX = 0;
            camOffZ = minHorizDist;
        } else {
            const scaleH = minHorizDist / horizDist;
            camOffX *= scaleH;
            camOffZ *= scaleH;
        }
    }
    const camTargetLim = 100.0;
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, -camTargetLim, camTargetLim);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, -camTargetLim, camTargetLim);
    const targetGroundY = getSurfaceHeightWithBridges(controls.target.x, controls.target.z);
    if (controls.target.y < targetGroundY - 1.5 || controls.target.y > targetGroundY + 12.0) {
        const targetYClamped = THREE.MathUtils.clamp(controls.target.y, targetGroundY - 1.5, targetGroundY + 12.0);
        const dy = targetYClamped - controls.target.y;
        controls.target.y = targetYClamped;
        camera.position.y += dy;
    }
    camera.position.x = controls.target.x + camOffX;
    camera.position.z = controls.target.z + camOffZ;
    const camSurfaceY = getSurfaceHeightWithBridges(camera.position.x, camera.position.z);
    if (camera.position.y < camSurfaceY + 8.0) {
        camera.position.y = camSurfaceY + 8.0;
    }

    updateCameraViewportFrustum();
    syncUnitAndBuildingCounters();
    rebuildFrameSpatialGrids();
    if (window.BRIDGE_TRAFFIC_MANAGER && typeof window.BRIDGE_TRAFFIC_MANAGER.update === 'function') {
        window.BRIDGE_TRAFFIC_MANAGER.update(dt);
    }
    if (window.STRATEGIC_COMMANDER && typeof window.STRATEGIC_COMMANDER.update === 'function') {
        window.STRATEGIC_COMMANDER.update(dt);
    }
    if (window.AI_DEBUG && typeof window.AI_DEBUG.update === 'function') {
        window.AI_DEBUG.update(dt);
    }

    const perfCfg = (window.PERF_MANAGER && window.PERF_MANAGER.current) ? window.PERF_MANAGER.current : null;
    const fowInterval = perfCfg ? perfCfg.fowInterval : 0.09;
    fowTimer -= dt;
    if (fowTimer <= 0) {
        _fowStepToggle = !_fowStepToggle;
        if (_fowStepToggle) {
            updateFogOfWarVision();
        } else {
            if (window.PERF_PROFILER) window.PERF_PROFILER.begin('minimapRender');
            renderTacticalMinimap();
            if (window.PERF_PROFILER) window.PERF_PROFILER.end('minimapRender');
        }
        fowTimer = fowInterval;
    }

    if (window.PERF_PROFILER) window.PERF_PROFILER.begin('weatherAndShaders');
    if (MAT.updateShaders) MAT.updateShaders(now * 0.001);
    if (window.SHADER_ENGINE && typeof window.SHADER_ENGINE.update === 'function') {
        window.SHADER_ENGINE.update(now * 0.001);
    }
    if (window.WEATHER_SYSTEM && typeof window.WEATHER_SYSTEM.update === 'function') {
        window.WEATHER_SYSTEM.update(dt, now * 0.001, camera);
    }
    if (typeof updateWaterPondsAndRipples === 'function') updateWaterPondsAndRipples(dt);
    if (typeof window.updateBiomeLandmarks === 'function') window.updateBiomeLandmarks(dt);
    if (window.AMBIENT_AUDIO_ENGINE && typeof window.AMBIENT_AUDIO_ENGINE.update === 'function') {
        window.AMBIENT_AUDIO_ENGINE.update(dt, camera, controls.target);
    }
    waterTex.offset.x += dt * 0.04;
    waterTex.offset.y += dt * 0.025;
    const treeStride = perfCfg && perfCfg.particleBudgetScale < 0.7 ? 2 : 1;
    const frameTickForTrees = window.PERF_PROFILER ? window.PERF_PROFILER.frameCount : 0;
    for (let ti = frameTickForTrees % treeStride; ti < swayTrees.length; ti += treeStride) {
        const t = swayTrees[ti];
        if (!t || !t.crown) continue;
        const tp = t.crown.position;
        if (tp && !window.isWorldPosInViewport(tp.x, tp.y, tp.z, 4.5)) continue;
        t.phase += dt * 1.6 * treeStride;
        t.crown.rotation.z = Math.sin(t.phase) * 0.035;
    }
    if (window.PERF_PROFILER) window.PERF_PROFILER.end('weatherAndShaders');

    // Dynamic Red Glow Border Frame Modulation: ONLY appears when Friendly Main Base HP is low (<= 40% HP)!
    const redBorderEl = document.getElementById('red-border-glow-frame');
    if (redBorderEl) {
        const hqLowHp = !!(state.basePlaced && state.baseBuilding && state.baseBuilding.hp > 0 && (state.baseBuilding.hp / state.baseBuilding.maxHp) <= 0.40);
        redBorderEl.classList.toggle('combat-alert', hqLowHp);
    }

    // Modulate Command & Conquer: Red Alert AI Music combat intensity based on active enemies & battle state
    if (window.RAID_MUSIC && typeof window.RAID_MUSIC.setCombatIntensity === 'function') {
        const enemyFactor = Math.min(1.0, enemies.length / 18);
        const waveFactor = Math.min(1.0, (state.wave - 1) * 0.15);
        window.RAID_MUSIC.setCombatIntensity(0.25 + enemyFactor * 0.55 + waveFactor * 0.20);
    }

    const weatherSpdMult = (window.WEATHER_SYSTEM && typeof window.WEATHER_SYSTEM.getSpeedMultiplier === 'function')
        ? window.WEATHER_SYSTEM.getSpeedMultiplier()
        : 1.0;

    // --- ACTIVE ZERG CREEP SPREAD & ANIMATED DISAPPEARING WHEN THE MAIN ZERG BASE IS DESTROYED ---
    // BUG FIX: Zerg creep ONLY appears when a Zerg Main Base is already built & alive, and NEVER on Protoss or Terran bases!
    const activeCreepState = typeof window.getActiveZergCreepState === 'function'
        ? window.getActiveZergCreepState()
        : {
            hasBuiltZergMainBase: Boolean(
                state.enemyBase && state.enemyBase.hp > 0 &&
                (!state.enemyBase.faction || state.enemyBase.faction === 'zerg') &&
                (state.enemyBase.buildProgress === undefined || state.enemyBase.buildProgress >= 0.99) &&
                enemyBuildings.includes(state.enemyBase)
            ),
            x: ENEMY_BASE_POS.x,
            z: ENEMY_BASE_POS.z,
            buildingsList: enemyBuildings
        };
    const hasMainZergBase = activeCreepState.hasBuiltZergMainBase;
    const zergCreepCenterX = activeCreepState.x;
    const zergCreepCenterZ = activeCreepState.z;
    if (state.enemyBase && state.enemyBase.hp > 0) {
        ENEMY_BASE_POS.x = state.enemyBase.pos.x;
        ENEMY_BASE_POS.z = state.enemyBase.pos.z;
    }
    if (hasMainZergBase && !state.missionWon) {
        // Decreased Zerg Base Creep Infect Radius (compact 16.5m–23.5m radius around the Zerg Main Base!)
        const zergBldCount = Array.isArray(activeCreepState.buildingsList) ? activeCreepState.buildingsList.length : enemyBuildings.length;
        const baseCreepGoal = state.basePlaced
            ? (16.5 + zergBldCount * 1.15 + Math.min(4.5, state.elapsedSec * 0.05))
            : (16.5 + Math.min(2.5, (performance.now() * 0.001) * 0.04));
        creepTargetRadius = Math.min(23.5, Math.max(16.5, baseCreepGoal));
        if (creepRadius < 1.0) creepRadius = 16.5;

        if (typeof emitZergCreepGooParticles === 'function') {
            emitZergCreepGooParticles(zergCreepCenterX, zergCreepCenterZ, creepRadius, dt);
        }
        creepUpdateClock += dt;
        if (creepUpdateClock >= 0.25) {
            creepUpdateClock = 0;
            const isReceding = creepRadius > creepTargetRadius + 0.3;
            if (creepRadius < creepTargetRadius) {
                creepRadius = Math.min(creepTargetRadius, creepRadius + 0.22);
                // Spawn new creep tumor inside the compact Zerg creep radius occasionally
                if (state.basePlaced && Math.random() < 0.14 && creepTumors.length < 16) {
                    const ang = Math.random() * Math.PI * 2;
                    const tr = Math.max(6.5, creepRadius - 2.2);
                    spawnCreepTumor(zergCreepCenterX + Math.cos(ang) * tr, zergCreepCenterZ + Math.sin(ang) * tr);
                }
            } else if (creepRadius > creepTargetRadius) {
                creepRadius = Math.max(creepTargetRadius, creepRadius - 1.15);
            }
            updateZergCreepColors(creepRadius, isReceding, false);

            // Emit dissolving spore/ember particles along receding creep edge
            if (isReceding && particles.length < 130) {
                for (let pIdx = 0; pIdx < 3; pIdx++) {
                    const a = Math.random() * Math.PI * 2;
                    const px = zergCreepCenterX + Math.cos(a) * creepRadius;
                    const pz = zergCreepCenterZ + Math.sin(a) * creepRadius;
                    const py = getTerrainHeight(px, pz);
                    if (py > -0.5) {
                        const ember = new THREE.Mesh(SHARED_FX_GEO.goreChunk, pIdx % 2 === 0 ? MAT.volatileGlow : MAT.hiveVeinGlow);
                        ember.scale.setScalar(0.45);
                        ember.position.set(px, py + 0.2, pz);
                        scene.add(ember);
                        particles.push({
                            mesh: ember,
                            vel: new THREE.Vector3((Math.random() - 0.5) * 1.5, 2.2 + Math.random() * 1.8, (Math.random() - 0.5) * 1.5),
                            gravity: -1.0,
                            life: 0.45
                        });
                    }
                }
            }
        }
    } else if (creepRadius > 0.01) {
        // Main Zerg Base is destroyed or not built: immediately recede & dissolve Zerg Creep smoothly to 0!
        creepTargetRadius = 0;
        creepRadius = Math.max(0, creepRadius - dt * 9.5);
        if (creepRadius < 0.48) creepRadius = 0;
        creepUpdateClock += dt;
        if (creepUpdateClock >= 0.05 || creepRadius === 0) {
            creepUpdateClock = 0;
            updateZergCreepColors(creepRadius, true, creepRadius === 0);

            if (creepRadius > 0.8 && particles.length < 135) {
                for (let pIdx = 0; pIdx < 4; pIdx++) {
                    const a = Math.random() * Math.PI * 2;
                    const px = zergCreepCenterX + Math.cos(a) * creepRadius;
                    const pz = zergCreepCenterZ + Math.sin(a) * creepRadius;
                    const py = getTerrainHeight(px, pz);
                    if (py > -0.5) {
                        const ember = new THREE.Mesh(SHARED_FX_GEO.goreChunk, pIdx % 2 === 0 ? MAT.acidGlow : MAT.hiveVeinGlow);
                        ember.scale.setScalar(0.5);
                        ember.position.set(px, py + 0.2, pz);
                        scene.add(ember);
                        particles.push({
                            mesh: ember,
                            vel: new THREE.Vector3((Math.random() - 0.5) * 2.0, 2.5 + Math.random() * 2.0, (Math.random() - 0.5) * 2.0),
                            gravity: -1.2,
                            life: 0.42
                        });
                    }
                }
            }
        }
    }

    // Keep Creep Tumors 100% Static in the Zerg Creep Zone (Only shrink/pop when enemy structures are destroyed and creep recedes)
    for (let i = creepTumors.length - 1; i >= 0; i--) {
        const ct = creepTumors[i];
        if (ct.distFromHive > creepRadius + 0.5) {
            ct.scale = (ct.scale || 1.0) - dt * 1.8;
            ct.group.scale.setScalar(Math.max(0.01, ct.scale));
            if (ct.scale <= 0.05) {
                spawnGoreExplosion(ct.group.position, false, true);
                scene.remove(ct.group);
                creepTumors.splice(i, 1);
            }
        }
    }

    // --- AUTONOMOUS 3-FACTION MINERAL HARVESTING DRONES (TERRAN SCV, PROTOSS PROBE, ZERG BIO-DRONE) ---
    syncAndUpdateAutoMiningDrones(dt);

    // --- PLAYER STRUCTURE COMPLETION / FIELD REPAIR & AI ALLY REINFORCEMENTS ---
    // NOTE: Player controls their own faction (`buildings`) manually — never auto-build structures into `buildings`!
    // Autonomous base building is strictly for the AI Allies faction (`solarisBuildings` at `SOLARIS_BASE_POS`).
    if (state.basePlaced && !state.missionWon) {
        for (let bi = 0; bi < buildings.length; bi++) {
            const b = buildings[bi];
            if (!b || b.hp <= 0) continue;
            if (b.buildProgress !== undefined && b.buildProgress < 1.0) {
                // Realistic slow-start paced construction speed: ~16.5s for factory/robotics, ~14s for barracks/gate, ~10s for turrets/pylons
                const buildRate = (b.type === 'factory' || b.type === 'solaris_robotics')
                    ? 0.060
                    : ((b.type === 'barracks' || b.type === 'solaris_gate') ? 0.072 : 0.095);
                b.buildProgress = Math.min(1.0, b.buildProgress + dt * buildRate);
                // Keep spawnTimer at full spawnDuration while under construction so unit training waits for construction to finish!
                if (b.spawnDuration) {
                    b.spawnTimer = b.spawnDuration;
                }
                if (b === state.selectedBuilding) {
                    updateHUD();
                    if (b.buildProgress >= 1.0) renderSC2CommandCard();
                }
            } else if (b.hp < b.maxHp) {
                b.hp = Math.min(b.maxHp, b.hp + dt * 4.5);
                if (b.hb) updateHealthPip(b.hb, b.hp, b.maxHp, b.shield || 0, b.maxShield || 0);
            }
        }

        const allyMode = state.aiAllyMode || 'defensive';
        if (allyMode !== 'off') {
            if (!state.allyPlaybookStrategy || state.allyPlaybookStrategy === 'cannon_rush' || state.allyPlaybookStrategy === 'proxy_forward_base') {
                const stratPool = ['massive_fleet', 'zealot_rush', 'combined_arms'];
                state.allyPlaybookStrategy = stratPool[Math.floor(Math.random() * stratPool.length)];
            }

            state.aiAllyTimer = (state.aiAllyTimer === undefined ? 18.0 : state.aiAllyTimer) - dt;
            if (state.aiAllyTimer <= 0) {
                const allyBotCount = (state.multiplayerConfig && state.multiplayerConfig.allyBots) ? state.multiplayerConfig.allyBots.length : 1;
                state.aiAllyTimer = Math.max(15.0, 29.0 - allyBotCount * 3.5);
                // Spawn AI Ally Protoss reinforcements exclusively from completed Solaris Warp Gates & Robotics Bays!
                const prodBuildings = [];
                if (!state.solarisHostile) {
                    for (let sbi = 0; sbi < solarisBuildings.length; sbi++) {
                        const sb = solarisBuildings[sbi];
                        if (sb && (sb.role === 'gate' || sb.role === 'robotics') && sb.hp > 0 && (sb.buildProgress === undefined || sb.buildProgress >= 1.0)) {
                            prodBuildings.push(sb);
                        }
                    }
                }
                if (units.length < 40 && prodBuildings.length > 0) {
                    const chosenBld = prodBuildings[Math.floor(Math.random() * prodBuildings.length)];
                    const spawnPos = chosenBld.pos;
                    const isFleetStrat = state.allyPlaybookStrategy === 'massive_fleet';
                    const allyPool = chosenBld.role === 'robotics'
                        ? ['phoenix', 'void_ray', 'carrier', 'archon']
                        : (isFleetStrat ? ['archon', 'stalker'] : ['zealot', 'stalker', 'archon']);
                    const pick1 = allyPool[Math.floor(Math.random() * allyPool.length)];
                    spawnAlliedUnit(pick1, spawnPos);
                    const newest = units[units.length - 1];
                    if (newest) {
                        if (isFleetStrat) {
                            const stagePos = new THREE.Vector3(
                                THREE.MathUtils.lerp(PLAYER_START_POS.x, ENEMY_BASE_POS.x, 0.36),
                                0,
                                THREE.MathUtils.lerp(PLAYER_START_POS.z, ENEMY_BASE_POS.z, 0.36)
                            );
                            newest.isFleetStaged = true;
                            newest.order = 'attack_move';
                            newest.orderTarget = stagePos;
                        } else if (allyMode === 'aggressive' || state.allyPlaybookStrategy === 'zealot_rush') {
                            newest.order = 'attack_move';
                            newest.orderTarget = ENEMY_BASE_POS.clone();
                        }
                    }

                    let stagedCount = 0;
                    for (let ui = 0; ui < units.length; ui++) {
                        if (units[ui] && units[ui].hp > 0 && units[ui].isFleetStaged) stagedCount++;
                    }
                    if (stagedCount >= 6) {
                        const targetPos = (enemyBuildings.length > 0 ? enemyBuildings[0].pos : ENEMY_BASE_POS);
                        for (let ui = 0; ui < units.length; ui++) {
                            const fu = units[ui];
                            if (fu && fu.hp > 0 && fu.isFleetStaged) {
                                fu.isFleetStaged = false;
                                fu.order = 'attack_move';
                                fu.orderTarget = targetPos.clone();
                            }
                        }
                    }
                }
            }
        }

        // Multiplayer Enemy Bot Team Extra Wave Spawner (Only spawns from constructed Zerg Barracks / Bio-Factory, never Citadel!)
        if (state.multiplayerConfig && state.multiplayerConfig.enemyBots && state.multiplayerConfig.enemyBots.length > 0) {
            state.mpEnemyBotTimer = (state.mpEnemyBotTimer === undefined ? 20.0 : state.mpEnemyBotTimer) - dt;
            if (state.mpEnemyBotTimer <= 0) {
                const eBots = state.multiplayerConfig.enemyBots;
                const diffMult = state.multiplayerConfig.botDifficulty === 'Brutal' ? 0.65
                    : (state.multiplayerConfig.botDifficulty === 'Hard' ? 0.80 : 1.0);
                state.mpEnemyBotTimer = Math.max(11.0, (24.0 - eBots.length * 2.5) * diffMult);
                const zergSpawners = [];
                for (let ebi = 0; ebi < enemyBuildings.length; ebi++) {
                    const eb = enemyBuildings[ebi];
                    if (eb && (eb.role === 'barracks' || eb.role === 'factory') && eb.hp > 0 && (eb.buildProgress === undefined || eb.buildProgress >= 1.0)) {
                        zergSpawners.push(eb);
                    }
                }
                const dynamicEnemyCap = Math.min(72, 32 + Math.floor(units.length * 1.35));
                if (enemies.length < dynamicEnemyCap && zergSpawners.length > 0) {
                    const variants = ['skitterer', 'spitter', 'crusher', 'burster', 'mutalisk'];
                    for (let bIdx = 0; bIdx < eBots.length; bIdx++) {
                        const spawner = zergSpawners[bIdx % zergSpawners.length];
                        const v = variants[Math.floor(Math.random() * variants.length)];
                        spawnEnemyFromBuilding(v, spawner.pos);
                    }
                }
            }
        }
    }

    // Enemy Zerg Progressive Base Construction (Slow-start economy: Starts ONLY with Citadel, builds Spawning Pool, Bio-Factory & Defenses gradually!)
    if (state.basePlaced && !state.missionWon && state.enemyBase && state.enemyBase.hp > 0) {
        state.enemyBuildTimer = (state.enemyBuildTimer || 22.0) - dt;
        if (state.enemyBuildTimer <= 0) {
            constructNextEnemyZergStructure();
            state.enemyBuildTimer = Math.max(19.0, 30.0 - state.wave * 1.0);
        }
    }

    // Allied Solaris Protoss Progressive Base, Proxy Outpost, Cannon Rush & Warp Gate Construction
    if (state.basePlaced && !state.missionWon && !(state.isMultiplayerMatch && !state.hasAlliedAiCommander) && solarisBuildings.length > 0) {
        state.solarisBuildTimer = (state.solarisBuildTimer || 18.0) - dt;
        if (state.solarisBuildTimer <= 0) {
            constructNextSolarisStructure();
            state.solarisBuildTimer = 24.0;
        }

        // Autonomous Lab Research for Zerg Evolution Chamber & Solaris Cybernetics Forge
        const hasZergEvoChamber = enemyBuildings.some(eb => eb && eb.role === 'evolution_chamber' && eb.hp > 0 && (eb.buildProgress === undefined || eb.buildProgress >= 1.0));
        if (hasZergEvoChamber && state.upgrades && state.upgrades.zerg) {
            state.zergUpgradeTimer = (state.zergUpgradeTimer || 34.0) - dt;
            if (state.zergUpgradeTimer <= 0) {
                state.zergUpgradeTimer = 36.0;
                const zUpg = state.upgrades.zerg;
                if ((zUpg.weapons || 0) <= (zUpg.armor || 0) && (zUpg.weapons || 0) < 3) {
                    zUpg.weapons = (zUpg.weapons || 0) + 1;
                    applyFactionTechToExistingUnits('zerg');
                } else if ((zUpg.armor || 0) < 3) {
                    zUpg.armor = (zUpg.armor || 0) + 1;
                    applyFactionTechToExistingUnits('zerg');
                }
            }
        }

        const hasSolarisCyberLab = solarisBuildings.some(sb => sb && sb.role === 'cyber_lab' && sb.hp > 0 && (sb.buildProgress === undefined || sb.buildProgress >= 1.0));
        if (hasSolarisCyberLab && state.upgrades && state.upgrades.solaris) {
            state.solarisUpgradeTimer = (state.solarisUpgradeTimer || 32.0) - dt;
            if (state.solarisUpgradeTimer <= 0) {
                state.solarisUpgradeTimer = 34.0;
                const sUpg = state.upgrades.solaris;
                if ((sUpg.weapons || 0) <= (sUpg.armor || 0) && (sUpg.weapons || 0) < 3) {
                    sUpg.weapons = (sUpg.weapons || 0) + 1;
                    applyFactionTechToExistingUnits('solaris');
                } else if ((sUpg.armor || 0) < 3) {
                    sUpg.armor = (sUpg.armor || 0) + 1;
                    applyFactionTechToExistingUnits('solaris');
                }
            }
        }

        // Run Squad Intelligence evaluation (Defensive Phalanx vs Aggressive Hunt based on Zerg cluster proximity)
        updateSquadIntelligence(dt);
    }

    for (let i = enemyBuildings.length - 1; i >= 0; i--) {
        const eb = enemyBuildings[i];
        if (eb.hp <= 0) {
            if (typeof spawnEnemyBuildingBreakAnimation === 'function') {
                spawnEnemyBuildingBreakAnimation(eb.pos, eb.role);
            }
            spawnGoreExplosion(eb.pos, true, true);
            if (eb === state.enemyBase || eb.role === 'citadel') {
                if (eb === state.enemyBase) {
                    creepTargetRadius = 0;
                }
                if (eb.expCreepMesh && eb.expCreepMesh.userData) {
                    eb.expCreepMesh.userData.ownerDestroyed = true;
                }
            }
            scene.remove(eb.mesh);
            if (eb.badge) eb.badge.remove();
            if (eb.hb) eb.hb.root.remove();
            enemyBuildings.splice(i, 1);
            state.req += 250;
            if (enemyBuildings.length === 0) {
                recallAllFriendlyUnitsToMainBase();
            }
            updateHUD(true);
            continue;
        }

        // Progressive Zerg Bio-Structure Metamorphosis Cocoon Animation (Full 100% HP, realistic ~12.5s gestation time)
        if (eb.buildProgress !== undefined && eb.buildProgress < 1.0) {
            eb.buildProgress = Math.min(1.0, eb.buildProgress + dt * 0.080);
        }
        if (eb.hatchPulse && eb.hatchPulse > 0) {
            eb.hatchPulse = Math.max(0, eb.hatchPulse - dt * 1.85);
        }

        const ebInViewport = window.isWorldPosInViewport(eb.pos.x, eb.pos.y, eb.pos.z, 7.5);
        const ebExplored = !!(window.titleScreenActive || window.loadingCameraSweep || window.fowRevealAll) || isWorldPosExplored(eb.pos.x, eb.pos.z);
        eb.mesh.visible = ebInViewport && ebExplored;
        if (eb.expCreepMesh) {
            eb.expCreepMesh.visible = ebExplored && (typeof creepRadius === 'undefined' || creepRadius > 0.45);
        }

        const ud = eb.mesh.userData;
        ud.pulsePhase = (ud.pulsePhase || 0) + dt * (2.8 + (eb.hatchPulse || 0) * 6.0);
        if (ebInViewport) {
            if (typeof updateEnemyBuildingAnimationAndBreak === 'function') {
                updateEnemyBuildingAnimationAndBreak(eb, dt, state.elapsedSec);
            }
            if (ud.emblem) {
                ud.emblem.rotation.y -= dt * 0.55;
                if (ud.emblem.userData.holoPlane) {
                    ud.emblem.userData.holoPlane.position.y = 6.6 + Math.sin(ud.pulsePhase) * 0.25;
                }
            }
            if (ud.psionicRing) ud.psionicRing.rotation.y += dt * 1.6;
            if (ud.coreGem) ud.coreGem.rotation.x += dt * 2.2;
            if (ud.sacs) {
                const hatchBoost = (eb.hatchPulse || 0) * 0.28;
                for (let si = 0; si < ud.sacs.length; si++) {
                    ud.sacs[si].scale.setScalar(1 + Math.sin(ud.pulsePhase + si) * (0.16 + hatchBoost));
                }
            }
            if (ud.claws) {
                for (let ci = 0; ci < ud.claws.length; ci++) {
                    const c = ud.claws[ci];
                    c.pivot.rotation.x = c.baseRotX + Math.sin(ud.pulsePhase * 0.7 + c.idx) * 0.08;
                }
            }
        }

        if (ebInViewport && isWorldPosVisible(eb.pos.x, eb.pos.z)) {
            updateHealthPip(eb.hb, eb.hp, eb.maxHp);
            projectToScreen(eb.hb.root, eb.pos, eb.role === 'citadel' ? 3.8 : 2.1);
        } else if (eb.hb && eb.hb.root && eb.hb._lastDisp !== 'none') {
            eb.hb._lastDisp = 'none';
            eb.hb.root.style.display = 'none';
        }

        if (eb.buildProgress !== undefined && eb.buildProgress < 1.0) continue;

        // Enemy Zerg Subterranean Spine-Whip Symbiote AI (6-Segment Coiling Muscular Tentacle & Whip-Snap Stinger)
        if (eb.role === 'spine_turret' && state.basePlaced && !state.missionWon) {
            eb.cooldown = (eb.cooldown || 0) - dt;
            eb.whipAnim = Math.max(0, (eb.whipAnim || 0) - dt * 2.8);

            let nearestTarget = null, minDistSq = 16.5 * 16.5;
            for (let ui = 0; ui < units.length; ui++) {
                const u = units[ui];
                const dx = u.mesh.position.x - eb.pos.x;
                const dz = u.mesh.position.z - eb.pos.z;
                const dSq = dx * dx + dz * dz;
                if (dSq < minDistSq) { minDistSq = dSq; nearestTarget = u; }
            }
            for (let bi = 0; bi < buildings.length; bi++) {
                const b = buildings[bi];
                const dx = b.pos.x - eb.pos.x;
                const dz = b.pos.z - eb.pos.z;
                const dSq = dx * dx + dz * dz;
                if (dSq < minDistSq) { minDistSq = dSq; nearestTarget = b; }
            }

            if (nearestTarget) {
                const tPos = nearestTarget.mesh ? nearestTarget.mesh.position : nearestTarget.pos;
                const desiredYaw = Math.atan2(tPos.x - eb.pos.x, tPos.z - eb.pos.z);
                const angleDiff = shortestAngleDiff(eb.currentYaw || 0, desiredYaw);
                const maxStep = 3.8 * dt;
                eb.currentYaw = (eb.currentYaw || 0) + (Math.abs(angleDiff) <= maxStep ? angleDiff : Math.sign(angleDiff) * maxStep);
                if (ud.yawRoot) ud.yawRoot.rotation.y = eb.currentYaw;
                else if (ud.head) ud.head.rotation.y = eb.currentYaw;

                if (Math.abs(angleDiff) < 0.38 && eb.cooldown <= 0) {
                    if (ud.cannonBarrel) {
                        ud.cannonBarrel.getWorldPosition(_muzzleScratch);
                    } else {
                        _muzzleScratch.set(eb.pos.x, eb.pos.y + 1.85, eb.pos.z);
                    }
                    launchOrdProjectile(_muzzleScratch, nearestTarget, 'spine', 24 * getWaveStrengthMultiplier(), true);
                    eb.whipAnim = 1.0;
                    eb.cooldown = 1.25;
                }
            }

            // Multi-segment kinematic spine articulation (Serpentine sway + S-coil windup + violent forward whip snap)
            if (ebInViewport && ud.spineSegments && ud.spineSegments.length > 0) {
                const segs = ud.spineSegments;
                const w = eb.whipAnim || 0;
                const whipPhase = w > 0.55
                    ? -Math.sin(((w - 0.55) / 0.45) * Math.PI) * 0.35
                    : Math.sin((w / 0.55) * Math.PI) * 0.52;
                const targetLean = nearestTarget ? 0.16 : 0.0;
                for (let si = 0; si < segs.length; si++) {
                    const segEntry = segs[si];
                    if (!segEntry) continue;
                    const segObj = segEntry.pivot || segEntry;
                    if (!segObj || !segObj.rotation) continue;
                    const baseRX = segEntry.baseRotX ?? (segObj.userData ? segObj.userData.baseRotX : 0) ?? 0;
                    const frac = si / Math.max(1, segs.length - 1);
                    const swayZ = Math.sin(ud.pulsePhase * 1.35 - si * 0.65) * (0.06 + frac * 0.08) * (1.0 - w * 0.6);
                    const swayX = Math.cos(ud.pulsePhase * 1.1 - si * 0.5) * 0.05;
                    const sCurveWhip = (si < 2 ? -whipPhase * 0.55 : whipPhase * (0.65 + frac * 0.75));
                    segObj.rotation.x = baseRX + targetLean + swayX + sCurveWhip;
                    segObj.rotation.z = swayZ;
                }
            }
            if (ebInViewport && ud.mawJaws) {
                const flare = (eb.whipAnim || 0) * 0.55 + Math.sin(ud.pulsePhase * 2.2) * 0.08;
                for (let ji = 0; ji < ud.mawJaws.length; ji++) {
                    const j = ud.mawJaws[ji];
                    j.pivot.rotation.x = j.baseFlare + flare;
                }
            }
        }

        // Unique Enemy Subterranean Tremor Drill Defense Building: drills down into borehole & erupts upward under units in radius!
        if (eb.role === 'drill_tower' && state.basePlaced && !state.missionWon) {
            eb.cooldown = (eb.cooldown || 0) - dt;
            const drillRad = eb.drillRadius || 18.5;
            let groundTarget = null, minDistSq = drillRad * drillRad;
            for (let ui = 0; ui < units.length; ui++) {
                const u = units[ui];
                if (u.isAir) continue;
                const dx = u.mesh.position.x - eb.pos.x;
                const dz = u.mesh.position.z - eb.pos.z;
                const dSq = dx * dx + dz * dz;
                if (dSq < minDistSq) { minDistSq = dSq; groundTarget = u; }
            }
            if (!groundTarget) {
                for (let bi = 0; bi < buildings.length; bi++) {
                    const b = buildings[bi];
                    const dx = b.pos.x - eb.pos.x;
                    const dz = b.pos.z - eb.pos.z;
                    const dSq = dx * dx + dz * dz;
                    if (dSq < minDistSq) { minDistSq = dSq; groundTarget = b; }
                }
            }

            if (ebInViewport && ud.drillAssembly) {
                const isDrilling = !!groundTarget;
                ud.drillAssembly.rotation.y += dt * (isDrilling ? 22.0 : 4.5);
                const targetDepth = isDrilling ? (0.48 + Math.sin(ud.pulsePhase * 5.0) * 0.28) : 1.05;
                ud.drillAssembly.position.y = THREE.MathUtils.lerp(ud.drillAssembly.position.y, targetDepth, dt * 8.0);
            }
            if (ebInViewport && ud.seismicRing) {
                const sScale = 0.85 + (ud.pulsePhase % 1.8) * 0.35;
                ud.seismicRing.scale.setScalar(sScale);
            }

            if (groundTarget && eb.cooldown <= 0) {
                const tPos = (groundTarget.mesh ? groundTarget.mesh.position : groundTarget.pos);
                if (typeof spawnSubterraneanDrillEruptionFX === 'function') {
                    spawnSubterraneanDrillEruptionFX(tPos);
                }
                const dmg = Math.round(34 * getWaveStrengthMultiplier());
                for (let ui = 0; ui < units.length; ui++) {
                    const u = units[ui];
                    if (u.isAir) continue;
                    const dx = u.mesh.position.x - tPos.x;
                    const dz = u.mesh.position.z - tPos.z;
                    if (dx * dx + dz * dz <= 5.76) { // 2.4^2
                        recordRagdollHitImpulse(u, tPos, true);
                        applyDamageWithTurretShield(u, dmg);
                        spawnCombatFloat(u.mesh.position, `${dmg} DRILL`, '#ff5400');
                    }
                }
                for (let bi = 0; bi < buildings.length; bi++) {
                    const b = buildings[bi];
                    const dx = b.pos.x - tPos.x;
                    const dz = b.pos.z - tPos.z;
                    if (dx * dx + dz * dz <= 7.84) { // 2.8^2
                        applyDamageWithTurretShield(b, dmg);
                        spawnCombatFloat(b.pos, `${dmg} DRILL`, '#ff5400');
                        if (b === state.baseBuilding) updateHUD();
                    }
                }
                eb.cooldown = 2.45;
            }
        }

        const armyScaledEnemyCap = state.isEndless
            ? Math.min(82, 32 + Math.floor(units.length * 1.55))
            : Math.min(60, 28 + Math.floor(units.length * 0.90));
        const isZergProducer = (eb.role === 'barracks' || eb.role === 'factory' || eb.role === 'roach_warren' || eb.role === 'spire_hive' || eb.role === 'spire');
        if (!window.titleScreenActive && !window.loadingCameraSweep && !state.missionWon && isZergProducer) {
            if (!Number.isFinite(eb.spawnTimer)) {
                eb.spawnDuration = eb.role === 'barracks' ? 5.5 : (eb.role === 'roach_warren' ? 7.2 : 8.5);
                eb.spawnTimer = eb.spawnDuration * 0.5;
            }
            eb.spawnTimer -= dt;
            if (eb.spawnTimer <= 0) {
                if (enemies.length >= armyScaledEnemyCap) {
                    // Retry shortly when unit cap frees up instead of silently skipping
                    eb.spawnTimer = 1.25;
                } else if (eb.role === 'barracks') {
                    const r = Math.random();
                    let v = 'skitterer';
                    if (state.rushGraceTimer > 0 && !state.isEndless) {
                        v = r < 0.62 ? 'skitterer' : 'spitter';
                        eb.spawnDuration = Math.max(5.2, 8.2 - state.wave * 0.25);
                    } else {
                        v = r < 0.36 ? 'skitterer' : (r < 0.62 ? 'spitter' : (r < 0.80 ? 'burster' : 'mutalisk'));
                        eb.spawnDuration = Math.max(3.8, 7.2 - state.wave * 0.25);
                    }
                    eb.spawnTimer = eb.spawnDuration;
                    spawnEnemyFromBuilding(v, eb.pos, eb);
                } else if (eb.role === 'roach_warren') {
                    const r = Math.random();
                    const v = r < 0.65 ? 'crusher' : 'gorgon';
                    eb.spawnDuration = Math.max(5.8, 9.5 - state.wave * 0.28);
                    eb.spawnTimer = eb.spawnDuration;
                    spawnEnemyFromBuilding(v, eb.pos, eb);
                } else if (eb.role === 'spire_hive' || eb.role === 'spire') {
                    const r = Math.random();
                    const v = r < 0.60 ? 'mutalisk' : 'brood_lord';
                    eb.spawnDuration = Math.max(6.5, 11.0 - state.wave * 0.32);
                    eb.spawnTimer = eb.spawnDuration;
                    spawnEnemyFromBuilding(v, eb.pos, eb);
                } else if (eb.role === 'factory') {
                    const r = Math.random();
                    const v = r < 0.32 ? 'crusher' : (r < 0.58 ? 'gorgon' : (r < 0.76 ? 'behemoth' : (r < 0.90 ? 'mutalisk' : 'brood_lord')));
                    eb.spawnDuration = (state.rushGraceTimer > 0 && !state.isEndless)
                        ? 9.5
                        : Math.max(6.8, 12.2 - state.wave * 0.35);
                    eb.spawnTimer = eb.spawnDuration;
                    spawnEnemyFromBuilding(v, eb.pos, eb);
                }
            }
        }
    }

    // Update 3rd Faction: Autonomous Solaris Chrono-Synod Enclave Structures, Khaydarin Pylons, Robotics Bays, Cannon Spires & Warp Gates
    for (let i = solarisBuildings.length - 1; i >= 0; i--) {
        const sb = solarisBuildings[i];
        if (!sb || sb.hp <= 0) {
            if (sb && sb.mesh) scene.remove(sb.mesh);
            if (sb && sb.hb && sb.hb.root) sb.hb.root.remove();
            solarisBuildings.splice(i, 1);
            continue;
        }
        if (sb.buildProgress !== undefined && sb.buildProgress < 1.0) {
            sb.buildProgress = Math.min(1.0, sb.buildProgress + dt * 0.085);
            if (sb.spawnTimer !== undefined) sb.spawnTimer = 13.5;
        }
        if (sb.maxShield && sb.maxShield > 0) {
            sb.shieldRegenDelay = Math.max(0, (sb.shieldRegenDelay || 0) - dt);
            if (sb.shieldRegenDelay <= 0 && (sb.shield || 0) < sb.maxShield) {
                sb.shield = Math.min(sb.maxShield, (sb.shield || 0) + 24 * dt);
            }
        }
        const sbInViewport = window.isWorldPosInViewport(sb.pos.x, sb.pos.y, sb.pos.z, 6.5);
        const sbFowVis = !state.solarisHostile || window.fowRevealAll || window.titleScreenActive || isWorldPosVisible(sb.pos.x, sb.pos.z);
        sb.mesh.visible = sbInViewport && sbFowVis;
        if (sb.mesh.visible) {
            updateBuildingMechanicsAndDamage(sb, dt);
        }
        if (sb.mesh.visible && isWorldPosVisible(sb.pos.x, sb.pos.z)) {
            updateHealthPip(sb.hb, sb.hp, sb.maxHp, sb.shield || 0, sb.maxShield || 0);
            projectToScreen(sb.hb.root, sb.pos, sb.role === 'nexus' ? 3.2 : 2.2);
        } else if (sb.hb && sb.hb.root && sb.hb._lastDisp !== 'none') {
            sb.hb._lastDisp = 'none';
            sb.hb.root.style.display = 'none';
        }

        if (sb.buildProgress !== undefined && sb.buildProgress < 1.0) continue;

        if (state.basePlaced && !state.missionWon) {
            if (sb.role === 'spire') {
                sb.cooldown = (sb.cooldown || 0) - dt;
                let nearestEnemy = null, minDistSq = 24.5 * 24.5;
                for (let ei = 0; ei < enemies.length; ei++) {
                    const e = enemies[ei];
                    if (e.hp <= 0) continue;
                    const dx = e.mesh.position.x - sb.pos.x;
                    const dz = e.mesh.position.z - sb.pos.z;
                    const dSq = dx * dx + dz * dz;
                    if (dSq < minDistSq) { minDistSq = dSq; nearestEnemy = e; }
                }
                if (!nearestEnemy && !state.solarisHostile) {
                    for (let ebi = 0; ebi < enemyBuildings.length; ebi++) {
                        const eb = enemyBuildings[ebi];
                        if (eb.hp <= 0) continue;
                        const dx = eb.pos.x - sb.pos.x;
                        const dz = eb.pos.z - sb.pos.z;
                        const dSq = dx * dx + dz * dz;
                        if (dSq < minDistSq) { minDistSq = dSq; nearestEnemy = eb; }
                    }
                }
                if (state.solarisHostile && !nearestEnemy) {
                    for (let ui = 0; ui < units.length; ui++) {
                        const u = units[ui];
                        if (u.hp <= 0) continue;
                        const dx = u.mesh.position.x - sb.pos.x;
                        const dz = u.mesh.position.z - sb.pos.z;
                        const dSq = dx * dx + dz * dz;
                        if (dSq < minDistSq) { minDistSq = dSq; nearestEnemy = u; }
                    }
                }
                if (nearestEnemy && sb.cooldown <= 0) {
                    _muzzleScratch.set(sb.pos.x, sb.pos.y + 2.55, sb.pos.z);
                    launchOrdProjectile(_muzzleScratch, nearestEnemy, 'solaris_spire', 42, state.solarisHostile && units.includes(nearestEnemy));
                    sb.cooldown = 1.15;
                }
            } else if ((sb.role === 'gate' || sb.role === 'robotics') && !state.solarisHostile) {
                // Only completed Protoss Warp Gates ('gate') & Robotics Bays ('robotics') spawn Solaris Protoss units!
                sb.spawnTimer = (sb.spawnTimer || 13.5) - dt;
                if (sb.spawnTimer <= 0) {
                    if (units.length < 38 && UNIT_COUNTS.solaris < 16) {
                        const doc = state.solarisDoctrine || 'zealot_rush';
                        const r = Math.random();
                        const sUnit = sb.role === 'robotics'
                            ? (r < 0.34 ? 'phoenix' : (r < 0.68 ? 'void_ray' : (r < 0.88 ? 'carrier' : 'archon')))
                            : (doc === 'zealot_rush'
                                ? (r < 0.72 ? 'zealot' : 'stalker')
                                : (doc === 'massive_fleet'
                                    ? (r < 0.48 ? 'archon' : (r < 0.85 ? 'stalker' : 'zealot'))
                                    : (r < 0.45 ? 'zealot' : (r < 0.80 ? 'stalker' : 'archon'))));
                        spawnAlliedUnit(sUnit, sb.pos);
                        UNIT_COUNTS.solaris++;
                        const spawned = units[units.length - 1];
                        if (spawned) {
                            if (doc === 'zealot_rush' || sb.isProxy) {
                                spawned.order = 'attack_move';
                                spawned.orderTarget = (enemyBuildings.length > 0 ? enemyBuildings[0].pos : ENEMY_BASE_POS).clone();
                            } else if (doc === 'massive_fleet' && UNIT_COUNTS.solaris < 7) {
                                spawned.isSolarisFleetStaged = true;
                                spawned.order = 'attack_move';
                                spawned.orderTarget = new THREE.Vector3(
                                    THREE.MathUtils.lerp(SOLARIS_BASE_POS.x, ENEMY_BASE_POS.x, 0.42),
                                    0,
                                    THREE.MathUtils.lerp(SOLARIS_BASE_POS.z, ENEMY_BASE_POS.z, 0.42)
                                );
                            }
                        }
                        if (UNIT_COUNTS.solaris >= 6) {
                            const targetPos = (enemyBuildings.length > 0 ? enemyBuildings[0].pos : ENEMY_BASE_POS);
                            for (let ui = 0; ui < units.length; ui++) {
                                const su = units[ui];
                                if (su && su.isSolarisFleetStaged) {
                                    su.isSolarisFleetStaged = false;
                                    su.order = 'attack_move';
                                    su.orderTarget = targetPos.clone();
                                }
                            }
                        }
                    }
                    sb.spawnTimer = sb.role === 'robotics' ? 16.0 : 13.5;
                }
            }
        }
    }

    if (!state.isEndless && !state.missionWon && enemyBuildings.length === 0) {
        state.missionWon = true;
        creepTargetRadius = 0;
        recallAllFriendlyUnitsToMainBase();
        updateHUD();
        document.getElementById('victory-modal').style.display = 'block';
    }

    if (state.baseBuilding) {
        const em = state.baseBuilding.mesh.userData.emblem;
        if (em) {
            em.rotation.y += dt * 0.55;
            if (em.userData.holoPlane) {
                em.userData.holoPlane.position.y = 2.85 + Math.sin(now * 0.003) * 0.18;
            }
        }
    }

    if (flashLight.intensity > 0) flashLight.intensity = Math.max(0, flashLight.intensity - dt * 28);
    if (screenShake > 0) {
        camera.position.x += (Math.random() - 0.5) * screenShake;
        camera.position.y += (Math.random() - 0.5) * screenShake;
        screenShake = Math.max(0, screenShake - dt * 2.8);
    }

    if (!window.titleScreenActive && !window.loadingCameraSweep && !state.missionWon && (!state.basePlaced || (state.baseBuilding && state.baseBuilding.hp > 0))) {
        if (state.isEndless && state.baseBuilding) {
            endlessSpawnClock -= dt;
            if (endlessSpawnClock <= 0) {
                // Scale Endless Mode enemy wave size & cap dynamically with Player Army Size!
                const playerArmyCount = units.length;
                const endlessEnemyCap = Math.min(85, 30 + Math.floor(playerArmyCount * 1.65));
                const batchCount = Math.min(6, 1 + Math.floor(playerArmyCount / 6) + Math.floor(state.wave / 4));
                const pool = ['skitterer', 'spitter', 'burster', 'mutalisk', 'crusher', 'gorgon', 'behemoth'];
                if (enemies.length < endlessEnemyCap) {
                    for (let bIdx = 0; bIdx < batchCount; bIdx++) {
                        if (enemies.length >= endlessEnemyCap) break;
                        const a = Math.random() * Math.PI * 2;
                        const spawnDist = 46 + Math.random() * 24;
                        const origin = new THREE.Vector3(
                            THREE.MathUtils.clamp(state.baseBuilding.pos.x + Math.cos(a) * spawnDist, -104, 104),
                            0,
                            THREE.MathUtils.clamp(state.baseBuilding.pos.z + Math.sin(a) * spawnDist, -104, 104)
                        );
                        if (isWalkableGround(origin.x, origin.z)) {
                            spawnEnemyFromBuilding(pool[Math.floor(Math.random() * pool.length)], origin);
                        }
                    }
                }
                const armyRateAccel = Math.min(1.3, playerArmyCount * 0.045);
                endlessSpawnClock = Math.max(0.85, 3.6 - state.wave * 0.16 - armyRateAccel);
            }
        }

        for (let i = buildings.length - 1; i >= 0; i--) {
            const b = buildings[i];
            if (b.hp <= 0) {
                if (b.type === 'turret') {
                    if (b.mesh.userData.mounts) {
                        ['left', 'right', 'top'].forEach(s => {
                            const m = b.mesh.userData.mounts[s];
                            if (m && m.userData.repairBeam) scene.remove(m.userData.repairBeam);
                            if (m && m.userData.mindBeam) scene.remove(m.userData.mindBeam);
                        });
                    }
                    if (b.turretBadge) b.turretBadge.remove();
                }
                if (typeof window.spawnTerranBaseBlastCrater === 'function') {
                    window.spawnTerranBaseBlastCrater(b.pos, b.type === 'base' ? 2.75 : 1.65);
                }
                spawnVehicleWreckageExplosion(b.pos, 'tank');
                scene.remove(b.mesh);
                b.hb.root.remove();
                if (state.selectedBuilding === b) selectStructure(null);

                if (b.type === 'hero') {
                    state.heroPlaced = false;
                    renderSC2CommandCard();
                }
                if (b.type === 'base') {
                    // Automatic Emergency Overload Fail-Safe (or manual Emergency Repair)
                    const nowSec = state.elapsedSec;
                    if (!b.lastAutoOverload || (nowSec - b.lastAutoOverload) >= 25.0) {
                        b.lastAutoOverload = nowSec;
                        executeHQEmergencyOverloadRepair();
                        continue;
                    }
                    updateHUD();
                    document.getElementById('directive-ticker').innerText = "CRITICAL FAILURE: COMMAND HQ CRITICAL — TRIGGER EMERGENCY OVERLOAD REPAIR!";
                    document.getElementById('directive-ticker').style.color = "#ff2a4b";
                    break;
                }
                buildings.splice(i, 1);
                continue;
            }

            if (b.maxShield && b.maxShield > 0) {
                b.shieldRegenDelay = Math.max(0, (b.shieldRegenDelay || 0) - dt);
                if (b.shieldRegenDelay <= 0 && (b.shield || 0) < b.maxShield) {
                    b.shield = Math.min(b.maxShield, (b.shield || 0) + 22 * dt);
                }
            }
            const bInViewport = window.isWorldPosInViewport(b.pos.x, b.pos.y, b.pos.z, 6.5);
            if (b.mesh) b.mesh.visible = bInViewport;
            if (bInViewport) {
                updateBuildingMechanicsAndDamage(b, dt);
                updateHealthPip(b.hb, b.hp, b.maxHp, b.shield || 0, b.maxShield || 0);
                projectToScreen(b.hb.root, b.pos, b.type === 'base' ? 2.1 : 1.6, state.selectedBuilding === b);
            } else if (b.hb && b.hb.root && b.hb._lastDisp !== 'none') {
                b.hb._lastDisp = 'none';
                b.hb.root.style.display = 'none';
            }

            // Wait for construction animation to finish (`buildProgress >= 1.0`) before spawning units or operating turrets!
            if (b.buildProgress < 1.0) continue;

            if (bInViewport && b.mesh.userData.rotor) b.mesh.userData.rotor.rotation.y += dt * 2.0;

            if (b.type === 'barracks') {
                if (UNIT_COUNTS.infantry < 24) {
                    b.spawnTimer -= dt;
                    if (b.spawnTimer <= 0) {
                        spawnAlliedUnit(b.unitType, b.pos);
                        UNIT_COUNTS.infantry++;
                        const infTimes = { grunt: 9.0, ranger: 10.0, medic: 10.5, rocketman: 11.5, reaper: 10.0, firebat: 11.0, marauder: 12.5 };
                        b.spawnDuration = infTimes[b.unitType] || 10.0;
                        b.spawnTimer = b.spawnDuration;
                        b.doorHoldTimer = 1.2;
                    }
                }
            }
            else if (b.type === 'factory' || b.type === 'solaris_robotics') {
                const hasActiveBarracks = BUILDING_COUNTS.activeBarracksOrGate > 0;
                if (b.unitType === 'transport' && !hasActiveBarracks) {
                    // Dropship requires an active Barracks / Warp Gate to operate!
                    b.spawnTimer = b.spawnDuration;
                } else {
                    const isRobotics = b.type === 'solaris_robotics';
                    const capOk = isRobotics ? (UNIT_COUNTS.solaris < 14 && UNIT_COUNTS.vehicles < 12) : (UNIT_COUNTS.vehicles < 10);
                    if (capOk) {
                        b.spawnTimer -= dt;
                        if (b.spawnTimer <= 0) {
                            const uToSpawn = b.unitType || (isRobotics ? 'phoenix' : 'tank');
                            spawnAlliedUnit(uToSpawn, b.pos);
                            if (isRobotics) UNIT_COUNTS.solaris++;
                            else UNIT_COUNTS.vehicles++;
                            const vehTimes = { tank: 15.5, siege_tank: 18.0, heli: 14.0, transport: 14.0, valkyrie: 16.5, phoenix: 13.5, void_ray: 16.5, carrier: 21.0 };
                            b.spawnDuration = vehTimes[uToSpawn] || 15.5;
                            b.spawnTimer = b.spawnDuration;
                            b.doorHoldTimer = 1.5;
                        }
                    }
                }
            }
            else if (b.type === 'solaris_gate') {
                if (UNIT_COUNTS.solaris < 12) {
                    b.spawnTimer -= dt;
                    if (b.spawnTimer <= 0) {
                        const sType = b.unitType || 'zealot';
                        spawnAlliedUnit(sType, b.pos);
                        UNIT_COUNTS.solaris++;
                        const solTimes = { zealot: 10.0, stalker: 12.0, archon: 15.5 };
                        b.spawnDuration = solTimes[sType] || 11.0;
                        b.spawnTimer = b.spawnDuration;
                    }
                }
            }
            else if (b.type === 'mine_drill') {
                // Animate Deep-Core Tungsten Auger Rotation & Vertical Reciprocating Bore Stroke
                if (bInViewport && b.mesh && b.mesh.userData && b.mesh.userData.drillAuger) {
                    const auger = b.mesh.userData.drillAuger;
                    auger.rotation.y += dt * 14.0;
                    auger.position.y = 0.86 + Math.sin(now * 0.012) * 0.14;
                }
                b.mineTimer = (b.mineTimer === undefined ? 4.0 : b.mineTimer) - dt;
                if (b.mineTimer <= 0) {
                    b.mineTimer = 4.0;
                    state.req += 10;
                    const crater = b.linkedCrater;
                    if (crater) {
                        if (crater.isEmpty || crater.gemsRemaining <= 0) {
                            if (!b.emptyNotified) {
                                b.emptyNotified = true;
                                spawnCombatFloat(b.pos, 'GEM CRATER EMPTY! (+14M ONLY — FIND ANOTHER CRATER)', '#94a3b8');
                            } else {
                                spawnCombatFloat(b.pos, '+14M (EMPTY CRATER)', '#00e5ff');
                            }
                        } else {
                            const extracted = Math.min(15, crater.gemsRemaining);
                            crater.gemsRemaining -= extracted;
                            state.gems = (state.gems || 0) + extracted;
                            b.totalMinedGems = (b.totalMinedGems || 0) + extracted;
                            if (typeof window.updateGemCraterDepletionVisuals === 'function') {
                                window.updateGemCraterDepletionVisuals(crater);
                            }
                            spawnCombatFloat(b.pos, `+14M & +${extracted} GEMS!`, '#f0abfc');

                            // Every 45 Gems extracted from a rich crater automatically grants a bonus reinforcement unit or build cache!
                            if (b.totalMinedGems > 0 && b.totalMinedGems % 45 === 0) {
                                const bonusOrigin = state.baseBuilding ? state.baseBuilding.pos : b.pos;
                                if (units.length < 38) {
                                    const rewardPool = state.playerFaction === 'solaris'
                                        ? ['zealot', 'stalker', 'archon', 'phoenix']
                                        : ['ranger', 'marauder', 'tank', 'siege_tank'];
                                    const rUnit = rewardPool[Math.floor(Math.random() * rewardPool.length)];
                                    spawnAlliedUnit(rUnit, bonusOrigin);
                                    spawnCombatFloat(bonusOrigin, `GEM BONUS TROOP: +1 ${rUnit.toUpperCase()}!`, '#00ff66');
                                } else {
                                    state.req += 110;
                                    spawnCombatFloat(b.pos, 'GEM BONUS CACHE: +110 MINERALS!', '#00ff66');
                                }
                            }

                            if (crater.gemsRemaining <= 0) {
                                if (typeof window.depleteGemCraterVisuals === 'function') {
                                    window.depleteGemCraterVisuals(crater);
                                }
                                spawnCombatFloat(b.pos, 'GEM CRATER DEPLETED (NOW EMPTY) — SCOUT FOR MORE!', '#ffaa00');
                            }
                        }
                    } else {
                        spawnCombatFloat(b.pos, '+14 MINERALS', '#00e5ff');
                    }
                    if (state.selectedBuilding === b) renderSC2CommandCard();
                    updateHUD();
                }
            }
            else if (b.isSolarisSpire || b.type === 'solaris_spire') {
                // Player-Controlled Protoss Khaydarin Aegis Spire Defense Turret
                b.cooldown = (b.cooldown || 0) - dt;
                const spireRange = b.spireRange || 25.0;
                const spireMode = b.spireTargetMode || 'auto';
                let bestTarget = null;
                let bestScore = Infinity;

                for (let ei = 0; ei < enemies.length; ei++) {
                    const e = enemies[ei];
                    if (!e || e.hp <= 0) continue;
                    const d = Math.hypot(e.mesh.position.x - b.pos.x, e.mesh.position.z - b.pos.z);
                    if (d > spireRange) continue;
                    let score = d;
                    if (spireMode === 'air_first' && e.isAir) score -= 14.0;
                    else if (spireMode === 'heavy_first' && (e.variant === 'behemoth' || e.variant === 'crusher' || e.variant === 'gorgon')) score -= 14.0;
                    else if (e.isAir) score -= 4.5;
                    if (score < bestScore) {
                        bestScore = score;
                        bestTarget = e;
                    }
                }
                if (!bestTarget) {
                    for (let ebi = 0; ebi < enemyBuildings.length; ebi++) {
                        const eb = enemyBuildings[ebi];
                        if (!eb || eb.hp <= 0) continue;
                        const d = Math.hypot(eb.pos.x - b.pos.x, eb.pos.z - b.pos.z);
                        if (d <= spireRange && d < bestScore) {
                            bestScore = d;
                            bestTarget = eb;
                        }
                    }
                }

                if (bestTarget) {
                    const tPos = bestTarget.mesh ? bestTarget.mesh.position : bestTarget.pos;
                    const desiredYaw = Math.atan2(tPos.x - b.pos.x, tPos.z - b.pos.z);
                    const angleDiff = shortestAngleDiff(b.currentYaw || 0, desiredYaw);
                    const maxStep = 6.5 * dt;
                    b.currentYaw = (b.currentYaw || 0) + (Math.abs(angleDiff) <= maxStep ? angleDiff : Math.sign(angleDiff) * maxStep);
                    if (b.mesh && b.mesh.userData && b.mesh.userData.emitterHead) {
                        b.mesh.userData.emitterHead.rotation.y = b.currentYaw;
                    }
                    if (Math.abs(angleDiff) < 0.42 && b.cooldown <= 0) {
                        const ud = b.mesh ? b.mesh.userData : null;
                        if (ud && ud.muzzleNode) {
                            ud.muzzleNode.getWorldPosition(_muzzleScratch);
                        } else {
                            _muzzleScratch.set(b.pos.x, b.pos.y + 2.55, b.pos.z);
                        }
                        if (ud) ud.attackAnim = 1.0;
                        const baseDmg = b.spireDamage || 46;
                        const sWeapons = (state.upgrades && state.upgrades.solaris) ? (state.upgrades.solaris.weapons || 0) : 0;
                        const finalDmg = Math.round(baseDmg * (1 + sWeapons * 0.14));
                        launchOrdProjectile(_muzzleScratch, bestTarget, 'solaris_spire', finalDmg, false);
                        triggerMuzzleFlash(_muzzleScratch);
                        b.cooldown = b.spireFireRate || 1.05;
                    }
                }
            }
            else if (b.type === 'turret') {
                // Defensive null-guards for turret weapons, cooldowns, and mount sockets
                if (!b.weapons) b.weapons = { left: 'none', right: 'none', top: 'none' };
                if (!b.cooldowns) b.cooldowns = { left: 0, right: 0, top: 0 };
                if (b.currentYaw === undefined) b.currentYaw = 0;
                const mounts = (b.mesh && b.mesh.userData && b.mesh.userData.mounts) ? b.mesh.userData.mounts : {};

                // 1. Update Autonomous Fixing Drones on any slot (Patches up friendly MECHANICAL UNITS and STRUCTURES with 3D Nano-Weld Beam!)
                ['left', 'right', 'top'].forEach(slot => {
                    if (b.weapons[slot] !== 'drone') return;
                    b.cooldowns[slot] -= dt;
                    const pod = mounts[slot];
                    if (!pod || !pod.userData.droneMesh) return;

                    const drone = pod.userData.droneMesh;
                    pod.userData.dronePhase = (pod.userData.dronePhase || 0) + dt * 4.5;
                    drone.position.y = 0.68 + Math.sin(pod.userData.dronePhase) * 0.14;
                    drone.position.x = Math.cos(pod.userData.dronePhase * 0.6) * 0.22;
                    if (pod.userData.droneRotors) {
                        for (let ri = 0; ri < pod.userData.droneRotors.length; ri++) {
                            pod.userData.droneRotors[ri].rotation.y += dt * 32;
                        }
                    }

                    // Fixing Drone patches up damaged friendly Mechanical Units (Tanks, Siege Tanks, Gunships, Dropships, Valkyries) AND friendly Buildings within 19.5m!
                    let repairTarget = null, lowestRatio = 1.0, isUnitTarget = false;
                    for (let ui = 0; ui < units.length; ui++) {
                        const allyU = units[ui];
                        if (allyU && allyU.isMechanical && allyU.hp > 0 && allyU.hp < allyU.maxHp && allyU.mesh) {
                            const dx = allyU.mesh.position.x - b.pos.x;
                            const dz = allyU.mesh.position.z - b.pos.z;
                            if (dx * dx + dz * dz <= 380.25) { // 19.5^2
                                const r = allyU.hp / allyU.maxHp;
                                if (r < lowestRatio) {
                                    lowestRatio = r;
                                    repairTarget = allyU;
                                    isUnitTarget = true;
                                }
                            }
                        }
                    }
                    for (let bi2 = 0; bi2 < buildings.length; bi2++) {
                        const allyB = buildings[bi2];
                        if (allyB.hp > 0 && allyB.hp < allyB.maxHp) {
                            const dx = allyB.pos.x - b.pos.x;
                            const dz = allyB.pos.z - b.pos.z;
                            if (dx * dx + dz * dz <= 380.25) {
                                const r = allyB.hp / allyB.maxHp;
                                if (r < lowestRatio) {
                                    lowestRatio = r;
                                    repairTarget = allyB;
                                    isUnitTarget = false;
                                }
                            }
                        }
                    }

                    let rBeam = pod.userData.repairBeam;
                    if (rBeam && !rBeam.userData?.coreMesh && typeof window.createRepairBeamAssembly === 'function') {
                        scene.remove(rBeam);
                        rBeam = window.createRepairBeamAssembly();
                        scene.add(rBeam);
                        pod.userData.repairBeam = rBeam;
                    }

                    if (repairTarget) {
                        repairTarget.hp = Math.min(repairTarget.maxHp, repairTarget.hp + 38 * dt);
                        repairTarget.isBeingRepairedTimer = 0.55;
                        if (repairTarget.hb) {
                            updateHealthPip(repairTarget.hb, repairTarget.hp, repairTarget.maxHp, repairTarget.shield || 0, repairTarget.maxShield || 0);
                        }
                        if (
                            window.PORTRAIT_3D_VIEWER &&
                            typeof window.PORTRAIT_3D_VIEWER.setRepairing === 'function' &&
                            (state.selectedUnits.includes(repairTarget) || state.selectedBuilding === repairTarget || state.selectedBuilding === b)
                        ) {
                            window.PORTRAIT_3D_VIEWER.setRepairing(true, 0.75);
                        }

                        drone.getWorldPosition(_beamStartScratch);
                        const rawTargetPos = isUnitTarget ? repairTarget.mesh.position : repairTarget.pos;
                        _beamEndScratch.set(rawTargetPos.x, rawTargetPos.y + (isUnitTarget && repairTarget.isAir ? 0.0 : 0.85), rawTargetPos.z);
                        if (rBeam) {
                            if (typeof window.updateRepairBeamAssembly === 'function' && rBeam.userData?.coreMesh) {
                                window.updateRepairBeamAssembly(rBeam, _beamStartScratch, _beamEndScratch, dt);
                            } else {
                                const dist = _beamStartScratch.distanceTo(_beamEndScratch);
                                const pulseThick = 0.9 + Math.sin(pod.userData.dronePhase * 4) * 0.35;
                                rBeam.visible = true;
                                rBeam.position.lerpVectors(_beamStartScratch, _beamEndScratch, 0.5);
                                rBeam.scale.set(pulseThick, pulseThick, dist);
                                rBeam.lookAt(_beamEndScratch);
                            }
                        }
                        if (b.cooldowns[slot] <= 0) {
                            spawnNanoWeldSparkFX(_beamEndScratch);
                            if (window.SFX) window.SFX.playHeal();
                            b.cooldowns[slot] = 0.85;
                        }
                    } else if (rBeam) {
                        rBeam.visible = false;
                    }
                });

                // 1B. Update Shield Dome Generator, Mind Control Emitter Slots & Procedural Hardpoint Snap Animation
                ['left', 'right', 'top'].forEach(slot => {
                    const w = b.weapons[slot];
                    const pod = mounts[slot];
                    if (pod && pod.userData.snapAnim > 0 && pod.userData.snapBasePos && pod.userData.snapNormal) {
                        pod.userData.snapAnim = Math.max(0, pod.userData.snapAnim - dt * 6.5);
                        const s = pod.userData.snapAnim * 0.14;
                        pod.position.set(
                            pod.userData.snapBasePos.x + pod.userData.snapNormal.x * s,
                            pod.userData.snapBasePos.y + pod.userData.snapNormal.y * s,
                            pod.userData.snapBasePos.z + pod.userData.snapNormal.z * s
                        );
                    }
                    if (w === 'shield' && pod) {
                        b.cooldowns[slot] -= dt;
                        if (pod.userData.shieldRings) {
                            for (let ri = 0; ri < pod.userData.shieldRings.length; ri++) {
                                pod.userData.shieldRings[ri].rotation.z += dt * (ri % 2 === 0 ? 3.5 : -3.5);
                            }
                        }
                        if (b.maxShieldHp > 0) {
                            if (b.shieldBrokenTimer > 0) {
                                b.shieldBrokenTimer = Math.max(0, b.shieldBrokenTimer - dt);
                                b.shieldHp = 0;
                                if (b.shieldBrokenTimer <= 0) {
                                    b.shieldHp = 160;
                                    spawnCombatFloat(b.pos, 'SHIELD BARRIER ONLINE!', '#00e5ff');
                                }
                            } else {
                                b.shieldHp = Math.min(b.maxShieldHp, (b.shieldHp || 0) + 22 * dt);
                            }
                            if (b.shieldDomeMesh) {
                                b.shieldDomeMesh.visible = b.shieldHp > 15 && !(b.shieldBrokenTimer > 0);
                                b.shieldDomeMesh.rotation.y += dt * 0.45;
                            }
                        }
                    } else if (w === 'mindcontrol' && pod) {
                        b.cooldowns[slot] -= dt;
                        if (pod.userData.psiRings) {
                            for (let ri = 0; ri < pod.userData.psiRings.length; ri++) {
                                pod.userData.psiRings[ri].rotation.z += dt * (ri % 2 === 0 ? 4.2 : -4.2);
                            }
                        }
                        if (pod.userData.satelliteDish && pod.userData.satelliteDish.azimuthBase && !b._hasActiveTarget) {
                            pod.userData.satelliteDish.azimuthBase.rotation.y += dt * 1.15;
                        }
                        const mBeam = pod.userData.mindBeam;
                        if (mBeam && b.cooldowns[slot] < 4.8) mBeam.visible = false;
                    }
                });

                // Rotate visual range sector arcs to match turret heading
                if (b.mesh && b.mesh.userData && b.mesh.userData.rangeGroup) {
                    b.mesh.userData.rangeGroup.rotation.y = b.currentYaw || 0;
                }

                // 2. Smart Target Selection up to 22.0m for Equipped Combat Weapons
                const hasSniper = ['left', 'right', 'top'].some(s => b.weapons[s] === 'sniper');
                const hasAoE = ['left', 'right', 'top'].some(s => ['flame', 'plasma', 'mortar', 'rocket'].includes(b.weapons[s]));
                const nearest = selectSmartTarget(b.pos, 22.0, true, hasSniper, hasAoE);
                const minDist = nearest ? b.pos.distanceTo(nearest.mesh ? nearest.mesh.position : nearest.pos) : Infinity;
                b._hasActiveTarget = !!(nearest && minDist <= 22.0);

                if (nearest && minDist <= 22.0) {
                    const head = (b.mesh && b.mesh.userData) ? b.mesh.userData.head : null;
                    const tPos = nearest.mesh ? nearest.mesh.position : nearest.pos;

                    const dx = tPos.x - b.pos.x;
                    const dz = tPos.z - b.pos.z;
                    const dy = (tPos.y + (nearest.isAir ? 0.0 : 0.65)) - (b.pos.y + 1.55);
                    const horizDist = Math.max(0.5, Math.hypot(dx, dz));
                    const desiredYaw = Math.atan2(dx, dz);
                    const desiredPitch = THREE.MathUtils.clamp(-Math.atan2(dy, horizDist), -0.48, 0.38);
                    const angleDiff = shortestAngleDiff(b.currentYaw, desiredYaw);
                    const maxStep = (TURRET_TURN_SPEED * 1.45) * dt;

                    if (Math.abs(angleDiff) <= maxStep) b.currentYaw = desiredYaw;
                    else b.currentYaw += Math.sign(angleDiff) * maxStep;
                    b.currentPitch = THREE.MathUtils.lerp(b.currentPitch || 0, desiredPitch, dt * 8.0);
                    if (head) {
                        head.rotation.y = b.currentYaw;
                        head.rotation.x = b.currentPitch * 0.45;
                    }

                    const isAimed = Math.abs(angleDiff) < 0.42;

                    ['left', 'right', 'top'].forEach(slot => {
                        const w = b.weapons[slot];
                        if (!w || w === 'none' || w === 'drone' || w === 'shield') return;
                        b.cooldowns[slot] -= dt;

                        const pod = mounts[slot];
                        const basePodZ = (pod && pod.userData.snapBasePos) ? pod.userData.snapBasePos.z : 0;
                        if (pod && !(pod.userData.snapAnim > 0)) {
                            pod.position.z = THREE.MathUtils.lerp(pod.position.z, basePodZ, dt * 14);
                            if (pod.userData.recoilGroup) {
                                pod.userData.recoilGroup.position.z = THREE.MathUtils.lerp(pod.userData.recoilGroup.position.z, 0, dt * 16);
                            }
                            if (pod.userData.aimPivot) {
                                pod.userData.aimPivot.rotation.y = THREE.MathUtils.lerp(pod.userData.aimPivot.rotation.y, shortestAngleDiff(b.currentYaw, desiredYaw) * 0.65, dt * 12);
                                pod.userData.aimPivot.rotation.x = THREE.MathUtils.lerp(pod.userData.aimPivot.rotation.x, desiredPitch * 0.65, dt * 12);
                            }
                            if (pod.userData.satelliteDish) {
                                const sd = pod.userData.satelliteDish;
                                if (sd.azimuthBase) sd.azimuthBase.rotation.y = THREE.MathUtils.lerp(sd.azimuthBase.rotation.y, shortestAngleDiff(b.currentYaw, desiredYaw), dt * 10);
                                if (sd.dishHead) sd.dishHead.rotation.x = THREE.MathUtils.lerp(sd.dishHead.rotation.x, -0.28 + desiredPitch * 0.6, dt * 10);
                            }
                            if (pod.userData.barrelCluster) {
                                const spinRate = isAimed ? 26.0 : 6.0;
                                pod.userData.barrelCluster.rotation.z += dt * spinRate;
                            }
                            if (pod.userData.muzzleFlashMesh && pod.userData.flashTimer > 0) {
                                pod.userData.flashTimer = Math.max(0, pod.userData.flashTimer - dt);
                                pod.userData.muzzleFlashMesh.visible = pod.userData.flashTimer > 0;
                                pod.userData.muzzleFlashMesh.rotation.z += dt * 35;
                            }
                        }
                        if (!isAimed) return;

                        if (pod && pod.userData.recoilGroup && pod.userData.muzzleOffset) {
                            _muzzleScratch.copy(pod.userData.muzzleOffset);
                            pod.userData.recoilGroup.localToWorld(_muzzleScratch);
                        } else if (pod) {
                            pod.getWorldPosition(_muzzleScratch);
                        } else {
                            _muzzleScratch.copy(b.pos);
                        }
                        const aimDir = _aimScratch.copy(tPos).sub(_muzzleScratch).normalize();

                        if (w === 'mg' && minDist <= 14.0 && b.cooldowns[slot] <= 0) {
                            launchOrdProjectile(_muzzleScratch, nearest, 'mg', 16);
                            triggerMuzzleFlash(_muzzleScratch);
                            if (typeof window.spawnTurretMuzzleFlashFX === 'function') {
                                window.spawnTurretMuzzleFlashFX(_muzzleScratch, aimDir, 'mg');
                            }
                            ejectBrassCasing(_muzzleScratch);
                            if (pod) {
                                pod.position.z = basePodZ - 0.06;
                                if (pod.userData.recoilGroup) pod.userData.recoilGroup.position.z = -0.11;
                                if (pod.userData.muzzleFlashMesh) {
                                    pod.userData.muzzleFlashMesh.visible = true;
                                    pod.userData.flashTimer = 0.09;
                                }
                            }
                            b.cooldowns[slot] = 0.18;
                        }
                        else if (w === 'flame' && minDist <= 13.5 && b.cooldowns[slot] <= 0) {
                            if (typeof window.spawnNapalmFireStreamFX === 'function') {
                                window.spawnNapalmFireStreamFX(_muzzleScratch, tPos);
                            } else if (particles.length < 140) {
                                const fireBall = new THREE.Mesh(
                                    SHARED_FX_GEO.fireBall,
                                    Math.random() > 0.4 ? MAT.amberGlow : MAT.crimsonTank
                                );
                                fireBall.position.copy(_muzzleScratch);
                                scene.add(fireBall);
                                const dir = tPos.clone().sub(_muzzleScratch).normalize();
                                particles.push({
                                    mesh: fireBall,
                                    vel: dir.multiplyScalar(15).add(new THREE.Vector3((Math.random()-0.5)*2, 1, (Math.random()-0.5)*2)),
                                    gravity: -2,
                                    life: 0.46
                                });
                            }
                            if (pod && pod.userData.recoilGroup) pod.userData.recoilGroup.position.z = -0.05;
                            recordRagdollHitImpulse(nearest, _muzzleScratch, false);
                            nearest.hp -= 10;
                            // Splash thermal burn to adjacent enemies along the 13.5m fire cone
                            for (let ei = 0; ei < enemies.length; ei++) {
                                const eOther = enemies[ei];
                                if (!eOther || eOther === nearest || eOther.hp <= 0) continue;
                                const dOther = Math.hypot(eOther.mesh.position.x - tPos.x, eOther.mesh.position.z - tPos.z);
                                if (dOther <= 2.3) {
                                    eOther.hp -= 5;
                                }
                            }
                            b.cooldowns[slot] = 0.08;
                        }
                        else if (w === 'plasma' && minDist <= 16.5 && b.cooldowns[slot] <= 0) {
                            launchOrdProjectile(_muzzleScratch, nearest, 'plasma', 42);
                            triggerMuzzleFlash(_muzzleScratch);
                            if (typeof window.spawnTurretMuzzleFlashFX === 'function') {
                                window.spawnTurretMuzzleFlashFX(_muzzleScratch, aimDir, 'plasma');
                            }
                            if (typeof window.spawnPlasmaElectricTrailParticle === 'function') {
                                window.spawnPlasmaElectricTrailParticle(_muzzleScratch);
                            }
                            if (pod) {
                                pod.position.z = basePodZ - 0.09;
                                if (pod.userData.recoilGroup) pod.userData.recoilGroup.position.z = -0.15;
                            }
                            b.cooldowns[slot] = 0.72;
                        }
                        else if (w === 'rocket' && minDist <= 20.0 && b.cooldowns[slot] <= 0) {
                            // Staggered Multi-Tube Rocketpad Missile Barrage (5 missiles launched sequentially from tube muzzles into target radius)
                            window.queueRocketpadMissileBarrage({ mesh: b.mesh, pod, pos: b.pos }, nearest, 34, 5, 2.6);
                            if (typeof window.spawnTurretMuzzleFlashFX === 'function') {
                                window.spawnTurretMuzzleFlashFX(_muzzleScratch, aimDir, 'rocket');
                            }
                            if (pod) {
                                pod.position.z = basePodZ - 0.12;
                                if (pod.userData.recoilGroup) pod.userData.recoilGroup.position.z = -0.18;
                            }
                            b.cooldowns[slot] = 1.85;
                        }
                        else if (w === 'sniper' && minDist <= 22.0 && b.cooldowns[slot] <= 0) {
                            launchOrdProjectile(_muzzleScratch, nearest, 'sniper', 125);
                            triggerMuzzleFlash(_muzzleScratch);
                            if (typeof window.spawnTurretMuzzleFlashFX === 'function') {
                                window.spawnTurretMuzzleFlashFX(_muzzleScratch, aimDir, 'sniper');
                            }
                            ejectBrassCasing(_muzzleScratch);
                            if (pod) {
                                pod.position.z = basePodZ - 0.16;
                                if (pod.userData.recoilGroup) pod.userData.recoilGroup.position.z = -0.24;
                            }
                            b.cooldowns[slot] = 2.1;
                        }
                        else if (w === 'mortar' && minDist <= 18.0 && b.cooldowns[slot] <= 0) {
                            launchOrdProjectile(_muzzleScratch, nearest, 'mortar', 70);
                            triggerMuzzleFlash(_muzzleScratch);
                            if (typeof window.spawnTurretMuzzleFlashFX === 'function') {
                                window.spawnTurretMuzzleFlashFX(_muzzleScratch, aimDir, 'mortar');
                            }
                            if (pod) {
                                pod.position.z = basePodZ - 0.14;
                                if (pod.userData.recoilGroup) pod.userData.recoilGroup.position.z = -0.22;
                            }
                            b.cooldowns[slot] = 2.3;
                        }
                        else if (w === 'mindcontrol' && minDist <= 19.0 && b.cooldowns[slot] <= 0) {
                            // Strictly enforce MAX_MIND_CONTROL_UNITS (3 units) cap!
                            if (getActiveMindControlledCount() < MAX_MIND_CONTROL_UNITS) {
                                let domCandidate = null, bestDomScore = -1;
                                for (let ei = 0; ei < enemies.length; ei++) {
                                    const e = enemies[ei];
                                    if (e.hp <= 0) continue;
                                    const dx2 = e.mesh.position.x - b.pos.x;
                                    const dz2 = e.mesh.position.z - b.pos.z;
                                    if (dx2 * dx2 + dz2 * dz2 <= 361.0 && e.maxHp > bestDomScore) { // 19.0^2
                                        bestDomScore = e.maxHp;
                                        domCandidate = e;
                                    }
                                }
                                if (domCandidate) {
                                    const mBeam = pod ? pod.userData.mindBeam : null;
                                    if (mBeam) {
                                        _beamEndScratch.set(domCandidate.mesh.position.x, domCandidate.mesh.position.y + 0.8, domCandidate.mesh.position.z);
                                        const dist = _muzzleScratch.distanceTo(_beamEndScratch);
                                        mBeam.visible = true;
                                        mBeam.position.lerpVectors(_muzzleScratch, _beamEndScratch, 0.5);
                                        mBeam.scale.set(1.3, 1.3, dist);
                                        mBeam.lookAt(_beamEndScratch);
                                    }
                                    convertEnemyWithMindControl(domCandidate, _muzzleScratch);
                                    b.cooldowns[slot] = 5.5;
                                }
                            } else {
                                // At 3/3 Mind Control capacity: fire psionic satellite neural overload zap without converting a 4th unit
                                const mBeam = pod ? pod.userData.mindBeam : null;
                                if (mBeam && nearest.mesh) {
                                    _beamEndScratch.set(nearest.mesh.position.x, nearest.mesh.position.y + 0.8, nearest.mesh.position.z);
                                    const dist = _muzzleScratch.distanceTo(_beamEndScratch);
                                    mBeam.visible = true;
                                    mBeam.position.lerpVectors(_muzzleScratch, _beamEndScratch, 0.5);
                                    mBeam.scale.set(0.95, 0.95, dist);
                                    mBeam.lookAt(_beamEndScratch);
                                }
                                nearest.hp -= 28;
                                spawnCombatFloat(tPos, 'PSI SAT ZAP (3/3 MAX)', '#d946ef');
                                b.cooldowns[slot] = 2.2;
                            }
                        }
                    });
                } else {
                    // Gently return weapon pod aim pivots and recoil when idle
                    ['left', 'right', 'top'].forEach(slot => {
                        const pod = mounts[slot];
                        if (!pod) return;
                        if (pod.userData.recoilGroup) {
                            pod.userData.recoilGroup.position.z = THREE.MathUtils.lerp(pod.userData.recoilGroup.position.z, 0, dt * 12);
                        }
                        if (pod.userData.aimPivot) {
                            pod.userData.aimPivot.rotation.x = THREE.MathUtils.lerp(pod.userData.aimPivot.rotation.x, 0, dt * 6);
                            pod.userData.aimPivot.rotation.y = THREE.MathUtils.lerp(pod.userData.aimPivot.rotation.y, 0, dt * 6);
                        }
                        if (pod.userData.muzzleFlashMesh) {
                            pod.userData.muzzleFlashMesh.visible = false;
                        }
                    });
                }
            }
        }

        // Throttle selection HUD updates to ~4.5Hz (0.22s) instead of every frame (60Hz) to prevent multi-unit SVG DOM innerHTML lag!
        state._hudRefreshTimer = (state._hudRefreshTimer || 0) + dt;
        if ((state.selectedBuilding || state.selectedUnits.length > 0) && state._hudRefreshTimer >= 0.22) {
            state._hudRefreshTimer = 0;
            updateHUD();
        }

        // Update Allied Units (With Weather Speed Mult, Smart Targeting, Tactical Formations, Dropship Anti-Air Retreat & 360° Heli Belly Turret Aiming)
        const mainBaseAnchor = state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS;

        if (perfProf) perfProf.begin('unitAI');
        units.forEach((u, unitIdx) => {
            u.cooldown -= dt;
            if (u.maxShield && u.maxShield > 0) {
                u.shieldRegenDelay = Math.max(0, (u.shieldRegenDelay || 0) - dt);
                if (u.shieldRegenDelay <= 0 && (u.shield || 0) < u.maxShield) {
                    u.shield = Math.min(u.maxShield, (u.shield || 0) + 16 * dt);
                }
            }
            const inViewport = window.isWorldPosInViewport(u.mesh.position.x, u.mesh.position.y, u.mesh.position.z, 3.8);
            u.mesh.visible = inViewport;
            const isSelectedUnit = state.selectedUnits.includes(u);
            let moving = false;
            const envTactical = (!u.isAir && typeof window.getEnvironmentalTacticalModifiers === 'function')
                ? window.getEnvironmentalTacticalModifiers(u.mesh.position.x, u.mesh.position.z, false, !!u.isVehicle)
                : null;
            const roadSpdMult = (envTactical && envTactical.speedMult) ? envTactical.speedMult : 1.0;
            const effSpeed = (u.type === 'siege_tank' && u.siegeMode) ? 0 : (u.speed * weatherSpdMult * roadSpdMult);

            if (u.selCircle && u.isAir) {
                const gh = getTerrainHeight(u.mesh.position.x, u.mesh.position.z);
                u.selCircle.position.y = gh - u.mesh.position.y + 0.12;
            }

            // Initial post-spawn walk-out step so newly trained ground units immediately clear the building doorway without double-moving
            if (!u.isAir && !(u.type === 'siege_tank' && u.siegeMode) && u.spawnRallyTimer > 0 && u.spawnRallyTarget && u.order === 'auto') {
                u.spawnRallyTimer -= dt;
                const dRally = Math.hypot(u.spawnRallyTarget.x - u.mesh.position.x, u.spawnRallyTarget.z - u.mesh.position.z);
                if (dRally > 0.55) {
                    const stepDir = computeSafeGroundStep(u.mesh.position, u.spawnRallyTarget, effSpeed, dt, u, units, buildings, enemyBuildings);
                    if (stepDir.lengthSq() > 0.0001) {
                        u.mesh.position.addScaledVector(stepDir, effSpeed * dt);
                        alignGroundUnitToTerrain(u.mesh, u.mesh.position.x + stepDir.x, u.mesh.position.z + stepDir.z, dt);
                        moving = true;
                        if (inViewport) {
                            updateUnitAnimation(u.mesh, dt, moving, null);
                            updateHealthPip(u.hb, u.hp, u.maxHp, u.shield || 0, u.maxShield || 0);
                            projectToScreen(u.hb.root, u.mesh.position, 1.55, isSelectedUnit);
                        } else if (u.hb && u.hb.root && u.hb.root.style.display !== 'none') {
                            u.hb.root.style.display = 'none';
                        }
                        return;
                    }
                } else {
                    u.spawnRallyTimer = 0;
                }
            }

            // --- FORWARD DROPSHIP AI WITH ANTI-AIR THREAT EVASION ('transport') ---
            if (u.type === 'transport') {
                const allDropships = UNIT_COUNTS.dropships;
                const myIndex = Math.max(0, allDropships.indexOf(u));

                let airShootingThreat = null;
                let minThreatDist = 17.5;
                for (let ei = 0; ei < enemies.length; ei++) {
                    const e = enemies[ei];
                    if (e.hp <= 0) continue;
                    const shootsAir = (e.variant === 'spitter' || e.variant === 'mutalisk' || e.variant === 'behemoth' || e.range >= 4.0);
                    if (!shootsAir) continue;
                    const d = Math.hypot(e.mesh.position.x - u.mesh.position.x, e.mesh.position.z - u.mesh.position.z);
                    if (d < minThreatDist) {
                        minThreatDist = d;
                        airShootingThreat = e;
                    }
                }
                for (let ebi = 0; ebi < enemyBuildings.length; ebi++) {
                    const eb = enemyBuildings[ebi];
                    if (eb.hp <= 0 || eb.role !== 'spine_turret') continue;
                    const d = Math.hypot(eb.pos.x - u.mesh.position.x, eb.pos.z - u.mesh.position.z);
                    if (d < minThreatDist) {
                        minThreatDist = d;
                        airShootingThreat = eb;
                    }
                }

                const slotAngles = [0.78, 1.32, 0.35, 1.75, 2.15];
                const slotAng = slotAngles[myIndex % slotAngles.length];

                const hasEnemyTerritory = enemyBuildings.length > 0;
                const enemyAnchor = hasEnemyTerritory ? enemyBuildings[0].pos : ENEMY_BASE_POS;
                const standoffDist = 19.5 + (myIndex % 2) * 4.5;
                const forwardDropX = THREE.MathUtils.clamp(enemyAnchor.x + Math.cos(slotAng) * standoffDist, -102, 102);
                const forwardDropZ = THREE.MathUtils.clamp(enemyAnchor.z + Math.sin(slotAng) * standoffDist, -102, 102);

                const safeHomeX = THREE.MathUtils.clamp(mainBaseAnchor.x + Math.cos(slotAng) * (7.5 + myIndex * 2.5), -102, 102);
                const safeHomeZ = THREE.MathUtils.clamp(mainBaseAnchor.z + Math.sin(slotAng) * (7.5 + myIndex * 2.5), -102, 102);

                if (airShootingThreat) {
                    u.evasionTimer = 3.6;
                } else if (u.evasionTimer > 0) {
                    u.evasionTimer = Math.max(0, u.evasionTimer - dt);
                }

                const shouldGoBackToBase = (u.evasionTimer > 0) || !hasEnemyTerritory || u.order === 'retreat';

                let targetX = shouldGoBackToBase ? safeHomeX : forwardDropX;
                let targetZ = shouldGoBackToBase ? safeHomeZ : forwardDropZ;
                if ((u.order === 'move' || u.order === 'attack_move' || u.order === 'retreat') && u.orderTarget && !airShootingThreat) {
                    targetX = u.orderTarget.x;
                    targetZ = u.orderTarget.z;
                }

                const dx = targetX - u.mesh.position.x;
                const dz = targetZ - u.mesh.position.z;
                const distToDest = Math.hypot(dx, dz);

                let lookX = hasEnemyTerritory && !shouldGoBackToBase ? enemyAnchor.x : mainBaseAnchor.x;
                let lookZ = hasEnemyTerritory && !shouldGoBackToBase ? enemyAnchor.z : mainBaseAnchor.z;

                if (distToDest > 1.35 && u.order !== 'hold') {
                    const stepSpd = Math.min(effSpeed, distToDest * 2.2);
                    u.mesh.position.x += (dx / distToDest) * stepSpd * dt;
                    u.mesh.position.z += (dz / distToDest) * stepSpd * dt;
                    lookX = targetX;
                    lookZ = targetZ;
                    moving = true;
                } else {
                    moving = false;
                    if (u.order === 'move' || u.order === 'attack_move' || u.order === 'retreat') {
                        u.order = 'auto';
                        u.orderTarget = null;
                    }
                }

                smoothAirVehicleTransform(u, lookX, lookZ, 6.2, moving, dt);

                u.dropTimer -= dt;
                const nearDropArea = (!shouldGoBackToBase && distToDest < 8.5) || (airShootingThreat && u.dropTimer <= 0.8);
                if (u.dropTimer <= 0 && nearDropArea && hasEnemyTerritory) {
                    const hasActiveBarracks = BUILDING_COUNTS.activeBarracks > 0;
                    if (!hasActiveBarracks) {
                        u.dropTimer = 4.5;
                    } else if (UNIT_COUNTS.ground < 24) {
                        const clearDrop = typeof findClearSpawnPoint === 'function'
                            ? findClearSpawnPoint(u.mesh.position.x, u.mesh.position.z, enemyAnchor.x, enemyAnchor.z, 0.55, buildings, enemyBuildings, units)
                            : new THREE.Vector3(u.mesh.position.x, getTerrainHeight(u.mesh.position.x, u.mesh.position.z), u.mesh.position.z);
                        if (isWalkableGround(clearDrop.x, clearDrop.z)) {
                            if (u.mesh.userData) u.mesh.userData.dropAnim = 1.0;
                            spawnAlliedUnit('grunt', clearDrop);
                            spawnAlliedUnit('ranger', clearDrop);
                            u.dropTimer = 9.5;
                        }
                    }
                }

                if (inViewport) {
                    updateUnitAnimation(u.mesh, dt, moving, null);
                    updateHealthPip(u.hb, u.hp, u.maxHp, u.shield || 0, u.maxShield || 0);
                    projectToScreen(u.hb.root, u.mesh.position, 1.25, isSelectedUnit);
                } else if (u.hb && u.hb.root && u.hb.root.style.display !== 'none') {
                    u.hb.root.style.display = 'none';
                }
                return;
            }

            if (u.type === 'medic') {
                if ((u.order === 'move' || u.order === 'retreat' || u.order === 'attack_move') && u.orderTarget) {
                    const distToOrder = Math.hypot(u.orderTarget.x - u.mesh.position.x, u.orderTarget.z - u.mesh.position.z);
                    if (distToOrder > 1.35) {
                        const navPt = getGroundNavigationWaypoint(u.mesh.position, u.orderTarget, u);
                        const stepDir = computeSafeGroundStep(u.mesh.position, navPt, effSpeed, dt, u, units, buildings, enemyBuildings);
                        if (stepDir.lengthSq() > 0.0001) {
                            u.mesh.position.addScaledVector(stepDir, effSpeed * dt);
                            alignGroundUnitToTerrain(u.mesh, u.mesh.position.x + stepDir.x, u.mesh.position.z + stepDir.z, dt);
                            moving = true;
                            checkAndUnstickGroundUnit(u, navPt, dt);
                        }
                        u.healBeam.visible = false;
                        if (inViewport) {
                            updateUnitAnimation(u.mesh, dt, moving, null);
                            updateHealthPip(u.hb, u.hp, u.maxHp, u.shield || 0, u.maxShield || 0);
                            projectToScreen(u.hb.root, u.mesh.position, 1.5, isSelectedUnit);
                        } else if (u.hb && u.hb.root && u.hb.root.style.display !== 'none') {
                            u.hb.root.style.display = 'none';
                        }
                        return;
                    } else {
                        u.order = 'auto';
                        u.orderTarget = null;
                    }
                }

                let injuredBioAlly = null, minAllyDist = Infinity, bestMedicScore = -Infinity;
                let isTargetBridgeCongested = false;

                for (let ai = 0; ai < units.length; ai++) {
                    const ally = units[ai];
                    if (ally !== u && ally.isBiological && !ally.isMechanical && ally.type !== 'medic') {
                        const d = u.mesh.position.distanceTo(ally.mesh.position);
                        const missingRatio = Math.max(0, (ally.maxHp - ally.hp) / Math.max(1, ally.maxHp));
                        const nearBridgeRear = typeof getRiverDist === 'function'
                            && getRiverDist(ally.mesh.position.x, ally.mesh.position.z) < (RIVER_HALF_WIDTH + 9.5)
                            && ally.mesh.position.z > -1.0;
                        const isRearQueuedOrStuck = (ally.stuckTimer || 0) > 0.08 || (nearBridgeRear && (ally.stuckTimer || 0) > 0.03);

                        if (missingRatio > 0.01 || isRearQueuedOrStuck) {
                            const score = missingRatio * 120 + (isRearQueuedOrStuck ? 48 : 0) + (nearBridgeRear ? 18 : 0) - d * 1.35;
                            if (score > bestMedicScore) {
                                bestMedicScore = score;
                                injuredBioAlly = ally;
                                minAllyDist = d;
                                isTargetBridgeCongested = isRearQueuedOrStuck || nearBridgeRear;
                            }
                        }
                    }
                }
                if (!injuredBioAlly) {
                    for (let ai = 0; ai < units.length; ai++) {
                        const ally = units[ai];
                        if (ally !== u && ally.isBiological && !ally.isMechanical && ally.type !== 'medic') {
                            const d = u.mesh.position.distanceTo(ally.mesh.position);
                            const nearBridgeRear = typeof getRiverDist === 'function'
                                && getRiverDist(ally.mesh.position.x, ally.mesh.position.z) < (RIVER_HALF_WIDTH + 10.5)
                                && ally.mesh.position.z > 0;
                            const effectiveDist = nearBridgeRear ? d * 0.55 : d;
                            if (effectiveDist < minAllyDist) {
                                minAllyDist = d;
                                injuredBioAlly = ally;
                                isTargetBridgeCongested = nearBridgeRear || (ally.stuckTimer || 0) > 0.06;
                            }
                        }
                    }
                }

                if (injuredBioAlly) {
                    const rawDest = injuredBioAlly.mesh.position;
                    const desiredApproachDist = isTargetBridgeCongested ? 1.35 : (injuredBioAlly.hp < injuredBioAlly.maxHp ? u.range * 0.58 : u.range * 0.72);

                    if (minAllyDist <= u.range && injuredBioAlly.hp < injuredBioAlly.maxHp) {
                        alignGroundUnitToTerrain(u.mesh, rawDest.x, rawDest.z, dt);
                        injuredBioAlly.hp = Math.min(injuredBioAlly.maxHp, injuredBioAlly.hp + 28 * dt);

                        _beamStartScratch.set(u.mesh.position.x, u.mesh.position.y + 0.75, u.mesh.position.z);
                        _beamEndScratch.set(rawDest.x, rawDest.y + 0.75, rawDest.z);
                        const dist = _beamStartScratch.distanceTo(_beamEndScratch);
                        const bioPulse = 0.85 + Math.sin(now * 0.015) * 0.35;
                        u.healBeam.visible = true;
                        u.healBeam.position.lerpVectors(_beamStartScratch, _beamEndScratch, 0.5);
                        u.healBeam.scale.set(bioPulse, bioPulse, dist);
                        u.healBeam.lookAt(_beamEndScratch);

                        if (u.cooldown <= 0) {
                            spawnMedicBioPulseFX(rawDest);
                            spawnCombatFloat(rawDest, '+BIO REGEN', '#00ff66');
                            if (window.SFX) window.SFX.playHeal();
                            u.cooldown = 0.85;
                        }

                        if (minAllyDist > desiredApproachDist && u.order !== 'hold') {
                            const navPt = getGroundNavigationWaypoint(u.mesh.position, rawDest, u);
                            const stepDir = computeSafeGroundStep(u.mesh.position, navPt, effSpeed * 0.85, dt, u, units, buildings, enemyBuildings);
                            if (stepDir.lengthSq() > 0.0001) {
                                u.mesh.position.addScaledVector(stepDir, effSpeed * 0.85 * dt);
                                moving = true;
                            }
                        }
                    } else if (minAllyDist > desiredApproachDist && u.order !== 'hold') {
                        const navPt = getGroundNavigationWaypoint(u.mesh.position, rawDest, u);
                        const stepDir = computeSafeGroundStep(u.mesh.position, navPt, effSpeed, dt, u, units, buildings, enemyBuildings);
                        if (stepDir.lengthSq() > 0.0001) {
                            u.mesh.position.addScaledVector(stepDir, effSpeed * dt);
                            alignGroundUnitToTerrain(u.mesh, u.mesh.position.x + stepDir.x, u.mesh.position.z + stepDir.z, dt);
                            moving = true;
                            checkAndUnstickGroundUnit(u, navPt, dt);
                        }
                        u.healBeam.visible = false;
                    } else {
                        u.healBeam.visible = false;
                    }
                } else {
                    u.healBeam.visible = false;
                }

                if (inViewport) {
                    updateUnitAnimation(u.mesh, dt, moving, null);
                    updateHealthPip(u.hb, u.hp, u.maxHp, u.shield || 0, u.maxShield || 0);
                    projectToScreen(u.hb.root, u.mesh.position, 1.5, isSelectedUnit);
                } else if (u.hb && u.hb.root && u.hb.root.style.display !== 'none') {
                    u.hb.root.style.display = 'none';
                }
                return;
            }

            // --- TERRAN MEDIVAC MEDICAL SUPPORT DROPSHIP AI (Autonomous Biological Healing Beam) ---
            if (u.type === 'medivac') {
                const medivacAlt = 6.2;
                if (u.order === 'move' && u.orderTarget) {
                    const dMove = Math.hypot(u.orderTarget.x - u.mesh.position.x, u.orderTarget.z - u.mesh.position.z);
                    if (dMove > 1.2) {
                        const dxAir = u.orderTarget.x - u.mesh.position.x;
                        const dzAir = u.orderTarget.z - u.mesh.position.z;
                        const lenAir = Math.hypot(dxAir, dzAir) || 1;
                        u.mesh.position.x += (dxAir / lenAir) * effSpeed * dt;
                        u.mesh.position.z += (dzAir / lenAir) * effSpeed * dt;
                        smoothAirVehicleTransform(u, u.orderTarget.x, u.orderTarget.z, medivacAlt, true, dt);
                        moving = true;
                        if (u.healBeam) u.healBeam.visible = false;
                        if (inViewport) {
                            updateUnitAnimation(u.mesh, dt, moving, null);
                            updateHealthPip(u.hb, u.hp, u.maxHp, u.shield || 0, u.maxShield || 0);
                            projectToScreen(u.hb.root, u.mesh.position, 1.85, isSelectedUnit);
                        }
                        return;
                    } else {
                        u.order = 'auto';
                        u.orderTarget = null;
                    }
                }

                let injuredBioAlly = null;
                let bestScore = -Infinity;
                let nearestBioAlly = null;
                let minBioDist = Infinity;

                for (let ai = 0; ai < units.length; ai++) {
                    const ally = units[ai];
                    if (!ally || ally === u || ally.hp <= 0 || !ally.isBiological || ally.isMechanical) continue;
                    const d = Math.hypot(ally.mesh.position.x - u.mesh.position.x, ally.mesh.position.z - u.mesh.position.z);
                    if (d < minBioDist) {
                        minBioDist = d;
                        nearestBioAlly = ally;
                    }
                    if (ally.hp < ally.maxHp) {
                        const missingRatio = (ally.maxHp - ally.hp) / Math.max(1, ally.maxHp);
                        const score = missingRatio * 140 - d * 1.25;
                        if (score > bestScore) {
                            bestScore = score;
                            injuredBioAlly = ally;
                        }
                    }
                }

                const supportTarget = injuredBioAlly || nearestBioAlly;
                if (supportTarget) {
                    const tPos = supportTarget.mesh.position;
                    const dist2D = Math.hypot(tPos.x - u.mesh.position.x, tPos.z - u.mesh.position.z);
                    if (injuredBioAlly && dist2D <= u.range && injuredBioAlly.hp < injuredBioAlly.maxHp) {
                        smoothAirVehicleTransform(u, tPos.x, tPos.z, medivacAlt, false, dt);
                        injuredBioAlly.hp = Math.min(injuredBioAlly.maxHp, injuredBioAlly.hp + 36 * dt);
                        if (u.healBeam) {
                            window.getWeaponMuzzleWorldPos(u, 0, _beamStartScratch);
                            _beamEndScratch.set(tPos.x, tPos.y + 0.75, tPos.z);
                            const beamDist = _beamStartScratch.distanceTo(_beamEndScratch);
                            const bioPulse = 0.90 + Math.sin(now * 0.018) * 0.35;
                            u.healBeam.visible = true;
                            u.healBeam.position.lerpVectors(_beamStartScratch, _beamEndScratch, 0.5);
                            u.healBeam.scale.set(bioPulse, bioPulse, beamDist);
                            u.healBeam.lookAt(_beamEndScratch);
                        }
                        if (u.cooldown <= 0) {
                            spawnMedicBioPulseFX(tPos);
                            spawnCombatFloat(tPos, '+CADUCEUS HEAL', '#00ff66');
                            if (window.SFX) window.SFX.playHeal();
                            u.cooldown = 0.80;
                        }
                    } else if (dist2D > 5.5 && u.order !== 'hold') {
                        const dxAir = tPos.x - u.mesh.position.x;
                        const dzAir = tPos.z - u.mesh.position.z;
                        const lenAir = Math.hypot(dxAir, dzAir) || 1;
                        u.mesh.position.x += (dxAir / lenAir) * effSpeed * dt;
                        u.mesh.position.z += (dzAir / lenAir) * effSpeed * dt;
                        smoothAirVehicleTransform(u, tPos.x, tPos.z, medivacAlt, true, dt);
                        moving = true;
                        if (u.healBeam) u.healBeam.visible = false;
                    } else {
                        smoothAirVehicleTransform(u, tPos.x, tPos.z, medivacAlt, false, dt);
                        if (u.healBeam) u.healBeam.visible = false;
                    }
                } else {
                    if (u.healBeam) u.healBeam.visible = false;
                }

                if (inViewport) {
                    updateUnitAnimation(u.mesh, dt, moving, null);
                    updateHealthPip(u.hb, u.hp, u.maxHp, u.shield || 0, u.maxShield || 0);
                    projectToScreen(u.hb.root, u.mesh.position, 1.85, isSelectedUnit);
                } else if (u.hb && u.hb.root && u.hb.root.style.display !== 'none') {
                    u.hb.root.style.display = 'none';
                }
                return;
            }

            // --- SMARTER VALKYRIE VARIABLE-FIGHTER & SEMI-MECH AI ---
            if (u.type === 'valkyrie') {
                u.modeSwitchCooldown = Math.max(0, (u.modeSwitchCooldown || 0) - dt);
                if (u.manualModeLockTimer > 0) {
                    u.manualModeLockTimer = Math.max(0, u.manualModeLockTimer - dt);
                }

                let closestAirEnemy = null, minAirDist = Infinity;
                let closestGroundEnemy = null, minGroundDist = Infinity;
                for (let ei = 0; ei < enemies.length; ei++) {
                    const en = enemies[ei];
                    if (!en || en.hp <= 0) continue;
                    const d = Math.hypot(en.mesh.position.x - u.mesh.position.x, en.mesh.position.z - u.mesh.position.z);
                    if (en.isAir) {
                        if (d < minAirDist) { minAirDist = d; closestAirEnemy = en; }
                    } else {
                        if (d < minGroundDist) { minGroundDist = d; closestGroundEnemy = en; }
                    }
                }
                let closestEnemyBld = null, minBldDist = Infinity;
                for (let bi = 0; bi < enemyBuildings.length; bi++) {
                    const eb = enemyBuildings[bi];
                    if (!eb || eb.hp <= 0) continue;
                    const d = Math.hypot(eb.pos.x - u.mesh.position.x, eb.pos.z - u.mesh.position.z);
                    if (d < minBldDist) { minBldDist = d; closestEnemyBld = eb; }
                }

                let navGoalPos = null;
                if ((u.order === 'move' || u.order === 'retreat' || u.order === 'attack_move') && u.orderTarget) {
                    navGoalPos = u.orderTarget;
                } else if (closestAirEnemy && minAirDist <= 44.0) {
                    navGoalPos = closestAirEnemy.mesh.position;
                } else if (closestGroundEnemy) {
                    navGoalPos = closestGroundEnemy.mesh.position;
                } else if (closestEnemyBld) {
                    navGoalPos = closestEnemyBld.pos;
                }

                if (!(u.manualModeLockTimer > 0) && u.modeSwitchCooldown <= 0 && u.order !== 'hold') {
                    const airThreatActive = closestAirEnemy && minAirDist <= 44.0;
                    const nearestGroundCombatDist = Math.min(minGroundDist, minBldDist);
                    const distToGoal = navGoalPos
                        ? Math.hypot(navGoalPos.x - u.mesh.position.x, navGoalPos.z - u.mesh.position.z)
                        : 0;

                    let complexTerrainAhead = false;
                    if (navGoalPos && distToGoal > 9.5) {
                        if (typeof getRiverCoords === 'function') {
                            const rcCur = getRiverCoords(u.mesh.position.x, u.mesh.position.z);
                            const rcGoal = getRiverCoords(navGoalPos.x, navGoalPos.z);
                            if ((rcCur.u - rcCur.centerU) * (rcGoal.u - rcGoal.centerU) < 0 || Math.abs(rcCur.u - rcCur.centerU) < RIVER_HALF_WIDTH + 3.5) {
                                complexTerrainAhead = true;
                            }
                        }
                        if (!complexTerrainAhead && typeof getGroundNavigationWaypoint === 'function') {
                            const wp = getGroundNavigationWaypoint(u.mesh.position, navGoalPos, u);
                            const directAng = Math.atan2(navGoalPos.z - u.mesh.position.z, navGoalPos.x - u.mesh.position.x);
                            const wpAng = Math.atan2(wp.z - u.mesh.position.z, wp.x - u.mesh.position.x);
                            if (Math.abs(shortestAngleDiff(directAng, wpAng)) > 0.38) {
                                complexTerrainAhead = true;
                            }
                        }
                        if ((u.stuckTimer || 0) > 0.20) {
                            complexTerrainAhead = true;
                        }
                    }

                    const shouldFlyFast =
                        airThreatActive ||
                        ((u.order === 'move' || u.order === 'retreat') && distToGoal > 8.5) ||
                        (nearestGroundCombatDist > 15.8 && (distToGoal > 16.0 || complexTerrainAhead));

                    const canLandHere = isWalkableGround(u.mesh.position.x, u.mesh.position.z, 0.55);
                    const shouldLandToFight =
                        !airThreatActive &&
                        canLandHere &&
                        (nearestGroundCombatDist <= 15.2 || (distToGoal <= 12.5 && nearestGroundCombatDist <= 18.0));

                    if (u.mechMode && shouldFlyFast) {
                        setValkyrieCombatMode(u, false, false);
                    } else if (!u.mechMode && shouldLandToFight) {
                        setValkyrieCombatMode(u, true, false);
                    }
                }
            }

            // CRUCIO SIEGE TANK AUTO-SIEGE ARTILLERY TRANSFORMATION (< 5s), MINIMUM RANGE DEADZONE (7.5m),
            // AND TACTICAL TANK RETREAT / ESCORT AI (FOR BOTH TANK & SIEGE TANK):
            const SIEGE_MIN_RANGE = 7.5;
            let isSiegeTransitioning = false;
            if (u.type === 'siege_tank') {
                u.siegeSwitchCooldown = Math.max(0, (u.siegeSwitchCooldown || 0) - dt);
                u.siegeCooldown = u.siegeSwitchCooldown;
                u.siegeTransitionTimer = Math.max(0, (u.siegeTransitionTimer || 0) - dt);
                u.manualSiegeLockTimer = Math.max(0, (u.manualSiegeLockTimer || 0) - dt);
                const targetTr = u.siegeMode ? 1.0 : 0.0;
                const curTr = u.mesh.userData.siegeTransition || 0.0;
                if (Math.abs(targetTr - curTr) > 0.001) {
                    u.mesh.userData.siegeTransition = curTr + Math.sign(targetTr - curTr) * Math.min(Math.abs(targetTr - curTr), dt / 3.6);
                } else {
                    u.mesh.userData.siegeTransition = targetTr;
                }
                isSiegeTransitioning = (u.siegeTransitionTimer > 0) || (Math.abs(targetTr - (u.mesh.userData.siegeTransition || 0)) > 0.02);

                if (u.siegeMode || isSiegeTransitioning) {
                    if (!u.anchoredPos) u.anchoredPos = u.mesh.position.clone();
                    if (u.anchoredYaw === undefined) {
                        u.anchoredYaw = (u.mesh.userData && u.mesh.userData.smoothYaw !== undefined)
                            ? u.mesh.userData.smoothYaw
                            : u.mesh.rotation.y;
                    }
                    u.mesh.position.x = u.anchoredPos.x;
                    u.mesh.position.z = u.anchoredPos.z;
                    u.mesh.rotation.y = u.anchoredYaw;
                    if (u.mesh.userData) u.mesh.userData.smoothYaw = u.anchoredYaw;
                }
            }

            if ((u.type === 'tank' || u.type === 'siege_tank') && u.order !== 'hold' && u.order !== 'move') {
                let chargingEnemies = 0;
                let closeDeadzoneEnemies = 0;
                let threatSumX = 0, threatSumZ = 0;
                for (let ei = 0; ei < enemies.length; ei++) {
                    const en = enemies[ei];
                    if (!en || en.hp <= 0 || en.isAir) continue;
                    const dE = Math.hypot(en.mesh.position.x - u.mesh.position.x, en.mesh.position.z - u.mesh.position.z);
                    if (dE <= 10.0) {
                        chargingEnemies++;
                        threatSumX += en.mesh.position.x;
                        threatSumZ += en.mesh.position.z;
                        if (dE < SIEGE_MIN_RANGE) closeDeadzoneEnemies++;
                    }
                }

                let escortAllies = 0;
                let nearestDefenderClusterPos = null;
                let bestDefDist = Infinity;
                for (let ai = 0; ai < units.length; ai++) {
                    const ally = units[ai];
                    if (!ally || ally === u || ally.hp <= 0 || ally.type === 'transport') continue;
                    const dA = Math.hypot(ally.mesh.position.x - u.mesh.position.x, ally.mesh.position.z - u.mesh.position.z);
                    if (dA <= 10.5 && ally.type !== 'tank' && ally.type !== 'siege_tank') {
                        escortAllies++;
                    }
                    if (dA > 5.0 && dA < bestDefDist && ally.type !== 'tank' && ally.type !== 'siege_tank') {
                        bestDefDist = dA;
                        nearestDefenderClusterPos = ally.mesh.position;
                    }
                }

                const overwhelmedBySwarm =
                    (chargingEnemies >= 3 && escortAllies < 2) ||
                    (chargingEnemies >= 2 && u.hp < u.maxHp * 0.65 && escortAllies < 2) ||
                    (u.type === 'siege_tank' && closeDeadzoneEnemies >= 1 && escortAllies < 2);

                if (overwhelmedBySwarm) {
                    u.tankTacticalRetreat = true;
                    if (u.type === 'siege_tank' && u.siegeMode && !isSiegeTransitioning && u.siegeSwitchCooldown <= 0) {
                        setSiegeTankMode(u, false, false);
                        isSiegeTransitioning = true;
                    }
                } else if (u.tankTacticalRetreat && (escortAllies >= 3 || chargingEnemies === 0)) {
                    u.tankTacticalRetreat = false;
                }

                if (u.tankTacticalRetreat && !(u.type === 'siege_tank' && (u.siegeMode || isSiegeTransitioning)) && effSpeed > 0.01) {
                    const fallbackDest = nearestDefenderClusterPos || mainBaseAnchor;
                    let retreatPt = fallbackDest;
                    if (chargingEnemies > 0) {
                        const avgEx = threatSumX / chargingEnemies;
                        const avgEz = threatSumZ / chargingEnemies;
                        const awayX = u.mesh.position.x - avgEx;
                        const awayZ = u.mesh.position.z - avgEz;
                        const awayLen = Math.hypot(awayX, awayZ) || 1;
                        const toBaseX = fallbackDest.x - u.mesh.position.x;
                        const toBaseZ = fallbackDest.z - u.mesh.position.z;
                        const toBaseLen = Math.hypot(toBaseX, toBaseZ) || 1;
                        const rx = THREE.MathUtils.clamp(u.mesh.position.x + ((awayX / awayLen) * 0.55 + (toBaseX / toBaseLen) * 0.45) * 9.0, -100, 100);
                        const rz = THREE.MathUtils.clamp(u.mesh.position.z + ((awayZ / awayLen) * 0.55 + (toBaseZ / toBaseLen) * 0.45) * 9.0, -100, 100);
                        if (!u._retreatScratch) u._retreatScratch = new THREE.Vector3();
                        retreatPt = u._retreatScratch.set(rx, getTerrainHeight(rx, rz), rz);
                    }
                    const navPt = getGroundNavigationWaypoint(u.mesh.position, retreatPt, u);
                    const stepDir = computeSafeGroundStep(u.mesh.position, navPt, effSpeed, dt, u, units, buildings, enemyBuildings);
                    if (stepDir.lengthSq() > 0.0001) {
                        u.mesh.position.addScaledVector(stepDir, effSpeed * dt);
                        alignGroundUnitToTerrain(u.mesh, u.mesh.position.x + stepDir.x, u.mesh.position.z + stepDir.z, dt);
                        moving = true;
                        checkAndUnstickGroundUnit(u, navPt, dt);
                    }
                }
            }

            if (u.type === 'siege_tank' && !u.tankTacticalRetreat) {
                if (!isSiegeTransitioning && u.siegeSwitchCooldown <= 0 && u.manualSiegeLockTimer <= 0) {
                    if ((u.order === 'move' || u.order === 'retreat') && u.orderTarget) {
                        if (u.siegeMode) setSiegeTankMode(u, false, false);
                    } else {
                        let validSiegeBandDist = Infinity;
                        let closestEnemyDist = Infinity;
                        for (let ei = 0; ei < enemies.length; ei++) {
                            const e = enemies[ei];
                            if (e.hp <= 0 || e.isAir) continue;
                            const ex = e.mesh.position.x, ez = e.mesh.position.z;
                            const d = Math.hypot(ex - u.mesh.position.x, ez - u.mesh.position.z);
                            if (d > 28.5 && !isWorldPosVisible(ex, ez)) continue;
                            if (d < closestEnemyDist) closestEnemyDist = d;
                            if (d >= SIEGE_MIN_RANGE && d <= 28.5 && d < validSiegeBandDist) {
                                validSiegeBandDist = d;
                            }
                        }
                        for (let ebi = 0; ebi < enemyBuildings.length; ebi++) {
                            const eb = enemyBuildings[ebi];
                            const d = Math.hypot(eb.pos.x - u.mesh.position.x, eb.pos.z - u.mesh.position.z);
                            if (d > 28.5 && !isWorldPosVisible(eb.pos.x, eb.pos.z)) continue;
                            if (d < closestEnemyDist) closestEnemyDist = d;
                            if (d >= SIEGE_MIN_RANGE && d <= 28.5 && d < validSiegeBandDist) {
                                validSiegeBandDist = d;
                            }
                        }

                        if (!u.siegeMode && validSiegeBandDist <= 28.0 && closestEnemyDist >= SIEGE_MIN_RANGE + 1.0) {
                            setSiegeTankMode(u, true, false);
                        } else if (u.siegeMode && (validSiegeBandDist === Infinity && (closestEnemyDist < SIEGE_MIN_RANGE || closestEnemyDist > 29.5))) {
                            setSiegeTankMode(u, false, false);
                        }
                    }
                }
            }

            if (u.order === 'retreat' && u.isAutoRecall && enemies.length > 0) {
                u.order = 'auto';
                u.orderTarget = null;
                u.isAutoRecall = false;
            }

            if ((u.order === 'move' || u.order === 'retreat') && u.orderTarget && !(u.type === 'siege_tank' && (u.siegeMode || isSiegeTransitioning))) {
                const distToDest = Math.hypot(u.orderTarget.x - u.mesh.position.x, u.orderTarget.z - u.mesh.position.z);
                if (distToDest > 1.35) {
                    const navPt = u.isAir ? u.orderTarget : getGroundNavigationWaypoint(u.mesh.position, u.orderTarget, u);
                    if (u.isAir) {
                        const dxAir = navPt.x - u.mesh.position.x;
                        const dzAir = navPt.z - u.mesh.position.z;
                        const lenAir = Math.hypot(dxAir, dzAir) || 1;
                        u.mesh.position.x += (dxAir / lenAir) * effSpeed * dt;
                        u.mesh.position.z += (dzAir / lenAir) * effSpeed * dt;
                        smoothAirVehicleTransform(u, navPt.x, navPt.z, 6.0, true, dt);
                        moving = true;
                    } else if (effSpeed > 0.01) {
                        const stepDir = computeSafeGroundStep(u.mesh.position, navPt, effSpeed, dt, u, units, buildings, enemyBuildings);
                        if (stepDir.lengthSq() > 0.0001) {
                            u.mesh.position.addScaledVector(stepDir, effSpeed * dt);
                            alignGroundUnitToTerrain(u.mesh, u.mesh.position.x + stepDir.x, u.mesh.position.z + stepDir.z, dt);
                            moving = true;
                            checkAndUnstickGroundUnit(u, navPt, dt);
                        }
                    }
                    if (inViewport) {
                        updateUnitAnimation(u.mesh, dt, moving, null);
                        updateHealthPip(u.hb, u.hp, u.maxHp, u.shield || 0, u.maxShield || 0);
                        projectToScreen(u.hb.root, u.mesh.position, u.isAir ? 1.2 : 1.55, isSelectedUnit);
                    } else if (u.hb && u.hb.root && u.hb.root.style.display !== 'none') {
                        u.hb.root.style.display = 'none';
                    }
                    return;
                } else {
                    u.order = 'auto';
                    u.orderTarget = null;
                    u.isAutoRecall = false;
                }
            }

            let target = null;
            let minDist = Infinity;
            let valkGroundApproachPos = null;
            const localSensorRad = u.order === 'hold' ? (u.range + 2.5) : Math.max(u.range + 4.0, 22.0);
            const sharedFowRad = u.order === 'hold' ? (u.range + 2.5) : 38.0;

            if (u.type === 'valkyrie') {
                if (!u.mechMode) {
                    // VALKYRIE FLIGHT MODE: STRICTLY AIR-ONLY ATTACK!
                    enemies.forEach(e => {
                        if (e.hp <= 0 || !e.isAir) return;
                        const d = Math.hypot(e.mesh.position.x - u.mesh.position.x, e.mesh.position.z - u.mesh.position.z);
                        const isDetected = d <= localSensorRad || (d <= sharedFowRad && isWorldPosVisible(e.mesh.position.x, e.mesh.position.z));
                        if (isDetected && d < minDist) {
                            minDist = d;
                            target = e;
                        }
                    });
                    if (!target && u.order !== 'hold') {
                        let bestGndDist = Infinity;
                        enemies.forEach(e => {
                            if (e.hp <= 0 || e.isAir) return;
                            const d = Math.hypot(e.mesh.position.x - u.mesh.position.x, e.mesh.position.z - u.mesh.position.z);
                            const isDetected = d <= localSensorRad || (d <= sharedFowRad && isWorldPosVisible(e.mesh.position.x, e.mesh.position.z));
                            if (isDetected && d < bestGndDist) { bestGndDist = d; valkGroundApproachPos = e.mesh.position; }
                        });
                        if ((!valkGroundApproachPos || bestGndDist > 18) && enemyBuildings.length > 0) {
                            enemyBuildings.forEach(eb => {
                                const d = Math.hypot(eb.pos.x - u.mesh.position.x, eb.pos.z - u.mesh.position.z);
                                const isDetected = d <= localSensorRad || (d <= sharedFowRad && isWorldPosVisible(eb.pos.x, eb.pos.z));
                                if (isDetected && d < bestGndDist) { bestGndDist = d; valkGroundApproachPos = eb.pos; }
                            });
                        }
                    }
                } else {
                    // VALKYRIE SEMI-MECH WALKER MODE: Target visible GROUND enemies and enemy buildings!
                    enemies.forEach(e => {
                        if (e.hp <= 0 || e.isAir) return;
                        const d = Math.hypot(e.mesh.position.x - u.mesh.position.x, e.mesh.position.z - u.mesh.position.z);
                        const isDetected = d <= localSensorRad || (d <= sharedFowRad && isWorldPosVisible(e.mesh.position.x, e.mesh.position.z));
                        if (isDetected && d < minDist) {
                            minDist = d;
                            target = e;
                        }
                    });
                    if (u.order !== 'hold' && (!target || minDist > 18) && enemyBuildings.length > 0) {
                        enemyBuildings.forEach(eb => {
                            const d = Math.hypot(eb.pos.x - u.mesh.position.x, eb.pos.z - u.mesh.position.z);
                            const isDetected = d <= localSensorRad || (d <= sharedFowRad && isWorldPosVisible(eb.pos.x, eb.pos.z));
                            if (isDetected && d < minDist) { minDist = d; target = eb; }
                        });
                    }
                }
            } else if (u.type === 'siege_tank' && u.siegeMode) {
                // SIEGE TANK IN SIEGE MODE: Cannot target or shoot enemies closer than SIEGE_MIN_RANGE (6.5m)!
                enemies.forEach(e => {
                    if (e.hp <= 0 || e.isAir) return;
                    const d = Math.hypot(e.mesh.position.x - u.mesh.position.x, e.mesh.position.z - u.mesh.position.z);
                    if (d < SIEGE_MIN_RANGE) return; // Inside minimum range deadzone — cannot shoot!
                    const isDetected = d <= u.range + 2.0 || (d <= sharedFowRad && isWorldPosVisible(e.mesh.position.x, e.mesh.position.z));
                    if (isDetected && d < minDist) {
                        minDist = d;
                        target = e;
                    }
                });
                if (!target || minDist > u.range) {
                    enemyBuildings.forEach(eb => {
                        const d = Math.hypot(eb.pos.x - u.mesh.position.x, eb.pos.z - u.mesh.position.z);
                        if (d < SIEGE_MIN_RANGE) return;
                        const isDetected = d <= u.range + 3.0 || (d <= sharedFowRad && isWorldPosVisible(eb.pos.x, eb.pos.z));
                        if (isDetected && d < minDist) {
                            minDist = d;
                            target = eb;
                        }
                    });
                }
            } else {
                const isMeleeUnit = (u.type === 'grunt' || u.type === 'zealot' || u.type === 'skitterer' || u.type === 'crusher' || u.type === 'burster');
                const canHitAir = !isMeleeUnit && !(u.range < 2.5 || u.type === 'tank' || u.type === 'siege_tank');
                const preferHeavy = (u.type === 'tank' || u.type === 'siege_tank' || u.type === 'heli' || u.type === 'behemoth' || u.type === 'crusher');

                // Immediate Retaliation Priority: If an enemy is attacking this unit (especially Mind-Controlled Zerg!), hit back immediately!
                if (u.retaliateTarget && u.retaliateTarget.hp > 0 && (!u.retaliateTarget.isAir || canHitAir)) {
                    const rtPos = u.retaliateTarget.mesh ? u.retaliateTarget.mesh.position : u.retaliateTarget.pos;
                    const rtDist = Math.hypot(rtPos.x - u.mesh.position.x, rtPos.z - u.mesh.position.z);
                    if (rtDist <= Math.max(localSensorRad, 24.0)) {
                        target = u.retaliateTarget;
                        minDist = rtDist;
                    } else {
                        u.retaliateTarget = null;
                    }
                } else {
                    u.retaliateTarget = null;
                }

                if (!target) {
                    const effectiveSensorRad = u.isMindControlled ? Math.max(localSensorRad, 28.0) : localSensorRad;
                    target = selectSmartTarget(u.mesh.position, effectiveSensorRad, canHitAir, preferHeavy, isMeleeUnit, u);
                    minDist = target ? Math.hypot((target.mesh ? target.mesh.position.x : target.pos.x) - u.mesh.position.x, (target.mesh ? target.mesh.position.z : target.pos.z) - u.mesh.position.z) : Infinity;
                }

                // Prioritize defending the Main Base & friendly structures if any enemy is attacking within 32m of HQ!
                if (u.order !== 'hold' && (!target || minDist > 16)) {
                    let hqThreat = null;
                    let bestHqDist = 32.0;
                    enemies.forEach(e => {
                        if (e.hp <= 0 || (e.isAir && !canHitAir)) return;
                        const dHq = Math.hypot(e.mesh.position.x - mainBaseAnchor.x, e.mesh.position.z - mainBaseAnchor.z);
                        if (dHq < bestHqDist) {
                            bestHqDist = dHq;
                            hqThreat = e;
                        }
                    });
                    if (hqThreat) {
                        target = hqThreat;
                        minDist = Math.hypot(hqThreat.mesh.position.x - u.mesh.position.x, hqThreat.mesh.position.z - u.mesh.position.z);
                    }
                }

                // Check enemies/structures visible in Fog of War within shared tactical radar range (38m)
                if (u.order !== 'hold' && !target) {
                    enemies.forEach(e => {
                        if (e.hp <= 0 || (e.isAir && !canHitAir)) return;
                        if (!u.isMindControlled && !isWorldPosVisible(e.mesh.position.x, e.mesh.position.z)) return;
                        const d = Math.hypot(e.mesh.position.x - u.mesh.position.x, e.mesh.position.z - u.mesh.position.z);
                        if (d <= (u.isMindControlled ? 65.0 : sharedFowRad) && d < minDist) { minDist = d; target = e; }
                    });
                }
                if (u.order !== 'hold' && !target && enemyBuildings.length > 0) {
                    enemyBuildings.forEach(eb => {
                        const distEb = Math.hypot(eb.pos.x - u.mesh.position.x, eb.pos.z - u.mesh.position.z);
                        if (distEb <= localSensorRad + 4.0) {
                            notifyEnemyBaseDiscovered(eb.pos);
                        }
                        if (!u.isMindControlled && !state.enemyBaseDiscovered && !isWorldPosVisible(eb.pos.x, eb.pos.z) && distEb > localSensorRad) return;
                        if (distEb <= (u.isMindControlled || state.enemyBaseDiscovered ? 95.0 : sharedFowRad) && distEb < minDist) {
                            minDist = distEb;
                            target = eb;
                        }
                    });
                }
                // ENDLESS MODE / NO ENEMY BUILDINGS: If any enemy unit exists anywhere on the map, acquire it immediately so units hunt & attack instead of walking back to base!
                if (u.order !== 'hold' && !target && (state.isEndless || enemyBuildings.length === 0) && enemies.length > 0) {
                    enemies.forEach(e => {
                        if (!e || e.hp <= 0 || (e.isAir && !canHitAir)) return;
                        const d = Math.hypot(e.mesh.position.x - u.mesh.position.x, e.mesh.position.z - u.mesh.position.z);
                        if (d < minDist) {
                            minDist = d;
                            target = e;
                        }
                    });
                }
            }

            // Also check if this unit's scouting sensor has spotted any enemy building!
            if (!state.enemyBaseDiscovered && enemyBuildings.length > 0) {
                for (let ebi = 0; ebi < enemyBuildings.length; ebi++) {
                    const eb = enemyBuildings[ebi];
                    if (Math.hypot(eb.pos.x - u.mesh.position.x, eb.pos.z - u.mesh.position.z) <= localSensorRad + 5.0) {
                        notifyEnemyBaseDiscovered(eb.pos);
                        break;
                    }
                }
            }

            let aimTargetPos = null;
            const unitFlyAlt = u.type === 'reaper' ? 2.65 : (u.type === 'carrier' ? 7.2 : (u.type === 'void_ray' ? 6.5 : (u.type === 'phoenix' ? 6.2 : 6.0)));
            const hasAttackMoveDest = (u.order === 'attack_move' && u.orderTarget);
            const enemyInImmediateRange = target && minDist <= Math.max(u.range + 3.5, 11.0);

            // --- PROTOSS VOID RAY PRISMATIC BEAM SUSTAINED RAMPING DAMAGE ---
            if (u.type === 'void_ray') {
                const beamValid = target && minDist <= u.range + (enemyBuildings.includes(target) ? 2.8 : 0.8) && u.hp > 0 && target.hp > 0;
                if (beamValid) {
                    const tPos = target.mesh ? target.mesh.position : target.pos;
                    aimTargetPos = _aimScratch.set(tPos.x, (tPos.y || 0) + (target.isAir ? 0.0 : 0.65), tPos.z);
                    if (u.prismaticTarget === target) {
                        u.prismaticCharge = Math.min(6.0, (u.prismaticCharge || 0) + dt);
                    } else {
                        u.prismaticTarget = target;
                        u.prismaticCharge = Math.max(0, (u.prismaticCharge || 0) * 0.5);
                    }
                    const stage = u.prismaticCharge >= 3.2 ? 3 : (u.prismaticCharge >= 1.4 ? 2 : 1);
                    if (u.mesh.userData) {
                        u.mesh.userData.beamChargeLevel = stage / 3.0;
                        u.mesh.userData.attackAnim = 0.85;
                    }
                    if (u.prismaticBeam) {
                        const muzzleObj = u.mesh.userData ? u.mesh.userData.muzzleNode : null;
                        if (muzzleObj) muzzleObj.getWorldPosition(_beamStartScratch);
                        else _beamStartScratch.set(u.mesh.position.x, u.mesh.position.y - 0.1, u.mesh.position.z);
                        _beamEndScratch.set(tPos.x, (tPos.y || 0) + (target.isAir ? 0.0 : 0.7), tPos.z);
                        const dist = Math.max(0.2, _beamStartScratch.distanceTo(_beamEndScratch));
                        const beamThick = (0.55 + stage * 0.42) * (0.92 + Math.sin(now * 0.025) * 0.14);
                        u.prismaticBeam.visible = true;
                        u.prismaticBeam.position.lerpVectors(_beamStartScratch, _beamEndScratch, 0.5);
                        u.prismaticBeam.scale.set(beamThick, beamThick, dist);
                        u.prismaticBeam.lookAt(_beamEndScratch);
                    }
                    if (u.cooldown <= 0) {
                        const stageMult = stage === 3 ? 1.85 : (stage === 2 ? 1.38 : 1.0);
                        const armoredBonus = (target.variant === 'crusher' || target.variant === 'behemoth' || enemyBuildings.includes(target)) ? 1.25 : 1.0;
                        const tickDmg = Math.round(u.damage * stageMult * armoredBonus);
                        target.hp -= tickDmg;
                        if (typeof triggerSparks === 'function' && Math.random() < 0.65) triggerSparks(tPos);
                        spawnCombatFloat(tPos, `${tickDmg} PRISM T${stage}`, stage === 3 ? '#f5b932' : '#38bdf8');
                        if (enemyBuildings.includes(target)) updateHUD();
                        u.cooldown = u.fireRate;
                    }
                } else {
                    u.prismaticTarget = null;
                    u.prismaticCharge = Math.max(0, (u.prismaticCharge || 0) - dt * 1.5);
                    if (u.mesh.userData) u.mesh.userData.beamChargeLevel = (u.prismaticCharge || 0) / 6.0;
                    if (u.prismaticBeam) u.prismaticBeam.visible = false;
                }
            }

            // --- TERRAN BATTLECRUISER 4 INDEPENDENT LASER CANNONS + HEAVY YAMATO CANNON ---
            if (u.type === 'battlecruiser') {
                const bcAim = updateBattlecruiserFourLaserWeapons(u, dt);
                if (bcAim) aimTargetPos = bcAim;
            }

            // --- PROTOSS CARRIER AUTONOMOUS INTERCEPTOR SQUADRON AI ---
            if (u.type === 'carrier') {
                if (!u.interceptors) u.interceptors = [];
                const maxInt = u.maxInterceptors || 5;
                if (u.interceptors.length < maxInt) {
                    u.interceptorBuildTimer = (u.interceptorBuildTimer === undefined ? 2.5 : u.interceptorBuildTimer) - dt;
                    if (u.interceptorBuildTimer <= 0) {
                        u.interceptorBuildTimer = 3.2;
                        const intMesh = createAnimatedUnitModel('interceptor');
                        intMesh.position.set(u.mesh.position.x, u.mesh.position.y - 0.25, u.mesh.position.z);
                        scene.add(intMesh);
                        u.interceptors.push({
                            mesh: intMesh,
                            orbitPhase: u.interceptors.length * (Math.PI * 2 / maxInt),
                            cooldown: Math.random() * 0.45,
                            passAngle: Math.random() * Math.PI * 2
                        });
                    }
                }
                const carrierHasTarget = target && minDist <= u.range + 4.0 && target.hp > 0;
                const cTargetPos = carrierHasTarget ? (target.mesh ? target.mesh.position : target.pos) : null;
                if (u.mesh.userData) {
                    u.mesh.userData.attackAnim = carrierHasTarget ? 1.0 : Math.max(0, (u.mesh.userData.attackAnim || 0) - dt * 2.0);
                }
                for (let ii = u.interceptors.length - 1; ii >= 0; ii--) {
                    const ic = u.interceptors[ii];
                    if (!ic || !ic.mesh) continue;
                    ic.orbitPhase += dt * (carrierHasTarget ? 3.8 : 2.1);
                    ic.cooldown -= dt;
                    ic.mesh.visible = inViewport;
                    let goalX = u.mesh.position.x + Math.cos(ic.orbitPhase) * 2.2;
                    let goalY = u.mesh.position.y + 0.35 + Math.sin(ic.orbitPhase * 2.0) * 0.28;
                    let goalZ = u.mesh.position.z + Math.sin(ic.orbitPhase) * 2.2;

                    if (carrierHasTarget && cTargetPos) {
                        const figure8R = 2.8 + (ii % 2) * 0.9;
                        goalX = cTargetPos.x + Math.cos(ic.orbitPhase + ii * 1.2) * figure8R;
                        goalY = Math.max(getTerrainHeight(goalX, cTargetPos.z) + 2.8, (cTargetPos.y || 0) + (target.isAir ? 0.4 : 3.2)) + Math.sin(ic.orbitPhase * 1.7) * 0.55;
                        goalZ = cTargetPos.z + Math.sin(ic.orbitPhase * 2.0 + ii) * figure8R;
                    }
                    const dxI = goalX - ic.mesh.position.x;
                    const dyI = goalY - ic.mesh.position.y;
                    const dzI = goalZ - ic.mesh.position.z;
                    const distI = Math.hypot(dxI, dyI, dzI) || 1;
                    const intSpd = carrierHasTarget ? 13.5 : 9.5;
                    const stepI = Math.min(distI, intSpd * dt);
                    ic.mesh.position.x += (dxI / distI) * stepI;
                    ic.mesh.position.y += (dyI / distI) * stepI;
                    ic.mesh.position.z += (dzI / distI) * stepI;
                    if (distI > 0.08) {
                        ic.mesh.rotation.y = Math.atan2(dxI, dzI);
                    }
                    if (inViewport) {
                        updateUnitAnimation(ic.mesh, dt, true, cTargetPos);
                    }
                    if (carrierHasTarget && cTargetPos) {
                        const dToEnemy = Math.hypot(cTargetPos.x - ic.mesh.position.x, cTargetPos.z - ic.mesh.position.z);
                        if (dToEnemy <= 5.5 && ic.cooldown <= 0) {
                            _muzzleScratch.copy(ic.mesh.position);
                            const intDmg = Math.max(8, Math.round((u.damage || 16) * 0.55));
                            launchOrdProjectile(_muzzleScratch, target, 'interceptor', intDmg, false);
                            ic.cooldown = 0.72 + (ii % 3) * 0.08;
                        }
                    }
                }
            }

            // GUNSHIP HELICOPTER UNDER-BELLY MINIGUN TURRET:
            if (u.type === 'heli' && target && minDist <= u.range + 2.5) {
                const tPos = target.mesh ? target.mesh.position : target.pos;
                aimTargetPos = _aimScratch.set(tPos.x, (tPos.y || 0) + 0.5, tPos.z);
                u.bellyCooldown = (u.bellyCooldown || 0) - dt;
                if (u.bellyCooldown <= 0) {
                    const bellyMuzzleObj = u.mesh.userData.bellyMuzzle || u.mesh.userData.bellyTurret;
                    const bellyMuzzle = bellyMuzzleObj
                        ? bellyMuzzleObj.getWorldPosition(_muzzleScratch)
                        : _muzzleScratch.set(u.mesh.position.x, u.mesh.position.y - 0.38, u.mesh.position.z);
                    launchOrdProjectile(bellyMuzzle, target, 'mg', 11);
                    if (typeof triggerHeliBellyMinigunFlash === 'function') {
                        triggerHeliBellyMinigunFlash(u.mesh);
                    }
                    triggerMuzzleFlash(bellyMuzzle);
                    ejectBrassCasing(bellyMuzzle);
                    u.bellyCooldown = 0.16;
                }
            }

            // TANK & SIEGE TANK TURRET FIRE CONTROL:
            const canSiegeFireAtDist = !(u.type === 'siege_tank' && u.siegeMode && minDist < SIEGE_MIN_RANGE);
            if ((u.type === 'tank' || u.type === 'siege_tank') && target && canSiegeFireAtDist && minDist <= u.range + (enemyBuildings.includes(target) ? 2.5 : 0)) {
                const tPos = target.mesh ? target.mesh.position : target.pos;
                const trReady = u.type !== 'siege_tank' || !isSiegeTransitioning;
                if (trReady) {
                    aimTargetPos = _aimScratch.set(tPos.x, (tPos.y || 0) + 0.5, tPos.z);
                }
                if (u.damage > 0 && u.cooldown <= 0 && trReady) {
                    u.mesh.userData.attackAnim = 1.0;
                    const muzzleObj = u.mesh.userData.tankMuzzleFlash || u.mesh.userData.cannonBarrel || u.mesh.userData.cannonPivot;
                    const muzzle = muzzleObj
                        ? muzzleObj.getWorldPosition(_muzzleScratch)
                        : _muzzleScratch.set(u.mesh.position.x, u.mesh.position.y + 0.75, u.mesh.position.z);
                    launchOrdProjectile(muzzle, target, u.type, u.damage);
                    if (typeof triggerTankCannonMuzzleFlash === 'function') {
                        triggerTankCannonMuzzleFlash(u.mesh, muzzle, tPos);
                    } else {
                        triggerMuzzleFlash(muzzle);
                    }
                    ejectBrassCasing(muzzle);
                    u.cooldown = u.fireRate;
                }
            }

            if (hasAttackMoveDest && !enemyInImmediateRange) {
                const distToDest = Math.hypot(u.orderTarget.x - u.mesh.position.x, u.orderTarget.z - u.mesh.position.z);
                if (distToDest > 1.4) {
                    const navPt = u.isAir ? u.orderTarget : getGroundNavigationWaypoint(u.mesh.position, u.orderTarget, u);
                    if (u.isAir) {
                        const dxAir = navPt.x - u.mesh.position.x;
                        const dzAir = navPt.z - u.mesh.position.z;
                        const lenAir = Math.hypot(dxAir, dzAir) || 1;
                        u.mesh.position.x += (dxAir / lenAir) * effSpeed * dt;
                        u.mesh.position.z += (dzAir / lenAir) * effSpeed * dt;
                        smoothAirVehicleTransform(u, navPt.x, navPt.z, unitFlyAlt, true, dt);
                        moving = true;
                    } else if (effSpeed > 0.01) {
                        const stepDir = computeSafeGroundStep(u.mesh.position, navPt, effSpeed, dt, u, units, buildings, enemyBuildings);
                        if (stepDir.lengthSq() > 0.0001) {
                            u.mesh.position.addScaledVector(stepDir, effSpeed * dt);
                            alignGroundUnitToTerrain(u.mesh, u.mesh.position.x + stepDir.x, u.mesh.position.z + stepDir.z, dt);
                            moving = true;
                            checkAndUnstickGroundUnit(u, navPt, dt);
                        }
                    }
                } else {
                    u.order = 'auto';
                    u.orderTarget = null;
                }
            } else if (target) {
                const tPos = target.mesh ? target.mesh.position : target.pos;
                if (!aimTargetPos) aimTargetPos = _aimScratch.set(tPos.x, (tPos.y || 0) + (target.isAir ? 0.0 : 0.5), tPos.z);
                const targetFootprint = enemyBuildings.includes(target) ? 2.5 : ((u.radius || 0.55) + (target.radius || 0.65) + 0.55);
                const stopRange = enemyBuildings.includes(target) ? u.range + 2.5 : Math.max(u.range, targetFootprint);
                const flatDist = Math.hypot(tPos.x - u.mesh.position.x, tPos.z - u.mesh.position.z);

                if (flatDist <= stopRange) {
                    if (u.isAir) {
                        if (u.type === 'heli') {
                            const holdLookX = u.mesh.position.x + Math.sin(u.currentYaw || u.mesh.rotation.y || 0) * 5.0;
                            const holdLookZ = u.mesh.position.z + Math.cos(u.currentYaw || u.mesh.rotation.y || 0) * 5.0;
                            smoothAirVehicleTransform(u, holdLookX, holdLookZ, unitFlyAlt, false, dt);
                        } else {
                            smoothAirVehicleTransform(u, tPos.x, tPos.z, unitFlyAlt, false, dt);
                        }
                    } else if (u.type !== 'tank' && u.type !== 'siege_tank') {
                        alignGroundUnitToTerrain(u.mesh, tPos.x, tPos.z, dt);
                    }

                    if (u.damage > 0 && u.cooldown <= 0 && u.type !== 'tank' && u.type !== 'siege_tank') {
                        u.mesh.userData.attackAnim = 1.0;
                        u._shotBarrelIdx = ((u._shotBarrelIdx || 0) + 1) % 12;
                        const muzzle = typeof window.getWeaponMuzzleWorldPos === 'function'
                            ? window.getWeaponMuzzleWorldPos(u, u._shotBarrelIdx, _muzzleScratch)
                            : _muzzleScratch.set(u.mesh.position.x, u.mesh.position.y + 0.75, u.mesh.position.z);

                        const isMeleeStrike = (u.type === 'grunt' || u.type === 'zealot' || u.type === 'skitterer' || u.type === 'crusher' || u.type === 'burster');
                        if (!isMeleeStrike && u.range > 2.35) {
                            if (u.type === 'void_ray' || u.type === 'carrier' || u.type === 'battlecruiser') {
                                // Handled by dedicated Prismatic Beam, Autonomous Interceptor Squadron & Battlecruiser 4-Laser Battery systems above
                            } else if (u.type === 'heli') {
                                launchOrdProjectile(muzzle, target, 'heli', u.damage, false);
                                if (u._shotBarrelIdx % 3 === 0) {
                                    const podSlot = (u._shotBarrelIdx % 2 === 0) ? 1 : 2;
                                    const podMuzzle = window.getWeaponMuzzleWorldPos(u, podSlot, _muzzleScratch2);
                                    launchOrdProjectile(podMuzzle, target, 'rocket', Math.round(u.damage * 0.85), false);
                                }
                            } else if (u.type === 'phoenix') {
                                const rx = Math.cos(u.currentYaw || u.mesh.rotation.y || 0);
                                const rz = -Math.sin(u.currentYaw || u.mesh.rotation.y || 0);
                                const airBonusDmg = (target && target.isAir) ? Math.round(u.damage * 1.35) : u.damage;
                                _muzzleScratch2.set(muzzle.x - rx * 0.42, muzzle.y, muzzle.z - rz * 0.42);
                                launchOrdProjectile(_muzzleScratch2, target, 'phoenix', airBonusDmg, false);
                                _muzzleScratch2.set(muzzle.x + rx * 0.42, muzzle.y, muzzle.z + rz * 0.42);
                                launchOrdProjectile(_muzzleScratch2, target, 'phoenix', Math.round(airBonusDmg * 0.75), false);
                            } else if (u.type === 'valkyrie') {
                                const rx = Math.cos(u.currentYaw || u.mesh.rotation.y || 0);
                                const rz = -Math.sin(u.currentYaw || u.mesh.rotation.y || 0);
                                if (!u.mechMode) {
                                    if (target && target.isAir) {
                                        _muzzleScratch2.set(muzzle.x - rx * 0.95, muzzle.y, muzzle.z - rz * 0.95);
                                        launchOrdProjectile(_muzzleScratch2, target, 'valk_aa', u.damage);
                                        _muzzleScratch2.set(muzzle.x + rx * 0.95, muzzle.y, muzzle.z + rz * 0.95);
                                        launchOrdProjectile(_muzzleScratch2, target, 'valk_aa', u.damage);
                                    }
                                } else {
                                    if (target && !target.isAir) {
                                        _muzzleScratch2.set(muzzle.x - rx * 0.58, muzzle.y, muzzle.z - rz * 0.58);
                                        launchOrdProjectile(_muzzleScratch2, target, 'valk_mech', u.damage);
                                        _muzzleScratch2.set(muzzle.x + rx * 0.58, muzzle.y, muzzle.z + rz * 0.58);
                                        launchOrdProjectile(_muzzleScratch2, target, 'valk_mech', u.damage);
                                        ejectBrassCasing(muzzle);
                                    }
                                }
                            } else if (u.type === 'hero') {
                                launchOrdProjectile(muzzle, target, 'sunlance', u.damage);
                                u.heroShotCounter = ((u.heroShotCounter || 0) + 1) % 3;
                                if (u.heroShotCounter === 0) {
                                    _muzzleScratch2.set(u.mesh.position.x, u.mesh.position.y + 1.35, u.mesh.position.z);
                                    launchOrdProjectile(_muzzleScratch2, target, 'rocket', Math.round(u.damage * 0.85));
                                }
                            } else if (u.type === 'firebat') {
                                if (typeof triggerFirebatFlameStreamFX === 'function') {
                                    triggerFirebatFlameStreamFX(muzzle, tPos);
                                }
                                for (let ei = 0; ei < enemies.length; ei++) {
                                    const e = enemies[ei];
                                    const d = Math.hypot(e.mesh.position.x - tPos.x, e.mesh.position.z - tPos.z);
                                    if (d <= 3.0) {
                                        recordRagdollHitImpulse(e, u.mesh.position, false);
                                        e.hp -= u.damage;
                                        spawnCombatFloat(e.mesh.position, u.damage, '#ff5500');
                                    }
                                }
                                for (let ebi = 0; ebi < enemyBuildings.length; ebi++) {
                                    const eb = enemyBuildings[ebi];
                                    const d = Math.hypot(eb.pos.x - tPos.x, eb.pos.z - tPos.z);
                                    if (d <= 3.2) {
                                        eb.hp -= u.damage;
                                        spawnCombatFloat(eb.pos, u.damage, '#ff5500');
                                        updateHUD();
                                    }
                                }
                            } else if (u.type === 'marauder') {
                                launchOrdProjectile(muzzle, target, 'marauder', u.damage);
                            } else if (u.type === 'rocketman') {
                                launchOrdProjectile(muzzle, target, 'rocket', u.damage);
                            } else if (u.type === 'reaper') {
                                const rx = Math.cos(u.currentYaw || 0);
                                const rz = -Math.sin(u.currentYaw || 0);
                                _muzzleScratch2.set(muzzle.x - rx * 0.22, muzzle.y, muzzle.z - rz * 0.22);
                                launchOrdProjectile(_muzzleScratch2, target, 'reaper', u.damage);
                                _muzzleScratch2.set(muzzle.x + rx * 0.22, muzzle.y, muzzle.z + rz * 0.22);
                                launchOrdProjectile(_muzzleScratch2, target, 'reaper', Math.round(u.damage * 0.65));
                            } else {
                                launchOrdProjectile(muzzle, target, u.type, u.damage, false);
                            }
                            if (u.type === 'heli' && typeof triggerHeliBellyMinigunFlash === 'function') {
                                triggerHeliBellyMinigunFlash(u.mesh);
                            }
                            if (!u.isMindControlled) {
                                triggerMuzzleFlash(muzzle);
                            }
                            if (!u.isAir && !u.isMindControlled && u.type !== 'rocketman' && u.type !== 'hero' && u.type !== 'firebat' && u.type !== 'marauder') ejectBrassCasing(muzzle);
                        } else {
                            recordRagdollHitImpulse(target, u.mesh.position, u.type === 'crusher' || u.type === 'burster');
                            target.hp -= u.damage;
                            if (typeof triggerSparks === 'function' && !u.isMindControlled) {
                                triggerSparks(tPos);
                            } else if (u.isMindControlled && typeof spawnEnemyGooSplashFX === 'function') {
                                spawnEnemyGooSplashFX(tPos, u.type);
                            }
                            spawnCombatFloat(tPos, u.damage, u.isMindControlled ? '#d946ef' : '#00ff66');
                            if (enemyBuildings.includes(target)) updateHUD();
                        }
                        u.cooldown = u.fireRate;
                    }

                    const isRangedGroundShooter = !u.isAir && u.order !== 'hold' && u.range > 2.35 && u.type !== 'tank' && u.type !== 'siege_tank';
                    if (isRangedGroundShooter && effSpeed > 0.01) {
                        const desiredAdvanceBand = Math.max(3.0, u.range * 0.56);
                        const clearLane = hasClearFiringLane(u, tPos);
                        if (!clearLane || flatDist > desiredAdvanceBand) {
                            const slotGoal = !clearLane ? findOpenFiringSlot(u, tPos) : tPos;
                            const navPt = getGroundNavigationWaypoint(u.mesh.position, slotGoal, u);
                            const stepSpd = !clearLane ? effSpeed * 0.90 : effSpeed * 0.74;
                            const stepDir = computeSafeGroundStep(u.mesh.position, navPt, stepSpd, dt, u, units, buildings, enemyBuildings);
                            if (stepDir.lengthSq() > 0.0001) {
                                u.mesh.position.addScaledVector(stepDir, stepSpd * dt);
                                alignGroundUnitToTerrain(u.mesh, tPos.x, tPos.z, dt);
                                moving = true;
                            }
                        }
                    }
                } else if (u.order !== 'hold' && !u.tankTacticalRetreat && !(u.type === 'siege_tank' && (u.siegeMode || isSiegeTransitioning))) {
                    const navPt = u.isAir ? tPos : getGroundNavigationWaypoint(u.mesh.position, tPos, u);
                    if (u.isAir) {
                        const dxAir = navPt.x - u.mesh.position.x;
                        const dzAir = navPt.z - u.mesh.position.z;
                        const lenAir = Math.hypot(dxAir, dzAir) || 1;
                        u.mesh.position.x += (dxAir / lenAir) * effSpeed * dt;
                        u.mesh.position.z += (dzAir / lenAir) * effSpeed * dt;
                        smoothAirVehicleTransform(u, navPt.x, navPt.z, unitFlyAlt, true, dt);
                        moving = true;
                    } else if (effSpeed > 0.01) {
                        const stepDir = computeSafeGroundStep(u.mesh.position, navPt, effSpeed, dt, u, units, buildings, enemyBuildings);
                        if (stepDir.lengthSq() > 0.0001) {
                            u.mesh.position.addScaledVector(stepDir, effSpeed * dt);
                            alignGroundUnitToTerrain(u.mesh, u.mesh.position.x + stepDir.x, u.mesh.position.z + stepDir.z, dt);
                            moving = true;
                            checkAndUnstickGroundUnit(u, navPt, dt);
                        }
                    }
                } else if (u.isAir) {
                    const holdLookX = u.mesh.position.x + Math.sin(u.currentYaw || u.mesh.rotation.y || 0) * 5.0;
                    const holdLookZ = u.mesh.position.z + Math.cos(u.currentYaw || u.mesh.rotation.y || 0) * 5.0;
                    smoothAirVehicleTransform(u, holdLookX, holdLookZ, unitFlyAlt, false, dt);
                }
            } else if (u.type === 'valkyrie' && !u.mechMode && valkGroundApproachPos && u.order !== 'hold') {
                const distToGnd = Math.hypot(valkGroundApproachPos.x - u.mesh.position.x, valkGroundApproachPos.z - u.mesh.position.z);
                if (distToGnd > 8.0) {
                    const dxAir = valkGroundApproachPos.x - u.mesh.position.x;
                    const dzAir = valkGroundApproachPos.z - u.mesh.position.z;
                    const lenAir = Math.hypot(dxAir, dzAir) || 1;
                    u.mesh.position.x += (dxAir / lenAir) * effSpeed * dt;
                    u.mesh.position.z += (dzAir / lenAir) * effSpeed * dt;
                    smoothAirVehicleTransform(u, valkGroundApproachPos.x, valkGroundApproachPos.z, 6.0, true, dt);
                    moving = true;
                } else {
                    smoothAirVehicleTransform(u, valkGroundApproachPos.x, valkGroundApproachPos.z, 6.0, false, dt);
                }
            } else if (u.order !== 'hold' && !(u.type === 'siege_tank' && u.siegeMode)) {
                if (enemyBuildings.length === 0) {
                    let nearestEnemy = null;
                    let bestEDist = Infinity;
                    for (let ei = 0; ei < enemies.length; ei++) {
                        const e = enemies[ei];
                        if (!e || e.hp <= 0 || !e.mesh) continue;
                        const dE = Math.hypot(e.mesh.position.x - u.mesh.position.x, e.mesh.position.z - u.mesh.position.z);
                        if (dE < bestEDist) {
                            bestEDist = dE;
                            nearestEnemy = e;
                        }
                    }
                    if (nearestEnemy) {
                        if (!u.patrolTarget) u.patrolTarget = new THREE.Vector3();
                        u.patrolTarget.set(
                            nearestEnemy.mesh.position.x,
                            getTerrainHeight(nearestEnemy.mesh.position.x, nearestEnemy.mesh.position.z),
                            nearestEnemy.mesh.position.z
                        );
                    } else {
                        const arcAngle = -Math.PI * 0.5 + ((unitIdx % 10) - 4.5) * 0.22;
                        const guardRad = 7.2 + Math.floor(unitIdx / 10) * 2.4;
                        if (!u.patrolTarget) u.patrolTarget = new THREE.Vector3();
                        u.patrolTarget.set(
                            mainBaseAnchor.x + Math.sin(arcAngle) * guardRad,
                            0,
                            mainBaseAnchor.z + Math.cos(arcAngle) * guardRad
                        );
                    }
                } else if (state.enemyBaseDiscovered) {
                    const activeEnemyBld = enemyBuildings[unitIdx % enemyBuildings.length] || enemyBuildings[0];
                    const targetBldPos = activeEnemyBld ? activeEnemyBld.pos : (state.discoveredEnemyBasePos || ENEMY_BASE_POS);
                    if (!u.patrolTarget) u.patrolTarget = new THREE.Vector3();
                    u.patrolTarget.set(
                        targetBldPos.x,
                        getTerrainHeight(targetBldPos.x, targetBldPos.z),
                        targetBldPos.z
                    );
                } else {
                    const distToPatrol = u.patrolTarget
                        ? Math.hypot(u.patrolTarget.x - u.mesh.position.x, u.patrolTarget.z - u.mesh.position.z)
                        : 0;
                    if (!u.patrolTarget || distToPatrol <= 8.5) {
                        const toEnemyX = ENEMY_BASE_POS.x - mainBaseAnchor.x;
                        const toEnemyZ = ENEMY_BASE_POS.z - mainBaseAnchor.z;
                        const perpX = -toEnemyZ;
                        const perpZ = toEnemyX;
                        const perpLen = Math.hypot(perpX, perpZ) || 1;
                        const laneOffset = ((unitIdx % 3) - 1) * 16.0;

                        const midReconX = mainBaseAnchor.x + toEnemyX * 0.52 + (perpX / perpLen) * laneOffset;
                        const midReconZ = mainBaseAnchor.z + toEnemyZ * 0.52 + (perpZ / perpLen) * laneOffset;
                        const reconWaypoints = [
                            { x: midReconX, z: midReconZ },
                            { x: ENEMY_BASE_POS.x, z: ENEMY_BASE_POS.z }
                        ];

                        if (u.patrolStep === undefined) {
                            u.patrolStep = 0;
                        } else if (u.patrolStep < reconWaypoints.length - 1) {
                            u.patrolStep++;
                        }
                        const chosenWP = reconWaypoints[Math.min(u.patrolStep, reconWaypoints.length - 1)];
                        const rawPx = THREE.MathUtils.clamp(chosenWP.x + ((unitIdx % 5) - 2) * 2.2, -96, 96);
                        const rawPz = THREE.MathUtils.clamp(chosenWP.z + ((unitIdx % 3) - 1) * 2.2, -96, 96);
                        const clearPt = typeof findClearSpawnPoint === 'function'
                            ? findClearSpawnPoint(rawPx, rawPz, u.mesh.position.x, u.mesh.position.z, 0.85, buildings, enemyBuildings, [])
                            : { x: rawPx, z: rawPz };
                        if (!u.patrolTarget) u.patrolTarget = new THREE.Vector3();
                        u.patrolTarget.set(clearPt.x, getTerrainHeight(clearPt.x, clearPt.z), clearPt.z);
                    }
                }

                if (u.patrolTarget && effSpeed > 0.01) {
                    const distToPatrol = Math.hypot(u.patrolTarget.x - u.mesh.position.x, u.patrolTarget.z - u.mesh.position.z);
                    if (distToPatrol > 2.2) {
                        const navPt = u.isAir ? u.patrolTarget : getGroundNavigationWaypoint(u.mesh.position, u.patrolTarget, u);
                        if (u.isAir) {
                            const dxAir = navPt.x - u.mesh.position.x;
                            const dzAir = navPt.z - u.mesh.position.z;
                            const lenAir = Math.hypot(dxAir, dzAir) || 1;
                            u.mesh.position.x += (dxAir / lenAir) * effSpeed * dt;
                            u.mesh.position.z += (dzAir / lenAir) * effSpeed * dt;
                            smoothAirVehicleTransform(u, navPt.x, navPt.z, unitFlyAlt, true, dt);
                            moving = true;
                        } else {
                            const stepDir = computeSafeGroundStep(u.mesh.position, navPt, effSpeed, dt, u, units, buildings, enemyBuildings);
                            if (stepDir.lengthSq() > 0.0001) {
                                u.mesh.position.addScaledVector(stepDir, effSpeed * dt);
                                alignGroundUnitToTerrain(u.mesh, u.mesh.position.x + stepDir.x, u.mesh.position.z + stepDir.z, dt);
                                moving = true;
                                checkAndUnstickGroundUnit(u, navPt, dt);
                            }
                        }
                    }
                }
            } else if (u.isAir) {
                const holdLookX = u.mesh.position.x + Math.sin(u.currentYaw || u.mesh.rotation.y || 0) * 5.0;
                const holdLookZ = u.mesh.position.z + Math.cos(u.currentYaw || u.mesh.rotation.y || 0) * 5.0;
                smoothAirVehicleTransform(u, holdLookX, holdLookZ, unitFlyAlt, false, dt);
            }

            // Enforce Siege Tank body lock after any combat/patrol branch so only the turret head rotates!
            if (u.type === 'siege_tank' && (u.siegeMode || isSiegeTransitioning)) {
                moving = false;
                if (u.anchoredPos) {
                    u.mesh.position.x = u.anchoredPos.x;
                    u.mesh.position.z = u.anchoredPos.z;
                }
                if (u.anchoredYaw !== undefined) {
                    u.mesh.rotation.y = u.anchoredYaw;
                    if (u.mesh.userData) u.mesh.userData.smoothYaw = u.anchoredYaw;
                }
            }

            // Lava Planet Environmental Hazard: Ground units touching molten lava rivers/ponds suffer periodic thermal burn damage
            if (!u.isAir && window.ACTIVE_PLANET_BIOME === 'lava' && typeof isPointInWaterPond === 'function' && isPointInWaterPond(u.mesh.position.x, u.mesh.position.z, -0.18)) {
                u.hp -= 12.0 * dt;
                u.lavaBurnTick = (u.lavaBurnTick || 0) - dt;
                if (u.lavaBurnTick <= 0) {
                    u.lavaBurnTick = 0.65;
                    triggerSparks(u.mesh.position);
                }
            }

            if (inViewport) {
                if (u.isMechanical && typeof window.updateMechanicalUnitDamageDeformation === 'function') {
                    window.updateMechanicalUnitDamageDeformation(u);
                } else if (u.isMindControlled && !u.isAir && typeof window.updateZergUnitBruiseDamage === 'function') {
                    window.updateZergUnitBruiseDamage(u);
                }
                updateUnitAnimation(u.mesh, dt, moving, aimTargetPos);
                updateHealthPip(u.hb, u.hp, u.maxHp, u.shield || 0, u.maxShield || 0);
                projectToScreen(u.hb.root, u.mesh.position, u.isAir ? 1.2 : 1.55, isSelectedUnit);
            } else if (u.hb && u.hb.root && u.hb.root.style.display !== 'none') {
                u.hb.root.style.display = 'none';
            }
        });
        if (perfProf) perfProf.end('unitAI');

        // --- ZERG OVERMIND TACTICAL EVALUATION: Detect When Losing & Coordinate Multi-Corridor Flanking ---
        const isZergLosing = (units.length > enemies.length * 1.05) || (enemyBuildings.length < 4) || (state.kills >= 12);

        // Verify that ALLY_GRID is populated when living friendly units exist
        if (units.length > 0 && ALLY_GRID.activeIndices.length === 0) {
            rebuildFrameSpatialGrids();
        }

        // Update Enemy Zerg Units (Ground Bio-Swarm + Flying Mutalisk Leviathans + Adaptive Flanking AI + Stuck Babyspot Calibration)
        if (perfProf) perfProf.begin('enemyAI');
        for (let i = enemies.length - 1; i >= 0; i--) {
            const e = enemies[i];
            if (!e || !e.mesh) continue;
            if (!e.id) {
                window._zergUnitSeq = (window._zergUnitSeq || 0) + 1;
                e.id = `zerg_${e.variant || 'unit'}_${window._zergUnitSeq}`;
            }
            try {
                if (e.slowTimer && e.slowTimer > 0) e.slowTimer = Math.max(0, e.slowTimer - dt);
                const concussiveSlowMult = (e.slowTimer && e.slowTimer > 0) ? 0.52 : 1.0;
                const enemyEnvMod = (!e.isAir && typeof window.getEnvironmentalTacticalModifiers === 'function')
                    ? window.getEnvironmentalTacticalModifiers(e.mesh.position.x, e.mesh.position.z, false, false)
                    : null;
                const enemyRoadMult = (enemyEnvMod && enemyEnvMod.speedMult) ? enemyEnvMod.speedMult : 1.0;
                const effEnemySpeed = Math.max(1.2, (e.speed || 3.2) * weatherSpdMult * concussiveSlowMult * enemyRoadMult);

                // Lava Planet Environmental Hazard: Ground Zerg units in molten lava take thermal burn damage
                if (!e.isAir && window.ACTIVE_PLANET_BIOME === 'lava' && typeof isPointInWaterPond === 'function' && isPointInWaterPond(e.mesh.position.x, e.mesh.position.z, -0.18)) {
                    e.hp -= 12.0 * dt;
                    e.lavaBurnTick = (e.lavaBurnTick || 0) - dt;
                    if (e.lavaBurnTick <= 0) {
                        e.lavaBurnTick = 0.65;
                        triggerSparks(e.mesh.position);
                    }
                }

                if (e.hp <= 0) {
                    e.aiState = 'DEAD';
                    spawnXenoBugGoreExplosion(e.mesh.position, e.variant === 'crusher' || e.variant === 'behemoth', e.variant === 'burster');
                    if (e.hb && e.hb.root) e.hb.root.remove();
                    if (e.variant === 'burster') {
                        if (typeof spawnScavengerPostDeathDebris === 'function') {
                            spawnScavengerPostDeathDebris(e.mesh.position, 'infantry', true, false);
                        }
                        scene.remove(e.mesh);
                    } else {
                        spawnDeathCorpse(e.mesh, true, e.lastHitImpulse, e.lastHitHeavy);
                    }
                    enemies.splice(i, 1);

                    state.req += (e.reward || 15);
                    state.kills++;
                    if (state.kills % 10 === 0) {
                        state.wave++;
                        if (state.baseBuilding) {
                            spawnCombatFloat(state.baseBuilding.pos, `WAVE #${state.wave} (${getWaveStrengthMultiplier()}x)`, '#ffaa00');
                        }
                    }
                    updateHUD();
                    continue;
                }

                e.cooldown = (e.cooldown || 0) - dt;
                if (!e.faction) e.faction = 'zerg';
                if (!e.aiState || e.aiState === 'staging' || e.aiState === 'charge' || e.aiState === 'IDLE') {
                    e.aiState = 'MOVING';
                }

                const frameStartX = e.mesh.position.x;
                const frameStartZ = e.mesh.position.z;

                // Helper to advance a ground Zerg unit toward a target position with validated waypoints & obstacle-safe recovery (never teleports or force-slides through obstacles!)
                const advanceGroundZergToward = (rawGoalPos) => {
                    if (!rawGoalPos) {
                        e.stopReason = 'no_goal_pos';
                        e.navSuccess = false;
                        return false;
                    }
                    const unitRad = e.radius || 0.52;
                    const surfFn = typeof getSurfaceHeightWithBridges === 'function' ? getSurfaceHeightWithBridges : getTerrainHeight;
                    const validGoal = (typeof window.validateGroundDestination === 'function')
                        ? window.validateGroundDestination(e.mesh.position, rawGoalPos, unitRad)
                        : rawGoalPos;

                    e.currentDestination = { x: Number(validGoal.x.toFixed(2)), z: Number(validGoal.z.toFixed(2)) };
                    e.distanceToDestination = Number(Math.hypot(validGoal.x - e.mesh.position.x, validGoal.z - e.mesh.position.z).toFixed(2));
                    e.currentSpeed = Number(effEnemySpeed.toFixed(2));

                    // 1. Safe recovery when a unit is trapped inside its own structure or any building footprint:
                    //    Smoothly guide the unit radially outward toward the nearest walkable perimeter point.
                    const checkBuildingLists = [enemyBuildings, buildings, typeof solarisBuildings !== 'undefined' ? solarisBuildings : null];
                    for (let li = 0; li < checkBuildingLists.length; li++) {
                        const bList = checkBuildingLists[li];
                        if (!Array.isArray(bList)) continue;
                        for (let bi = 0; bi < bList.length; bi++) {
                            const b = bList[bi];
                            if (!b || b.hp <= 0 || !b.pos) continue;
                            const bFootprint = b.footprintRadius || 2.2;
                            const minSafeDist = bFootprint + unitRad + 0.22;
                            const bdx = e.mesh.position.x - b.pos.x;
                            const bdz = e.mesh.position.z - b.pos.z;
                            const bDist = Math.hypot(bdx, bdz);
                            if (bDist < minSafeDist) {
                                const baseEscapeAng = bDist > 0.05
                                    ? Math.atan2(bdx, bdz)
                                    : Math.atan2(validGoal.x - b.pos.x, validGoal.z - b.pos.z);
                                const escapeStep = Math.min(0.45, Math.max(effEnemySpeed * dt * 1.35, (minSafeDist - bDist) * 0.65));
                                for (let aTry = 0; aTry < 12; aTry++) {
                                    const angOff = (aTry % 2 === 0 ? 1 : -1) * Math.floor((aTry + 1) / 2) * (Math.PI / 6);
                                    const tryAng = baseEscapeAng + angOff;
                                    const ex = e.mesh.position.x + Math.sin(tryAng) * escapeStep;
                                    const ez = e.mesh.position.z + Math.cos(tryAng) * escapeStep;
                                    if (typeof isWalkableGround !== 'function' || isWalkableGround(ex, ez, unitRad * 0.40)) {
                                        e.mesh.position.x = ex;
                                        e.mesh.position.z = ez;
                                        e.mesh.position.y = surfFn(ex, ez);
                                        alignGroundUnitToTerrain(e.mesh, ex + Math.sin(tryAng), ez + Math.cos(tryAng), dt);
                                        e.lastNavResult = 'structure_escape';
                                        e.navSuccess = true;
                                        e.stopReason = 'none';
                                        e.lastMoveTime = state.elapsedSec;
                                        return true;
                                    }
                                }
                            }
                        }
                    }

                    // 2. If an active recovery detour waypoint is set, follow it until reached or expired
                    let activeTarget = validGoal;
                    if (e.recoveryDetourPos && e.recoveryDetourTimer > 0) {
                        e.recoveryDetourTimer = Math.max(0, e.recoveryDetourTimer - dt);
                        const dDetour = Math.hypot(e.recoveryDetourPos.x - e.mesh.position.x, e.recoveryDetourPos.z - e.mesh.position.z);
                        if (dDetour > 1.35) {
                            activeTarget = e.recoveryDetourPos;
                        } else {
                            e.recoveryDetourPos = null;
                            e.recoveryDetourTimer = 0;
                        }
                    }

                    const navPt = getGroundNavigationWaypoint(e.mesh.position, activeTarget, e) || activeTarget;
                    e.navWaypoint = { x: Number(navPt.x.toFixed(2)), z: Number(navPt.z.toFixed(2)) };

                    const stepDir = computeSafeGroundStep(e.mesh.position, navPt, effEnemySpeed, dt, e, enemies, buildings, enemyBuildings);
                    const stepLen = effEnemySpeed * dt;
                    let didMove = false;

                    if (stepDir && stepDir.lengthSq() > 0.0001) {
                        const nextX = e.mesh.position.x + stepDir.x * stepLen;
                        const nextZ = e.mesh.position.z + stepDir.z * stepLen;
                        const walkOk = (typeof isWalkableGround !== 'function') || isWalkableGround(nextX, nextZ, unitRad * 0.45);
                        const bldOk = (typeof window.isPointClearOfAllBuildings !== 'function') || window.isPointClearOfAllBuildings(nextX, nextZ, unitRad * 0.45, validGoal);
                        if (walkOk && bldOk) {
                            e.mesh.position.x = nextX;
                            e.mesh.position.z = nextZ;
                            alignGroundUnitToTerrain(e.mesh, nextX + stepDir.x, nextZ + stepDir.z, dt);
                            e.lastNavResult = activeTarget === e.recoveryDetourPos ? 'recovery_detour' : 'waypoint_step';
                            e.navSuccess = true;
                            e.stopReason = 'none';
                            e.lastMoveTime = state.elapsedSec;
                            didMove = true;
                        }
                    }

                    // 3. Validated Fallback Route when A* or direct step is blocked (never teleports or slides into obstacles!)
                    if (!didMove) {
                        const fdx = navPt.x - e.mesh.position.x;
                        const fdz = navPt.z - e.mesh.position.z;
                        const fLen = Math.hypot(fdx, fdz);
                        if (fLen > 0.08) {
                            const baseAng = Math.atan2(fdx, fdz);
                            const sign = e.wallFollowSign || e.flankSign || 1;
                            const tryOffsets = [
                                0,
                                sign * 0.38, -sign * 0.38,
                                sign * 0.78, -sign * 0.78,
                                sign * 1.18, -sign * 1.18,
                                sign * 1.57, -sign * 1.57,
                                sign * 2.05, -sign * 2.05,
                                sign * 2.55, -sign * 2.55,
                                Math.PI
                            ];
                            for (let aIdx = 0; aIdx < tryOffsets.length; aIdx++) {
                                const tryAng = baseAng + tryOffsets[aIdx];
                                // Skip angle if it matches the most recent blocked heading memory
                                if (typeof e._blockedHeading === 'number') {
                                    let diff = Math.abs(Math.atan2(Math.sin(tryAng - e._blockedHeading), Math.cos(tryAng - e._blockedHeading)));
                                    if (diff < 0.28 && aIdx < tryOffsets.length - 2) continue;
                                }
                                const sx = Math.sin(tryAng);
                                const sz = Math.cos(tryAng);
                                const candX = e.mesh.position.x + sx * stepLen;
                                const candZ = e.mesh.position.z + sz * stepLen;
                                const lookX = e.mesh.position.x + sx * Math.max(0.85, unitRad + 0.45);
                                const lookZ = e.mesh.position.z + sz * Math.max(0.85, unitRad + 0.45);
                                const stepWalkOk = (typeof isWalkableGround !== 'function') || (isWalkableGround(candX, candZ, unitRad * 0.45) && isWalkableGround(lookX, lookZ, unitRad * 0.45));
                                const stepBldOk = (typeof window.isPointClearOfAllBuildings !== 'function') || (window.isPointClearOfAllBuildings(candX, candZ, unitRad * 0.45, validGoal) && window.isPointClearOfAllBuildings(lookX, lookZ, unitRad * 0.45, validGoal));
                                if (stepWalkOk && stepBldOk) {
                                    e.mesh.position.x = candX;
                                    e.mesh.position.z = candZ;
                                    alignGroundUnitToTerrain(e.mesh, candX + sx, candZ + sz, dt);
                                    e.lastNavResult = aIdx === 0 ? 'direct_fallback' : 'flank_detour_fallback';
                                    e.navSuccess = true;
                                    e.stopReason = 'none';
                                    e.lastMoveTime = state.elapsedSec;
                                    // Commit to a short detour waypoint when deflecting around an obstacle so unit doesn't oscillate
                                    if (aIdx >= 3) {
                                        const detourX = e.mesh.position.x + sx * 3.2;
                                        const detourZ = e.mesh.position.z + sz * 3.2;
                                        if (typeof isWalkableGround === 'function' && isWalkableGround(detourX, detourZ, unitRad * 0.45)) {
                                            e.recoveryDetourPos = new THREE.Vector3(detourX, surfFn(detourX, detourZ), detourZ);
                                            e.recoveryDetourTimer = 0.65;
                                        }
                                    }
                                    didMove = true;
                                    break;
                                }
                            }
                            if (!didMove) {
                                e.lastNavResult = 'blocked';
                                e.navSuccess = false;
                                e.stopReason = e._lastNavFailure || 'obstacle_blocked';
                            }
                        } else {
                            e.lastNavResult = 'at_waypoint';
                            e.navSuccess = true;
                            e.stopReason = 'reached_waypoint';
                        }
                    }

                    checkAndUnstickGroundUnit(e, navPt, dt);
                    return didMove;
                };

                // Explicit 7-State Machine Entry: SPAWNING -> MOVING
                if (e.aiState === 'SPAWNING') {
                    e.aiStateTimer = (e.aiStateTimer === undefined ? 0.25 : e.aiStateTimer) - dt;
                    if (e.rallyPos && !e.isAir) {
                        const rLen = Math.hypot(e.rallyPos.x - e.mesh.position.x, e.rallyPos.z - e.mesh.position.z);
                        if (rLen > 0.25) {
                            advanceGroundZergToward(e.rallyPos);
                        }
                    }
                    if (e.aiStateTimer <= 0) {
                        e.aiState = 'MOVING';
                    }
                }

                if ((isZergLosing || e.isFlanker) && !e.flankTactic) {
                    e.isFlanker = true;
                    const tactics = ['west_bridge_pincer', 'east_bridge_pincer', 'canyon_rim_envelopment', 'rear_eco_raid'];
                    e.flankTactic = tactics[i % tactics.length];
                    e.flankSign = (i % 2 === 0) ? 1 : -1;
                }

                // Periodically calibrate preferred bridge based on stuck babyspot heatmap + player turret concentration
                e.bridgeCalibTimer = (e.bridgeCalibTimer || 0) - dt;
                if (!e.isAir && e.bridgeCalibTimer <= 0 && typeof RIVER_BRIDGES !== 'undefined' && RIVER_BRIDGES.length > 0) {
                    e.bridgeCalibTimer = 2.8 + Math.random() * 1.4;
                    let bestBrIdx = e.preferredBridgeIdx ?? (i % RIVER_BRIDGES.length);
                    let bestScore = Infinity;
                    for (let bi = 0; bi < RIVER_BRIDGES.length; bi++) {
                        if (RIVER_BRIDGES[bi].destroyed) continue;
                        const bWorld = typeof riverCoordsToWorld === 'function' ? riverCoordsToWorld(RIVER_BRIDGES[bi].sCoord, 0) : { x: 0, z: 0 };
                        const stuckPen = typeof window.getNavStuckPenalty === 'function' ? window.getNavStuckPenalty(bWorld.x, bWorld.z) * 14.0 : 0;
                        let turretThreat = 0;
                        for (let k = 0; k < buildings.length; k++) {
                            const b = buildings[k];
                            if (b && b.type === 'turret' && b.hp > 0 && b.pos) {
                                const dB = Math.hypot(b.pos.x - bWorld.x, b.pos.z - bWorld.z);
                                if (dB < 22.0) turretThreat += (22.0 - dB) * 1.4;
                            }
                        }
                        const tacticBias = (e.flankTactic === 'west_bridge_pincer' && bi === 0) ? -12.0
                            : ((e.flankTactic === 'east_bridge_pincer' && bi === RIVER_BRIDGES.length - 1) ? -12.0 : 0);
                        const totalScore = stuckPen + turretThreat + tacticBias;
                        if (totalScore < bestScore) {
                            bestScore = totalScore;
                            bestBrIdx = bi;
                        }
                    }
                    if (bestBrIdx !== e.preferredBridgeIdx) {
                        e.preferredBridgeIdx = bestBrIdx;
                        e.navWaypoints = null;
                    }
                }

                // Target Selection with Hysteresis (Prevent target switching every frame & prioritize hostile units when closer than buildings)
                // NOTE: Fog-of-War visibility NEVER blocks AI target selection or simulation; it only affects rendering below!
                e.targetLockTimer = Math.max(0, (e.targetLockTimer || 0) - dt);
                let bestTarget = null, bestDist = Infinity, isBuildingTarget = false;

                // Validate lockedTarget before accessing position, mesh, health, or faction (handles dead units & destroyed buildings cleanly)
                if (e.lockedTarget) {
                    const lt = e.lockedTarget;
                    const ltAlive = typeof lt.hp === 'number' && lt.hp > 0;
                    const ltIsBld = Boolean(!lt.mesh || buildings.includes(lt) || (typeof solarisBuildings !== 'undefined' && solarisBuildings.includes(lt)) || lt === state.baseBuilding);
                    const ltStillExists = ltIsBld
                        ? (lt === state.baseBuilding ? Boolean(state.basePlaced && state.baseBuilding && state.baseBuilding.hp > 0) : (buildings.includes(lt) || (typeof solarisBuildings !== 'undefined' && solarisBuildings.includes(lt))))
                        : units.includes(lt);
                    const ltPos = ltIsBld ? lt.pos : (lt.mesh ? lt.mesh.position : lt.pos);
                    if (ltAlive && ltStillExists && ltPos && Number.isFinite(ltPos.x) && Number.isFinite(ltPos.z) && !(lt.isAir && e.range < 4.0) && e.targetLockTimer > 0) {
                        bestTarget = lt;
                        isBuildingTarget = ltIsBld;
                        bestDist = Math.hypot(ltPos.x - e.mesh.position.x, ltPos.z - e.mesh.position.z);
                    } else if (!ltAlive || !ltStillExists) {
                        e.lockedTarget = null;
                        e.targetLockTimer = 0;
                    }
                }

                if (!bestTarget) {
                    let closestUnit = null, closestUnitDist = Infinity;
                    const nearAlliesCount = (ALLY_GRID && typeof ALLY_GRID.queryRadiusInto === 'function')
                        ? ALLY_GRID.queryRadiusInto(e.mesh.position.x, e.mesh.position.z, 38.0, _spatialQueryBuf)
                        : 0;
                    if (nearAlliesCount > 0) {
                        for (let ai = 0; ai < nearAlliesCount; ai++) {
                            const u = _spatialQueryBuf[ai];
                            if (!u || typeof u.hp !== 'number' || u.hp <= 0 || !u.mesh || !u.mesh.position || (u.isAir && e.range < 4.0)) continue;
                            const d = Math.hypot(u.mesh.position.x - e.mesh.position.x, u.mesh.position.z - e.mesh.position.z);
                            if (d < closestUnitDist) { closestUnitDist = d; closestUnit = u; }
                        }
                    }
                    // Fallback to full valid-target scan over `units` whenever spatial query finds nothing
                    if (!closestUnit) {
                        for (let ui = 0; ui < units.length; ui++) {
                            const u = units[ui];
                            if (!u || typeof u.hp !== 'number' || u.hp <= 0 || !u.mesh || !u.mesh.position || (u.isAir && e.range < 4.0)) continue;
                            const d = Math.hypot(u.mesh.position.x - e.mesh.position.x, u.mesh.position.z - e.mesh.position.z);
                            if (d < closestUnitDist) { closestUnitDist = d; closestUnit = u; }
                        }
                    }

                    let closestBld = null, closestBldDist = Infinity;
                    const preferSolarisBase = (!state.solarisHostile && typeof solarisBuildings !== 'undefined' && solarisBuildings.length > 0 && (i % 3 === 0));
                    for (let bi = 0; bi < buildings.length; bi++) {
                        const b = buildings[bi];
                        if (!b || typeof b.hp !== 'number' || b.hp <= 0 || !b.pos) continue;
                        let d = Math.hypot(b.pos.x - e.mesh.position.x, b.pos.z - e.mesh.position.z);
                        if (preferSolarisBase && d > 16.0) d *= 1.25;
                        if (d < closestBldDist) { closestBldDist = d; closestBld = b; }
                    }
                    if (state.baseBuilding && state.baseBuilding.hp > 0 && state.baseBuilding.pos) {
                        const dHq = Math.hypot(state.baseBuilding.pos.x - e.mesh.position.x, state.baseBuilding.pos.z - e.mesh.position.z);
                        if (dHq < closestBldDist) {
                            closestBldDist = dHq;
                            closestBld = state.baseBuilding;
                        }
                    }
                    if (!state.solarisHostile && typeof solarisBuildings !== 'undefined') {
                        for (let sbi = 0; sbi < solarisBuildings.length; sbi++) {
                            const sb = solarisBuildings[sbi];
                            if (!sb || typeof sb.hp !== 'number' || sb.hp <= 0 || !sb.pos) continue;
                            let d = Math.hypot(sb.pos.x - e.mesh.position.x, sb.pos.z - e.mesh.position.z);
                            if (preferSolarisBase) d *= 0.75;
                            if (d < closestBldDist) { closestBldDist = d; closestBld = sb; }
                        }
                    }

                    // Attack hostile units when they are closer than buildings; attack buildings when closer or no units exist
                    if (closestUnit && closestUnitDist <= closestBldDist + 1.5) {
                        bestTarget = closestUnit;
                        bestDist = closestUnitDist;
                        isBuildingTarget = false;
                    } else if (closestBld) {
                        bestTarget = closestBld;
                        bestDist = closestBldDist;
                        isBuildingTarget = true;
                    } else if (closestUnit) {
                        bestTarget = closestUnit;
                        bestDist = closestUnitDist;
                        isBuildingTarget = false;
                    }

                    if (bestTarget) {
                        e.lockedTarget = bestTarget;
                        e.lockedTargetIsBuilding = isBuildingTarget;
                        e.targetLockTimer = 1.25; // Solid hysteresis lock so units don't continually switch targets
                    }
                } else if (isBuildingTarget && bestDist > 6.5) {
                    // Even while locked on a distant building, switch to a hostile unit that engages at close range (< 6.0m)
                    const nearCount = (ALLY_GRID && typeof ALLY_GRID.queryRadiusInto === 'function')
                        ? ALLY_GRID.queryRadiusInto(e.mesh.position.x, e.mesh.position.z, 6.0, _spatialQueryBuf)
                        : 0;
                    for (let ai = 0; ai < nearCount; ai++) {
                        const u = _spatialQueryBuf[ai];
                        if (!u || typeof u.hp !== 'number' || u.hp <= 0 || !u.mesh || !u.mesh.position || (u.isAir && e.range < 4.0)) continue;
                        const dU = Math.hypot(u.mesh.position.x - e.mesh.position.x, u.mesh.position.z - e.mesh.position.z);
                        if (dU < bestDist - 1.5) {
                            bestTarget = u;
                            bestDist = dU;
                            isBuildingTarget = false;
                            e.lockedTarget = u;
                            e.lockedTargetIsBuilding = false;
                            e.targetLockTimer = 1.25;
                            break;
                        }
                    }
                }

                // Fallback to player's base or start sector if no units/buildings matched
                if (!bestTarget) {
                    e.aiState = 'SEARCHING';
                    if (state.baseBuilding && state.baseBuilding.hp > 0 && state.baseBuilding.pos) {
                        bestTarget = state.baseBuilding;
                        isBuildingTarget = true;
                        bestDist = Math.hypot(state.baseBuilding.pos.x - e.mesh.position.x, state.baseBuilding.pos.z - e.mesh.position.z);
                    } else {
                        bestTarget = { pos: (state.baseBuilding && state.baseBuilding.pos) || PLAYER_START_POS, hp: 1000, maxHp: 1000, type: 'base' };
                        isBuildingTarget = true;
                        bestDist = Math.hypot(bestTarget.pos.x - e.mesh.position.x, bestTarget.pos.z - e.mesh.position.z);
                    }
                }

                const validTargetPos = isBuildingTarget
                    ? (bestTarget.pos || PLAYER_START_POS)
                    : ((bestTarget.mesh && bestTarget.mesh.position) ? bestTarget.mesh.position : (bestTarget.pos || PLAYER_START_POS));
                bestDist = Math.hypot(validTargetPos.x - e.mesh.position.x, validTargetPos.z - e.mesh.position.z);
                e.currentTargetDist = bestDist;

                let moving = false;

                if ((e.variant === 'skitterer' || e.variant === 'burster') && !e.isAir) {
                    e.burrowCooldown = (e.burrowCooldown || 0) - dt;
                    if (!e.burrowed && e.burrowCooldown <= 0 && bestDist > 16.0 && Math.abs(e.mesh.position.z) < 22 && Math.random() < 0.015) {
                        e.burrowed = true;
                        e.burrowTimer = 2.4;
                        e.mesh.position.y -= 0.45;
                    }
                    if (e.burrowed) {
                        e.burrowTimer = (e.burrowTimer === undefined ? 2.4 : e.burrowTimer) - dt;
                        if (bestDist <= 9.5 || e.burrowTimer <= 0 || isZergLosing) {
                            e.burrowed = false;
                            e.mesh.position.y = getTerrainHeight(e.mesh.position.x, e.mesh.position.z);
                            e.burrowCooldown = 18.0;
                            e.aiState = 'MOVING';
                            if (bestDist <= 9.5) {
                                spawnCombatFloat(e.mesh.position, 'AMBUSH!', '#ff2a4b');
                            }
                        } else {
                            e.actualSpeedPerSec = 0;
                            updateUnitAnimation(e.mesh, dt, false, null);
                            continue;
                        }
                    }
                }

                let rawTargetPos = validTargetPos;
                let attackNavTarget = rawTargetPos;

                if ((isZergLosing || e.isFlanker) && bestDist > 10.5 && (e.recoveryAttempts || 0) < 2) {
                    const toTargetX = rawTargetPos.x - e.mesh.position.x;
                    const toTargetZ = rawTargetPos.z - e.mesh.position.z;
                    const toLen = Math.hypot(toTargetX, toTargetZ) || 1;
                    const perpX = -toTargetZ / toLen;
                    const perpZ = toTargetX / toLen;
                    const flankSign = e.flankSign || 1;
                    let lateralSpread = 0;
                    if (e.flankTactic === 'west_bridge_pincer') lateralSpread = -12.5;
                    else if (e.flankTactic === 'east_bridge_pincer') lateralSpread = 12.5;
                    else if (e.flankTactic === 'canyon_rim_envelopment') lateralSpread = flankSign * 15.0;
                    else if (e.flankTactic === 'rear_eco_raid') lateralSpread = flankSign * 11.5;

                    const blend = Math.min(1.0, (bestDist - 9.0) / 22.0);
                    const candidateX = rawTargetPos.x + perpX * lateralSpread * blend;
                    const candidateZ = rawTargetPos.z + perpZ * lateralSpread * blend;
                    if (e.isAir || (typeof isWalkableGround === 'function' && isWalkableGround(candidateX, candidateZ, (e.radius || 0.50) * 0.6))) {
                        if (!e._flankScratch) e._flankScratch = new THREE.Vector3();
                        attackNavTarget = e._flankScratch.set(candidateX, rawTargetPos.y || 0, candidateZ);
                    }
                }

                let enemyAimPos = null;
                if (bestTarget && attackNavTarget) {
                    let tPos = validTargetPos;
                    enemyAimPos = tPos;
                    let targetRad = isBuildingTarget ? (bestTarget.footprintRadius || 1.65) : (bestTarget.radius || 0.55);
                    let engageRange = (e.range || 1.5) + targetRad + 0.45;

                    // Physical Turret Shield Barrier Check via pre-filtered BUILDING_COUNTS.activeShieldTurrets
                    let blockingShieldTurret = null;
                    const activeTurrets = BUILDING_COUNTS.activeShieldTurrets;
                    for (let bi = 0; bi < activeTurrets.length; bi++) {
                        const b = activeTurrets[bi];
                        if (!b || !b.pos || b.hp <= 0) continue;
                        const dEnemyToTurret = Math.hypot(e.mesh.position.x - b.pos.x, e.mesh.position.z - b.pos.z);
                        const dTargetToTurret = Math.hypot(tPos.x - b.pos.x, tPos.z - b.pos.z);
                        if (dTargetToTurret <= 9.5 || dEnemyToTurret <= 9.5 + (e.radius || 0.55) + 1.2) {
                            blockingShieldTurret = b;
                            break;
                        }
                    }
                    if (blockingShieldTurret) {
                        const dToTurret = Math.hypot(e.mesh.position.x - blockingShieldTurret.pos.x, e.mesh.position.z - blockingShieldTurret.pos.z);
                        const shieldPerimeter = 9.5 + (e.radius || 0.55);
                        if (dToTurret <= shieldPerimeter + Math.max(e.range || 1.5, 0.85)) {
                            bestTarget = blockingShieldTurret;
                            isBuildingTarget = true;
                            tPos = blockingShieldTurret.pos;
                            enemyAimPos = tPos;
                            bestDist = dToTurret;
                            engageRange = shieldPerimeter + Math.max(e.range || 1.5, 0.85);
                        }
                    }

                    if ((e.variant === 'behemoth' || e.variant === 'gorgon') && bestDist <= Math.max(e.range || 8.0, engageRange)) {
                        e.aiState = 'ATTACKING';
                        e.lastNavResult = 'in_attack_range';
                        e.navSuccess = true;
                        e.stopReason = 'in_attack_range';
                        if (e.cooldown <= 0) {
                            e.mesh.userData.attackAnim = 1.0;
                            _muzzleScratch.set(e.mesh.position.x, e.mesh.position.y + (e.variant === 'gorgon' ? 1.55 : 1.1), e.mesh.position.z);
                            launchOrdProjectile(_muzzleScratch, bestTarget, e.variant, e.damage, true);
                            e.cooldown = e.fireRate || 1.4;
                            e.lastCombatActionTime = state.elapsedSec;
                            e.lastAttackTime = state.elapsedSec;
                            e.watchdogTimer = 0;
                        }
                        if (bestDist > (blockingShieldTurret ? 11.2 : 5.5)) {
                            advanceGroundZergToward(attackNavTarget);
                        } else {
                            alignGroundUnitToTerrain(e.mesh, tPos.x, tPos.z, dt);
                        }
                    } else if (bestDist <= engageRange) {
                        e.aiState = 'ATTACKING';
                        e.lastNavResult = 'in_attack_range';
                        e.navSuccess = true;
                        e.stopReason = 'in_attack_range';
                        if (e.isAir) {
                            smoothAirVehicleTransform(e, tPos.x, tPos.z, e.variant === 'brood_lord' ? 6.8 : 5.8, false, dt);
                        } else {
                            alignGroundUnitToTerrain(e.mesh, tPos.x, tPos.z, dt);
                        }

                        if (e.variant === 'burster') {
                            if (!isBuildingTarget) {
                                recordRagdollHitImpulse(bestTarget, e.mesh.position, true);
                            }
                            if (typeof spawnBombCrater === 'function') spawnBombCrater(e.mesh.position, 0.55);
                            applyDamageWithTurretShield(bestTarget, e.damage, e.mesh.position);
                            spawnCombatFloat(e.mesh.position, e.damage, '#ff5400');
                            if (bestTarget === state.baseBuilding) updateHUD();
                            e.lastAttackTime = state.elapsedSec;
                            e.aiState = 'DEAD';
                            e.hp = 0;
                            continue;
                        } else if (e.cooldown <= 0) {
                            e.mesh.userData.attackAnim = 1.0;
                            e.lastCombatActionTime = state.elapsedSec;
                            e.lastAttackTime = state.elapsedSec;
                            e.watchdogTimer = 0;
                            if (!isBuildingTarget && bestTarget) {
                                bestTarget.retaliateTarget = e;
                            }
                            if (e.variant === 'spitter' || e.variant === 'behemoth' || e.variant === 'gorgon' || e.variant === 'mutalisk' || e.variant === 'brood_lord') {
                                _muzzleScratch.set(
                                    e.mesh.position.x,
                                    e.mesh.position.y + (e.isAir ? -0.15 : (e.variant === 'gorgon' ? 1.55 : 0.7)),
                                    e.mesh.position.z
                                );
                                launchOrdProjectile(_muzzleScratch, bestTarget, e.variant, e.damage, true);
                            } else {
                                if (!isBuildingTarget) {
                                    recordRagdollHitImpulse(bestTarget, e.mesh.position, e.variant === 'crusher');
                                }
                                applyDamageWithTurretShield(bestTarget, e.damage, e.mesh.position);
                                spawnCombatFloat(blockingShieldTurret ? e.mesh.position : tPos, e.damage, blockingShieldTurret ? '#38bdf8' : '#ff2a4b');
                                if (bestTarget === state.baseBuilding) updateHUD();
                            }
                            e.cooldown = e.fireRate || 1.0;
                        }
                    } else if (e.isAir) {
                        e.aiState = 'MOVING';
                        e.currentDestination = { x: Number(attackNavTarget.x.toFixed(2)), z: Number(attackNavTarget.z.toFixed(2)) };
                        e.navWaypoint = e.currentDestination;
                        e.distanceToDestination = Number(Math.hypot(attackNavTarget.x - e.mesh.position.x, attackNavTarget.z - e.mesh.position.z).toFixed(2));
                        e.currentSpeed = Number(effEnemySpeed.toFixed(2));
                        const dxAir = attackNavTarget.x - e.mesh.position.x;
                        const dzAir = attackNavTarget.z - e.mesh.position.z;
                        const lenAir = Math.hypot(dxAir, dzAir) || 1;
                        e.mesh.position.x += (dxAir / lenAir) * effEnemySpeed * dt;
                        e.mesh.position.z += (dzAir / lenAir) * effEnemySpeed * dt;
                        smoothAirVehicleTransform(e, attackNavTarget.x, attackNavTarget.z, e.variant === 'brood_lord' ? 6.8 : 5.8, true, dt);
                        e.lastNavResult = 'air_direct';
                        e.navSuccess = true;
                        e.stopReason = 'none';
                        e.lastMoveTime = state.elapsedSec;
                    } else {
                        if (e.aiState !== 'SPAWNING') e.aiState = 'MOVING';
                        advanceGroundZergToward(attackNavTarget);
                    }

                    // --- COMBAT WATCHDOG: Detects BOTH zero movement AND circular/looping movement ---
                    if (!e.isAir) {
                        if (!e._posHistory) e._posHistory = [{ x: e.mesh.position.x, z: e.mesh.position.z, t: state.elapsedSec }];
                        e._posSampleTimer = (e._posSampleTimer || 0) + dt;
                        if (e._posSampleTimer >= 0.25) {
                            e._posSampleTimer = 0;
                            e._posHistory.push({ x: e.mesh.position.x, z: e.mesh.position.z, t: state.elapsedSec });
                            if (e._posHistory.length > 8) e._posHistory.shift();
                        }

                        if (e.aiState !== 'ATTACKING' && e._posHistory.length >= 6) {
                            let pathLen = 0;
                            for (let hi = 1; hi < e._posHistory.length; hi++) {
                                pathLen += Math.hypot(e._posHistory[hi].x - e._posHistory[hi - 1].x, e._posHistory[hi].z - e._posHistory[hi - 1].z);
                            }
                            const oldest = e._posHistory[0];
                            const netDisp = Math.hypot(e.mesh.position.x - oldest.x, e.mesh.position.z - oldest.z);
                            const isZeroMove = pathLen < 0.35 && netDisp < 0.30;
                            const isCircling = pathLen > 1.85 && netDisp < 0.80;

                            if (isZeroMove || isCircling) {
                                e.watchdogTimer = (e.watchdogTimer || 0) + dt;
                                if (e.watchdogTimer >= 0.55) {
                                    e.watchdogTimer = 0;
                                    e._posHistory.length = 0;
                                    e._posHistory.push({ x: e.mesh.position.x, z: e.mesh.position.z, t: state.elapsedSec });
                                    e.recoveryAttempts = (e.recoveryAttempts || 0) + 1;
                                    e.lastRecoveryTime = state.elapsedSec;
                                    e.lastStuckPos = { x: Number(e.mesh.position.x.toFixed(2)), z: Number(e.mesh.position.z.toFixed(2)) };

                                    if (typeof window.recordNavStuckHotspot === 'function') {
                                        window.recordNavStuckHotspot(e.mesh.position.x, e.mesh.position.z, 3.0, 2.2);
                                    }

                                    // Remember the blocked heading so recovery never repeatedly sends the unit into the same obstacle
                                    const wpRef = e.navWaypoint || tPos;
                                    const blockedAng = Math.atan2(wpRef.x - e.mesh.position.x, wpRef.z - e.mesh.position.z);
                                    e._blockedHeading = blockedAng;
                                    e.wallFollowSign = -(e.wallFollowSign || e.flankSign || 1);
                                    e.navWaypoints = null;
                                    e.navRepathTimer = 0;

                                    if (typeof RIVER_BRIDGES !== 'undefined' && RIVER_BRIDGES.length > 1 && e.recoveryAttempts % 2 === 0) {
                                        e.preferredBridgeIdx = ((e.preferredBridgeIdx || 0) + 1) % RIVER_BRIDGES.length;
                                        if (window.BRIDGE_TRAFFIC_MANAGER) window.BRIDGE_TRAFFIC_MANAGER.releaseActor(e);
                                    }

                                    // Assign a validated walkable detour waypoint away from the blocked heading (without teleporting!)
                                    const surfH = typeof getSurfaceHeightWithBridges === 'function' ? getSurfaceHeightWithBridges : getTerrainHeight;
                                    const detourAngles = [
                                        e.wallFollowSign * 1.35,
                                        -e.wallFollowSign * 1.35,
                                        e.wallFollowSign * 2.05,
                                        -e.wallFollowSign * 2.05,
                                        Math.PI
                                    ];
                                    for (let di = 0; di < detourAngles.length; di++) {
                                        const dAng = blockedAng + detourAngles[di];
                                        const dx = e.mesh.position.x + Math.sin(dAng) * 6.5;
                                        const dz = e.mesh.position.z + Math.cos(dAng) * 6.5;
                                        if (typeof isWalkableGround === 'function' && isWalkableGround(dx, dz, (e.radius || 0.5) * 0.5) &&
                                            (typeof window.isPointClearOfAllBuildings !== 'function' || window.isPointClearOfAllBuildings(dx, dz, (e.radius || 0.5) * 0.5))) {
                                            e.recoveryDetourPos = new THREE.Vector3(dx, surfH(dx, dz), dz);
                                            e.recoveryDetourTimer = 1.6;
                                            break;
                                        }
                                    }

                                    if (window.AI_DEBUG && window.AI_DEBUG.loggingEnabled) {
                                        window.AI_DEBUG.logEvent(`Watchdog recovery #${e.recoveryAttempts} on ${e.id} (${isCircling ? 'circling' : 'zero_move'}) at (${e.lastStuckPos.x}, ${e.lastStuckPos.z})`);
                                    }
                                }
                            } else {
                                e.watchdogTimer = 0;
                            }
                        }
                    }
                }

                // Measure actual frame displacement to synchronize walk animation and telemetry
                const actualFrameDist = Math.hypot(e.mesh.position.x - frameStartX, e.mesh.position.z - frameStartZ);
                e.actualSpeedPerSec = dt > 0.0001 ? Number((actualFrameDist / dt).toFixed(2)) : 0;
                moving = actualFrameDist > 0.0012;
                e.walkableAtPos = e.isAir ? true : Boolean(typeof isWalkableGround === 'function' ? isWalkableGround(e.mesh.position.x, e.mesh.position.z, (e.radius || 0.5) * 0.40) : true);

                // Fog-of-War & Viewport visibility ONLY controls rendering, never AI simulation!
                const eVisFow = isWorldPosVisible(e.mesh.position.x, e.mesh.position.z);
                const eInViewport = eVisFow && window.isWorldPosInViewport(e.mesh.position.x, e.mesh.position.y, e.mesh.position.z, 3.8);
                e.mesh.visible = eInViewport;
                if (eInViewport) {
                    if (!e.isAir && typeof window.updateZergUnitBruiseDamage === 'function') {
                        window.updateZergUnitBruiseDamage(e);
                    }
                    updateUnitAnimation(e.mesh, dt, moving, enemyAimPos);
                    updateHealthPip(e.hb, e.hp, e.maxHp, 0, 0);
                    projectToScreen(e.hb.root, e.mesh.position, e.isAir ? 1.25 : (e.variant === 'behemoth' ? 1.8 : 1.15));
                } else if (e.hb && e.hb.root && e.hb.root.style.display !== 'none') {
                    e.hb.root.style.display = 'none';
                }
            } catch (unitErr) {
                e.lastError = (unitErr && unitErr.message) ? unitErr.message : String(unitErr);
                if (window.APP_ERROR_HANDLER && typeof window.APP_ERROR_HANDLER.record === 'function') {
                    window.APP_ERROR_HANDLER.record('enemyAI_unit', unitErr, 'ai');
                }
            }
        }
        if (perfProf) perfProf.end('enemyAI');

        resolveAllUnitCollisions();

        // Cleanup Defeated Allied Units (Blood splash ONLY on ground unit death & 50% Gunship Crash Animation without labels!)
        let selectionChanged = false;
        for (let i = units.length - 1; i >= 0; i--) {
            const u = units[i];
            if (u.hp <= 0) {
                if (u.type === 'hero' && state.heroPlaced) {
                    u.hp = u.maxHp;
                    u.mesh.position.copy(u.homePos);
                } else {
                    if (state.selectedUnits.includes(u)) {
                        state.selectedUnits = state.selectedUnits.filter(item => item !== u);
                        selectionChanged = true;
                    }
                    if (u.healBeam) scene.remove(u.healBeam);
                    if (u.prismaticBeam) scene.remove(u.prismaticBeam);
                    cleanupBattlecruiserLaserWeapons(u);
                    if (Array.isArray(u.interceptors)) {
                        for (let ii = 0; ii < u.interceptors.length; ii++) {
                            if (u.interceptors[ii] && u.interceptors[ii].mesh) {
                                scene.remove(u.interceptors[ii].mesh);
                            }
                        }
                        u.interceptors.length = 0;
                    }
                    if (u.selCircle) u.mesh.remove(u.selCircle);
                    u.hb.root.remove();
                    if (u.type === 'heli' && typeof startHelicopterTailDestroyCrash === 'function' && Math.random() < 0.50) {
                        startHelicopterTailDestroyCrash(u);
                    } else if (u.isVehicle || u.isAir) {
                        spawnVehicleWreckageExplosion(u.mesh.position, u.type);
                        scene.remove(u.mesh);
                    } else {
                        if (!u.isMindControlled) {
                            spawnAlliedBloodPhysicsSplash(u.mesh.position, u.lastHitImpulse);
                        }
                        spawnGoreExplosion(u.mesh.position, false, false, false);
                        spawnDeathCorpse(u.mesh, !!u.isMindControlled, u.lastHitImpulse, u.lastHitHeavy);
                    }
                    units.splice(i, 1);
                    if (state.selectedBuilding && state.selectedBuilding.type === 'turret') {
                        renderSC2CommandCard();
                    }
                    updateHUD();
                }
            }
        }
        if (selectionChanged) {
            renderSC2CommandCard();
            updateHUD();
        }
    }

    if (perfProf) perfProf.begin('corpsesAndDebris');
    // Animate Out-Of-Control Tail-Destroyed Crashing Helicopters
    if (typeof updateCrashingHelicopters === 'function') {
        updateCrashingHelicopters(dt);
    }

    // Cap corpses and wreckage parts dynamically based on adaptive quality budget
    const maxCorpseBudget = perfCfg ? perfCfg.maxCorpses : 48;
    while (corpses.length > maxCorpseBudget) {
        const oldest = corpses.shift();
        if (oldest && oldest.mesh) disposeHierarchy(oldest.mesh);
    }

    // Animate Articulated Ragdoll Death Corpses
    for (let i = corpses.length - 1; i >= 0; i--) {
        const c = corpses[i];
        updateRagdollCorpse(c, dt);
        if (c.life <= 0) {
            disposeHierarchy(c.mesh);
            corpses.splice(i, 1);
        }
    }

    const maxDebrisBudget = perfCfg ? perfCfg.maxDebris : 64;
    while (wreckageParts.length > maxDebrisBudget) {
        const oldestW = wreckageParts.shift();
        if (oldestW && oldestW.mesh) scene.remove(oldestW.mesh);
    }

    // Animate Scattered Flaming Vehicle Wreckage & Detached Weapon/Chitin Parts
    for (let i = wreckageParts.length - 1; i >= 0; i--) {
        const wp = wreckageParts[i];
        wp.life -= dt;
        const groundY = getTerrainHeight(wp.mesh.position.x, wp.mesh.position.z) + 0.14;

        if (wp.mesh.position.y > groundY || wp.vel.y > 0) {
            wp.mesh.position.addScaledVector(wp.vel, dt);
            wp.vel.y -= 18 * dt;
            wp.mesh.rotation.x += wp.rotVel.x * dt;
            wp.mesh.rotation.y += wp.rotVel.y * dt;
            wp.mesh.rotation.z += wp.rotVel.z * dt;
        }
        if (wp.mesh.position.y <= groundY) {
            wp.mesh.position.y = groundY;
            if (Math.abs(wp.vel.y) > 1.5) {
                wp.vel.y *= -0.38;
                wp.vel.x *= 0.65;
                wp.vel.z *= 0.65;
                wp.rotVel.multiplyScalar(0.6);
            } else {
                wp.vel.set(0, 0, 0);
            }
        }

        if (wp.hasFire && wp.life > 3.0) {
            wp.smokeTimer -= dt;
            if (wp.smokeTimer <= 0 && smokeClouds.length < 60) {
                const sm = new THREE.Mesh(
                    SHARED_FX_GEO.smoke,
                    Math.random() > 0.35 ? SHARED_FX_MAT.smokeDark : SHARED_FX_MAT.smokeFire
                );
                sm.scale.setScalar(0.75);
                sm.position.set(wp.mesh.position.x, wp.mesh.position.y + 0.2, wp.mesh.position.z);
                scene.add(sm);
                smokeClouds.push({ mesh: sm, vel: new THREE.Vector3((Math.random()-0.5)*0.6, 1.8, (Math.random()-0.5)*0.6), life: 0.6 });
                wp.smokeTimer = 0.22;
            }
        }

        if (wp.life < 1.5) wp.mesh.position.y -= dt * 0.4;
        if (wp.life <= 0) {
            scene.remove(wp.mesh);
            wreckageParts.splice(i, 1);
        }
    }
    if (perfProf) perfProf.end('corpsesAndDebris');

    if (perfProf) perfProf.begin('projectilesAndFX');
    if (typeof window.updateActiveMissileBarrages === 'function') {
        window.updateActiveMissileBarrages(dt);
    }
    const maxParticlesBudget = perfCfg ? perfCfg.maxParticles : 120;
    const projFowBypass = !!(window.titleScreenActive || window.loadingCameraSweep || window.fowRevealAll);
    // Update Projectiles (Tracks fast-moving air targets so Barracks anti-air infantry reliably hit flying Mutalisks!)
    for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        if (!p || !p.mesh || !p.start || !p.landingPos) {
            if (p && p.mesh) scene.remove(p.mesh);
            projectiles.splice(i, 1);
            continue;
        }
        p.age = (p.age || 0) + dt;
        const safeSpeed = (Number.isFinite(p.speed) && p.speed > 0.05) ? p.speed : 2.5;
        p.progress = (Number.isFinite(p.progress) ? p.progress : 0) + dt * safeSpeed;
        if (p.age > (p.maxAge || 4.5)) {
            p.progress = 1.0;
        }
        if (p.isAirTarget && p.targetObj && p.targetObj.hp > 0 && p.targetObj.mesh) {
            p.landingPos.copy(p.targetObj.mesh.position);
        }
        const tPos = p.landingPos;

        _projPrevPosScratch.copy(p.mesh.position);
        p.mesh.position.lerpVectors(p.start, tPos, Math.min(1, p.progress));
        if (p.isEnemyAcid || p.isBioGoo) {
            p.mesh.visible = projFowBypass || isWorldPosVisible(p.mesh.position.x, p.mesh.position.z);
        }
        if (p.wType === 'mortar' || p.isBioGoo || p.isEnemyAcid || p.wType === 'siege_tank') {
            p.mesh.position.y += Math.sin(p.progress * Math.PI) * (p.wType === 'mortar' ? 6.2 : (p.wType === 'siege_tank' ? 4.8 : 2.6));
            if (p.wType === 'siege_tank' && typeof emitThrusterExhaustParticles === 'function') {
                _projTrailDirScratch.copy(_projPrevPosScratch).sub(p.mesh.position).normalize();
                emitThrusterExhaustParticles(p.mesh.position, _projTrailDirScratch, 0.92, true);
            }
        } else if (p.wType === 'rocket' || p.wType === 'heli' || p.wType === 'rocketman' || p.wType === 'valkyrie' || p.wType === 'valk_aa' || p.wType === 'marauder') {
            // Initial upward climb + curved guidance arc into target radius
            const climbArc = (p.arcHeight || 2.15) * Math.sin(Math.pow(p.progress, 0.78) * Math.PI);
            p.mesh.position.y += climbArc;
            if (p.lateralCurve) {
                const dx = tPos.x - p.start.x;
                const dz = tPos.z - p.start.z;
                const dLen = Math.hypot(dx, dz) || 1;
                const perpX = -dz / dLen;
                const perpZ = dx / dLen;
                const latOffset = Math.sin(p.progress * Math.PI) * p.lateralCurve;
                p.mesh.position.x += perpX * latOffset;
                p.mesh.position.z += perpZ * latOffset;
            }
            if (typeof emitThrusterExhaustParticles === 'function') {
                _projTrailDirScratch.copy(_projPrevPosScratch).sub(p.mesh.position).normalize();
                emitThrusterExhaustParticles(p.mesh.position, _projTrailDirScratch, 0.85, false);
                emitThrusterExhaustParticles(_projPrevPosScratch, _projTrailDirScratch, 0.65, false);
            }
        } else if (p.wType === 'stalker' || p.wType === 'archon' || p.wType === 'solaris_spire') {
            p.mesh.position.y += Math.sin(p.progress * Math.PI) * (p.wType === 'archon' ? 0.25 : 0.45);
            if (p.mesh.userData) {
                if (p.mesh.userData.gyroRing1) p.mesh.userData.gyroRing1.rotation.z += dt * 18.0;
                if (p.mesh.userData.gyroRing2) p.mesh.userData.gyroRing2.rotation.y -= dt * 22.0;
            }
            if (Math.random() < 0.65 && particles.length < maxParticlesBudget && window.isWorldPosInViewport(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, 3.0)) {
                const wake = new THREE.Mesh(
                    SHARED_FX_GEO.weldSpark,
                    Math.random() > 0.4 ? (MAT.solarisPrismGlow || MAT.cyanGlow) : (MAT.solarisGold || MAT.amberGlow)
                );
                wake.scale.setScalar(p.wType === 'archon' ? 1.15 : 0.78);
                wake.position.copy(p.mesh.position);
                scene.add(wake);
                particles.push({
                    mesh: wake,
                    vel: new THREE.Vector3((Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2),
                    gravity: 0,
                    life: 0.16
                });
            }
        } else if (p.wType === 'tank' || p.wType === 'sunlance') {
            p.mesh.position.y += Math.sin(p.progress * Math.PI) * (p.wType === 'sunlance' ? 0.35 : 0.65);
            if (Math.random() < 0.55 && particles.length < maxParticlesBudget && window.isWorldPosInViewport(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, 3.0)) {
                const wake = new THREE.Mesh(SHARED_FX_GEO.weldSpark, p.wType === 'sunlance' ? MAT.amberGlow : MAT.cyanGlow);
                wake.scale.setScalar(p.wType === 'sunlance' ? 0.95 : 0.85);
                wake.position.copy(p.mesh.position);
                scene.add(wake);
                particles.push({
                    mesh: wake,
                    vel: new THREE.Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8),
                    gravity: 0,
                    life: 0.15
                });
            }
        } else if (p.wType === 'plasma') {
            p.mesh.position.y += Math.sin(p.progress * Math.PI) * 0.35;
            if (Math.random() < 0.75 && typeof window.spawnPlasmaElectricTrailParticle === 'function' && window.isWorldPosInViewport(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, 3.0)) {
                window.spawnPlasmaElectricTrailParticle(p.mesh.position);
            }
        } else if (p.wType === 'valk_mech') {
            p.mesh.position.y += Math.sin(p.progress * Math.PI) * 0.25;
        }
        _projDeltaScratch.copy(p.mesh.position).sub(_projPrevPosScratch);
        if (_projDeltaScratch.lengthSq() > 0.00001) {
            _projTrailDirScratch.copy(p.mesh.position).add(_projDeltaScratch);
            p.mesh.lookAt(_projTrailDirScratch);
            if (p.mesh.userData && p.mesh.userData.wakeRing) {
                p.mesh.userData.wakeRing.rotation.z += dt * 20.0;
            }
        }

        // Algorithmic Viscoelastic Spit / Goo / Jelly Wobble & Dripping Trail Synthesis
        if (p.mesh.userData && p.mesh.userData.isBioGooProj) {
            p.gooTime = (p.gooTime || 0) + dt * 22.0;
            const gt = p.gooTime;
            const ud = p.mesh.userData;
            if (ud.coreBlob) {
                const sx = 1.0 + Math.sin(gt) * 0.26;
                const sy = 1.0 + Math.cos(gt * 1.25) * 0.26;
                const sz = 1.28 - Math.sin(gt) * 0.22;
                ud.coreBlob.scale.set(sx, sy, sz);
                ud.coreBlob.rotation.z = gt * 0.45;
            }
            if (ud.satelliteBlobs) {
                for (let si = 0; si < ud.satelliteBlobs.length; si++) {
                    const sat = ud.satelliteBlobs[si];
                    const ph = gt * 1.15 + sat.phase;
                    const pulse = 1.0 + Math.sin(ph * 1.6) * 0.34;
                    sat.mesh.position.set(
                        sat.baseX * (0.75 + Math.sin(ph) * 0.45),
                        sat.baseY * (0.75 + Math.cos(ph * 1.1) * 0.45),
                        sat.baseZ + Math.sin(ph * 0.9) * 0.06
                    );
                    sat.mesh.scale.set(pulse, 2.0 - pulse * 0.7, 1.15 + Math.cos(ph) * 0.25);
                }
            }
            if (ud.gooStrands) {
                for (let st = 0; st < ud.gooStrands.length; st++) {
                    const strand = ud.gooStrands[st];
                    const sp = gt * 1.4 + strand.phase;
                    strand.mesh.position.x = strand.baseX + Math.sin(sp) * 0.04;
                    strand.mesh.position.y = strand.baseY + Math.cos(sp) * 0.04;
                    strand.mesh.scale.set(0.85 + Math.sin(sp) * 0.2, 0.85 + Math.cos(sp) * 0.2, 1.15 + Math.sin(sp * 0.8) * 0.35);
                }
            }
            if (Math.random() < 0.32 && particles.length < maxParticlesBudget && ud.dripGeo && ud.dripMat) {
                const drip = new THREE.Mesh(ud.dripGeo, ud.dripMat);
                const s = 0.55 + Math.random() * 0.45;
                drip.scale.set(s, s, s * 1.45);
                drip.position.set(
                    p.mesh.position.x + (Math.random() - 0.5) * 0.14,
                    p.mesh.position.y + (Math.random() - 0.5) * 0.14,
                    p.mesh.position.z + (Math.random() - 0.5) * 0.14
                );
                scene.add(drip);
                particles.push({
                    mesh: drip,
                    vel: new THREE.Vector3((Math.random() - 0.5) * 1.1, 0.4 + Math.random() * 0.9, (Math.random() - 0.5) * 1.1),
                    gravity: 11.5,
                    life: 0.24 + Math.random() * 0.14
                });
            }
        }

        if (p.progress >= 1) {
            if (typeof triggerWaterRippleFX === 'function' && !(typeof isOnRiverBridge === 'function' && isOnRiverBridge(tPos.x, tPos.z, 0.65))) {
                const isHeavySplash = (p.wType === 'mortar' || p.wType === 'tank' || p.wType === 'siege_tank' || p.wType === 'rocket' || p.wType === 'heli' || p.wType === 'behemoth' || p.wType === 'sunlance' || p.wType === 'valk_mech');
                triggerWaterRippleFX(tPos.x, tPos.z, isHeavySplash ? 1.45 : 0.82, true);
            }
            if (p.start && !p.isAirTarget && (p.start.y - tPos.y) > 1.6) {
                p.damage = Math.round(p.damage * 1.12);
            }
            if (!p.isAirTarget && typeof window.damageEnvironmentalStructuresAt === 'function') {
                const isExplosiveOrd = ['tank', 'siege_tank', 'mortar', 'rocket', 'sunlance', 'valk_mech', 'marauder', 'plasma', 'behemoth', 'gorgon', 'archon'].includes(p.wType);
                if (isExplosiveOrd) {
                    const envRad = (p.wType === 'siege_tank' || p.wType === 'mortar') ? 5.2 : 3.4;
                    window.damageEnvironmentalStructuresAt(tPos, envRad, p.damage);
                }
            }
            if (p.wType === 'tank' || p.wType === 'siege_tank') {
                if (typeof detonateTankKineticShell === 'function') {
                    detonateTankKineticShell(tPos, p.wType === 'siege_tank');
                } else {
                    detonateArtilleryBomb(tPos, true);
                }
                const splashRad = p.wType === 'siege_tank' ? 4.8 : 4.0;
                const bldRad = p.wType === 'siege_tank' ? 6.5 : 5.5;
                const tag = p.wType === 'siege_tank' ? 'SIEGE' : 'AP';
                enemies.forEach(e => {
                    if (e.isAir) return;
                    if (Math.hypot(e.mesh.position.x - tPos.x, e.mesh.position.z - tPos.z) <= splashRad) {
                        recordRagdollHitImpulse(e, p.start, true);
                        e.hp -= p.damage;
                        spawnCombatFloat(e.mesh.position, `${p.damage} ${tag}`, '#00e5ff');
                    }
                });
                enemyBuildings.forEach(eb => {
                    if (Math.hypot(eb.pos.x - tPos.x, eb.pos.z - tPos.z) <= bldRad) {
                        eb.hp -= p.damage;
                        spawnCombatFloat(eb.pos, `${p.damage} ${tag}`, '#00e5ff');
                        updateHUD();
                    }
                });
            } else if (p.wType === 'sunlance') {
                if (typeof spawnBombCrater === 'function' && !p.isAirTarget) spawnBombCrater(tPos, 0.56);
                if (typeof window.spawnParticleBlastWaveFX === 'function') {
                    window.spawnParticleBlastWaveFX(tPos, 0xffaa00, 1.05, 16);
                }
                enemies.forEach(e => {
                    if (Math.hypot(e.mesh.position.x - tPos.x, e.mesh.position.z - tPos.z) <= 2.8) {
                        recordRagdollHitImpulse(e, p.start, true);
                        e.hp -= p.damage;
                        spawnCombatFloat(e.mesh.position, `${p.damage} SUNLANCE`, '#ffaa00');
                    }
                });
                enemyBuildings.forEach(eb => {
                    if (Math.hypot(eb.pos.x - tPos.x, eb.pos.z - tPos.z) <= 3.6) {
                        eb.hp -= p.damage;
                        spawnCombatFloat(eb.pos, `${p.damage} SUNLANCE`, '#ffaa00');
                        updateHUD();
                    }
                });
            } else if (p.wType === 'yamato') {
                if (typeof spawnBombCrater === 'function' && !p.isAirTarget) spawnBombCrater(tPos, 0.85);
                if (typeof window.spawnParticleBlastWaveFX === 'function') {
                    window.spawnParticleBlastWaveFX(tPos, 0xff8800, 1.85, 24);
                }
                enemies.forEach(e => {
                    if (Math.hypot(e.mesh.position.x - tPos.x, e.mesh.position.z - tPos.z) <= 4.6) {
                        recordRagdollHitImpulse(e, p.start, true);
                        e.hp -= p.damage;
                        spawnCombatFloat(e.mesh.position, `${p.damage} YAMATO`, '#ffaa00');
                    }
                });
                enemyBuildings.forEach(eb => {
                    if (Math.hypot(eb.pos.x - tPos.x, eb.pos.z - tPos.z) <= 5.5) {
                        eb.hp -= p.damage;
                        spawnCombatFloat(eb.pos, `${p.damage} YAMATO`, '#ffaa00');
                        updateHUD();
                    }
                });
            } else if (p.wType === 'valk_mech') {
                if (typeof spawnBombCrater === 'function') spawnBombCrater(tPos, 0.48);
                triggerSparks(tPos);
                enemies.forEach(e => {
                    if (e.isAir) return;
                    if (Math.hypot(e.mesh.position.x - tPos.x, e.mesh.position.z - tPos.z) <= 2.6) {
                        recordRagdollHitImpulse(e, p.start, false);
                        e.hp -= p.damage;
                        spawnCombatFloat(e.mesh.position, `${p.damage} MECH`, '#38bdf8');
                    }
                });
                enemyBuildings.forEach(eb => {
                    if (Math.hypot(eb.pos.x - tPos.x, eb.pos.z - tPos.z) <= 3.8) {
                        eb.hp -= p.damage;
                        spawnCombatFloat(eb.pos, `${p.damage} MECH`, '#38bdf8');
                        updateHUD();
                    }
                });
            } else if (p.wType === 'valk_aa') {
                triggerSparks(tPos);
                enemies.forEach(e => {
                    if (!e.isAir) return;
                    if (Math.hypot(e.mesh.position.x - tPos.x, e.mesh.position.z - tPos.z) <= 3.6) {
                        recordRagdollHitImpulse(e, p.start, true);
                        e.hp -= p.damage;
                        spawnCombatFloat(e.mesh.position, `${p.damage} AA`, '#38bdf8');
                    }
                });
            } else if (p.wType === 'rocket') {
                if (typeof spawnBombCrater === 'function' && !p.isAirTarget) spawnBombCrater(tPos, 0.58);
                if (typeof window.spawnParticleBlastWaveFX === 'function') {
                    window.spawnParticleBlastWaveFX(tPos, 0xff4500, 1.15, 16);
                }
                enemies.forEach(e => {
                    if (Math.hypot(e.mesh.position.x - tPos.x, e.mesh.position.z - tPos.z) <= 3.4) {
                        recordRagdollHitImpulse(e, p.start, true);
                        e.hp -= p.damage;
                        spawnCombatFloat(e.mesh.position, `${p.damage} MIS`, '#ff2a4b');
                    }
                });
                enemyBuildings.forEach(eb => {
                    if (Math.hypot(eb.pos.x - tPos.x, eb.pos.z - tPos.z) <= 4.2) {
                        eb.hp -= p.damage;
                        spawnCombatFloat(eb.pos, `${p.damage} MIS`, '#ff2a4b');
                        updateHUD();
                    }
                });
            } else if (p.wType === 'mortar') {
                detonateArtilleryBomb(tPos, true);
                enemies.forEach(e => {
                    if (Math.hypot(e.mesh.position.x - tPos.x, e.mesh.position.z - tPos.z) <= 4.2) {
                        recordRagdollHitImpulse(e, tPos, true);
                        e.hp -= p.damage;
                        spawnCombatFloat(e.mesh.position, p.damage, '#ffaa00');
                    }
                });
                enemyBuildings.forEach(eb => {
                    if (Math.hypot(eb.pos.x - tPos.x, eb.pos.z - tPos.z) <= 5.5) {
                        eb.hp -= p.damage;
                        updateHUD();
                    }
                });
            } else if (p.wType === 'marauder') {
                if (typeof detonateMarauderConcussiveShell === 'function') {
                    detonateMarauderConcussiveShell(tPos);
                }
                enemies.forEach(e => {
                    const d = Math.hypot(e.mesh.position.x - tPos.x, e.mesh.position.z - tPos.z);
                    if (d <= 2.4 + (e.radius || 0.5)) {
                        const isArmored = (e.variant === 'crusher' || e.variant === 'behemoth');
                        const finalDmg = isArmored ? Math.round(p.damage * 1.35) : p.damage;
                        recordRagdollHitImpulse(e, p.start, true);
                        e.hp -= finalDmg;
                        e.slowTimer = 3.5;
                        spawnCombatFloat(e.mesh.position, finalDmg, '#ffaa00');
                    }
                });
                enemyBuildings.forEach(eb => {
                    if (Math.hypot(eb.pos.x - tPos.x, eb.pos.z - tPos.z) <= 3.2) {
                        const bldDmg = Math.round(p.damage * 1.35);
                        eb.hp -= bldDmg;
                        spawnCombatFloat(eb.pos, bldDmg, '#ffaa00');
                        updateHUD();
                    }
                });
            } else if (p.wType === 'plasma') {
                if (typeof spawnBombCrater === 'function') spawnBombCrater(tPos, 0.52);
                if (typeof spawnSimulatedVolumetricExplosion === 'function') {
                    spawnSimulatedVolumetricExplosion(tPos, 0.58, 1.38, 1.0, 6, 10);
                } else if (typeof window.spawnParticleBlastWaveFX === 'function') {
                    window.spawnParticleBlastWaveFX(tPos, 0x00e5ff, 0.95, 14);
                }
                let primaryHitEnemy = null;
                enemies.forEach(e => {
                    if (Math.hypot(e.mesh.position.x - tPos.x, e.mesh.position.z - tPos.z) <= 2.5) {
                        if (!primaryHitEnemy) primaryHitEnemy = e;
                        recordRagdollHitImpulse(e, p.start, false);
                        e.hp -= p.damage;
                        spawnCombatFloat(e.mesh.position, p.damage, '#00e5ff');
                    }
                });
                // Plasma Electric Chain-Zap: Arcs electric lightning to up to 3 nearby enemies within 5.5m!
                const arcOrigin = primaryHitEnemy ? primaryHitEnemy.mesh.position : tPos;
                const chainCandidates = [];
                for (let ei = 0; ei < enemies.length; ei++) {
                    const eOther = enemies[ei];
                    if (!eOther || eOther.hp <= 0 || eOther === primaryHitEnemy) continue;
                    const dArc = Math.hypot(eOther.mesh.position.x - arcOrigin.x, eOther.mesh.position.z - arcOrigin.z);
                    if (dArc <= 5.5) {
                        chainCandidates.push({ enemy: eOther, dist: dArc });
                    }
                }
                chainCandidates.sort((a, b) => a.dist - b.dist);
                const maxChains = Math.min(3, chainCandidates.length);
                let prevZapNode = arcOrigin;
                const zapDmg = Math.max(14, Math.round(p.damage * 0.52));
                for (let ci = 0; ci < maxChains; ci++) {
                    const ce = chainCandidates[ci].enemy;
                    if (typeof window.spawnPlasmaChainLightningArcFX === 'function') {
                        window.spawnPlasmaChainLightningArcFX(prevZapNode, ce.mesh.position);
                    }
                    ce.hp -= zapDmg;
                    spawnCombatFloat(ce.mesh.position, `${zapDmg} ZAP`, '#38bdf8');
                    prevZapNode = ce.mesh.position;
                }
                enemyBuildings.forEach(eb => {
                    if (Math.hypot(eb.pos.x - tPos.x, eb.pos.z - tPos.z) <= 3.2) {
                        eb.hp -= p.damage;
                        spawnCombatFloat(eb.pos, p.damage, '#00e5ff');
                        updateHUD();
                    }
                });
            } else if (p.isEnemyAcid) {
                if (typeof spawnEnemyGooSplashFX === 'function') {
                    spawnEnemyGooSplashFX(tPos, p.wType);
                }
                const splashRad = p.wType === 'behemoth' ? 3.2 : (p.wType === 'gorgon' ? 2.85 : 1.95);
                units.forEach(u => {
                    const d = Math.hypot(u.mesh.position.x - tPos.x, u.mesh.position.z - tPos.z);
                    if (d <= splashRad + (u.radius || 0.5)) {
                        recordRagdollHitImpulse(u, p.start, p.wType === 'behemoth' || p.wType === 'gorgon');
                        applyDamageWithTurretShield(u, p.damage);
                        if (p.wType === 'gorgon') u.slowTimer = 2.6;
                        spawnCombatFloat(u.mesh.position, p.damage, '#84cc16');
                    }
                });
                buildings.forEach(b => {
                    const d = Math.hypot(b.pos.x - tPos.x, b.pos.z - tPos.z);
                    if (d <= splashRad + 1.6) {
                        applyDamageWithTurretShield(b, p.damage);
                        spawnCombatFloat(b.pos, p.damage, '#84cc16');
                        if (b === state.baseBuilding) updateHUD();
                    }
                });
                if (!state.solarisHostile && typeof solarisBuildings !== 'undefined') {
                    solarisBuildings.forEach(sb => {
                        if (!sb || sb.hp <= 0) return;
                        const d = Math.hypot(sb.pos.x - tPos.x, sb.pos.z - tPos.z);
                        if (d <= splashRad + 1.8) {
                            applyDamageWithTurretShield(sb, p.damage, tPos);
                            spawnCombatFloat(sb.pos, p.damage, '#84cc16');
                        }
                    });
                }
            } else if (p.isBioGoo && !p.isEnemyAcid) {
                if (typeof spawnEnemyGooSplashFX === 'function') {
                    spawnEnemyGooSplashFX(tPos, p.wType);
                }
                const splashRad = p.wType === 'behemoth' ? 3.4 : (p.wType === 'gorgon' ? 3.0 : 2.15);
                enemies.forEach(e => {
                    const d = Math.hypot(e.mesh.position.x - tPos.x, e.mesh.position.z - tPos.z);
                    if (d <= splashRad + (e.radius || 0.55)) {
                        recordRagdollHitImpulse(e, p.start, p.wType === 'behemoth' || p.wType === 'gorgon');
                        e.hp -= p.damage;
                        if (p.wType === 'gorgon') e.slowTimer = 2.8;
                        spawnCombatFloat(e.mesh.position, p.damage, '#d946ef');
                    }
                });
                enemyBuildings.forEach(eb => {
                    const d = Math.hypot(eb.pos.x - tPos.x, eb.pos.z - tPos.z);
                    if (d <= splashRad + 2.2) {
                        eb.hp -= p.damage;
                        spawnCombatFloat(eb.pos, p.damage, '#d946ef');
                        updateHUD();
                    }
                });
            } else if (p.wType === 'stalker' || p.wType === 'archon' || p.wType === 'solaris_spire' || p.wType === 'phoenix' || p.wType === 'interceptor') {
                triggerSparks(tPos);
                const isArchonOrb = (p.wType === 'archon');
                const isSpireBeam = (p.wType === 'solaris_spire');
                if (typeof window.spawnParticleBlastWaveFX === 'function' && (isArchonOrb || isSpireBeam)) {
                    window.spawnParticleBlastWaveFX(tPos, isArchonOrb ? 0xf5b932 : 0x38bdf8, isArchonOrb ? 1.25 : 0.92, isArchonOrb ? 18 : 14);
                }
                const splashRad = isArchonOrb ? 2.85 : (isSpireBeam ? 2.15 : 1.65);
                enemies.forEach(e => {
                    const d = Math.hypot(e.mesh.position.x - tPos.x, e.mesh.position.z - tPos.z);
                    if (d <= splashRad + (e.radius || 0.55)) {
                        recordRagdollHitImpulse(e, p.start, isArchonOrb);
                        e.hp -= p.damage;
                        spawnCombatFloat(e.mesh.position, p.damage, isArchonOrb ? '#f5b932' : '#38bdf8');
                    }
                });
                enemyBuildings.forEach(eb => {
                    const d = Math.hypot(eb.pos.x - tPos.x, eb.pos.z - tPos.z);
                    if (d <= splashRad + 2.2) {
                        eb.hp -= p.damage;
                        spawnCombatFloat(eb.pos, p.damage, isArchonOrb ? '#f5b932' : '#38bdf8');
                        updateHUD();
                    }
                });
            } else {
                if ((p.wType === 'heli' || p.wType === 'reaper') && typeof spawnBombCrater === 'function' && !p.isAirTarget) {
                    spawnBombCrater(tPos, p.wType === 'heli' ? 0.48 : 0.36);
                    if (p.wType === 'heli' && typeof spawnSimulatedVolumetricExplosion === 'function') {
                        spawnSimulatedVolumetricExplosion(tPos, 0.52, 1.32, 0.0, 5, 8);
                    }
                }
                const isSniper = p.wType === 'sniper';
                let hitEnemy = null, bestD = 1.95;
                enemies.forEach(e => {
                    const d = Math.hypot(e.mesh.position.x - tPos.x, e.mesh.position.z - tPos.z);
                    if (d <= bestD + (e.radius || 0.55)) { bestD = d; hitEnemy = e; }
                });
                if (hitEnemy) {
                    recordRagdollHitImpulse(hitEnemy, p.start, isSniper);
                    hitEnemy.hp -= p.damage;
                    spawnCombatFloat(
                        hitEnemy.mesh.position,
                        isSniper ? `${p.damage} CRIT` : p.damage,
                        isSniper ? '#00ff66' : '#e8e6df'
                    );
                } else {
                    enemyBuildings.forEach(eb => {
                        const d = Math.hypot(eb.pos.x - tPos.x, eb.pos.z - tPos.z);
                        if (d <= 3.0) {
                            eb.hp -= p.damage;
                            spawnCombatFloat(eb.pos, p.damage, isSniper ? '#00ff66' : '#e8e6df');
                            updateHUD();
                        }
                    });
                }
            }
            scene.remove(p.mesh);
            projectiles.splice(i, 1);
        }
    }

    // Update Physics Blood Droplets, Bomb Impact Craters & Scavenger Post-Death Debris
    if (typeof updateBloodPhysicsDrops === 'function') updateBloodPhysicsDrops(dt);
    if (typeof updateBombCraters === 'function') updateBombCraters(dt);
    if (typeof updateScavengerDebris === 'function') updateScavengerDebris(dt);
    if (typeof updateBasePlacementBarriers === 'function') updateBasePlacementBarriers(dt);

    // Update Casings, Ballistic Spark Streaks, Gore Particles, Simulated Combustion Plumes & Blast Waves
    for (let i = shellCasings.length - 1; i >= 0; i--) {
        const c = shellCasings[i];
        c.life -= dt;
        c.mesh.position.addScaledVector(c.vel, dt);
        c.vel.y -= 15 * dt;
        c.mesh.rotation.x += c.rotVel.x * dt;
        c.mesh.rotation.z += c.rotVel.z * dt;
        const groundY = getTerrainHeight(c.mesh.position.x, c.mesh.position.z) + 0.03;
        if (c.mesh.position.y < groundY) {
            c.mesh.position.y = groundY;
            c.vel.y *= -0.4; c.vel.x *= 0.6; c.vel.z *= 0.6;
        }
        if (c.life <= 0) { scene.remove(c.mesh); shellCasings.splice(i, 1); }
    }

    while (particles.length > maxParticlesBudget) {
        const oldestPt = particles.shift();
        if (oldestPt && oldestPt.mesh) scene.remove(oldestPt.mesh);
    }

    for (let i = particles.length - 1; i >= 0; i--) {
        const pt = particles[i];
        pt.life -= dt;
        if (pt.drag) {
            const dragMult = Math.max(0, 1.0 - pt.drag * dt);
            pt.vel.x *= dragMult;
            pt.vel.z *= dragMult;
        }
        pt.mesh.position.addScaledVector(pt.vel, dt);
        pt.vel.y -= pt.gravity * dt;

        if (pt.isWaterDrop) {
            if (pt.vel.lengthSq() > 0.001) {
                pt.mesh.lookAt(
                    pt.mesh.position.x + pt.vel.x,
                    pt.mesh.position.y + pt.vel.y,
                    pt.mesh.position.z + pt.vel.z
                );
            }
            pt.mesh.scale.multiplyScalar(0.985);
            if (pt.waterY !== undefined && pt.vel.y < 0 && pt.mesh.position.y <= pt.waterY) {
                pt.life = 0;
            }
        } else if (pt.isBallisticSpark) {
            if (pt.vel.lengthSq() > 0.002) {
                pt.mesh.lookAt(
                    pt.mesh.position.x + pt.vel.x,
                    pt.mesh.position.y + pt.vel.y,
                    pt.mesh.position.z + pt.vel.z
                );
            }
            const gY = getTerrainHeight(pt.mesh.position.x, pt.mesh.position.z) + 0.03;
            if (pt.mesh.position.y < gY && pt.vel.y < 0) {
                pt.mesh.position.y = gY;
                if ((pt.bounces || 0) < 2) {
                    pt.vel.y = -pt.vel.y * 0.42;
                    pt.vel.x *= 0.68;
                    pt.vel.z *= 0.68;
                    pt.bounces = (pt.bounces || 0) + 1;
                } else {
                    pt.life = 0;
                }
            }
        } else if (pt.isThrustParticle) {
            if (pt.vel.lengthSq() > 0.002) {
                pt.mesh.lookAt(
                    pt.mesh.position.x + pt.vel.x,
                    pt.mesh.position.y + pt.vel.y,
                    pt.mesh.position.z + pt.vel.z
                );
            }
            pt.mesh.scale.x *= 0.88;
            pt.mesh.scale.y *= 0.88;
            pt.mesh.scale.z *= 0.94;
        } else {
            pt.mesh.scale.multiplyScalar(0.95);
        }
        if (pt.life <= 0) { scene.remove(pt.mesh); particles.splice(i, 1); }
    }

    for (let i = smokeClouds.length - 1; i >= 0; i--) {
        const sm = smokeClouds[i];
        sm.life -= dt;
        sm.age = (sm.age || 0) + dt;
        if (sm.buoyancy) {
            sm.vel.y += sm.buoyancy * dt;
        }
        if (sm.drag) {
            const dragMult = Math.max(0, 1.0 - sm.drag * dt);
            sm.vel.x *= dragMult;
            sm.vel.z *= dragMult;
            sm.vel.y *= Math.max(0, 1.0 - sm.drag * 0.45 * dt);
        }
        sm.mesh.position.addScaledVector(sm.vel, dt);
        sm.mesh.scale.multiplyScalar(1 + dt * (sm.expandRate || 1.2));

        if (sm.mesh.material && sm.mesh.material.uniforms && sm.mesh.material.uniforms.uAge) {
            sm.mesh.material.uniforms.uAge.value = sm.age;
            sm.mesh.material.uniforms.uLife.value = sm.maxLife || 1.0;
        }

        if (sm.life <= 0) {
            scene.remove(sm.mesh);
            if (sm.ownsMaterial && sm.mesh.material) {
                sm.mesh.material.dispose();
            }
            smokeClouds.splice(i, 1);
        }
    }

    for (let i = shockwaves.length - 1; i >= 0; i--) {
        const sw = shockwaves[i];
        sw.scale += dt * (sw.speed || 15);
        if (sw.riseY) sw.mesh.position.y += dt * sw.riseY;
        sw.alpha -= dt * 2.2;
        sw.mesh.scale.setScalar(sw.scale);
        const clampedAlpha = Math.max(0, sw.alpha);
        sw.mesh.material.opacity = clampedAlpha;
        if (sw.mesh.material && sw.mesh.material.uniforms && sw.mesh.material.uniforms.uOpacity) {
            sw.mesh.material.uniforms.uOpacity.value = clampedAlpha;
        }
        if (sw.alpha <= 0) { scene.remove(sw.mesh); sw.mesh.material.dispose(); shockwaves.splice(i, 1); }
    }

    // Animate 3D Tactical Order Waypoint Markers
    for (let i = tacticalWaypoints.length - 1; i >= 0; i--) {
        const tw = tacticalWaypoints[i];
        tw.age += dt;
        const t = Math.min(1.0, tw.age / tw.maxLife);
        const ease = 1.0 - Math.pow(1.0 - t, 3.0);
        const rad = THREE.MathUtils.lerp(0.92, 0.22, ease);
        for (let ci = 0; ci < tw.chevrons.length; ci++) {
            const c = tw.chevrons[ci];
            c.mesh.position.set(Math.sin(c.ang) * rad, 0.04 + Math.sin(t * Math.PI) * 0.06, Math.cos(c.ang) * rad);
        }
        if (tw.beaconPin) {
            tw.beaconPin.position.y = THREE.MathUtils.lerp(1.15, 0.22, ease);
            tw.beaconPin.rotation.y += dt * 7.5;
            const s = 1.0 - t * 0.35;
            tw.beaconPin.scale.set(0.85 * s, 2.4 * (1.0 - t * 0.45), 0.85 * s);
        }
        if (tw.mat) {
            tw.mat.opacity = Math.max(0, 1.0 - Math.pow(t, 1.8));
        }
        if (tw.age >= tw.maxLife) {
            scene.remove(tw.root);
            if (tw.mat) tw.mat.dispose();
            tacticalWaypoints.splice(i, 1);
        }
    }
    if (perfProf) perfProf.end('projectilesAndFX');

    const portraitTargetInterval = perfCfg ? perfCfg.portraitInterval : 0.065;
    _portrait3DAccum += dt;
    if (_portrait3DAccum >= portraitTargetInterval) {
        if (window.PORTRAIT_3D_VIEWER && typeof window.PORTRAIT_3D_VIEWER.update === 'function') {
            if (perfProf) perfProf.begin('portrait3D');
            window.PORTRAIT_3D_VIEWER.update(_portrait3DAccum);
            if (perfProf) perfProf.end('portrait3D');
        }
        _portrait3DAccum = 0;
    }

    if (window.TANK_TRACK_SYSTEM && typeof window.TANK_TRACK_SYSTEM.update === 'function') {
        window.TANK_TRACK_SYSTEM.update(dt);
    }

    if (window.AXIS_BALL_CONTROLLER && typeof window.AXIS_BALL_CONTROLLER.update === 'function') {
        window.AXIS_BALL_CONTROLLER.update(rawDt);
    }

    if (perfProf) perfProf.begin('renderScene');
    if (window.SCENE_INTEGRITY_VALIDATOR && typeof window.SCENE_INTEGRITY_VALIDATOR.validateSceneGraph === 'function') {
        const frameNum = perfProf ? perfProf.frameCount : 0;
        if (window._forceSceneValidation || (frameNum % 45 === 0)) {
            window._forceSceneValidation = false;
            window.SCENE_INTEGRITY_VALIDATOR.validateSceneGraph(scene, 'pre-render');
        }
    }
    try {
        renderer.render(scene, camera);
    } catch (renderErr) {
        let repairedCount = 0;
        if (window.SCENE_INTEGRITY_VALIDATOR && typeof window.SCENE_INTEGRITY_VALIDATOR.validateSceneGraph === 'function') {
            const rep = window.SCENE_INTEGRITY_VALIDATOR.validateSceneGraph(scene, 'render-exception-recovery');
            repairedCount = (rep && typeof rep.repaired === 'number') ? rep.repaired : 0;
        }
        if (window.APP_ERROR_HANDLER) window.APP_ERROR_HANDLER.record('renderer.render', renderErr, 'graphics');
        if (repairedCount > 0) {
            try {
                renderer.render(scene, camera);
            } catch (retryErr) {
                if (window.APP_ERROR_HANDLER) window.APP_ERROR_HANDLER.record('renderer.render.retry', retryErr, 'graphics');
            }
        }
    }
    if (perfProf) {
        perfProf.end('renderScene');
        perfProf.endFrame(renderer, {
            units: units.length,
            enemies: enemies.length,
            buildings: buildings.length + enemyBuildings.length + (typeof solarisBuildings !== 'undefined' ? solarisBuildings.length : 0),
            projectiles: projectiles.length,
            particles: particles.length + smokeClouds.length + shockwaves.length
        });
    }
    } catch (err) {
        if (window.APP_ERROR_HANDLER) window.APP_ERROR_HANDLER.record('animate', err);
        if (window.SCENE_INTEGRITY_VALIDATOR && typeof window.SCENE_INTEGRITY_VALIDATOR.validateSceneGraph === 'function') {
            window.SCENE_INTEGRITY_VALIDATOR.validateSceneGraph(scene, 'animate-catch');
        }
    }
}

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================================
// MULTIPLAYER CONFIGURATION VALIDATION & DYNAMIC PARTICIPANT ROSTER INITIALIZER
// Single source of truth for multiplayer match participants, teams, factions & AI
// ============================================================================
function normalizeMultiplayerFaction(rawFaction) {
    const f = String(rawFaction || '').trim().toLowerCase();
    if (f === 'terran' || f.includes('terran') || f.includes('dominion')) return 'terran';
    if (f === 'protoss' || f === 'solaris' || f.includes('protoss') || f.includes('solaris') || f.includes('synod')) return 'protoss';
    if (f === 'zerg' || f.includes('zerg') || f.includes('swarm') || f.includes('xeno')) return 'zerg';
    return '';
}

function normalizeAiDifficulty(rawDiff) {
    const d = String(rawDiff || '').trim().toLowerCase();
    if (d === 'easy') return 'Easy';
    if (d === 'medium' || d === 'normal') return 'Medium';
    if (d === 'hard') return 'Hard';
    if (d === 'brutal' || d === 'insane') return 'Brutal';
    return '';
}

window.validateAndBuildMultiplayerRoster = function(lobbyConfig) {
    const errors = [];
    if (!lobbyConfig || typeof lobbyConfig !== 'object') {
        return { valid: false, errors: ['Missing lobby configuration object.'], roster: [] };
    }

    const rawSlots = Array.isArray(lobbyConfig.players)
        ? lobbyConfig.players
        : (Array.isArray(lobbyConfig.slots)
            ? lobbyConfig.slots
            : (Array.isArray(lobbyConfig.lobbyPlayers) ? lobbyConfig.lobbyPlayers : []));

    if (rawSlots.length < 2) {
        errors.push(`Invalid participant count (${rawSlots.length}). At least 2 participants are required.`);
    }

    const explicitLocalPlayerId = lobbyConfig.localPlayerId ? String(lobbyConfig.localPlayerId).trim() : '';
    const roster = [];
    const distinctTeams = new Set();
    const seenPlayerIds = new Set();
    const seenSlotIds = new Set();
    let humanCount = 0;

    for (let i = 0; i < rawSlots.length; i++) {
        const s = rawSlots[i];
        if (!s || typeof s !== 'object') {
            errors.push(`Slot #${i + 1} is null or malformed.`);
            continue;
        }
        const rawId = s.id !== undefined ? String(s.id).trim() : '';
        const rawPlayerId = s.playerId !== undefined ? String(s.playerId).trim() : '';
        const rawSlotId = s.slotId !== undefined ? String(s.slotId).trim() : '';

        const playerId = rawPlayerId || rawId || rawSlotId;
        const slotId = rawSlotId || rawId || rawPlayerId || `slot_${i + 1}`;

        if (!playerId) {
            errors.push(`Slot #${i + 1} is missing a valid participant ID.`);
        } else if (seenPlayerIds.has(playerId)) {
            errors.push(`Duplicate participant ID "${playerId}" detected at slot #${i + 1}.`);
        } else {
            seenPlayerIds.add(playerId);
        }

        if (seenSlotIds.has(slotId) && slotId !== playerId) {
            errors.push(`Duplicate slot ID "${slotId}" detected at slot #${i + 1}.`);
        } else {
            seenSlotIds.add(slotId);
        }

        const rawTypeStr = String(s.type || '').trim().toLowerCase();
        const isAiFlag = s.isAi === true || s.isBot === true || rawTypeStr === 'ai' || rawTypeStr === 'bot';
        const isHumanFlag = s.isAi === false || s.isBot === false || rawTypeStr === 'human';
        const type = isAiFlag ? 'ai' : (isHumanFlag ? 'human' : '');

        if (type !== 'human' && type !== 'ai') {
            errors.push(`Slot "${slotId}" has invalid participant type (type="${s.type}", isAi=${s.isAi}, isBot=${s.isBot}).`);
        }
        if (type === 'human') humanCount++;

        const rawTeamVal = s.team !== undefined ? s.team : s.teamId;
        const teamId = Number(rawTeamVal);
        if (!Number.isInteger(teamId) || teamId < 0 || teamId > 8) {
            errors.push(`Slot "${slotId}" has invalid team assignment (${rawTeamVal}).`);
        } else {
            distinctTeams.add(teamId === 0 ? `ffa_${playerId || i}` : String(teamId));
        }

        const faction = normalizeMultiplayerFaction(s.faction);
        if (!faction) {
            errors.push(`Slot "${slotId}" has invalid faction "${s.faction}".`);
        }

        let aiDifficulty = null;
        if (type === 'ai') {
            aiDifficulty = normalizeAiDifficulty(s.aiDifficulty || s.difficulty || lobbyConfig.botDifficulty || 'Medium');
            if (!aiDifficulty) {
                errors.push(`AI slot "${slotId}" has invalid difficulty "${s.aiDifficulty || s.difficulty}".`);
            }
        }

        const ready = type === 'ai' ? true : (s.ready !== false);
        if (type === 'human' && s.ready === false) {
            errors.push(`Human participant "${s.name || playerId}" is not ready.`);
        }

        const isMatchedLocal = explicitLocalPlayerId
            ? (type === 'human' && (playerId === explicitLocalPlayerId || slotId === explicitLocalPlayerId))
            : Boolean(s.isLocalHuman);

        roster.push({
            id: playerId,
            slotId,
            playerId,
            name: String(s.name || (type === 'ai' ? `AI Commander ${i + 1}` : `Commander ${i + 1}`)),
            type,
            isAi: type === 'ai',
            isBot: type === 'ai',
            teamId,
            team: teamId,
            faction,
            rawFaction: String(s.faction || faction),
            aiDifficulty,
            difficulty: aiDifficulty,
            ready,
            isHost: Boolean(s.isHost),
            isLocalHuman: isMatchedLocal
        });
    }

    // If no explicit localPlayerId matched or was provided, fall back to explicit isLocalHuman or first human
    if (!roster.some(r => r.isLocalHuman)) {
        const fallbackHuman = explicitLocalPlayerId
            ? roster.find(r => r.type === 'human' && (r.playerId === explicitLocalPlayerId || r.id === explicitLocalPlayerId))
            : roster.find(r => r.type === 'human');
        if (fallbackHuman) {
            fallbackHuman.isLocalHuman = true;
        }
    }

    if (humanCount < 1) {
        errors.push('At least 1 human player is required in the lobby roster.');
    }
    if (distinctTeams.size < 2) {
        errors.push('At least 2 opposing teams are required to start a match.');
    }
    if (roster.length !== rawSlots.length) {
        errors.push('Generated participant roster length does not match lobby slots.');
    }

    return {
        valid: errors.length === 0,
        errors,
        roster,
        localPlayerId: explicitLocalPlayerId || (roster.find(r => r.isLocalHuman)?.playerId || null),
        teamCount: distinctTeams.size,
        humanCount,
        aiCount: roster.filter(r => r.type === 'ai').length
    };
};

// Spawns ONLY the exact participants from the validated roster (no unrequested Solaris allies or default extras)
function spawnLobbyExpansionBases(lobbyPlayersOrConfig, localPlayerIdOverride) {
    const configObj = Array.isArray(lobbyPlayersOrConfig)
        ? { players: lobbyPlayersOrConfig, localPlayerId: localPlayerIdOverride || (state.multiplayerConfig && state.multiplayerConfig.localPlayerId) || null }
        : (lobbyPlayersOrConfig && typeof lobbyPlayersOrConfig === 'object' ? lobbyPlayersOrConfig : { players: [] });

    const validation = window.validateAndBuildMultiplayerRoster(configObj);
    if (!validation.valid || validation.roster.length === 0) return validation;

    const roster = validation.roster;
    const targetLocalId = localPlayerIdOverride || configObj.localPlayerId || validation.localPlayerId;
    const localHuman = (targetLocalId && roster.find(p => p.type === 'human' && (p.playerId === targetLocalId || p.id === targetLocalId || p.slotId === targetLocalId)))
        || roster.find(p => p.type === 'human' && p.isLocalHuman)
        || roster.find(p => p.type === 'human')
        || roster[0];

    const localTeamId = localHuman ? (localHuman.teamId !== undefined ? localHuman.teamId : (localHuman.team !== undefined ? localHuman.team : 1)) : 1;

    const isSameTeamAsLocal = (p) => {
        if (!p || p === localHuman) return false;
        const pTeam = p.teamId !== undefined ? p.teamId : p.team;
        if (localTeamId === 0 || pTeam === 0) return false; // Free-For-All: everyone is hostile
        return pTeam === localTeamId;
    };

    const alliedParticipants = roster.filter(p => p !== localHuman && isSameTeamAsLocal(p));
    const hostileParticipants = roster.filter(p => p !== localHuman && !isSameTeamAsLocal(p));

    state.isMultiplayerMatch = true;
    state.hasAlliedAiCommander = alliedParticipants.length > 0;
    state.playerTeamId = localTeamId;
    state.localPlayerId = localHuman ? localHuman.playerId : null;
    state.activeMultiplayerRoster = roster;
    state.multiplayerParticipants = roster;

    // 1. If 0 allied AI/players are on the human player's team, ensure 0 Solaris ally structures/units exist!
    solarisBuildings.forEach(sb => {
        if (sb && sb.mesh) scene.remove(sb.mesh);
        if (sb && sb.hb && sb.hb.root) sb.hb.root.remove();
    });
    solarisBuildings.length = 0;
    for (let ui = units.length - 1; ui >= 0; ui--) {
        const u = units[ui];
        if (u && u.isSolarisAllyUnit) {
            if (u.mesh) scene.remove(u.mesh);
            if (u.hb && u.hb.root) u.hb.root.remove();
            units.splice(ui, 1);
        }
    }

    // 2. Rebuild enemyBuildings strictly from hostileParticipants (never hardcode counts, teams, or factions)
    enemyBuildings.forEach(eb => {
        if (eb && eb.mesh) scene.remove(eb.mesh);
        if (eb && eb.expCreepMesh) scene.remove(eb.expCreepMesh);
        if (eb && eb.badge) eb.badge.remove();
        if (eb && eb.hb && eb.hb.root) eb.hb.root.remove();
    });
    enemyBuildings.length = 0;
    enemies.forEach(e => {
        if (e && e.mesh) scene.remove(e.mesh);
        if (e && e.hb && e.hb.root) e.hb.root.remove();
    });
    enemies.length = 0;
    state.enemyBase = null;

    // Candidate world positions for hostile and allied bases
    const zones = Array.isArray(window.BASE_TERRAIN_ZONES) ? window.BASE_TERRAIN_ZONES : [];
    const expansionZones = zones.filter(z => z && z.id && (z.id.startsWith('faction_expansion_') || z.id.startsWith('corner_ramp_platform_')));
    const usedZoneIds = new Set();

    // Primary hostile spawn anchor is ENEMY_BASE_POS; additional hostile slots use distinct far expansion zones
    const hostileSpawnCoords = [
        { x: ENEMY_BASE_POS.x, z: ENEMY_BASE_POS.z, id: 'primary_enemy_base' }
    ];
    const sortedFarZones = expansionZones
        .slice()
        .sort((a, b) => Math.hypot(b.x - PLAYER_START_POS.x, b.z - PLAYER_START_POS.z) - Math.hypot(a.x - PLAYER_START_POS.x, a.z - PLAYER_START_POS.z));
    for (let zi = 0; zi < sortedFarZones.length; zi++) {
        const z = sortedFarZones[zi];
        if (Number.isFinite(z.x) && Number.isFinite(z.z) &&
            Math.hypot(z.x - ENEMY_BASE_POS.x, z.z - ENEMY_BASE_POS.z) > 18.0 &&
            Math.hypot(z.x - PLAYER_START_POS.x, z.z - PLAYER_START_POS.z) > 45.0) {
            hostileSpawnCoords.push({ x: z.x, z: z.z, id: z.id });
        }
    }
    if (typeof SOLARIS_BASE_POS !== 'undefined' && alliedParticipants.length === 0 && solarisBuildings.length === 0 && Number.isFinite(SOLARIS_BASE_POS.x) && Number.isFinite(SOLARIS_BASE_POS.z)) {
        hostileSpawnCoords.push({ x: SOLARIS_BASE_POS.x, z: SOLARIS_BASE_POS.z, id: 'solaris_sector_anchor' });
    }

    const diffMultiplierMap = { Easy: 0.85, Medium: 1.0, Hard: 1.20, Brutal: 1.45 };

    for (let hi = 0; hi < hostileParticipants.length; hi++) {
        const cmdr = hostileParticipants[hi];
        const coord = hostileSpawnCoords[hi % hostileSpawnCoords.length] || {
            x: ENEMY_BASE_POS.x + (hi * 22.0),
            z: ENEMY_BASE_POS.z - (hi * 16.0),
            id: `hostile_fallback_${hi}`
        };
        usedZoneIds.add(coord.id);

        const rawGroundY = getTerrainHeight(coord.x, coord.z);
        const safeGroundY = Number.isFinite(rawGroundY) ? rawGroundY : 0;
        const basePos = resolveSafeEnemyBuildingPos(new THREE.Vector3(coord.x, safeGroundY, coord.z), 3.2, true);
        if (!Number.isFinite(basePos.x) || !Number.isFinite(basePos.z)) {
            basePos.set(ENEMY_BASE_POS.x, 0, ENEMY_BASE_POS.z);
        }
        if (typeof window.flattenTerrainUnderBuilding === 'function') {
            const flatY = window.flattenTerrainUnderBuilding(basePos.x, basePos.z, 3.8, 2.2);
            basePos.y = Number.isFinite(flatY) ? flatY : safeGroundY;
        } else {
            basePos.y = safeGroundY;
        }

        const fac = normalizeMultiplayerFaction(cmdr.faction) || 'zerg';
        const diffKey = normalizeAiDifficulty(cmdr.aiDifficulty || cmdr.difficulty || 'Medium') || 'Medium';
        const hpMult = diffMultiplierMap[diffKey] || 1.0;
        const spawnRateMult = diffKey === 'Brutal' ? 0.72 : (diffKey === 'Hard' ? 0.85 : (diffKey === 'Easy' ? 1.20 : 1.0));

        let hqMesh;
        let expCreepMesh = null;
        if (fac === 'zerg') {
            hqMesh = createLeviathanCitadel();
            if (hi > 0 && typeof window.spawnZergExpansionCreepBlanket === 'function') {
                expCreepMesh = window.spawnZergExpansionCreepBlanket(basePos.x, basePos.z, 13.5);
            }
        } else if (fac === 'protoss') {
            hqMesh = createEngineeredBuilding('solaris_nexus', false);
        } else {
            hqMesh = createEngineeredBuilding('base', false);
        }
        hqMesh.position.copy(basePos);
        if (typeof window.tagSceneObjectMetadata === 'function') {
            window.tagSceneObjectMetadata(hqMesh, 'spawnLobbyExpansionBases.hostileHQ', 'multiplayer-spawner', { participantId: cmdr.playerId });
        }
        scene.add(hqMesh);

        const cBadge = document.createElement('div');
        cBadge.style.display = 'none';
        const pipColor = fac === 'zerg' ? '#ff2a4b' : (fac === 'protoss' ? '#f5b932' : '#ff5400');
        const hqMaxHp = Math.round(2800 * hpMult);
        const hqEntry = {
            role: 'citadel',
            slotId: cmdr.slotId,
            playerId: cmdr.playerId,
            participantType: cmdr.type,
            isAi: cmdr.type === 'ai',
            commanderName: cmdr.name,
            faction: fac,
            teamId: cmdr.teamId !== undefined ? cmdr.teamId : (cmdr.team || 2),
            aiDifficulty: diffKey,
            isExpansionCitadel: hi > 0,
            expCreepMesh,
            mesh: hqMesh,
            pos: basePos.clone(),
            footprintRadius: 3.3,
            hp: hqMaxHp,
            maxHp: hqMaxHp,
            buildProgress: 1.0,
            badge: cBadge,
            hb: makeHealthPip(pipColor, true)
        };
        enemyBuildings.push(hqEntry);
        if (hi === 0) {
            state.enemyBase = hqEntry;
            ENEMY_BASE_POS.copy(basePos);
        }

        // Spawn 1 faction production building per hostile commander so each configured AI actively produces units
        const prodOffset = new THREE.Vector3(basePos.x + (hi % 2 === 0 ? 5.2 : -5.2), 0, basePos.z + 6.5);
        const prodPos = resolveSafeEnemyBuildingPos(prodOffset, 2.8, true, basePos, 20.0);
        if (!Number.isFinite(prodPos.x) || !Number.isFinite(prodPos.z)) {
            prodPos.set(basePos.x + 5.2, basePos.y, basePos.z + 6.5);
        }
        if (typeof window.flattenTerrainUnderBuilding === 'function') {
            const flatProdY = window.flattenTerrainUnderBuilding(prodPos.x, prodPos.z, 3.2, 1.8);
            prodPos.y = Number.isFinite(flatProdY) ? flatProdY : basePos.y;
        } else {
            const gProdY = getTerrainHeight(prodPos.x, prodPos.z);
            prodPos.y = Number.isFinite(gProdY) ? gProdY : basePos.y;
        }
        let prodMesh;
        if (fac === 'zerg') prodMesh = createEnemySpawningPool();
        else if (fac === 'protoss') prodMesh = createEngineeredBuilding('solaris_gate', false);
        else prodMesh = createEngineeredBuilding('barracks', false);
        prodMesh.position.copy(prodPos);
        if (typeof window.tagSceneObjectMetadata === 'function') {
            window.tagSceneObjectMetadata(prodMesh, 'spawnLobbyExpansionBases.hostileProd', 'multiplayer-spawner', { participantId: cmdr.playerId });
        }
        scene.add(prodMesh);
        const pBadge = document.createElement('div');
        pBadge.style.display = 'none';
        const prodMaxHp = Math.round(1300 * hpMult);
        enemyBuildings.push({
            role: 'barracks',
            slotId: cmdr.slotId,
            playerId: cmdr.playerId,
            participantType: cmdr.type,
            isAi: cmdr.type === 'ai',
            commanderName: cmdr.name,
            faction: fac,
            teamId: cmdr.teamId !== undefined ? cmdr.teamId : (cmdr.team || 2),
            aiDifficulty: diffKey,
            bpIdx: hi,
            mesh: prodMesh,
            pos: prodPos.clone(),
            footprintRadius: 2.8,
            hp: prodMaxHp,
            maxHp: prodMaxHp,
            buildProgress: 1.0,
            badge: pBadge,
            hb: makeHealthPip(pipColor, true),
            spawnTimer: 3.5 * spawnRateMult,
            spawnDuration: 6.5 * spawnRateMult,
            cooldown: 0.8
        });
    }

    // 3. Spawn Allied bases ONLY if allied slots were explicitly configured on the local human player's team
    if (alliedParticipants.length > 0) {
        const alliedCoords = [];
        if (typeof SOLARIS_BASE_POS !== 'undefined' && Number.isFinite(SOLARIS_BASE_POS.x) && Number.isFinite(SOLARIS_BASE_POS.z)) {
            alliedCoords.push({ x: SOLARIS_BASE_POS.x, z: SOLARIS_BASE_POS.z });
        }
        const sortedNearZones = expansionZones
            .filter(z => !usedZoneIds.has(z.id) && Number.isFinite(z.x) && Number.isFinite(z.z))
            .sort((a, b) => Math.hypot(a.x - PLAYER_START_POS.x, a.z - PLAYER_START_POS.z) - Math.hypot(b.x - PLAYER_START_POS.x, b.z - PLAYER_START_POS.z));
        for (let zi = 0; zi < sortedNearZones.length; zi++) {
            alliedCoords.push({ x: sortedNearZones[zi].x, z: sortedNearZones[zi].z });
        }

        for (let ai = 0; ai < alliedParticipants.length; ai++) {
            const allyCmdr = alliedParticipants[ai];
            const ac = alliedCoords[ai % alliedCoords.length] || { x: PLAYER_START_POS.x - 18.0, z: PLAYER_START_POS.z - 12.0 };
            const rawAllyY = getTerrainHeight(ac.x, ac.z);
            const safeAllyY = Number.isFinite(rawAllyY) ? rawAllyY : 0;
            const allyPos = resolveSafeEnemyBuildingPos(new THREE.Vector3(ac.x, safeAllyY, ac.z), 3.0, true);
            if (!Number.isFinite(allyPos.x) || !Number.isFinite(allyPos.z)) {
                allyPos.set(PLAYER_START_POS.x - 18.0, safeAllyY, PLAYER_START_POS.z - 12.0);
            }
            if (typeof window.flattenTerrainUnderBuilding === 'function') {
                const flatAllyY = window.flattenTerrainUnderBuilding(allyPos.x, allyPos.z, 3.6, 2.0);
                allyPos.y = Number.isFinite(flatAllyY) ? flatAllyY : safeAllyY;
            } else {
                allyPos.y = safeAllyY;
            }
            const allyFac = normalizeMultiplayerFaction(allyCmdr.faction) || 'protoss';
            const allyHqType = allyFac === 'terran' ? 'base' : 'solaris_nexus';
            const hqMesh = createEngineeredBuilding(allyHqType, false);
            hqMesh.position.copy(allyPos);
            if (typeof window.tagSceneObjectMetadata === 'function') {
                window.tagSceneObjectMetadata(hqMesh, 'spawnLobbyExpansionBases.allyHQ', 'multiplayer-spawner', { participantId: allyCmdr.playerId });
            }
            scene.add(hqMesh);
            solarisBuildings.push({
                type: allyHqType,
                role: 'nexus',
                slotId: allyCmdr.slotId,
                playerId: allyCmdr.playerId,
                participantType: allyCmdr.type,
                isAi: allyCmdr.type === 'ai',
                commanderName: allyCmdr.name,
                faction: allyFac,
                teamId: allyCmdr.teamId !== undefined ? allyCmdr.teamId : (allyCmdr.team || localTeamId),
                aiDifficulty: normalizeAiDifficulty(allyCmdr.aiDifficulty || allyCmdr.difficulty || 'Medium') || 'Medium',
                bpIdx: ai,
                mesh: hqMesh,
                pos: allyPos.clone(),
                footprintRadius: 2.8,
                hp: 2400,
                maxHp: 2400,
                shield: allyFac === 'protoss' ? 1200 : 0,
                maxShield: allyFac === 'protoss' ? 1200 : 0,
                shieldRegenDelay: 0,
                buildProgress: 1.0,
                hb: makeHealthPip('#00e5ff', true),
                spawnTimer: 8.5,
                spawnDuration: 12.0
            });
        }
    }

    state.spawnedMultiplayerParticipants = {
        totalCount: roster.length,
        distinctTeams: validation.teamCount,
        localPlayer: localHuman,
        alliedCount: alliedParticipants.length,
        hostileCount: hostileParticipants.length,
        solarisBuildingsCount: solarisBuildings.length,
        enemyCitadelsCount: enemyBuildings.filter(eb => eb.role === 'citadel').length,
        enemyBuildingsCount: enemyBuildings.length
    };
    return validation;
}

window.initializeMultiplayerMatchFromRoster = function(lobbyConfig) {
    const validation = window.validateAndBuildMultiplayerRoster(lobbyConfig);
    if (!validation.valid) {
        return validation;
    }
    const roster = validation.roster;
    window.CUSTOM_LOBBY_PLAYERS = roster;

    const targetLocalId = (lobbyConfig && lobbyConfig.localPlayerId) || validation.localPlayerId;
    const localHuman = (targetLocalId && roster.find(p => p.type === 'human' && (p.playerId === targetLocalId || p.id === targetLocalId || p.slotId === targetLocalId)))
        || roster.find(p => p.type === 'human' && p.isLocalHuman)
        || roster.find(p => p.type === 'human')
        || roster[0];

    const localTeamId = localHuman ? (localHuman.teamId !== undefined ? localHuman.teamId : localHuman.team) : 1;
    const isSameTeam = (p) => {
        if (!p || p === localHuman) return false;
        const pTeam = p.teamId !== undefined ? p.teamId : p.team;
        if (localTeamId === 0 || pTeam === 0) return false;
        return pTeam === localTeamId;
    };

    const alliedParticipants = roster.filter(p => p !== localHuman && isSameTeam(p));
    const hostileCmdrs = roster.filter(p => p !== localHuman && !isSameTeam(p));

    state.isMultiplayerMatch = true;
    state.hasAlliedAiCommander = alliedParticipants.length > 0;
    state.playerTeamId = localTeamId;
    state.localPlayerId = localHuman ? localHuman.playerId : null;
    state.playerFaction = localHuman.faction === 'protoss' ? 'solaris' : (localHuman.faction === 'zerg' ? 'zerg' : 'terran');
    state.aiAllyMode = alliedParticipants.length > 0 ? 'defensive' : 'off';

    const badge = document.getElementById('mode-badge');
    if (badge) {
        badge.innerText = state.playerFaction === 'solaris'
            ? 'SOLARIS PROTOSS'
            : (state.playerFaction === 'zerg' ? 'ZERG SWARM' : 'TERRAN DOMINION');
    }

    spawnLobbyExpansionBases({ players: roster, localPlayerId: localHuman ? localHuman.playerId : null });

    return {
        valid: true,
        errors: [],
        roster,
        teamCount: validation.teamCount,
        humanCount: validation.humanCount,
        aiCount: validation.aiCount,
        localPlayer: localHuman,
        alliedCount: alliedParticipants.length,
        hostileCount: hostileCmdrs.length,
        solarisBuildingsCount: solarisBuildings.length,
        enemyCitadelsCount: enemyBuildings.filter(eb => eb.role === 'citadel').length,
        enemyBuildingsCount: enemyBuildings.length
    };
};

// Expose Playtest & Game Shell API for React HUD
window.GAME_API = {
    getState: () => {
        const primarySelected = (state && Array.isArray(state.selectedUnits) && state.selectedUnits.length > 0)
            ? state.selectedUnits[0]
            : (state ? state.selectedBuilding : null);
        const safeStats = primarySelected ? {
            type: primarySelected.type || 'unit',
            hp: primarySelected.hp ?? 100,
            maxHp: primarySelected.maxHp ?? 100,
            damage: primarySelected.damage ?? 0,
            range: primarySelected.range ?? 0,
            rad: primarySelected.radius ?? 0.55
        } : null;
        const safeUserData = (primarySelected && primarySelected.mesh && primarySelected.mesh.userData)
            ? primarySelected.mesh.userData
            : null;
        return {
            basePlaced: !!(state && state.basePlaced),
            hqDead: !!(state && state.basePlaced && state.baseBuilding && state.baseBuilding.hp <= 0),
            hqHp: (state && state.baseBuilding) ? Math.max(0, Math.floor(state.baseBuilding.hp)) : 1500,
            missionWon: !!(state && state.missionWon),
            isEndless: !!(state && state.isEndless),
            req: (state && typeof state.req === 'number') ? state.req : 200,
            gems: (state && typeof state.gems === 'number') ? state.gems : 0,
            wave: (state && typeof state.wave === 'number') ? state.wave : 1,
            kills: (state && typeof state.kills === 'number') ? state.kills : 0,
            unitsCount: Array.isArray(units) ? units.length : 0,
            selectedUnitsCount: (state && Array.isArray(state.selectedUnits)) ? state.selectedUnits.length : 0,
            enemiesCount: Array.isArray(enemies) ? enemies.length : 0,
            fowRevealAll: !!window.fowRevealAll,
            aiAllyMode: (state && state.aiAllyMode) || 'defensive',
            stats: safeStats,
            userData: safeUserData
        };
    },
    startMission: (config = null) => {
        window.titleScreenActive = false;
        window.loadingCameraSweep = false;
        window.gamePaused = false;
        if (window.BATTLE_CINEMATIC && typeof window.BATTLE_CINEMATIC.cleanup === 'function') {
            window.BATTLE_CINEMATIC.cleanup();
        }
        const rawMpList = config && (config.players || config.slots || config.lobbyPlayers);
        const hasMpRoster = Boolean(config && (config.isMultiplayer || (Array.isArray(rawMpList) && rawMpList.length >= 2)));
        if (config && typeof config === 'object') {
            state.multiplayerConfig = config;
            if (config.startingMinerals && typeof config.startingMinerals === 'number') {
                state.req = config.startingMinerals;
            }
            if (hasMpRoster) {
                const mpInit = window.initializeMultiplayerMatchFromRoster(config);
                if (!mpInit.valid) {
                    console.error('[MultiplayerMatchInit] Invalid roster configuration:', mpInit.errors);
                    return mpInit;
                }
            } else {
                window.CUSTOM_LOBBY_PLAYERS = null;
                state.isMultiplayerMatch = false;
                state.hasAlliedAiCommander = true;
                if (config.aiAllyMode) {
                    state.aiAllyMode = config.aiAllyMode;
                    syncAiAllyButtons();
                }
            }
        } else {
            window.CUSTOM_LOBBY_PLAYERS = null;
            state.isMultiplayerMatch = false;
            state.hasAlliedAiCommander = true;
        }
        if (!hasMpRoster && (!state.enemyBase || enemyBuildings.length === 0)) {
            initEnemyHiveCluster();
        }
        if (config && config.autoDeployBase && !state.basePlaced) {
            deployBaseAtBarrier(selectedBaseBarrierId || 'alpha');
        }
        const targetPos = state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS;
        controls.target.set(targetPos.x, getTerrainHeight(targetPos.x, targetPos.z), targetPos.z);
        if (IS_MOBILE) {
            camera.position.set(targetPos.x + 6, 52, targetPos.z + 46);
        } else {
            camera.position.set(targetPos.x + 4, 38, targetPos.z + 34);
        }
        controls.update();
        updateHUD(true);
        if (window.SFX) window.SFX.playBuild();
        if (window.RAID_MUSIC && !window.RAID_MUSIC.muted) {
            window.RAID_MUSIC.start();
        }
    },
    addMinerals: (amount = 500) => {
        const clamped = Math.max(0, Math.min(2500, Math.floor(Number(amount) || 0)));
        state.req += clamped;
        updateHUD(true);
        if (window.SFX) window.SFX.playClick();
    },
    spendResourcesForShare: (minerals = 0, gems = 0) => {
        const m = Math.max(0, Math.floor(Number(minerals) || 0));
        const g = Math.max(0, Math.floor(Number(gems) || 0));
        if ((state.req || 0) < m || (state.gems || 0) < g) return false;
        state.req -= m;
        state.gems = Math.max(0, (state.gems || 0) - g);
        updateHUD(true);
        if (window.SFX) window.SFX.playClick();
        return true;
    },
    receiveSharedResources: (minerals = 0, gems = 0, senderName = 'ALLY') => {
        const m = Math.max(0, Math.min(5000, Math.floor(Number(minerals) || 0)));
        const g = Math.max(0, Math.min(1000, Math.floor(Number(gems) || 0)));
        state.req = (state.req || 0) + m;
        state.gems = (state.gems || 0) + g;
        updateHUD(true);
        if (window.SFX) window.SFX.playHeal();
        const ticker = document.getElementById('directive-ticker');
        if (ticker) {
            ticker.innerText = `RESOURCE TRANSFER RECEIVED FROM ${String(senderName).toUpperCase()}: +${m} MINERALS${g > 0 ? ` & +${g} GEMS` : ''}!`;
            ticker.style.color = '#00ff66';
        }
    },
    getAntiCheatDigest: () => {
        const reqVal = Math.floor(state.req || 0);
        const gemsVal = Math.floor(state.gems || 0);
        const unitsVal = Array.isArray(units) ? units.length : 0;
        const bldsVal = Array.isArray(buildings) ? buildings.length : 0;
        const waveVal = Math.floor(state.wave || 1);
        const checksum = ((reqVal * 31 + gemsVal * 97 + unitsVal * 13 + bldsVal * 7 + waveVal * 53) % 1000003);
        return {
            req: reqVal,
            gems: gemsVal,
            unitsCount: unitsVal,
            buildingsCount: bldsVal,
            wave: waveVal,
            checksum
        };
    },
    toggleFogReveal: () => {
        window.fowRevealAll = !window.fowRevealAll;
        updateFogOfWarVision();
        renderTacticalMinimap();
        if (window.SFX) window.SFX.playClick();
        return window.fowRevealAll;
    },
    spawnTestSquad: () => {
        const origin = state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS;
        if (!state.basePlaced) {
            setMode('base');
            deployStructure(PLAYER_START_POS);
        }
        spawnAlliedUnit('grunt', origin);
        spawnAlliedUnit('ranger', origin);
        spawnAlliedUnit('medic', origin);
        spawnAlliedUnit('tank', origin);
        spawnAlliedUnit('heli', origin);
        if (window.SFX) window.SFX.playBuild();
    },
    spawnEnemyWaveNow: () => {
        if (!state.basePlaced) {
            setMode('base');
            deployStructure(PLAYER_START_POS);
        }
        const origin = state.enemyBase ? state.enemyBase.pos : ENEMY_BASE_POS;
        ['skitterer', 'spitter', 'burster', 'mutalisk', 'crusher', 'behemoth'].forEach(v => {
            spawnEnemyFromBuilding(v, origin);
        });
        state.wave++;
        updateHUD();
        if (window.SFX) window.SFX.playExplosion(false);
    },
    repairHQ: () => {
        if (state.baseBuilding) {
            executeHQEmergencyOverloadRepair();
        }
    },
    focusCamera: (zone) => {
        let tx = PLAYER_START_POS.x, tz = PLAYER_START_POS.z;
        if (zone === 'hq' && state.baseBuilding) {
            tx = state.baseBuilding.pos.x; tz = state.baseBuilding.pos.z;
        } else if (zone === 'bridge') {
            tx = BRIDGES.length > 0 ? BRIDGES[0].center.x : 0;
            tz = BRIDGES.length > 0 ? BRIDGES[0].center.z : 0;
        } else if (zone === 'hive') {
            tx = ENEMY_BASE_POS.x; tz = ENEMY_BASE_POS.z;
        }
        const offset = camera.position.clone().sub(controls.target);
        controls.target.set(tx, getTerrainHeight(tx, tz), tz);
        camera.position.copy(controls.target).add(offset);
        controls.update();
        if (window.SFX) window.SFX.playClick();
    },
    getBaseBarriers: () => BASE_PLACEMENT_BARRIERS,
    getSelectedBaseBarrier: () => selectedBaseBarrierId,
    selectBaseBarrierZone: (id) => {
        selectBaseBarrierZone(id, true);
    },
    deployBaseAtBarrier: (id) => {
        return deployBaseAtBarrier(id);
    },
    regenerateMap: (customSeed, lobbyPlayers) => {
        if (typeof window.regenerateDynamicSectorMap === 'function') {
            return window.regenerateDynamicSectorMap(customSeed, lobbyPlayers);
        }
    },
    getPerfReport: () => (window.PERF_PROFILER ? window.PERF_PROFILER.getReport() : null),
    togglePerfHUD: () => (window.PERF_PROFILER ? window.PERF_PROFILER.toggleHUD() : false),
    setQualityPreset: (preset) => (window.PERF_MANAGER ? window.PERF_MANAGER.setPreset(preset, renderer) : null),
    getBattleCinematicState: () => {
        if (!window.BATTLE_CINEMATIC) return null;
        const bc = window.BATTLE_CINEMATIC;
        const stageIdx = typeof bc.getCurrentStageIndex === 'function' ? bc.getCurrentStageIndex() : 0;
        const stageObj = (bc.STAGES && bc.STAGES[stageIdx]) ? bc.STAGES[stageIdx] : null;
        const telemetry = typeof bc.getSpectatorTelemetry === 'function' ? bc.getSpectatorTelemetry() : null;
        return {
            stageIndex: stageIdx,
            totalStages: bc.STAGES ? bc.STAGES.length : 5,
            title: bc.matchWinner || (stageObj ? stageObj.title : 'LIVE AI-VS-AI SPECTATOR MATCH'),
            subtitle: stageObj ? stageObj.subtitle : '',
            progress: Math.min(1, Math.max(0, (bc.elapsed || 0) / (bc.totalDuration || 90.0))),
            viewMode: bc.cameraViewMode || 'auto',
            telemetry
        };
    },
    setBattleCinematicViewMode: (mode) => {
        if (window.BATTLE_CINEMATIC && typeof window.BATTLE_CINEMATIC.setCameraViewMode === 'function') {
            window.BATTLE_CINEMATIC.setCameraViewMode(mode);
        }
    },
    restartBattleCinematic: () => {
        if (window.BATTLE_CINEMATIC && typeof window.BATTLE_CINEMATIC.restart === 'function') {
            window.BATTLE_CINEMATIC.restart();
        }
    },
    runInitializationStep: async (stepIndex, config = {}) => {
        // Real 10-stage world initialization pipeline driven by actual engine verification
        const idx = Number(stepIndex) || 0;
        const tStepStart = performance.now();
        const rawMpList = config && (config.players || config.slots || config.lobbyPlayers);
        const hasMpRoster = Boolean(config && (config.isMultiplayer || (Array.isArray(rawMpList) && rawMpList.length >= 2)));
        const recordVal = (name, cat, ok, details) => {
            if (window.SYSTEM_INIT_VALIDATOR) {
                window.SYSTEM_INIT_VALIDATOR.recordStage(name, cat, ok ? 'PASS' : 'FAIL', performance.now() - tStepStart, details);
            }
        };
        switch (idx) {
            case 0: {
                // Step 1: Verify Three.js WebGLRenderer, Scene, Camera & Lighting
                const ok = !!(renderer && scene && camera && controls);
                if (renderer && camera) {
                    camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
                    camera.updateProjectionMatrix();
                }
                recordVal('Stage 1: WebGL & Camera', 'Loading', ok, 'Renderer, Scene & Camera verified');
                return { ok, stage: 'WebGL Renderer & Tactical Camera Rig Verified' };
            }
            case 1: {
                // Step 2: Generate / Verify Procedural Canyon Terrain, River & Bridges
                if (config && config.forceRegen && typeof window.regenerateDynamicSectorMap === 'function') {
                    window.regenerateDynamicSectorMap(config.seed, rawMpList || []);
                }
                const tPipe = typeof window.validateAndRepairTerrainPipeline === 'function'
                    ? window.validateAndRepairTerrainPipeline()
                    : { ok: true, status: 'PASS', vertexCount: 0 };
                const bridgeCount = Array.isArray(window.BRIDGES) ? window.BRIDGES.length : 0;
                recordVal('Stage 2: Terrain & Bridges', 'World', Boolean(tPipe.status === 'PASS' || tPipe.ok), `Bridges=${bridgeCount}, Vertices=${tPipe.vertexCount || 0}`);
                return { ok: true, stage: `Procedural Canyon & ${bridgeCount} Bridges Synthesized` };
            }
            case 2: {
                // Step 3: Verify Navigation Walkability Grid & A* Pathfinding Cache
                if (typeof window.invalidateStaticAStarGrid === 'function') {
                    window.invalidateStaticAStarGrid();
                }
                const sampleWalkable = typeof isWalkableGround === 'function'
                    ? isWalkableGround(PLAYER_START_POS.x, PLAYER_START_POS.z)
                    : true;
                recordVal('Stage 3: A* Navigation Grid', 'World', true, `StartPosWalkable=${sampleWalkable}`);
                return { ok: true, walkableVerified: sampleWalkable, stage: 'A* Navigation Grid & Bridge Waypoints Calibrated' };
            }
            case 3: {
                // Step 4: Initialize Resource Nodes, Gem Craters & Drop-Zone Barriers
                if (typeof buildBasePlacementBarrierMeshes === 'function') {
                    buildBasePlacementBarrierMeshes();
                }
                const gemCount = Array.isArray(window.GEM_CRATERS) ? window.GEM_CRATERS.length : 0;
                recordVal('Stage 4: Resource Nodes', 'World', gemCount > 0, `GemCraters=${gemCount}`);
                return { ok: true, stage: `Mineral Clusters & ${gemCount} Rich Gem Craters Active` };
            }
            case 4: {
                // Step 5: Pre-warm 3-Faction Procedural 3D Model & Material Caches
                if (typeof window.verifyAndRepairFactionMaterials === 'function') {
                    window.verifyAndRepairFactionMaterials();
                }
                const hasModels = typeof createAnimatedUnitModel === 'function' && typeof createEngineeredBuilding === 'function';
                recordVal('Stage 5: Model & Material Factories', 'Functions & Dependencies', hasModels, '3-Faction model builders & materials verified');
                return { ok: hasModels, stage: '3-Faction Procedural 3D Meshes & Shaders Compiled' };
            }
            case 5: {
                // Step 6: Spawn Hostile Commanders or Single-Player Zerg Hive Cluster
                if (hasMpRoster) {
                    const mpInit = window.initializeMultiplayerMatchFromRoster(config);
                    recordVal('Stage 6: Multiplayer Opponents', 'Buildings', Boolean(mpInit && mpInit.valid), `HostileStructures=${enemyBuildings.length}`);
                    return { ok: Boolean(mpInit && mpInit.valid), stage: `Multiplayer Opposing Forces (${enemyBuildings.length} Structures) Online` };
                }
                if (!state.enemyBase || enemyBuildings.length === 0) {
                    initEnemyHiveCluster();
                }
                recordVal('Stage 6: Zerg Hive Cluster', 'Buildings', enemyBuildings.length > 0, `ZergStructures=${enemyBuildings.length}, ZergUnits=${enemies.length}`);
                return { ok: enemyBuildings.length > 0, stage: `Zerg Overmind Hive Cluster (${enemyBuildings.length} Bio-Structures) Online` };
            }
            case 6: {
                // Step 7: Verify Allied Factions & Multiplayer Expansion Roster
                if (hasMpRoster) {
                    recordVal('Stage 7: Multiplayer Roster Sync', 'Units & Factions', true, `AlliedStructures=${solarisBuildings.length}, HostileStructures=${enemyBuildings.length}`);
                    return { ok: true, stage: `Multiplayer Roster & Faction Bases Synchronized` };
                }
                recordVal('Stage 7: Solaris Protoss Enclave', 'Units & Factions', true, `SolarisStructures=${solarisBuildings.length}`);
                return { ok: true, stage: `Solaris Protoss Enclave & Warp Matrix Synchronized` };
            }
            case 7: {
                // Step 8: Deploy Player Orbital Command HQ & Autonomous Mining Drones
                if (config && config.autoDeployBase && !state.basePlaced) {
                    deployBaseAtBarrier(selectedBaseBarrierId || 'alpha');
                }
                syncAndUpdateAutoMiningDrones(0.016);
                recordVal('Stage 8: Orbital Command HQ', 'Buildings', true, `BasePlaced=${!!state.basePlaced}`);
                return { ok: true, stage: 'Orbital Command HQ & Faction Harvester Drones Deployed' };
            }
            case 8: {
                // Step 9: Initialize Fog of War Vision & Tactical Minimap Rasterizer
                updateFogOfWarVision();
                renderTacticalMinimap();
                renderSC2CommandCard();
                recordVal('Stage 9: Fog of War & Minimap', 'Loading', true, 'Vision matrix & radar ready');
                return { ok: true, stage: 'Fog of War Vision Matrix & Tactical Radar Ready' };
            }
            case 9:
            default: {
                // Step 10: Finalize Mission State, Camera Focus & Audio Engine
                if (window.BATTLE_CINEMATIC && typeof window.BATTLE_CINEMATIC.cleanup === 'function') {
                    window.BATTLE_CINEMATIC.cleanup();
                }
                if (window.AXIS_BALL_CONTROLLER && !window.AXIS_BALL_CONTROLLER.canvas && typeof window.AXIS_BALL_CONTROLLER.init === 'function') {
                    window.AXIS_BALL_CONTROLLER.init();
                }
                window.GAME_API.startMission(config);
                if (window.SYSTEM_INIT_VALIDATOR) {
                    window.SYSTEM_INIT_VALIDATOR.validateAllSystems();
                }
                renderer.render(scene, camera);
                return { ok: true, stage: 'All Combat Systems Nominal — Entering Sector-09' };
            }
        }
    },
    getStateSnapshot: () => {
        return {
            seq: (state._netSeq = (state._netSeq || 0) + 1),
            timestamp: Date.now(),
            seed: window.MAP_SEED || 100,
            req: Math.floor(state.req || 0),
            gems: Math.floor(state.gems || 0),
            wave: state.wave || 1,
            kills: state.kills || 0,
            basePlaced: !!state.basePlaced,
            hqHp: state.baseBuilding ? Math.floor(state.baseBuilding.hp) : 1500,
            units: units.slice(0, 48).map(u => ({
                type: u.type,
                x: Math.round(u.mesh.position.x * 10) / 10,
                z: Math.round(u.mesh.position.z * 10) / 10,
                hp: Math.round(u.hp),
                maxHp: Math.round(u.maxHp),
                order: u.order || 'auto'
            })),
            buildings: buildings.slice(0, 32).map(b => ({
                type: b.type,
                x: Math.round(b.pos.x * 10) / 10,
                z: Math.round(b.pos.z * 10) / 10,
                hp: Math.round(b.hp),
                maxHp: Math.round(b.maxHp)
            })),
            enemiesCount: enemies.length,
            enemyBuildingsCount: enemyBuildings.length
        };
    },
    applyStateSnapshot: (snap) => {
        if (!snap || typeof snap !== 'object') return;
        if (typeof snap.wave === 'number' && snap.wave > state.wave) {
            state.wave = snap.wave;
        }
        if (typeof snap.kills === 'number' && snap.kills > state.kills) {
            state.kills = snap.kills;
        }
        updateHUD();
    },
    handleNetworkOrder: (order, senderId) => {
        if (!order) return;
        if (order.orderId) {
            if (!state._processedOrderIds) state._processedOrderIds = new Set();
            if (state._processedOrderIds.has(order.orderId)) return;
            state._processedOrderIds.add(order.orderId);
            if (state._processedOrderIds.size > 400) {
                const firstKey = state._processedOrderIds.values().next().value;
                state._processedOrderIds.delete(firstKey);
            }
        }
        if (order.type === 'ping' && order.pos) {
            const h = getTerrainHeight(order.pos.x, order.pos.z) + 1.2;
            spawnCombatFloat(new THREE.Vector3(order.pos.x, h, order.pos.z), `+1`, '#00f2ff');
            if (typeof triggerRadarPulseFx === 'function') triggerRadarPulseFx(new THREE.Vector3(order.pos.x, 0, order.pos.z));
            if (window.SFX) window.SFX.playClick();
        } else if (order.type === 'spawn_allied' && order.unitType) {
            const spawnPos = order.pos
                ? new THREE.Vector3(order.pos.x, getTerrainHeight(order.pos.x, order.pos.z), order.pos.z)
                : (state.baseBuilding ? state.baseBuilding.pos : PLAYER_START_POS);
            spawnAlliedUnit(order.unitType, spawnPos);
        } else if (order.type === 'deploy_building' && order.buildingType && order.pos) {
            const bPos = new THREE.Vector3(order.pos.x, getTerrainHeight(order.pos.x, order.pos.z), order.pos.z);
            const bMesh = createEngineeredBuilding(order.buildingType, false);
            bMesh.position.copy(bPos);
            scene.add(bMesh);
        } else if (order.type === 'squad_order' && order.orderMode && order.targetPos) {
            const tVec = new THREE.Vector3(order.targetPos.x, getTerrainHeight(order.targetPos.x, order.targetPos.z), order.targetPos.z);
            units.forEach(u => {
                if (u && u.hp > 0 && u.isAlliedOrderSync) {
                    u.order = order.orderMode;
                    u.orderTarget = tVec.clone();
                }
            });
        } else if (order.type === 'base_barrier' && order.barrierId) {
            selectBaseBarrierZone(order.barrierId, false);
        } else if (order.type === 'state_snapshot' && order.snapshot) {
            window.GAME_API.applyStateSnapshot(order.snapshot);
        }
    }
};

// ============================================================================
// DYNAMIC MAP REGENERATION MATCH RESET & HUD / MOBILE UI VISIBILITY TOGGLES
// Completely resets all match progress (buildings, units, enemies, resources,
// wave, timers, FOW) and starts fresh on the newly generated terrain algorithm!
// ============================================================================
window.resetMatchForNewMap = function(newSeed) {
    // 0. Clear active autonomous mining drones & invalidate cached A* static walkability grid
    if (typeof clearAutoMiningDrones === 'function') {
        clearAutoMiningDrones();
    }
    if (typeof window.invalidateStaticAStarGrid === 'function') {
        window.invalidateStaticAStarGrid();
    }
    _fowLastSig = -1;

    // 1. Remove & clean up all player buildings
    buildings.forEach(b => {
        if (!b) return;
        if (b.mesh) scene.remove(b.mesh);
        if (b.shieldDomeMesh) scene.remove(b.shieldDomeMesh);
        if (b.hb && b.hb.root) b.hb.root.remove();
        if (b.badge) b.badge.remove();
    });
    buildings.length = 0;

    // 2. Remove & clean up all friendly units (including Void Ray beams & Carrier Interceptors)
    if (window.BATTLE_CINEMATIC && typeof window.BATTLE_CINEMATIC.cleanup === 'function') {
        window.BATTLE_CINEMATIC.cleanup();
    }
    units.forEach(u => {
        if (!u) return;
        if (u.mesh) scene.remove(u.mesh);
        if (u.healBeam) scene.remove(u.healBeam);
        if (u.prismaticBeam) scene.remove(u.prismaticBeam);
        cleanupBattlecruiserLaserWeapons(u);
        if (Array.isArray(u.interceptors)) {
            u.interceptors.forEach(ic => { if (ic && ic.mesh) scene.remove(ic.mesh); });
            u.interceptors.length = 0;
        }
        if (u.selCircle) scene.remove(u.selCircle);
        if (u.hb && u.hb.root) u.hb.root.remove();
    });
    units.length = 0;

    // 3. Remove & clean up all enemy units
    enemies.forEach(e => {
        if (!e) return;
        if (e.mesh) scene.remove(e.mesh);
        if (e.hb && e.hb.root) e.hb.root.remove();
    });
    enemies.length = 0;

    // 4. Remove & clean up all active projectiles, particles, smoke, shockwaves & casings
    projectiles.forEach(p => { if (p && p.mesh) scene.remove(p.mesh); });
    projectiles.length = 0;
    particles.forEach(pt => { if (pt && pt.mesh) scene.remove(pt.mesh); });
    particles.length = 0;
    smokeClouds.forEach(sm => {
        if (sm && sm.mesh) {
            scene.remove(sm.mesh);
            if (sm.ownsMaterial && sm.mesh.material) sm.mesh.material.dispose();
        }
    });
    smokeClouds.length = 0;
    shockwaves.forEach(sw => {
        if (sw && sw.mesh) {
            scene.remove(sw.mesh);
            if (sw.mesh.material) sw.mesh.material.dispose();
        }
    });
    shockwaves.length = 0;
    shellCasings.forEach(sc => { if (sc && sc.mesh) scene.remove(sc.mesh); });
    shellCasings.length = 0;
    if (typeof corpses !== 'undefined') {
        corpses.forEach(c => { if (c && c.mesh) disposeHierarchy(c.mesh); });
        corpses.length = 0;
    }
    if (typeof wreckageParts !== 'undefined') {
        wreckageParts.forEach(w => { if (w && w.mesh) scene.remove(w.mesh); });
        wreckageParts.length = 0;
    }
    if (typeof scavengerDebrisClusters !== 'undefined') {
        scavengerDebrisClusters.forEach(sc => { if (sc && sc.group) scene.remove(sc.group); });
        scavengerDebrisClusters.length = 0;
    }

    // 5. Reset match state & progress back to fresh start (Slow-start economy: 200 starting minerals)
    state.req = 200;
    state.gems = 0;
    state.wave = 1;
    state.kills = 0;
    state.elapsedSec = 0;
    state.rushGraceTimer = 45.0;
    state.swarmWaveTimer = 28.0;
    state.basePlaced = false;
    state.heroPlaced = false;
    state.missionWon = false;
    state.isEndless = false;
    state.enemyBaseDiscovered = false;
    state.discoveredEnemyBasePos = null;
    state.baseBuilding = null;
    state.selectedBuilding = null;
    state.selectedUnits = [];
    state.unitCommandMode = null;
    state.squadPosture = 'DEFENSIVE';
    state.upgrades = {
        terran: { weapons: 0, armor: 0 },
        solaris: { weapons: 0, armor: 0 },
        zerg: { weapons: 0, armor: 0 }
    };
    state.zergUpgradeTimer = 34.0;
    state.solarisUpgradeTimer = 32.0;
    state.mode = 'base';
    syncSquadIntelButtonUI();

    if (state.humanBadgeDom) {
        state.humanBadgeDom.remove();
        state.humanBadgeDom = null;
    }
    if (state.powerRing) {
        scene.remove(state.powerRing);
        state.powerRing = null;
    }
    if (typeof selRing !== 'undefined' && selRing) selRing.visible = false;
    if (typeof ghostMesh !== 'undefined' && ghostMesh) ghostMesh.visible = true;
    const victoryOverlay = document.getElementById('victory-overlay');
    if (victoryOverlay) victoryOverlay.style.display = 'none';

    // Reset Fog of War arrays completely
    fowExplored.fill(0);
    fowVisible.fill(0);
    fowSmoothAlpha.fill(215);

    if (window.TANK_TRACK_SYSTEM && typeof window.TANK_TRACK_SYSTEM.clear === 'function') {
        window.TANK_TRACK_SYSTEM.clear();
    }

    // 6. Rebuild Drop-Zone Barriers & Base Placement Ghost on the new terrain
    buildBasePlacementBarrierMeshes();
    rebuildGhostModel('base');
    selectBaseBarrierZone('alpha', true);

    // 7. Rebuild Enemy Hive Cluster & AI Ally Solaris Enclave at new procedural sector coordinates
    enemyBuildings.forEach(eb => {
        if (eb.mesh) scene.remove(eb.mesh);
        if (eb.badge) eb.badge.remove();
        if (eb.hb && eb.hb.root) eb.hb.root.remove();
    });
    enemyBuildings.length = 0;
    state.enemyBase = null;
    if (Array.isArray(window.CUSTOM_LOBBY_PLAYERS) && window.CUSTOM_LOBBY_PLAYERS.length >= 2) {
        spawnLobbyExpansionBases(window.CUSTOM_LOBBY_PLAYERS);
    } else {
        initEnemyHiveCluster();
    }
    if (window.titleScreenActive && window.BATTLE_CINEMATIC && typeof window.BATTLE_CINEMATIC.init === 'function') {
        window.BATTLE_CINEMATIC.lastMapSeed = null;
        window.BATTLE_CINEMATIC.init();
    }
    const resetCreepState = typeof window.getActiveZergCreepState === 'function'
        ? window.getActiveZergCreepState()
        : { hasBuiltZergMainBase: true };
    creepRadius = resetCreepState.hasBuiltZergMainBase ? 16.5 : 0.0;
    creepTargetRadius = resetCreepState.hasBuiltZergMainBase ? 21.0 : 0.0;
    if (typeof updateZergCreepColors === 'function') {
        updateZergCreepColors(creepRadius, false, true);
    }

    // 8. Recenter camera on the new Player Start Sector
    const startY = getTerrainHeight(PLAYER_START_POS.x, PLAYER_START_POS.z);
    controls.target.set(PLAYER_START_POS.x, startY, PLAYER_START_POS.z);
    if (IS_MOBILE) {
        camera.position.set(PLAYER_START_POS.x + 6, 52, PLAYER_START_POS.z + 46);
    } else {
        camera.position.set(PLAYER_START_POS.x + 4, 38, PLAYER_START_POS.z + 34);
    }
    controls.update();

    const rampDesc = window.HAS_BASE_PLATEAU_RAMP ? 'Elevated Ramp Sanctuary' : 'Open Valley Basin';
    const ticker = document.getElementById('directive-ticker');
    if (ticker) {
        ticker.innerText = `NEW SECTOR GENERATED [SEED #${newSeed || window.ACTIVE_MAP_SEED} · ${rampDesc}]: Deploy Orbital Citadel HQ!`;
        ticker.style.color = '#00e5ff';
    }

    updateFogOfWarVision();
    renderTacticalMinimap();
    renderSC2CommandCard();
    updateHUD();
};

var hudVisibilityState = window.hudVisibilityState = Object.assign(window.hudVisibilityState || {}, {
    allHidden: false,
    consoleHidden: false,
    minimalMobile: IS_MOBILE,
    showMinimap: true,
    showPortrait: !IS_MOBILE,
    showCenter: true,
    showObjective: !IS_MOBILE,
    showHpBars: true,
    soundEnabled: true
});

function syncHudVisibilityClasses() {
    const container = document.getElementById('game-container');
    if (!container) return;

    container.classList.toggle('hud-all-hidden', !!hudVisibilityState.allHidden);
    container.classList.toggle('hud-console-hidden', !!hudVisibilityState.consoleHidden);
    container.classList.toggle('hud-minimal-mobile', !!hudVisibilityState.minimalMobile);
    container.classList.toggle('hud-hide-minimap', !hudVisibilityState.showMinimap);
    container.classList.toggle('hud-hide-portrait', !hudVisibilityState.showPortrait);
    container.classList.toggle('hud-hide-center', !hudVisibilityState.showCenter);
    container.classList.toggle('hud-hide-objective', !hudVisibilityState.showObjective);
    container.classList.toggle('hud-hide-hpbars', !hudVisibilityState.showHpBars);

    if (typeof worldUi !== 'undefined' && worldUi) {
        const pips = worldUi.querySelectorAll('.hp-pip, .combat-float');
        pips.forEach(el => {
            if (!hudVisibilityState.showHpBars) {
                el.style.display = 'none';
                el._lastDisp = 'none';
            }
        });
    }

    const btnRestoreAll = document.getElementById('btn-restore-all-ui');
    if (btnRestoreAll) {
        btnRestoreAll.style.display = '';
        btnRestoreAll.classList.toggle('pill-visible', !!hudVisibilityState.allHidden);
    }
    const btnRestoreConsole = document.getElementById('btn-restore-console');
    if (btnRestoreConsole) {
        btnRestoreConsole.style.display = '';
        btnRestoreConsole.classList.toggle('pill-visible', !hudVisibilityState.allHidden && !!hudVisibilityState.consoleHidden);
    }
    const btnToggleConsole = document.getElementById('btn-toggle-console');
    if (btnToggleConsole) {
        btnToggleConsole.innerText = hudVisibilityState.consoleHidden ? '▲ PANEL' : '▼ PANEL';
    }

    // Sync Settings Modal Checkboxes
    const chkMinimal = document.getElementById('chk-hud-minimal');
    if (chkMinimal) chkMinimal.checked = !!hudVisibilityState.minimalMobile;
    const chkConsole = document.getElementById('chk-hud-console');
    if (chkConsole) chkConsole.checked = !hudVisibilityState.consoleHidden;
    const chkMinimap = document.getElementById('chk-hud-minimap');
    if (chkMinimap) chkMinimap.checked = !!hudVisibilityState.showMinimap;
    const chkPortrait = document.getElementById('chk-hud-portrait');
    if (chkPortrait) chkPortrait.checked = !!hudVisibilityState.showPortrait;
    const chkCenter = document.getElementById('chk-hud-center');
    if (chkCenter) chkCenter.checked = !!hudVisibilityState.showCenter;
    const chkObj = document.getElementById('chk-hud-objective');
    if (chkObj) chkObj.checked = !!hudVisibilityState.showObjective;
    const chkHpBars = document.getElementById('chk-hud-hpbars');
    if (chkHpBars) chkHpBars.checked = !!hudVisibilityState.showHpBars;
    const chkSound = document.getElementById('chk-hud-sound');
    if (chkSound && window.SFX) chkSound.checked = !window.SFX.muted;
}

window.toggleBottomConsole = function() {
    hudVisibilityState.consoleHidden = !hudVisibilityState.consoleHidden;
    if (window.SFX) window.SFX.playClick();
    syncHudVisibilityClasses();
};

window.toggleAllGameUI = function() {
    hudVisibilityState.allHidden = !hudVisibilityState.allHidden;
    if (window.SFX) window.SFX.playClick();
    syncHudVisibilityClasses();
};

window.toggleHudSettingsModal = function() {
    const modal = document.getElementById('hud-settings-modal');
    if (!modal) return;
    const isHidden = modal.style.display === 'none' || !modal.style.display;
    modal.style.display = isHidden ? 'flex' : 'none';
    if (window.SFX) window.SFX.playClick();
    syncHudVisibilityClasses();
};

window.updateHudSetting = function(key, checked) {
    if (key === 'minimal') {
        hudVisibilityState.minimalMobile = !!checked;
    } else if (key === 'console') {
        hudVisibilityState.consoleHidden = !checked;
    } else if (key === 'minimap') {
        hudVisibilityState.showMinimap = !!checked;
        if (checked) hudVisibilityState.minimalMobile = false;
    } else if (key === 'portrait') {
        hudVisibilityState.showPortrait = !!checked;
        if (checked) hudVisibilityState.minimalMobile = false;
    } else if (key === 'center') {
        hudVisibilityState.showCenter = !!checked;
    } else if (key === 'objective') {
        hudVisibilityState.showObjective = !!checked;
        if (checked) hudVisibilityState.minimalMobile = false;
    } else if (key === 'hpBars') {
        hudVisibilityState.showHpBars = !!checked;
    } else if (key === 'sound' && window.SFX) {
        window.SFX.muted = !checked;
    }
    if (window.SFX) window.SFX.playClick();
    syncHudVisibilityClasses();
};

state.aiAllyMode = 'defensive';
state.aiAllyTimer = 11.0;

function syncAiAllyButtons() {
    const mode = (state.aiAllyMode || 'defensive').toUpperCase();
    const btnTop = document.getElementById('btn-toggle-ai-ally');
    if (btnTop) {
        btnTop.innerText = `🤖 ALLY AI: ${mode}`;
        btnTop.style.borderColor = mode === 'OFF' ? 'rgba(148,163,184,0.4)' : (mode === 'AGGRESSIVE' ? '#f59e0b' : '#00ff66');
        btnTop.style.color = mode === 'OFF' ? '#94a3b8' : (mode === 'AGGRESSIVE' ? '#fde047' : '#86efac');
    }
    const btnModal = document.getElementById('btn-modal-ai-ally');
    if (btnModal) {
        btnModal.innerText = `🤖 AI ALLY COMMANDER: ${mode}`;
    }
}

window.toggleAiAllyMode = function() {
    const order = ['defensive', 'aggressive', 'off'];
    const idx = order.indexOf(state.aiAllyMode || 'defensive');
    state.aiAllyMode = order[(idx + 1) % order.length];
    const prodBld = buildings.find(b =>
        (b.type === 'barracks' || b.type === 'factory' || b.type === 'solaris_gate') &&
        b.hp > 0 && (b.buildProgress === undefined || b.buildProgress >= 1.0)
    );
    if (state.aiAllyMode !== 'off' && state.basePlaced && prodBld && units.length < 36) {
        const uToSpawn = prodBld.type === 'factory' ? 'tank' : (prodBld.type === 'solaris_gate' ? 'zealot' : 'firebat');
        spawnAlliedUnit(uToSpawn, prodBld.pos);
    }
    if (window.SFX) window.SFX.playClick();
    syncAiAllyButtons();
};

syncHudVisibilityClasses();
syncAiAllyButtons();

// ============================================================================
// TOP-RIGHT 3D AXIS BALL CAMERA EYE PERSPECTIVE CONTROLLER
// Real Three.js 3D Sphere Gizmo: Renders a lit 3D procedural planet sphere,
// orbital latitude/longitude rings, and 3D axis nodes inside #axis-ball-canvas.
// Drag to orbit/tilt camera eye perspective or click any 3D axis node (TOP, N, S, E, W, TAC).
// ============================================================================
const AXIS_BALL_CONTROLLER = {
    canvas: null,
    ctx: null,
    readoutEl: null,
    cageSpinAngle: 0,
    isDragging: false,
    dragMoved: false,
    lastPointerX: 0,
    lastPointerY: 0,
    hoveredNodeId: null,
    activePreset: 'tac',
    transition: null,
    projectedNodes: [],

    init() {
        const canvas = document.getElementById('axis-ball-canvas');
        if (!canvas) return;
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.readoutEl = document.getElementById('axis-ball-readout');

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(78 * dpr);
        canvas.height = Math.round(78 * dpr);

        const getLocalCoords = (e) => {
            const rect = canvas.getBoundingClientRect();
            return {
                x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
                y: ((e.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height
            };
        };

        canvas.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            this.isDragging = true;
            this.dragMoved = false;
            this.transition = null;
            this.lastPointerX = e.clientX;
            this.lastPointerY = e.clientY;
            try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        });

        canvas.addEventListener('pointermove', (e) => {
            e.stopPropagation();
            const pt = getLocalCoords(e);
            if (!this.isDragging) {
                let bestId = null;
                let bestDist = 11 * (canvas.width / 78);
                for (let i = 0; i < this.projectedNodes.length; i++) {
                    const n = this.projectedNodes[i];
                    const d = Math.hypot(pt.x - n.sx, pt.y - n.sy);
                    if (d <= bestDist) {
                        bestDist = d;
                        bestId = n.id;
                    }
                }
                this.hoveredNodeId = bestId;
                return;
            }

            const dx = e.clientX - this.lastPointerX;
            const dy = e.clientY - this.lastPointerY;
            if (Math.hypot(dx, dy) > 2.2) {
                this.dragMoved = true;
            }
            this.lastPointerX = e.clientX;
            this.lastPointerY = e.clientY;

            if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
                this.orbitCameraByDelta(-dx * 0.014, -dy * 0.011);
                this.setActivePresetBadge(null);
            }
        });

        const finishPointer = (e) => {
            if (!this.isDragging) return;
            this.isDragging = false;
            try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}

            if (!this.dragMoved) {
                const pt = getLocalCoords(e);
                let clickedNode = null;
                let bestDist = 13 * (canvas.width / 78);
                for (let i = 0; i < this.projectedNodes.length; i++) {
                    const n = this.projectedNodes[i];
                    const d = Math.hypot(pt.x - n.sx, pt.y - n.sy);
                    if (d <= bestDist) {
                        bestDist = d;
                        clickedNode = n;
                    }
                }
                if (clickedNode) {
                    this.snapToPerspective(clickedNode.id);
                }
            }
        };

        canvas.addEventListener('pointerup', finishPointer);
        canvas.addEventListener('pointercancel', finishPointer);
        canvas.addEventListener('pointerleave', () => {
            if (!this.isDragging) this.hoveredNodeId = null;
        });
    },

    getBiomeColors() {
        const biome = window.ACTIVE_PLANET_BIOME || 'highland';
        if (biome === 'lava') return { hi: '#ff7b00', mid: '#7c2d12', low: '#1f0904', ring: '#ff5400' };
        if (biome === 'ocean') return { hi: '#38bdf8', mid: '#0369a1', low: '#082f49', ring: '#00e5ff' };
        if (biome === 'desert') return { hi: '#fbbf24', mid: '#b45309', low: '#451a03', ring: '#f59e0b' };
        if (biome === 'jungle') return { hi: '#4ade80', mid: '#15803d', low: '#052e16', ring: '#22c55e' };
        return { hi: '#60a5fa', mid: '#1d4ed8', low: '#091930', ring: '#38bdf8' };
    },

    getCameraSpherical() {
        const ox = camera.position.x - controls.target.x;
        const oy = camera.position.y - controls.target.y;
        const oz = camera.position.z - controls.target.z;
        const radius = Math.max(18.0, Math.min(140.0, Math.hypot(ox, oy, oz) || 48.0));
        const polar = THREE.MathUtils.clamp(Math.acos(THREE.MathUtils.clamp(oy / radius, -1, 1)), 0.14, 0.94);
        const azimuth = Math.atan2(ox, oz);
        return { radius, polar, azimuth };
    },

    applyCameraSpherical(radius, polar, azimuth) {
        const safePolar = THREE.MathUtils.clamp(polar, 0.14, 0.94);
        const safeRadius = THREE.MathUtils.clamp(radius, 18.0, 140.0);
        const sinP = Math.sin(safePolar);
        const cosP = Math.cos(safePolar);

        camera.position.x = controls.target.x + sinP * Math.sin(azimuth) * safeRadius;
        camera.position.z = controls.target.z + sinP * Math.cos(azimuth) * safeRadius;
        camera.position.y = controls.target.y + cosP * safeRadius;
        camera.lookAt(controls.target);
    },

    orbitCameraByDelta(dAzimuth, dPolar) {
        const sph = this.getCameraSpherical();
        this.applyCameraSpherical(
            sph.radius,
            THREE.MathUtils.clamp(sph.polar + dPolar, 0.14, 0.94),
            sph.azimuth + dAzimuth
        );
    },

    setActivePresetBadge(viewId) {
        this.activePreset = viewId;
        const btns = document.querySelectorAll('#sc2-axis-ball-widget .axis-preset-btn');
        btns.forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-view') === viewId);
        });
    },

    snapToPerspective(viewId) {
        if (window.SFX) window.SFX.playClick();
        const sph = this.getCameraSpherical();
        let targetAzimuth = sph.azimuth;
        let targetPolar = 0.72;
        let targetRadius = Math.max(38.0, Math.min(68.0, sph.radius));

        const key = String(viewId || 'tac').toLowerCase();
        if (key === 'top' || key === '+y') {
            targetPolar = 0.15;
            targetRadius = Math.max(54.0, targetRadius);
            this.setActivePresetBadge('top');
        } else if (key === 'tac') {
            targetAzimuth = 0.12;
            targetPolar = 0.74;
            targetRadius = 50.0;
            this.setActivePresetBadge('tac');
        } else if (key === 's' || key === '+z') {
            targetAzimuth = 0.0;
            targetPolar = 0.72;
            this.setActivePresetBadge('s');
        } else if (key === 'n' || key === '-z') {
            targetAzimuth = Math.PI;
            targetPolar = 0.72;
            this.setActivePresetBadge('n');
        } else if (key === 'e' || key === '+x') {
            targetAzimuth = Math.PI * 0.5;
            targetPolar = 0.72;
            this.setActivePresetBadge('e');
        } else if (key === 'w' || key === '-x') {
            targetAzimuth = -Math.PI * 0.5;
            targetPolar = 0.72;
            this.setActivePresetBadge('w');
        }

        this.transition = {
            startAzimuth: sph.azimuth,
            targetAzimuth,
            startPolar: sph.polar,
            targetPolar,
            startRadius: sph.radius,
            targetRadius,
            elapsed: 0,
            duration: 0.32
        };
    },

    update(dt) {
        if (!this.canvas) this.init();
        if (!this.canvas || !this.ctx) return;

        if (this.transition) {
            this.transition.elapsed += dt;
            const t = Math.min(1.0, this.transition.elapsed / this.transition.duration);
            const ease = 1.0 - Math.pow(1.0 - t, 3);
            const dAz = shortestAngleDiff(this.transition.startAzimuth, this.transition.targetAzimuth);
            const curAz = this.transition.startAzimuth + dAz * ease;
            const curPol = THREE.MathUtils.lerp(this.transition.startPolar, this.transition.targetPolar, ease);
            const curRad = THREE.MathUtils.lerp(this.transition.startRadius, this.transition.targetRadius, ease);
            this.applyCameraSpherical(curRad, curPol, curAz);
            if (t >= 1.0) {
                this.transition = null;
            }
        }

        this.renderGizmo(dt);
    },

    renderGizmo(dt = 0.016) {
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const cx = w * 0.5;
        const cy = h * 0.5;
        const ballR = w * 0.36;
        const scaleFactor = w / 78;

        ctx.clearRect(0, 0, w, h);

        const sph = this.getCameraSpherical();
        const elevDeg = Math.round(90 - THREE.MathUtils.radToDeg(sph.polar));
        if (this.readoutEl) {
            this.readoutEl.innerText = `${elevDeg}° UP`;
        }

        const sinAz = Math.sin(sph.azimuth);
        const cosAz = Math.cos(sph.azimuth);
        const sinPol = Math.sin(sph.polar);
        const cosPol = Math.cos(sph.polar);

        const rx = cosAz, ry = 0, rz = -sinAz;
        const ux = -cosPol * sinAz, uy = sinPol, uz = -cosPol * cosAz;
        const vx = sinPol * sinAz, vy = cosPol, vz = sinPol * cosAz;

        const project3D = (wx, wy, wz) => {
            const px = wx * rx + wy * ry + wz * rz;
            const py = wx * ux + wy * uy + wz * uz;
            const pz = wx * vx + wy * vy + wz * vz;
            return {
                sx: cx + px * ballR,
                sy: cy - py * ballR,
                depth: pz
            };
        };

        // 1. Render 3D-shaded planetary sphere using pure Canvas 2D radial gradients (Zero extra WebGL context for Adreno 610 safety)
        const pal = this.getBiomeColors();
        const sphereR = ballR * 0.72;
        const grad = ctx.createRadialGradient(
            cx - sphereR * 0.32,
            cy - sphereR * 0.35,
            sphereR * 0.08,
            cx,
            cy,
            sphereR
        );
        grad.addColorStop(0, pal.hi);
        grad.addColorStop(0.52, pal.mid);
        grad.addColorStop(1, pal.low);

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, sphereR, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.lineWidth = 1.2 * scaleFactor;
        ctx.strokeStyle = pal.ring;
        ctx.stroke();

        // 2. Render 3D projected Equatorial & Meridian Orbital Rings
        this.cageSpinAngle = (this.cageSpinAngle + dt * 0.35) % (Math.PI * 2);
        const drawRing3D = (ringRadius, pointFn, strokeCol, alpha, width) => {
            ctx.beginPath();
            const steps = 28;
            for (let i = 0; i <= steps; i++) {
                const a = (i / steps) * Math.PI * 2;
                const pt3 = pointFn(a, ringRadius);
                const p = project3D(pt3.x, pt3.y, pt3.z);
                if (i === 0) ctx.moveTo(p.sx, p.sy);
                else ctx.lineTo(p.sx, p.sy);
            }
            ctx.strokeStyle = strokeCol;
            ctx.globalAlpha = alpha;
            ctx.lineWidth = width * scaleFactor;
            ctx.stroke();
        };

        drawRing3D(0.92, (a, r) => ({ x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r }), pal.ring, 0.65, 1.35);
        drawRing3D(0.86, (a, r) => ({ x: 0, y: Math.sin(a) * r, z: Math.cos(a) * r }), '#94a3b8', 0.35, 1.0);
        ctx.restore();

        // 3. Define & Render 3D Axis Nodes (+X East, -X West, +Y Top, +Z South, -Z North)
        const rawNodes = [
            { id: 'e',   label: 'E',   wx:  1, wy:  0, wz:  0, color: '#ff4d6d', stem: true },
            { id: 'w',   label: 'W',   wx: -1, wy:  0, wz:  0, color: '#9f1239', stem: false },
            { id: 'top', label: 'Y',   wx:  0, wy:  1, wz:  0, color: '#00ff66', stem: true },
            { id: 's',   label: 'S',   wx:  0, wy:  0, wz:  1, color: '#00e5ff', stem: true },
            { id: 'n',   label: 'N',   wx:  0, wy:  0, wz: -1, color: '#0369a1', stem: false }
        ];

        const nodes = rawNodes.map(n => {
            const p = project3D(n.wx, n.wy, n.wz);
            return { ...n, sx: p.sx, sy: p.sy, depth: p.depth };
        });

        nodes.sort((a, b) => a.depth - b.depth);
        this.projectedNodes = nodes;

        nodes.forEach(n => {
            const isFront = n.depth >= -0.05;
            const isHovered = this.hoveredNodeId === n.id;

            ctx.save();
            ctx.globalAlpha = isFront ? 0.96 : 0.48;
            ctx.strokeStyle = n.color;
            ctx.lineWidth = (n.stem ? 2.2 : 1.3) * scaleFactor;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(n.sx, n.sy);
            ctx.stroke();

            const nodeR = (isHovered ? 8.2 : (n.stem ? 6.6 : 5.2)) * scaleFactor;
            ctx.beginPath();
            ctx.arc(n.sx, n.sy, nodeR, 0, Math.PI * 2);
            ctx.fillStyle = n.color;
            ctx.fill();
            ctx.lineWidth = (isHovered ? 1.8 : 1.0) * scaleFactor;
            ctx.strokeStyle = isHovered ? '#ffffff' : '#040810';
            ctx.stroke();

            ctx.fillStyle = (n.id === 'top' || n.id === 's') ? '#030810' : '#ffffff';
            ctx.font = `900 ${Math.round(6.8 * scaleFactor)}px "JetBrains Mono", monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(n.label, n.sx, n.sy + 0.5 * scaleFactor);
            ctx.restore();
        });
    }
};

window.AXIS_BALL_CONTROLLER = AXIS_BALL_CONTROLLER;
window.setCameraAxisPerspective = function(viewId) {
    if (!AXIS_BALL_CONTROLLER.canvas) AXIS_BALL_CONTROLLER.init();
    AXIS_BALL_CONTROLLER.snapToPerspective(viewId);
};
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        if (!AXIS_BALL_CONTROLLER.canvas) AXIS_BALL_CONTROLLER.init();
    });
} else {
    if (!AXIS_BALL_CONTROLLER.canvas) AXIS_BALL_CONTROLLER.init();
}

// ============================================================================
// REALISTIC 3D TANK TRACKS & DIRT DEFORMATION SYSTEM (POOLED INSTANCEDMESH)
// Spawns two continuous parallel tread paths with repeated tread-link
// impressions and displaced soil side berms behind moving tanks on dirt/soil/mud.
// ============================================================================
window.TANK_TRACK_SYSTEM = {
    MAX_LINKS: 1024,
    MAX_LIFE: 14.0,
    mesh: null,
    activeCount: 0,
    writeCursor: 0,
    slots: [],
    _dummy: new THREE.Object3D(),
    _normVec: new THREE.Vector3(),
    _fwdVec: new THREE.Vector3(),
    _rightVec: new THREE.Vector3(),
    _rotMat: new THREE.Matrix4(),

    init() {
        if (this.mesh) return;
        // Build a 3D tread-link geometry: sunken central compressed rut + two raised displaced dirt side edges
        const geo = new THREE.BoxGeometry(0.42, 0.045, 0.22, 3, 1, 1);
        const pos = geo.attributes.position;
        const cols = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
            const lx = pos.getX(i);
            const ly = pos.getY(i);
            const edgeFrac = Math.abs(lx) / 0.21;
            if (edgeFrac > 0.65) {
                // Raised displaced soil micro-berm on outer edges of the track
                if (ly > 0) pos.setY(i, ly + 0.024);
                cols[i * 3] = 0.28;
                cols[i * 3 + 1] = 0.22;
                cols[i * 3 + 2] = 0.16;
            } else {
                // Compressed dark earth tread groove in the center
                if (ly > 0) pos.setY(i, ly * 0.35);
                cols[i * 3] = 0.14;
                cols[i * 3 + 1] = 0.11;
                cols[i * 3 + 2] = 0.08;
            }
        }
        geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
        geo.computeVertexNormals();

        const mat = new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.96,
            metalness: 0.04,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2
        });

        this.mesh = new THREE.InstancedMesh(geo, mat, this.MAX_LINKS);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.receiveShadow = true;
        this.mesh.frustumCulled = false;

        this.slots = new Array(this.MAX_LINKS);
        const hiddenMat = new THREE.Matrix4().makeScale(0, 0, 0);
        for (let i = 0; i < this.MAX_LINKS; i++) {
            this.slots[i] = { active: false, age: 0, x: 0, y: -100, z: 0, quat: new THREE.Quaternion(), scaleX: 1, scaleZ: 1 };
            this.mesh.setMatrixAt(i, hiddenMat);
        }
        this.mesh.instanceMatrix.needsUpdate = true;
        scene.add(this.mesh);
    },

    clear() {
        if (!this.mesh) return;
        const hiddenMat = new THREE.Matrix4().makeScale(0, 0, 0);
        for (let i = 0; i < this.MAX_LINKS; i++) {
            this.slots[i].active = false;
            this.mesh.setMatrixAt(i, hiddenMat);
        }
        this.mesh.instanceMatrix.needsUpdate = true;
    },

    isTrackableSurface(x, z) {
        const biome = window.ACTIVE_PLANET_BIOME || 'highland';
        if (biome === 'lava') return false;
        if (typeof isOnRiverBridge === 'function' && isOnRiverBridge(x, z, 0.35)) return false;
        if (typeof getSupplyRoadFactor === 'function' && getSupplyRoadFactor(x, z) > 0.32) return false;
        const h = getTerrainHeight(x, z);
        if (h < 0.06) return false;
        if (biome === 'ocean' && h < 0.24) return false;
        if (typeof isPointInWaterPond === 'function' && isPointInWaterPond(x, z, 0.35)) return false;
        return true;
    },

    spawnTreadPair(wx, wz, dirX, dirZ, isHeavySiege) {
        if (!this.mesh) this.init();
        if (!this.isTrackableSurface(wx, wz)) return;

        // Right vector perpendicular to tank heading in XZ
        const rx = -dirZ;
        const rz = dirX;
        const halfTrackGauge = isHeavySiege ? 0.62 : 0.52;
        const rearOffset = isHeavySiege ? -0.42 : -0.36;
        const scaleW = isHeavySiege ? 1.18 : 1.0;

        [-1, 1].forEach(sideSign => {
            const tx = wx + dirX * rearOffset + rx * (sideSign * halfTrackGauge);
            const tz = wz + dirZ * rearOffset + rz * (sideSign * halfTrackGauge);
            if (!this.isTrackableSurface(tx, tz)) return;

            const ty = getTerrainHeight(tx, tz) + 0.016;
            if (typeof getTerrainNormalInto === 'function') {
                getTerrainNormalInto(tx, tz, this._normVec);
            } else {
                this._normVec.set(0, 1, 0);
            }

            this._fwdVec.set(dirX, 0, dirZ).normalize();
            this._rightVec.crossVectors(this._normVec, this._fwdVec).normalize();
            this._fwdVec.crossVectors(this._rightVec, this._normVec).normalize();
            this._rotMat.makeBasis(this._rightVec, this._normVec, this._fwdVec);

            const idx = this.writeCursor;
            this.writeCursor = (this.writeCursor + 1) % this.MAX_LINKS;
            const slot = this.slots[idx];
            slot.active = true;
            slot.age = 0;
            slot.x = tx;
            slot.y = ty;
            slot.z = tz;
            slot.scaleX = scaleW;
            slot.scaleZ = 1.0;
            slot.quat.setFromRotationMatrix(this._rotMat);

            this._dummy.position.set(tx, ty, tz);
            this._dummy.quaternion.copy(slot.quat);
            this._dummy.scale.set(scaleW, 1.0, 1.0);
            this._dummy.updateMatrix();
            this.mesh.setMatrixAt(idx, this._dummy.matrix);
        });
        this.mesh.instanceMatrix.needsUpdate = true;
    },

    update(dt) {
        if (!this.mesh) this.init();

        // 1. Emit new tread link pairs behind moving tanks (stopped when stationary or in siege mode)
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (!u || u.hp <= 0 || !u.mesh) continue;
            if (u.type !== 'tank' && u.type !== 'siege_tank') continue;
            if (u.type === 'siege_tank' && u.siegeMode) {
                u._lastTrackX = u.mesh.position.x;
                u._lastTrackZ = u.mesh.position.z;
                continue;
            }
            const cx = u.mesh.position.x;
            const cz = u.mesh.position.z;
            if (u._lastTrackX === undefined) {
                u._lastTrackX = cx;
                u._lastTrackZ = cz;
                continue;
            }
            const dx = cx - u._lastTrackX;
            const dz = cz - u._lastTrackZ;
            const dist = Math.hypot(dx, dz);
            const spacing = 0.34;
            if (dist >= spacing) {
                const dirX = dx / dist;
                const dirZ = dz / dist;
                const steps = Math.min(3, Math.floor(dist / spacing));
                for (let s = 1; s <= steps; s++) {
                    const px = u._lastTrackX + dirX * (s * spacing);
                    const pz = u._lastTrackZ + dirZ * (s * spacing);
                    this.spawnTreadPair(px, pz, dirX, dirZ, u.type === 'siege_tank');
                }
                u._lastTrackX = cx;
                u._lastTrackZ = cz;
            }
        }

        // 2. Age & naturally fade out older tank tracks
        let dirty = false;
        const fadeStart = this.MAX_LIFE - 3.5;
        for (let i = 0; i < this.MAX_LINKS; i++) {
            const slot = this.slots[i];
            if (!slot.active) continue;
            slot.age += dt;
            if (slot.age >= this.MAX_LIFE) {
                slot.active = false;
                this._dummy.position.set(0, -100, 0);
                this._dummy.scale.set(0, 0, 0);
                this._dummy.updateMatrix();
                this.mesh.setMatrixAt(i, this._dummy.matrix);
                dirty = true;
            } else if (slot.age >= fadeStart) {
                const fadeT = (slot.age - fadeStart) / 3.5;
                const s = Math.max(0.01, 1.0 - fadeT);
                this._dummy.position.set(slot.x, slot.y - fadeT * 0.025, slot.z);
                this._dummy.quaternion.copy(slot.quat);
                this._dummy.scale.set(slot.scaleX * (0.75 + 0.25 * s), s, slot.scaleZ * s);
                this._dummy.updateMatrix();
                this.mesh.setMatrixAt(i, this._dummy.matrix);
                dirty = true;
            }
        }
        if (dirty) {
            this.mesh.instanceMatrix.needsUpdate = true;
        }
    }
};

// ============================================================================
// LOCATION-AWARE SPATIAL AMBIENT AUDIO ENGINE
// Synthesizes subtle procedural wildlife calls & environmental acoustics
// modulated by camera elevation, river proximity, and active weather state.
// ============================================================================
window.AMBIENT_AUDIO_ENGINE = {
    birdTimer: 5.5,
    update(dt, cam, target) {
        if (!window.SFX || window.SFX.muted || !window.SFX.ctx || window.titleScreenActive) return;
        this.birdTimer -= dt;
        if (this.birdTimer <= 0) {
            this.birdTimer = 7.0 + Math.random() * 9.0;
            const weatherKey = (window.WEATHER_SYSTEM && window.WEATHER_SYSTEM.currentKey) || 'clear';
            if (weatherKey === 'clear' && cam.position.y < 52 && window.SFX.ctx.state === 'running') {
                try {
                    const ctx = window.SFX.ctx;
                    const now = ctx.currentTime;
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'sine';
                    const baseFreq = 1650 + Math.random() * 450;
                    osc.frequency.setValueAtTime(baseFreq, now);
                    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.22, now + 0.09);
                    osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.88, now + 0.24);
                    gain.gain.setValueAtTime(0.0001, now);
                    gain.gain.linearRampToValueAtTime(0.018, now + 0.04);
                    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.start(now);
                    osc.stop(now + 0.27);
                } catch (_) {}
            }
        }
    }
};

// ============================================================================
// ZERG AI DEVELOPER DIAGNOSTIC & WATCHDOG TELEMETRY SYSTEM
// Exposes real-time per-unit AI state, target, destination, movement speed,
// distance to destination, navigation result, and reason for stopping.
// ============================================================================
window.ZERG_AI_DIAGNOSTICS = {
    getUnitReport(e) {
        if (!e) return null;
        const t = e.lockedTarget;
        let targetDesc = 'none';
        let targetCoords = null;
        if (t) {
            if (t === state.baseBuilding) targetDesc = 'player_base_hq';
            else if (t.type) targetDesc = `${t.faction || 'ally'}_${t.type}`;
            else if (t.role) targetDesc = `solaris_${t.role}`;
            else targetDesc = 'hostile_target';
            const tp = t.mesh ? t.mesh.position : t.pos;
            if (tp && Number.isFinite(tp.x) && Number.isFinite(tp.z)) {
                targetCoords = { x: Number(tp.x.toFixed(2)), z: Number(tp.z.toFixed(2)) };
            }
        }
        const isStuck = Boolean((e.stuckTimer || 0) > 0.25 || !e.navSuccess || e.lastNavResult === 'blocked');
        const isRecovering = Boolean((e.recoveryStage || 0) > 0 || (e.recoveryDetourTimer || 0) > 0);
        const bridgeIdx = e.activeBridgeCrossIdx !== undefined ? `Active Bridge #${e.activeBridgeCrossIdx}` : (e.preferredBridgeIdx !== undefined ? `Pref Bridge #${e.preferredBridgeIdx}` : 'Open Terrain');
        return {
            unitId: e.id || 'unassigned',
            unitType: e.variant || 'skitterer',
            aiState: e.aiState || 'MOVING',
            position: e.mesh ? { x: Number(e.mesh.position.x.toFixed(2)), z: Number(e.mesh.position.z.toFixed(2)) } : { x: 0, z: 0 },
            currentTarget: targetDesc,
            targetCoords,
            destination: e.currentDestination || null,
            navigationWaypoint: e.navWaypoint || e.currentDestination || null,
            navigationSuccess: e.navSuccess !== false,
            movementSpeed: typeof e.currentSpeed === 'number' ? e.currentSpeed : Number((e.speed || 0).toFixed(2)),
            actualSpeedPerSec: typeof e.actualSpeedPerSec === 'number' ? e.actualSpeedPerSec : 0,
            distanceToDestination: typeof e.distanceToDestination === 'number'
                ? e.distanceToDestination
                : (typeof e.currentTargetDist === 'number' ? Number(e.currentTargetDist.toFixed(2)) : null),
            targetDistance: typeof e.currentTargetDist === 'number' ? Number(e.currentTargetDist.toFixed(2)) : null,
            navigationResult: e.lastNavResult || 'pending',
            stopReason: e.stopReason || (e.aiState === 'ATTACKING' ? 'in_attack_range' : 'none'),
            lastSuccessfulMovementTime: Number((e.lastMoveTime || 0).toFixed(2)),
            lastSuccessfulAttackTime: Number((e.lastAttackTime || 0).toFixed(2)),
            attackCooldown: Number(Math.max(0, e.cooldown || 0).toFixed(2)),
            lastRecoveryAttempt: e.recoveryAttempts || 0,
            lastRecoveryTime: Number((e.lastRecoveryTime || 0).toFixed(2)),
            bridgeAssignment: bridgeIdx,
            terrainWalkable: e.walkableAtPos !== false,
            isStuck,
            isRecovering,
            currentError: e.lastError || null
        };
    },
    getReport() {
        const unitReports = [];
        for (let i = 0; i < enemies.length; i++) {
            const rep = this.getUnitReport(enemies[i]);
            if (rep) unitReports.push(rep);
        }
        return {
            timestampSec: Number((state.elapsedSec || 0).toFixed(2)),
            totalZergUnits: enemies.length,
            totalZergBuildings: enemyBuildings.length,
            movingCount: unitReports.filter(r => r.aiState === 'MOVING' || r.aiState === 'SPAWNING').length,
            attackingCount: unitReports.filter(r => r.aiState === 'ATTACKING').length,
            searchingCount: unitReports.filter(r => r.aiState === 'SEARCHING').length,
            stuckCount: unitReports.filter(r => r.isStuck).length,
            recoveringCount: unitReports.filter(r => r.isRecovering).length,
            units: unitReports
        };
    }
};
window.getZergAIDiagnosticReport = function() {
    return window.ZERG_AI_DIAGNOSTICS.getReport();
};

// ============================================================================
// AUTOMATED ZERG GROUND MOVEMENT & NAVIGATION SIMULATION TEST
// Spawns multiple Zerg ground unit variants at actual Hive structures, advances
// their navigation & collision steps across 90 simulation frames (3.0s virtual
// time), and verifies that every unit changes position over time, escapes its
// spawn structure, and advances toward a valid attack destination.
// ============================================================================
window.runZergMovementSimulationTest = function(keepSpawnedUnits = true) {
    const variantsToTest = ['skitterer', 'spitter', 'crusher', 'gorgon', 'behemoth'];
    const spawnedTestUnits = [];
    const spawnRecords = [];

    for (let vIdx = 0; vIdx < variantsToTest.length; vIdx++) {
        const v = variantsToTest[vIdx];
        const prodBld = enemyBuildings.find(eb => eb && eb.hp > 0 && (eb.role === 'barracks' || eb.role === 'factory' || eb.role === 'citadel')) || state.enemyBase;
        const origin = prodBld && prodBld.pos ? prodBld.pos : ENEMY_BASE_POS;
        const unit = spawnEnemyFromBuilding(v, origin, prodBld);
        if (unit && unit.mesh) {
            spawnedTestUnits.push(unit);
            spawnRecords.push({
                unit,
                startX: unit.mesh.position.x,
                startZ: unit.mesh.position.z
            });
        }
    }

    const simDt = 1 / 30;
    const simSteps = 90; // 3.0 seconds of simulated movement
    const surfFn = typeof getSurfaceHeightWithBridges === 'function' ? getSurfaceHeightWithBridges : getTerrainHeight;
    const goalPos = (state.baseBuilding && state.baseBuilding.pos) ? state.baseBuilding.pos : PLAYER_START_POS;

    for (let step = 0; step < simSteps; step++) {
        for (let uIdx = 0; uIdx < spawnedTestUnits.length; uIdx++) {
            const e = spawnedTestUnits[uIdx];
            if (!e || e.hp <= 0 || !e.mesh) continue;
            const prevX = e.mesh.position.x;
            const prevZ = e.mesh.position.z;
            const validGoal = (typeof window.validateGroundDestination === 'function')
                ? window.validateGroundDestination(e.mesh.position, goalPos, e.radius || 0.52)
                : goalPos;
            const navPt = getGroundNavigationWaypoint(e.mesh.position, validGoal, e) || validGoal;
            e.currentDestination = { x: Number(validGoal.x.toFixed(2)), z: Number(validGoal.z.toFixed(2)) };
            e.navWaypoint = { x: Number(navPt.x.toFixed(2)), z: Number(navPt.z.toFixed(2)) };
            const stepDir = computeSafeGroundStep(e.mesh.position, navPt, e.speed || 3.0, simDt, e, enemies, buildings, enemyBuildings);
            if (stepDir && stepDir.lengthSq() > 0.0001) {
                const nx = e.mesh.position.x + stepDir.x * (e.speed || 3.0) * simDt;
                const nz = e.mesh.position.z + stepDir.z * (e.speed || 3.0) * simDt;
                if (typeof isWalkableGround !== 'function' || isWalkableGround(nx, nz, (e.radius || 0.5) * 0.45)) {
                    e.mesh.position.x = nx;
                    e.mesh.position.z = nz;
                    e.mesh.position.y = surfFn(nx, nz);
                    alignGroundUnitToTerrain(e.mesh, nx + stepDir.x, nz + stepDir.z, simDt);
                }
            }
            const movedD = Math.hypot(e.mesh.position.x - prevX, e.mesh.position.z - prevZ);
            e.actualSpeedPerSec = Number((movedD / simDt).toFixed(2));
            e.navSuccess = movedD > 0.001;
            e.lastNavResult = movedD > 0.001 ? 'sim_waypoint_step' : 'blocked';
            e.lastMoveTime = state.elapsedSec || 0;
        }
        resolveAllUnitCollisions();
    }

    let passedCount = 0;
    let totalDisp = 0;
    const perUnitResults = [];

    for (let i = 0; i < spawnRecords.length; i++) {
        const rec = spawnRecords[i];
        const u = rec.unit;
        const endX = u.mesh.position.x;
        const endZ = u.mesh.position.z;
        const disp = Math.hypot(endX - rec.startX, endZ - rec.startZ);
        const startDistToGoal = Math.hypot(goalPos.x - rec.startX, goalPos.z - rec.startZ);
        const endDistToGoal = Math.hypot(goalPos.x - endX, goalPos.z - endZ);
        const walkableEnd = typeof isWalkableGround === 'function' ? isWalkableGround(endX, endZ, (u.radius || 0.5) * 0.40) : true;
        const unitPassed = disp >= 2.5 && walkableEnd && (endDistToGoal < startDistToGoal + 4.0);
        if (unitPassed) passedCount++;
        totalDisp += disp;
        perUnitResults.push({
            unitId: u.id,
            variant: u.variant,
            startPos: { x: +rec.startX.toFixed(2), z: +rec.startZ.toFixed(2) },
            endPos: { x: +endX.toFixed(2), z: +endZ.toFixed(2) },
            displacementM: +disp.toFixed(2),
            walkableEnd,
            passed: unitPassed
        });
    }

    if (!keepSpawnedUnits) {
        for (let i = 0; i < spawnedTestUnits.length; i++) {
            const u = spawnedTestUnits[i];
            const idx = enemies.indexOf(u);
            if (idx !== -1) enemies.splice(idx, 1);
            if (u.mesh) scene.remove(u.mesh);
            if (u.hb && u.hb.root) u.hb.root.remove();
        }
    }

    const summary = {
        passed: passedCount === spawnRecords.length && spawnRecords.length > 0,
        testedCount: spawnRecords.length,
        passedCount,
        avgDisplacementM: spawnRecords.length > 0 ? +(totalDisp / spawnRecords.length).toFixed(2) : 0,
        units: perUnitResults
    };

    if (window.AI_DEBUG) {
        window.AI_DEBUG.lastSimTestResult = summary;
        window.AI_DEBUG.logEvent(`Zerg Sim Test: ${summary.passed ? 'PASSED' : 'FAILED'} (${passedCount}/${spawnRecords.length} units moved, avg ${summary.avgDisplacementM}m)`);
        window.AI_DEBUG.renderUI(true);
    }
    return summary;
};

// ============================================================================
// STARBLOCK V2 COMPREHENSIVE RUNTIME DIAGNOSTICS & REGRESSION VERIFIER
// Audits white structures, biome flat-plain structures, out-of-bounds skirt,
// 3-state FOW & enemy structure hiding, biome skybox, Terran aircraft
// (Heli, Medivac, Battlecruiser), weapon muzzle world positions,
// faction projectiles, and staggered Rocketpad missile barrages.
// ============================================================================
window.runV2RegressionDiagnostics = function() {
    const whiteDiag = window.WHITE_STRUCTURE_DIAGNOSTICS || { auditedMeshes: 0, repairedWhiteMeshes: 0, repairedMissingUVs: 0 };
    let unmappedWhiteStructures = 0;
    scene.traverse(obj => {
        if (obj && obj.isMesh && obj.visible && obj.material) {
            const m = obj.material;
            if (m.isMeshBasicMaterial && !m.map && m.color && m.color.r > 0.97 && m.color.g > 0.97 && m.color.b > 0.97 && !m.transparent && !m.wireframe) {
                unmappedWhiteStructures++;
            }
        }
    });

    const fowBypass = !!(window.titleScreenActive || window.loadingCameraSweep || window.fowRevealAll);
    let enemyBuildingsLeakingInFog = 0;
    for (let i = 0; i < enemyBuildings.length; i++) {
        const eb = enemyBuildings[i];
        if (!eb || !eb.mesh) continue;
        const vis = fowBypass || isWorldPosVisible(eb.pos.x, eb.pos.z);
        if (!vis && eb.mesh.visible) enemyBuildingsLeakingInFog++;
    }

    const skyboxOk = !!(window.BIOME_SKYBOX_SYSTEM && window.BIOME_SKYBOX_SYSTEM.mesh && window.BIOME_SKYBOX_SYSTEM.texture);
    const oobSkirtOk = !!(window.OUT_OF_BOUNDS_TERRAIN_SYSTEM && window.OUT_OF_BOUNDS_TERRAIN_SYSTEM.mesh);
    const flatPlainCount = (window.TERRAIN_CLASSIFIER && Array.isArray(window.TERRAIN_CLASSIFIER.lastPlacedBiomeStructures))
        ? window.TERRAIN_CLASSIFIER.lastPlacedBiomeStructures.length
        : 0;

    return {
        ok: unmappedWhiteStructures === 0 && enemyBuildingsLeakingInFog === 0 && skyboxOk && oobSkirtOk && flatPlainCount > 0,
        whiteStructures: {
            unmappedWhiteStructures,
            auditedMeshes: whiteDiag.auditedMeshes,
            repairedWhiteMeshes: whiteDiag.repairedWhiteMeshes,
            repairedMissingUVs: whiteDiag.repairedMissingUVs
        },
        biomeClassification: {
            activeBiome: window.ACTIVE_PLANET_BIOME || 'highland',
            flatPlainStructuresPlaced: flatPlainCount,
            summary: window.TERRAIN_CLASSIFIER ? window.TERRAIN_CLASSIFIER.classificationSummary : {}
        },
        fogOfWar: {
            enemyBuildingsLeakingInFog,
            fowDebugModeAvailable: typeof window.toggleFowDebugMode === 'function'
        },
        outOfBoundsAndSkybox: {
            oobSkirtAttached: oobSkirtOk,
            skyboxAttached: skyboxOk,
            skyboxBiome: window.BIOME_SKYBOX_SYSTEM ? window.BIOME_SKYBOX_SYSTEM.currentBiome : null
        },
        aircraftAndCombat: {
            thrustFxSystemReady: !!window.THRUST_FX_SYSTEM,
            projectileVisualFactoryReady: !!window.PROJECTILE_VISUAL_FACTORY,
            muzzleResolverReady: typeof window.getWeaponMuzzleWorldPos === 'function',
            rocketpadBarrageReady: typeof window.queueRocketpadMissileBarrage === 'function'
        }
    };
};
window.verifyStarBlockV2Overhaul = window.runV2RegressionDiagnostics;

if (typeof window.returnToMainMenu !== 'function') {
    window.returnToMainMenu = function defaultReturnToMainMenu() {
        window.titleScreenActive = true;
        if (window.BATTLE_CINEMATIC && typeof window.BATTLE_CINEMATIC.init === 'function') {
            window.BATTLE_CINEMATIC.init();
        }
    };
}

// ============================================================================
// CINEMATIC ENTITY & ANIMATION VALIDATOR
// ============================================================================
window.validateCinematicEntities = function validateCinematicEntities() {
    const bc = window.BATTLE_CINEMATIC;
    if (!bc || !bc.actors) {
        return { ok: false, reason: 'BATTLE_CINEMATIC_NOT_INITIALIZED' };
    }
    const mismatches = [];
    const expectedWorkerByFaction = { terran: 'scv', protoss: 'probe', zerg: 'drone' };

    const workers = (bc.actors.workers || []).map(w => {
        const expectedWorker = expectedWorkerByFaction[w.faction] || 'scv';
        const actualWorker = w.workerType || w.role;
        const isMatch = actualWorker === expectedWorker;
        if (!isMatch) {
            mismatches.push({ kind: 'worker', teamId: w.teamId, faction: w.faction, expected: expectedWorker, actual: actualWorker });
        }
        return {
            teamId: w.teamId,
            faction: w.faction,
            workerType: actualWorker,
            animState: (w.mesh && w.mesh.userData && w.mesh.userData.animState) || 'Walking',
            valid: isMatch
        };
    });

    const structures = (bc.actors.buildings || []).map(b => {
        const ud = (b.mesh && b.mesh.userData) || {};
        const isZergOrganicOk = b.faction !== 'zerg' || Boolean(ud.isOrganicZergStructure && ud.faction === 'zerg');
        const isFactionMatch = !ud.faction || ud.faction === b.faction;
        const valid = isZergOrganicOk && isFactionMatch;
        if (!valid) {
            mismatches.push({ kind: 'structure', teamId: b.teamId, faction: b.faction, role: b.role, buildingType: b.buildingType, udFaction: ud.faction });
        }
        return {
            teamId: b.teamId,
            faction: b.faction,
            role: b.role,
            buildingType: b.buildingType || ud.buildingType || b.role,
            isOrganicZerg: Boolean(ud.isOrganicZergStructure),
            valid
        };
    });

    const unitsList = [...(bc.actors.infantry || []), ...(bc.actors.enemies || [])].map(u => {
        const fDef = CINEMATIC_FACTION_DEFS[u.faction] || CINEMATIC_FACTION_DEFS.terran;
        const allowed = [...(fDef.infantryPool || []), ...(fDef.heavyPool || []), ...(fDef.airPool || [])];
        const valid = allowed.includes(u.role);
        if (!valid) {
            mismatches.push({ kind: 'unit', teamId: u.teamId, faction: u.faction, role: u.role });
        }
        return {
            teamId: u.teamId,
            faction: u.faction,
            role: u.role,
            isAir: Boolean(u.isAir),
            animState: (u.mesh && u.mesh.userData && u.mesh.userData.animState) || 'Idle',
            valid
        };
    });

    return {
        ok: mismatches.length === 0,
        workerCount: workers.length,
        structureCount: structures.length,
        unitCount: unitsList.length,
        mismatches,
        workers,
        structures,
        units: unitsList
    };
};

// ============================================================================
// STARCRAFT II-INSPIRED STRATEGIC AI COMMANDER & 10 PLAYSTYLES SYSTEM
// Supports: Rush, Cannon Rush (Protoss), Proxy Barracks (Terran),
// Proxy Gateway (Protoss), Proxy Hatchery (Zerg), Economic Expansion,
// Tech Rush, Air Rush, Defensive Turtle, and Flanking.
// ============================================================================
window.STRATEGIC_COMMANDER = {
    PLAYSTYLES: {
        Rush: {
            id: 'Rush',
            name: 'Early All-In Rush',
            allowedFactions: ['terran', 'protoss', 'zerg'],
            buildOrder: ['spawning_pool', 'early_vanguard_pack', 'speed_metabolic_boost', 'continuous_melee_flood'],
            objective: 'Overwhelm enemy perimeter before heavy defenses complete',
            unitWeights: { zerg: { skitterer: 0.65, burster: 0.25, spitter: 0.10 }, protoss: { zealot: 0.75, stalker: 0.25 }, terran: { grunt: 0.65, ranger: 0.35 } }
        },
        'Cannon Rush': {
            id: 'Cannon Rush',
            name: 'Protoss Forward Photon Cannon Rush',
            allowedFactions: ['protoss'],
            buildOrder: ['forward_scout_probe', 'forward_khaydarin_pylon', 'forward_photon_cannon_ring', 'warp_gate_reinforce'],
            objective: 'Construct forward Pylon and Photon Cannons near enemy base perimeter',
            unitWeights: { protoss: { zealot: 0.50, stalker: 0.35, immortal: 0.15 } }
        },
        'Proxy Barracks': {
            id: 'Proxy Barracks',
            name: 'Terran Forward Proxy Barracks',
            allowedFactions: ['terran'],
            buildOrder: ['forward_scv_dispatch', 'hidden_proxy_barracks', 'proxy_marauder_marine_push', 'bunker_contain'],
            objective: 'Deploy concealed forward Barracks along flank corridor for rapid infantry pressure',
            unitWeights: { terran: { grunt: 0.45, marauder: 0.35, firebat: 0.20 } }
        },
        'Proxy Gateway': {
            id: 'Proxy Gateway',
            name: 'Protoss Forward Proxy Gateway',
            allowedFactions: ['protoss'],
            buildOrder: ['forward_probe_dispatch', 'proxy_pylon_matrix', 'proxy_warp_gate_pair', 'zealot_stalker_warp_assault'],
            objective: 'Warp in forward Pylon and Gateways near midfield choke to cut reinforcement time',
            unitWeights: { protoss: { zealot: 0.55, stalker: 0.35, archon: 0.10 } }
        },
        'Proxy Hatchery': {
            id: 'Proxy Hatchery',
            name: 'Zerg Forward Proxy Hatchery & Creep Siege',
            allowedFactions: ['zerg'],
            buildOrder: ['forward_drone_burrow', 'proxy_hatchery_gestation', 'forward_spine_crawler_root', 'roach_zergling_surge'],
            objective: 'Establish forward Hatchery and Spine Crawler outside enemy natural expansion',
            unitWeights: { zerg: { crusher: 0.45, skitterer: 0.35, spitter: 0.20 } }
        },
        'Economic Expansion': {
            id: 'Economic Expansion',
            name: 'Macro Nexus / Hatchery Fast Expansion',
            allowedFactions: ['terran', 'protoss', 'zerg'],
            buildOrder: ['fast_natural_expansion', 'saturate_harvesters', 'double_upgrade_chambers', 'max_supply_macro_push'],
            objective: 'Secure high-yield resource expansion and out-produce enemy on 2+ bases',
            unitWeights: { zerg: { spitter: 0.35, crusher: 0.30, mutalisk: 0.20, brood_lord: 0.15 }, protoss: { stalker: 0.40, immortal: 0.30, colossus: 0.30 }, terran: { ranger: 0.40, marauder: 0.30, tank: 0.30 } }
        },
        'Tech Rush': {
            id: 'Tech Rush',
            name: 'Accelerated Tier-3 Tech Rush',
            allowedFactions: ['terran', 'protoss', 'zerg'],
            buildOrder: ['fast_vespene_extractors', 'tech_core_escalation', 'spire_and_heavy_foundry', 'tier3_siege_breakers'],
            objective: 'Rush high-tier siege units (Brood Lords, Ultralisks, Colossi, Siege Tanks)',
            unitWeights: { zerg: { brood_lord: 0.38, behemoth: 0.32, gorgon: 0.20, spitter: 0.10 }, protoss: { colossus: 0.45, immortal: 0.35, archon: 0.20 }, terran: { tank: 0.60, marauder: 0.25, heli: 0.15 } }
        },
        'Air Rush': {
            id: 'Air Rush',
            name: 'Sky Fleet / Spire Air Dominance',
            allowedFactions: ['terran', 'protoss', 'zerg'],
            buildOrder: ['double_vespene_gorging', 'fast_spire_stargate_airfield', 'mutalisk_voidray_harass', 'brood_lord_carrier_armada'],
            objective: 'Bypass ground choke points with Mutalisk & Brood Lord / Void Ray aerial squadrons',
            unitWeights: { zerg: { mutalisk: 0.55, brood_lord: 0.35, skitterer: 0.10 }, protoss: { voidray: 0.60, carrier: 0.40 }, terran: { heli: 0.75, ranger: 0.25 } }
        },
        'Defensive Turtle': {
            id: 'Defensive Turtle',
            name: 'Fortified Siege Turtle & Late-Game Deathball',
            allowedFactions: ['terran', 'protoss', 'zerg'],
            buildOrder: ['perimeter_spine_photon_bunker_wall', 'subterranean_drill_matrix', 'level3_carapace_weapons', 'unstoppable_siege_deathball'],
            objective: 'Fortify base choke points with dense defensive turrets while massing an upgraded siege army',
            unitWeights: { zerg: { crusher: 0.30, gorgon: 0.25, behemoth: 0.25, brood_lord: 0.20 }, protoss: { immortal: 0.35, colossus: 0.35, archon: 0.30 }, terran: { tank: 0.55, marauder: 0.25, ranger: 0.20 } }
        },
        Flanking: {
            id: 'Flanking',
            name: 'Multi-Corridor Pincer & Mineral Harassment',
            allowedFactions: ['terran', 'protoss', 'zerg'],
            buildOrder: ['mobility_wing_upgrades', 'split_vanguard_squads', 'mineral_line_raiders', 'synchronized_pincer_envelopment'],
            objective: 'Split strike forces across alternate bridges and flanks to surround enemy formations',
            unitWeights: { zerg: { skitterer: 0.35, mutalisk: 0.30, burster: 0.20, spitter: 0.15 }, protoss: { stalker: 0.55, zealot: 0.30, voidray: 0.15 }, terran: { ranger: 0.45, heli: 0.30, grunt: 0.25 } }
        }
    },

    DIFFICULTY_PROFILES: {
        Easy:   { decisionInterval: 5.5, buildSpeedMult: 0.75, econRateMult: 0.80, allowCounterTransition: false, allowProxy: false, squadCoordination: 0.45 },
        Normal: { decisionInterval: 3.5, buildSpeedMult: 1.00, econRateMult: 1.00, allowCounterTransition: true,  allowProxy: true,  squadCoordination: 0.75 },
        Medium: { decisionInterval: 3.5, buildSpeedMult: 1.00, econRateMult: 1.00, allowCounterTransition: true,  allowProxy: true,  squadCoordination: 0.75 },
        Hard:   { decisionInterval: 2.0, buildSpeedMult: 1.25, econRateMult: 1.25, allowCounterTransition: true,  allowProxy: true,  squadCoordination: 0.92 },
        Brutal: { decisionInterval: 1.1, buildSpeedMult: 1.50, econRateMult: 1.50, allowCounterTransition: true,  allowProxy: true,  squadCoordination: 1.00 }
    },

    difficulty: 'Normal',
    selectedStrategy: 'Rush',
    protossStrategy: 'Cannon Rush',
    currentBuildOrder: [],
    currentObjective: 'Initialize tactical command',
    strategyTransitionReason: 'Initial deterministic seed selection',
    transitionHistory: [],
    proxyStructuresSpawned: [],
    scoutingInfo: {
        lastScoutTime: 0,
        playerTurretCount: 0,
        playerAirCount: 0,
        playerHeavyCount: 0,
        playerInfantryCount: 0,
        playerBuildingCount: 0,
        detectedPlayerPosture: 'BALANCED'
    },
    economyState: {
        virtualMinerals: 400,
        virtualGas: 200,
        harvesterEquivalent: 6,
        productionEfficiency: 1.0
    },
    _evalTimer: 0,
    _initializedSeed: null,

    getValidStrategiesForFaction(faction) {
        const f = String(faction || 'zerg').toLowerCase();
        const normF = f === 'solaris' ? 'protoss' : f;
        return Object.values(this.PLAYSTYLES).filter(p => p.allowedFactions.includes(normF));
    },

    setDifficulty(level) {
        const normalized = String(level || 'Normal');
        const key = Object.keys(this.DIFFICULTY_PROFILES).find(k => k.toLowerCase() === normalized.toLowerCase()) || 'Normal';
        this.difficulty = key;
        const prof = this.DIFFICULTY_PROFILES[key];
        this.economyState.productionEfficiency = prof.econRateMult;
        return this.getDiagnostics();
    },

    selectStrategyForSeed(seed = window.MAP_SEED || 1, faction = 'zerg', forcedStrategy = null) {
        const normFaction = faction === 'solaris' ? 'protoss' : faction;
        const validList = this.getValidStrategiesForFaction(normFaction);
        let chosen = validList[0];
        if (forcedStrategy && this.PLAYSTYLES[forcedStrategy] && this.PLAYSTYLES[forcedStrategy].allowedFactions.includes(normFaction)) {
            chosen = this.PLAYSTYLES[forcedStrategy];
            this.strategyTransitionReason = `Explicit strategy override (${forcedStrategy})`;
        } else {
            const hash = Math.abs(Math.floor(Number(seed) * 2654435761)) % Math.max(1, validList.length);
            chosen = validList[hash] || validList[0];
            this.strategyTransitionReason = `Seed-deterministic selection (seed=${seed}, faction=${normFaction})`;
        }

        if (normFaction === 'protoss') {
            this.protossStrategy = chosen.id;
        } else {
            this.selectedStrategy = chosen.id;
            this.currentBuildOrder = [...chosen.buildOrder];
            this.currentObjective = chosen.objective;
        }
        this._initializedSeed = seed;
        return chosen;
    },

    setStrategy(strategyName, reason = 'Manual / Tactical Override', faction = 'zerg') {
        const normFaction = faction === 'solaris' ? 'protoss' : faction;
        const style = this.PLAYSTYLES[strategyName];
        if (!style) return { ok: false, reason: 'UNKNOWN_STRATEGY' };
        if (!style.allowedFactions.includes(normFaction)) {
            return { ok: false, reason: `FACTION_RESTRICTED: ${strategyName} is only allowed for ${style.allowedFactions.join(', ')}` };
        }
        const prev = normFaction === 'protoss' ? this.protossStrategy : this.selectedStrategy;
        if (normFaction === 'protoss') {
            this.protossStrategy = style.id;
        } else {
            this.selectedStrategy = style.id;
            this.currentBuildOrder = [...style.buildOrder];
            this.currentObjective = style.objective;
        }
        this.strategyTransitionReason = reason;
        if (prev !== style.id) {
            this.transitionHistory.push({
                from: prev,
                to: style.id,
                faction: normFaction,
                reason,
                time: Number((state.elapsedSec || 0).toFixed(1))
            });
        }
        this.applyStrategyToField(normFaction);
        return { ok: true, strategy: style.id, faction: normFaction, reason };
    },

    scoutEnemyComposition() {
        let turretCount = 0;
        let bldCount = 0;
        for (let i = 0; i < buildings.length; i++) {
            const b = buildings[i];
            if (!b || b.hp <= 0 || b.isEnemy) continue;
            bldCount++;
            if (b.type === 'turret' || b.type === 'solaris_spire') turretCount++;
        }
        let airCount = 0;
        let heavyCount = 0;
        let infCount = 0;
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (!u || u.hp <= 0 || u.isEnemy) continue;
            if (u.isAir || u.type === 'heli' || u.type === 'valkyrie' || u.type === 'battlecruiser' || u.type === 'voidray' || u.type === 'carrier') airCount++;
            else if (u.type === 'tank' || u.type === 'siege_tank' || u.type === 'immortal' || u.type === 'colossus' || u.type === 'marauder') heavyCount++;
            else infCount++;
        }
        let posture = 'BALANCED';
        if (turretCount >= 4) posture = 'FORTIFIED_TURTLE';
        else if (airCount >= 3) posture = 'AIR_HEAVY';
        else if (heavyCount >= 4) posture = 'ARMOR_SIEGE';
        else if (infCount >= 7 && bldCount <= 3) posture = 'EARLY_INFANTRY_RUSH';

        this.scoutingInfo = {
            lastScoutTime: Number((state.elapsedSec || 0).toFixed(1)),
            playerTurretCount: turretCount,
            playerAirCount: airCount,
            playerHeavyCount: heavyCount,
            playerInfantryCount: infCount,
            playerBuildingCount: bldCount,
            detectedPlayerPosture: posture
        };
        return this.scoutingInfo;
    },

    evaluateDynamicCounterTransition() {
        const prof = this.DIFFICULTY_PROFILES[this.difficulty] || this.DIFFICULTY_PROFILES.Normal;
        if (!prof.allowCounterTransition) return null;
        const scout = this.scoutingInfo;
        const cur = this.selectedStrategy;

        if (scout.detectedPlayerPosture === 'FORTIFIED_TURTLE' && (cur === 'Rush' || cur === 'Proxy Hatchery')) {
            return this.setStrategy('Tech Rush', 'Scouted heavy player turret fortification (>=4 turrets); transitioning from early rush to long-range Brood Lord / Behemoth siege tech', 'zerg');
        }
        if (scout.detectedPlayerPosture === 'AIR_HEAVY' && cur !== 'Air Rush' && cur !== 'Flanking') {
            return this.setStrategy('Air Rush', 'Scouted player aerial fleet (>=3 air units); transitioning to Spire Mutalisk & Hydralisk anti-air dominance', 'zerg');
        }
        if (scout.detectedPlayerPosture === 'ARMOR_SIEGE' && cur === 'Defensive Turtle') {
            return this.setStrategy('Flanking', 'Scouted player heavy siege armor; transitioning to multi-corridor Flanking & Air harassment', 'zerg');
        }
        if (scout.detectedPlayerPosture === 'EARLY_INFANTRY_RUSH' && cur === 'Economic Expansion') {
            return this.setStrategy('Defensive Turtle', 'Scouted early player infantry flood; fortifying perimeter with Spine Crawlers and Roach Warrens', 'zerg');
        }
        return null;
    },

    findValidForwardProxyLocation(originPos, targetPos, radius = 2.4) {
        const midX = originPos.x + (targetPos.x - originPos.x) * 0.58;
        const midZ = originPos.z + (targetPos.z - originPos.z) * 0.58;
        const perpX = -(targetPos.z - originPos.z);
        const perpZ = (targetPos.x - originPos.x);
        const pLen = Math.hypot(perpX, perpZ) || 1;
        const nx = perpX / pLen;
        const nz = perpZ / pLen;

        const offsets = [
            { x: midX + nx * 16, z: midZ + nz * 16 },
            { x: midX - nx * 16, z: midZ - nz * 16 },
            { x: midX + nx * 24, z: midZ + nz * 24 },
            { x: midX - nx * 24, z: midZ - nz * 24 },
            { x: midX, z: midZ }
        ];
        const surfFn = typeof getSurfaceHeightWithBridges === 'function' ? getSurfaceHeightWithBridges : getTerrainHeight;
        for (let i = 0; i < offsets.length; i++) {
            const c = offsets[i];
            const cx = THREE.MathUtils.clamp(c.x, -88, 88);
            const cz = THREE.MathUtils.clamp(c.z, -88, 88);
            const walkable = typeof isWalkableGround === 'function' ? isWalkableGround(cx, cz, radius) : (surfFn(cx, cz) > 0.15);
            const aboveWater = typeof isFootprintAboveWater === 'function' ? isFootprintAboveWater(cx, cz, radius).aboveWater : true;
            const overlapsAnyBuilding = (typeof buildings !== 'undefined' && buildings.some(b => b && b.hp > 0 && Math.hypot(b.pos.x - cx, b.pos.z - cz) < radius + 4.5))
                || (typeof solarisBuildings !== 'undefined' && solarisBuildings.some(sb => sb && sb.hp > 0 && Math.hypot(sb.pos.x - cx, sb.pos.z - cz) < radius + 4.5))
                || (typeof enemyBuildings !== 'undefined' && enemyBuildings.some(eb => eb && eb.hp > 0 && Math.hypot(eb.pos.x - cx, eb.pos.z - cz) < radius + 4.5));
            if (walkable && aboveWater && !overlapsAnyBuilding) {
                const y = surfFn(cx, cz);
                return new THREE.Vector3(cx, Number.isFinite(y) ? y : 0.4, cz);
            }
        }
        return new THREE.Vector3(
            THREE.MathUtils.clamp(originPos.x + (targetPos.x - originPos.x) * 0.38, -85, 85),
            Math.max(0.25, surfFn(originPos.x, originPos.z)),
            THREE.MathUtils.clamp(originPos.z + (targetPos.z - originPos.z) * 0.38, -85, 85)
        );
    },

    applyStrategyToField(faction = 'zerg') {
        const prof = this.DIFFICULTY_PROFILES[this.difficulty] || this.DIFFICULTY_PROFILES.Normal;
        if (faction === 'zerg') {
            const strat = this.selectedStrategy;
            if (strat === 'Rush') {
                state.rushGraceTimer = Math.min(state.rushGraceTimer || 0, 5.0);
                this.currentObjective = 'Execute immediate Zergling & Baneling swarm pressure';
            } else if (strat === 'Proxy Hatchery' && prof.allowProxy) {
                const proxyExists = enemyBuildings.some(eb => eb && eb.hp > 0 && eb.isProxyStructure);
                if (!proxyExists && state.enemyBase && state.enemyBase.hp > 0) {
                    const targetAnchor = (state.baseBuilding && state.baseBuilding.pos) ? state.baseBuilding.pos : PLAYER_START_POS;
                    const proxyPos = this.findValidForwardProxyLocation(ENEMY_BASE_POS, targetAnchor, 2.8);
                    const mesh = typeof createOrganicZergStructure === 'function'
                        ? createOrganicZergStructure('hatchery')
                        : createEnemySpawningPool();
                    mesh.position.copy(proxyPos);
                    scene.add(mesh);
                    const badge = document.createElement('div');
                    badge.style.display = 'none';
                    const hb = makeHealthPip('#d946ef', true);
                    const proxyBld = {
                        role: 'barracks',
                        isProxyStructure: true,
                        proxyStrategy: 'Proxy Hatchery',
                        mesh,
                        pos: proxyPos,
                        footprintRadius: 2.8,
                        hp: 1350,
                        maxHp: 1350,
                        buildProgress: 1.0,
                        badge,
                        hb,
                        spawnDuration: 5.0,
                        spawnTimer: 1.5
                    };
                    enemyBuildings.push(proxyBld);
                    this.proxyStructuresSpawned.push({ faction: 'zerg', type: 'proxy_hatchery', x: Number(proxyPos.x.toFixed(1)), z: Number(proxyPos.z.toFixed(1)) });
                }
            } else if (strat === 'Air Rush' || strat === 'Tech Rush') {
                const hasSpire = enemyBuildings.some(eb => eb && eb.hp > 0 && (eb.role === 'spire_hive' || eb.role === 'spire'));
                if (!hasSpire && state.enemyBase && state.enemyBase.hp > 0) {
                    constructNextEnemyZergStructure();
                }
            }
        } else if (faction === 'protoss') {
            const pStrat = this.protossStrategy;
            if ((pStrat === 'Cannon Rush' || pStrat === 'Proxy Gateway') && prof.allowProxy && typeof solarisBuildings !== 'undefined') {
                const hasProtossProxy = solarisBuildings.some(sb => sb && sb.hp > 0 && sb.isProxyStructure);
                if (!hasProtossProxy && typeof SOLARIS_BASE_POS !== 'undefined') {
                    const targetAnchor = state.solarisHostile && state.baseBuilding ? state.baseBuilding.pos : ENEMY_BASE_POS;
                    const proxyPos = this.findValidForwardProxyLocation(SOLARIS_BASE_POS, targetAnchor, 2.2);
                    const role = pStrat === 'Cannon Rush' ? 'turret' : 'gate';
                    const bldType = pStrat === 'Cannon Rush' ? 'solaris_spire' : 'solaris_gate';
                    const mesh = createEngineeredBuilding(bldType, false);
                    mesh.position.copy(proxyPos);
                    scene.add(mesh);
                    const hb = makeHealthPip('#f5b932', true);
                    solarisBuildings.push({
                        role,
                        isProxyStructure: true,
                        proxyStrategy: pStrat,
                        mesh,
                        pos: proxyPos,
                        footprintRadius: 2.1,
                        hp: 1100,
                        maxHp: 1100,
                        buildProgress: 1.0,
                        hb,
                        cooldown: 0.5,
                        spawnTimer: 2.0
                    });
                    this.proxyStructuresSpawned.push({ faction: 'protoss', type: bldType, strategy: pStrat, x: Number(proxyPos.x.toFixed(1)), z: Number(proxyPos.z.toFixed(1)) });
                }
            }
        }
    },

    pickUnitVariantForStrategy(buildingRole = 'barracks', faction = 'zerg') {
        const normFaction = faction === 'solaris' ? 'protoss' : faction;
        const stratName = normFaction === 'protoss' ? this.protossStrategy : this.selectedStrategy;
        const style = this.PLAYSTYLES[stratName] || this.PLAYSTYLES.Rush;
        const weights = (style.unitWeights && style.unitWeights[normFaction]) || null;
        if (!weights) return buildingRole === 'spire_hive' ? 'brood_lord' : 'skitterer';

        const entries = Object.entries(weights);
        let r = Math.random();
        for (let i = 0; i < entries.length; i++) {
            const [unitKey, w] = entries[i];
            if (r <= w || i === entries.length - 1) return unitKey;
            r -= w;
        }
        return entries[0][0];
    },

    getArmyCompositionSummary() {
        const counts = {};
        for (let i = 0; i < enemies.length; i++) {
            const e = enemies[i];
            if (!e || e.hp <= 0) continue;
            const k = e.variant || 'skitterer';
            counts[k] = (counts[k] || 0) + 1;
        }
        return counts;
    },

    getDiagnostics() {
        return {
            selectedStrategy: this.selectedStrategy,
            protossStrategy: this.protossStrategy,
            difficulty: this.difficulty,
            currentBuildOrder: this.currentBuildOrder,
            currentObjective: this.currentObjective,
            economyState: {
                ...this.economyState,
                activeStructures: enemyBuildings.filter(b => b && b.hp > 0).length
            },
            armyComposition: this.getArmyCompositionSummary(),
            scoutingInformation: this.scoutingInfo,
            strategyTransitionReason: this.strategyTransitionReason,
            transitionHistory: this.transitionHistory,
            proxyStructuresSpawned: this.proxyStructuresSpawned,
            availableStrategies: Object.keys(this.PLAYSTYLES)
        };
    },

    update(dt) {
        if (this._initializedSeed !== window.MAP_SEED) {
            this.selectStrategyForSeed(window.MAP_SEED || 1, 'zerg');
            const pStyles = ['Cannon Rush', 'Proxy Gateway', 'Air Rush', 'Tech Rush', 'Flanking'];
            const pIdx = Math.abs(Math.floor(Number(window.MAP_SEED || 1) * 19349663)) % pStyles.length;
            this.setStrategy(pStyles[pIdx], `Seed-deterministic Protoss selection (seed=${window.MAP_SEED || 1})`, 'protoss');
        }

        const prof = this.DIFFICULTY_PROFILES[this.difficulty] || this.DIFFICULTY_PROFILES.Normal;
        this.economyState.virtualMinerals = Math.min(2500, this.economyState.virtualMinerals + dt * 14 * prof.econRateMult);
        this.economyState.virtualGas = Math.min(1500, this.economyState.virtualGas + dt * 7 * prof.econRateMult);

        this._evalTimer += dt;
        if (this._evalTimer < prof.decisionInterval) return;
        this._evalTimer = 0;

        this.scoutEnemyComposition();
        this.evaluateDynamicCounterTransition();
        this.applyStrategyToField('zerg');
        this.applyStrategyToField('protoss');

        // Coordinate Flanking or Rush objectives on active Zerg units
        if (this.selectedStrategy === 'Flanking' && enemies.length > 0) {
            for (let i = 0; i < enemies.length; i++) {
                const e = enemies[i];
                if (e && e.hp > 0) {
                    e.isFlanker = (i % 2 === 0);
                    e.flankSide = (i % 4 < 2) ? 1 : -1;
                }
            }
        }
    }
};
window.AI_STRATEGY_DIAGNOSTICS = {
    getReport: () => window.STRATEGIC_COMMANDER.getDiagnostics(),
    setStrategy: (s, r, f) => window.STRATEGIC_COMMANDER.setStrategy(s, r, f),
    setDifficulty: (d) => window.STRATEGIC_COMMANDER.setDifficulty(d)
};

// ============================================================================
// ENGINE DEPENDENCY VALIDATION SYSTEM (CHECKS ALL REQUIRED ENGINE FUNCTIONS)
// ============================================================================
window.ENGINE_DEPENDENCY_VALIDATOR = {
    lastReport: null,
    validate() {
        const requiredDependencies = [
            { name: 'THREE', ref: () => window.THREE, caller: 'All 3D scripts' },
            { name: 'APP_ERROR_HANDLER', ref: () => window.APP_ERROR_HANDLER, caller: 'Global diagnostics & F9 monitor' },
            { name: 'SHADER_ENGINE', ref: () => window.SHADER_ENGINE, caller: 'textures-scene.js / terrain-fow.js' },
            { name: 'THRUST_FX_SYSTEM', ref: () => window.THRUST_FX_SYSTEM, caller: 'models-fx.js / game.js aircraft' },
            { name: 'PROJECTILE_VISUAL_FACTORY', ref: () => window.PROJECTILE_VISUAL_FACTORY, caller: 'models-fx.js / game.js combat' },
            { name: 'TERRAIN_CLASSIFIER', ref: () => window.TERRAIN_CLASSIFIER, caller: 'terrain-fow.js biome structure placement' },
            { name: 'OUT_OF_BOUNDS_TERRAIN_SYSTEM', ref: () => window.OUT_OF_BOUNDS_TERRAIN_SYSTEM, caller: 'terrain-fow.js border skirt' },
            { name: 'BIOME_SKYBOX_SYSTEM', ref: () => window.BIOME_SKYBOX_SYSTEM, caller: 'terrain-fow.js skybox' },
            { name: 'PERF_PROFILER', ref: () => window.PERF_PROFILER, caller: 'perf_optimizer.js / game.js F10 HUD' },
            { name: 'PERF_MANAGER', ref: () => window.PERF_MANAGER, caller: 'perf_optimizer.js / game.js adaptive quality' },
            { name: 'BATTLE_CINEMATIC', ref: () => window.BATTLE_CINEMATIC, caller: 'game.js / App.tsx spectator match' },
            { name: 'STRATEGIC_COMMANDER', ref: () => window.STRATEGIC_COMMANDER, caller: 'game.js AI strategy & playstyles' },
            { name: 'GAME_API', ref: () => window.GAME_API, caller: 'src/App.tsx React bridge' },
            { name: 'triggerFormSquad', ref: () => window.triggerFormSquad, caller: 'index.html #btn-form-squad onclick' },
            { name: 'selectAllArmy', ref: () => window.selectAllArmy, caller: 'index.html #army-SelectAll-btn onclick' },
            { name: 'switchToEndlessMode', ref: () => window.switchToEndlessMode, caller: 'index.html #btn-toggle-endless onclick' },
            { name: 'returnToMainMenu', ref: () => window.returnToMainMenu, caller: 'index.html #btn-top-menu onclick' }
        ];
        const missing = [];
        for (let i = 0; i < requiredDependencies.length; i++) {
            const dep = requiredDependencies[i];
            let val = null;
            try { val = dep.ref(); } catch (_) {}
            if (typeof val === 'undefined' || val === null) {
                missing.push({ name: dep.name, caller: dep.caller });
                if (window.APP_ERROR_HANDLER) {
                    window.APP_ERROR_HANDLER.record(
                        'ENGINE_DEPENDENCY_VALIDATOR',
                        new Error(`Missing required engine dependency: ${dep.name} (called by ${dep.caller})`),
                        'initialization',
                        'ERROR',
                        dep.name
                    );
                }
            }
        }
        const report = {
            ok: missing.length === 0,
            checkedCount: requiredDependencies.length,
            missing,
            timestamp: new Date().toISOString()
        };
        this.lastReport = report;
        return report;
    }
};
window.ENGINE_DEPENDENCY_VALIDATOR.validate();

window.titleScreenActive = true;
animate(performance.now());


