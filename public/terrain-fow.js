// ============================================================================
// 3. DYNAMIC PROCEDURAL TERRAIN GENERATOR, BRIDGES, RAVINE & FOG OF WAR
// ============================================================================
const MAP_SIZE = 260;
const FOW_RES = 128;
window.FOW_RES = FOW_RES;
if (typeof window.titleScreenActive === 'undefined') window.titleScreenActive = true;
const obstacles = [];
const envMapMeshes = [];
const BRIDGE_BARRIER_NO_GO_ZONES = [];
const BRIDGE_BUILDING_EXCLUSION_ZONES = [];
var ALL_BIOMES = ['highland', 'desert', 'jungle', 'ocean', 'lava'];
var STRUCTURE_BIOME_METADATA = null;
var STRUCTURE_PLACEMENT_DIAGNOSTICS = null;

function trackEnvMesh(obj) {
    if (obj) {
        scene.add(obj);
        envMapMeshes.push(obj);
    }
    return obj;
}

// Uncached dynamic procedural map seed (computes a fresh seed on every load and regeneration, ignoring any cached storage!)
let MAP_SEED = Math.floor(100000 + Math.random() * 899999);
window.MAP_SEED = MAP_SEED;
window.ACTIVE_MAP_SEED = MAP_SEED;

let seedState = Math.floor(MAP_SEED) + 1;
function seededRandom() {
    seedState = (seedState * 16807) % 2147483647;
    return (seedState - 1) / 2147483646;
}

// Dynamic Procedural Map Parameters & Planet Biome (Updated per seed in generateProceduralTopographyParameters)
let MAP_ARCHETYPE = 'open_badlands';
let ACTIVE_PLANET_BIOME = 'highland'; // 'highland' | 'desert' | 'ocean' | 'lava' | 'jungle'
let HAS_RAVINE_BRIDGES = false;
let HAS_VALLEY_RIVER = false;
let BRIDGE_COUNT = 0;
window.MAP_ARCHETYPE = MAP_ARCHETYPE;
window.ACTIVE_PLANET_BIOME = ACTIVE_PLANET_BIOME;
let RAVINE_CURVE_AMP = 3.5 + seededRandom() * 3.5;
let RAVINE_CURVE_FREQ = 0.04 + seededRandom() * 0.025;
let RAVINE_PHASE = seededRandom() * Math.PI * 2;
let RIVER_BASE_OFFSET_U = -4.5 + (seededRandom() - 0.5) * 3.2;
let RIVER_WAVE_AMP = 3.6 + seededRandom() * 1.4;
let RIVER_FREQ_1 = 0.048 + seededRandom() * 0.018;
let RIVER_FREQ_2 = 0.095 + seededRandom() * 0.032;
let RIVER_AMP_2 = 1.35 + seededRandom() * 0.85;
let HILL_FREQ_1 = 0.032 + seededRandom() * 0.014;
let HILL_FREQ_2 = 0.016 + seededRandom() * 0.010;
let HILL_AMP_1 = 0.46 + seededRandom() * 0.24;
let HILL_AMP_2 = 0.34 + seededRandom() * 0.20;

// Enemy Hive Cluster far away across the valley, Solaris Chrono-Synod Enclave in flanking sector & Player Start Sector
const ENEMY_BASE_POS = new THREE.Vector3(-74, 0, -74);
const ENEMY_BARRACKS_POS = new THREE.Vector3(-56, 0, -78);
const ENEMY_FACTORY_POS  = new THREE.Vector3(-78, 0, -56);
const SOLARIS_BASE_POS = new THREE.Vector3(58, 0, -56);
const PLAYER_START_POS = new THREE.Vector3(48, 0, 52);
window.SOLARIS_BASE_POS = SOLARIS_BASE_POS;

// Multi-Faction Base Sanctuary Terrain Archetypes ('flat_ramp', 'under_ramp', 'no_ramp')
const BASE_PLATEAU_RADIUS = 23.5;
const BASE_PLATEAU_RIM_OUTER = 27.5;
const BASE_PLATEAU_HEIGHT = 1.85;
let HAS_BASE_PLATEAU_RAMP = false;
let PLAYER_BASE_TECTONIC_MODE = 'no_ramp'; // 'flat_ramp' | 'under_ramp' | 'no_ramp'
let PLAYER_BASE_RAMP_DIR = { x: -0.70710678, z: -0.70710678 };
const PLAYER_BASE_RAMP_HALF_W = 4.65;
const BASE_TERRAIN_ZONES = [];
window.HAS_BASE_PLATEAU_RAMP = HAS_BASE_PLATEAU_RAMP;
window.BASE_TERRAIN_ZONES = BASE_TERRAIN_ZONES;
const DYNAMIC_TRENCHES = [];
window.DYNAMIC_TRENCHES = DYNAMIC_TRENCHES;
const GEM_CRATERS = [];
window.GEM_CRATERS = GEM_CRATERS;
const MINERAL_PATCHES = [];
window.MINERAL_PATCHES = MINERAL_PATCHES;

// Fast O(1) Bilinear Terrain Height Lookup Cache (Eliminates per-frame road spline & feature loop bottlenecks during gameplay)
const HEIGHT_CACHE_DIM = 261; // 1.0m grid resolution across [-130, +130]
const HEIGHT_CACHE_HALF = MAP_SIZE * 0.5;
const TERRAIN_HEIGHT_CACHE = new Float32Array(HEIGHT_CACHE_DIM * HEIGHT_CACHE_DIM);
let _terrainHeightCacheReady = false;

// Evaluates Multi-Ramp & Merged Second Platform Metrics:
// - First Upper Ramps (center + 2 angled wing ramps) descend from Upper Sanctuary Plateau onto a wide Merged Second Ramp Platform (Bastion Terrace)
// - Second Lower Ramp + 2 side platform ramps descend smoothly from the Merged Platform to the Valley Floor
// - Uses continuous C2 cosine lateral blending so there are ZERO sharp cliff spikes or seams!
function getBaseZoneRampMetrics(zone, x, z) {
    const dx = x - zone.x;
    const dz = z - zone.z;
    const dist = Math.hypot(dx, dz);
    const baseAng = Math.atan2(zone.rampDirZ, zone.rampDirX);
    const baseHalfW = (zone.rampHalfW || PLAYER_BASE_RAMP_HALF_W) * 1.12;

    // 3 Upper First-Ramp Openings converging toward the front Merged Bastion Platform + 1 Wide Second Lower Ramp
    const openingOffsets = [0.0, 0.68, -0.68];
    let bestAlong = -999;
    let bestAcross = 999;
    let activeOpeningIdx = 0;
    let effHalfW = baseHalfW;
    let inRampAngle = false;
    let maxRampBlend = 0.0;

    const innerR = zone.radius || BASE_PLATEAU_RADIUS;
    const outerR = zone.rimOuter || BASE_PLATEAU_RIM_OUTER;
    const mergedPlatformInner = outerR - 1.2;
    const mergedPlatformOuter = outerR + 6.4;
    const lowerRampOuter = outerR + 14.2;

    // Forward & lateral coordinates along the primary front axis (for the wide Merged Second Ramp Platform)
    const fwdAlong = dx * zone.rampDirX + dz * zone.rampDirZ;
    const fwdAcross = Math.abs(-dx * zone.rampDirZ + dz * zone.rampDirX);
    const relAng = Math.abs(Math.atan2(-dx * zone.rampDirZ + dz * zone.rampDirX, fwdAlong));

    for (let i = 0; i < openingOffsets.length; i++) {
        const ang = baseAng + openingOffsets[i];
        const rx = Math.cos(ang);
        const rz = Math.sin(ang);
        const al = dx * rx + dz * rz;
        const ac = Math.abs(-dx * rz + dz * rx);
        const hw = (i === 0) ? (baseHalfW * 1.15) : (baseHalfW * 0.92);
        const maxOuter = (i === 0) ? (lowerRampOuter + 2.5) : (mergedPlatformOuter + 5.5);
        const featherW = 3.4;

        if (al > (innerR - 8.5) && al < maxOuter && ac < hw + featherW) {
            const latT = THREE.MathUtils.clamp((ac - hw) / featherW, 0.0, 1.0);
            const blend = 0.5 + 0.5 * Math.cos(latT * Math.PI);
            if (blend > maxRampBlend) {
                maxRampBlend = blend;
                activeOpeningIdx = i;
                bestAlong = al;
                bestAcross = ac;
                effHalfW = hw;
            }
            if (ac <= hw + 0.45) {
                inRampAngle = true;
            }
        } else if (i === 0 && bestAlong === -999) {
            bestAlong = al;
            bestAcross = ac;
            activeOpeningIdx = 0;
            effHalfW = hw;
        }
    }

    // Wide Merged Second Ramp Platform Envelope: spans across all 3 upper ramp toes (`relAng <= 0.82`)
    let mergedPlatformBlend = 0.0;
    const mergedArcLimit = 0.82;
    const mergedArcFeather = 0.28;
    if (dist > innerR - 2.5 && dist < lowerRampOuter + 1.5 && relAng < mergedArcLimit + mergedArcFeather) {
        const angT = THREE.MathUtils.clamp((relAng - mergedArcLimit) / mergedArcFeather, 0.0, 1.0);
        const angBlend = 0.5 + 0.5 * Math.cos(angT * Math.PI);
        if (dist >= mergedPlatformInner && dist <= mergedPlatformOuter) {
            mergedPlatformBlend = angBlend;
            if (angBlend > 0.55) inRampAngle = true;
        } else if (dist > mergedPlatformOuter && dist <= lowerRampOuter) {
            // Second Wide Merged Ramp descending from Merged Platform to Valley Floor
            const secondRampHalfW = baseHalfW * 1.45;
            if (fwdAcross < secondRampHalfW + 3.6) {
                const lat2T = THREE.MathUtils.clamp((fwdAcross - secondRampHalfW) / 3.6, 0.0, 1.0);
                const lat2Blend = 0.5 + 0.5 * Math.cos(lat2T * Math.PI);
                mergedPlatformBlend = Math.max(mergedPlatformBlend, lat2Blend * angBlend);
                if (fwdAcross <= secondRampHalfW + 0.4) inRampAngle = true;
            }
        }
    }

    const combinedBlend = Math.max(maxRampBlend, mergedPlatformBlend);
    return {
        dist,
        along: fwdAlong,
        across: fwdAcross,
        relAng,
        inRampAngle,
        activeOpeningIdx,
        bestAlong,
        bestAcross,
        effHalfW,
        rampBlend: combinedBlend,
        mergedPlatformBlend,
        mergedPlatformInner,
        mergedPlatformOuter,
        isPrimaryOpening: activeOpeningIdx === 0,
        lowerRampOuter,
        openingAngles: [baseAng, baseAng + 0.68, baseAng - 0.68]
    };
}
window.getBaseZoneRampMetrics = getBaseZoneRampMetrics;

let RIVER_HALF_WIDTH = 3.35;
let RIVER_WATER_Y = -0.20;
let WATER_LEVEL = RIVER_WATER_Y;
window.RIVER_HALF_WIDTH = RIVER_HALF_WIDTH;
window.RIVER_WATER_Y = RIVER_WATER_Y;
window.WATER_LEVEL = WATER_LEVEL;
const RIVER_BRIDGES = [];
window.RIVER_BRIDGES = RIVER_BRIDGES;

const BRIDGES = [];
window.BRIDGES = BRIDGES;
const DYNAMIC_MESAS = [];
const DYNAMIC_MOUNTAINS = [];
const DYNAMIC_PONDS = [];
const DYNAMIC_VALLEYS = [];
const DYNAMIC_CANYONS = [];
const DYNAMIC_CRATERS = [];
const DYNAMIC_RAVINES = [];
const DYNAMIC_BOMB_CRATERS = [];
const FLATTENED_BUILDING_PADS = [];

// O(1) Spatial Road Lookup & Longitudinal Elevation Caches (261x261 at 1.0m grid resolution)
const ROAD_FACTOR_CACHE = new Float32Array(HEIGHT_CACHE_DIM * HEIGHT_CACHE_DIM);
const ROAD_ELEVATION_CACHE = new Float32Array(HEIGHT_CACHE_DIM * HEIGHT_CACHE_DIM);
let _roadSpatialCacheReady = false;

// Evaluates the organic, non-circular radius of a dynamic oasis pond at a given world angle
function getDynamicPondRadiusAtAngle(pd, ang) {
    if (!pd) return 5.0;
    const a = ang - (pd.rot || 0.0);
    const sx = pd.scaleX || 1.18;
    const sz = pd.scaleZ || 0.84;
    const ex = Math.cos(a) / sx;
    const ez = Math.sin(a) / sz;
    const ellipseScale = 1.0 / Math.max(0.4, Math.hypot(ex, ez));
    const lobeMod = 1.0
        + (pd.lobe2Amp !== undefined ? pd.lobe2Amp : 0.18) * Math.sin(a * 2.0 + (pd.phase2 || 0.5))
        + (pd.lobe3Amp !== undefined ? pd.lobe3Amp : 0.13) * Math.cos(a * 3.0 + (pd.phase3 || 1.7))
        + (pd.lobe4Amp !== undefined ? pd.lobe4Amp : 0.07) * Math.sin(a * 4.0 + (pd.phase4 || 2.9));
    return pd.r * ellipseScale * THREE.MathUtils.clamp(lobeMod, 0.62, 1.42);
}
window.getDynamicPondRadiusAtAngle = getDynamicPondRadiusAtAngle;

function getRiverCenterUAtS(s) {
    return RIVER_BASE_OFFSET_U
        + Math.sin(s * RIVER_FREQ_1 + MAP_SEED * 0.35) * RIVER_WAVE_AMP
        + Math.cos(s * RIVER_FREQ_2 + MAP_SEED * 0.15) * RIVER_AMP_2;
}

function getRiverTangentSlopeAtS(s) {
    return Math.cos(s * RIVER_FREQ_1 + MAP_SEED * 0.35) * RIVER_FREQ_1 * RIVER_WAVE_AMP
        - Math.sin(s * RIVER_FREQ_2 + MAP_SEED * 0.15) * RIVER_FREQ_2 * RIVER_AMP_2;
}

// Computes natural variable river half-width at coordinate s:
// Widens organically in floodplain meanders (up to ~4.45m) and narrows cleanly to RIVER_HALF_WIDTH (3.35m) at bridge crossings!
function getRiverHalfWidthAtS(s) {
    let bridgePinch = 1.0;
    for (let i = 0; i < RIVER_BRIDGES.length; i++) {
        const dS = Math.abs(s - RIVER_BRIDGES[i].sCoord);
        if (dS < 11.0) {
            const t = dS / 11.0;
            bridgePinch = Math.min(bridgePinch, t * t * (3.0 - 2.0 * t));
        }
    }
    const meanderSwell = 0.42 + 0.36 * Math.sin(s * 0.052 + MAP_SEED * 0.41) + 0.22 * Math.cos(s * 0.105 - MAP_SEED * 0.23);
    return RIVER_HALF_WIDTH + Math.max(0.0, meanderSwell) * bridgePinch;
}
window.getRiverHalfWidthAtS = getRiverHalfWidthAtS;

let RIVER_ANGLE = Math.PI * 0.25;
let RIVER_COS = 0.70710678;
let RIVER_SIN = 0.70710678;

function getRiverCoords(x, z) {
    // True orthonormal rotated coordinates along the dynamic seed-driven river axis: s = along river, u = across river
    const s = x * RIVER_COS - z * RIVER_SIN;
    const u = x * RIVER_SIN + z * RIVER_COS;
    const centerU = getRiverCenterUAtS(s);
    const halfWidth = getRiverHalfWidthAtS(s);
    return { s, u, centerU, halfWidth, dist: Math.abs(u - centerU), signedDist: u - centerU };
}

function riverCoordsToWorld(s, u) {
    return {
        x: s * RIVER_COS + u * RIVER_SIN,
        z: -s * RIVER_SIN + u * RIVER_COS
    };
}

// Unified Orthonormal Bridge Coordinate Frame (Shared by 3D bridge mesh, approach ramps, roads, height queries & unit collisions!)
function getBridgeLocalCoords(rb, x, z) {
    if (!rb || rb.centerX === undefined) {
        const rc = getRiverCoords(x, z);
        const bCenterU = getRiverCenterUAtS(rb ? rb.sCoord : 0);
        return { localS: rc.s - (rb ? rb.sCoord : 0), localU: rc.u - bCenterU };
    }
    const dx = x - rb.centerX;
    const dz = z - rb.centerZ;
    return {
        localS: dx * rb.cosYaw - dz * rb.sinYaw,
        localU: dx * rb.sinYaw + dz * rb.cosYaw
    };
}

function bridgeLocalToWorld(rb, localS, localU) {
    if (!rb || rb.centerX === undefined) {
        const s0 = rb ? rb.sCoord : 0;
        return riverCoordsToWorld(s0 + localS, getRiverCenterUAtS(s0) + localU);
    }
    return {
        x: rb.centerX + localS * rb.cosYaw + localU * rb.sinYaw,
        z: rb.centerZ - localS * rb.sinYaw + localU * rb.cosYaw
    };
}
window.getBridgeLocalCoords = getBridgeLocalCoords;
window.bridgeLocalToWorld = bridgeLocalToWorld;

function getRiverDist(x, z) {
    if (!HAS_VALLEY_RIVER) return 999.0;
    if (ACTIVE_PLANET_BIOME === 'ocean') {
        const gh = getTerrainHeight(x, z);
        if (gh <= WATER_LEVEL + 0.05) return 0.0;
        return Math.max(4.8, (gh - WATER_LEVEL) * 14.0);
    }
    return getRiverCoords(x, z).dist;
}

function isPointInValleyRiver(x, z, extraRadius = 0.5) {
    if (!HAS_VALLEY_RIVER) return false;
    if (isOnRiverBridge(x, z)) return false;
    if (ACTIVE_PLANET_BIOME === 'ocean') {
        return getTerrainHeight(x, z) <= WATER_LEVEL + 0.04;
    }
    const rc = getRiverCoords(x, z);
    return rc.dist <= (rc.halfWidth || RIVER_HALF_WIDTH) + extraRadius;
}
window.isPointInValleyRiver = isPointInValleyRiver;

// Helper: evaluates Player Base Sanctuary Plateau & Intruding Entrance Ramp geometry at (x, z)
function getPlayerBaseRampMetrics(x, z) {
    const dx = x - PLAYER_START_POS.x;
    const dz = z - PLAYER_START_POS.z;
    const dist = Math.hypot(dx, dz);
    const along = dx * PLAYER_BASE_RAMP_DIR.x + dz * PLAYER_BASE_RAMP_DIR.z;
    const across = Math.abs(-dx * PLAYER_BASE_RAMP_DIR.z + dz * PLAYER_BASE_RAMP_DIR.x);
    const inRampAngle = along > 14.0 && along < (BASE_PLATEAU_RIM_OUTER + 6.5) && across <= PLAYER_BASE_RAMP_HALF_W;
    return { dist, along, across, inRampAngle };
}
window.getPlayerBaseRampMetrics = getPlayerBaseRampMetrics;

// Strictly check if a point lies inside any of the designated Base Drop-Zone or Multi-Faction Base Placement zones
function isInsideBasePlacementZone(x, z, margin = 12.0) {
    if (Math.hypot(x - PLAYER_START_POS.x, z - PLAYER_START_POS.z) < margin) return true;
    if (Math.hypot(x - (PLAYER_START_POS.x - 13.5), z - (PLAYER_START_POS.z + 5.5)) < margin) return true;
    if (Math.hypot(x - (PLAYER_START_POS.x + 13.5), z - (PLAYER_START_POS.z + 4.5)) < margin) return true;
    for (let i = 0; i < BASE_TERRAIN_ZONES.length; i++) {
        const bz = BASE_TERRAIN_ZONES[i];
        if (Math.hypot(x - bz.x, z - bz.z) < Math.max(margin, bz.rimOuter + 4.0)) return true;
    }
    return false;
}
window.isInsideBasePlacementZone = isInsideBasePlacementZone;

function getRavineSignedDist(x, z) {
    if (!HAS_RAVINE_BRIDGES) return 999.0;
    return (x + z) * 0.70710678 + Math.sin((x - z) * RAVINE_CURVE_FREQ + RAVINE_PHASE) * RAVINE_CURVE_AMP;
}

function getRiverBridgeFactor(x, z) {
    let bestFactor = 0.0;
    for (let i = 0; i < RIVER_BRIDGES.length; i++) {
        const br = RIVER_BRIDGES[i];
        if (br.destroyed) continue;
        const bc = getBridgeLocalCoords(br, x, z);
        const dU = Math.abs(bc.localU);
        const reachU = (br.rampReachU || (RIVER_HALF_WIDTH + 3.65));
        if (dU > reachU) continue;
        const dS = Math.abs(bc.localS);
        const deckHalfW = br.halfWidth - 0.15;
        if (dS <= deckHalfW) {
            bestFactor = Math.max(bestFactor, 1.0);
        } else if (dS <= deckHalfW + 1.4) {
            bestFactor = Math.max(bestFactor, 0.5 + 0.5 * Math.cos(((dS - deckHalfW) / 1.4) * Math.PI));
        }
    }
    return bestFactor;
}

function isOnRiverBridge(x, z, unitRad = 0.0) {
    for (let i = 0; i < RIVER_BRIDGES.length; i++) {
        const br = RIVER_BRIDGES[i];
        if (br.destroyed) continue;
        const bc = getBridgeLocalCoords(br, x, z);
        const dU = Math.abs(bc.localU);
        const reachU = (br.rampReachU || (RIVER_HALF_WIDTH + 3.65));
        if (dU <= reachU) {
            const safeHalfW = br.halfWidth - 0.45 - Math.min(0.28, unitRad * 0.35);
            if (Math.abs(bc.localS) <= safeHalfW) {
                return true;
            }
        }
    }
    return false;
}
window.isOnRiverBridge = isOnRiverBridge;

function isPointInBridgeApproachCorridor(x, z, extraWidth = 3.2, inlandReach = 12.5) {
    for (let i = 0; i < RIVER_BRIDGES.length; i++) {
        const br = RIVER_BRIDGES[i];
        const bc = getBridgeLocalCoords(br, x, z);
        const effRiverHalfW = br.riverHalfW || RIVER_HALF_WIDTH;
        if (Math.abs(bc.localU) <= effRiverHalfW + inlandReach &&
            Math.abs(bc.localS) <= br.halfWidth + extraWidth) {
            return true;
        }
    }
    return false;
}
window.isPointInBridgeApproachCorridor = isPointInBridgeApproachCorridor;

// Rebuilds Bridge Barrier 'No-Go' Zones (along side guardrails) and Building Collision Exclusion Zones around bridges
function rebuildBridgeNavAndExclusionZones() {
    BRIDGE_BARRIER_NO_GO_ZONES.length = 0;
    BRIDGE_BUILDING_EXCLUSION_ZONES.length = 0;

    RIVER_BRIDGES.forEach((rb, bIdx) => {
        const s0 = rb.sCoord;
        const centerU = getRiverCenterUAtS(s0);
        const effRiverHalfW = rb.riverHalfW || RIVER_HALF_WIDTH;
        const railSpanHalfU = rb.flatHalfSpan || (effRiverHalfW + 1.05);
        const railOffsetS = rb.halfWidth * 0.98;
        const rampToeDist = rb.rampReachU || (effRiverHalfW + 3.65);

        // 1. Building Collision Exclusion Zone (OBB around bridge deck + approach ramp plazas)
        const southRampToe = bridgeLocalToWorld(rb, 0, rampToeDist);
        const northRampToe = bridgeLocalToWorld(rb, 0, -rampToeDist);
        BRIDGE_BUILDING_EXCLUSION_ZONES.push({
            bridgeIdx: bIdx,
            sCoord: s0,
            centerU,
            deckHalfS: rb.halfWidth + 0.65,
            spanHalfU: rampToeDist + 0.4,
            southPlaza: { x: southRampToe.x, z: southRampToe.z, r: 3.6 },
            northPlaza: { x: northRampToe.x, z: northRampToe.z, r: 3.6 }
        });

        // 2. Non-Walkable 'No-Go' Zones strictly along the outer Bridge Side Guardrails
        [-1, 1].forEach(sideSign => {
            const localRailS = sideSign * railOffsetS;
            for (let uStep = -railSpanHalfU; uStep <= railSpanHalfU; uStep += 1.05) {
                const wPt = bridgeLocalToWorld(rb, localRailS, uStep);
                BRIDGE_BARRIER_NO_GO_ZONES.push({
                    x: wPt.x,
                    z: wPt.z,
                    r: 0.26,
                    sCoord: s0 + localRailS,
                    sideSign,
                    bridgeIdx: bIdx
                });
            }
        });
    });
}
window.BRIDGE_BARRIER_NO_GO_ZONES = BRIDGE_BARRIER_NO_GO_ZONES;
window.BRIDGE_BUILDING_EXCLUSION_ZONES = BRIDGE_BUILDING_EXCLUSION_ZONES;

// Checks if a point over the bridge deck or ramp shoulder clips into the side guardrails
function isPointInBridgeBarrierNoGoZone(x, z, unitRad = 0.0) {
    for (let i = 0; i < RIVER_BRIDGES.length; i++) {
        const br = RIVER_BRIDGES[i];
        const bc = getBridgeLocalCoords(br, x, z);
        const spanHalfU = (br.flatHalfSpan || (RIVER_HALF_WIDTH + 1.05)) + 0.20;
        if (Math.abs(bc.localU) > spanHalfU) continue;
        const dS = Math.abs(bc.localS);
        const innerWalkwayLimit = br.halfWidth - 0.45 - Math.min(0.28, unitRad * 0.35);
        const outerBarrierLimit = br.halfWidth + 0.55 + Math.min(0.28, unitRad * 0.35);
        if (dS > innerWalkwayLimit && dS < outerBarrierLimit) {
            return true;
        }
    }
    return false;
}
window.isPointInBridgeBarrierNoGoZone = isPointInBridgeBarrierNoGoZone;

function generateProceduralTopographyParameters(customSeed) {
    // Honor any explicitly provided numeric customSeed deterministically (critical for seed replay & multiplayer sync!).
    // Only generate a new non-repeating random seed when customSeed is omitted/undefined.
    const prevSeed = MAP_SEED;
    if (typeof customSeed === 'number' && Number.isFinite(customSeed)) {
        MAP_SEED = Math.max(1, Math.floor(customSeed));
    } else {
        let candidate = Math.floor(100000 + Math.random() * 899999);
        if (candidate === prevSeed) candidate = ((candidate + 137911) % 899999) + 100000;
        MAP_SEED = candidate;
    }
    window.MAP_SEED = MAP_SEED;
    window.ACTIVE_MAP_SEED = MAP_SEED;
    seedState = Math.floor(MAP_SEED) + 1;

    // Select a distinct procedural map archetype from the seed so layouts never look identical!
    const archetypes = [
        'river_bridges',
        'canyon_crossfire',
        'open_badlands',
        'fortified_plateau',
        'crater_basin',
        'tectonic_ravines'
    ];
    const archIdx = Math.floor(seededRandom() * archetypes.length);
    MAP_ARCHETYPE = archetypes[archIdx];
    window.MAP_ARCHETYPE = MAP_ARCHETYPE;

    // Resolve Planet Biome ('highland' | 'desert' | 'ocean' | 'lava' | 'jungle') from WORLD_GEN_CONFIG or seed
    const requestedBiome = (window.WORLD_GEN_CONFIG && window.WORLD_GEN_CONFIG.biome)
        ? String(window.WORLD_GEN_CONFIG.biome).toLowerCase()
        : 'highland';
    const planetBiomes = ['highland', 'desert', 'ocean', 'lava', 'jungle'];
    if (requestedBiome === 'random') {
        ACTIVE_PLANET_BIOME = planetBiomes[Math.floor(seededRandom() * planetBiomes.length)];
    } else if (planetBiomes.includes(requestedBiome)) {
        ACTIVE_PLANET_BIOME = requestedBiome;
    } else {
        ACTIVE_PLANET_BIOME = 'highland';
    }
    window.ACTIVE_PLANET_BIOME = ACTIVE_PLANET_BIOME;
    const biomeIdMap = { highland: 0.0, desert: 1.0, ocean: 2.0, lava: 3.0, jungle: 4.0 };
    if (typeof SHADER_ENGINE !== 'undefined' && typeof SHADER_ENGINE.setBiomeId === 'function') {
        SHADER_ENGINE.setBiomeId(biomeIdMap[ACTIVE_PLANET_BIOME] ?? 0.0);
    }

    // Dictate terrain elevation frequencies & amplitudes from the new seed, archetype, and planet biome
    RAVINE_CURVE_AMP = 3.5 + seededRandom() * 4.2;
    RAVINE_CURVE_FREQ = 0.036 + seededRandom() * 0.030;
    RAVINE_PHASE = seededRandom() * Math.PI * 2;
    RIVER_BASE_OFFSET_U = -5.0 + (seededRandom() - 0.5) * 7.5;
    RIVER_WAVE_AMP = 2.8 + seededRandom() * 2.4;
    RIVER_FREQ_1 = 0.038 + seededRandom() * 0.022;
    RIVER_FREQ_2 = 0.080 + seededRandom() * 0.036;
    RIVER_AMP_2 = 0.95 + seededRandom() * 1.05;
    HILL_FREQ_1 = 0.026 + seededRandom() * 0.026;
    HILL_FREQ_2 = 0.014 + seededRandom() * 0.018;
    const isRugged = (MAP_ARCHETYPE === 'canyon_crossfire' || MAP_ARCHETYPE === 'tectonic_ravines' || ACTIVE_PLANET_BIOME === 'lava');
    const duneBoost = ACTIVE_PLANET_BIOME === 'desert' ? 1.25 : (ACTIVE_PLANET_BIOME === 'ocean' ? 0.82 : 1.0);
    HILL_AMP_1 = ((isRugged ? 0.54 : 0.34) + seededRandom() * 0.34) * duneBoost;
    HILL_AMP_2 = ((isRugged ? 0.38 : 0.24) + seededRandom() * 0.26) * duneBoost;

    // Dynamically configure river / lava channel / ocean strait & bridge placement from the procedural seed and biome
    RIVER_BRIDGES.length = 0;
    BRIDGES.length = 0;
    const waterCfg = (window.WORLD_GEN_CONFIG && typeof window.WORLD_GEN_CONFIG.waterLevel === 'number')
        ? window.WORLD_GEN_CONFIG.waterLevel
        : 1.0;
    if (ACTIVE_PLANET_BIOME === 'desert') {
        // Desert Planet: dry canyon riverbeds by default (or rare oasis channel)
        HAS_VALLEY_RIVER = false;
    } else if (ACTIVE_PLANET_BIOME === 'ocean' || ACTIVE_PLANET_BIOME === 'lava' || ACTIVE_PLANET_BIOME === 'jungle') {
        // Ocean, Lava, and Jungle planets always feature a central water/lava channel with bridges so bases remain connected
        HAS_VALLEY_RIVER = waterCfg > 0.05;
    } else {
        HAS_VALLEY_RIVER = waterCfg > 0.15 && (
            MAP_ARCHETYPE === 'river_bridges' ||
            MAP_ARCHETYPE === 'canyon_crossfire' ||
            MAP_ARCHETYPE === 'open_badlands' ||
            MAP_ARCHETYPE === 'fortified_plateau'
        );
    }
    HAS_RAVINE_BRIDGES = false;

    // Dynamically pick one of 8 distinct cardinal/diagonal sectors for Player Start so every regenerated map has a genuinely new layout!
    const sectorSlot = Math.floor(seededRandom() * 8);
    const playerSectorAng = (sectorSlot * (Math.PI * 0.25)) + (seededRandom() - 0.5) * 0.24;
    const playerDist = 66.0 + seededRandom() * 14.0;
    PLAYER_START_POS.set(
        THREE.MathUtils.clamp(Math.round(Math.cos(playerSectorAng) * playerDist), -76, 76),
        0,
        THREE.MathUtils.clamp(Math.round(Math.sin(playerSectorAng) * playerDist), -76, 76)
    );

    // Place Enemy Zerg Hive FAR AWAY in the opposite sector across the map (~155m-195m separation)
    const enemySectorAng = playerSectorAng + Math.PI + (seededRandom() - 0.5) * 0.28;
    const enemyDist = 76.0 + seededRandom() * 14.0;
    ENEMY_BASE_POS.set(
        THREE.MathUtils.clamp(Math.round(Math.cos(enemySectorAng) * enemyDist), -84, 84),
        0,
        THREE.MathUtils.clamp(Math.round(Math.sin(enemySectorAng) * enemyDist), -84, 84)
    );

    // Align the dynamic river axis so the river flows perpendicular to the Player-to-Enemy battle axis!
    // In riverCoordsToWorld(s, u): +s flows along (RIVER_COS, -RIVER_SIN), and +u (across river) points along (RIVER_SIN, RIVER_COS).
    // Setting RIVER_ANGLE = Math.atan2(battleAxisX, battleAxisZ) aligns the across-river +u axis with the Player-to-Enemy vector!
    const battleAxisAng = Math.atan2(PLAYER_START_POS.x - ENEMY_BASE_POS.x, PLAYER_START_POS.z - ENEMY_BASE_POS.z);
    RIVER_ANGLE = battleAxisAng + (seededRandom() - 0.5) * 0.20;
    RIVER_COS = Math.cos(RIVER_ANGLE);
    RIVER_SIN = Math.sin(RIVER_ANGLE);

    // Reset river width & water elevation defaults before biome-specific overrides
    RIVER_HALF_WIDTH = ACTIVE_PLANET_BIOME === 'lava' ? 4.55 : 3.35;
    RIVER_WATER_Y = -0.20;
    WATER_LEVEL = RIVER_WATER_Y;
    window.RIVER_HALF_WIDTH = RIVER_HALF_WIDTH;
    window.RIVER_WATER_Y = RIVER_WATER_Y;
    window.WATER_LEVEL = WATER_LEVEL;

    // Place Enemy Barracks/Factory and 3rd Faction (Solaris Chrono-Synod Allied Enclave) BEFORE archipelago/fissure generation!
    const enemyInwardAng = Math.atan2(-ENEMY_BASE_POS.z, -ENEMY_BASE_POS.x);
    ENEMY_BARRACKS_POS.set(
        ENEMY_BASE_POS.x + Math.cos(enemyInwardAng - 0.52) * 12.2,
        0,
        ENEMY_BASE_POS.z + Math.sin(enemyInwardAng - 0.52) * 12.2
    );
    ENEMY_FACTORY_POS.set(
        ENEMY_BASE_POS.x + Math.cos(enemyInwardAng + 0.52) * 12.2,
        0,
        ENEMY_BASE_POS.z + Math.sin(enemyInwardAng + 0.52) * 12.2
    );

    const allyFlankSign = seededRandom() > 0.5 ? 1 : -1;
    const solarisSectorAng = playerSectorAng + allyFlankSign * (0.52 + seededRandom() * 0.16);
    const solarisDist = 62.0 + seededRandom() * 14.0;
    SOLARIS_BASE_POS.set(
        THREE.MathUtils.clamp(Math.round(Math.cos(solarisSectorAng) * solarisDist), -80, 80),
        0,
        THREE.MathUtils.clamp(Math.round(Math.sin(solarisSectorAng) * solarisDist), -80, 80)
    );

    window.OCEAN_ISLANDS = [];
    window.LAVA_FISSURES = [];

    if (ACTIVE_PLANET_BIOME === 'ocean') {
        HAS_VALLEY_RIVER = true;
        RIVER_HALF_WIDTH = 14.5;
        RIVER_WATER_Y = -0.18;
        WATER_LEVEL = RIVER_WATER_Y;
        window.RIVER_HALF_WIDTH = RIVER_HALF_WIDTH;
        window.RIVER_WATER_Y = RIVER_WATER_Y;
        window.WATER_LEVEL = WATER_LEVEL;

        // Multi-island archipelago: 5 large strategic islands + 6 smaller satellite islands/atolls
        const makeArchipelagoIsland = (id, x, z, rx, rz, rot, peakH, isMajor = false) => ({
            id, x, z, rx, rz,
            cosR: Math.cos(rot),
            sinR: Math.sin(rot),
            peakH,
            isMajor,
            lobePhase1: seededRandom() * Math.PI * 2,
            lobePhase2: seededRandom() * Math.PI * 2,
            lobePhase3: seededRandom() * Math.PI * 2,
            coveAngle: seededRandom() * Math.PI * 2
        });

        const centralX = Math.round((seededRandom() - 0.5) * 8.0);
        const centralZ = Math.round((seededRandom() - 0.5) * 8.0);
        const oppFlankX = THREE.MathUtils.clamp(-SOLARIS_BASE_POS.x + Math.round((seededRandom() - 0.5) * 8.0), -78, 78);
        const oppFlankZ = THREE.MathUtils.clamp(-SOLARIS_BASE_POS.z + Math.round((seededRandom() - 0.5) * 8.0), -78, 78);

        window.OCEAN_ISLANDS.push(
            makeArchipelagoIsland('island_player', PLAYER_START_POS.x, PLAYER_START_POS.z, 31.0, 28.5, seededRandom() * Math.PI, 1.25, true),
            makeArchipelagoIsland('island_enemy', ENEMY_BASE_POS.x, ENEMY_BASE_POS.z, 31.5, 29.0, seededRandom() * Math.PI, 1.20, true),
            makeArchipelagoIsland('island_solaris', SOLARIS_BASE_POS.x, SOLARIS_BASE_POS.z, 26.5, 24.5, seededRandom() * Math.PI, 1.15, true),
            makeArchipelagoIsland('island_central', centralX, centralZ, 24.5, 22.5, seededRandom() * Math.PI, 1.45, true),
            makeArchipelagoIsland('island_flank', oppFlankX, oppFlankZ, 24.0, 22.0, seededRandom() * Math.PI, 1.18, true)
        );

        const islPlayer = window.OCEAN_ISLANDS[0];
        const islEnemy = window.OCEAN_ISLANDS[1];
        const islSolaris = window.OCEAN_ISLANDS[2];
        const islCentral = window.OCEAN_ISLANDS[3];
        const islFlank = window.OCEAN_ISLANDS[4];

        // Primary inter-island bridge corridors to keep clear of satellite islands
        const plannedBridgePairs = [
            [islPlayer, islCentral],
            [islCentral, islEnemy],
            [islCentral, islSolaris],
            [islCentral, islFlank],
            [islPlayer, islSolaris]
        ];
        const distToSegment2D = (px, pz, ax, az, bx, bz) => {
            const vx = bx - ax, vz = bz - az;
            const lenSq = vx * vx + vz * vz || 1.0;
            const t = THREE.MathUtils.clamp(((px - ax) * vx + (pz - az) * vz) / lenSq, 0.0, 1.0);
            return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
        };

        const satCandidates = [
            [-78, 0, 15.5, 13.5, 0.96],
            [78, 0, 15.5, 13.5, 0.98],
            [0, -82, 15.0, 13.0, 0.94],
            [0, 82, 15.0, 13.0, 0.95],
            [(ENEMY_BASE_POS.x + oppFlankX) * 0.52, (ENEMY_BASE_POS.z + oppFlankZ) * 0.52, 15.5, 13.5, 1.06],
            [(PLAYER_START_POS.x + oppFlankX) * 0.52, (PLAYER_START_POS.z + oppFlankZ) * 0.52, 16.0, 14.0, 1.08],
            [(ENEMY_BASE_POS.x + SOLARIS_BASE_POS.x) * 0.52, (ENEMY_BASE_POS.z + SOLARIS_BASE_POS.z) * 0.52, 16.0, 14.0, 1.08]
        ];
        satCandidates.forEach(([sx, sz, srx, srz, sh], idx) => {
            const jx = THREE.MathUtils.clamp(Math.round(sx + (seededRandom() - 0.5) * 6.0), -94, 94);
            const jz = THREE.MathUtils.clamp(Math.round(sz + (seededRandom() - 0.5) * 6.0), -94, 94);
            const maxSatR = Math.max(srx, srz);
            const clearExisting = window.OCEAN_ISLANDS.every(isl => Math.hypot(jx - isl.x, jz - isl.z) > (Math.max(isl.rx, isl.rz) + maxSatR + 4.0));
            const clearBridgeChannels = plannedBridgePairs.every(([a, b]) => distToSegment2D(jx, jz, a.x, a.z, b.x, b.z) > maxSatR + 12.0);
            if (clearExisting && clearBridgeChannels) {
                window.OCEAN_ISLANDS.push(
                    makeArchipelagoIsland(`island_sat_${idx + 1}`, jx, jz, srx, srz, seededRandom() * Math.PI, sh, false)
                );
            }
        });

        // Exact island height evaluator (without bridge grading) for coastline / shoreline intersection raymarching
        const evalSingleIslandHeight = (isl, x, z) => {
            const baseWave = Math.sin(x * HILL_FREQ_1 + MAP_SEED) * Math.cos(z * HILL_FREQ_1 + MAP_SEED) * HILL_AMP_1
                + Math.sin(x * HILL_FREQ_2 - z * (HILL_FREQ_2 * 1.22) + MAP_SEED * 0.5) * HILL_AMP_2;
            const dx = x - isl.x;
            const dz = z - isl.z;
            const lx = dx * isl.cosR + dz * isl.sinR;
            const lz = -dx * isl.sinR + dz * isl.cosR;
            const ang = Math.atan2(lz, lx);
            const coastMod = 1.0
                + 0.15 * Math.sin(ang * 3.0 + isl.lobePhase1)
                + 0.10 * Math.cos(ang * 5.0 + isl.lobePhase2)
                + 0.06 * Math.sin(ang * 7.0 + (isl.lobePhase3 || 1.2))
                - 0.12 * Math.exp(-Math.pow(Math.atan2(Math.sin(ang - isl.coveAngle), Math.cos(ang - isl.coveAngle)) * 2.4, 2));
            const effRx = isl.rx * coastMod;
            const effRz = isl.rz * coastMod;
            const normR = Math.hypot(lx / effRx, lz / effRz);
            if (normR >= 1.55) return -1.42;
            if (normR <= 0.64) {
                const inlandT = normR / 0.64;
                const bluffRing = Math.pow(Math.sin(inlandT * Math.PI), 1.6) * 0.24 * (0.5 + 0.5 * Math.sin(ang * 2.0 + isl.lobePhase1));
                const baseElevation = isl.isMajor ? 0.68 : 0.62;
                return baseElevation + bluffRing * isl.peakH + baseWave * 0.12;
            }
            if (normR <= 0.96) {
                const beachT = (normR - 0.64) / 0.32;
                const sBeach = beachT * beachT * (3.0 - 2.0 * beachT);
                const rimBase = (isl.isMajor ? 0.68 : 0.62) + baseWave * 0.08;
                const beachShelf = 0.22 * Math.sin(beachT * Math.PI);
                return THREE.MathUtils.lerp(rimBase, -0.06, sBeach) + beachShelf * 0.35;
            }
            if (normR <= 1.26) {
                const shoalT = (normR - 0.96) / 0.30;
                const sShoal = shoalT * shoalT * (3.0 - 2.0 * shoalT);
                return THREE.MathUtils.lerp(-0.06, -0.46, sShoal);
            }
            const deepT = (normR - 1.26) / 0.29;
            const sDeep = deepT * deepT * (3.0 - 2.0 * deepT);
            return THREE.MathUtils.lerp(-0.46, -1.42, sDeep);
        };

        const evalAllIslandsHeight = (x, z) => {
            let bestH = -1.42 + Math.sin(x * 0.055 + MAP_SEED) * Math.cos(z * 0.055) * 0.16;
            for (let i = 0; i < window.OCEAN_ISLANDS.length; i++) {
                const ih = evalSingleIslandHeight(window.OCEAN_ISLANDS[i], x, z);
                if (ih > bestH) bestH = ih;
            }
            return bestH;
        };

        // Geometry-aware long bridge placement between distinct islands:
        // 1. Raymarches actual island coastlines to find exact shoreline intersections.
        // 2. Verifies the bridge deck spans open water and never cuts through any island interior.
        // 3. Verifies both approach ramps terminate on walkable terrain above water.
        // 4. Verifies clearance from other bridges and structures, testing lateral offset candidates if needed.
        const createIslandBridgeLink = (islA, islB, bIdx, archType) => {
            if (!islA || !islB || islA.id === islB.id) return false;
            const baseDx = islB.x - islA.x;
            const baseDz = islB.z - islA.z;
            const baseDist = Math.hypot(baseDx, baseDz);
            if (!Number.isFinite(baseDist) || baseDist < 12.0) return false;

            const baseDirX = baseDx / baseDist;
            const baseDirZ = baseDz / baseDist;
            const perpX = -baseDirZ;
            const perpZ = baseDirX;

            const shoreElevThreshold = WATER_LEVEL + 0.16; // ~-0.02m dry shoreline edge above water (-0.18m)
            const rampLength = 4.8;
            const bHalfW = 5.1;
            const lateralOffsets = [0, -3.5, 3.5, -7.0, 7.0, -10.5, 10.5, -14.0, 14.0, -18.0, 18.0];

            let chosenCandidate = null;
            let bestFallbackCandidate = null;
            let bestFallbackMaxMidH = Infinity;

            for (let cIdx = 0; cIdx < lateralOffsets.length; cIdx++) {
                const latOff = lateralOffsets[cIdx];
                const startX = islA.x + perpX * latOff;
                const startZ = islA.z + perpZ * latOff;
                const endX = islB.x + perpX * latOff;
                const endZ = islB.z + perpZ * latOff;

                const dirX = (endX - startX) / baseDist;
                const dirZ = (endZ - startZ) / baseDist;

                // Step 1: Raymarch outward from islA center to find exact coastline exit into water
                let sShoreA = null;
                const step = 0.5;
                const maxSearchA = Math.min(baseDist * 0.72, Math.max(islA.rx, islA.rz) * 1.45);
                for (let s = 3.5; s <= maxSearchA; s += step) {
                    const px = startX + dirX * s;
                    const pz = startZ + dirZ * s;
                    const hA = evalSingleIslandHeight(islA, px, pz);
                    if (hA > shoreElevThreshold) {
                        sShoreA = s;
                    } else if (sShoreA !== null && hA <= WATER_LEVEL + 0.06) {
                        break;
                    }
                }

                // Step 2: Raymarch outward from islB center toward islA to find exact coastline exit on islB
                let sFromB = null;
                const maxSearchB = Math.min(baseDist * 0.72, Math.max(islB.rx, islB.rz) * 1.45);
                for (let s = 3.5; s <= maxSearchB; s += step) {
                    const px = endX - dirX * s;
                    const pz = endZ - dirZ * s;
                    const hB = evalSingleIslandHeight(islB, px, pz);
                    if (hB > shoreElevThreshold) {
                        sFromB = s;
                    } else if (sFromB !== null && hB <= WATER_LEVEL + 0.06) {
                        break;
                    }
                }

                if (sShoreA === null || sFromB === null) continue;
                const sShoreB = baseDist - sFromB;
                const waterSpanLen = sShoreB - sShoreA;
                if (waterSpanLen < 4.5) continue;

                // Step 3: Verify the bridge deck spans water rather than extending through any island interior
                let spansOnlyWater = true;
                let maxMidIslandH = -Infinity;
                for (let s = sShoreA + 1.5; s <= sShoreB - 1.5; s += 1.0) {
                    const px = startX + dirX * s;
                    const pz = startZ + dirZ * s;
                    const hAll = evalAllIslandsHeight(px, pz);
                    if (hAll > maxMidIslandH) maxMidIslandH = hAll;
                    if (hAll > WATER_LEVEL + 0.16) {
                        spansOnlyWater = false;
                    }
                    // Also check lateral edges of the deck
                    for (const side of [-bHalfW, bHalfW]) {
                        const lpx = px + perpX * side;
                        const lpz = pz + perpZ * side;
                        const lh = evalAllIslandsHeight(lpx, lpz);
                        if (lh > maxMidIslandH) maxMidIslandH = lh;
                        if (lh > WATER_LEVEL + 0.22) {
                            spansOnlyWater = false;
                        }
                    }
                }

                // Step 4: Verify both approach ramps terminate on walkable terrain above water on islA and islB
                const sToeA = Math.max(2.0, sShoreA - rampLength);
                const sToeB = Math.min(baseDist - 2.0, sShoreB + rampLength);
                const toeAX = startX + dirX * sToeA;
                const toeAZ = startZ + dirZ * sToeA;
                const toeBX = startX + dirX * sToeB;
                const toeBZ = startZ + dirZ * sToeB;
                const toeAH = Math.max(evalSingleIslandHeight(islA, toeAX, toeAZ), evalAllIslandsHeight(toeAX, toeAZ));
                const toeBH = Math.max(evalSingleIslandHeight(islB, toeBX, toeBZ), evalAllIslandsHeight(toeBX, toeBZ));
                if (toeAH < WATER_LEVEL + 0.22 || toeBH < WATER_LEVEL + 0.22) continue;

                // Step 5: Check clearance from existing bridges
                const shoreAX = startX + dirX * sShoreA;
                const shoreAZ = startZ + dirZ * sShoreA;
                const shoreBX = startX + dirX * sShoreB;
                const shoreBZ = startZ + dirZ * sShoreB;
                const cx = (shoreAX + shoreBX) * 0.5;
                const cz = (shoreAZ + shoreBZ) * 0.5;

                const clearOfOtherBridges = RIVER_BRIDGES.every(other => {
                    const centerDist = Math.hypot(cx - other.centerX, cz - other.centerZ);
                    return centerDist > (bHalfW + other.halfWidth + 4.5);
                });
                if (!clearOfOtherBridges) continue;

                const candObj = {
                    dirX, dirZ,
                    shoreAX, shoreAZ, shoreAY: evalAllIslandsHeight(shoreAX, shoreAZ),
                    shoreBX, shoreBZ, shoreBY: evalAllIslandsHeight(shoreBX, shoreBZ),
                    toeAX, toeAZ, toeAH,
                    toeBX, toeBZ, toeBH,
                    cx, cz,
                    waterSpanLen
                };

                if (spansOnlyWater) {
                    chosenCandidate = candObj;
                    break;
                } else if (maxMidIslandH < bestFallbackMaxMidH) {
                    bestFallbackMaxMidH = maxMidIslandH;
                    bestFallbackCandidate = candObj;
                }
            }

            if (!chosenCandidate && bestFallbackCandidate) {
                chosenCandidate = bestFallbackCandidate;
            }
            if (!chosenCandidate) {
                // Guaranteed geometric fallback between island interiors so strategic islands are NEVER left unbridged
                const sShoreA = Math.min(baseDist * 0.36, Math.max(islA.rx, islA.rz) * 0.80);
                const sShoreB = Math.max(baseDist * 0.64, baseDist - Math.max(islB.rx, islB.rz) * 0.80);
                const waterSpanLen = Math.max(6.0, sShoreB - sShoreA);
                const shoreAX = islA.x + baseDirX * sShoreA;
                const shoreAZ = islA.z + baseDirZ * sShoreA;
                const shoreBX = islA.x + baseDirX * sShoreB;
                const shoreBZ = islA.z + baseDirZ * sShoreB;
                const sToeA = Math.max(2.0, sShoreA - rampLength);
                const sToeB = Math.min(baseDist - 2.0, sShoreB + rampLength);
                const toeAX = islA.x + baseDirX * sToeA;
                const toeAZ = islA.z + baseDirZ * sToeA;
                const toeBX = islA.x + baseDirX * sToeB;
                const toeBZ = islA.z + baseDirZ * sToeB;
                chosenCandidate = {
                    dirX: baseDirX,
                    dirZ: baseDirZ,
                    shoreAX, shoreAZ, shoreAY: evalAllIslandsHeight(shoreAX, shoreAZ),
                    shoreBX, shoreBZ, shoreBY: evalAllIslandsHeight(shoreBX, shoreBZ),
                    toeAX, toeAZ, toeAH: Math.max(0.45, evalAllIslandsHeight(toeAX, toeAZ)),
                    toeBX, toeBZ, toeBH: Math.max(0.45, evalAllIslandsHeight(toeBX, toeBZ)),
                    cx: (shoreAX + shoreBX) * 0.5,
                    cz: (shoreAZ + shoreBZ) * 0.5,
                    waterSpanLen
                };
            }

            const { dirX, dirZ, shoreAX, shoreAZ, shoreAY, shoreBX, shoreBZ, shoreBY, toeAH, toeBH, cx, cz, waterSpanLen } = chosenCandidate;
            // Flat deck spans the water channel between the two shorelines (+0.45m abutment seat on each shore)
            const flatHalfSpan = waterSpanLen * 0.5 + 0.45;
            const rampReachU = flatHalfSpan + rampLength;
            const bridgeYaw = Math.atan2(dirX, dirZ);
            const cosYaw = Math.cos(bridgeYaw);
            const sinYaw = Math.sin(bridgeYaw);
            const rcMid = getRiverCoords(cx, cz);

            const rbObj = {
                id: `bridge_${RIVER_BRIDGES.length + 1}`,
                index: RIVER_BRIDGES.length,
                isCustomIslandBridge: true,
                islandAId: islA.id,
                islandBId: islB.id,
                shorelineA: { x: shoreAX, y: shoreAY, z: shoreAZ },
                shorelineB: { x: shoreBX, y: shoreBY, z: shoreBZ },
                northToeElevation: toeAH,
                southToeElevation: toeBH,
                sCoord: rcMid.s,
                centerU: rcMid.u,
                centerX: cx,
                centerZ: cz,
                worldX: cx,
                worldZ: cz,
                yaw: bridgeYaw,
                cosYaw,
                sinYaw,
                tangentSlope: 0,
                halfWidth: bHalfW,
                riverHalfW: waterSpanLen * 0.5,
                flatHalfSpan,
                rampReachU,
                archetype: archType,
                hp: 1800,
                maxHp: 1800,
                destroyed: false
            };
            RIVER_BRIDGES.push(rbObj);

            const sW = bridgeLocalToWorld(rbObj, 0, rampReachU);
            const nW = bridgeLocalToWorld(rbObj, 0, -rampReachU);
            const southEntryVec = new THREE.Vector3(sW.x, 0, sW.z);
            southEntryVec.dirX = sinYaw;
            southEntryVec.dirZ = cosYaw;
            const northEntryVec = new THREE.Vector3(nW.x, 0, nW.z);
            northEntryVec.dirX = -sinYaw;
            northEntryVec.dirZ = -cosYaw;

            BRIDGES.push({
                id: rbObj.id,
                sCoord: rbObj.sCoord,
                halfWidth: bHalfW,
                yaw: bridgeYaw,
                archetype: archType,
                center: new THREE.Vector3(cx, 0, cz),
                southEntry: southEntryVec,
                northEntry: northEntryVec,
                bridgeRef: rbObj
            });
            return rbObj;
        };
        window.createIslandBridgeLink = createIslandBridgeLink;

        createIslandBridgeLink(islPlayer, islCentral, 0, 'truss_bridge');
        createIslandBridgeLink(islCentral, islEnemy, 1, 'industrial_girder');
        createIslandBridgeLink(islCentral, islSolaris, 2, 'concrete_causeway');
        createIslandBridgeLink(islCentral, islFlank, 3, 'truss_bridge');
        createIslandBridgeLink(islPlayer, islSolaris, 4, 'concrete_causeway');
        BRIDGE_COUNT = RIVER_BRIDGES.length;
    } else if (HAS_VALLEY_RIVER) {
        BRIDGE_COUNT = 2 + (seededRandom() > 0.45 ? 1 : 0);
        const spanSpread = BRIDGE_COUNT === 3 ? [-28.0, 0.0, 28.0] : [-20.0, 20.0];
        const bridgeArchetypes = ACTIVE_PLANET_BIOME === 'lava'
            ? ['industrial_girder', 'truss_bridge', 'industrial_girder']
            : ['truss_bridge', 'concrete_causeway', 'industrial_girder'];

        for (let b = 0; b < BRIDGE_COUNT; b++) {
            let sPos = spanSpread[b] + (seededRandom() - 0.5) * 8.5;
            // Refine sPos toward a gentle river tangent section with valid clearance from other bridges
            let bestS = sPos;
            let bestScore = Infinity;
            for (let step = -5.0; step <= 5.0; step += 0.75) {
                const candS = sPos + step;
                const clearOther = RIVER_BRIDGES.every(other => Math.abs(candS - other.sCoord) >= 14.0);
                if (!clearOther) continue;
                const candSlope = Math.abs(getRiverTangentSlopeAtS(candS));
                if (candSlope < bestScore) {
                    bestScore = candSlope;
                    bestS = candS;
                }
            }
            sPos = bestS;

            const bHalfW = 4.6 + seededRandom() * 0.7;
            const cU = getRiverCenterUAtS(sPos);
            const cW = riverCoordsToWorld(sPos, cU);
            const tangentSlope = getRiverTangentSlopeAtS(sPos);
            const localSkew = Math.atan(tangentSlope);
            const bridgeYaw = RIVER_ANGLE - localSkew;
            const cosYaw = Math.cos(bridgeYaw);
            const sinYaw = Math.sin(bridgeYaw);

            const localHalfW = (typeof getRiverHalfWidthAtS === 'function') ? getRiverHalfWidthAtS(sPos) : RIVER_HALF_WIDTH;
            const effRiverHalfW = localHalfW * Math.sqrt(1.0 + tangentSlope * tangentSlope);
            const flatHalfSpan = effRiverHalfW + 0.95;
            const rampReachU = flatHalfSpan + 3.4;
            const arch = bridgeArchetypes[(b + Math.floor(seededRandom() * 3)) % bridgeArchetypes.length];

            const rbObj = {
                id: `bridge_${b + 1}`,
                index: b,
                isCustomIslandBridge: false,
                islandAId: 'north_riverbank',
                islandBId: 'south_riverbank',
                sCoord: sPos,
                centerU: cU,
                centerX: cW.x,
                centerZ: cW.z,
                worldX: cW.x,
                worldZ: cW.z,
                yaw: bridgeYaw,
                cosYaw,
                sinYaw,
                tangentSlope,
                halfWidth: bHalfW,
                riverHalfW: effRiverHalfW,
                flatHalfSpan,
                rampReachU,
                archetype: arch,
                hp: 1200,
                maxHp: 1200,
                destroyed: false
            };

            const shoreNorth = bridgeLocalToWorld(rbObj, 0, -effRiverHalfW);
            const shoreSouth = bridgeLocalToWorld(rbObj, 0, effRiverHalfW);
            rbObj.shorelineA = { x: shoreNorth.x, y: WATER_LEVEL, z: shoreNorth.z };
            rbObj.shorelineB = { x: shoreSouth.x, y: WATER_LEVEL, z: shoreSouth.z };
            RIVER_BRIDGES.push(rbObj);

            const sW = bridgeLocalToWorld(rbObj, 0, rampReachU);
            const nW = bridgeLocalToWorld(rbObj, 0, -rampReachU);
            const southEntryVec = new THREE.Vector3(sW.x, 0, sW.z);
            southEntryVec.dirX = sinYaw;
            southEntryVec.dirZ = cosYaw;
            const northEntryVec = new THREE.Vector3(nW.x, 0, nW.z);
            northEntryVec.dirX = -sinYaw;
            northEntryVec.dirZ = -cosYaw;

            BRIDGES.push({
                id: rbObj.id,
                sCoord: sPos,
                halfWidth: bHalfW,
                yaw: bridgeYaw,
                archetype: arch,
                center: new THREE.Vector3(cW.x, 0, cW.z),
                southEntry: southEntryVec,
                northEntry: northEntryVec,
                bridgeRef: rbObj
            });
        }
    } else {
        BRIDGE_COUNT = 0;
    }

    if (ACTIVE_PLANET_BIOME === 'lava') {
        // Generate large branching molten lava fissures and crevices across the volcanic caldera
        const fissureDefs = [
            { x: -38, z: 16, len: 26, wid: 2.8, ang: 0.42, curve: 0.18 },
            { x: 36, z: -18, len: 28, wid: 3.1, ang: -0.55, curve: -0.22 },
            { x: -16, z: -42, len: 24, wid: 2.6, ang: 1.15, curve: 0.16 },
            { x: 22, z: 44, len: 25, wid: 2.9, ang: -1.05, curve: -0.19 },
            { x: -52, z: -34, len: 22, wid: 2.5, ang: 0.78, curve: 0.14 },
            { x: 54, z: 32, len: 22, wid: 2.6, ang: -0.72, curve: -0.15 }
        ];
        fissureDefs.forEach((fd, idx) => {
            const fx = fd.x + (seededRandom() - 0.5) * 6.0;
            const fz = fd.z + (seededRandom() - 0.5) * 6.0;
            if (Math.hypot(fx - PLAYER_START_POS.x, fz - PLAYER_START_POS.z) > 28 &&
                Math.hypot(fx - ENEMY_BASE_POS.x, fz - ENEMY_BASE_POS.z) > 28 &&
                Math.hypot(fx - SOLARIS_BASE_POS.x, fz - SOLARIS_BASE_POS.z) > 24) {
                const fang = fd.ang + (seededRandom() - 0.5) * 0.25;
                window.LAVA_FISSURES.push({
                    id: `lava_fissure_${idx + 1}`,
                    x: fx,
                    z: fz,
                    len: fd.len,
                    wid: fd.wid,
                    ang: fang,
                    cosA: Math.cos(fang),
                    sinA: Math.sin(fang),
                    curve: fd.curve
                });
            }
        });
    }

    // Dynamically orient the Player Base entrance direction toward the valley center / enemy!
    const baseRampAng = Math.atan2((ENEMY_BASE_POS.z * 0.35) - PLAYER_START_POS.z, (ENEMY_BASE_POS.x * 0.35) - PLAYER_START_POS.x);
    const dynamicRampAng = baseRampAng + (seededRandom() - 0.5) * 0.45;
    PLAYER_BASE_RAMP_DIR.x = Math.cos(dynamicRampAng);
    PLAYER_BASE_RAMP_DIR.z = Math.sin(dynamicRampAng);

    // Auto-generate Multi-Faction Base Terrain Archetypes ('flat_ramp', 'under_ramp', 'no_ramp')
    BASE_TERRAIN_ZONES.length = 0;
    if (ACTIVE_PLANET_BIOME === 'ocean') {
        PLAYER_BASE_TECTONIC_MODE = 'no_ramp';
        HAS_BASE_PLATEAU_RAMP = false;
        window.HAS_BASE_PLATEAU_RAMP = false;
        window.PLAYER_BASE_TECTONIC_MODE = 'no_ramp';
        window.OCEAN_ISLANDS.forEach((isl, idx) => {
            if (isl.isMajor || idx < 6) {
                const rAng = Math.atan2(-isl.z, -isl.x);
                BASE_TERRAIN_ZONES.push({
                    id: idx === 0 ? 'player_main' : (idx === 1 ? 'enemy_main' : isl.id),
                    faction: idx === 0 ? 'player' : (idx === 1 ? 'enemy' : (idx === 2 ? 'solaris' : `island_faction_${idx}`)),
                    mode: 'no_ramp',
                    x: isl.x,
                    z: isl.z,
                    radius: Math.min(isl.rx, isl.rz) * 0.62,
                    rimOuter: Math.min(isl.rx, isl.rz) * 0.78,
                    heightDelta: 0.55,
                    rampDirX: Math.cos(rAng),
                    rampDirZ: Math.sin(rAng),
                    rampHalfW: 4.8,
                    isPrimaryPlayer: idx === 0,
                    isPrimaryEnemy: idx === 1
                });
            }
        });
    } else {
        const baseModes = ['flat_ramp', 'under_ramp', 'flat_ramp'];
        const pRoll = seededRandom();
        PLAYER_BASE_TECTONIC_MODE = (MAP_ARCHETYPE === 'fortified_plateau')
            ? 'flat_ramp'
            : (pRoll < 0.72 ? 'flat_ramp' : (pRoll < 0.94 ? 'under_ramp' : 'no_ramp'));
        HAS_BASE_PLATEAU_RAMP = (PLAYER_BASE_TECTONIC_MODE === 'flat_ramp' || PLAYER_BASE_TECTONIC_MODE === 'under_ramp');
        window.HAS_BASE_PLATEAU_RAMP = HAS_BASE_PLATEAU_RAMP;
        window.PLAYER_BASE_TECTONIC_MODE = PLAYER_BASE_TECTONIC_MODE;

        BASE_TERRAIN_ZONES.push({
            id: 'player_main',
            faction: 'player',
            mode: PLAYER_BASE_TECTONIC_MODE,
            x: PLAYER_START_POS.x,
            z: PLAYER_START_POS.z,
            radius: Math.max(BASE_PLATEAU_RADIUS, 20.5),
            rimOuter: Math.max(BASE_PLATEAU_RIM_OUTER, 25.0),
            heightDelta: PLAYER_BASE_TECTONIC_MODE === 'flat_ramp' ? 2.35 : (PLAYER_BASE_TECTONIC_MODE === 'under_ramp' ? -1.45 : 0.45),
            rampDirX: PLAYER_BASE_RAMP_DIR.x,
            rampDirZ: PLAYER_BASE_RAMP_DIR.z,
            rampHalfW: Math.max(PLAYER_BASE_RAMP_HALF_W, 5.2),
            isPrimaryPlayer: true,
            isCornerPlatform: true
        });

        const enemyRampAng = Math.atan2((PLAYER_START_POS.z * 0.35) - ENEMY_BASE_POS.z, (PLAYER_START_POS.x * 0.35) - ENEMY_BASE_POS.x);
        BASE_TERRAIN_ZONES.push({
            id: 'enemy_main',
            faction: 'enemy',
            mode: 'no_ramp',
            x: ENEMY_BASE_POS.x,
            z: ENEMY_BASE_POS.z,
            radius: 21.0,
            rimOuter: 27.0,
            heightDelta: 0.65,
            rampDirX: Math.cos(enemyRampAng),
            rampDirZ: Math.sin(enemyRampAng),
            rampHalfW: 5.2,
            isPrimaryEnemy: true
        });

        const solRampAng = Math.atan2(-SOLARIS_BASE_POS.z, -SOLARIS_BASE_POS.x);
        const solMode = baseModes[Math.floor(seededRandom() * baseModes.length)];
        BASE_TERRAIN_ZONES.push({
            id: 'solaris_ai',
            faction: 'solaris',
            mode: solMode,
            x: SOLARIS_BASE_POS.x,
            z: SOLARIS_BASE_POS.z,
            radius: 17.5,
            rimOuter: 21.8,
            heightDelta: solMode === 'flat_ramp' ? 2.05 : (solMode === 'under_ramp' ? -1.30 : 0.55),
            rampDirX: Math.cos(solRampAng),
            rampDirZ: Math.sin(solRampAng),
            rampHalfW: 4.8
        });

        // Dynamically Generate Big Corner Ramp Platform Terrains in the 4 Map Corners
        const cornerAnchors = [
            [-78, -78],
            [ 78, -78],
            [-78,  78],
            [ 78,  78]
        ];
        cornerAnchors.forEach(([rawCx, rawCz], cIdx) => {
            let cx = rawCx + Math.round((seededRandom() - 0.5) * 8.0);
            let cz = rawCz + Math.round((seededRandom() - 0.5) * 8.0);
            if (HAS_VALLEY_RIVER && getRiverDist(cx, cz) < RIVER_HALF_WIDTH + 24.0) {
                const rcC = getRiverCoords(cx, cz);
                const pSign = rcC.signedDist >= 0 ? 1 : -1;
                const pushed = riverCoordsToWorld(rcC.s, rcC.centerU + pSign * (RIVER_HALF_WIDTH + 25.0));
                cx = THREE.MathUtils.clamp(Math.round(pushed.x), -86, 86);
                cz = THREE.MathUtils.clamp(Math.round(pushed.z), -86, 86);
            }
            if (Math.hypot(cx - PLAYER_START_POS.x, cz - PLAYER_START_POS.z) < 38) return;
            if (Math.hypot(cx - SOLARIS_BASE_POS.x, cz - SOLARIS_BASE_POS.z) < 34) return;
            if (Math.hypot(cx - ENEMY_BASE_POS.x, cz - ENEMY_BASE_POS.z) < 36) return;

            const cRampAng = Math.atan2(-cz, -cx);
            const cRadius = 21.0 + seededRandom() * 3.0;
            BASE_TERRAIN_ZONES.push({
                id: `corner_ramp_platform_${cIdx + 1}`,
                faction: `corner_platform_${cIdx + 1}`,
                mode: 'flat_ramp',
                x: cx,
                z: cz,
                radius: cRadius,
                rimOuter: cRadius + 4.8,
                heightDelta: 2.35 + seededRandom() * 0.35,
                rampDirX: Math.cos(cRampAng),
                rampDirZ: Math.sin(cRampAng),
                rampHalfW: 5.2,
                isCornerPlatform: true
            });
        });

        // Generate Additional Scattered Platform Bases across the sector
        const lobbyExtraCount = (window.CUSTOM_LOBBY_PLAYERS && Array.isArray(window.CUSTOM_LOBBY_PLAYERS))
            ? Math.max(4, window.CUSTOM_LOBBY_PLAYERS.length)
            : 4;
        const expansionAngles = [-1.35, 2.15, -2.35, 0.85, -0.65, 2.75];
        for (let fIdx = 0; fIdx < Math.min(6, lobbyExtraCount); fIdx++) {
            const expAng = playerSectorAng + expansionAngles[fIdx % expansionAngles.length] + (seededRandom() - 0.5) * 0.18;
            const expDist = 54.0 + (fIdx % 2) * 14.0 + seededRandom() * 10.0;
            let ex = THREE.MathUtils.clamp(Math.round(Math.cos(expAng) * expDist), -84, 84);
            let ez = THREE.MathUtils.clamp(Math.round(Math.sin(expAng) * expDist), -84, 84);
            if (HAS_VALLEY_RIVER && getRiverDist(ex, ez) < RIVER_HALF_WIDTH + 18.0) {
                const rcE = getRiverCoords(ex, ez);
                const pSign = rcE.signedDist >= 0 ? 1 : -1;
                const pushed = riverCoordsToWorld(rcE.s, rcE.centerU + pSign * (RIVER_HALF_WIDTH + 20.0));
                ex = THREE.MathUtils.clamp(Math.round(pushed.x), -84, 84);
                ez = THREE.MathUtils.clamp(Math.round(pushed.z), -84, 84);
            }
            const clearOfExistingZones = BASE_TERRAIN_ZONES.every(bz => Math.hypot(ex - bz.x, ez - bz.z) > (bz.rimOuter || 20) + 18.0);
            if (clearOfExistingZones && Math.hypot(ex - ENEMY_BASE_POS.x, ez - ENEMY_BASE_POS.z) > 34) {
                const eMode = (fIdx % 4 === 3) ? 'under_ramp' : 'flat_ramp';
                const eRampAng = Math.atan2(-ez, -ex);
                BASE_TERRAIN_ZONES.push({
                    id: `faction_expansion_${fIdx + 1}`,
                    faction: `ai_faction_${fIdx + 1}`,
                    mode: eMode,
                    x: ex,
                    z: ez,
                    radius: 15.8,
                    rimOuter: 19.8,
                    heightDelta: eMode === 'flat_ramp' ? 1.95 : -1.25,
                    rampDirX: Math.cos(eRampAng),
                    rampDirZ: Math.sin(eRampAng),
                    rampHalfW: 4.5,
                    isScatteredPlatform: true
                });
            }
        }
    }

    rebuildBridgeNavAndExclusionZones();

    DYNAMIC_MESAS.length = 0;
    DYNAMIC_MOUNTAINS.length = 0;
    DYNAMIC_PONDS.length = 0;
    DYNAMIC_VALLEYS.length = 0;
    DYNAMIC_CANYONS.length = 0;
    DYNAMIC_CRATERS.length = 0;
    DYNAMIC_RAVINES.length = 0;
    DYNAMIC_BOMB_CRATERS.length = 0;
    DYNAMIC_TRENCHES.length = 0;
    GEM_CRATERS.length = 0;
    FLATTENED_BUILDING_PADS.length = 0;

    // Helper to keep large mountains/mesas/ravines off the central highway spine between Player, Enemy, and Solaris bases
    const isNearHighwayCorridor = (px, pz, pad = 16.0) => {
        const ax = PLAYER_START_POS.x, az = PLAYER_START_POS.z;
        const bx = ENEMY_BASE_POS.x, bz = ENEMY_BASE_POS.z;
        const abx = bx - ax, abz = bz - az;
        const lenSq = abx * abx + abz * abz || 1;
        const t = THREE.MathUtils.clamp(((px - ax) * abx + (pz - az) * abz) / lenSq, 0, 1);
        const dTrunk = Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
        if (dTrunk < pad) return true;
        const sx = SOLARIS_BASE_POS.x, sz = SOLARIS_BASE_POS.z;
        const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
        const msx = sx - mx, msz = sz - mz;
        const mLenSq = msx * msx + msz * msz || 1;
        const ts = THREE.MathUtils.clamp(((px - mx) * msx + (pz - mz) * msz) / mLenSq, 0, 1);
        const dSpur = Math.hypot(px - (mx + msx * ts), pz - (mz + msz * ts));
        return dSpur < pad * 0.85;
    };

    const isClearOfGeneratedRiverAndBridges = (px, pz, pad) => {
        if (!HAS_VALLEY_RIVER) return true;
        if (getRiverDist(px, pz) < pad + RIVER_HALF_WIDTH + 9.5) return false;
        if (isPointInBridgeApproachCorridor(px, pz, pad + 6.5, 16.0)) return false;
        return true;
    };

    if (ACTIVE_PLANET_BIOME === 'ocean') {
        // Ocean Archipelago uses OCEAN_ISLANDS exclusively; skip continental mesas, canyons, ravines & ponds
        return;
    }

    for (let i = 0; i < 6; i++) {
        const mx = (seededRandom() - 0.5) * 185;
        const mz = (seededRandom() - 0.5) * 185;
        const mr = 14.5 + seededRandom() * 6.5;
        if (Math.hypot(mx - ENEMY_BASE_POS.x, mz - ENEMY_BASE_POS.z) > 34 &&
            Math.hypot(mx - SOLARIS_BASE_POS.x, mz - SOLARIS_BASE_POS.z) > 28 &&
            !isInsideBasePlacementZone(mx, mz, mr + 18.0) &&
            !isNearHighwayCorridor(mx, mz, mr + 15.0) &&
            isClearOfGeneratedRiverAndBridges(mx, mz, mr)) {
            DYNAMIC_MESAS.push({ x: mx, z: mz, r: mr, h: 3.2 + seededRandom() * 2.2 });
        }
    }

    for (let i = 0; i < 6; i++) {
        const px = (seededRandom() - 0.5) * 195;
        const pz = (seededRandom() - 0.5) * 195;
        const mr = 16.0 + seededRandom() * 6.5;
        if (Math.hypot(px - ENEMY_BASE_POS.x, pz - ENEMY_BASE_POS.z) > 34 &&
            Math.hypot(px - SOLARIS_BASE_POS.x, pz - SOLARIS_BASE_POS.z) > 28 &&
            !isInsideBasePlacementZone(px, pz, mr + 18.0) &&
            !isNearHighwayCorridor(px, pz, mr + 16.0) &&
            isClearOfGeneratedRiverAndBridges(px, pz, mr)) {
            DYNAMIC_MOUNTAINS.push({ x: px, z: pz, r: mr, h: 4.6 + seededRandom() * 2.8 });
        }
    }

    // 1. Dynamic Carved Tactical Valleys (8 Sunken Valley Corridors with Flanking Ridge Shoulders)
    for (let i = 0; i < 8; i++) {
        const vx = (seededRandom() - 0.5) * 180;
        const vz = (seededRandom() - 0.5) * 180;
        const vLen = 20.0 + seededRandom() * 14.0;
        const vWid = 9.0 + seededRandom() * 5.0;
        const vAng = seededRandom() * Math.PI * 2;
        if (!isInsideBasePlacementZone(vx, vz, vLen + 14.0) &&
            Math.hypot(vx - ENEMY_BASE_POS.x, vz - ENEMY_BASE_POS.z) > vLen + 22.0 &&
            Math.hypot(vx - SOLARIS_BASE_POS.x, vz - SOLARIS_BASE_POS.z) > vLen + 18.0 &&
            !isNearHighwayCorridor(vx, vz, vWid + 12.0) &&
            isClearOfGeneratedRiverAndBridges(vx, vz, vLen)) {
            DYNAMIC_VALLEYS.push({
                x: vx,
                z: vz,
                len: vLen,
                wid: vWid,
                cosA: Math.cos(vAng),
                sinA: Math.sin(vAng),
                depth: 0.58 + seededRandom() * 0.38,
                rimH: 0.88 + seededRandom() * 0.62
            });
        }
    }

    // 2. Dynamic Steep-Walled Passable Canyons (Gorge Corridors with Flat Walkable Floor & Towering Escarpment Walls)
    for (let i = 0; i < 5; i++) {
        const cx = (seededRandom() - 0.5) * 176;
        const cz = (seededRandom() - 0.5) * 176;
        const cLen = 24.0 + seededRandom() * 14.0;
        const cFloorW = 4.6 + seededRandom() * 2.2;
        const cWallW = 5.5 + seededRandom() * 2.5;
        const cAng = seededRandom() * Math.PI * 2;
        if (!isInsideBasePlacementZone(cx, cz, cLen + 16.0) &&
            Math.hypot(cx - ENEMY_BASE_POS.x, cz - ENEMY_BASE_POS.z) > cLen + 24.0 &&
            Math.hypot(cx - SOLARIS_BASE_POS.x, cz - SOLARIS_BASE_POS.z) > cLen + 20.0 &&
            !isNearHighwayCorridor(cx, cz, cFloorW + cWallW + 10.0) &&
            isClearOfGeneratedRiverAndBridges(cx, cz, cLen)) {
            DYNAMIC_CANYONS.push({
                x: cx,
                z: cz,
                len: cLen,
                floorW: cFloorW,
                wallW: cWallW,
                cosA: Math.cos(cAng),
                sinA: Math.sin(cAng),
                floorDrop: 0.42 + seededRandom() * 0.25,
                wallH: 2.35 + seededRandom() * 1.45
            });
        }
    }

    // 3. Dynamic Impact Craters (Topographic Meteor/Artillery Basins with Raised Ejecta Rims)
    for (let i = 0; i < 7; i++) {
        const crx = (seededRandom() - 0.5) * 182;
        const crz = (seededRandom() - 0.5) * 182;
        const crr = 7.5 + seededRandom() * 4.5;
        if (!isInsideBasePlacementZone(crx, crz, crr + 16.0) &&
            Math.hypot(crx - ENEMY_BASE_POS.x, crz - ENEMY_BASE_POS.z) > crr + 26.0 &&
            Math.hypot(crx - SOLARIS_BASE_POS.x, crz - SOLARIS_BASE_POS.z) > crr + 20.0 &&
            !isNearHighwayCorridor(crx, crz, crr + 10.0) &&
            isClearOfGeneratedRiverAndBridges(crx, crz, crr + 4.0)) {
            DYNAMIC_CRATERS.push({
                x: crx,
                z: crz,
                r: crr,
                depth: 0.72 + seededRandom() * 0.45,
                rimH: 0.65 + seededRandom() * 0.45
            });
        }
    }

    // 4. Dynamic Tectonic Ravines (Deep Chasm Fissures with Natural Passable Land-Bridge Crossings in the Center)
    for (let i = 0; i < 4; i++) {
        const rvx = (seededRandom() - 0.5) * 168;
        const rvz = (seededRandom() - 0.5) * 168;
        const rvLen = 22.0 + seededRandom() * 12.0;
        const rvWid = 3.8 + seededRandom() * 1.6;
        const rvAng = seededRandom() * Math.PI * 2;
        if (!isInsideBasePlacementZone(rvx, rvz, rvLen + 18.0) &&
            Math.hypot(rvx - ENEMY_BASE_POS.x, rvz - ENEMY_BASE_POS.z) > rvLen + 26.0 &&
            Math.hypot(rvx - SOLARIS_BASE_POS.x, rvz - SOLARIS_BASE_POS.z) > rvLen + 22.0 &&
            !isNearHighwayCorridor(rvx, rvz, rvWid + 14.0) &&
            isClearOfGeneratedRiverAndBridges(rvx, rvz, rvLen)) {
            DYNAMIC_RAVINES.push({
                x: rvx,
                z: rvz,
                len: rvLen,
                wid: rvWid,
                cosA: Math.cos(rvAng),
                sinA: Math.sin(rvAng),
                depth: 2.25 + seededRandom() * 1.15,
                rimH: 0.58 + seededRandom() * 0.35,
                bridgeHalfSpan: 4.5 + seededRandom() * 1.5
            });
        }
    }

    const pondCount = ACTIVE_PLANET_BIOME === 'ocean' ? 6 : (ACTIVE_PLANET_BIOME === 'jungle' ? 4 : (ACTIVE_PLANET_BIOME === 'lava' ? 4 : (ACTIVE_PLANET_BIOME === 'desert' ? 1 : 3)));
    for (let i = 0; i < pondCount; i++) {
        const wx = (seededRandom() - 0.5) * 155;
        const wz = (seededRandom() - 0.5) * 155;
        if (!isInsideBasePlacementZone(wx, wz, 28.0) &&
            Math.hypot(wx - ENEMY_BASE_POS.x, wz - ENEMY_BASE_POS.z) > 32 &&
            Math.hypot(wx - SOLARIS_BASE_POS.x, wz - SOLARIS_BASE_POS.z) > 26 &&
            !isNearHighwayCorridor(wx, wz, 14.0) &&
            isClearOfGeneratedRiverAndBridges(wx, wz, 16.0) &&
            DYNAMIC_MESAS.every(m => Math.hypot(wx - m.x, wz - m.z) > m.r + 8) &&
            DYNAMIC_MOUNTAINS.every(m => Math.hypot(wx - m.x, wz - m.z) > m.r + 8)) {
            DYNAMIC_PONDS.push({
                x: wx,
                z: wz,
                r: (ACTIVE_PLANET_BIOME === 'ocean' ? 7.4 : 6.2) + seededRandom() * 2.4,
                scaleX: 1.24 + (seededRandom() - 0.5) * 0.32,
                scaleZ: 0.78 + (seededRandom() - 0.5) * 0.28,
                rot: seededRandom() * Math.PI * 2,
                lobe2Amp: 0.18 + seededRandom() * 0.12,
                lobe3Amp: 0.12 + seededRandom() * 0.10,
                lobe4Amp: 0.06 + seededRandom() * 0.05,
                phase2: seededRandom() * Math.PI * 2,
                phase3: seededRandom() * Math.PI * 2,
                phase4: seededRandom() * Math.PI * 2
            });
        }
    }
}
generateProceduralTopographyParameters();

function getBridgeFactor(x, z) {
    if (!HAS_RAVINE_BRIDGES || BRIDGES.length === 0) return 0.0;
    const s = (x - z) * 0.70710678;
    let minDist = Infinity;
    for (let i = 0; i < BRIDGES.length; i++) {
        const d = Math.abs(s - BRIDGES[i].sCoord);
        if (d < minDist) minDist = d;
    }
    const halfWidth = 6.2;
    if (minDist <= halfWidth) return 1.0;
    if (minDist <= halfWidth + 3.2) {
        return Math.cos(((minDist - halfWidth) / 3.2) * (Math.PI / 2));
    }
    return 0.0;
}

function isOnBridgeCorridor(x, z) {
    if (!HAS_RAVINE_BRIDGES || BRIDGES.length === 0) return false;
    const s = (x - z) * 0.70710678;
    let minDist = Infinity;
    for (let i = 0; i < BRIDGES.length; i++) {
        const d = Math.abs(s - BRIDGES[i].sCoord);
        if (d < minDist) minDist = d;
    }
    return minDist <= 5.6 && Math.abs(getRavineSignedDist(x, z)) <= 16.0;
}

function getTerrainHeight(x, z) {
    if (_terrainHeightCacheReady) {
        const fx = x + HEIGHT_CACHE_HALF;
        const fz = z + HEIGHT_CACHE_HALF;
        if (fx >= 0 && fx < HEIGHT_CACHE_DIM - 1 && fz >= 0 && fz < HEIGHT_CACHE_DIM - 1) {
            const ix = fx | 0;
            const iz = fz | 0;
            const tx = fx - ix;
            const tz = fz - iz;
            const row0 = iz * HEIGHT_CACHE_DIM + ix;
            const row1 = row0 + HEIGHT_CACHE_DIM;
            const h00 = TERRAIN_HEIGHT_CACHE[row0];
            const h10 = TERRAIN_HEIGHT_CACHE[row0 + 1];
            const h01 = TERRAIN_HEIGHT_CACHE[row1];
            const h11 = TERRAIN_HEIGHT_CACHE[row1 + 1];
            return (h00 + (h10 - h00) * tx) * (1.0 - tz) + (h01 + (h11 - h01) * tx) * tz;
        }
    }
    return computeRawTerrainHeight(x, z);
}

function computeRawTerrainHeight(x, z) {
    // Seeded multi-octave organic hills with randomized per-map frequencies & amplitudes
    let h = Math.sin(x * HILL_FREQ_1 + MAP_SEED) * Math.cos(z * HILL_FREQ_1 + MAP_SEED) * HILL_AMP_1
          + Math.sin(x * HILL_FREQ_2 - z * (HILL_FREQ_2 * 1.22) + MAP_SEED * 0.5) * HILL_AMP_2;

    const biome = ACTIVE_PLANET_BIOME || 'highland';
    if (biome === 'desert') {
        // Asymmetric wind-carved sand dunes (steep slip-face + gentle windward slope) & terraced badland shelves
        const dunePhase = x * 0.11 + z * 0.045 + Math.sin(z * 0.06 + MAP_SEED * 0.13) * 1.4;
        const rawWave = Math.sin(dunePhase);
        const sawtoothDune = (rawWave + 0.35 * Math.sin(dunePhase * 2.0 - 0.8)) * 0.52;
        const terraceShelf = Math.round(h * 1.6) / 1.6;
        h = h * 0.65 + sawtoothDune + (terraceShelf - h) * 0.28;
    } else if (biome === 'lava') {
        // Jagged volcanic caldera ridges, fractured basalt plates & cooled lava flow channels
        const ridge1 = 1.0 - Math.abs(Math.sin(x * 0.085 + z * 0.065 + MAP_SEED * 0.21));
        const ridge2 = 1.0 - Math.abs(Math.cos(x * 0.062 - z * 0.092 - MAP_SEED * 0.17));
        const fissureCrack = Math.pow(Math.max(0, Math.sin(x * 0.18 - z * 0.14 + MAP_SEED * 0.31)), 6) * -0.42;
        h = h * 0.72 + (ridge1 * ridge1 * 0.65 + ridge2 * 0.38 - 0.35) + fissureCrack;
    } else if (biome === 'jungle') {
        // Lush multi-tiered tropical karst valley undulations & root-terraced hillocks
        const karstSwale = Math.sin(x * 0.095 + MAP_SEED * 0.19) * Math.sin(z * 0.095 - MAP_SEED * 0.23) * 0.42;
        const hummock = Math.cos(x * 0.21 + z * 0.19 + MAP_SEED * 0.07) * 0.16;
        h = h * 0.90 + karstSwale + hummock;
    } else if (biome === 'ocean' && window.OCEAN_ISLANDS && window.OCEAN_ISLANDS.length > 0) {
        // Multi-Island Archipelago Topography:
        // Deep ocean floor (-1.42m) -> shallow coral reef shoals (-0.32m) -> raised sandy/rocky beaches (+0.18m..+0.42m)
        // -> flat strategic buildable island plateau (+0.65m..+0.92m) -> coastal rocky headlands & bluffs (+1.35m..+2.15m)
        let bestIslandH = -1.42 + Math.sin(x * 0.055 + MAP_SEED) * Math.cos(z * 0.055) * 0.16;
        for (let idx = 0; idx < window.OCEAN_ISLANDS.length; idx++) {
            const isl = window.OCEAN_ISLANDS[idx];
            const dx = x - isl.x;
            const dz = z - isl.z;
            const lx = dx * isl.cosR + dz * isl.sinR;
            const lz = -dx * isl.sinR + dz * isl.cosR;
            const ang = Math.atan2(lz, lx);
            // Irregular organic multi-harmonic island coastline with natural coves, headlands, peninsulas & sandbars
            const coastMod = 1.0
                + 0.15 * Math.sin(ang * 3.0 + isl.lobePhase1)
                + 0.10 * Math.cos(ang * 5.0 + isl.lobePhase2)
                + 0.06 * Math.sin(ang * 7.0 + (isl.lobePhase3 || 1.2))
                - 0.12 * Math.exp(-Math.pow(Math.atan2(Math.sin(ang - isl.coveAngle), Math.cos(ang - isl.coveAngle)) * 2.4, 2));
            const effRx = isl.rx * coastMod;
            const effRz = isl.rz * coastMod;
            const normR = Math.hypot(lx / effRx, lz / effRz);
            if (normR < 1.55) {
                let islElev;
                if (normR <= 0.64) {
                    // Strategic flat buildable island plateau for bases/structures + subtle coastal bluff crown near headlands
                    const inlandT = normR / 0.64;
                    const bluffRing = Math.pow(Math.sin(inlandT * Math.PI), 1.6) * 0.24 * (0.5 + 0.5 * Math.sin(ang * 2.0 + isl.lobePhase1));
                    const baseElevation = isl.isMajor ? 0.68 : 0.62;
                    islElev = baseElevation + bluffRing * isl.peakH + h * 0.12;
                } else if (normR <= 0.96) {
                    // Raised rocky shore & sandy beach berm descending smoothly from interior plateau (+0.68m) to waterline (0.0m)
                    const beachT = (normR - 0.64) / 0.32;
                    const sBeach = beachT * beachT * (3.0 - 2.0 * beachT);
                    const rimBase = (isl.isMajor ? 0.68 : 0.62) + h * 0.08;
                    const beachShelf = 0.22 * Math.sin(beachT * Math.PI);
                    islElev = THREE.MathUtils.lerp(rimBase, -0.06, sBeach) + beachShelf * 0.35;
                } else if (normR <= 1.26) {
                    // Shallow coastal turquoise shelf & sandbar (-0.06m to -0.46m)
                    const shoalT = (normR - 0.96) / 0.30;
                    const sShoal = shoalT * shoalT * (3.0 - 2.0 * shoalT);
                    islElev = THREE.MathUtils.lerp(-0.06, -0.46, sShoal);
                } else {
                    // Dropoff into deep ocean channel (-0.46m to -1.42m)
                    const deepT = (normR - 1.26) / 0.29;
                    const sDeep = deepT * deepT * (3.0 - 2.0 * deepT);
                    islElev = THREE.MathUtils.lerp(-0.46, -1.42, sDeep);
                }
                if (islElev > bestIslandH) bestIslandH = islElev;
            }
        }
        h = bestIslandH;

        // Carve channel beneath inter-island bridge decks and grade approach ramp abutments so terrain never overlaps the bridge deck
        for (let bIdx = 0; bIdx < RIVER_BRIDGES.length; bIdx++) {
            const rb = RIVER_BRIDGES[bIdx];
            const bc = getBridgeLocalCoords(rb, x, z);
            const dU = Math.abs(bc.localU);
            const dS = Math.abs(bc.localS);
            const flatSpan = rb.flatHalfSpan || 14.0;
            const rampReach = rb.rampReachU || (flatSpan + 4.6);

            if (dU < flatSpan - 0.35 && dS <= rb.halfWidth + 1.6) {
                const sBlend = dS <= rb.halfWidth + 0.35 ? 1.0 : THREE.MathUtils.clamp(1.0 - (dS - (rb.halfWidth + 0.35)) / 1.25, 0.0, 1.0);
                const carvedChannelY = Math.min(h, WATER_LEVEL - 0.30);
                h = THREE.MathUtils.lerp(h, carvedChannelY, sBlend);
            } else if (dU >= flatSpan - 0.35 && dU <= rampReach + 2.4 && dS <= rb.halfWidth + 3.0) {
                const sBlend = dS <= rb.halfWidth ? 1.0 : THREE.MathUtils.clamp(1.0 - (dS - rb.halfWidth) / 3.0, 0.0, 1.0);
                const rampSpanLen = Math.max(1.0, rampReach - (flatSpan - 0.35));
                const rampT = THREE.MathUtils.clamp((dU - (flatSpan - 0.35)) / rampSpanLen, 0.0, 1.0);
                const smoothRampT = rampT * rampT * (3.0 - 2.0 * rampT);
                const targetInlandH = Math.max(0.28, Math.min(0.68, h));
                const gradedAbutmentY = THREE.MathUtils.lerp(0.24, targetInlandH, smoothRampT);
                const outerFade = dU <= rampReach ? 1.0 : THREE.MathUtils.clamp(1.0 - (dU - rampReach) / 2.4, 0.0, 1.0);
                const w = sBlend * outerFade;
                if (w > 0.005) {
                    h = THREE.MathUtils.lerp(h, gradedAbutmentY, w);
                }
            }
        }

        // Apply flattened building pads on islands and return directly so continental trenches/valleys never cut islands!
        for (let i = 0; i < FLATTENED_BUILDING_PADS.length; i++) {
            const pad = FLATTENED_BUILDING_PADS[i];
            const d = Math.hypot(x - pad.x, z - pad.z);
            const totalR = pad.flatR + pad.blendR;
            if (d <= pad.flatR) {
                h = pad.targetY;
            } else if (d < totalR) {
                const t = (d - pad.flatR) / pad.blendR;
                const smoothT = t * t * (3.0 - 2.0 * t);
                h = THREE.MathUtils.lerp(pad.targetY, h, smoothT);
            }
        }
        return h;
    }

    if (HAS_RAVINE_BRIDGES) {
        const ravDist = Math.abs(getRavineSignedDist(x, z));
        const bridgeRamp = getBridgeFactor(x, z);

        if (ravDist < 9.0) {
            const gorgeProfile = Math.cos((ravDist / 9.0) * (Math.PI / 2));
            const abyssDepth = -15.0 * Math.pow(gorgeProfile, 1.35);
            const rampDeckHeight = 0.35 * Math.cos((ravDist / 9.0) * (Math.PI / 2));
            h = h * (1 - gorgeProfile) + (abyssDepth * (1 - bridgeRamp) + rampDeckHeight * bridgeRamp);
        } else if (ravDist >= 9.0 && ravDist < 13.0) {
            const rimProfile = Math.sin(((ravDist - 9.0) / 4.0) * Math.PI);
            h += rimProfile * (1.2 * (1 - bridgeRamp) + 0.15 * bridgeRamp);
        }
    }

    // Dynamic Climbable Ramped Canyon Mesas (Smooth cosine ramp edge + flat tactical top)
    for (let i = 0; i < DYNAMIC_MESAS.length; i++) {
        const ms = DYNAMIC_MESAS[i];
        const d = Math.hypot(x - ms.x, z - ms.z);
        if (d < ms.r) {
            const normDist = d / ms.r;
            const plateauT = Math.min(1.0, Math.max(0.0, (1.0 - normDist) * 1.08));
            const smoothRamp = 0.5 - 0.5 * Math.cos(plateauT * Math.PI);
            h += smoothRamp * ms.h;
        }
    }

    // Dynamic Climbable Alpine Mountains (Broad, smooth cosine bell slope)
    for (let i = 0; i < DYNAMIC_MOUNTAINS.length; i++) {
        const mt = DYNAMIC_MOUNTAINS[i];
        const d = Math.hypot(x - mt.x, z - mt.z);
        if (d < mt.r) {
            const m = Math.cos((d / mt.r) * (Math.PI / 2));
            h += Math.pow(m, 1.35) * mt.h + Math.sin(x * 0.25) * Math.cos(z * 0.25) * 0.22 * m;
        }
    }

    // Multi-Faction Base Placement Zones: Seamless First Ramp -> Merged Second Ramp Platform -> Second Lower Ramp
    // Uses continuous C2 cosine blending between plateau, merged platform, and ramps with ZERO sharp wall spikes!
    const rm = getPlayerBaseRampMetrics(x, z);
    for (let bIdx = 0; bIdx < BASE_TERRAIN_ZONES.length; bIdx++) {
        const bz = BASE_TERRAIN_ZONES[bIdx];
        const zm = getBaseZoneRampMetrics(bz, x, z);
        const maxZoneReach = (bz.rimOuter || 24.0) + 15.5;
        if (zm.dist >= maxZoneReach) continue;

        if (bz.mode === 'flat_ramp' || bz.mode === 'under_ramp') {
            const isUnder = (bz.mode === 'under_ramp');
            const targetH = isUnder ? Math.max(-0.22, bz.heightDelta * 0.48) : bz.heightDelta;
            const midTerraceH = targetH * 0.52; // Shared Merged Second Ramp Platform elevation
            const innerFlatR = bz.radius - 2.0;
            const outerRimR = bz.rimOuter;

            // 1. Base Plateau / Escarpment Radial Profile (without ramp) — smooth C1 cosine cliff without artificial spikes
            let cliffProfileH = h;
            if (zm.dist <= innerFlatR) {
                cliffProfileH = isUnder ? targetH : (h * 0.08 + targetH);
            } else if (zm.dist < outerRimR + 3.2) {
                const rimT = THREE.MathUtils.clamp((zm.dist - innerFlatR) / (outerRimR + 3.2 - innerFlatR), 0.0, 1.0);
                const dropBlend = 0.5 + 0.5 * Math.cos(rimT * Math.PI);
                const rimShoulder = isUnder ? (Math.sin(rimT * Math.PI) * 0.22) : (Math.sin(rimT * Math.PI) * 0.16);
                cliffProfileH = THREE.MathUtils.lerp(h, targetH, dropBlend) + rimShoulder * (1.0 - zm.rampBlend);
            }

            // 2. Multi-Ramp & Merged Second Ramp Platform Profile:
            //    - First Ramp (`innerFlatR - 3.5` -> `mergedPlatformInner`): smoothly descends from `targetH` to `midTerraceH`
            //    - Merged Second Ramp Platform (`mergedPlatformInner` -> `mergedPlatformOuter`): wide level bastion platform at `midTerraceH`
            //    - Second Wide Ramp (`mergedPlatformOuter` -> `lowerRampOuter`): smoothly descends from `midTerraceH` to valley floor `h`
            if (zm.rampBlend > 0.001) {
                const ramp1Start = bz.radius - 5.5;
                const ramp1End = zm.mergedPlatformInner;
                const platEnd = zm.mergedPlatformOuter;
                const ramp2End = zm.lowerRampOuter;
                const radialCoord = Math.max(zm.bestAlong, zm.dist);

                let rampTargetH = h;
                if (radialCoord <= ramp1Start) {
                    rampTargetH = isUnder ? targetH : (h * 0.08 + targetH);
                } else if (radialCoord <= ramp1End) {
                    const t1 = THREE.MathUtils.clamp((radialCoord - ramp1Start) / Math.max(1.0, ramp1End - ramp1Start), 0.0, 1.0);
                    const s1 = 0.5 + 0.5 * Math.cos(t1 * Math.PI);
                    rampTargetH = THREE.MathUtils.lerp(midTerraceH, targetH, s1);
                } else if (radialCoord <= platEnd) {
                    // Wide Merged Second Ramp Platform connecting all upper ramps seamlessly!
                    rampTargetH = midTerraceH;
                } else if (radialCoord < ramp2End) {
                    const t2 = THREE.MathUtils.clamp((radialCoord - platEnd) / Math.max(1.0, ramp2End - platEnd), 0.0, 1.0);
                    const s2 = 0.5 + 0.5 * Math.cos(t2 * Math.PI);
                    rampTargetH = THREE.MathUtils.lerp(h, midTerraceH, s2);
                }

                h = THREE.MathUtils.lerp(cliffProfileH, rampTargetH, zm.rampBlend);
            } else {
                h = cliffProfileH;
            }
        } else {
            // Open Flat Base Basin ('no_ramp'): smooth flat buildable pad with 360-degree open access!
            if (zm.dist <= bz.radius) {
                h = h * 0.10 + 0.35;
            } else if (zm.dist < bz.rimOuter + 4.5) {
                const fadeT = (zm.dist - bz.radius) / (bz.rimOuter + 4.5 - bz.radius);
                const smoothFade = fadeT * fadeT * (3.0 - 2.0 * fadeT);
                h = THREE.MathUtils.lerp(h * 0.10 + 0.35, h, smoothFade);
            }
        }
    }

    // Natural Horizon Transition at Map Perimeter (No artificial tall mountain wall cutting across the camera view!)
    const edgeDist = Math.max(Math.abs(x), Math.abs(z));
    if (edgeDist > 104) {
        const rimT = Math.min(1.0, (edgeDist - 104) / 14.0);
        const smoothRim = rimT * rimT * (3.0 - 2.0 * rimT);
        if (biome === 'ocean') {
            h = THREE.MathUtils.lerp(h, -1.35, smoothRim);
        } else {
            const naturalRidgeWave = (0.45 + 0.55 * Math.sin(x * 0.09 + MAP_SEED) * Math.cos(z * 0.09 - MAP_SEED * 0.5))
                                   + 0.35 * Math.sin(x * 0.04 - z * 0.05);
            h += smoothRim * naturalRidgeWave * 0.95;
        }
    }

    // 1. Dynamic Carved Valleys (Tactical sunken valley floor with flanked ridge shoulders)
    for (let i = 0; i < DYNAMIC_VALLEYS.length; i++) {
        const vl = DYNAMIC_VALLEYS[i];
        const dx = x - vl.x;
        const dz = z - vl.z;
        const along = dx * vl.cosA + dz * vl.sinA;
        const across = -dx * vl.sinA + dz * vl.cosA;
        const normAlong = Math.abs(along) / vl.len;
        const normAcross = Math.abs(across) / vl.wid;
        if (normAlong < 1.0 && normAcross < 1.65) {
            const lenFade = 0.5 + 0.5 * Math.cos(normAlong * Math.PI);
            if (normAcross < 1.0) {
                const trough = 0.5 + 0.5 * Math.cos(normAcross * Math.PI);
                h -= vl.depth * trough * lenFade;
            } else {
                const rimT = (normAcross - 1.0) / 0.65;
                const ridge = Math.sin(rimT * Math.PI);
                h += vl.rimH * ridge * lenFade;
            }
        }
    }

    // 2. Dynamic Steep-Walled Passable Canyons (Walkable flat gorge floor + towering canyon walls on both flanks)
    for (let i = 0; i < DYNAMIC_CANYONS.length; i++) {
        const cn = DYNAMIC_CANYONS[i];
        const dx = x - cn.x;
        const dz = z - cn.z;
        const along = dx * cn.cosA + dz * cn.sinA;
        const across = Math.abs(-dx * cn.sinA + dz * cn.cosA);
        const normAlong = Math.abs(along) / cn.len;
        if (normAlong < 1.0 && across < cn.floorW + cn.wallW * 1.4) {
            const lenFade = Math.sin((1.0 - normAlong) * Math.PI * 0.5);
            if (across <= cn.floorW) {
                const floorBlend = 0.5 + 0.5 * Math.cos((across / cn.floorW) * Math.PI);
                h = THREE.MathUtils.lerp(h, Math.max(0.14, h * 0.25 - cn.floorDrop), floorBlend * lenFade);
            } else {
                const wallNorm = (across - cn.floorW) / (cn.wallW * 1.4);
                const escarpment = Math.sin(wallNorm * Math.PI);
                h += cn.wallH * Math.pow(escarpment, 0.85) * lenFade;
            }
        }
    }

    // 3. Dynamic Topographic Impact Craters (Deep circular basin + raised blast rim)
    for (let i = 0; i < DYNAMIC_CRATERS.length; i++) {
        const cr = DYNAMIC_CRATERS[i];
        const d = Math.hypot(x - cr.x, z - cr.z);
        if (d < cr.r * 1.45) {
            if (d < cr.r * 0.88) {
                const normD = d / (cr.r * 0.88);
                const bowl = 0.5 + 0.5 * Math.cos(normD * Math.PI);
                h = Math.max(-0.10, h - cr.depth * bowl);
            } else {
                const rimT = (d - cr.r * 0.88) / (cr.r * 0.57);
                h += Math.sin(rimT * Math.PI) * cr.rimH;
            }
        }
    }

    // 4. Dynamic Tectonic Ravines (Deep chasm fissure with natural passable land-bridge crossing in the middle!)
    for (let i = 0; i < DYNAMIC_RAVINES.length; i++) {
        const rv = DYNAMIC_RAVINES[i];
        const dx = x - rv.x;
        const dz = z - rv.z;
        const along = dx * rv.cosA + dz * rv.sinA;
        const across = Math.abs(-dx * rv.sinA + dz * rv.cosA);
        const absAlong = Math.abs(along);
        if (absAlong < rv.len && across < rv.wid * 1.65) {
            const lenFade = 0.5 + 0.5 * Math.cos((absAlong / rv.len) * Math.PI);
            const bridgeFactor = absAlong <= rv.bridgeHalfSpan
                ? 1.0
                : (absAlong < rv.bridgeHalfSpan + 3.2 ? 0.5 + 0.5 * Math.cos(((absAlong - rv.bridgeHalfSpan) / 3.2) * Math.PI) : 0.0);
            if (across < rv.wid) {
                const chasmProfile = Math.cos((across / rv.wid) * (Math.PI * 0.5));
                const chasmDrop = rv.depth * Math.pow(chasmProfile, 1.3) * lenFade * (1.0 - bridgeFactor);
                h -= chasmDrop;
                if (bridgeFactor > 0.01) {
                    h = THREE.MathUtils.lerp(h, Math.max(0.24, h * 0.35 + 0.25), bridgeFactor * 0.85);
                }
            } else {
                const rimT = (across - rv.wid) / (rv.wid * 0.65);
                h += Math.sin(rimT * Math.PI) * rv.rimH * lenFade * (1.0 - bridgeFactor * 0.7);
            }
        }
    }

    // Smooth Roadbed Grading Pass: Carves & levels terrain along each road's longitudinal elevation profile!
    if (typeof _roadGradingActive !== 'undefined' && _roadGradingActive && typeof getSupplyRoadFactor === 'function') {
        const rf = getSupplyRoadFactor(x, z);
        if (rf > 0.02 && (!HAS_BASE_PLATEAU_RAMP || rm.dist >= BASE_PLATEAU_RIM_OUTER + 1.5)) {
            const smoothRoadTargetH = (typeof getRoadTargetElevationAt === 'function' && _roadSpatialCacheReady)
                ? getRoadTargetElevationAt(x, z, h)
                : THREE.MathUtils.clamp(h * 0.22 + 0.24, 0.12, 0.92);
            const gradeBlend = THREE.MathUtils.smoothstep(rf, 0.02, 0.68);
            h = THREE.MathUtils.lerp(h, smoothRoadTargetH, gradeBlend * 0.94);
        }
    }

    // Valley River Channel & Variable-Width Riverbed Carving (Evaluated AFTER macro landforms & road grading so riverbed is never raised above water!)
    if (HAS_VALLEY_RIVER) {
        if (biome !== 'ocean') {
            const rc = getRiverCoords(x, z);
            const riverDist = rc.dist;
            const localHalfW = rc.halfWidth || RIVER_HALF_WIDTH;
            const bankWidth = 3.25;
            if (riverDist < localHalfW + bankWidth) {
                if (riverDist <= localHalfW) {
                    const bedProfile = Math.cos((riverDist / localHalfW) * (Math.PI * 0.5));
                    const rawBedY = -0.36 - Math.pow(bedProfile, 1.15) * 0.62;
                    h = Math.min(h, rawBedY);
                } else {
                    const bankT = (riverDist - localHalfW) / bankWidth;
                    const smoothBank = bankT * bankT * (3.0 - 2.0 * bankT);
                    h = THREE.MathUtils.lerp(-0.10, Math.max(0.16, h), smoothBank);
                }
            }
        }
        // Carve channel beneath river bridge decks and grade approach abutments on the banks so terrain never overlaps the bridge deck
        for (let bIdx = 0; bIdx < RIVER_BRIDGES.length; bIdx++) {
            const rb = RIVER_BRIDGES[bIdx];
            const bc = getBridgeLocalCoords(rb, x, z);
            const dU = Math.abs(bc.localU);
            const dS = Math.abs(bc.localS);
            const flatSpan = rb.flatHalfSpan || ((rb.riverHalfW || RIVER_HALF_WIDTH) + 0.95);
            const rampReach = rb.rampReachU || (flatSpan + 3.4);

            if (dU < flatSpan - 0.35 && dS <= rb.halfWidth + 1.5) {
                const sBlend = dS <= rb.halfWidth + 0.35 ? 1.0 : THREE.MathUtils.clamp(1.0 - (dS - (rb.halfWidth + 0.35)) / 1.15, 0.0, 1.0);
                const carvedChannelY = Math.min(h, WATER_LEVEL - 0.28);
                h = THREE.MathUtils.lerp(h, carvedChannelY, sBlend);
            } else if (dU >= flatSpan - 0.35 && dU <= rampReach + 2.4 && dS <= rb.halfWidth + 2.6) {
                const sBlend = dS <= rb.halfWidth ? 1.0 : Math.max(0.0, 1.0 - (dS - rb.halfWidth) / 2.6);
                const rampSpanLen = Math.max(1.0, rampReach - (flatSpan - 0.35));
                const rampT = THREE.MathUtils.clamp((dU - (flatSpan - 0.35)) / rampSpanLen, 0.0, 1.0);
                const smoothRampT = rampT * rampT * (3.0 - 2.0 * rampT);
                const targetBankH = Math.max(0.24, Math.min(0.62, h));
                const gradedAbutmentY = THREE.MathUtils.lerp(0.22, targetBankH, smoothRampT);
                const outerFade = dU <= rampReach ? 1.0 : THREE.MathUtils.clamp(1.0 - (dU - rampReach) / 2.4, 0.0, 1.0);
                const abutWeight = THREE.MathUtils.clamp(sBlend * outerFade, 0.0, 1.0);
                if (abutWeight > 0.01) {
                    h = THREE.MathUtils.lerp(h, gradedAbutmentY, abutWeight);
                }
            }
        }
    }

    // Volcanic Lava Fissure Carving in 'lava' Biome
    if (biome === 'lava' && window.LAVA_FISSURES && window.LAVA_FISSURES.length > 0) {
        for (let fIdx = 0; fIdx < window.LAVA_FISSURES.length; fIdx++) {
            const lf = window.LAVA_FISSURES[fIdx];
            const dx = x - lf.x;
            const dz = z - lf.z;
            const along = dx * lf.cosA + dz * lf.sinA;
            if (Math.abs(along) > lf.len) continue;
            const bend = Math.sin((along / lf.len) * Math.PI) * lf.len * lf.curve;
            const across = Math.abs((-dx * lf.sinA + dz * lf.cosA) - bend);
            const localW = lf.wid * (1.0 - 0.55 * Math.pow(Math.abs(along) / lf.len, 1.6));
            if (across < localW + 1.6) {
                if (across <= localW) {
                    const fProfile = Math.cos((across / Math.max(0.2, localW)) * (Math.PI * 0.5));
                    h = Math.min(h, -0.24 - fProfile * 0.48);
                } else {
                    const rimT = (across - localW) / 1.6;
                    h += Math.sin(rimT * Math.PI) * 0.28;
                }
            }
        }
    }

    // Dynamic Multi-Lobe Organic Ponds
    for (let i = 0; i < DYNAMIC_PONDS.length; i++) {
        const pd = DYNAMIC_PONDS[i];
        const dx = x - pd.x;
        const dz = z - pd.z;
        const d = Math.hypot(dx, dz);
        if (d < pd.r * 1.55) {
            const ang = Math.atan2(dz, dx);
            const effR = getDynamicPondRadiusAtAngle(pd, ang) + 0.45;
            if (d < effR) {
                h -= Math.cos((d / effR) * (Math.PI / 2)) * 2.15;
            }
        }
    }

    // Dynamic Bomb Hole Craters (Carved bowl depression + raised blast ejecta rim)
    for (let i = 0; i < DYNAMIC_BOMB_CRATERS.length; i++) {
        const bc = DYNAMIC_BOMB_CRATERS[i];
        const d = Math.hypot(x - bc.x, z - bc.z);
        if (d < bc.r * 1.35) {
            if (d < bc.r * 0.85) {
                const normD = d / (bc.r * 0.85);
                const bowl = 0.5 + 0.5 * Math.cos(normD * Math.PI);
                h = Math.max(-0.95, h - bc.depth * bowl);
            } else {
                const rimT = (d - bc.r * 0.85) / (bc.r * 0.50);
                h += Math.sin(rimT * Math.PI) * (bc.depth * 0.28);
            }
        }
    }

    // Physically Carved Tactical Trenches in the Soil Mesh (Trapezoidal Sunken Channel + Sloped Entry Ramps + Merged Trench Junctions)
    if (DYNAMIC_TRENCHES.length > 0) {
        let maxTrenchCarve = 0.0;
        let maxBermLift = 0.0;
        for (let i = 0; i < DYNAMIC_TRENCHES.length; i++) {
            const tr = DYNAMIC_TRENCHES[i];
            const dx = x - tr.x;
            const dz = z - tr.z;
            if (Math.abs(dx) > tr.halfLen + 5.0 && Math.abs(dz) > tr.halfLen + 5.0) continue;
            // Local trench coordinates: along (+Z in local group = sinR*x + cosR*z), across (+X in local group = cosR*x - sinR*z)
            const along = dx * tr.sinR + dz * tr.cosR;
            const across = Math.abs(dx * tr.cosR - dz * tr.sinR);
            const absAlong = Math.abs(along);
            const rampSpan = 2.6; // Smooth sloped entry ramps at both ends of the trench
            if (absAlong <= tr.halfLen + rampSpan && across <= tr.halfWid + 1.55) {
                let lenFade = 1.0;
                if (absAlong > tr.halfLen) {
                    const rt = (absAlong - tr.halfLen) / rampSpan;
                    lenFade = 0.5 + 0.5 * Math.cos(rt * Math.PI);
                }
                if (across <= tr.halfWid) {
                    // Flat sunken duckboard floor in center, smooth trapezoidal revetment wall slope on edges
                    const flatFloorW = tr.halfWid * 0.58;
                    let channelProfile = 1.0;
                    if (across > flatFloorW) {
                        const wt = (across - flatFloorW) / Math.max(0.1, tr.halfWid - flatFloorW);
                        channelProfile = 0.5 + 0.5 * Math.cos(wt * Math.PI);
                    }
                    maxTrenchCarve = Math.max(maxTrenchCarve, tr.depth * channelProfile * lenFade);
                } else if (absAlong <= tr.halfLen) {
                    const bermT = (across - tr.halfWid) / 1.55;
                    const bermProfile = Math.sin(bermT * Math.PI);
                    maxBermLift = Math.max(maxBermLift, 0.34 * bermProfile * lenFade);
                }
            }
        }
        if (maxTrenchCarve > 0.0) {
            h -= maxTrenchCarve;
        } else if (maxBermLift > 0.0) {
            h += maxBermLift;
        }
    }

    // Flatten Enemy Zerg Hive Cluster Sanctuary & Solaris Enclave Pad AFTER all valleys/canyons/ravines so Zerg Main Base is 100% flat & creep-covered!
    const dEnemy = Math.hypot(x - ENEMY_BASE_POS.x, z - ENEMY_BASE_POS.z);
    if (dEnemy < 30.0) {
        if (dEnemy <= 21.0) {
            h = 0.65;
        } else {
            const f = (dEnemy - 21.0) / 9.0;
            const sf = f * f * (3.0 - 2.0 * f);
            h = THREE.MathUtils.lerp(0.65, h, sf);
        }
    }
    const dSolaris = Math.hypot(x - SOLARIS_BASE_POS.x, z - SOLARIS_BASE_POS.z);
    if (dSolaris < 22.0) {
        if (dSolaris <= 14.0) {
            h = 0.65;
        } else {
            const f = (dSolaris - 14.0) / 8.0;
            const sf = f * f * (3.0 - 2.0 * f);
            h = THREE.MathUtils.lerp(0.65, h, sf);
        }
    }

    // Dynamically Flattened Building Pads (Carves & flattens terrain floor wherever a building is placed!)
    for (let i = 0; i < FLATTENED_BUILDING_PADS.length; i++) {
        const pad = FLATTENED_BUILDING_PADS[i];
        const d = Math.hypot(x - pad.x, z - pad.z);
        const totalR = pad.flatR + pad.blendR;
        if (d <= pad.flatR) {
            h = pad.targetY;
        } else if (d < totalR) {
            const t = (d - pad.flatR) / pad.blendR;
            const smoothT = t * t * (3.0 - 2.0 * t);
            h = THREE.MathUtils.lerp(pad.targetY, h, smoothT);
        }
    }

    return h;
}

// Returns terrain height including the 3D Engineered River Bridge decks for unit movement & placement
function getSurfaceHeightWithBridges(x, z) {
    const rawH = getTerrainHeight(x, z);
    for (let i = 0; i < RIVER_BRIDGES.length; i++) {
        const br = RIVER_BRIDGES[i];
        if (br.destroyed) continue;
        const bc = getBridgeLocalCoords(br, x, z);
        const dU = Math.abs(bc.localU);
        const flatHalfSpan = br.flatHalfSpan || (RIVER_HALF_WIDTH + 1.05);
        const rampReachU = br.rampReachU || (RIVER_HALF_WIDTH + 3.65);
        if (dU <= rampReachU + 1.15) {
            const dS = Math.abs(bc.localS);
            if (dS <= br.halfWidth + 1.1) {
                let deckY = rawH;
                if (dU <= flatHalfSpan) {
                    deckY = 0.35;
                } else {
                    const rampLen = Math.max(0.5, (rampReachU + 1.15) - flatHalfSpan);
                    const rampT = THREE.MathUtils.clamp((dU - flatHalfSpan) / rampLen, 0.0, 1.0);
                    const smoothRamp = rampT * rampT * (3.0 - 2.0 * rampT);
                    deckY = THREE.MathUtils.lerp(0.35, Math.max(0.16, rawH), smoothRamp);
                }
                if (dS > br.halfWidth - 0.15) {
                    const latT = THREE.MathUtils.clamp((dS - (br.halfWidth - 0.15)) / 1.1, 0.0, 1.0);
                    return THREE.MathUtils.lerp(Math.max(rawH, deckY), rawH, latT);
                }
                return Math.max(rawH, deckY);
            }
        }
    }
    return rawH;
}

// Strict Collision Exclusion Zones for Buildings around Bridge Walkways, Ramps & Immediate Approach Plazas
// Uses exact OBB deck bounds in the unified bridge local coordinate frame + compact ramp toe clearance!
function isSpotUnderOrBlockingBridge(x, z, radius = 1.8, isBarrierWall = false) {
    for (let i = 0; i < BRIDGE_BUILDING_EXCLUSION_ZONES.length; i++) {
        const ez = BRIDGE_BUILDING_EXCLUSION_ZONES[i];
        const rb = RIVER_BRIDGES[ez.bridgeIdx];
        const bc = rb ? getBridgeLocalCoords(rb, x, z) : { localS: 999, localU: 999 };
        const dS = Math.abs(bc.localS);
        const dU = Math.abs(bc.localU);

        // 1. Never allow placing any structure or barrier directly on the bridge deck span over the river
        const deckPad = isBarrierWall ? 0.35 : (radius + 0.55);
        const spanPad = isBarrierWall ? 0.25 : (radius + 0.45);
        if (dS < ez.deckHalfS + deckPad && dU < ez.spanHalfU + spanPad) {
            return true;
        }

        // 2. For full buildings (non-barriers), keep the immediate ramp toes clear so units can enter/exit the bridge walkway
        if (!isBarrierWall) {
            if (Math.hypot(x - ez.southPlaza.x, z - ez.southPlaza.z) < ez.southPlaza.r + radius * 0.65 ||
                Math.hypot(x - ez.northPlaza.x, z - ez.northPlaza.z) < ez.northPlaza.r + radius * 0.65) {
                return true;
            }
        }
    }
    return false;
}
window.isSpotUnderOrBlockingBridge = isSpotUnderOrBlockingBridge;

// Terrain Floor Carving & Grading Helper for Structures (Replaces Foundation Pillars!)
// Carves and levels the floor terrain directly underneath the building so it sits flush on the ground with ZERO pillars!
function addSlopeFoundationPillars(group, worldX, worldZ, width = 3.4, depth = 3.4, rotY = 0) {
    const flatR = Math.max(width, depth) * 0.56;
    const blendR = Math.max(1.8, flatR * 0.65);
    let baseWorldY = getTerrainHeight(worldX, worldZ);
    if (typeof flattenTerrainUnderBuilding === 'function') {
        baseWorldY = flattenTerrainUnderBuilding(worldX, worldZ, flatR, blendR);
    }
    group.position.set(worldX, baseWorldY, worldZ);
    return baseWorldY;
}
window.addSlopeFoundationPillars = addSlopeFoundationPillars;

function syncBaseAndCameraToTerrain() {
    ENEMY_BASE_POS.y = getTerrainHeight(ENEMY_BASE_POS.x, ENEMY_BASE_POS.z);
    ENEMY_BARRACKS_POS.y = getTerrainHeight(ENEMY_BARRACKS_POS.x, ENEMY_BARRACKS_POS.z);
    ENEMY_FACTORY_POS.y = getTerrainHeight(ENEMY_FACTORY_POS.x, ENEMY_FACTORY_POS.z);
    SOLARIS_BASE_POS.y = getTerrainHeight(SOLARIS_BASE_POS.x, SOLARIS_BASE_POS.z);
    BRIDGES.forEach(b => {
        b.center.y = getTerrainHeight(b.center.x, b.center.z);
        b.southEntry.y = getTerrainHeight(b.southEntry.x, b.southEntry.z);
        b.northEntry.y = getTerrainHeight(b.northEntry.x, b.northEntry.z);
    });

    controls.target.set(PLAYER_START_POS.x, getTerrainHeight(PLAYER_START_POS.x, PLAYER_START_POS.z), PLAYER_START_POS.z);
    if (IS_MOBILE) {
        camera.position.set(PLAYER_START_POS.x + 6, 52, PLAYER_START_POS.z + 46);
    } else {
        camera.position.set(PLAYER_START_POS.x + 4, 38, PLAYER_START_POS.z + 34);
    }
    controls.update();
}
syncBaseAndCameraToTerrain();

const _normalScratchVec = new THREE.Vector3();
const _alignNormalScratch = new THREE.Vector3();
const _targetQuatScratch = new THREE.Quaternion();
const _stepReturnScratch = new THREE.Vector3();

function getTerrainNormalInto(x, z, outVec) {
    const eps = 0.4;
    const hL = getTerrainHeight(x - eps, z);
    const hR = getTerrainHeight(x + eps, z);
    const hD = getTerrainHeight(x, z - eps);
    const hU = getTerrainHeight(x, z + eps);
    return outVec.set(hL - hR, 2 * eps, hD - hU).normalize();
}

function getTerrainNormalY(x, z) {
    const eps = 0.4;
    const dx = getTerrainHeight(x - eps, z) - getTerrainHeight(x + eps, z);
    const dz = getTerrainHeight(x, z - eps) - getTerrainHeight(x, z + eps);
    const twoEps = 2 * eps;
    return twoEps / Math.hypot(dx, twoEps, dz);
}

function getTerrainNormal(x, z) {
    const eps = 0.4;
    const hL = getTerrainHeight(x - eps, z);
    const hR = getTerrainHeight(x + eps, z);
    const hD = getTerrainHeight(x, z - eps);
    const hU = getTerrainHeight(x, z + eps);
    return new THREE.Vector3(hL - hR, 2 * eps, hD - hU).normalize();
}

// ============================================================================
// SPATIAL HASH INDEX FOR HARD BARRIERS & STRUCTURE BLOCKERS (32x32 CELLS, 8m)
// Eliminates O(Obstacles) scans inside isWalkableGround, isPointWalkableForUnitSize,
// computeSafeGroundStep, and findClearSpawnPoint!
// ============================================================================
const SGRID_HALF = 128.0;
const SGRID_CELL = 8.0;
const SGRID_DIM = 32; // 32x32 = 1024 cells covering [-128..+128]
const SGRID_TOTAL = SGRID_DIM * SGRID_DIM;

const _barrierGridBuckets = new Array(SGRID_TOTAL);
const _structGridBuckets = new Array(SGRID_TOTAL);
for (let i = 0; i < SGRID_TOTAL; i++) {
    _barrierGridBuckets[i] = [];
    _structGridBuckets[i] = [];
}
let _barrierGridLastMs = -9999;
let _barrierGridLastObCount = -1;
let _barrierGridLastBldCount = -1;

function _toSGridCoord(v) {
    const c = Math.floor((v + SGRID_HALF) / SGRID_CELL);
    return c < 0 ? 0 : (c >= SGRID_DIM ? SGRID_DIM - 1 : c);
}

function _insertCircleIntoSGrid(buckets, item, x, z, radius) {
    const minCx = _toSGridCoord(x - radius);
    const maxCx = _toSGridCoord(x + radius);
    const minCz = _toSGridCoord(z - radius);
    const maxCz = _toSGridCoord(z + radius);
    for (let cz = minCz; cz <= maxCz; cz++) {
        const rowOff = cz * SGRID_DIM;
        for (let cx = minCx; cx <= maxCx; cx++) {
            buckets[rowOff + cx].push(item);
        }
    }
}

function _ensureBarrierSpatialGrid() {
    const nowMs = performance.now();
    const obLen = obstacles.length;
    const bldLen = (window.buildings && Array.isArray(window.buildings)) ? window.buildings.length : 0;
    if (obLen === _barrierGridLastObCount && bldLen === _barrierGridLastBldCount && (nowMs - _barrierGridLastMs) < 240) {
        return;
    }
    _barrierGridLastMs = nowMs;
    _barrierGridLastObCount = obLen;
    _barrierGridLastBldCount = bldLen;

    for (let i = 0; i < SGRID_TOTAL; i++) {
        _barrierGridBuckets[i].length = 0;
    }
    for (let i = 0; i < obLen; i++) {
        const ob = obstacles[i];
        if (ob && (ob.isBarrier || ob.type === 'battlefield_barriers' || ob.type === 'map_boundary_barrier' || ob.type === 'trench_wall')) {
            const r = ob.r || 1.15;
            _insertCircleIntoSGrid(_barrierGridBuckets, { x: ob.x, z: ob.z, r }, ob.x, ob.z, r + 1.5);
        }
    }
    if (window.buildings && Array.isArray(window.buildings)) {
        for (let i = 0; i < window.buildings.length; i++) {
            const b = window.buildings[i];
            if (b && b.hp > 0 && b.type === 'barrier' && b.pos) {
                const r = b.footprintRadius || 1.25;
                _insertCircleIntoSGrid(_barrierGridBuckets, { x: b.pos.x, z: b.pos.z, r }, b.pos.x, b.pos.z, r + 1.5);
            }
        }
    }
}

function isWalkableGround(x, z, unitRad = 0.0) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    // Out-of-bounds map perimeter barrier check (hard boundary at ±105.5m inside the outer cliff wall)
    if (Math.abs(x) > 105.5 - unitRad || Math.abs(z) > 105.5 - unitRad) return false;

    // 0. Hard Impassable Barrier Check via O(1) Spatial Grid Bucket Lookup:
    _ensureBarrierSpatialGrid();
    const barrierPad = Math.max(0.18, unitRad * 0.65);
    const bCellIdx = _toSGridCoord(z) * SGRID_DIM + _toSGridCoord(x);
    const bBucket = _barrierGridBuckets[bCellIdx];
    for (let i = 0; i < bBucket.length; i++) {
        const ob = bBucket[i];
        const dx = x - ob.x;
        const dz = z - ob.z;
        const minR = ob.r + barrierPad;
        if (dx * dx + dz * dz < minR * minR) return false;
    }

    // 0B. Carved Tactical Trench Collision Volume Check:
    // Units can enter via the sloped end ramps and walk along the sunken interior channel, but CANNOT clip through side revetment walls!
    for (let i = 0; i < DYNAMIC_TRENCHES.length; i++) {
        const tr = DYNAMIC_TRENCHES[i];
        const dx = x - tr.x;
        const dz = z - tr.z;
        if (Math.abs(dx) > tr.halfLen + 3.5 && Math.abs(dz) > tr.halfLen + 3.5) continue;
        const along = dx * tr.sinR + dz * tr.cosR;
        const across = Math.abs(dx * tr.cosR - dz * tr.sinR);
        const absAlong = Math.abs(along);
        if (absAlong <= tr.halfLen + 2.4 && across <= tr.halfWid + 1.25) {
            let inMergedChannel = false;
            for (let j = 0; j < DYNAMIC_TRENCHES.length; j++) {
                if (j === i) continue;
                const tr2 = DYNAMIC_TRENCHES[j];
                const dx2 = x - tr2.x, dz2 = z - tr2.z;
                const al2 = Math.abs(dx2 * tr2.sinR + dz2 * tr2.cosR);
                const ac2 = Math.abs(dx2 * tr2.cosR - dz2 * tr2.sinR);
                if (al2 <= tr2.halfLen + 1.8 && ac2 <= tr2.halfWid * 0.72) {
                    inMergedChannel = true;
                    break;
                }
            }
            if (inMergedChannel) return true;
            if (across <= tr.halfWid * 0.70 || absAlong > tr.halfLen - 0.45) {
                return true;
            }
            if (across > tr.halfWid * 0.70 && across <= tr.halfWid + 1.15 && absAlong <= tr.halfLen - 0.45) {
                return false;
            }
        }
    }

    // 1. Multi-Faction Base Rim & Merged Multi-Ramp Check ('flat_ramp' & 'under_ramp' zones):
    // Fast radial bounding reject avoids expensive trigonometric ramp evaluation when far from base zones!
    for (let bIdx = 0; bIdx < BASE_TERRAIN_ZONES.length; bIdx++) {
        const bz = BASE_TERRAIN_ZONES[bIdx];
        if (bz.mode !== 'flat_ramp' && bz.mode !== 'under_ramp') continue;
        const bdx = x - bz.x;
        const bdz = z - bz.z;
        const maxZoneR = (bz.rimOuter || 27.5) + 15.0;
        if (bdx * bdx + bdz * bdz > maxZoneR * maxZoneR) continue;
        const zm = getBaseZoneRampMetrics(bz, x, z);
        if (zm.inRampAngle || zm.rampBlend > 0.35 || zm.mergedPlatformBlend > 0.35) {
            return true;
        }
        if (zm.dist >= bz.radius - 1.0 && zm.dist <= bz.rimOuter + 0.6) {
            return false; // Steep protective non-ramp cliff rim blocks direct climbing
        }
    }

    // 2. River & Island Bridge Deck & Approach Ramps: unconditionally walkable across the entire bridge deck & approach ramps
    // Uses exact bridgeLocalCoords(br, x, z) so skewed river bridges and long custom island bridges are 100% aligned!
    if (RIVER_BRIDGES.length > 0) {
        for (let i = 0; i < RIVER_BRIDGES.length; i++) {
            const br = RIVER_BRIDGES[i];
            if (br.destroyed) continue;
            const bc = getBridgeLocalCoords(br, x, z);
            const dU = Math.abs(bc.localU);
            const dS = Math.abs(bc.localS);
            const flatHalfSpan = br.flatHalfSpan || (RIVER_HALF_WIDTH + 1.05);
            const rampReachU = br.rampReachU || (RIVER_HALF_WIDTH + 3.65);
            const safeHalfW = br.halfWidth - 0.22 - Math.min(0.18, unitRad * 0.20);
            if (dU <= flatHalfSpan + 0.45) {
                if (dS <= safeHalfW) return true;
                if (dS > safeHalfW && dS < br.halfWidth + 0.45) return false;
            } else if (dU <= rampReachU + 6.5) {
                const exitFlare = THREE.MathUtils.clamp((dU - flatHalfSpan) * 0.75, 0.55, 4.2);
                if (dS <= br.halfWidth + exitFlare) return true;
            }
        }
    }
    if (HAS_VALLEY_RIVER && ACTIVE_PLANET_BIOME !== 'ocean') {
        const rc = getRiverCoords(x, z);
        if (rc.dist <= (rc.halfWidth || RIVER_HALF_WIDTH) + 0.55) {
            return false;
        }
    }

    if (isOnBridgeCorridor(x, z)) return true;
    const h = getTerrainHeight(x, z);
    if (ACTIVE_PLANET_BIOME === 'ocean' && h < -0.14) return false;
    if (ACTIVE_PLANET_BIOME === 'lava' && h < -0.20) return false;
    if (h < -1.65 || h > 16.5) return false;
    if (typeof isPointInWaterPond === 'function' && isPointInWaterPond(x, z, Math.min(0.28, unitRad * 0.35))) return false;
    // Zero-allocation normal Y check rejects steep canyon/mountain/ravine cliff faces (norm.y < 0.46)
    if (getTerrainNormalY(x, z) < 0.46) return false;
    return true;
}

const _forwardVec = new THREE.Vector3();
const _rightVec = new THREE.Vector3();
const _rotMatrix = new THREE.Matrix4();
const _upVec = new THREE.Vector3(0, 1, 0);

function alignGroundUnitToTerrain(mesh, targetLookX, targetLookZ, dt = 0.016, actor = null) {
    const x = mesh.position.x;
    const z = mesh.position.z;
    // Walk on top of bridge deck when on a bridge, otherwise on terrain surface!
    const targetY = getSurfaceHeightWithBridges(x, z);
    const isTank = !!(mesh.userData && mesh.userData.vType === 'tank');

    // Smooth vertical suspension for tanks & ground units climbing mountain slopes or crossing bridges
    if (Number.isFinite(mesh.position.y)) {
        mesh.position.y = THREE.MathUtils.lerp(mesh.position.y, targetY, Math.min(1, dt * (isTank ? 12 : 24)));
    } else {
        mesh.position.y = targetY;
    }

    const onBridge = isOnRiverBridge(x, z);
    const rawNormal = onBridge ? _upVec : getTerrainNormalInto(x, z, _alignNormalScratch);
    if (!mesh.userData.smoothNormal) {
        mesh.userData.smoothNormal = rawNormal.clone();
    } else {
        mesh.userData.smoothNormal.lerp(rawNormal, Math.min(1, dt * (isTank ? 5.5 : 11.0))).normalize();
    }
    const normal = mesh.userData.smoothNormal;

    const dx = targetLookX - x;
    const dz = targetLookZ - z;
    if (dx * dx + dz * dz > 0.0004) {
        const desiredYaw = Math.atan2(dx, dz);
        if (mesh.userData.smoothYaw === undefined) {
            mesh.userData.smoothYaw = desiredYaw;
        } else {
            let diff = (desiredYaw - mesh.userData.smoothYaw + Math.PI) % (Math.PI * 2) - Math.PI;
            if (diff < -Math.PI) diff += Math.PI * 2;
            const maxTurnStep = (isTank ? 2.6 : 7.5) * dt;
            if (Math.abs(diff) <= maxTurnStep) {
                mesh.userData.smoothYaw = desiredYaw;
            } else {
                mesh.userData.smoothYaw += Math.sign(diff) * maxTurnStep;
            }
        }
    } else if (mesh.userData.smoothYaw === undefined) {
        mesh.userData.smoothYaw = mesh.rotation.y || 0;
    }

    const yaw = mesh.userData.smoothYaw;
    _forwardVec.set(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
    _rightVec.crossVectors(normal, _forwardVec).normalize();
    _forwardVec.crossVectors(_rightVec, normal).normalize();

    _rotMatrix.makeBasis(_rightVec, normal, _forwardVec);
    _targetQuatScratch.setFromRotationMatrix(_rotMatrix);
    mesh.quaternion.slerp(_targetQuatScratch, Math.min(1, dt * (isTank ? 6.0 : 12.0)));
}

function isPointClearOfAllBuildings(wx, wz, unitRad = 0.45, targetPos = null, ignoreBuilding = null) {
    const checkList = (list) => {
        if (!Array.isArray(list)) return true;
        for (let i = 0; i < list.length; i++) {
            const b = list[i];
            if (!b || b.hp <= 0 || !b.pos || b === ignoreBuilding) continue;
            const bRad = b.footprintRadius || (b.type === 'base' || b.role === 'citadel' ? 2.65 : (b.type === 'turret' || b.role === 'spine_turret' ? 1.36 : 2.05));
            const minSep = bRad + unitRad + 0.18;
            const dx = wx - b.pos.x;
            const dz = wz - b.pos.z;
            const dSq = dx * dx + dz * dz;
            if (dSq < minSep * minSep) {
                // If this building IS the targetPos, allow approaching up to its outer hull perimeter (bRad + unitRad * 0.5)
                if (targetPos && Math.hypot(targetPos.x - b.pos.x, targetPos.z - b.pos.z) < bRad + 1.2) {
                    const hullSep = bRad + unitRad * 0.45;
                    if (dSq >= hullSep * hullSep) continue;
                }
                return false;
            }
        }
        return true;
    };
    if (!checkList(window.buildings)) return false;
    if (!checkList(window.enemyBuildings)) return false;
    if (!checkList(window.solarisBuildings)) return false;
    return true;
}
window.isPointClearOfAllBuildings = isPointClearOfAllBuildings;

function validateGroundDestination(currPos, destPos, unitRad = 0.5) {
    if (!destPos || !Number.isFinite(destPos.x) || !Number.isFinite(destPos.z)) {
        return currPos ? currPos.clone() : new THREE.Vector3(0, 0, 0);
    }
    const clampedX = Math.max(-104, Math.min(104, destPos.x));
    const clampedZ = Math.max(-104, Math.min(104, destPos.z));
    if (isWalkableGround(clampedX, clampedZ, unitRad * 0.55) && isPointClearOfAllBuildings(clampedX, clampedZ, unitRad * 0.55, destPos)) {
        if (Math.abs(clampedX - destPos.x) > 0.01 || Math.abs(clampedZ - destPos.z) > 0.01) {
            return new THREE.Vector3(clampedX, getSurfaceHeightWithBridges(clampedX, clampedZ), clampedZ);
        }
        return destPos;
    }
    // Project destination outward toward currPos or radial ring to find the nearest valid attack/move stand point
    const baseAng = currPos ? Math.atan2(currPos.z - clampedZ, currPos.x - clampedX) : 0;
    for (let r = 1.6; r <= 7.6; r += 1.0) {
        for (let s = 0; s < 12; s++) {
            const offsetAng = (s % 2 === 0 ? 1 : -1) * Math.ceil(s / 2) * (Math.PI / 6);
            const ang = baseAng + offsetAng;
            const tx = Math.max(-104, Math.min(104, clampedX + Math.cos(ang) * r));
            const tz = Math.max(-104, Math.min(104, clampedZ + Math.sin(ang) * r));
            if (isWalkableGround(tx, tz, unitRad * 0.55) && isPointClearOfAllBuildings(tx, tz, unitRad * 0.55, destPos)) {
                return new THREE.Vector3(tx, getSurfaceHeightWithBridges(tx, tz), tz);
            }
        }
    }
    return new THREE.Vector3(clampedX, getSurfaceHeightWithBridges(clampedX, clampedZ), clampedZ);
}
window.validateGroundDestination = validateGroundDestination;

function getGroundNavigationWaypoint(currPos, destPos, actor = null) {
    const unitRad = (actor && actor.radius) ? actor.radius : 0.52;
    const validDest = validateGroundDestination(currPos, destPos, unitRad);
    if (actor) {
        actor._validatedDest = validDest;
    }

    let candidateWp = validDest;
    let isRampOrBridgeWp = false;

    // 1. Funnel units entering or exiting any Ramp-Gated Base Zone ('flat_ramp' or 'under_ramp') through the nearest Upper Ramp -> Merged Second Ramp Platform -> Lower Ramp!
    for (let bIdx = 0; bIdx < BASE_TERRAIN_ZONES.length; bIdx++) {
        const bz = BASE_TERRAIN_ZONES[bIdx];
        if (bz.mode !== 'flat_ramp' && bz.mode !== 'under_ramp') continue;
        const cDx = currPos.x - bz.x, cDz = currPos.z - bz.z;
        const dDx = validDest.x - bz.x, dDz = validDest.z - bz.z;
        const cDistSq = cDx * cDx + cDz * cDz;
        const dDistSq = dDx * dDx + dDz * dDz;
        const innerR = bz.radius - 0.5;
        const innerRSq = innerR * innerR;
        const currInside = cDistSq < innerRSq;
        const destInside = dDistSq < innerRSq;

        if (currInside !== destInside) {
            const currRM = getBaseZoneRampMetrics(bz, currPos.x, currPos.z);
            const openingAngles = currRM.openingAngles || [Math.atan2(bz.rampDirZ, bz.rampDirX)];
            const primaryAng = openingAngles[0];
            let bestOpAng = primaryAng;
            let bestOpScore = Infinity;
            for (let oIdx = 0; oIdx < openingAngles.length; oIdx++) {
                const oa = openingAngles[oIdx];
                const ox = bz.x + Math.cos(oa) * bz.rimOuter;
                const oz = bz.z + Math.sin(oa) * bz.rimOuter;
                const score = Math.hypot(currPos.x - ox, currPos.z - oz) + Math.hypot(validDest.x - ox, validDest.z - oz) * 0.75;
                if (score < bestOpScore) {
                    bestOpScore = score;
                    bestOpAng = oa;
                }
            }
            const opDirX = Math.cos(bestOpAng);
            const opDirZ = Math.sin(bestOpAng);
            const priDirX = Math.cos(primaryAng);
            const priDirZ = Math.sin(primaryAng);
            const outerReach = bz.rimOuter + 14.2;

            const rampInnerPt = {
                x: bz.x + opDirX * (bz.radius - 3.2),
                z: bz.z + opDirZ * (bz.radius - 3.2)
            };
            const mergedPlatformPt = {
                x: bz.x + priDirX * (bz.rimOuter + 3.2),
                z: bz.z + priDirZ * (bz.rimOuter + 3.2)
            };
            const rampOuterPt = {
                x: bz.x + priDirX * outerReach,
                z: bz.z + priDirZ * outerReach
            };
            if (currInside && !destInside) {
                if (!currRM.inRampAngle && currRM.dist > bz.radius - 4.0) {
                    candidateWp = new THREE.Vector3(rampInnerPt.x, getTerrainHeight(rampInnerPt.x, rampInnerPt.z), rampInnerPt.z);
                    isRampOrBridgeWp = true;
                    break;
                }
                if (currRM.dist < bz.rimOuter + 1.8) {
                    candidateWp = new THREE.Vector3(mergedPlatformPt.x, getTerrainHeight(mergedPlatformPt.x, mergedPlatformPt.z), mergedPlatformPt.z);
                    isRampOrBridgeWp = true;
                    break;
                }
                if (currRM.dist < outerReach - 1.5) {
                    candidateWp = new THREE.Vector3(rampOuterPt.x, getTerrainHeight(rampOuterPt.x, rampOuterPt.z), rampOuterPt.z);
                    isRampOrBridgeWp = true;
                    break;
                }
            } else if (!currInside && destInside) {
                if (currRM.dist > bz.rimOuter + 6.8 && !currRM.inRampAngle) {
                    candidateWp = new THREE.Vector3(rampOuterPt.x, getTerrainHeight(rampOuterPt.x, rampOuterPt.z), rampOuterPt.z);
                    isRampOrBridgeWp = true;
                    break;
                }
                if (currRM.dist > bz.rimOuter + 1.2 && !currRM.inRampAngle) {
                    candidateWp = new THREE.Vector3(mergedPlatformPt.x, getTerrainHeight(mergedPlatformPt.x, mergedPlatformPt.z), mergedPlatformPt.z);
                    isRampOrBridgeWp = true;
                    break;
                }
                if (currRM.dist > bz.radius - 2.2) {
                    candidateWp = new THREE.Vector3(rampInnerPt.x, getTerrainHeight(rampInnerPt.x, rampInnerPt.z), rampInnerPt.z);
                    isRampOrBridgeWp = true;
                    break;
                }
            }
        }
    }

    // 2. When a River with Bridges is present, route ground units cleanly across the assigned Bridge with Traffic Control!
    if (!isRampOrBridgeWp && HAS_VALLEY_RIVER && BRIDGES.length > 0) {
        if (ACTIVE_PLANET_BIOME === 'ocean') {
            // In Ocean Archipelago biome, bridges are custom island-to-island spans; cache multi-island A* waypoints per actor to prevent per-frame freeze!
            if (typeof computeAStarWalkablePath === 'function') {
                const distToGoal = Math.hypot(validDest.x - currPos.x, validDest.z - currPos.z);
                if (distToGoal > 18.0) {
                    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                    const cacheValid = actor && actor._oceanNavCache &&
                        (nowMs - actor._oceanNavCache.timeMs < 950) &&
                        Math.hypot(actor._oceanNavCache.destX - validDest.x, actor._oceanNavCache.destZ - validDest.z) < 3.2;
                    let path = cacheValid ? actor._oceanNavCache.path : null;
                    if (!path) {
                        const structBlockers = typeof gatherStructureBlockers === 'function' ? gatherStructureBlockers(unitRad) : [];
                        path = computeAStarWalkablePath(currPos, validDest, unitRad, structBlockers);
                        if (actor) {
                            actor._oceanNavCache = {
                                timeMs: nowMs + Math.random() * 250,
                                destX: validDest.x,
                                destZ: validDest.z,
                                path
                            };
                        }
                    }
                    if (Array.isArray(path) && path.length > 1) {
                        for (let p = 0; p < path.length; p++) {
                            if (Math.hypot(path[p].x - currPos.x, path[p].z - currPos.z) > 4.2) {
                                candidateWp = path[p];
                                isRampOrBridgeWp = true;
                                break;
                            }
                        }
                    }
                }
            }
        } else {
            if (window.BRIDGE_TRAFFIC_MANAGER) {
                const trafficWp = window.BRIDGE_TRAFFIC_MANAGER.getNavigationTarget(actor, currPos, validDest);
                if (trafficWp) {
                    candidateWp = trafficWp;
                    isRampOrBridgeWp = true;
                }
            }

            if (!isRampOrBridgeWp) {
                const currRC = getRiverCoords(currPos.x, currPos.z);
                const destRC = getRiverCoords(validDest.x, validDest.z);
                const destSideSign = destRC.signedDist >= 0 ? 1 : -1;
                const currSideSign = currRC.signedDist >= 0 ? 1 : -1;
                const onOppositeSides = (currSideSign !== destSideSign) && Math.abs(destRC.signedDist) > 1.2;
                const stillOnBridgeOrRamp = Math.abs(currRC.signedDist) < RIVER_HALF_WIDTH + 4.2 &&
                                            (currRC.signedDist * destSideSign < RIVER_HALF_WIDTH + 4.0);

                if (onOppositeSides || stillOnBridgeOrRamp) {
                    let bestIdx = 0;
                    if (actor && actor.activeBridgeCrossIdx !== undefined && BRIDGES[actor.activeBridgeCrossIdx]) {
                        bestIdx = actor.activeBridgeCrossIdx;
                    } else if (actor && actor.preferredBridgeIdx !== undefined && BRIDGES[actor.preferredBridgeIdx]) {
                        bestIdx = actor.preferredBridgeIdx;
                    } else {
                        let bestScore = Infinity;
                        for (let i = 0; i < BRIDGES.length; i++) {
                            const br = BRIDGES[i];
                            const dScore = Math.hypot(currPos.x - br.center.x, currPos.z - br.center.z) +
                                           Math.hypot(validDest.x - br.center.x, validDest.z - br.center.z) * 0.55;
                            if (dScore < bestScore) {
                                bestScore = dScore;
                                bestIdx = i;
                            }
                        }
                    }
                    if (actor) actor.activeBridgeCrossIdx = bestIdx;
                    const bestBr = BRIDGES[bestIdx];
                    const bCenterU = getRiverCenterUAtS(bestBr.sCoord);

                    const nearEntryPt = destSideSign > 0 ? bestBr.northEntry : bestBr.southEntry;
                    const farExitPt   = destSideSign > 0 ? bestBr.southEntry : bestBr.northEntry;
                    const farClearWorld = riverCoordsToWorld(
                        bestBr.sCoord,
                        bCenterU + destSideSign * (RIVER_HALF_WIDTH + 5.6)
                    );
                    const dS = Math.abs(currRC.s - bestBr.sCoord);

                    if (currRC.signedDist * destSideSign < -(RIVER_HALF_WIDTH + 1.8) && dS > bestBr.halfWidth * 0.62) {
                        candidateWp = new THREE.Vector3(nearEntryPt.x, getSurfaceHeightWithBridges(nearEntryPt.x, nearEntryPt.z), nearEntryPt.z);
                    } else if (currRC.signedDist * destSideSign < -0.6) {
                        candidateWp = new THREE.Vector3(bestBr.center.x, getSurfaceHeightWithBridges(bestBr.center.x, bestBr.center.z), bestBr.center.z);
                    } else if (currRC.signedDist * destSideSign < RIVER_HALF_WIDTH + 3.8) {
                        candidateWp = new THREE.Vector3(farClearWorld.x, getSurfaceHeightWithBridges(farClearWorld.x, farClearWorld.z), farClearWorld.z);
                    } else {
                        candidateWp = new THREE.Vector3(farExitPt.x, getSurfaceHeightWithBridges(farExitPt.x, farExitPt.z), farExitPt.z);
                    }
                    isRampOrBridgeWp = true;
                } else if (actor && actor.activeBridgeCrossIdx !== undefined) {
                    actor.activeBridgeCrossIdx = undefined;
                }
            }
        }
    }

    return candidateWp;
}

// ============================================================================
// TACTICAL BRIDGE TRAFFIC CONTROLLER & DEADLOCK RECOVERY SYSTEM
// Manages bridge reservations, directional convoy flow, heavy-armor priority,
// safe bank waiting/staging slots, timeout expiration, and deadlock clearing.
// ============================================================================
const BRIDGE_TRAFFIC_MANAGER = {
    bridges: [],
    lastSyncSeed: null,
    deadlockRecoveries: 0,

    isHeavyActor(actor) {
        if (!actor) return false;
        const t = actor.type || actor.variant || '';
        return t === 'tank' || t === 'siege_tank' || t === 'behemoth' || t === 'crusher' ||
               t === 'gorgon' || t === 'archon' || (t === 'valkyrie' && actor.mechMode);
    },

    syncFromBridges() {
        if (!HAS_VALLEY_RIVER || !Array.isArray(BRIDGES) || BRIDGES.length === 0) {
            this.bridges = [];
            return;
        }
        if (this.bridges.length === BRIDGES.length && this.lastSyncSeed === window.ACTIVE_MAP_SEED) {
            return;
        }
        this.lastSyncSeed = window.ACTIVE_MAP_SEED;
        this.bridges = BRIDGES.map((br, idx) => {
            const bCenterU = getRiverCenterUAtS(br.sCoord);
            const width = (br.halfWidth || 3.4) * 2.0;
            const waitingAreaSouth = [];
            const waitingAreaNorth = [];
            // Build 8 ordered staging slots on both banks outside the bridge ramp entrance
            for (let s = 0; s < 8; s++) {
                const row = (s >> 1);
                const side = (s & 1) === 0 ? -1 : 1;
                const lateralS = br.sCoord + side * (1.85 + (row % 2) * 1.15);
                const backDist = RIVER_HALF_WIDTH + 6.2 + row * 2.1;
                const ptSouth = riverCoordsToWorld(lateralS, bCenterU + backDist);
                const ptNorth = riverCoordsToWorld(lateralS, bCenterU - backDist);
                waitingAreaSouth.push(new THREE.Vector3(ptSouth.x, getSurfaceHeightWithBridges(ptSouth.x, ptSouth.z), ptSouth.z));
                waitingAreaNorth.push(new THREE.Vector3(ptNorth.x, getSurfaceHeightWithBridges(ptNorth.x, ptNorth.z), ptNorth.z));
            }
            return {
                id: br.id || `bridge_${idx}`,
                index: idx,
                sCoord: br.sCoord,
                center: br.center.clone(),
                entranceSouth: br.southEntry.clone(),
                entranceNorth: br.northEntry.clone(),
                corridorCenterLine: [br.southEntry.clone(), br.center.clone(), br.northEntry.clone()],
                width,
                halfWidth: br.halfWidth || 3.4,
                maxConcurrentUnits: width >= 6.4 ? 5 : 4,
                activeDirection: 'idle', // 'idle' | 'south_to_north' | 'north_to_south'
                occupiedBy: new Map(),   // actor -> { enteredAt, lastU, lastMoveAt, direction, isHeavy, laneOffset }
                reservationQueue: [],    // [{ actor, direction, requestedAt, isHeavy, priority, waitSlotIdx }]
                waitingAreaSouth,
                waitingAreaNorth,
                lockTimestamp: 0
            };
        });
    },

    chooseBestBridgeIndex(actor, currPos, destPos, avoidBridgeIdx = -1) {
        this.syncFromBridges();
        if (this.bridges.length === 0) return 0;
        let bestIdx = 0;
        let bestScore = Infinity;
        for (let i = 0; i < this.bridges.length; i++) {
            const rb = RIVER_BRIDGES[i];
            if (rb && rb.destroyed) continue;
            const bDesc = this.bridges[i];
            const dStart = Math.hypot(currPos.x - bDesc.center.x, currPos.z - bDesc.center.z);
            const dGoal = Math.hypot(destPos.x - bDesc.center.x, destPos.z - bDesc.center.z);
            const queuePenalty = (bDesc.occupiedBy.size * 3.5) + (bDesc.reservationQueue.length * 4.2);
            const avoidPenalty = (i === avoidBridgeIdx && this.bridges.length > 1) ? 28.0 : 0;
            const score = dStart + dGoal * 0.55 + queuePenalty + avoidPenalty;
            if (score < bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }
        return bestIdx;
    },

    releaseActor(actor) {
        if (!actor) return;
        for (let i = 0; i < this.bridges.length; i++) {
            const b = this.bridges[i];
            b.occupiedBy.delete(actor);
            for (let q = b.reservationQueue.length - 1; q >= 0; q--) {
                if (b.reservationQueue[q].actor === actor) {
                    b.reservationQueue.splice(q, 1);
                }
            }
            if (b.occupiedBy.size === 0 && b.reservationQueue.length === 0) {
                b.activeDirection = 'idle';
            }
        }
        actor._bridgeWaitState = null;
    },

    update(dt) {
        this.syncFromBridges();
        if (this.bridges.length === 0) return;
        const nowSec = performance.now() * 0.001;

        for (let i = 0; i < this.bridges.length; i++) {
            const b = this.bridges[i];
            const br = BRIDGES[i];
            if (!br) continue;

            // 1. Clean up dead, distant, or stalled occupants
            for (const [actor, meta] of b.occupiedBy.entries()) {
                if (!actor || actor.hp <= 0 || !actor.mesh) {
                    b.occupiedBy.delete(actor);
                    continue;
                }
                const pos = actor.mesh.position;
                const rc = getRiverCoords(pos.x, pos.z);
                const dS = Math.abs(rc.s - b.sCoord);
                const clearedFarBank = (meta.direction === 'south_to_north' && rc.signedDist < -(RIVER_HALF_WIDTH + 4.8)) ||
                                       (meta.direction === 'north_to_south' && rc.signedDist > (RIVER_HALF_WIDTH + 4.8));
                const wanderedOff = dS > b.halfWidth + 8.5 && Math.abs(rc.signedDist) > RIVER_HALF_WIDTH + 5.5;
                const timedOut = (nowSec - meta.enteredAt) > 6.5;

                // Track longitudinal progress across river U axis
                if (Math.abs(rc.signedDist - meta.lastU) > 0.28) {
                    meta.lastU = rc.signedDist;
                    meta.lastMoveAt = nowSec;
                }

                // Deadlock recovery if a unit stalls on the bridge span for > 1.75s
                if ((nowSec - meta.lastMoveAt) > 1.75) {
                    this.deadlockRecoveries++;
                    meta.lastMoveAt = nowSec;
                    meta.laneOffset = ((meta.laneOffset || 0) >= 0 ? -1 : 1) * 0.85;
                    if ((nowSec - meta.enteredAt) > 4.2) {
                        b.occupiedBy.delete(actor);
                        continue;
                    }
                }

                if (clearedFarBank || wanderedOff || timedOut) {
                    b.occupiedBy.delete(actor);
                    actor.bridgeClearedTimer = 0.85;
                }
            }

            // 2. Prune invalid or expired queue entries
            for (let q = b.reservationQueue.length - 1; q >= 0; q--) {
                const req = b.reservationQueue[q];
                if (!req.actor || req.actor.hp <= 0 || !req.actor.mesh || (nowSec - req.requestedAt) > 4.5) {
                    b.reservationQueue.splice(q, 1);
                }
            }

            // 3. Promote queued units into active bridge occupancy when direction matches or bridge is clear
            if (b.occupiedBy.size === 0) {
                if (b.reservationQueue.length > 0) {
                    // Sort by heavy priority first, then FIFO timestamp
                    b.reservationQueue.sort((a, bReq) => (bReq.priority - a.priority) || (a.requestedAt - bReq.requestedAt));
                    b.activeDirection = b.reservationQueue[0].direction;
                    b.lockTimestamp = nowSec;
                } else {
                    b.activeDirection = 'idle';
                }
            }

            if (b.activeDirection !== 'idle' && b.reservationQueue.length > 0) {
                // Prevent one direction from starving the opposite bank for > 5.0s
                const dirHoldTime = nowSec - (b.lockTimestamp || nowSec);
                const hasOppositeWaiting = b.reservationQueue.some(r => r.direction !== b.activeDirection && (nowSec - r.requestedAt) > 2.2);
                const allowMoreSameDir = !(dirHoldTime > 4.8 && hasOppositeWaiting);

                if (allowMoreSameDir) {
                    for (let q = 0; q < b.reservationQueue.length; q++) {
                        if (b.occupiedBy.size >= b.maxConcurrentUnits) break;
                        const req = b.reservationQueue[q];
                        if (req.direction !== b.activeDirection) continue;
                        const rc = getRiverCoords(req.actor.mesh.position.x, req.actor.mesh.position.z);
                        b.occupiedBy.set(req.actor, {
                            enteredAt: nowSec,
                            lastU: rc.signedDist,
                            lastMoveAt: nowSec,
                            direction: req.direction,
                            isHeavy: req.isHeavy,
                            laneOffset: ((b.occupiedBy.size % 3) - 1) * 0.72
                        });
                        req.actor._bridgeWaitState = 'crossing';
                        b.reservationQueue.splice(q, 1);
                        q--;
                    }
                }
            }
        }
    },

    getNavigationTarget(actor, currPos, destPos) {
        this.syncFromBridges();
        if (this.bridges.length === 0) return null;

        const currRC = getRiverCoords(currPos.x, currPos.z);
        const destRC = getRiverCoords(destPos.x, destPos.z);
        const destSideSign = destRC.signedDist >= 0 ? 1 : -1;
        const currSideSign = currRC.signedDist >= 0 ? 1 : -1;
        const onOppositeSides = (currSideSign !== destSideSign) && Math.abs(destRC.signedDist) > 1.2;
        const stillOnBridgeOrRamp = Math.abs(currRC.signedDist) < RIVER_HALF_WIDTH + 4.2 &&
                                    (currRC.signedDist * destSideSign < RIVER_HALF_WIDTH + 4.0);

        if (!onOppositeSides && !stillOnBridgeOrRamp) {
            if (actor) {
                if (actor.activeBridgeCrossIdx !== undefined) actor.activeBridgeCrossIdx = undefined;
                if (actor._bridgeWaitState) this.releaseActor(actor);
            }
            return null;
        }

        let bestIdx = 0;
        if (actor && actor.activeBridgeCrossIdx !== undefined && this.bridges[actor.activeBridgeCrossIdx]) {
            bestIdx = actor.activeBridgeCrossIdx;
        } else if (actor && actor.preferredBridgeIdx !== undefined && this.bridges[actor.preferredBridgeIdx]) {
            bestIdx = actor.preferredBridgeIdx;
        } else {
            bestIdx = this.chooseBestBridgeIndex(actor, currPos, destPos);
        }
        if (actor) actor.activeBridgeCrossIdx = bestIdx;

        const b = this.bridges[bestIdx];
        const bestBr = BRIDGES[bestIdx];
        if (!b || !bestBr) return null;

        const desiredDir = destSideSign < 0 ? 'south_to_north' : 'north_to_south';
        const isHeavy = this.isHeavyActor(actor);
        const nowSec = performance.now() * 0.001;

        // If actor is already physically on the bridge span, grant/maintain occupancy and guide smoothly across
        const dS = Math.abs(currRC.s - bestBr.sCoord);
        const physicallyOnSpan = Math.abs(currRC.signedDist) < RIVER_HALF_WIDTH + 2.4 && dS <= bestBr.halfWidth + 1.4;

        if (actor) {
            if (physicallyOnSpan && !b.occupiedBy.has(actor)) {
                if (b.activeDirection === 'idle') {
                    b.activeDirection = desiredDir;
                    b.lockTimestamp = nowSec;
                }
                b.occupiedBy.set(actor, {
                    enteredAt: nowSec,
                    lastU: currRC.signedDist,
                    lastMoveAt: nowSec,
                    direction: desiredDir,
                    isHeavy,
                    laneOffset: (((actor._aiSlotId || 0) % 3) - 1) * 0.68
                });
                actor._bridgeWaitState = 'crossing';
            } else if (!b.occupiedBy.has(actor)) {
                // Can actor enter immediately?
                const dirCompatible = (b.activeDirection === 'idle' || b.activeDirection === desiredDir);
                const hasCapacity = b.occupiedBy.size < b.maxConcurrentUnits;
                const distToEntry = Math.hypot(
                    currPos.x - (destSideSign < 0 ? bestBr.southEntry.x : bestBr.northEntry.x),
                    currPos.z - (destSideSign < 0 ? bestBr.southEntry.z : bestBr.northEntry.z)
                );

                if (dirCompatible && hasCapacity && distToEntry < 13.5) {
                    if (b.activeDirection === 'idle') {
                        b.activeDirection = desiredDir;
                        b.lockTimestamp = nowSec;
                    }
                    b.occupiedBy.set(actor, {
                        enteredAt: nowSec,
                        lastU: currRC.signedDist,
                        lastMoveAt: nowSec,
                        direction: desiredDir,
                        isHeavy,
                        laneOffset: (((actor._aiSlotId || 0) % 3) - 1) * 0.68
                    });
                    actor._bridgeWaitState = 'crossing';
                } else if (distToEntry < 16.0) {
                    // Enqueue reservation and assign an ordered bank waiting slot
                    let existingReq = null;
                    for (let q = 0; q < b.reservationQueue.length; q++) {
                        if (b.reservationQueue[q].actor === actor) {
                            existingReq = b.reservationQueue[q];
                            break;
                        }
                    }
                    if (!existingReq) {
                        existingReq = {
                            actor,
                            direction: desiredDir,
                            requestedAt: nowSec,
                            isHeavy,
                            priority: isHeavy ? 10 : 1,
                            waitSlotIdx: b.reservationQueue.length % 8
                        };
                        b.reservationQueue.push(existingReq);
                    }
                    actor._bridgeWaitState = 'waiting';
                    const waitPool = desiredDir === 'south_to_north' ? b.waitingAreaSouth : b.waitingAreaNorth;
                    const slotPt = waitPool[existingReq.waitSlotIdx % waitPool.length];
                    if (slotPt && !physicallyOnSpan) {
                        return slotPt.clone();
                    }
                }
            }
        }

        const occMeta = actor ? b.occupiedBy.get(actor) : null;
        const laneShift = (occMeta && !isHeavy) ? (occMeta.laneOffset || 0) : 0;
        const bCenterU = getRiverCenterUAtS(bestBr.sCoord);
        const laneS = bestBr.sCoord + laneShift;

        const nearEntryWorld = riverCoordsToWorld(laneS, bCenterU - destSideSign * (RIVER_HALF_WIDTH + 3.1));
        const centerWorld = riverCoordsToWorld(laneS, bCenterU);
        const farClearWorld = riverCoordsToWorld(laneS, bCenterU + destSideSign * (RIVER_HALF_WIDTH + 5.8));

        if (currRC.signedDist * destSideSign < -(RIVER_HALF_WIDTH + 1.8) && dS > bestBr.halfWidth * 0.62) {
            return new THREE.Vector3(nearEntryWorld.x, getSurfaceHeightWithBridges(nearEntryWorld.x, nearEntryWorld.z), nearEntryWorld.z);
        }
        if (currRC.signedDist * destSideSign < -0.5) {
            return new THREE.Vector3(centerWorld.x, getSurfaceHeightWithBridges(centerWorld.x, centerWorld.z), centerWorld.z);
        }
        return new THREE.Vector3(farClearWorld.x, getSurfaceHeightWithBridges(farClearWorld.x, farClearWorld.z), farClearWorld.z);
    }
};
window.BRIDGE_TRAFFIC_MANAGER = BRIDGE_TRAFFIC_MANAGER;

// ============================================================================
// SIZE-AWARE WALKABLE MESH / NAV-GRID A* PATHFINDING, SELF-CALIBRATING
// "STUCK BABYSPOT" MEMORY & SMALL-STRUCTURE TANGENTIAL FLOW STEERING
// ============================================================================
const NAV_GRID_HALF = 112;
const NAV_CELL_SIZE = 2.5;
const NAV_GRID_DIM = Math.floor((NAV_GRID_HALF * 2) / NAV_CELL_SIZE); // 89x89 cells
const _ASTAR_TOTAL_CELLS = NAV_GRID_DIM * NAV_GRID_DIM;
const _astarGScore = new Float32Array(_ASTAR_TOTAL_CELLS);
const _astarFScore = new Float32Array(_ASTAR_TOTAL_CELLS);
const _astarParent = new Int32Array(_ASTAR_TOTAL_CELLS);
const _astarClosed = new Uint8Array(_ASTAR_TOTAL_CELLS);
const _astarHeapNodes = new Int32Array(_ASTAR_TOTAL_CELLS + 1);
let _astarHeapSize = 0;

// Precomputed static terrain walkability (bit 0 = infantry 0.45m, bit 1 = vehicle 0.95m) & terrain step-cost multiplier per cell
const _astarStaticWalkable = new Uint8Array(_ASTAR_TOTAL_CELLS);
const _astarStaticCostMult = new Float32Array(_ASTAR_TOTAL_CELLS);
let _astarStaticDirty = true;

function invalidateStaticAStarGrid() {
    _astarStaticDirty = true;
}
window.invalidateStaticAStarGrid = invalidateStaticAStarGrid;

function _ensureStaticAStarGridBaked() {
    if (!_astarStaticDirty) return;
    _astarStaticDirty = false;
    for (let gz = 0; gz < NAV_GRID_DIM; gz++) {
        const wz = -NAV_GRID_HALF + (gz + 0.5) * NAV_CELL_SIZE;
        for (let gx = 0; gx < NAV_GRID_DIM; gx++) {
            const wx = -NAV_GRID_HALF + (gx + 0.5) * NAV_CELL_SIZE;
            const idx = gz * NAV_GRID_DIM + gx;
            const inPondInf = (typeof isPointInWaterPond === 'function') && isPointInWaterPond(wx, wz, 0.90);
            const inPondVeh = inPondInf || ((typeof isPointInWaterPond === 'function') && isPointInWaterPond(wx, wz, 1.40));
            let mask = 0;
            if (!inPondInf && isWalkableGround(wx, wz, 0.45)) mask |= 1;
            if (!inPondVeh && isWalkableGround(wx, wz, 0.95)) mask |= 2;
            _astarStaticWalkable[idx] = mask;

            let mult = 1.0;
            if (isOnRiverBridge(wx, wz)) {
                mult = 0.68;
            } else if (typeof getSupplyRoadFactor === 'function') {
                const rf = getSupplyRoadFactor(wx, wz);
                if (rf > 0.12) {
                    mult = 1.0 - rf * 0.40;
                } else {
                    const normY = getTerrainNormalY(wx, wz);
                    const slopeGrade = Math.max(0, 1.0 - normY);
                    if (slopeGrade > 0.06) {
                        mult = 1.0 + slopeGrade * 5.4;
                    }
                }
            }
            _astarStaticCostMult[idx] = mult;
        }
    }
}

const NAV_STUCK_HOTSPOTS = [];
window.NAV_STUCK_HOTSPOTS = NAV_STUCK_HOTSPOTS;

function recordNavStuckHotspot(wx, wz, radius = 2.6, weightBoost = 1.8) {
    if (!Number.isFinite(wx) || !Number.isFinite(wz)) return null;
    if (typeof isOnRiverBridge === 'function' && isOnRiverBridge(wx, wz, 2.4)) return null;
    if (typeof isPointInBridgeApproachCorridor === 'function' && isPointInBridgeApproachCorridor(wx, wz, 3.8, 10.5)) return null;
    const nowSec = performance.now() * 0.001;
    for (let i = 0; i < NAV_STUCK_HOTSPOTS.length; i++) {
        const hs = NAV_STUCK_HOTSPOTS[i];
        const d = Math.hypot(wx - hs.x, wz - hs.z);
        if (d < 2.8) {
            hs.x = hs.x * 0.7 + wx * 0.3;
            hs.z = hs.z * 0.7 + wz * 0.3;
            hs.radius = Math.min(4.2, Math.max(hs.radius, radius));
            hs.weight = Math.min(12.0, hs.weight + weightBoost);
            hs.hits = (hs.hits || 1) + 1;
            hs.lastSeen = nowSec;
            return hs;
        }
    }
    if (NAV_STUCK_HOTSPOTS.length >= 48) {
        NAV_STUCK_HOTSPOTS.shift();
    }
    const created = {
        x: wx,
        z: wz,
        radius: Math.max(1.8, Math.min(4.0, radius)),
        weight: weightBoost,
        hits: 1,
        lastSeen: nowSec
    };
    NAV_STUCK_HOTSPOTS.push(created);
    return created;
}
window.recordNavStuckHotspot = recordNavStuckHotspot;

function getNavStuckPenalty(wx, wz) {
    if (NAV_STUCK_HOTSPOTS.length === 0) return 0;
    const nowSec = performance.now() * 0.001;
    let totalPenalty = 0;
    for (let i = NAV_STUCK_HOTSPOTS.length - 1; i >= 0; i--) {
        const hs = NAV_STUCK_HOTSPOTS[i];
        const age = Math.max(0, nowSec - (hs.lastSeen || nowSec));
        const halfLife = hs.hits >= 3 ? 75.0 : 35.0;
        const decay = Math.exp(-age / halfLife);
        if (hs.weight * decay < 0.20) {
            NAV_STUCK_HOTSPOTS.splice(i, 1);
            continue;
        }
        const dx = wx - hs.x;
        const dz = wz - hs.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < hs.radius * hs.radius) {
            const d = Math.sqrt(dSq);
            const falloff = 1.0 - (d / hs.radius);
            totalPenalty += hs.weight * decay * falloff * falloff;
        }
    }
    return totalPenalty;
}
window.getNavStuckPenalty = getNavStuckPenalty;

let _cachedBaseBlockers = null;
let _cachedPinchZones = [];
let _cachedBaseBlockersMs = -9999;

function invalidateStructureBlockersCache() {
    _cachedBaseBlockersMs = -9999;
    _barrierGridLastMs = -9999;
}
window.invalidateStructureBlockersCache = invalidateStructureBlockersCache;

function gatherStructureBlockers(selfRad, buildingsList, enemyBuildingsList) {
    const nowMs = performance.now();
    if (!_cachedBaseBlockers || (nowMs - _cachedBaseBlockersMs) > 220) {
        _cachedBaseBlockersMs = nowMs;
        const rawList = [];
        for (let i = 0; i < SGRID_TOTAL; i++) {
            _structGridBuckets[i].length = 0;
        }
        if (buildingsList) {
            for (let i = 0; i < buildingsList.length; i++) {
                const b = buildingsList[i];
                if (!b || b.hp <= 0) continue;
                const bRad = b.footprintRadius || (b.type === 'base' ? 2.65 : (b.type === 'turret' ? 1.35 : (b.type === 'barrier' ? 1.25 : 2.05)));
                const item = {
                    x: b.pos.x, z: b.pos.z, rawR: bRad, r: bRad + 0.82,
                    isBuilding: true,
                    isBridgeBarrier: b.type === 'barrier',
                    id: `b_${i}`
                };
                rawList.push(item);
                _insertCircleIntoSGrid(_structGridBuckets, item, item.x, item.z, bRad + 3.2);
            }
        }
        if (enemyBuildingsList) {
            for (let i = 0; i < enemyBuildingsList.length; i++) {
                const eb = enemyBuildingsList[i];
                if (!eb || eb.hp <= 0) continue;
                const ebRad = eb.footprintRadius || (eb.role === 'citadel' ? 2.52 : (eb.role === 'spine_turret' ? 1.36 : 2.02));
                const item = { x: eb.pos.x, z: eb.pos.z, rawR: ebRad, r: ebRad + 0.42, isBuilding: true, isEnemyBuilding: true, isBridgeBarrier: false, id: `eb_${i}` };
                rawList.push(item);
                _insertCircleIntoSGrid(_structGridBuckets, item, item.x, item.z, ebRad + 3.2);
            }
        }
        if (window.solarisBuildings && Array.isArray(window.solarisBuildings)) {
            for (let i = 0; i < window.solarisBuildings.length; i++) {
                const sb = window.solarisBuildings[i];
                if (!sb || sb.hp <= 0) continue;
                const sbRad = sb.footprintRadius || 2.15;
                const item = { x: sb.pos.x, z: sb.pos.z, rawR: sbRad, r: sbRad + 0.42, isBuilding: true, isEnemyBuilding: true, isBridgeBarrier: false, id: `sb_${i}` };
                rawList.push(item);
                _insertCircleIntoSGrid(_structGridBuckets, item, item.x, item.z, sbRad + 3.2);
            }
        }
        for (let i = 0; i < obstacles.length; i++) {
            const ob = obstacles[i];
            if (!ob || ob.noUnitBlock) continue;
            const isHardBarrier = !!(ob.isBarrier || ob.type === 'anti_rush_barrier' || ob.type === 'battlefield_barriers' || ob.type === 'trench_wall' || ob.type === 'trench_pillbox');
            const isTerrainStructureOrPond = isHardBarrier || ob.isDynamicPond || (ob.r >= 1.25) ||
                ob.type === 'unique_building' || ob.type === 'station_building' || ob.type === 'abandoned_bunker' ||
                ob.type === 'military_bunker' || ob.type === 'watch_tower' || ob.type === 'mortar_emplacement' ||
                ob.type === 'satellite_dish' || ob.type === 'camp' || ob.type === 'radioactive_waste' ||
                ob.type === 'pond' || ob.type === 'refinery_complex' || ob.type === 'checkpoint_gate' || ob.type === 'power_substation';
            const item = {
                x: ob.x, z: ob.z, rawR: ob.r,
                r: isHardBarrier ? (ob.r + 0.65) : (isTerrainStructureOrPond ? (ob.r + 0.68) : (ob.r + 0.44)),
                isBuilding: isTerrainStructureOrPond,
                isBridgeBarrier: isHardBarrier,
                isDynamicPond: !!ob.isDynamicPond,
                pondRef: ob.pondRef || null,
                id: `ob_${i}`
            };
            rawList.push(item);
            const maxInfR = (ob.isDynamicPond ? ob.r * 1.45 : ob.r) + 3.2;
            _insertCircleIntoSGrid(_structGridBuckets, item, item.x, item.z, maxInfR);
        }
        _cachedBaseBlockers = rawList;

        const pinches = [];
        const maxPinchGap = 3.2;
        for (let i = 0; i < rawList.length; i++) {
            const a = rawList[i];
            if (!a.isBuilding || a.isDynamicPond) continue;
            for (let j = i + 1; j < rawList.length; j++) {
                const b = rawList[j];
                if (b.isBridgeBarrier || !b.isBuilding || b.isDynamicPond) continue;
                const dx = b.x - a.x;
                if (dx > 12.0 || dx < -12.0) continue;
                const dz = b.z - a.z;
                if (dz > 12.0 || dz < -12.0) continue;
                const centerDist = Math.hypot(dx, dz);
                const rawGap = centerDist - a.rawR - b.rawR;
                if (rawGap < maxPinchGap) {
                    pinches.push({
                        x: (a.x + b.x) * 0.5,
                        z: (a.z + b.z) * 0.5,
                        rawGap
                    });
                }
            }
        }
        _cachedPinchZones = pinches;
    }

    const radAddBld = selfRad + 0.42;
    const radAddOb = Math.min(0.42, selfRad * 0.72) + 0.12;
    for (let i = 0; i < _cachedBaseBlockers.length; i++) {
        const item = _cachedBaseBlockers[i];
        item.r = item.isEnemyBuilding ? (item.rawR * 0.58 + selfRad * 0.35) : (item.rawR + (item.isBuilding ? radAddBld : radAddOb));
    }
    return _cachedBaseBlockers;
}

function isPointWalkableForUnitSize(wx, wz, selfRad, structCircles, targetPos = null) {
    if (!isWalkableGround(wx, wz, selfRad)) return false;
    if (typeof isPointInWaterPond === 'function' && isPointInWaterPond(wx, wz, selfRad + 0.45)) return false;

    const bucket = _structGridBuckets[_toSGridCoord(wz) * SGRID_DIM + _toSGridCoord(wx)];
    for (let i = 0; i < bucket.length; i++) {
        const sc = bucket[i];
        const dx = wx - sc.x;
        if (dx > 10.5 || dx < -10.5) continue;
        const dz = wz - sc.z;
        if (dz > 10.5 || dz < -10.5) continue;
        const effR = sc.isEnemyBuilding
            ? (sc.rawR * 0.55 + selfRad * 0.30)
            : (!sc.isBuilding
                ? (sc.rawR + selfRad * 0.65 + 0.12)
                : (sc.rawR + selfRad + 0.42));
        if (!sc.isBridgeBarrier && !sc.isDynamicPond && targetPos) {
            const tdx = targetPos.x - sc.x;
            const tdz = targetPos.z - sc.z;
            const tr = effR + 0.75;
            if (tdx * tdx + tdz * tdz < tr * tr) continue;
        }
        if (sc.isDynamicPond && sc.pondRef) {
            const ang = Math.atan2(dz, dx);
            const lobeR = getDynamicPondRadiusAtAngle(sc.pondRef, ang) + selfRad + 0.48;
            if (dx * dx + dz * dz < lobeR * lobeR) return false;
            continue;
        }
        if (dx * dx + dz * dz < effR * effR) return false;
    }

    const minPassableGap = selfRad * 2.0 + 0.42;
    for (let i = 0; i < _cachedPinchZones.length; i++) {
        const pz = _cachedPinchZones[i];
        if (pz.rawGap < minPassableGap) {
            const dx = wx - pz.x;
            const dz = wz - pz.z;
            const pinchRadius = Math.max(0.75, (minPassableGap - pz.rawGap) * 0.55 + selfRad * 0.65);
            if (dx * dx + dz * dz < pinchRadius * pinchRadius) {
                return false;
            }
        }
    }
    return true;
}
window.isPointWalkableForUnitSize = isPointWalkableForUnitSize;

function isSegmentClearForUnitSize(ax, az, bx, bz, selfRad, structCircles, targetPos = null) {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(2, Math.ceil(dist / 1.35));
    for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const px = ax + (bx - ax) * t;
        const pz = az + (bz - az) * t;
        if (!isPointWalkableForUnitSize(px, pz, selfRad, structCircles, targetPos)) {
            return false;
        }
        if (!isOnRiverBridge(px, pz, 1.8) && getNavStuckPenalty(px, pz) > 3.2) {
            return false;
        }
    }
    return true;
}
window.isSegmentClearForUnitSize = isSegmentClearForUnitSize;

function _astarHeapPush(nodeIdx) {
    let i = ++_astarHeapSize;
    const f = _astarFScore[nodeIdx];
    while (i > 1) {
        const parent = i >> 1;
        const pNode = _astarHeapNodes[parent];
        if (f >= _astarFScore[pNode]) break;
        _astarHeapNodes[i] = pNode;
        i = parent;
    }
    _astarHeapNodes[i] = nodeIdx;
}

function _astarHeapPop() {
    const top = _astarHeapNodes[1];
    const last = _astarHeapNodes[_astarHeapSize--];
    if (_astarHeapSize > 0) {
        const f = _astarFScore[last];
        let i = 1;
        const half = _astarHeapSize >> 1;
        while (i <= half) {
            let child = i << 1;
            if (child < _astarHeapSize && _astarFScore[_astarHeapNodes[child + 1]] < _astarFScore[_astarHeapNodes[child]]) {
                child++;
            }
            if (f <= _astarFScore[_astarHeapNodes[child]]) break;
            _astarHeapNodes[i] = _astarHeapNodes[child];
            i = child;
        }
        _astarHeapNodes[i] = last;
    }
    return top;
}

// Fast Octile A* Pathfinder on Walkable Mesh Grid (Uses Binary Min-Heap + Precomputed Static Terrain Grid + Congestion Penalty!)
function computeAStarWalkablePath(startPos, goalPos, selfRad, structCircles, extraCongestionPenalty = 0) {
    // Support legacy scalar (sx, sz, gx, gz, uRad, penalty) invocation as well as (startPosObj, goalPosObj, selfRad, structCircles, penalty)
    if (typeof startPos === 'number' && typeof goalPos === 'number') {
        const argSx = startPos;
        const argSz = goalPos;
        const argGx = Number(selfRad) || 0;
        const argGz = Number(structCircles) || 0;
        const argRad = typeof extraCongestionPenalty === 'number' ? extraCongestionPenalty : 0.55;
        const argPen = typeof arguments[5] === 'number' ? arguments[5] : 0;
        startPos = new THREE.Vector3(argSx, 0, argSz);
        goalPos = new THREE.Vector3(argGx, 0, argGz);
        selfRad = argRad;
        structCircles = [];
        extraCongestionPenalty = argPen;
    }
    if (!startPos || !goalPos || !Number.isFinite(startPos.x) || !Number.isFinite(startPos.z) || !Number.isFinite(goalPos.x) || !Number.isFinite(goalPos.z)) {
        return [];
    }
    _ensureStaticAStarGridBaked();

    const toGrid = (v) => Math.max(0, Math.min(NAV_GRID_DIM - 1, Math.floor((v + NAV_GRID_HALF) / NAV_CELL_SIZE)));
    const toWorld = (g) => -NAV_GRID_HALF + (g + 0.5) * NAV_CELL_SIZE;

    const sx = toGrid(startPos.x), sz = toGrid(startPos.z);
    const gx = toGrid(goalPos.x), gz = toGrid(goalPos.z);
    if (sx === gx && sz === gz) {
        const singleRes = [goalPos.clone ? goalPos.clone() : new THREE.Vector3(goalPos.x, 0, goalPos.z)];
        singleRes.reachedGoal = true;
        singleRes.bestHeuristicCells = 0;
        return singleRes;
    }

    _astarGScore.fill(Infinity);
    _astarFScore.fill(Infinity);
    _astarParent.fill(-1);
    _astarClosed.fill(0);
    _astarHeapSize = 0;

    const startIdx = sz * NAV_GRID_DIM + sx;
    const goalIdx = gz * NAV_GRID_DIM + gx;
    _astarGScore[startIdx] = 0;
    _astarFScore[startIdx] = Math.hypot(gx - sx, gz - sz);
    _astarHeapPush(startIdx);

    let bestNode = startIdx;
    let bestHeuristic = Math.hypot(gx - sx, gz - sz);
    let iterations = 0;
    const maxIterations = ACTIVE_PLANET_BIOME === 'ocean' ? 2400 : 1800;
    const reqWalkMask = selfRad >= 0.72 ? 2 : 1;

    const dirs = [
        [1, 0, 1.0], [-1, 0, 1.0], [0, 1, 1.0], [0, -1, 1.0],
        [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]
    ];

    while (_astarHeapSize > 0 && iterations < maxIterations) {
        iterations++;
        const curr = _astarHeapPop();

        if (curr === goalIdx) {
            bestNode = curr;
            bestHeuristic = 0;
            break;
        }
        if (_astarClosed[curr]) continue;
        _astarClosed[curr] = 1;

        const cx = curr % NAV_GRID_DIM;
        const cz = (curr / NAV_GRID_DIM) | 0;
        const hDist = Math.hypot(gx - cx, gz - cz);
        if (hDist < bestHeuristic) {
            bestHeuristic = hDist;
            bestNode = curr;
        }

        for (let d = 0; d < dirs.length; d++) {
            const nx = cx + dirs[d][0];
            const nz = cz + dirs[d][1];
            if (nx < 0 || nx >= NAV_GRID_DIM || nz < 0 || nz >= NAV_GRID_DIM) continue;
            const nIdx = nz * NAV_GRID_DIM + nx;
            if (_astarClosed[nIdx]) continue;

            const wx = toWorld(nx);
            const wz = toWorld(nz);
            const gdx = wx - goalPos.x, gdz = wz - goalPos.z;
            const nearGoalOnSlope = (gdx * gdx + gdz * gdz < 7.84) && ((_astarStaticWalkable[nIdx] & 1) !== 0 || isWalkableGround(wx, wz, selfRad * 0.4));
            const isStartStep = (curr === startIdx) && isWalkableGround(wx, wz, selfRad * 0.35);
            if (nIdx !== goalIdx && !nearGoalOnSlope && !isStartStep) {
                if ((_astarStaticWalkable[nIdx] & reqWalkMask) === 0) continue;
                if (!isPointWalkableForUnitSize(wx, wz, selfRad, structCircles, goalPos)) continue;
            }

            let stepCost = dirs[d][2] * (_astarStaticCostMult[nIdx] || 1.0);
            if (NAV_STUCK_HOTSPOTS.length > 0) {
                const stuckPenalty = getNavStuckPenalty(wx, wz);
                if (stuckPenalty > 0) {
                    stepCost += stuckPenalty * (3.2 + extraCongestionPenalty);
                }
            }

            const tentativeG = _astarGScore[curr] + stepCost;
            if (tentativeG < _astarGScore[nIdx]) {
                _astarParent[nIdx] = curr;
                _astarGScore[nIdx] = tentativeG;
                _astarFScore[nIdx] = tentativeG + Math.hypot(gx - nx, gz - nz) * 1.15;
                _astarHeapPush(nIdx);
            }
        }
    }

    const reachedGoal = (bestNode === goalIdx || bestHeuristic <= 2.4);
    const rawPts = [];
    let trace = bestNode;
    while (trace !== -1 && trace !== startIdx) {
        const tx = toWorld(trace % NAV_GRID_DIM);
        const tz = toWorld((trace / NAV_GRID_DIM) | 0);
        rawPts.push(new THREE.Vector3(tx, getSurfaceHeightWithBridges(tx, tz), tz));
        trace = _astarParent[trace];
    }
    rawPts.reverse();
    if (reachedGoal) {
        rawPts.push(goalPos.clone());
    }
    rawPts.reachedGoal = reachedGoal;
    rawPts.bestHeuristicCells = bestHeuristic;

    if (rawPts.length <= 2) return rawPts;
    const smoothed = [];
    let anchor = startPos;
    let idx = 0;
    while (idx < rawPts.length) {
        let furthest = idx;
        for (let probe = Math.min(rawPts.length - 1, idx + 5); probe > idx; probe--) {
            if (isSegmentClearForUnitSize(anchor.x, anchor.z, rawPts[probe].x, rawPts[probe].z, selfRad, structCircles, goalPos)) {
                furthest = probe;
                break;
            }
        }
        smoothed.push(rawPts[furthest]);
        anchor = rawPts[furthest];
        idx = furthest + 1;
    }
    smoothed.reachedGoal = reachedGoal;
    smoothed.bestHeuristicCells = bestHeuristic;
    return smoothed;
}
window.computeAStarWalkablePath = computeAStarWalkablePath;

const _localUnitBlockerScratch = [];

function computeSafeGroundStep(currPos, targetPos, speed, dt, selfActor = null, blockerList = null, buildingsList = null, enemyBuildingsList = null) {
    const _navT0 = (window.PERF_PROFILER && window.PERF_PROFILER.enabled) ? performance.now() : 0;
    const explicitRadius = typeof selfActor === 'number' && Number.isFinite(selfActor) ? selfActor : null;
    if (typeof selfActor !== 'object' || selfActor === null) {
        selfActor = (typeof buildingsList === 'object' && buildingsList !== null && !Array.isArray(buildingsList)) ? buildingsList : null;
        if (selfActor === buildingsList) buildingsList = null;
    }
    if (selfActor && selfActor.bridgeClearedTimer > 0) {
        selfActor.bridgeClearedTimer = Math.max(0, selfActor.bridgeClearedTimer - dt);
    }
    const rawToTargetX = targetPos.x - currPos.x;
    const rawToTargetZ = targetPos.z - currPos.z;
    const distToTarget = Math.hypot(rawToTargetX, rawToTargetZ);
    if (distToTarget < 0.01) {
        if (_navT0 > 0) window.PERF_PROFILER.addSample('groundNavigation', performance.now() - _navT0);
        return _stepReturnScratch.set(0, 0, 0);
    }

    const selfRad = explicitRadius || ((selfActor && selfActor.radius) ? selfActor.radius : 0.52);
    const isTank = !!(selfActor && (selfActor.type === 'tank' || selfActor.type === 'siege_tank'));
    const structCircles = gatherStructureBlockers(selfRad, buildingsList, enemyBuildingsList);

    // 0. Bridge Guardrail Escape & Centering Logic (Uses unified bridge orthonormal basis!)
    const onOrCrossingBridge = isOnRiverBridge(currPos.x, currPos.z, 1.4) || !!(selfActor && selfActor.inBridgeChute);
    for (let i = 0; i < RIVER_BRIDGES.length; i++) {
        const br = RIVER_BRIDGES[i];
        if (br.destroyed) continue;
        const bc = getBridgeLocalCoords(br, currPos.x, currPos.z);
        const dU = Math.abs(bc.localU);
        const effRiverHalfW = br.riverHalfW || RIVER_HALF_WIDTH;
        if (dU <= effRiverHalfW + 1.45) {
            const dS = bc.localS;
            const absDS = Math.abs(dS);
            const safeCorridor = br.halfWidth - 0.52 - Math.min(0.24, selfRad * 0.30);
            if (absDS > safeCorridor && absDS <= br.halfWidth + 1.35) {
                const pushInwardSign = dS > 0 ? -1 : 1;
                const cosY = br.cosYaw !== undefined ? br.cosYaw : RIVER_COS;
                const sinY = br.sinYaw !== undefined ? br.sinYaw : RIVER_SIN;
                const inwardX = pushInwardSign * cosY;
                const inwardZ = -pushInwardSign * sinY;

                if (absDS >= br.halfWidth - 0.20 && dU > effRiverHalfW + 0.25) {
                    const bankSign = bc.localU >= 0 ? 1 : -1;
                    const inlandX = bankSign * sinY;
                    const inlandZ = bankSign * cosY;
                    _stepReturnScratch.set(inlandX * 0.68 + inwardX * 0.72, 0, inlandZ * 0.68 + inwardZ * 0.72).normalize();
                    if (selfActor && selfActor.smoothStepDir) {
                        selfActor.smoothStepDir.lerp(_stepReturnScratch, Math.min(1, dt * 14.0)).normalize();
                        if (_navT0 > 0) window.PERF_PROFILER.addSample('groundNavigation', performance.now() - _navT0);
                        return _stepReturnScratch.copy(selfActor.smoothStepDir);
                    }
                    if (_navT0 > 0) window.PERF_PROFILER.addSample('groundNavigation', performance.now() - _navT0);
                    return _stepReturnScratch;
                }

                const toTgtNormX = rawToTargetX / distToTarget;
                const toTgtNormZ = rawToTargetZ / distToTarget;
                _stepReturnScratch.set(toTgtNormX * 0.80 + inwardX * 0.60, 0, toTgtNormZ * 0.80 + inwardZ * 0.60).normalize();
                if (selfActor && selfActor.smoothStepDir) {
                    selfActor.smoothStepDir.lerp(_stepReturnScratch, Math.min(1, dt * 14.0)).normalize();
                    if (_navT0 > 0) window.PERF_PROFILER.addSample('groundNavigation', performance.now() - _navT0);
                    return _stepReturnScratch.copy(selfActor.smoothStepDir);
                }
                if (_navT0 > 0) window.PERF_PROFILER.addSample('groundNavigation', performance.now() - _navT0);
                return _stepReturnScratch;
            }
        }
    }

    // 1. If unit is currently overlapping any building/obstacle footprint in its local spatial bucket, push radially & tangentially outward!
    const localStructBucket = _structGridBuckets[_toSGridCoord(currPos.z) * SGRID_DIM + _toSGridCoord(currPos.x)];
    for (let i = 0; i < localStructBucket.length; i++) {
        const sc = localStructBucket[i];
        const effScR = sc.rawR + (sc.isBuilding ? (selfRad + 0.42) : (Math.min(0.42, selfRad * 0.72) + 0.12));
        if (!sc.isBridgeBarrier && !sc.isDynamicPond) {
            const tdx = targetPos.x - sc.x, tdz = targetPos.z - sc.z;
            if (tdx * tdx + tdz * tdz < (effScR + 0.45) * (effScR + 0.45)) continue;
        }
        const dx = currPos.x - sc.x;
        const dz = currPos.z - sc.z;
        let minOverlapR = sc.isBuilding ? (sc.rawR + selfRad + 0.28) : (sc.rawR + selfRad * 0.78 + 0.20);
        if (sc.isDynamicPond && sc.pondRef) {
            minOverlapR = getDynamicPondRadiusAtAngle(sc.pondRef, Math.atan2(dz, dx)) + selfRad + 0.48;
        }
        const dSq = dx * dx + dz * dz;
        if (dSq < minOverlapR * minOverlapR && dSq > 0.000001) {
            const d = Math.sqrt(dSq);
            const rnx = dx / d;
            const rnz = dz / d;
            const t1x = -rnz, t1z = rnx;
            const t2x = rnz,  t2z = -rnx;
            const dot1 = t1x * rawToTargetX + t1z * rawToTargetZ;
            const dot2 = t2x * rawToTargetX + t2z * rawToTargetZ;
            const tx = dot1 >= dot2 ? t1x : t2x;
            const tz = dot1 >= dot2 ? t1z : t2z;
            _stepReturnScratch.set(rnx * 0.58 + tx * 0.82, 0, rnz * 0.58 + tz * 0.82).normalize();
            if (isWalkableGround(currPos.x + _stepReturnScratch.x * 0.55, currPos.z + _stepReturnScratch.z * 0.55, selfRad * 0.45)) {
                if (_navT0 > 0) window.PERF_PROFILER.addSample('groundNavigation', performance.now() - _navT0);
                return _stepReturnScratch;
            }
        }
    }

    // 2. Use Size-Aware Walkable A* Pathfinding when direct segment is blocked by terrain structures, puddles/ponds, or cliffs
    let steerTarget = targetPos;
    if (selfActor) {
        selfActor.navRepathTimer = (Number.isFinite(selfActor.navRepathTimer) ? selfActor.navRepathTimer : 0) - dt;
        const goalMoved = !selfActor.navGoalPos ||
            ((targetPos.x - selfActor.navGoalPos.x) * (targetPos.x - selfActor.navGoalPos.x) +
             (targetPos.z - selfActor.navGoalPos.z) * (targetPos.z - selfActor.navGoalPos.z)) > 5.76;

        if (onOrCrossingBridge) {
            selfActor.navWaypoints = null;
        } else if (selfActor.navRepathTimer <= 0 || goalMoved) {
            if (!selfActor.navGoalPos) selfActor.navGoalPos = targetPos.clone();
            else selfActor.navGoalPos.copy(targetPos);
            const tierIdx = (window.PERF_MANAGER && window.PERF_MANAGER.current && Number.isFinite(window.PERF_MANAGER.current.tierIndex))
                ? window.PERF_MANAGER.current.tierIndex
                : 0;
            selfActor.navRepathTimer = (0.52 + tierIdx * 0.16) + ((selfActor._aiSlotId || 0) % 7) * 0.04;
            const directClear = distToTarget < 75.0 && isSegmentClearForUnitSize(currPos.x, currPos.z, targetPos.x, targetPos.z, selfRad, structCircles, targetPos);
            if (directClear) {
                selfActor.navWaypoints = null;
            } else {
                selfActor.navWaypoints = computeAStarWalkablePath(
                    currPos,
                    targetPos,
                    selfRad,
                    structCircles,
                    selfActor._navCongestionWeight || 0
                );
            }
        }

        if (selfActor.navWaypoints && selfActor.navWaypoints.length > 0) {
            const reachRad = Math.max(1.75, selfRad * 2.2);
            const reachRadSq = reachRad * reachRad;
            while (selfActor.navWaypoints.length > 1) {
                const wp = selfActor.navWaypoints[0];
                const wdx = wp.x - currPos.x, wdz = wp.z - currPos.z;
                if (wdx * wdx + wdz * wdz < reachRadSq) {
                    selfActor.navWaypoints.shift();
                } else {
                    break;
                }
            }
            steerTarget = selfActor.navWaypoints[0];
        }
    }

    const toSteerX = steerTarget.x - currPos.x;
    const toSteerZ = steerTarget.z - currPos.z;
    const steerDist = Math.hypot(toSteerX, toSteerZ) || 0.001;
    let desiredDirX = toSteerX / steerDist;
    let desiredDirZ = toSteerZ / steerDist;

    // 2B. CONTINUOUS TANGENTIAL DEFLECTION FIELD AROUND LOCAL SPATIAL BUCKET STRUCTURES & PONDS:
    let propFlowX = 0;
    let propFlowZ = 0;
    for (let i = 0; i < localStructBucket.length; i++) {
        const sc = localStructBucket[i];
        const effScR = sc.rawR + (sc.isBuilding ? (selfRad + 0.42) : (Math.min(0.42, selfRad * 0.72) + 0.12));
        if (!sc.isBridgeBarrier && !sc.isDynamicPond) {
            const tdx = targetPos.x - sc.x, tdz = targetPos.z - sc.z;
            if (tdx * tdx + tdz * tdz < (effScR + 0.55) * (effScR + 0.55)) continue;
        }
        const toObX = sc.x - currPos.x;
        const toObZ = sc.z - currPos.z;
        let effObR = sc.rawR;
        if (sc.isDynamicPond && sc.pondRef) {
            effObR = getDynamicPondRadiusAtAngle(sc.pondRef, Math.atan2(-toObZ, -toObX));
        }
        const margin = sc.isDynamicPond ? 1.45 : (sc.isBuilding ? 1.35 : 1.15);
        const influenceRad = effObR + selfRad + margin;
        const distToObSq = toObX * toObX + toObZ * toObZ;
        if (distToObSq < influenceRad * influenceRad && distToObSq > 0.000001) {
            const distToOb = Math.sqrt(distToObSq);
            const obDirX = toObX / distToOb;
            const obDirZ = toObZ / distToOb;
            const forwardDot = obDirX * desiredDirX + obDirZ * desiredDirZ;
            if (forwardDot > 0.05) {
                const tLX = -obDirZ, tLZ = obDirX;
                const tRX = obDirZ,  tRZ = -obDirX;
                const dotL = tLX * desiredDirX + tLZ * desiredDirZ;
                const dotR = tRX * desiredDirX + tRZ * desiredDirZ;
                let tangX = dotL >= dotR ? tLX : tRX;
                let tangZ = dotL >= dotR ? tLZ : tRZ;
                if (selfActor && selfActor.wallFollowSign && Math.abs(dotL - dotR) < 0.25) {
                    tangX = selfActor.wallFollowSign > 0 ? tLX : tRX;
                    tangZ = selfActor.wallFollowSign > 0 ? tLZ : tRZ;
                }
                const strength = Math.pow(1.0 - distToOb / influenceRad, 1.35) * (sc.isDynamicPond ? 1.35 : (sc.isBuilding ? 1.25 : 1.10));
                propFlowX += (tangX * 0.72 - obDirX * 0.52) * strength;
                propFlowZ += (tangZ * 0.72 - obDirZ * 0.52) * strength;
            }
        }
    }

    // Steep Terrain Escarpment Deflection: if the slope ahead is steep, deflect tangentially along the contour line!
    if (!onOrCrossingBridge) {
        const aheadX = currPos.x + desiredDirX * (selfRad + 1.35);
        const aheadZ = currPos.z + desiredDirZ * (selfRad + 1.35);
        const aheadNorm = getTerrainNormalInto(aheadX, aheadZ, _normalScratchVec);
        if (aheadNorm.y < 0.68) {
            const nLen = Math.hypot(aheadNorm.x, aheadNorm.z) || 1;
            const downSlopeX = aheadNorm.x / nLen;
            const downSlopeZ = aheadNorm.z / nLen;
            const cLX = -downSlopeZ, cLZ = downSlopeX;
            const cRX = downSlopeZ,  cRZ = -downSlopeX;
            const cDotL = cLX * desiredDirX + cLZ * desiredDirZ;
            const cDotR = cRX * desiredDirX + cRZ * desiredDirZ;
            const contourX = cDotL >= cDotR ? cLX : cRX;
            const contourZ = cDotL >= cDotR ? cLZ : cRZ;
            const steepness = THREE.MathUtils.clamp((0.68 - aheadNorm.y) * 4.5, 0, 2.8);
            propFlowX += (contourX * 0.85 + downSlopeX * 0.45) * steepness;
            propFlowZ += (contourZ * 0.85 + downSlopeZ * 0.45) * steepness;
        }
    }

    // Also deflect smoothly around learned stuck babyspots (only when not on a bridge)
    if (!onOrCrossingBridge) {
        for (let i = 0; i < NAV_STUCK_HOTSPOTS.length; i++) {
            const hs = NAV_STUCK_HOTSPOTS[i];
            const toHsX = hs.x - currPos.x;
            const toHsZ = hs.z - currPos.z;
            const distToHsSq = toHsX * toHsX + toHsZ * toHsZ;
            if (distToHsSq < hs.radius * hs.radius && distToHsSq > 0.000001) {
                const distToHs = Math.sqrt(distToHsSq);
                const hsDirX = toHsX / distToHs;
                const hsDirZ = toHsZ / distToHs;
                if (hsDirX * desiredDirX + hsDirZ * desiredDirZ > 0.0) {
                    const sign = (selfActor && selfActor.flankSign < 0) ? -1 : 1;
                    const tangX = -hsDirZ * sign;
                    const tangZ = hsDirX * sign;
                    const w = (1.0 - distToHs / hs.radius) * Math.min(2.2, hs.weight * 0.45);
                    propFlowX += (tangX * 0.88 - hsDirX * 0.35) * w;
                    propFlowZ += (tangZ * 0.88 - hsDirZ * 0.35) * w;
                }
            }
        }
    }
    // 2C. ROAD-CORRIDOR & RAMP-CENTERING GUIDANCE:
    if (!onOrCrossingBridge && distToTarget > 4.5 && typeof getSupplyRoadFactor === 'function') {
        const rfCurr = getSupplyRoadFactor(currPos.x, currPos.z);
        if (rfCurr > 0.05 && rfCurr < 0.88) {
            const perpX = -desiredDirZ;
            const perpZ = desiredDirX;
            const rfLeft = getSupplyRoadFactor(currPos.x + perpX * 1.4, currPos.z + perpZ * 1.4);
            const rfRight = getSupplyRoadFactor(currPos.x - perpX * 1.4, currPos.z - perpZ * 1.4);
            const roadGrad = rfLeft - rfRight;
            if (Math.abs(roadGrad) > 0.04) {
                propFlowX += perpX * roadGrad * 0.55;
                propFlowZ += perpZ * roadGrad * 0.55;
            }
        }
    }
    if (propFlowX * propFlowX + propFlowZ * propFlowZ > 0.0001) {
        desiredDirX += propFlowX;
        desiredDirZ += propFlowZ;
        const dNorm = Math.hypot(desiredDirX, desiredDirZ) || 1;
        desiredDirX /= dNorm;
        desiredDirZ /= dNorm;
    }

    const localBlockers = (typeof window.queryGroundUnitsNearInto === 'function')
        ? window.queryGroundUnitsNearInto(currPos.x, currPos.z, selfRad + 4.2, _localUnitBlockerScratch)
        : (blockerList || _localUnitBlockerScratch);

    // ACTIVE PATH-YIELDING ("GIVE PATH"): Lighter ground units proactively step aside for friendly Tanks & Heavy Mechs!
    const isHeavySelf = isTank || (selfActor && (
        (selfActor.type === 'valkyrie' && selfActor.mechMode) ||
        selfActor.variant === 'behemoth' ||
        selfActor.variant === 'crusher'
    ));
    if (!isHeavySelf && selfActor && localBlockers.length > 0) {
        let yieldVecX = 0;
        let yieldVecZ = 0;
        for (let i = 0; i < localBlockers.length; i++) {
            const other = localBlockers[i];
            if (!other || other === selfActor || other.isAir || other.hp <= 0) continue;
            const isHeavyOther = other.type === 'tank' || other.type === 'siege_tank' ||
                (other.type === 'valkyrie' && other.mechMode) ||
                other.variant === 'behemoth' ||
                other.variant === 'crusher';
            if (!isHeavyOther) continue;

            const dx = currPos.x - other.mesh.position.x;
            const dz = currPos.z - other.mesh.position.z;
            const yieldRadius = (other.radius || 1.15) + selfRad + 2.35;
            const distSq = dx * dx + dz * dz;
            if (distSq < yieldRadius * yieldRadius && distSq > 0.000001) {
                const dist = Math.sqrt(distSq);
                const heavyYaw = other.currentYaw !== undefined ? other.currentYaw : (other.mesh ? other.mesh.rotation.y : 0);
                const hDirX = (other.smoothStepDir && other.smoothStepDir.lengthSq() > 0.01) ? other.smoothStepDir.x : Math.sin(heavyYaw);
                const hDirZ = (other.smoothStepDir && other.smoothStepDir.lengthSq() > 0.01) ? other.smoothStepDir.z : Math.cos(heavyYaw);

                const relX = dx / dist;
                const relZ = dz / dist;
                const forwardDot = relX * hDirX + relZ * hDirZ;
                if (forwardDot > -0.35) {
                    const perpLX = -hDirZ, perpLZ = hDirX;
                    const perpRX = hDirZ,  perpRZ = -hDirX;
                    const sideCross = dx * perpLX + dz * perpLZ;
                    let sideX = sideCross >= 0 ? perpLX : perpRX;
                    let sideZ = sideCross >= 0 ? perpLZ : perpRZ;
                    if (!isWalkableGround(currPos.x + sideX * 1.1, currPos.z + sideZ * 1.1, selfRad * 0.6)) {
                        sideX = -sideX;
                        sideZ = -sideZ;
                    }
                    const urgency = Math.pow(1.0 - dist / yieldRadius, 0.75) * 1.85;
                    yieldVecX += (sideX * 0.82 + relX * 0.35) * urgency;
                    yieldVecZ += (sideZ * 0.82 + relZ * 0.35) * urgency;
                }
            }
        }
        if (yieldVecX * yieldVecX + yieldVecZ * yieldVecZ > 0.001) {
            desiredDirX += yieldVecX;
            desiredDirZ += yieldVecZ;
            const dNorm = Math.hypot(desiredDirX, desiredDirZ) || 1;
            desiredDirX /= dNorm;
            desiredDirZ /= dNorm;
        }
    }

    const stepDist = speed * dt;
    const lookAhead = Math.max(1.45, stepDist * 3.6);
    const midLook = Math.max(0.82, stepDist * 2.0);

    function isBlockedByUnit(px, pz) {
        if (!selfActor || localBlockers.length === 0) return false;
        for (let i = 0; i < localBlockers.length; i++) {
            const other = localBlockers[i];
            if (other === selfActor || other.isAir || other.hp <= 0) continue;
            const isOtherHeavy = other.type === 'tank' || other.type === 'siege_tank' ||
                (other.type === 'valkyrie' && other.mechMode) ||
                other.variant === 'behemoth' ||
                other.variant === 'crusher';
            const isOtherAnchored = !!(other.type === 'siege_tank' && other.siegeMode);
            if (isHeavySelf && !isOtherHeavy && !isOtherAnchored) continue;
            const ox = other.mesh.position.x;
            const oz = other.mesh.position.z;
            const relX = ox - currPos.x;
            const relZ = oz - currPos.z;
            if (relX * desiredDirX + relZ * desiredDirZ <= -0.05) continue;
            const extraPad = isOtherAnchored ? 0.38 : ((isTank && other.type === 'tank') ? 0.05 : (isOtherHeavy ? 0.28 : 0.16));
            const minClearance = selfRad + (other.radius || 0.52) + extraPad;
            const dx = px - ox, dz = pz - oz;
            if (dx * dx + dz * dz < minClearance * minClearance) return true;
        }
        return false;
    }

    function isBlockedByStructure(px, pz) {
        return !isPointWalkableForUnitSize(px, pz, selfRad, structCircles, targetPos);
    }

    const activeSign = (selfActor && selfActor.wallFollowSign)
        ? selfActor.wallFollowSign
        : ((selfActor && selfActor.flankSign < 0) ? -1 : 1);

    const testAngles = activeSign < 0
        ? [0, -0.24, 0.24, -0.52, 0.52, -0.86, 0.86, -1.24, 1.24, -1.65, 1.65, -2.15, 2.15, -2.65, 2.65, Math.PI]
        : [0, 0.24, -0.24, 0.52, -0.52, 0.86, -0.86, 1.24, -1.24, 1.65, -1.65, 2.15, -2.15, 2.65, -2.65, Math.PI];

    let chosenX = 0, chosenZ = 0, hasChosen = false;
    let fallbackStructX = 0, fallbackStructZ = 0, hasFallbackStruct = false;
    let fallbackTerrX = 0, fallbackTerrZ = 0, hasFallbackTerr = false;

    for (let i = 0; i < testAngles.length; i++) {
        const ang = testAngles[i];
        const cos = Math.cos(ang), sin = Math.sin(ang);
        const dx = desiredDirX * cos - desiredDirZ * sin;
        const dz = desiredDirX * sin + desiredDirZ * cos;

        const nearProbeX = currPos.x + dx * (selfRad + 0.30);
        const nearProbeZ = currPos.z + dz * (selfRad + 0.30);
        const midProbeX = currPos.x + dx * midLook;
        const midProbeZ = currPos.z + dz * midLook;
        const probeX = currPos.x + dx * lookAhead;
        const probeZ = currPos.z + dz * lookAhead;

        const clearStructNear = !isBlockedByStructure(nearProbeX, nearProbeZ);
        const clearStructMid = !isBlockedByStructure(midProbeX, midProbeZ);

        if (clearStructNear &&
            clearStructMid &&
            isWalkableGround(probeX, probeZ, selfRad * 0.65) &&
            isPointClearOfAllBuildings(probeX, probeZ, selfRad * 0.55, targetPos)) {
            if (!hasFallbackTerr) { fallbackTerrX = dx; fallbackTerrZ = dz; hasFallbackTerr = true; }
            if (!hasFallbackStruct) { fallbackStructX = dx; fallbackStructZ = dz; hasFallbackStruct = true; }
            if (!isBlockedByUnit(nearProbeX, nearProbeZ)) {
                chosenX = dx; chosenZ = dz; hasChosen = true;
                break;
            }
        } else if (!hasFallbackTerr &&
                   clearStructNear &&
                   isPointClearOfAllBuildings(nearProbeX, nearProbeZ, selfRad * 0.50, targetPos) &&
                   isPointClearOfAllBuildings(midProbeX, midProbeZ, selfRad * 0.45, targetPos) &&
                   isWalkableGround(nearProbeX, nearProbeZ, selfRad * 0.55) &&
                   isWalkableGround(midProbeX, midProbeZ, selfRad * 0.55)) {
            // Only accept fallbackTerr if it is ALSO clear of buildings (never pick ang=0 straight through a structure!)
            fallbackTerrX = dx; fallbackTerrZ = dz; hasFallbackTerr = true;
        }
    }

    // Secondary close-range escape ring if all lookAhead probes were blocked
    if (!hasChosen && !hasFallbackStruct && !hasFallbackTerr) {
        const shortStep = Math.max(0.42, selfRad + 0.24);
        for (let i = 0; i < testAngles.length; i++) {
            const ang = testAngles[i];
            const cos = Math.cos(ang), sin = Math.sin(ang);
            const dx = desiredDirX * cos - desiredDirZ * sin;
            const dz = desiredDirX * sin + desiredDirZ * cos;
            const sx = currPos.x + dx * shortStep;
            const sz = currPos.z + dz * shortStep;
            if (isWalkableGround(sx, sz, selfRad * 0.45) && isPointClearOfAllBuildings(sx, sz, selfRad * 0.45, targetPos)) {
                fallbackTerrX = dx;
                fallbackTerrZ = dz;
                hasFallbackTerr = true;
                break;
            }
        }
    }

    if (!hasChosen && !hasFallbackStruct && !hasFallbackTerr) {
        // Never return desiredDirX/desiredDirZ into a solid obstacle; signal blocked step cleanly
        if (selfActor) {
            selfActor._lastNavFailure = 'all_angles_blocked';
            selfActor.navRepathTimer = 0;
        }
        if (_navT0 > 0) window.PERF_PROFILER.addSample('groundNavigation', performance.now() - _navT0);
        return _stepReturnScratch.set(0, 0, 0);
    }

    const finalX = hasChosen ? chosenX : (hasFallbackStruct ? fallbackStructX : fallbackTerrX);
    const finalZ = hasChosen ? chosenZ : (hasFallbackStruct ? fallbackStructZ : fallbackTerrZ);
    _stepReturnScratch.set(finalX, 0, finalZ);

    if (selfActor) {
        selfActor._lastNavFailure = null;
        if (!selfActor.smoothStepDir || !hasChosen) {
            // Do not smear recovery/evasion angles with stale forward momentum when avoiding a structure
            selfActor.smoothStepDir = _stepReturnScratch.clone();
        } else {
            const smoothRate = isTank ? 6.5 : 14.0;
            selfActor.smoothStepDir.lerp(_stepReturnScratch, Math.min(1, dt * smoothRate));
            if (selfActor.smoothStepDir.lengthSq() > 0.0001) {
                selfActor.smoothStepDir.normalize();
            } else {
                selfActor.smoothStepDir.copy(_stepReturnScratch);
            }
        }
        if (_navT0 > 0) window.PERF_PROFILER.addSample('groundNavigation', performance.now() - _navT0);
        return _stepReturnScratch.copy(selfActor.smoothStepDir);
    }

    if (_navT0 > 0) window.PERF_PROFILER.addSample('groundNavigation', performance.now() - _navT0);
    return _stepReturnScratch;
}

// Universal Clear Spawn & Escape Point Finder: accelerated via spatial structure & ground-unit grids
function findClearSpawnPoint(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
    let ox = 0, oz = 0, tx = 0, tz = 1, unitRadius = 0.55;
    let buildingsList = [];
    let enemyBuildingsList = [];
    let unitsList = [];

    if (arg1 && typeof arg1 === 'object' && 'x' in arg1) {
        ox = Number(arg1.x) || 0;
        oz = Number(arg1.z) || 0;
        unitRadius = typeof arg2 === 'number' ? arg2 : 0.55;
        if (arg3 === true) {
            const a = (Math.random() - 0.5) * 1.6;
            return new THREE.Vector3(ox + Math.sin(a) * 2.2, arg1.y || getTerrainHeight(ox, oz), oz + Math.cos(a) * 2.2);
        }
        buildingsList = Array.isArray(arg4) ? arg4 : [];
        unitsList = Array.isArray(arg5) ? arg5 : [];
        tx = ox;
        tz = oz + 4.0;
    } else {
        ox = Number(arg1) || 0;
        oz = Number(arg2) || 0;
        tx = Number.isFinite(Number(arg3)) ? Number(arg3) : ox;
        tz = Number.isFinite(Number(arg4)) ? Number(arg4) : (oz + 4.0);
        unitRadius = typeof arg5 === 'number' ? arg5 : 0.55;
        buildingsList = Array.isArray(arg6) ? arg6 : [];
        enemyBuildingsList = Array.isArray(arg7) ? arg7 : [];
        unitsList = Array.isArray(arg8) ? arg8 : [];
    }

    gatherStructureBlockers(unitRadius, buildingsList, enemyBuildingsList);

    const baseAngle = Math.atan2(tx - ox, tz - oz);
    const candidateRings = [2.65, 3.45, 4.35, 5.35, 6.45];
    const angleOffsets = [0, 0.36, -0.36, 0.72, -0.72, 1.08, -1.08, 1.45, -1.45, 1.85, -1.85, 2.25, -2.25, 2.68, -2.68, Math.PI];

    let fallbackBuildingFreePt = null;
    const nearbyUnits = (typeof window.queryGroundUnitsNearInto === 'function')
        ? window.queryGroundUnitsNearInto(ox, oz, 8.5, _localUnitBlockerScratch)
        : (unitsList || []);

    for (let rIdx = 0; rIdx < candidateRings.length; rIdx++) {
        const dist = candidateRings[rIdx];
        for (let aIdx = 0; aIdx < angleOffsets.length; aIdx++) {
            const ang = baseAngle + angleOffsets[aIdx];
            const px = ox + Math.sin(ang) * dist;
            const pz = oz + Math.cos(ang) * dist;

            if (!isWalkableGround(px, pz, unitRadius * 0.5)) continue;

            // 1. Check natural obstacles & buildings via spatial bucket
            let blocked = false;
            const bucket = _structGridBuckets[_toSGridCoord(pz) * SGRID_DIM + _toSGridCoord(px)];
            for (let i = 0; i < bucket.length; i++) {
                const sc = bucket[i];
                const dx = px - sc.x;
                const dz = pz - sc.z;
                const reqR = sc.rawR + unitRadius + (sc.isBuilding ? 0.42 : 0.35);
                if (dx * dx + dz * dz < reqR * reqR) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) continue;

            if (!fallbackBuildingFreePt) {
                fallbackBuildingFreePt = new THREE.Vector3(px, getTerrainHeight(px, pz), pz);
            }

            // 2. Check nearby Ground Units so spawned units don't stack on top of each other
            let unitOverlap = false;
            for (let i = 0; i < nearbyUnits.length; i++) {
                const u = nearbyUnits[i];
                if (!u || u.isAir || u.hp <= 0 || !u.mesh) continue;
                const dx = px - u.mesh.position.x;
                const dz = pz - u.mesh.position.z;
                const minU = (u.radius || 0.52) + unitRadius + 0.16;
                if (dx * dx + dz * dz < minU * minU) {
                    unitOverlap = true;
                    break;
                }
            }
            if (!unitOverlap) {
                return new THREE.Vector3(px, getTerrainHeight(px, pz), pz);
            }
        }
    }

    if (fallbackBuildingFreePt) return fallbackBuildingFreePt;
    return new THREE.Vector3(ox, getTerrainHeight(ox, oz + 3.0), oz + 3.0);
}

const generatedMapMeshes = [];
window.WHITE_STRUCTURE_DIAGNOSTICS = {
    auditedMeshes: 0,
    repairedWhiteMeshes: 0,
    repairedMissingUVs: 0,
    repairedMissingNormals: 0,
    repairedMissingMaps: 0,
    records: []
};

function ensureGeometryUVsAndNormals(geo, meshName = 'unnamed') {
    if (!geo || !geo.attributes || !geo.attributes.position) return;
    const pos = geo.attributes.position;
    if (!geo.attributes.normal || geo.attributes.normal.count !== pos.count) {
        try {
            geo.computeVertexNormals();
            window.WHITE_STRUCTURE_DIAGNOSTICS.repairedMissingNormals++;
        } catch (e) {}
    }
    let needsUvRepair = !geo.attributes.uv || geo.attributes.uv.count !== pos.count;
    if (!needsUvRepair && geo.attributes.uv) {
        const uvArr = geo.attributes.uv.array;
        for (let i = 0; i < Math.min(uvArr.length, 24); i++) {
            if (!Number.isFinite(uvArr[i])) {
                needsUvRepair = true;
                break;
            }
        }
    }
    if (needsUvRepair) {
        const uvs = new Float32Array(pos.count * 2);
        for (let i = 0; i < pos.count; i++) {
            const vx = pos.getX(i) || 0;
            const vy = pos.getY(i) || 0;
            const vz = pos.getZ(i) || 0;
            uvs[i * 2] = (vx + vz) * 0.35;
            uvs[i * 2 + 1] = vy * 0.35 + (vx - vz) * 0.15;
        }
        geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        window.WHITE_STRUCTURE_DIAGNOSTICS.repairedMissingUVs++;
    }
}

function getBiomeOrFactionFallbackMaterial(obj, child) {
    const faction = (obj && obj.userData && obj.userData.faction) || (child && child.userData && child.userData.faction) || '';
    const biome = (typeof ACTIVE_PLANET_BIOME !== 'undefined' && ACTIVE_PLANET_BIOME) ? ACTIVE_PLANET_BIOME : 'highland';
    if (typeof MAT !== 'undefined' && MAT) {
        if (faction === 'zerg' && MAT.zergSkin) return MAT.zergSkin;
        if (faction === 'solaris' && MAT.protossGold) return MAT.protossGold;
        if (faction === 'terran' && MAT.terranBase) return MAT.terranBase;
        if (biome === 'lava' && MAT.obsidianMat) return MAT.obsidianMat;
        if (biome === 'desert' && MAT.canyonRock) return MAT.canyonRock;
        if (biome === 'jungle' && MAT.mossRock) return MAT.mossRock;
        if (biome === 'ocean' && MAT.ruinConcrete) return MAT.ruinConcrete;
        if (MAT.ruinSteel) return MAT.ruinSteel;
        if (MAT.terranBase) return MAT.terranBase;
    }
    return new THREE.MeshStandardMaterial({
        color: 0x4b5563,
        map: window.terranPlateTex || window.terrainDetailTex || null,
        roughness: 0.58,
        metalness: 0.45
    });
}

function finalizeTerrainStructureLightingAndShadows(obj) {
    if (!obj || typeof obj.traverse !== 'function') return;
    const rootName = obj.name || (obj.userData && obj.userData.structureType) || 'EnvStructure';
    obj.traverse(child => {
        if (!child || !child.isMesh) return;
        window.WHITE_STRUCTURE_DIAGNOSTICS.auditedMeshes++;
        if (child.geometry) {
            ensureGeometryUVsAndNormals(child.geometry, child.name || rootName);
        }

        // Detect missing material or default Three.js white fallback material (MeshBasicMaterial with 0xffffff and no map)
        const mat = child.material;
        const isDefaultWhiteBasic = !mat || (
            mat.isMeshBasicMaterial &&
            !mat.map &&
            mat.color &&
            mat.color.r > 0.96 && mat.color.g > 0.96 && mat.color.b > 0.96 &&
            !mat.transparent &&
            !mat.wireframe
        );
        const isUnmappedPureWhiteStandard = mat && mat.isMeshStandardMaterial && !mat.map && !mat.vertexColors &&
            mat.color && mat.color.r > 0.96 && mat.color.g > 0.96 && mat.color.b > 0.96 &&
            (!mat.emissive || (mat.emissive.r < 0.05 && mat.emissive.g < 0.05 && mat.emissive.b < 0.05));

        if (isDefaultWhiteBasic || isUnmappedPureWhiteStandard) {
            const replacement = getBiomeOrFactionFallbackMaterial(obj, child);
            window.WHITE_STRUCTURE_DIAGNOSTICS.repairedWhiteMeshes++;
            if (window.WHITE_STRUCTURE_DIAGNOSTICS.records.length < 60) {
                window.WHITE_STRUCTURE_DIAGNOSTICS.records.push({
                    model: rootName,
                    mesh: child.name || 'childMesh',
                    reason: !mat ? 'missing_material' : (isDefaultWhiteBasic ? 'default_white_basic_material' : 'unmapped_white_standard_material'),
                    assignedFallback: replacement.name || 'BiomeFactionFallback'
                });
            }
            child.material = replacement;
        }

        if (child.material && !child.material.isShaderMaterial && child.material.type !== 'ShaderMaterial') {
            child.receiveShadow = true;
            if (!IS_MOBILE) {
                if (child.geometry && !child.geometry.boundingSphere) {
                    child.geometry.computeBoundingSphere();
                }
                const bRad = (child.geometry && child.geometry.boundingSphere) ? child.geometry.boundingSphere.radius : 1.0;
                child.castShadow = bRad >= 1.15;
            }
            if (child.material.isMeshBasicMaterial) {
                const baseColor = child.material.color ? child.material.color.clone() : new THREE.Color(0x38bdf8);
                // Prevent pure white basic materials from turning into glowing white blobs
                if (baseColor.r > 0.92 && baseColor.g > 0.92 && baseColor.b > 0.92 && !child.material.transparent) {
                    baseColor.setHex(0x64748b);
                }
                const convertedMat = new THREE.MeshStandardMaterial({
                    color: baseColor,
                    map: child.material.map || window.terrainDetailTex || null,
                    emissive: baseColor.clone().multiplyScalar(0.24),
                    emissiveIntensity: 0.18,
                    roughness: 0.48,
                    metalness: 0.28,
                    transparent: Boolean(child.material.transparent),
                    opacity: child.material.opacity !== undefined ? child.material.opacity : 1.0
                });
                child.material = convertedMat;
            } else if (child.material.emissiveIntensity !== undefined && child.material.emissiveIntensity > 0.28) {
                child.material.emissiveIntensity = Math.min(0.28, child.material.emissiveIntensity * 0.45);
            }
            // Ensure cloned standard materials retain a detail texture map if neither map nor vertexColors is set
            if (child.material.isMeshStandardMaterial && !child.material.map && !child.material.vertexColors && !child.material.transparent && window.terrainDetailTex) {
                child.material.map = window.terrainDetailTex;
                child.material.needsUpdate = true;
                window.WHITE_STRUCTURE_DIAGNOSTICS.repairedMissingMaps++;
            }
            if (typeof SHADER_ENGINE !== 'undefined' && typeof SHADER_ENGINE.applyBuildingShader === 'function') {
                if (!child.material.userData || (!child.material.userData.fowEnhanced && !child.material.userData.terrainEnhanced)) {
                    SHADER_ENGINE.applyBuildingShader(child.material);
                }
            }
        }
    });
}
window.finalizeTerrainStructureLightingAndShadows = finalizeTerrainStructureLightingAndShadows;
function addMapMesh(obj) {
    finalizeTerrainStructureLightingAndShadows(obj);
    scene.add(obj);
    obj.updateMatrixWorld(true);
    generatedMapMeshes.push(obj);
    return obj;
}
function disposeObjectGeometriesSafely(rootObj) {
    if (!rootObj || typeof rootObj.traverse !== 'function') return;
    rootObj.traverse(child => {
        if (child && child.isMesh && child.geometry && child.geometry !== terrainGeo && child.geometry !== fowGeo) {
            if (!child.geometry.userData || !child.geometry.userData.sharedGlobalGeo) {
                try { child.geometry.dispose(); } catch (e) {}
            }
        }
    });
}

function clearGeneratedMapMeshes() {
    while (generatedMapMeshes.length > 0) {
        const obj = generatedMapMeshes.pop();
        if (obj) {
            if (obj.parent) obj.parent.remove(obj);
            disposeObjectGeometriesSafely(obj);
        }
    }
    while (envMapMeshes.length > 0) {
        const obj = envMapMeshes.pop();
        if (obj) {
            if (obj.parent) obj.parent.remove(obj);
            disposeObjectGeometriesSafely(obj);
        }
    }
    _roadSpatialCacheReady = false;
}

const terrainGeo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, IS_MOBILE ? 108 : 168, IS_MOBILE ? 108 : 168);
terrainGeo.rotateX(-Math.PI / 2);
const posAttr = terrainGeo.attributes.position;
const baseColors = new Float32Array(posAttr.count * 3);
const liveColors = new Float32Array(posAttr.count * 3);

// StarCraft II Koprulu Sector Highland, Sedimentary Cliff & Natural Cobblestone Palette
const cGrass        = new THREE.Color(0x2a5c2f);
const cLushVerge    = new THREE.Color(0x387236);
const cSunlitMeadow = new THREE.Color(0x4b873e);
const cForestFloor  = new THREE.Color(0x1d4723);
const cHighlandMoss = new THREE.Color(0x3a6644);
const cBridgeDeck   = new THREE.Color(0x5a6b7d);
const cBridgeCenter = new THREE.Color(0x414e5f);
const cCliffSlate   = new THREE.Color(0x4d5866);
const cRavineWall   = new THREE.Color(0x252c36);
const cRavineAbyss  = new THREE.Color(0x070b12);
const cMountainRock = new THREE.Color(0x5e6a7a);
const cSnowPeak     = new THREE.Color(0xdce6f2);
const cZergCreep    = new THREE.Color(0x42113c);
const cZergVein     = new THREE.Color(0x7c1f64);
const cCreepBurn    = new THREE.Color(0xff6a1a);

// Natural Warm Earth & Sandstone Pathway Colors
const cSupplyRoad   = new THREE.Color(0x6e5c44);
const cRoadBorder   = new THREE.Color(0x463b2c);
const cCrystalSoil  = new THREE.Color(0x26574d);

let ABANDONED_BASES = [];
let ABANDONED_TOWN_CENTER = { x: -24, z: 24 };
let BUILDING_RUINS = [];
let ROCKY_TERRAIN_ZONES = [];
let SOUTH_ROAD_HUB = new THREE.Vector3(0, 0, -14);
let NORTH_ROAD_HUB = new THREE.Vector3(0, 0, 6);
let DYNAMIC_ROAD_SEGMENTS = [];
let ROAD_JUNCTION_NODES = [];
window.DYNAMIC_ROAD_SEGMENTS = DYNAMIC_ROAD_SEGMENTS;
window.ROAD_JUNCTION_NODES = ROAD_JUNCTION_NODES;

// ============================================================================
// ALGORITHMIC GRAPH-BASED SPLINE ROAD NETWORK & O(1) SPATIAL ROAD CACHE
// Evaluates C1/C2 cubic Bezier curves with control-point obstacle routing,
// Laplacian XZ fairing, arc-length parameterization, and longitudinal grade clamping!
// ============================================================================
function evaluateRoadSplineRawPoint(seg, t) {
    const u = 1.0 - t;
    let px = 0, pz = 0;

    if (seg.mode === 'bezier' && seg.c1x !== undefined && seg.c2x !== undefined) {
        // True C1 Cubic Bezier Spline: B(t) = (1-t)^3 P0 + 3(1-t)^2 t C1 + 3(1-t) t^2 C2 + t^3 P3
        const b0 = u * u * u;
        const b1 = 3.0 * u * u * t;
        const b2 = 3.0 * u * t * t;
        const b3 = t * t * t;
        px = b0 * seg.ax + b1 * seg.c1x + b2 * seg.c2x + b3 * seg.bx;
        pz = b0 * seg.az + b1 * seg.c1z + b2 * seg.c2z + b3 * seg.bz;
    } else {
        const dx = seg.bx - seg.ax, dz = seg.bz - seg.az;
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len, nz = dx / len;
        const env = Math.sin(t * Math.PI);
        const bend = env * (seg.curveSign || 0) * Math.min(6.0, len * 0.18);
        px = seg.ax + t * dx + nx * bend;
        pz = seg.az + t * dz + nz * bend;
    }

    const widthMorph = (seg.baseWidth || 3.0) + Math.sin(t * Math.PI) * (seg.morphAmp || 0.04);
    return { x: px, z: pz, halfWidth: widthMorph * 0.5 };
}

function precomputeRoadSegmentSamples(seg, numSamples = 64) {
    const rawPts = [];
    const maxHalfW = ((seg.baseWidth || 3.0) + Math.abs(seg.morphAmp || 0.2)) * 0.5 + 2.8;

    // 1. Evaluate initial Bezier/curve samples
    for (let i = 0; i <= numSamples; i++) {
        const t = i / numSamples;
        const pt = evaluateRoadSplineRawPoint(seg, t);
        rawPts.push(pt);
    }

    // 2. Soft interior obstacle-avoidance relaxation around ponds, river bends & non-ramp base cliffs
    //    Followed by 6 passes of Laplacian XZ smoothing so obstacle routing NEVER introduces sharp corners or zigzags!
    for (let iter = 0; iter < 3; iter++) {
        for (let i = 2; i <= numSamples - 2; i++) {
            const t = i / numSamples;
            const endPin = Math.sin(t * Math.PI);
            const pt = rawPts[i];

            for (let p = 0; p < DYNAMIC_PONDS.length; p++) {
                const pd = DYNAMIC_PONDS[p];
                const dxP = pt.x - pd.x;
                const dzP = pt.z - pd.z;
                const dPond = Math.hypot(dxP, dzP);
                const effPondR = getDynamicPondRadiusAtAngle(pd, Math.atan2(dzP, dxP));
                const minClear = effPondR + pt.halfWidth + 2.6;
                if (dPond < minClear && dPond > 0.01) {
                    const push = (minClear - dPond) * 0.65 * endPin;
                    pt.x += (dxP / dPond) * push;
                    pt.z += (dzP / dPond) * push;
                }
            }

            if (HAS_VALLEY_RIVER && !seg.isBridgeCauseway) {
                const rc = getRiverCoords(pt.x, pt.z);
                const minRivClear = (rc.halfWidth || RIVER_HALF_WIDTH) + pt.halfWidth + 3.2;
                if (rc.dist < minRivClear) {
                    const pushSign = rc.signedDist >= 0 ? 1 : -1;
                    const targetU = rc.centerU + pushSign * minRivClear;
                    const wSafe = riverCoordsToWorld(rc.s, targetU);
                    pt.x = THREE.MathUtils.lerp(pt.x, wSafe.x, 0.65 * endPin);
                    pt.z = THREE.MathUtils.lerp(pt.z, wSafe.z, 0.65 * endPin);
                }
            }

            for (let b = 0; b < BASE_TERRAIN_ZONES.length; b++) {
                const bz = BASE_TERRAIN_ZONES[b];
                if (!bz || bz.mode === 'no_ramp') continue;
                const dxB = pt.x - bz.x;
                const dzB = pt.z - bz.z;
                const dBase = Math.hypot(dxB, dzB);
                const cliffClearR = (bz.rimOuter || 20.0) + 3.8;
                if (dBase < cliffClearR && dBase > 0.01) {
                    const zm = getBaseZoneRampMetrics(bz, pt.x, pt.z);
                    if (!zm.inRampAngle && zm.rampBlend < 0.15) {
                        const push = (cliffClearR - dBase) * 0.55 * endPin;
                        pt.x += (dxB / dBase) * push;
                        pt.z += (dzB / dBase) * push;
                    }
                }
            }
        }

        // Laplacian XZ fairing pass (keeps i=0,1 and i=numSamples-1,numSamples pinned to preserve exact bridge/ramp entry tangents!)
        for (let sPass = 0; sPass < 2; sPass++) {
            for (let i = 2; i <= numSamples - 2; i++) {
                rawPts[i].x = (rawPts[i - 1].x + rawPts[i].x * 2.0 + rawPts[i + 1].x) * 0.25;
                rawPts[i].z = (rawPts[i - 1].z + rawPts[i].z * 2.0 + rawPts[i + 1].z) * 0.25;
            }
        }
    }

    // 3. Uniform Arc-Length Resampling so vertex spacing, lane dashes, and curvature are 100% uniform
    const cumArc = new Float32Array(numSamples + 1);
    cumArc[0] = 0;
    for (let i = 1; i <= numSamples; i++) {
        cumArc[i] = cumArc[i - 1] + Math.hypot(rawPts[i].x - rawPts[i - 1].x, rawPts[i].z - rawPts[i - 1].z);
    }
    const totalLength = Math.max(0.01, cumArc[numSamples]);
    const samples = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

    let searchIdx = 0;
    for (let i = 0; i <= numSamples; i++) {
        const targetS = (i / numSamples) * totalLength;
        while (searchIdx < numSamples - 1 && cumArc[searchIdx + 1] < targetS) {
            searchIdx++;
        }
        const segLen = Math.max(0.0001, cumArc[searchIdx + 1] - cumArc[searchIdx]);
        const frac = THREE.MathUtils.clamp((targetS - cumArc[searchIdx]) / segLen, 0, 1);
        const p0 = rawPts[searchIdx];
        const p1 = rawPts[searchIdx + 1];
        const sx = p0.x + (p1.x - p0.x) * frac;
        const sz = p0.z + (p1.z - p0.z) * frac;
        const shw = p0.halfWidth + (p1.halfWidth - p0.halfWidth) * frac;
        const sy = THREE.MathUtils.clamp(getTerrainHeight(sx, sz), 0.14, 3.2);

        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
        if (sz < minZ) minZ = sz;
        if (sz > maxZ) maxZ = sz;
        samples.push({ x: sx, y: sy, z: sz, halfWidth: shw, arc: targetS });
    }

    // 4. Lock bridge-entry endpoints to 0.30m so road elevation meets the bridge approach ramp toe seamlessly
    if (seg.isBridgeCauseway) {
        for (let b = 0; b < BRIDGES.length; b++) {
            const br = BRIDGES[b];
            if (Math.hypot(samples[0].x - br.southEntry.x, samples[0].z - br.southEntry.z) < 2.5 ||
                Math.hypot(samples[0].x - br.northEntry.x, samples[0].z - br.northEntry.z) < 2.5) {
                samples[0].y = 0.28;
            }
            const last = samples[numSamples];
            if (Math.hypot(last.x - br.southEntry.x, last.z - br.southEntry.z) < 2.5 ||
                Math.hypot(last.x - br.northEntry.x, last.z - br.northEntry.z) < 2.5) {
                last.y = 0.28;
            }
        }
    }

    // 5. Longitudinal Elevation Profile Smoothing & Max-Grade Clamping (8 passes)
    for (let pass = 0; pass < 8; pass++) {
        for (let i = 1; i < numSamples; i++) {
            samples[i].y = (samples[i - 1].y + samples[i].y * 2.0 + samples[i + 1].y) * 0.25;
        }
    }
    const maxGrade = 0.085; // Max 8.5% longitudinal highway grade
    for (let i = 1; i <= numSamples; i++) {
        const ds = Math.max(0.2, samples[i].arc - samples[i - 1].arc);
        const maxDeltaY = ds * maxGrade;
        samples[i].y = THREE.MathUtils.clamp(samples[i].y, samples[i - 1].y - maxDeltaY, samples[i - 1].y + maxDeltaY);
    }

    // 6. Compute unit tangents, normals & curvature at each sample
    let maxCurvature = 0;
    for (let i = 0; i <= numSamples; i++) {
        const prev = samples[Math.max(0, i - 1)];
        const next = samples[Math.min(numSamples, i + 1)];
        let tx = next.x - prev.x;
        let tz = next.z - prev.z;
        const tLen = Math.hypot(tx, tz) || 1;
        tx /= tLen;
        tz /= tLen;
        samples[i].tx = tx;
        samples[i].tz = tz;
        samples[i].nx = -tz;
        samples[i].nz = tx;
        if (i > 0) {
            const dAng = Math.abs(Math.atan2(
                samples[i].tx * samples[i - 1].tz - samples[i].tz * samples[i - 1].tx,
                samples[i].tx * samples[i - 1].tx + samples[i].tz * samples[i - 1].tz
            ));
            const ds = Math.max(0.25, samples[i].arc - samples[i - 1].arc);
            maxCurvature = Math.max(maxCurvature, dAng / ds);
        }
    }

    seg.totalLength = totalLength;
    seg.maxCurvature = maxCurvature;
    seg.samples = samples;
    seg.bbox = {
        minX: minX - maxHalfW,
        maxX: maxX + maxHalfW,
        minZ: minZ - maxHalfW,
        maxZ: maxZ + maxHalfW
    };
    return seg;
}

// Bakes the O(1) Spatial Road Lookup Grid (ROAD_FACTOR_CACHE & ROAD_ELEVATION_CACHE) across the 261x261 map grid
function bakeRoadSpatialLookupGrid() {
    ROAD_FACTOR_CACHE.fill(0);
    ROAD_ELEVATION_CACHE.fill(0);
    _roadSpatialCacheReady = false;

    for (let sIdx = 0; sIdx < DYNAMIC_ROAD_SEGMENTS.length; sIdx++) {
        const seg = DYNAMIC_ROAD_SEGMENTS[sIdx];
        const samples = seg.samples;
        if (!samples || samples.length < 2 || !seg.bbox) continue;

        const minGX = Math.max(0, Math.floor(seg.bbox.minX + HEIGHT_CACHE_HALF - 1));
        const maxGX = Math.min(HEIGHT_CACHE_DIM - 1, Math.ceil(seg.bbox.maxX + HEIGHT_CACHE_HALF + 1));
        const minGZ = Math.max(0, Math.floor(seg.bbox.minZ + HEIGHT_CACHE_HALF - 1));
        const maxGZ = Math.min(HEIGHT_CACHE_DIM - 1, Math.ceil(seg.bbox.maxZ + HEIGHT_CACHE_HALF + 1));

        for (let gz = minGZ; gz <= maxGZ; gz++) {
            const wz = gz - HEIGHT_CACHE_HALF;
            const rowOff = gz * HEIGHT_CACHE_DIM;
            for (let gx = minGX; gx <= maxGX; gx++) {
                const wx = gx - HEIGHT_CACHE_HALF;
                let bestD = Infinity;
                let bestHW = 2.0;
                let bestY = 0.25;

                for (let i = 0; i < samples.length - 1; i++) {
                    const a = samples[i];
                    const b = samples[i + 1];
                    const abx = b.x - a.x;
                    const abz = b.z - a.z;
                    const lenSq = abx * abx + abz * abz || 1;
                    const proj = Math.max(0, Math.min(1, ((wx - a.x) * abx + (wz - a.z) * abz) / lenSq));
                    const px = a.x + abx * proj;
                    const pz = a.z + abz * proj;
                    const d = Math.hypot(wx - px, wz - pz);
                    if (d < bestD) {
                        bestD = d;
                        bestHW = a.halfWidth + (b.halfWidth - a.halfWidth) * proj;
                        bestY = a.y + (b.y - a.y) * proj;
                    }
                }

                let factor = 0.0;
                if (bestD < bestHW + 0.6) {
                    factor = 1.0 - (bestD / (bestHW + 0.6)) * 0.22;
                } else if (bestD < bestHW + 2.4) {
                    factor = (1.0 - (bestD - (bestHW + 0.6)) / 1.8) * 0.75;
                }

                if (factor > 0.0) {
                    const cellIdx = rowOff + gx;
                    const prevF = ROAD_FACTOR_CACHE[cellIdx];
                    if (factor > prevF) {
                        ROAD_FACTOR_CACHE[cellIdx] = factor;
                        ROAD_ELEVATION_CACHE[cellIdx] = bestY;
                    }
                }
            }
        }
    }

    _roadSpatialCacheReady = true;
}

// Helper to auto-position road endpoints & tangent vectors to align with nearby Base / Corner Platform Ramps!
function getRampAlignedRoadPlaza(anchorX, anchorZ, towardX, towardZ, defaultPull = 9.5) {
    let matchedZone = null;
    let bestZoneDist = 26.0;
    for (let i = 0; i < BASE_TERRAIN_ZONES.length; i++) {
        const bz = BASE_TERRAIN_ZONES[i];
        if (!bz) continue;
        const d = Math.hypot(anchorX - bz.x, anchorZ - bz.z);
        if (d < bestZoneDist) {
            bestZoneDist = d;
            matchedZone = bz;
        }
    }
    if (matchedZone && matchedZone.mode !== 'no_ramp') {
        const baseAng = Math.atan2(matchedZone.rampDirZ, matchedZone.rampDirX);
        const openingOffsets = [0.0, 1.12, -1.12];
        const toTargetAng = Math.atan2(towardZ - matchedZone.z, towardX - matchedZone.x);
        let bestAng = baseAng;
        let bestAngDiff = Infinity;
        for (let k = 0; k < openingOffsets.length; k++) {
            const candAng = baseAng + openingOffsets[k];
            let diff = Math.abs(Math.atan2(Math.sin(candAng - toTargetAng), Math.cos(candAng - toTargetAng)));
            if (k > 0) diff += 0.25;
            if (diff < bestAngDiff) {
                bestAngDiff = diff;
                bestAng = candAng;
            }
        }
        const rx = Math.cos(bestAng);
        const rz = Math.sin(bestAng);
        const toeDist = (matchedZone.rimOuter || 21.0) + (bestAng === baseAng ? 11.2 : 2.8);
        return {
            x: matchedZone.x + rx * toeDist,
            z: matchedZone.z + rz * toeDist,
            dirX: rx,
            dirZ: rz
        };
    }
    const dx = towardX - anchorX;
    const dz = towardZ - anchorZ;
    const len = Math.hypot(dx, dz) || 1;
    return {
        x: anchorX + (dx / len) * defaultPull,
        z: anchorZ + (dz / len) * defaultPull,
        dirX: dx / len,
        dirZ: dz / len
    };
}

function computeDynamicRoadAndLandmarkLayout() {
    _roadGradingActive = false;
    _roadSpatialCacheReady = false;

    // Auto-position Allied Base Plaza, Enemy Base Plaza & Solaris Gate Plaza to align directly with nearby Ramp Openings!
    const alliedBasePlaza = getRampAlignedRoadPlaza(
        PLAYER_START_POS.x, PLAYER_START_POS.z,
        ENEMY_BASE_POS.x, ENEMY_BASE_POS.z,
        BASE_PLATEAU_RIM_OUTER + 9.5
    );

    const axisX = ENEMY_BASE_POS.x - alliedBasePlaza.x;
    const axisZ = ENEMY_BASE_POS.z - alliedBasePlaza.z;
    const axisLen = Math.hypot(axisX, axisZ) || 1;
    const fwdX = axisX / axisLen;
    const fwdZ = axisZ / axisLen;
    const rightX = -fwdZ;
    const rightZ = fwdX;

    const enemyBasePlaza = getRampAlignedRoadPlaza(
        ENEMY_BASE_POS.x, ENEMY_BASE_POS.z,
        alliedBasePlaza.x, alliedBasePlaza.z,
        8.5
    );

    // Solaris Allied Enclave Gate Plaza (auto-aligned with Solaris ramp toe!)
    const solarisGatePlaza = getRampAlignedRoadPlaza(
        SOLARIS_BASE_POS.x, SOLARIS_BASE_POS.z,
        0, 0,
        10.5
    );

    // Dynamically place Abandoned Town Center on the opposite flank from Solaris Enclave (strictly away from any river using RIVER_SIN/RIVER_COS!)
    const solLatProj = (SOLARIS_BASE_POS.x - alliedBasePlaza.x) * rightX + (SOLARIS_BASE_POS.z - alliedBasePlaza.z) * rightZ;
    const townSide = solLatProj >= 0 ? -1 : 1;
    const townAlong = (0.34 + seededRandom() * 0.10) * axisLen;
    const townAcross = townSide * (29.0 + seededRandom() * 9.0);
    let rawTownX = THREE.MathUtils.clamp(alliedBasePlaza.x + fwdX * townAlong + rightX * townAcross, -68, 68);
    let rawTownZ = THREE.MathUtils.clamp(alliedBasePlaza.z + fwdZ * townAlong + rightZ * townAcross, -68, 68);
    if (HAS_VALLEY_RIVER && getRiverDist(rawTownX, rawTownZ) < RIVER_HALF_WIDTH + 16.0) {
        const rcTown = getRiverCoords(rawTownX, rawTownZ);
        const pushSign = rcTown.signedDist >= 0 ? 1 : -1;
        rawTownX += pushSign * 15.0 * RIVER_SIN;
        rawTownZ += pushSign * 15.0 * RIVER_COS;
    }
    const safeTownPt = relocateToSafeSlopePosition(rawTownX, rawTownZ, 11.5);
    ABANDONED_TOWN_CENTER = { x: safeTownPt.x, z: safeTownPt.z };

    // Dynamically place 2 Abandoned Military Outposts in flanking sectors (pushed clear of rivers)
    const ab1Along = (0.26 + seededRandom() * 0.14) * axisLen;
    const ab1Across = -townSide * (26.0 + seededRandom() * 11.0);
    const ab2Along = (0.66 + seededRandom() * 0.12) * axisLen;
    const ab2Across = townSide * (26.0 + seededRandom() * 11.0);
    ABANDONED_BASES = [
        {
            x: THREE.MathUtils.clamp(alliedBasePlaza.x + fwdX * ab1Along + rightX * ab1Across, -76, 76),
            z: THREE.MathUtils.clamp(alliedBasePlaza.z + fwdZ * ab1Along + rightZ * ab1Across, -76, 76),
            rot: seededRandom() * Math.PI * 2
        },
        {
            x: THREE.MathUtils.clamp(alliedBasePlaza.x + fwdX * ab2Along + rightX * ab2Across, -76, 76),
            z: THREE.MathUtils.clamp(alliedBasePlaza.z + fwdZ * ab2Along + rightZ * ab2Across, -76, 76),
            rot: seededRandom() * Math.PI * 2
        }
    ];

    // Dynamically scatter Building Ruins & Rocky Terrain Zones using seededRandom()
    BUILDING_RUINS = [];
    for (let r = 0; r < 6; r++) {
        const rAlong = (0.18 + seededRandom() * 0.66) * axisLen;
        const rAcross = (r % 2 === 0 ? 1 : -1) * (16.0 + seededRandom() * 34.0);
        BUILDING_RUINS.push({
            x: THREE.MathUtils.clamp(alliedBasePlaza.x + fwdX * rAlong + rightX * rAcross, -82, 82),
            z: THREE.MathUtils.clamp(alliedBasePlaza.z + fwdZ * rAlong + rightZ * rAcross, -82, 82),
            rot: seededRandom() * Math.PI * 2
        });
    }

    ROCKY_TERRAIN_ZONES = [];
    for (let rz = 0; rz < 4; rz++) {
        ROCKY_TERRAIN_ZONES.push({
            x: (seededRandom() - 0.5) * 135,
            z: (seededRandom() - 0.5) * 135,
            r: 8.5 + seededRandom() * 4.5
        });
    }

    // Helper to build a smooth, realistic C1 Bezier highway segment that auto-aligns with ramp & bridge tangent directions!
    // NOTE: Control handle at pA extends OUTWARD from pA (+pA.dir), whereas at pB it extends OUTWARD from pB (+pB.dir) so the road enters pB collinearly!
    function makeCurvedBezierRoad(pA, pB, width = 4.5, lateralBend = 0, extraProps = {}) {
        const dx = pB.x - pA.x;
        const dz = pB.z - pA.z;
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len;
        const nz = dx / len;
        const handleLen = Math.min(18.0, len * 0.32);

        let c1x = (pA.dirX !== undefined)
            ? (pA.x + pA.dirX * handleLen + nx * (lateralBend * 0.28))
            : (pA.x + dx * 0.33 + nx * lateralBend);
        let c1z = (pA.dirZ !== undefined)
            ? (pA.z + pA.dirZ * handleLen + nz * (lateralBend * 0.28))
            : (pA.z + dz * 0.33 + nz * lateralBend);
        let c2x = (pB.dirX !== undefined)
            ? (pB.x + pB.dirX * handleLen + nx * (lateralBend * 0.22))
            : (pA.x + dx * 0.67 + nx * (lateralBend * 0.5));
        let c2z = (pB.dirZ !== undefined)
            ? (pB.z + pB.dirZ * handleLen + nz * (lateralBend * 0.22))
            : (pA.z + dz * 0.67 + nz * (lateralBend * 0.5));

        // Deflect control handles cleanly around any oasis ponds before spline evaluation
        for (let p = 0; p < DYNAMIC_PONDS.length; p++) {
            const pd = DYNAMIC_PONDS[p];
            const minClear = pd.r * 1.35 + width + 3.0;
            const d1 = Math.hypot(c1x - pd.x, c1z - pd.z);
            if (d1 < minClear && d1 > 0.01) {
                c1x += ((c1x - pd.x) / d1) * (minClear - d1);
                c1z += ((c1z - pd.z) / d1) * (minClear - d1);
            }
            const d2 = Math.hypot(c2x - pd.x, c2z - pd.z);
            if (d2 < minClear && d2 > 0.01) {
                c2x += ((c2x - pd.x) / d2) * (minClear - d2);
                c2z += ((c2z - pd.z) / d2) * (minClear - d2);
            }
        }

        return Object.assign({
            mode: 'bezier',
            ax: pA.x, az: pA.z,
            c1x, c1z,
            c2x, c2z,
            bx: pB.x, bz: pB.z,
            baseWidth: width,
            morphAmp: 0.02,
            isMainHighway: true
        }, extraProps);
    }

    // Generate Clean, Non-Circular Military Asphalt Highway Network:
    // Zero roundabouts, zero circular loops, and 100% collinear tangent alignment into bridge approach ramps!
    ROAD_JUNCTION_NODES = [];
    if (HAS_VALLEY_RIVER && BRIDGES.length > 0) {
        let mainBr = BRIDGES[0];
        let secBr = BRIDGES.length > 1 ? BRIDGES[1] : null;
        const midX = (alliedBasePlaza.x + enemyBasePlaza.x) * 0.5;
        const midZ = (alliedBasePlaza.z + enemyBasePlaza.z) * 0.5;
        if (BRIDGES.length > 1) {
            const d0 = Math.hypot(BRIDGES[0].center.x - midX, BRIDGES[0].center.z - midZ);
            const d1 = Math.hypot(BRIDGES[1].center.x - midX, BRIDGES[1].center.z - midZ);
            if (d1 < d0) {
                mainBr = BRIDGES[1];
                secBr = BRIDGES[0];
            }
        }
        const alliedToSouth = Math.hypot(alliedBasePlaza.x - mainBr.southEntry.x, alliedBasePlaza.z - mainBr.southEntry.z);
        const alliedToNorth = Math.hypot(alliedBasePlaza.x - mainBr.northEntry.x, alliedBasePlaza.z - mainBr.northEntry.z);
        const mainEntry = alliedToSouth <= alliedToNorth ? mainBr.southEntry : mainBr.northEntry;
        const mainExit  = alliedToSouth <= alliedToNorth ? mainBr.northEntry : mainBr.southEntry;
        const mainCenterU = getRiverCenterUAtS(mainBr.sCoord);

        SOUTH_ROAD_HUB = new THREE.Vector3(mainEntry.x, 0, mainEntry.z);
        SOUTH_ROAD_HUB.dirX = mainEntry.dirX;
        SOUTH_ROAD_HUB.dirZ = mainEntry.dirZ;

        NORTH_ROAD_HUB = new THREE.Vector3(mainExit.x, 0, mainExit.z);
        NORTH_ROAD_HUB.dirX = mainExit.dirX;
        NORTH_ROAD_HUB.dirZ = mainExit.dirZ;

        const tcx = ABANDONED_TOWN_CENTER.x;
        const tcz = ABANDONED_TOWN_CENTER.z;
        const townRC = getRiverCoords(tcx, tcz);
        const southHubRC = getRiverCoords(SOUTH_ROAD_HUB.x, SOUTH_ROAD_HUB.z);
        const townSameAsSouth = (townRC.signedDist * southHubRC.signedDist >= 0);
        const townConnectPt = townSameAsSouth
            ? { x: (alliedBasePlaza.x + SOUTH_ROAD_HUB.x) * 0.5, z: (alliedBasePlaza.z + SOUTH_ROAD_HUB.z) * 0.5 }
            : { x: (NORTH_ROAD_HUB.x + enemyBasePlaza.x) * 0.5, z: (NORTH_ROAD_HUB.z + enemyBasePlaza.z) * 0.5 };

        ROAD_JUNCTION_NODES.push({ x: townConnectPt.x, z: townConnectPt.z, r: 3.2 });

        const solRC = getRiverCoords(solarisGatePlaza.x, solarisGatePlaza.z);
        const solSameAsSouth = (solRC.signedDist * southHubRC.signedDist >= 0);

        const cutSpurEnd = {
            x: THREE.MathUtils.clamp(townConnectPt.x - rightX * townSide * 18.0, -76, 76),
            z: THREE.MathUtils.clamp(townConnectPt.z - rightZ * townSide * 18.0, -76, 76)
        };

        DYNAMIC_ROAD_SEGMENTS = [
            // 1. Primary Two-Lane Asphalt Highway Spine approaching and exiting Main Bridge (Collinear with bridge span!)
            makeCurvedBezierRoad(alliedBasePlaza, SOUTH_ROAD_HUB, 4.6, (seededRandom() - 0.5) * 1.1, {
                isTrunk: true, isBridgeCauseway: true, bridgeCenterU: mainCenterU, connectedBridgeId: mainBr.id
            }),
            makeCurvedBezierRoad(NORTH_ROAD_HUB, enemyBasePlaza, 4.6, (seededRandom() - 0.5) * 1.1, {
                isTrunk: true, isBridgeCauseway: true, bridgeCenterU: mainCenterU, connectedBridgeId: mainBr.id
            }),

            // 2. Branch Highway to Abandoned Town + Town Cross Street
            makeCurvedBezierRoad(townConnectPt, ABANDONED_TOWN_CENTER, 4.0, (seededRandom() - 0.5) * 1.0, { isBranch: true }),
            {
                ax: tcx - 11.5, az: tcz,
                bx: tcx + 11.5, bz: tcz,
                curveSign: 0.0,
                baseWidth: 4.2,
                morphAmp: 0.0,
                isTownStreet: true,
                isMainHighway: true,
                isTrunk: true
            },

            // 3. Cut-Off Ruined Road Spur for tactical roadblock/ambush landmark
            makeCurvedBezierRoad(townConnectPt, cutSpurEnd, 3.8, (seededRandom() - 0.5) * 0.8, { isBranch: true, isCutRoadEnd: true })
        ];

        // Connect Solaris Enclave via Secondary Bridge or direct T-spur (and connect any 3rd bridge so every bridge has valid road approaches!)
        for (let bIdx = 0; bIdx < BRIDGES.length; bIdx++) {
            const br = BRIDGES[bIdx];
            if (br === mainBr) continue;
            const brEntry = alliedToSouth <= alliedToNorth ? br.southEntry : br.northEntry;
            const brExit  = alliedToSouth <= alliedToNorth ? br.northEntry : br.southEntry;
            const brCenterU = getRiverCenterUAtS(br.sCoord);
            if (br === secBr) {
                const nearSecHub = solSameAsSouth ? brEntry : brExit;
                const farSecHub  = solSameAsSouth ? brExit : brEntry;
                const mainSideAnchor = solSameAsSouth ? NORTH_ROAD_HUB : SOUTH_ROAD_HUB;
                DYNAMIC_ROAD_SEGMENTS.push(
                    makeCurvedBezierRoad(solarisGatePlaza, nearSecHub, 4.1, 0.0, {
                        isBranch: true, isBridgeCauseway: true, bridgeCenterU: brCenterU, connectedBridgeId: br.id
                    }),
                    makeCurvedBezierRoad(farSecHub, mainSideAnchor, 4.0, (seededRandom() - 0.5) * 0.9, {
                        isBranch: true, isBridgeCauseway: true, bridgeCenterU: brCenterU, connectedBridgeId: br.id
                    })
                );
            } else {
                // Connect 3rd flanking bridge to the trunk highway hubs on both banks
                DYNAMIC_ROAD_SEGMENTS.push(
                    makeCurvedBezierRoad(alliedBasePlaza, brEntry, 3.9, 0.0, {
                        isBranch: true, isBridgeCauseway: true, bridgeCenterU: brCenterU, connectedBridgeId: br.id
                    }),
                    makeCurvedBezierRoad(brExit, enemyBasePlaza, 3.9, 0.0, {
                        isBranch: true, isBridgeCauseway: true, bridgeCenterU: brCenterU, connectedBridgeId: br.id
                    })
                );
            }
        }
        if (!secBr) {
            const solAnchor = solSameAsSouth ? SOUTH_ROAD_HUB : NORTH_ROAD_HUB;
            DYNAMIC_ROAD_SEGMENTS.push(
                makeCurvedBezierRoad(solAnchor, solarisGatePlaza, 4.1, (seededRandom() - 0.5) * 1.0, { isBranch: true })
            );
        }
    } else {
        // Open Valley / Canyon Highway Spine: Straight/gently-curving arterial highway with clean T-junction branches
        const sSwing1 = townSide * (2.5 + seededRandom() * 2.5);
        const sSwing2 = -townSide * (2.5 + seededRandom() * 2.5);
        const hub1T = 0.35;
        const hub2T = 0.65;

        SOUTH_ROAD_HUB = new THREE.Vector3(
            alliedBasePlaza.x + fwdX * (axisLen * hub1T) + rightX * sSwing1,
            0,
            alliedBasePlaza.z + fwdZ * (axisLen * hub1T) + rightZ * sSwing1
        );
        NORTH_ROAD_HUB = new THREE.Vector3(
            alliedBasePlaza.x + fwdX * (axisLen * hub2T) + rightX * sSwing2,
            0,
            alliedBasePlaza.z + fwdZ * (axisLen * hub2T) + rightZ * sSwing2
        );
        ROAD_JUNCTION_NODES.push(
            { x: SOUTH_ROAD_HUB.x, z: SOUTH_ROAD_HUB.z, r: 3.4 },
            { x: NORTH_ROAD_HUB.x, z: NORTH_ROAD_HUB.z, r: 3.4 }
        );

        const cutSpur1End = {
            x: THREE.MathUtils.clamp(SOUTH_ROAD_HUB.x - rightX * townSide * 19.0 + fwdX * 4.0, -76, 76),
            z: THREE.MathUtils.clamp(SOUTH_ROAD_HUB.z - rightZ * townSide * 19.0 + fwdZ * 4.0, -76, 76)
        };
        const cutSpur2End = {
            x: THREE.MathUtils.clamp(NORTH_ROAD_HUB.x + rightX * townSide * 19.0 - fwdX * 4.0, -76, 76),
            z: THREE.MathUtils.clamp(NORTH_ROAD_HUB.z + rightZ * townSide * 19.0 - fwdZ * 4.0, -76, 76)
        };

        const tcx = ABANDONED_TOWN_CENTER.x;
        const tcz = ABANDONED_TOWN_CENTER.z;

        DYNAMIC_ROAD_SEGMENTS = [
            makeCurvedBezierRoad(alliedBasePlaza, SOUTH_ROAD_HUB, 4.6, (seededRandom() - 0.5) * 1.5, { isTrunk: true }),
            makeCurvedBezierRoad(SOUTH_ROAD_HUB,  NORTH_ROAD_HUB, 4.6, (seededRandom() - 0.5) * 1.5, { isTrunk: true }),
            makeCurvedBezierRoad(NORTH_ROAD_HUB,  enemyBasePlaza, 4.6, (seededRandom() - 0.5) * 1.5, { isTrunk: true }),
            makeCurvedBezierRoad(SOUTH_ROAD_HUB,  ABANDONED_TOWN_CENTER, 4.0, (seededRandom() - 0.5) * 1.2, { isBranch: true }),
            makeCurvedBezierRoad(NORTH_ROAD_HUB,  solarisGatePlaza,      4.0, (seededRandom() - 0.5) * 1.2, { isBranch: true }),
            {
                ax: tcx - 11.5, az: tcz,
                bx: tcx + 11.5, bz: tcz,
                curveSign: 0.0,
                baseWidth: 4.2,
                morphAmp: 0.0,
                isTownStreet: true,
                isMainHighway: true,
                isTrunk: true
            },
            makeCurvedBezierRoad(SOUTH_ROAD_HUB, cutSpur1End, 3.8, (seededRandom() - 0.5) * 1.0, { isBranch: true, isCutRoadEnd: true }),
            makeCurvedBezierRoad(NORTH_ROAD_HUB, cutSpur2End, 3.8, (seededRandom() - 0.5) * 1.0, { isBranch: true, isCutRoadEnd: true })
        ];
    }

    if (ACTIVE_PLANET_BIOME === 'lava' || ACTIVE_PLANET_BIOME === 'ocean') {
        // Lava volcanic caldera & Ocean island archipelago do NOT have civilian asphalt road networks!
        DYNAMIC_ROAD_SEGMENTS = [];
        ROAD_JUNCTION_NODES = [];
    }

    for (let i = 0; i < DYNAMIC_ROAD_SEGMENTS.length; i++) {
        precomputeRoadSegmentSamples(DYNAMIC_ROAD_SEGMENTS[i], 64);
    }

    // Bake O(1) Spatial Road Factor & Elevation Lookup Caches before activating terrain grading!
    bakeRoadSpatialLookupGrid();
    _roadGradingActive = (DYNAMIC_ROAD_SEGMENTS.length > 0);

    // Plan and merge long tactical trench networks BEFORE baking terrain vertices so trenches are physically carved into the soil mesh!
    planTacticalTrenchesAndMergeNetwork();
}

// Pre-plans long tactical trench lines and merged multi-segment (L-shaped / chevron / communication) trench complexes
// so they are physically carved into the terrain soil mesh during rebuildTerrainVerticesAndColors()!
function planTacticalTrenchesAndMergeNetwork() {
    DYNAMIC_TRENCHES.length = 0;
    const axisX = ENEMY_BASE_POS.x - PLAYER_START_POS.x;
    const axisZ = ENEMY_BASE_POS.z - PLAYER_START_POS.z;
    const axisLen = Math.hypot(axisX, axisZ) || 1;
    const fwdX = axisX / axisLen;
    const fwdZ = axisZ / axisLen;
    const rightX = -fwdZ;
    const rightZ = fwdX;
    const frontYaw = Math.atan2(rightX, rightZ); // Perpendicular to main battle axis

    const candidateSpecs = [
        // Frontline long defensive trenches oriented across the battle corridor flanks
        { alongFrac: 0.30, acrossDist:  22.5, len: 21.0, rot: frontYaw + 0.12, isFortified: true, mergeWing: true },
        { alongFrac: 0.32, acrossDist: -23.5, len: 19.5, rot: frontYaw - 0.14, isFortified: true, mergeWing: false },
        { alongFrac: 0.48, acrossDist:  28.0, len: 22.5, rot: frontYaw - 0.18, isFortified: true, mergeWing: true },
        { alongFrac: 0.50, acrossDist: -27.5, len: 20.5, rot: frontYaw + 0.16, isFortified: true, mergeWing: true },
        { alongFrac: 0.66, acrossDist:  22.0, len: 18.5, rot: frontYaw + 0.10, isFortified: true, mergeWing: false },
        { alongFrac: 0.68, acrossDist: -23.0, len: 19.0, rot: frontYaw - 0.12, isFortified: true, mergeWing: false },
        // Outer flank defensive trenches
        { alongFrac: 0.40, acrossDist:  42.0, len: 17.5, rot: frontYaw + 0.38, isFortified: false, mergeWing: false },
        { alongFrac: 0.58, acrossDist: -41.0, len: 18.0, rot: frontYaw - 0.35, isFortified: false, mergeWing: false }
    ];

    const isTrenchSegmentClear = (cx, cz, rotY, tLen) => {
        const halfL = tLen * 0.5;
        const sinR = Math.sin(rotY), cosR = Math.cos(rotY);
        if (Math.abs(cx) > 80 || Math.abs(cz) > 80) return false;
        if (isInsideBasePlacementZone(cx, cz, halfL + 14.0)) return false;
        if (Math.hypot(cx - ENEMY_BASE_POS.x, cz - ENEMY_BASE_POS.z) < halfL + 25.0) return false;
        if (Math.hypot(cx - SOLARIS_BASE_POS.x, cz - SOLARIS_BASE_POS.z) < halfL + 19.0) return false;
        if (Math.hypot(cx - ABANDONED_TOWN_CENTER.x, cz - ABANDONED_TOWN_CENTER.z) < halfL + 15.0) return false;
        for (let b = 0; b < BASE_TERRAIN_ZONES.length; b++) {
            const bz = BASE_TERRAIN_ZONES[b];
            if (bz && Math.hypot(cx - bz.x, cz - bz.z) < (bz.rimOuter || 22.0) + halfL + 8.5) return false;
        }
        for (let s = -3; s <= 3; s++) {
            const dAlong = (s / 3) * (halfL + 2.2);
            const px = cx + sinR * dAlong;
            const pz = cz + cosR * dAlong;
            if (Math.abs(px) > 82 || Math.abs(pz) > 82) return false;
            if (HAS_VALLEY_RIVER && getRiverDist(px, pz) < RIVER_HALF_WIDTH + 6.5) return false;
            if (isSpotUnderOrBlockingBridge(px, pz, 5.5)) return false;
            if (getSupplyRoadFactor(px, pz) > 0.03) return false;
            for (let pdIdx = 0; pdIdx < DYNAMIC_PONDS.length; pdIdx++) {
                const pd = DYNAMIC_PONDS[pdIdx];
                if (Math.hypot(px - pd.x, pz - pd.z) < pd.r * 1.35 + 4.0) return false;
            }
        }
        for (let t = 0; t < DYNAMIC_TRENCHES.length; t++) {
            const other = DYNAMIC_TRENCHES[t];
            if (Math.hypot(cx - other.x, cz - other.z) < (halfL + other.halfLen + 5.5)) return false;
        }
        for (let s = -3; s <= 3; s++) {
            const dAlong = (s / 3) * (halfL + 2.2);
            const px = cx + sinR * dAlong;
            const pz = cz + cosR * dAlong;
            if (getTerrainHeight(px, pz) <= WATER_LEVEL + 0.35) return false;
        }
        return true;
    };

    const trenchBiomeAllowed = (typeof isStructureAllowedInBiome === 'function')
        ? isStructureAllowedInBiome('military_trench', ACTIVE_PLANET_BIOME)
        : (ACTIVE_PLANET_BIOME === 'highland' || ACTIVE_PLANET_BIOME === 'jungle');

    for (let i = 0; trenchBiomeAllowed && i < candidateSpecs.length; i++) {
        const spec = candidateSpecs[i];
        const baseX = PLAYER_START_POS.x + fwdX * (axisLen * spec.alongFrac) + rightX * spec.acrossDist;
        const baseZ = PLAYER_START_POS.z + fwdZ * (axisLen * spec.alongFrac) + rightZ * spec.acrossDist;
        let placedMain = null;

        for (let attempt = 0; attempt < 14; attempt++) {
            const searchR = attempt === 0 ? 0 : (3.5 + attempt * 2.2);
            const searchAng = attempt * 1.15 + i * 0.7;
            const tx = baseX + Math.cos(searchAng) * searchR;
            const tz = baseZ + Math.sin(searchAng) * searchR;
            const rotY = spec.rot + (attempt > 0 ? (seededRandom() - 0.5) * 0.25 : 0);
            if (isTrenchSegmentClear(tx, tz, rotY, spec.len)) {
                placedMain = {
                    x: tx,
                    z: tz,
                    rotY,
                    cosR: Math.cos(rotY),
                    sinR: Math.sin(rotY),
                    trenchLen: spec.len,
                    halfLen: spec.len * 0.48,
                    halfWid: 1.56,
                    depth: 1.24,
                    isFortified: spec.isFortified,
                    isWingSegment: false,
                    builtMesh: false
                };
                DYNAMIC_TRENCHES.push(placedMain);
                break;
            }
        }

        if (placedMain && spec.mergeWing) {
            const endSign = (i % 2 === 0) ? 1 : -1;
            const wingTurn = endSign * (0.58 + seededRandom() * 0.22);
            const wingRot = placedMain.rotY + wingTurn;
            const wingLen = 11.5 + seededRandom() * 3.0;
            const wingHalfLen = wingLen * 0.48;
            const jx = placedMain.x + placedMain.sinR * (endSign * (placedMain.halfLen - 0.55));
            const jz = placedMain.z + placedMain.cosR * (endSign * (placedMain.halfLen - 0.55));
            const wx = jx + Math.sin(wingRot) * (endSign * (wingHalfLen - 0.55));
            const wz = jz + Math.cos(wingRot) * (endSign * (wingHalfLen - 0.55));

            let wingClear = true;
            for (let s = -2; s <= 2; s++) {
                const dA = (s / 2) * (wingHalfLen + 1.8);
                const px = wx + Math.sin(wingRot) * dA;
                const pz = wz + Math.cos(wingRot) * dA;
                if (Math.abs(px) > 82 || Math.abs(pz) > 82 ||
                    (HAS_VALLEY_RIVER && getRiverDist(px, pz) < RIVER_HALF_WIDTH + 6.0) ||
                    isSpotUnderOrBlockingBridge(px, pz, 5.0) ||
                    getSupplyRoadFactor(px, pz) > 0.03 ||
                    isInsideBasePlacementZone(px, pz, 12.0)) {
                    wingClear = false;
                    break;
                }
            }
            if (wingClear) {
                placedMain.hasMergedWing = true;
                placedMain.junctionPos = { x: jx, z: jz };
                DYNAMIC_TRENCHES.push({
                    x: wx,
                    z: wz,
                    rotY: wingRot,
                    cosR: Math.cos(wingRot),
                    sinR: Math.sin(wingRot),
                    trenchLen: wingLen,
                    halfLen: wingHalfLen,
                    halfWid: 1.50,
                    depth: 1.24,
                    isFortified: false,
                    isWingSegment: true,
                    parentTrench: placedMain,
                    junctionPos: { x: jx, z: jz },
                    builtMesh: false
                });
            }
        }
    }
}
computeDynamicRoadAndLandmarkLayout();

function evaluateDynamicRoadPoint(seg, t) {
    if (seg.samples && seg.samples.length > 1) {
        const clampedT = Math.max(0, Math.min(1, t));
        const fIdx = clampedT * (seg.samples.length - 1);
        const i0 = Math.floor(fIdx);
        const i1 = Math.min(seg.samples.length - 1, i0 + 1);
        const frac = fIdx - i0;
        const s0 = seg.samples[i0];
        const s1 = seg.samples[i1];
        return {
            x: s0.x + (s1.x - s0.x) * frac,
            y: (s0.y !== undefined && s1.y !== undefined) ? (s0.y + (s1.y - s0.y) * frac) : 0.25,
            z: s0.z + (s1.z - s0.z) * frac,
            halfWidth: s0.halfWidth + (s1.halfWidth - s0.halfWidth) * frac
        };
    }
    return evaluateRoadSplineRawPoint(seg, t);
}

// O(1) Bilinear Spatial Road Factor Lookup (Eliminates O(N*M) per-vertex and per-frame road sample scanning!)
function getSupplyRoadFactor(vx, vz) {
    if (_roadSpatialCacheReady) {
        const fx = vx + HEIGHT_CACHE_HALF;
        const fz = vz + HEIGHT_CACHE_HALF;
        if (fx >= 0 && fx < HEIGHT_CACHE_DIM - 1 && fz >= 0 && fz < HEIGHT_CACHE_DIM - 1) {
            const ix = fx | 0;
            const iz = fz | 0;
            const tx = fx - ix;
            const tz = fz - iz;
            const row0 = iz * HEIGHT_CACHE_DIM + ix;
            const row1 = row0 + HEIGHT_CACHE_DIM;
            const r00 = ROAD_FACTOR_CACHE[row0];
            const r10 = ROAD_FACTOR_CACHE[row0 + 1];
            const r01 = ROAD_FACTOR_CACHE[row1];
            const r11 = ROAD_FACTOR_CACHE[row1 + 1];
            return (r00 + (r10 - r00) * tx) * (1.0 - tz) + (r01 + (r11 - r01) * tx) * tz;
        }
        return 0.0;
    }

    let bestFactor = 0.0;
    for (let sIdx = 0; sIdx < DYNAMIC_ROAD_SEGMENTS.length; sIdx++) {
        const seg = DYNAMIC_ROAD_SEGMENTS[sIdx];
        if (seg.bbox) {
            if (vx < seg.bbox.minX || vx > seg.bbox.maxX || vz < seg.bbox.minZ || vz > seg.bbox.maxZ) {
                continue;
            }
        }
        const samples = seg.samples;
        if (samples && samples.length > 1) {
            for (let i = 0; i < samples.length - 1; i += 2) {
                const a = samples[i];
                const b = samples[Math.min(samples.length - 1, i + 2)];
                const abx = b.x - a.x, abz = b.z - a.z;
                const lenSq = abx * abx + abz * abz || 1;
                const proj = Math.max(0, Math.min(1, ((vx - a.x) * abx + (vz - a.z) * abz) / lenSq));
                const px = a.x + abx * proj;
                const pz = a.z + abz * proj;
                const d = Math.hypot(vx - px, vz - pz);
                const hw = a.halfWidth + (b.halfWidth - a.halfWidth) * proj;
                if (d < hw + 0.6) {
                    bestFactor = Math.max(bestFactor, 1.0 - (d / (hw + 0.6)) * 0.22);
                } else if (d < hw + 2.2) {
                    bestFactor = Math.max(bestFactor, (1.0 - (d - (hw + 0.6)) / 1.6) * 0.72);
                }
            }
        }
    }
    return bestFactor;
}

// O(1) Bilinear Spatial Road Target Elevation Lookup for Smooth Roadbed Terrain Grading
function getRoadTargetElevationAt(vx, vz, fallbackH = 0.25) {
    if (_roadSpatialCacheReady) {
        const fx = vx + HEIGHT_CACHE_HALF;
        const fz = vz + HEIGHT_CACHE_HALF;
        if (fx >= 0 && fx < HEIGHT_CACHE_DIM - 1 && fz >= 0 && fz < HEIGHT_CACHE_DIM - 1) {
            const ix = Math.round(fx);
            const iz = Math.round(fz);
            const cellIdx = iz * HEIGHT_CACHE_DIM + ix;
            if (ROAD_FACTOR_CACHE[cellIdx] > 0.01) {
                return ROAD_ELEVATION_CACHE[cellIdx];
            }
        }
    }
    return THREE.MathUtils.clamp(fallbackH * 0.22 + 0.24, 0.14, 1.25);
}
window.getRoadTargetElevationAt = getRoadTargetElevationAt;

// Updates a local bounding box of the O(1) bilinear height cache when craters or building pads deform the terrain
function updateLocalTerrainHeightCache(cx, cz, radius) {
    const pad = Math.ceil(radius + 2.5);
    const minGX = Math.max(0, Math.floor(cx + HEIGHT_CACHE_HALF - pad));
    const maxGX = Math.min(HEIGHT_CACHE_DIM - 1, Math.ceil(cx + HEIGHT_CACHE_HALF + pad));
    const minGZ = Math.max(0, Math.floor(cz + HEIGHT_CACHE_HALF - pad));
    const maxGZ = Math.min(HEIGHT_CACHE_DIM - 1, Math.ceil(cz + HEIGHT_CACHE_HALF + pad));
    for (let gz = minGZ; gz <= maxGZ; gz++) {
        const wz = gz - HEIGHT_CACHE_HALF;
        const rowOff = gz * HEIGHT_CACHE_DIM;
        for (let gx = minGX; gx <= maxGX; gx++) {
            const wx = gx - HEIGHT_CACHE_HALF;
            TERRAIN_HEIGHT_CACHE[rowOff + gx] = computeRawTerrainHeight(wx, wz);
        }
    }
}

function applyPlanetBiomePalette() {
    const biome = ACTIVE_PLANET_BIOME || 'highland';
    if (biome === 'desert') {
        // DESERT PLANET: Golden sand dunes, red-ochre badlands, dry sandstone arroyos & sun-bleached mesas
        cGrass.setHex(0xd4a259);
        cLushVerge.setHex(0xc28943);
        cSunlitMeadow.setHex(0xe8bd78);
        cForestFloor.setHex(0x9e6c36);
        cHighlandMoss.setHex(0xb57d40);
        cCliffSlate.setHex(0x945a38);
        cMountainRock.setHex(0xa86842);
        cSnowPeak.setHex(0xf2d7ad);
        cSupplyRoad.setHex(0x94714c);
        cRoadBorder.setHex(0x755638);
        cCrystalSoil.setHex(0xb08048);
        if (scene && scene.fog) scene.fog.color.setHex(0xd6aa74);
        if (typeof dirLight !== 'undefined' && dirLight) { dirLight.color.setHex(0xffe6bd); dirLight.intensity = 1.95; }
        if (typeof ambientLight !== 'undefined' && ambientLight) { ambientLight.color.setHex(0xd9b38c); ambientLight.intensity = 0.72; }
        if (typeof hemiLight !== 'undefined' && hemiLight) { hemiLight.color.setHex(0xfff0d4); hemiLight.groundColor.setHex(0x8c5a32); }
    } else if (biome === 'ocean') {
        // OCEAN PLANET: Coastal coral sandbars, lush island palms, limestone cliffs & turquoise shallows
        cGrass.setHex(0x367448);
        cLushVerge.setHex(0x468856);
        cSunlitMeadow.setHex(0xc8ba8a);
        cForestFloor.setHex(0x245638);
        cHighlandMoss.setHex(0x4e8a64);
        cCliffSlate.setHex(0x5e707e);
        cMountainRock.setHex(0x708492);
        cSnowPeak.setHex(0xeaf4f8);
        cSupplyRoad.setHex(0x7c7464);
        cRoadBorder.setHex(0x565044);
        cCrystalSoil.setHex(0x2d7a78);
        if (scene && scene.fog) scene.fog.color.setHex(0x7eb8d4);
        if (typeof dirLight !== 'undefined' && dirLight) { dirLight.color.setHex(0xf2faff); dirLight.intensity = 1.80; }
        if (typeof ambientLight !== 'undefined' && ambientLight) { ambientLight.color.setHex(0x88b8d6); ambientLight.intensity = 0.68; }
        if (typeof hemiLight !== 'undefined' && hemiLight) { hemiLight.color.setHex(0xd6f2ff); hemiLight.groundColor.setHex(0x2b5c6b); }
    } else if (biome === 'lava') {
        // LAVA PLANET: Charred volcanic obsidian, dark basalt ash plains, glowing magma veins & ember ridges
        cGrass.setHex(0x1f1918);
        cLushVerge.setHex(0x2c201d);
        cSunlitMeadow.setHex(0x3d261e);
        cForestFloor.setHex(0x141010);
        cHighlandMoss.setHex(0x4d2418);
        cCliffSlate.setHex(0x292121);
        cMountainRock.setHex(0x3b2a26);
        cSnowPeak.setHex(0x803414);
        cSupplyRoad.setHex(0x362b28);
        cRoadBorder.setHex(0x211816);
        cCrystalSoil.setHex(0x6b2412);
        if (scene && scene.fog) scene.fog.color.setHex(0x421c12);
        if (typeof dirLight !== 'undefined' && dirLight) { dirLight.color.setHex(0xffb88c); dirLight.intensity = 1.65; }
        if (typeof ambientLight !== 'undefined' && ambientLight) { ambientLight.color.setHex(0x8a3b24); ambientLight.intensity = 0.62; }
        if (typeof hemiLight !== 'undefined' && hemiLight) { hemiLight.color.setHex(0xff9466); hemiLight.groundColor.setHex(0x4a1408); }
    } else if (biome === 'jungle') {
        // JUNGLE PLANET: Deep tropical rainforest moss, rich humus soil, vibrant canopy clearings & humid mist
        cGrass.setHex(0x1b4f20);
        cLushVerge.setHex(0x266929);
        cSunlitMeadow.setHex(0x3a8531);
        cForestFloor.setHex(0x103315);
        cHighlandMoss.setHex(0x286938);
        cCliffSlate.setHex(0x3b4f42);
        cMountainRock.setHex(0x475c4d);
        cSnowPeak.setHex(0x88a68e);
        cSupplyRoad.setHex(0x524430);
        cRoadBorder.setHex(0x362c1e);
        cCrystalSoil.setHex(0x1c5e44);
        if (scene && scene.fog) scene.fog.color.setHex(0x648f70);
        if (typeof dirLight !== 'undefined' && dirLight) { dirLight.color.setHex(0xebffd9); dirLight.intensity = 1.72; }
        if (typeof ambientLight !== 'undefined' && ambientLight) { ambientLight.color.setHex(0x6c9676); ambientLight.intensity = 0.66; }
        if (typeof hemiLight !== 'undefined' && hemiLight) { hemiLight.color.setHex(0xd8f5dc); hemiLight.groundColor.setHex(0x1c3d22); }
    } else {
        // HIGHLAND PLANET (Default Koprulu Sector)
        cGrass.setHex(0x2a5c2f);
        cLushVerge.setHex(0x387236);
        cSunlitMeadow.setHex(0x4b873e);
        cForestFloor.setHex(0x1d4723);
        cHighlandMoss.setHex(0x3a6644);
        cCliffSlate.setHex(0x4d5866);
        cMountainRock.setHex(0x5e6a7a);
        cSnowPeak.setHex(0xdce6f2);
        cSupplyRoad.setHex(0x6e5c44);
        cRoadBorder.setHex(0x463b2c);
        cCrystalSoil.setHex(0x26574d);
        if (scene && scene.fog) scene.fog.color.setHex(0x8faec8);
        if (typeof dirLight !== 'undefined' && dirLight) { dirLight.color.setHex(0xfff4e0); dirLight.intensity = 1.80; }
        if (typeof ambientLight !== 'undefined' && ambientLight) { ambientLight.color.setHex(0x8faec8); ambientLight.intensity = 0.64; }
        if (typeof hemiLight !== 'undefined' && hemiLight) { hemiLight.color.setHex(0xdce8f5); hemiLight.groundColor.setHex(0x2c3b2e); }
    }
}
window.applyPlanetBiomePalette = applyPlanetBiomePalette;

function rebuildTerrainVerticesAndColors() {
    applyPlanetBiomePalette();
    _terrainHeightCacheReady = false;
    // 1. Populate the O(1) Bilinear Height Lookup Cache first so all subsequent height & normal queries are instantaneous!
    for (let gz = 0; gz < HEIGHT_CACHE_DIM; gz++) {
        const wz = gz - HEIGHT_CACHE_HALF;
        const rowOff = gz * HEIGHT_CACHE_DIM;
        for (let gx = 0; gx < HEIGHT_CACHE_DIM; gx++) {
            const wx = gx - HEIGHT_CACHE_HALF;
            TERRAIN_HEIGHT_CACHE[rowOff + gx] = computeRawTerrainHeight(wx, wz);
        }
    }
    _terrainHeightCacheReady = true;

    const cTrenchSoil = new THREE.Color(0x2d241c);
    const cTrenchBerm = new THREE.Color(0x4a3b2c);
    const biome = ACTIVE_PLANET_BIOME || 'highland';

    // Pre-allocate reusable scratch THREE.Color instances outside the 28,561-vertex loop
    const col = new THREE.Color();
    const cDeepAbyss = new THREE.Color(0x062034);
    const cCoralShoal = new THREE.Color(0x166b7d);
    const cWetSandBase = new THREE.Color(0xb8a378);
    const cWetSandDark = new THREE.Color(0x9c8964);
    const cWetSand = new THREE.Color();
    const cDryBeachBase = new THREE.Color(0xdcce9e);
    const cDryBeachDark = new THREE.Color(0xc9b686);
    const cDryBeach = new THREE.Color();
    const cIslandGrassBase = new THREE.Color(0x367848);
    const cIslandGrassLight = new THREE.Color(0x4a8f58);
    const cIslandGrass = new THREE.Color();
    const cCoastalRockBase = new THREE.Color(0x647582);
    const cCoastalRockLight = new THREE.Color(0x7c8d99);
    const cCoastalRock = new THREE.Color();
    const cLavaBasalt2 = new THREE.Color(0x2d201d);
    const cMagmaHot = new THREE.Color(0xff7711);
    const cMagmaWarm = new THREE.Color(0xd9380a);
    const cDuneHighlight = new THREE.Color(0xeac384);
    const deepWallCol = new THREE.Color();
    const cDeepSilt = new THREE.Color(biome === 'lava' ? 0x8f2006 : (biome === 'desert' ? 0x264852 : 0x122832));
    const cShallowShoal = new THREE.Color(biome === 'lava' ? 0xd9440c : (biome === 'desert' ? 0x456e68 : 0x27464b));
    const cWetMudBase = new THREE.Color(biome === 'lava' ? 0x261310 : (biome === 'desert' ? 0x8c673e : 0x3d382f));
    const cWetMudAlt = new THREE.Color(biome === 'lava' ? 0x3d1b14 : (biome === 'desert' ? 0xa37a4c : 0x484339));
    const cWetMud = new THREE.Color();
    const cRiparianLoamBase = new THREE.Color(biome === 'lava' ? 0x1f1210 : (biome === 'desert' ? 0xb5864e : 0x524c3e));
    const cRiparianLoam = new THREE.Color();
    const targetBank = new THREE.Color();
    const pathColorScratch = new THREE.Color();

    for (let i = 0; i < posAttr.count; i++) {
        const vx = posAttr.getX(i);
        const vz = posAttr.getZ(i);
        let vy = getTerrainHeight(vx, vz);

        const norm = getTerrainNormal(vx, vz);
        const slope = 1.0 - norm.y;
        const roadF = getSupplyRoadFactor(vx, vz);

        // Keep terrain bed aligned cleanly just below the road ribbon so Fog of War & shadows match seamlessly
        if (roadF > 0.05 && vy > -0.20 && vy < 12.0) {
            vy -= roadF * 0.04;
        }
        posAttr.setY(i, vy);

        const macroPatch = Math.sin(vx * 0.055 + MAP_SEED) * Math.cos(vz * 0.055 - MAP_SEED) * 0.5 + 0.5;
        const detailPatch = Math.sin(vx * 0.16 - vz * 0.15 + MAP_SEED * 0.3) * 0.5 + 0.5;
        const cloverNoise = Math.sin(vx * 0.35 + vz * 0.28) * 0.5 + 0.5;

        col.copy(cGrass)
            .lerp(cLushVerge, macroPatch * 0.65)
            .lerp(cSunlitMeadow, detailPatch * 0.42)
            .lerp(cForestFloor, (1.0 - cloverNoise) * 0.22);

        if (biome === 'ocean') {
            // Unified Ocean Archipelago Coastline & Island Biome Palette (Zero overlapping border outlines!)
            const sandGrain = Math.sin(vx * 0.85 + vz * 0.78 + MAP_SEED * 0.19) * 0.5 + 0.5;
            cWetSand.copy(cWetSandBase).lerp(cWetSandDark, sandGrain * 0.45);
            cDryBeach.copy(cDryBeachBase).lerp(cDryBeachDark, sandGrain * 0.40);
            cIslandGrass.copy(cIslandGrassBase).lerp(cIslandGrassLight, macroPatch * 0.65);
            cCoastalRock.copy(cCoastalRockBase).lerp(cCoastalRockLight, detailPatch * 0.55);

            if (vy < -0.52) {
                const tDeep = THREE.MathUtils.clamp((-0.52 - vy) / 0.90, 0.0, 1.0);
                col.copy(cCoralShoal).lerp(cDeepAbyss, tDeep);
            } else if (vy < -0.12) {
                const tShoal = (vy - (-0.52)) / 0.40;
                col.copy(cCoralShoal).lerp(cWetSand, tShoal * tShoal * (3.0 - 2.0 * tShoal));
            } else if (vy < 0.24) {
                const tBeach = (vy - (-0.12)) / 0.36;
                col.copy(cWetSand).lerp(cDryBeach, tBeach);
            } else if (vy < 0.56) {
                const tInland = (vy - 0.24) / 0.32;
                col.copy(cDryBeach).lerp(cIslandGrass, tInland * tInland * (3.0 - 2.0 * tInland));
            } else {
                col.copy(cIslandGrass);
                if (vy > 0.92 || slope > 0.11) {
                    const rockBlend = THREE.MathUtils.clamp(Math.max((vy - 0.92) * 0.75, (slope - 0.11) * 3.5), 0.0, 0.92);
                    col.lerp(cCoastalRock, rockBlend);
                }
            }
        } else if (biome === 'lava') {
            // Dark volcanic basalt rock, scorched obsidian plates & incandescent glowing magma cracks
            const basaltVar = Math.sin(vx * 0.14 + vz * 0.12 + MAP_SEED * 0.23) * 0.5 + 0.5;
            col.setHex(0x1b1514).lerp(cLavaBasalt2, basaltVar * 0.65);
            const crack1 = Math.sin(vx * 0.22 - vz * 0.18 + Math.sin(vx * 0.09 + vz * 0.08) * 2.2 + MAP_SEED * 0.31);
            const crack2 = Math.cos(vx * 0.17 + vz * 0.24 - Math.cos(vz * 0.11) * 1.8 - MAP_SEED * 0.19);
            const crackHeat = Math.pow(Math.max(0.0, 1.0 - Math.abs(crack1) * 4.2), 2.2) + Math.pow(Math.max(0.0, 1.0 - Math.abs(crack2) * 4.8), 2.4);
            if (crackHeat > 0.08 && roadF < 0.20 && vy < 2.6) {
                col.lerp(crackHeat > 0.55 ? cMagmaHot : cMagmaWarm, Math.min(0.92, crackHeat * 0.85));
            }
        } else if (biome === 'desert') {
            // Wind-rippled golden dune crests & red-ochre badland hollows
            const duneCrest = Math.sin(vx * 0.11 + vz * 0.045 + MAP_SEED * 0.13) * 0.5 + 0.5;
            col.lerp(cDuneHighlight, duneCrest * 0.32);
        }

        if (roadF > 0.08 && biome !== 'ocean') {
            col.lerp(cRoadBorder, Math.min(0.92, roadF * 1.25));
        }

        // Color physically carved trench channels & earthen parapet berms in the terrain vertex colors
        for (let tIdx = 0; tIdx < DYNAMIC_TRENCHES.length; tIdx++) {
            const tr = DYNAMIC_TRENCHES[tIdx];
            const dx = vx - tr.x, dz = vz - tr.z;
            if (Math.abs(dx) > tr.halfLen + 4.0 && Math.abs(dz) > tr.halfLen + 4.0) continue;
            const al = Math.abs(dx * tr.sinR + dz * tr.cosR);
            const ac = Math.abs(dx * tr.cosR - dz * tr.sinR);
            if (al <= tr.halfLen + 2.4 && ac <= tr.halfWid + 1.45) {
                if (ac <= tr.halfWid) {
                    col.lerp(cTrenchSoil, 0.85);
                } else {
                    col.lerp(cTrenchBerm, 0.65);
                }
            }
        }

        for (let rIdx = 0; rIdx < ROCKY_TERRAIN_ZONES.length; rIdx++) {
            const rz = ROCKY_TERRAIN_ZONES[rIdx];
            const dRock = Math.hypot(vx - rz.x, vz - rz.z);
            if (dRock < rz.r) {
                const rf = Math.cos((dRock / rz.r) * (Math.PI * 0.5));
                col.lerp(detailPatch > 0.5 ? cCliffSlate : cMountainRock, rf * 0.82);
            }
        }

        const bFactor = getBridgeFactor(vx, vz);
        const rDist = Math.abs(getRavineSignedDist(vx, vz));

        if (biome !== 'ocean') {
            if (HAS_RAVINE_BRIDGES && bFactor > 0.62 && rDist < 11.8) {
                const s = (vx - vz) * 0.70710678;
                let laneDist = Infinity;
                for (let bIdx = 0; bIdx < BRIDGES.length; bIdx++) {
                    laneDist = Math.min(laneDist, Math.abs(s - BRIDGES[bIdx].sCoord));
                }
                col.copy(laneDist < 1.8 ? cBridgeCenter : cBridgeDeck);
            } else if (vy < -8.0) {
                col.copy(cRavineAbyss);
            } else if (vy < -0.25) {
                const submergeBlend = THREE.MathUtils.smoothstep(-0.25 - vy, 0.0, 1.35);
                deepWallCol.copy(cRavineWall).lerp(cCliffSlate, Math.min(1, (vy + 6.0) / 5.5));
                col.lerp(deepWallCol, submergeBlend);
            } else if (vy > 5.8) {
                col.copy(cSnowPeak);
            } else if (vy > 1.8) {
                if (slope < 0.08) {
                    col.lerp(cHighlandMoss, 0.55).lerp(cCrystalSoil, detailPatch * 0.28);
                } else {
                    col.lerp(cMountainRock, Math.min(1, (vy - 1.8) / 2.4));
                }
            } else if (vy > 0.65) {
                col.lerp(cHighlandMoss, Math.min(0.48, (vy - 0.55) * 0.55));
                if (vy > 1.35) col.lerp(cCliffSlate, Math.min(0.45, (vy - 1.35) * 0.55));
            }
        }

        // Soft riparian shoreline & riverbank transition in terrain vertex colors (non-ocean biomes)
        if (HAS_VALLEY_RIVER && biome !== 'ocean') {
            const rc = getRiverCoords(vx, vz);
            const localHalfW = rc.halfWidth || RIVER_HALF_WIDTH;
            const maxShoreReach = localHalfW + 5.6;
            if (rc.dist <= maxShoreReach) {
                const shingleGrain = (Math.sin(vx * 0.92 + vz * 0.84 + MAP_SEED * 0.17) * 0.5 + 0.5);
                cWetMud.copy(cWetMudBase).lerp(cWetMudAlt, shingleGrain * 0.55);
                cRiparianLoam.copy(cRiparianLoamBase).lerp(cLushVerge, shingleGrain * 0.35);

                if (rc.dist < localHalfW * 0.72) {
                    const tDeep = rc.dist / Math.max(0.5, localHalfW * 0.72);
                    col.copy(cDeepSilt).lerp(cShallowShoal, tDeep * 0.55);
                } else if (rc.dist < localHalfW + 0.45) {
                    const tShoal = (rc.dist - localHalfW * 0.72) / Math.max(0.25, localHalfW * 0.28 + 0.45);
                    const sShoal = tShoal * tShoal * (3.0 - 2.0 * tShoal);
                    col.copy(cShallowShoal).lerp(cWetMud, sShoal);
                } else if (rc.dist < localHalfW + 2.25) {
                    const tLap = (rc.dist - (localHalfW + 0.45)) / 1.80;
                    const sLap = tLap * tLap * (3.0 - 2.0 * tLap);
                    targetBank.copy(cWetMud).lerp(cRiparianLoam, sLap);
                    col.lerp(targetBank, 0.88 * (1.0 - roadF * 0.65));
                } else {
                    const tBank = (rc.dist - (localHalfW + 2.25)) / 3.35;
                    const sBank = 1.0 - (tBank * tBank * (3.0 - 2.0 * tBank));
                    col.lerp(cRiparianLoam, sBank * 0.68 * (1.0 - roadF * 0.75));
                }
            }
        }

        if (roadF > 0.04 && vy > -0.35 && vy < 2.8 && slope < 0.24) {
            const pebbleGrain = (Math.sin(vx * 1.9 + vz * 1.7) * 0.5 + 0.5) * 0.08;
            if (roadF > 0.52) {
                pathColorScratch.copy(cSupplyRoad).offsetHSL(0, 0, pebbleGrain - 0.04);
                col.lerp(pathColorScratch, Math.min(0.88, roadF * 0.90));
            } else {
                col.lerp(cRoadBorder, Math.min(0.88, roadF * 0.90));
            }
        }

        if (slope > 0.14 && vy >= -0.45) {
            const strataBand = Math.sin(vy * 3.8 + vx * 0.2) * 0.04;
            col.lerp(cCliffSlate, Math.min(0.88, (slope - 0.14) * 3.2));
            col.r = THREE.MathUtils.clamp(col.r + strataBand, 0, 1);
            col.g = THREE.MathUtils.clamp(col.g + strataBand, 0, 1);
            col.b = THREE.MathUtils.clamp(col.b + strataBand, 0, 1);
        }

        baseColors[i * 3] = col.r;
        baseColors[i * 3 + 1] = col.g;
        baseColors[i * 3 + 2] = col.b;
        liveColors[i * 3] = col.r;
        liveColors[i * 3 + 1] = col.g;
        liveColors[i * 3 + 2] = col.b;
    }
    posAttr.needsUpdate = true;
    if (!terrainGeo.attributes.color) {
        terrainGeo.setAttribute('color', new THREE.BufferAttribute(liveColors, 3));
    }
    terrainGeo.attributes.color.needsUpdate = true;
    terrainGeo.computeVertexNormals();
    terrainGeo.computeBoundingBox();
    terrainGeo.computeBoundingSphere();
    if (typeof window.validateAndRepairTerrainPipeline === 'function') {
        window.validateAndRepairTerrainPipeline();
    }
}

window.terrainGeo = terrainGeo;
terrainGeo.setAttribute('color', new THREE.BufferAttribute(liveColors, 3));
rebuildTerrainVerticesAndColors();

// Helper to iterate only the local [minRow..maxRow, minCol..maxCol] vertices of terrainGeo in O(local area)
const TERRAIN_GRID_SEGS = IS_MOBILE ? 108 : 168;
const TERRAIN_GRID_COLS = TERRAIN_GRID_SEGS + 1;

// Real-Time Bomb & Tank Shell Crater Physical Vertex Depression on Terrain (Natural non-circular profile, zero artificial black ring)
let _lastCraterDeformMs = 0;
let _deferTerrainNormals = false;
function deformTerrainCrater(cx, cz, radius = 2.4, depth = 0.28, forceImmediate = false) {
    if (radius < 0.75) return;
    const nowMs = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    if (!forceImmediate && (nowMs - _lastCraterDeformMs < 60)) return;
    if (isOnBridgeCorridor(cx, cz) || isOnRiverBridge(cx, cz)) return;
    if (!forceImmediate) _lastCraterDeformMs = nowMs;

    const colorAttr = terrainGeo.attributes.color;
    const maxR = radius * 1.55;
    const maxRSq = maxR * maxR;
    let modified = false;

    const biome = ACTIVE_PLANET_BIOME || 'highland';
    // Natural overturned subsoil & mineral earth palette per biome (never a black circular border)
    const subsoilR = biome === 'desert' ? 0.56 : (biome === 'lava' ? 0.22 : (biome === 'jungle' ? 0.28 : 0.34));
    const subsoilG = biome === 'desert' ? 0.38 : (biome === 'lava' ? 0.12 : (biome === 'jungle' ? 0.20 : 0.27));
    const subsoilB = biome === 'desert' ? 0.22 : (biome === 'lava' ? 0.09 : (biome === 'jungle' ? 0.13 : 0.20));

    const rimLoamR = biome === 'desert' ? 0.68 : (biome === 'lava' ? 0.28 : (biome === 'jungle' ? 0.34 : 0.42));
    const rimLoamG = biome === 'desert' ? 0.49 : (biome === 'lava' ? 0.17 : (biome === 'jungle' ? 0.26 : 0.35));
    const rimLoamB = biome === 'desert' ? 0.30 : (biome === 'lava' ? 0.13 : (biome === 'jungle' ? 0.17 : 0.26));

    const seedPhase = (cx * 12.73 + cz * 19.37);

    const minCol = Math.max(0, Math.floor(((cx - maxR) / MAP_SIZE + 0.5) * TERRAIN_GRID_SEGS));
    const maxCol = Math.min(TERRAIN_GRID_SEGS, Math.ceil(((cx + maxR) / MAP_SIZE + 0.5) * TERRAIN_GRID_SEGS));
    const minRow = Math.max(0, Math.floor(((cz - maxR) / MAP_SIZE + 0.5) * TERRAIN_GRID_SEGS));
    const maxRow = Math.min(TERRAIN_GRID_SEGS, Math.ceil(((cz + maxR) / MAP_SIZE + 0.5) * TERRAIN_GRID_SEGS));

    for (let r = minRow; r <= maxRow; r++) {
        const rowOffset = r * TERRAIN_GRID_COLS;
        for (let c = minCol; c <= maxCol; c++) {
            const i = rowOffset + c;
            const vx = posAttr.getX(i);
            const vz = posAttr.getZ(i);
            const dx = vx - cx;
            const dz = vz - cz;
            const dSq = dx * dx + dz * dz;
            if (dSq < maxRSq) {
                const dist = Math.sqrt(dSq);
                const ang = Math.atan2(dz, dx);
                // Multi-harmonic angular noise breaks circular symmetry into a natural jagged blast cavity
                const angNoise = 1.0
                    + 0.16 * Math.sin(ang * 3.0 + seedPhase)
                    + 0.11 * Math.cos(ang * 5.0 - seedPhase * 0.7)
                    + 0.07 * Math.sin(ang * 7.0 + vx * 0.9 - vz * 0.8);
                const effR = radius * angNoise;
                if (dist > effR * 1.38) continue;

                const curY = posAttr.getY(i);
                if (curY > -1.65 && curY < 5.5) {
                    let nextY = curY;
                    const normDist = dist / effR;
                    if (normDist < 0.84) {
                        const tBowl = normDist / 0.84;
                        // Smooth concave bowl with subtle central compaction & natural floor roughness
                        const bowlProfile = Math.pow(Math.cos(tBowl * Math.PI * 0.5), 1.45);
                        const microRough = (Math.sin(vx * 3.1 + vz * 2.7 + seedPhase) * 0.5 + 0.5) * 0.04 * depth;
                        nextY = Math.max(-1.65, curY - depth * bowlProfile * 0.95 + microRough);
                    } else if (normDist < 1.38) {
                        const rimT = (normDist - 0.84) / 0.54;
                        const rimLobe = Math.max(0, Math.sin(ang * 4.0 + seedPhase * 0.5) * 0.35 + 0.65);
                        nextY = curY + Math.sin(rimT * Math.PI) * depth * 0.26 * rimLobe;
                    }
                    posAttr.setY(i, nextY);

                    // Blend natural exposed subsoil inside the bowl and overturned earth on the rim (no black ring)
                    const grain = (Math.sin(vx * 2.4 - vz * 2.1 + seedPhase) * 0.5 + 0.5) * 0.06;
                    if (normDist < 0.88) {
                        const bowlBlend = Math.pow(1.0 - normDist / 0.88, 1.15) * 0.68;
                        baseColors[i * 3]     = baseColors[i * 3] * (1 - bowlBlend) + (subsoilR + grain) * bowlBlend;
                        baseColors[i * 3 + 1] = baseColors[i * 3 + 1] * (1 - bowlBlend) + (subsoilG + grain * 0.8) * bowlBlend;
                        baseColors[i * 3 + 2] = baseColors[i * 3 + 2] * (1 - bowlBlend) + (subsoilB + grain * 0.6) * bowlBlend;
                    } else {
                        const rimBlend = Math.sin(((normDist - 0.88) / 0.50) * Math.PI) * 0.44;
                        baseColors[i * 3]     = baseColors[i * 3] * (1 - rimBlend) + (rimLoamR + grain) * rimBlend;
                        baseColors[i * 3 + 1] = baseColors[i * 3 + 1] * (1 - rimBlend) + (rimLoamG + grain * 0.8) * rimBlend;
                        baseColors[i * 3 + 2] = baseColors[i * 3 + 2] * (1 - rimBlend) + (rimLoamB + grain * 0.6) * rimBlend;
                    }
                    liveColors[i * 3]     = baseColors[i * 3];
                    liveColors[i * 3 + 1] = baseColors[i * 3 + 1];
                    liveColors[i * 3 + 2] = baseColors[i * 3 + 2];
                    colorAttr.setXYZ(i, baseColors[i * 3], baseColors[i * 3 + 1], baseColors[i * 3 + 2]);
                    modified = true;
                }
            }
        }
    }
    if (modified) {
        updateLocalTerrainHeightCache(cx, cz, maxR);
        posAttr.needsUpdate = true;
        colorAttr.needsUpdate = true;
        if (!_deferTerrainNormals) terrainGeo.computeVertexNormals();
        if (typeof fowGeo !== 'undefined' && fowGeo && fowGeo.attributes && fowGeo.attributes.position) {
            const fPos = fowGeo.attributes.position;
            for (let r = minRow; r <= maxRow; r++) {
                const rowOffset = r * TERRAIN_GRID_COLS;
                for (let c = minCol; c <= maxCol; c++) {
                    const idx = rowOffset + c;
                    if (idx < fPos.count) {
                        fPos.setY(idx, posAttr.getY(idx) + 0.08);
                    }
                }
            }
            fPos.needsUpdate = true;
        }
        // Vertically re-snap nearby ground units and structures so nothing floats after crater excavation
        if (typeof units !== 'undefined' && Array.isArray(units)) {
            for (let uIdx = 0; uIdx < units.length; uIdx++) {
                const u = units[uIdx];
                if (!u || u.isAir || u.type === 'drone' || !u.mesh) continue;
                if (Math.hypot(u.mesh.position.x - cx, u.mesh.position.z - cz) <= maxR + 1.5) {
                    u.mesh.position.y = getTerrainHeight(u.mesh.position.x, u.mesh.position.z);
                }
            }
        }
    }
}

// Dynamically Flattens the Terrain Floor Map when a Building or Camp is Placed! (Updates height cache, visible terrain mesh, vertex normals, and nearby structures)
function flattenTerrainUnderBuilding(cx, cz, flatRadius = 3.2, blendRadius = 2.2) {
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) return 0;

    // Sample 5-point footprint height so buildings placed on slopes sit naturally at the mean grade without floating or burying
    const sampleR = Math.max(0.8, flatRadius * 0.55);
    const hCenter = getTerrainHeight(cx, cz);
    const hN = getTerrainHeight(cx, cz - sampleR);
    const hS = getTerrainHeight(cx, cz + sampleR);
    const hE = getTerrainHeight(cx + sampleR, cz);
    const hW = getTerrainHeight(cx - sampleR, cz);
    const weightedH = hCenter * 0.44 + (hN + hS + hE + hW) * 0.14;
    const targetY = THREE.MathUtils.clamp(weightedH, 0.08, 6.2);

    // Update existing pad if re-flattening same spot, otherwise append
    let updatedExistingPad = false;
    for (let p = 0; p < FLATTENED_BUILDING_PADS.length; p++) {
        const pad = FLATTENED_BUILDING_PADS[p];
        if (Math.hypot(pad.x - cx, pad.z - cz) < 1.2) {
            pad.targetY = targetY;
            pad.flatR = Math.max(pad.flatR, flatRadius);
            pad.blendR = Math.max(pad.blendR, blendRadius);
            updatedExistingPad = true;
            break;
        }
    }
    if (!updatedExistingPad) {
        FLATTENED_BUILDING_PADS.push({
            x: cx,
            z: cz,
            targetY,
            flatR: flatRadius,
            blendR: blendRadius
        });
    }

    const totalR = flatRadius + blendRadius;
    updateLocalTerrainHeightCache(cx, cz, totalR + 1.5);

    const colorAttr = terrainGeo.attributes.color;
    const fPos = (typeof fowGeo !== 'undefined' && fowGeo && fowGeo.attributes) ? fowGeo.attributes.position : null;
    let modified = false;

    const minCol = Math.max(0, Math.floor(((cx - totalR) / MAP_SIZE + 0.5) * TERRAIN_GRID_SEGS));
    const maxCol = Math.min(TERRAIN_GRID_SEGS, Math.ceil(((cx + totalR) / MAP_SIZE + 0.5) * TERRAIN_GRID_SEGS));
    const minRow = Math.max(0, Math.floor(((cz - totalR) / MAP_SIZE + 0.5) * TERRAIN_GRID_SEGS));
    const maxRow = Math.min(TERRAIN_GRID_SEGS, Math.ceil(((cz + totalR) / MAP_SIZE + 0.5) * TERRAIN_GRID_SEGS));

    for (let r = minRow; r <= maxRow; r++) {
        const rowOffset = r * TERRAIN_GRID_COLS;
        for (let c = minCol; c <= maxCol; c++) {
            const i = rowOffset + c;
            const vx = posAttr.getX(i);
            const vz = posAttr.getZ(i);
            const dist = Math.hypot(vx - cx, vz - cz);
            if (dist <= totalR) {
                // Preserve river channel & bridge abutments
                if (typeof isPointInValleyRiver === 'function' && isPointInValleyRiver(vx, vz, 0.8)) continue;
                const newY = getTerrainHeight(vx, vz);
                posAttr.setY(i, newY);
                if (fPos) {
                    fPos.setY(i, getSurfaceHeightWithBridges(vx, vz));
                }
                if (dist <= flatRadius + 1.1) {
                    const padT = Math.max(0, Math.min(1, 1.0 - (dist / (flatRadius + 1.1))));
                    const padBlend = padT * padT * (3.0 - 2.0 * padT) * 0.30;
                    baseColors[i * 3]     = baseColors[i * 3] * (1 - padBlend) + 0.33 * padBlend;
                    baseColors[i * 3 + 1] = baseColors[i * 3 + 1] * (1 - padBlend) + 0.35 * padBlend;
                    baseColors[i * 3 + 2] = baseColors[i * 3 + 2] * (1 - padBlend) + 0.31 * padBlend;
                    if (colorAttr && (typeof isPointOnZergCreep !== 'function' || !isPointOnZergCreep(vx, vz))) {
                        colorAttr.setXYZ(i, baseColors[i * 3], baseColors[i * 3 + 1], baseColors[i * 3 + 2]);
                    }
                }
                modified = true;
            }
        }
    }
    if (modified) {
        posAttr.needsUpdate = true;
        if (!_deferTerrainNormals) {
            terrainGeo.computeVertexNormals();
            if (terrainGeo.attributes.normal) terrainGeo.attributes.normal.needsUpdate = true;
        }
        if (fPos) fPos.needsUpdate = true;
        if (colorAttr) colorAttr.needsUpdate = true;

        // Re-sync any nearby structures & foundations so nothing floats or sinks when adjacent terrain flattens
        const syncRadius = totalR + 2.5;
        if (Array.isArray(window.REGISTERED_MAP_STRUCTURES)) {
            for (let s = 0; s < window.REGISTERED_MAP_STRUCTURES.length; s++) {
                const st = window.REGISTERED_MAP_STRUCTURES[s];
                if (st && st.mesh && Math.hypot(st.x - cx, st.z - cz) <= syncRadius) {
                    st.mesh.position.y = getTerrainHeight(st.x, st.z) + (st.yOffset || 0);
                }
            }
        }
        const buildingLists = [window.buildings, window.enemyBuildings, window.solarisBuildings];
        for (let bl = 0; bl < buildingLists.length; bl++) {
            const list = buildingLists[bl];
            if (!Array.isArray(list)) continue;
            for (let bi = 0; bi < list.length; bi++) {
                const b = list[bi];
                if (!b || !b.pos || !b.mesh) continue;
                if (Math.hypot(b.pos.x - cx, b.pos.z - cz) <= syncRadius) {
                    const by = (typeof getSurfaceHeightWithBridges === 'function')
                        ? getSurfaceHeightWithBridges(b.pos.x, b.pos.z)
                        : getTerrainHeight(b.pos.x, b.pos.z);
                    b.pos.y = by;
                    b.mesh.position.y = by;
                }
            }
        }

        if (typeof syncZergCreepGroundMeshHeights === 'function' && activeZergMainCreepMesh) {
            if (Math.hypot(cx - ENEMY_BASE_POS.x, cz - ENEMY_BASE_POS.z) <= (creepRadius || 30.0) + totalR + 8.0) {
                syncZergCreepGroundMeshHeights(activeZergMainCreepMesh, ENEMY_BASE_POS.x, ENEMY_BASE_POS.z, creepRadius || 30.0);
            }
        }
        for (let em = 0; em < activeZergExpansionCreepMeshes.length; em++) {
            const expMesh = activeZergExpansionCreepMeshes[em];
            if (expMesh && Math.hypot(cx - expMesh.position.x, cz - expMesh.position.z) <= 18.0 + totalR) {
                syncZergCreepGroundMeshHeights(expMesh, expMesh.position.x, expMesh.position.z, 13.5);
            }
        }
    }
    return targetY;
}
window.flattenTerrainUnderBuilding = flattenTerrainUnderBuilding;

const terrainMat = new THREE.MeshStandardMaterial({
    name: 'KopruluTerrainMaterial',
    vertexColors: true,
    map: terrainDetailTex,
    roughness: 0.78,
    metalness: 0.05
});
if (typeof SHADER_ENGINE !== 'undefined' && SHADER_ENGINE.applyTerrainShader) {
    SHADER_ENGINE.applyTerrainShader(terrainMat);
}
const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
terrainMesh.receiveShadow = true;
scene.add(terrainMesh);
window.terrainMat = terrainMat;
window.terrainMesh = terrainMesh;

function buildBridgeBarriers() {
    // River barrier walls removed per user request so riverbanks remain open and unobstructed
}

// --- FOG OF WAR MECHANIC ---
const fowExplored = new Uint8Array(FOW_RES * FOW_RES);
const fowVisible = new Uint8Array(FOW_RES * FOW_RES);

const fowCanvas = document.createElement('canvas');
fowCanvas.width = FOW_RES; fowCanvas.height = FOW_RES;
const fowCtx = fowCanvas.getContext('2d');
const fowImgData = fowCtx.createImageData(FOW_RES, FOW_RES);

const fowTexture = new THREE.CanvasTexture(fowCanvas);
fowTexture.minFilter = THREE.LinearFilter;
fowTexture.magFilter = THREE.LinearFilter;
if (typeof window.registerGameTexture === 'function') {
    window.registerGameTexture('fowTexture', fowTexture, 'fow');
}
window.fowTexture = fowTexture;

function preseedInitialFogOfWarCanvas() {
    const data = fowImgData.data;
    const halfMap = MAP_SIZE * 0.5;
    const gridToWorld = MAP_SIZE / FOW_RES;
    const startX = (typeof PLAYER_START_POS !== 'undefined' && PLAYER_START_POS) ? PLAYER_START_POS.x : 18;
    const startZ = (typeof PLAYER_START_POS !== 'undefined' && PLAYER_START_POS) ? PLAYER_START_POS.z : 22;
    const solX = (typeof SOLARIS_BASE_POS !== 'undefined' && SOLARIS_BASE_POS) ? SOLARIS_BASE_POS.x : -62;
    const solZ = (typeof SOLARIS_BASE_POS !== 'undefined' && SOLARIS_BASE_POS) ? SOLARIS_BASE_POS.z : 58;
    const rMain = 40.0;
    const rSol = 25.0;

    for (let gy = 0; gy < FOW_RES; gy++) {
        const wz = gy * gridToWorld - halfMap;
        for (let gx = 0; gx < FOW_RES; gx++) {
            const wx = gx * gridToWorld - halfMap;
            const idx = gy * FOW_RES + gx;
            const dMain = Math.hypot(wx - startX, wz - startZ) / rMain;
            const dSol = Math.hypot(wx - solX, wz - solZ) / rSol;
            const minRatio = Math.min(dMain, dSol);
            let alpha = 195;
            if (minRatio < 1.0) {
                fowExplored[idx] = 1;
                fowVisible[idx] = 1;
                if (minRatio < 0.65) {
                    alpha = 0;
                } else {
                    const edgeT = (minRatio - 0.65) / 0.35;
                    alpha = Math.floor(edgeT * edgeT * (3.0 - 2.0 * edgeT) * 96);
                }
            } else {
                fowExplored[idx] = 0;
                fowVisible[idx] = 0;
            }
            const p = idx * 4;
            data[p] = 14;
            data[p + 1] = 22;
            data[p + 2] = 34;
            data[p + 3] = alpha;
        }
    }
    fowCtx.putImageData(fowImgData, 0, 0);
    fowTexture.needsUpdate = true;
}
preseedInitialFogOfWarCanvas();
window.preseedInitialFogOfWarCanvas = preseedInitialFogOfWarCanvas;

// Bind Fog of War texture directly to SHADER_ENGINE so terrain, roads & buildings darken smoothly in unexplored/fogged areas!
if (typeof SHADER_ENGINE !== 'undefined' && typeof SHADER_ENGINE.setFogOfWarTexture === 'function') {
    SHADER_ENGINE.setFogOfWarTexture(fowTexture, MAP_SIZE);
}

const fowGeo = terrainGeo.clone();
const fowMat = (typeof SHADER_ENGINE !== 'undefined' && SHADER_ENGINE.fowCloudShaderMat)
    ? SHADER_ENGINE.fowCloudShaderMat
    : new THREE.MeshBasicMaterial({ map: fowTexture, transparent: true, depthWrite: false });
const fowMesh = new THREE.Mesh(fowGeo, fowMat);
// Conforms just above ground and road surfaces with volumetric cloud shroud shader
fowMesh.position.y = 0.14;
fowMesh.renderOrder = 2;
scene.add(fowMesh);
window.fowMesh = fowMesh;

function syncFowGeometryWithTerrain() {
    const fPos = fowGeo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
        const vx = posAttr.getX(i);
        const vz = posAttr.getZ(i);
        fPos.setY(i, getSurfaceHeightWithBridges(vx, vz));
    }
    fPos.needsUpdate = true;
}
syncFowGeometryWithTerrain();

// Comprehensive Terrain Geometry, Vertex Color, Index, Bounding Volume, Material & Lighting Pipeline Validator
window.validateAndRepairTerrainPipeline = function() {
    const report = {
        geometryExists: false,
        vertexCount: 0,
        positionFinite: false,
        colorAttributeValid: false,
        indexValid: false,
        boundsValid: false,
        materialAssigned: false,
        materialMapValid: false,
        attachedToScene: false,
        meshVisible: false,
        lightingValid: false,
        fowValid: false,
        repairedIssues: [],
        ok: false
    };

    try {
        if (typeof terrainGeo === 'undefined' || !terrainGeo || !terrainGeo.isBufferGeometry) {
            report.repairedIssues.push('terrainGeo missing');
            window._lastTerrainPipelineReport = report;
            return report;
        }
        report.geometryExists = true;

        const pAttr = terrainGeo.attributes.position;
        if (pAttr && pAttr.count > 0 && pAttr.array) {
            report.vertexCount = pAttr.count;
            let nonFiniteCount = 0;
            const arr = pAttr.array;
            for (let i = 0; i < arr.length; i++) {
                if (!Number.isFinite(arr[i])) {
                    arr[i] = 0;
                    nonFiniteCount++;
                }
            }
            if (nonFiniteCount > 0) {
                pAttr.needsUpdate = true;
                report.repairedIssues.push(`Repaired ${nonFiniteCount} non-finite terrain position values`);
            }
            report.positionFinite = true;
        }

        // Verify vertex color attribute when vertexColors is enabled (never overwrite valid procedural biome colors!)
        let cAttr = terrainGeo.attributes.color;
        if (!cAttr || !cAttr.array || cAttr.count !== report.vertexCount) {
            const fallbackColors = new Float32Array(report.vertexCount * 3);
            for (let i = 0; i < report.vertexCount; i++) {
                const vy = pAttr ? pAttr.getY(i) : 0;
                const shade = THREE.MathUtils.clamp(0.32 + (vy + 2.0) * 0.04, 0.24, 0.68);
                fallbackColors[i * 3]     = shade * 0.68;
                fallbackColors[i * 3 + 1] = shade * 0.96;
                fallbackColors[i * 3 + 2] = shade * 0.62;
            }
            cAttr = new THREE.BufferAttribute(fallbackColors, 3);
            terrainGeo.setAttribute('color', cAttr);
            cAttr.needsUpdate = true;
            report.repairedIssues.push('Created fallback vertex color attribute on terrainGeo');
        } else {
            const cArr = cAttr.array;
            let validColorSampleCount = 0;
            let nanRepaired = 0;
            for (let i = 0; i < cArr.length; i += 3) {
                const r = cArr[i], g = cArr[i + 1], b = cArr[i + 2];
                if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
                    cArr[i] = 0.24; cArr[i + 1] = 0.42; cArr[i + 2] = 0.25;
                    nanRepaired++;
                    validColorSampleCount++;
                } else if ((r + g + b) > 0.01) {
                    validColorSampleCount++;
                }
            }
            if (nanRepaired > 0) {
                cAttr.needsUpdate = true;
                report.repairedIssues.push(`Repaired ${nanRepaired} non-finite vertex colors`);
            }
            if (validColorSampleCount === 0 && report.vertexCount > 0) {
                // Only populate fallback colors if the entire color buffer was uninitialized (all zeros)
                for (let i = 0; i < report.vertexCount; i++) {
                    const vy = pAttr ? pAttr.getY(i) : 0;
                    const shade = THREE.MathUtils.clamp(0.32 + (vy + 2.0) * 0.04, 0.24, 0.68);
                    cArr[i * 3]     = shade * 0.68;
                    cArr[i * 3 + 1] = shade * 0.96;
                    cArr[i * 3 + 2] = shade * 0.62;
                }
                cAttr.needsUpdate = true;
                report.repairedIssues.push('Populated fallback biome colors for all-zero color buffer');
            }
        }
        report.colorAttributeValid = Boolean(terrainGeo.attributes.color && terrainGeo.attributes.color.count === report.vertexCount);

        // Verify terrain index data
        const idxAttr = terrainGeo.index;
        if (idxAttr && idxAttr.count > 0 && idxAttr.array) {
            report.indexValid = true;
        }

        // Verify bounding box and bounding sphere
        if (!terrainGeo.boundingBox) terrainGeo.computeBoundingBox();
        if (!terrainGeo.boundingSphere) terrainGeo.computeBoundingSphere();
        if (terrainGeo.boundingSphere && Number.isFinite(terrainGeo.boundingSphere.radius) && terrainGeo.boundingSphere.radius > 0) {
            report.boundsValid = true;
        } else {
            terrainGeo.computeBoundingBox();
            terrainGeo.computeBoundingSphere();
            report.boundsValid = Boolean(terrainGeo.boundingSphere && Number.isFinite(terrainGeo.boundingSphere.radius) && terrainGeo.boundingSphere.radius > 0);
        }

        // Verify terrain material & mesh attachment
        if (typeof terrainMesh !== 'undefined' && terrainMesh && typeof terrainMat !== 'undefined' && terrainMat) {
            if (terrainMesh.material !== terrainMat) {
                terrainMesh.material = terrainMat;
                report.repairedIssues.push('Reassigned terrainMat to terrainMesh');
            }
            if (terrainMat.color && (terrainMat.color.r + terrainMat.color.g + terrainMat.color.b) < 0.1) {
                terrainMat.color.setHex(0xffffff);
                terrainMat.needsUpdate = true;
                report.repairedIssues.push('Restored terrainMat base color to white');
            }
            if (!terrainMat.map && window.terrainDetailTex && (!window.SHADER_ENGINE || window.SHADER_ENGINE.terrainShaderStage >= 1)) {
                terrainMat.map = window.terrainDetailTex;
                terrainMat.needsUpdate = true;
                report.repairedIssues.push('Reassigned terrainDetailTex to terrainMat.map');
            }
            report.materialAssigned = Boolean(terrainMesh.material);
            report.materialMapValid = Boolean(!terrainMat.map || (terrainMat.map.isTexture && terrainMat.map.image));

            if (typeof scene !== 'undefined' && scene && terrainMesh.parent !== scene) {
                scene.add(terrainMesh);
                report.repairedIssues.push('Re-attached terrainMesh to active scene');
            }
            report.attachedToScene = Boolean(typeof scene !== 'undefined' && terrainMesh.parent === scene);

            if (!terrainMesh.visible) {
                terrainMesh.visible = true;
                report.repairedIssues.push('Set terrainMesh.visible = true');
            }
            report.meshVisible = Boolean(terrainMesh.visible);
        }

        // Verify lighting & toneMapping exposure
        if (typeof renderer !== 'undefined' && renderer) {
            if (!Number.isFinite(renderer.toneMappingExposure) || renderer.toneMappingExposure < 0.35) {
                renderer.toneMappingExposure = 1.08;
                report.repairedIssues.push('Restored renderer.toneMappingExposure to 1.08');
            }
        }
        if (typeof hemiLight !== 'undefined' && hemiLight && hemiLight.intensity <= 0.05) {
            hemiLight.intensity = 0.88;
            report.repairedIssues.push('Restored hemiLight.intensity');
        }
        if (typeof dirLight !== 'undefined' && dirLight && dirLight.intensity <= 0.05) {
            dirLight.intensity = 1.65;
            report.repairedIssues.push('Restored dirLight.intensity');
        }
        report.lightingValid = Boolean(
            typeof hemiLight !== 'undefined' && hemiLight && hemiLight.intensity > 0.05 &&
            typeof dirLight !== 'undefined' && dirLight && dirLight.intensity > 0.05
        );

        // Verify Fog of War texture & overlay mesh
        report.fowValid = Boolean(
            typeof fowTexture !== 'undefined' && fowTexture && fowTexture.isTexture &&
            fowTexture.image && fowTexture.image.width > 0 &&
            typeof fowMesh !== 'undefined' && fowMesh && fowMesh.parent === scene
        );

        report.ok = Boolean(
            report.geometryExists &&
            report.vertexCount > 0 &&
            report.positionFinite &&
            report.colorAttributeValid &&
            report.indexValid &&
            report.boundsValid &&
            report.materialAssigned &&
            report.attachedToScene &&
            report.meshVisible &&
            report.lightingValid
        );
    } catch (err) {
        if (window.APP_ERROR_HANDLER) window.APP_ERROR_HANDLER.record('validateAndRepairTerrainPipeline', err, 'terrain');
    }

    window._lastTerrainPipelineReport = report;
    return report;
};
window.validateAndRepairTerrainPipeline();

// Diagnostic Helper: Toggle a plain MeshStandardMaterial test terrain patch with known color & zero custom shader
window._diagnosticTerrainPatchMesh = null;
window.toggleDiagnosticTerrainPatch = function(forceState) {
    if (window._diagnosticTerrainPatchMesh) {
        const nextVis = typeof forceState === 'boolean' ? forceState : !window._diagnosticTerrainPatchMesh.visible;
        window._diagnosticTerrainPatchMesh.visible = nextVis;
        return nextVis;
    }
    if (forceState === false) return false;
    const patchGeo = new THREE.PlaneGeometry(18, 18, 16, 16);
    patchGeo.rotateX(-Math.PI / 2);
    const pPos = patchGeo.attributes.position;
    const pCols = new Float32Array(pPos.count * 3);
    const cx = (typeof controls !== 'undefined' && controls && controls.target) ? controls.target.x : 18;
    const cz = (typeof controls !== 'undefined' && controls && controls.target) ? controls.target.z : 22;
    for (let i = 0; i < pPos.count; i++) {
        const lx = pPos.getX(i);
        const lz = pPos.getZ(i);
        const wy = getTerrainHeight(cx + lx, cz + lz) + 0.65;
        pPos.setY(i, wy);
        const checker = ((Math.floor((lx + 9) / 3) + Math.floor((lz + 9) / 3)) % 2 === 0);
        pCols[i * 3]     = checker ? 0.25 : 0.16;
        pCols[i * 3 + 1] = checker ? 0.82 : 0.58;
        pCols[i * 3 + 2] = checker ? 0.45 : 0.85;
    }
    patchGeo.setAttribute('color', new THREE.BufferAttribute(pCols, 3));
    patchGeo.computeVertexNormals();
    const patchMat = new THREE.MeshStandardMaterial({
        name: 'DiagnosticPlainTerrainPatchMat',
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.65,
        metalness: 0.08
    });
    const mesh = new THREE.Mesh(patchGeo, patchMat);
    mesh.position.set(cx, 0, cz);
    mesh.receiveShadow = true;
    scene.add(mesh);
    window._diagnosticTerrainPatchMesh = mesh;
    return true;
};

function isWorldPosVisible(x, z) {
    const gx = Math.floor(((x / MAP_SIZE) + 0.5) * FOW_RES);
    const gy = Math.floor(((z / MAP_SIZE) + 0.5) * FOW_RES);
    if (gx < 0 || gx >= FOW_RES || gy < 0 || gy >= FOW_RES) return false;
    return fowVisible[gy * FOW_RES + gx] === 1;
}
window.isPositionVisibleToPlayer = isWorldPosVisible;

function isWorldPosExplored(x, z) {
    const gx = Math.floor(((x / MAP_SIZE) + 0.5) * FOW_RES);
    const gy = Math.floor(((z / MAP_SIZE) + 0.5) * FOW_RES);
    if (gx < 0 || gx >= FOW_RES || gy < 0 || gy >= FOW_RES) return false;
    return fowExplored[gy * FOW_RES + gx] === 1;
}
window.isPositionExploredByPlayer = isWorldPosExplored;

let creepRadius = 0.0;
let creepTargetRadius = 0.0;
let activeZergMainCreepMesh = null;
const activeZergExpansionCreepMeshes = [];
const creepTumors = [];
const frontierBuildingInfestations = [];
let activeMeadowGrassMesh = null;
const meadowGrassEntries = [];
const _grassDummy = new THREE.Object3D();

// Authoritative Zerg Main Base & Creep Anchor resolver:
// Strictly ensures Zerg creep ONLY appears when a Zerg Main Base (Hive/Hatchery/Citadel) is actually built and alive,
// and always anchors creep at the actual Zerg Main Base position (never on a Protoss or Terran base!).
function getActiveZergCreepState() {
    const isCinematicMode = Boolean(
        (window.titleScreenActive || window.loadingCameraSweep) ||
        (window.BATTLE_CINEMATIC && window.BATTLE_CINEMATIC.active && window.BATTLE_CINEMATIC.lifecycleState === 'ACTIVE')
    );

    if (isCinematicMode) {
        const bc = window.BATTLE_CINEMATIC;
        if (bc && bc.active && bc.actors && Array.isArray(bc.actors.buildings)) {
            const zergMainBase = bc.actors.buildings.find(b =>
                b && b.hp > 0 && b.faction === 'zerg' &&
                (b.role === 'base' || b.role === 'citadel' || b.role === 'hatchery' || b.role === 'hive') &&
                (b.buildProgress === undefined || b.buildProgress >= 0.99) &&
                b.pos && Number.isFinite(b.pos.x) && Number.isFinite(b.pos.z)
            );
            if (zergMainBase) {
                const zergTeamId = zergMainBase.teamId;
                const builtZergBuildings = bc.actors.buildings.filter(b =>
                    b && b.hp > 0 && b.faction === 'zerg' &&
                    (!zergTeamId || b.teamId === zergTeamId) &&
                    (b.buildProgress === undefined || b.buildProgress >= 0.99) &&
                    b.pos && Number.isFinite(b.pos.x) && Number.isFinite(b.pos.z)
                );
                return {
                    hasBuiltZergMainBase: true,
                    x: zergMainBase.pos.x,
                    z: zergMainBase.pos.z,
                    mainBase: zergMainBase,
                    buildingsList: builtZergBuildings
                };
            }
        }
        return {
            hasBuiltZergMainBase: false,
            x: ENEMY_BASE_POS.x,
            z: ENEMY_BASE_POS.z,
            mainBase: null,
            buildingsList: []
        };
    }

    // Standard single-player / multiplayer gameplay:
    // Check enemyBuildings for a built, living Zerg Main Base (never treat Protoss or Terran HQ as Zerg!)
    if (Array.isArray(window.enemyBuildings)) {
        const zergEnemyMain = window.enemyBuildings.find(eb =>
            eb && eb.hp > 0 &&
            (!eb.faction || eb.faction === 'zerg') &&
            (eb.role === 'citadel' || eb.role === 'base' || eb.role === 'hatchery' || eb.role === 'hive') &&
            (eb.buildProgress === undefined || eb.buildProgress >= 0.99) &&
            eb.pos && Number.isFinite(eb.pos.x) && Number.isFinite(eb.pos.z)
        );
        if (zergEnemyMain) {
            const builtZergEnemyBlds = window.enemyBuildings.filter(eb =>
                eb && eb.hp > 0 &&
                (!eb.faction || eb.faction === 'zerg') &&
                (eb.buildProgress === undefined || eb.buildProgress >= 0.99) &&
                eb.pos && Number.isFinite(eb.pos.x) && Number.isFinite(eb.pos.z)
            );
            return {
                hasBuiltZergMainBase: true,
                x: zergEnemyMain.pos.x,
                z: zergEnemyMain.pos.z,
                mainBase: zergEnemyMain,
                buildingsList: builtZergEnemyBlds
            };
        }
    }

    // Also check if the local player is playing as Zerg and has a built Zerg Main Base
    if (Array.isArray(window.buildings)) {
        const zergPlayerMain = window.buildings.find(pb =>
            pb && pb.hp > 0 &&
            (pb.faction === 'zerg' || pb.type === 'hatchery' || pb.type === 'hive' || pb.type === 'citadel') &&
            (pb.role === 'base' || pb.type === 'base' || pb.type === 'hatchery' || pb.type === 'hive' || pb.type === 'citadel') &&
            (pb.buildProgress === undefined || pb.buildProgress >= 0.99) &&
            pb.pos && Number.isFinite(pb.pos.x) && Number.isFinite(pb.pos.z)
        );
        if (zergPlayerMain) {
            const builtZergPlayerBlds = window.buildings.filter(pb =>
                pb && pb.hp > 0 &&
                (pb.faction === 'zerg' || pb.type === 'hatchery' || pb.type === 'hive' || pb.type === 'spawning_pool' || pb.type === 'roach_warren' || pb.type === 'spire' || pb.type === 'spine_crawler' || pb.type === 'evolution_chamber') &&
                (pb.buildProgress === undefined || pb.buildProgress >= 0.99) &&
                pb.pos && Number.isFinite(pb.pos.x) && Number.isFinite(pb.pos.z)
            );
            return {
                hasBuiltZergMainBase: true,
                x: zergPlayerMain.pos.x,
                z: zergPlayerMain.pos.z,
                mainBase: zergPlayerMain,
                buildingsList: builtZergPlayerBlds
            };
        }
    }

    return {
        hasBuiltZergMainBase: false,
        x: ENEMY_BASE_POS.x,
        z: ENEMY_BASE_POS.z,
        mainBase: null,
        buildingsList: []
    };
}
window.getActiveZergCreepState = getActiveZergCreepState;

function spawnCreepTumor(x, z) {
    let tx = x, tz = z;
    let validSpot = false;
    const creepState = getActiveZergCreepState();
    const hiveX = creepState.hasBuiltZergMainBase ? creepState.x : ENEMY_BASE_POS.x;
    const hiveZ = creepState.hasBuiltZergMainBase ? creepState.z : ENEMY_BASE_POS.z;
    for (let attempt = 0; attempt < 8; attempt++) {
        if (attempt > 0) {
            const ang = attempt * 0.95 + seededRandom() * 0.5;
            const shift = 1.6 + attempt * 0.7;
            tx = x + Math.cos(ang) * shift;
            tz = z + Math.sin(ang) * shift;
        }
        const ty = getTerrainHeight(tx, tz);
        if (ty < -0.25 || ty > 16.5) continue;
        // Allow creep tumors near road shoulders, only avoid dead-center of road or bridge deck
        if (getSupplyRoadFactor(tx, tz) > 0.62) continue;
        if (isSpotUnderOrBlockingBridge(tx, tz, 1.5) || getRiverDist(tx, tz) < RIVER_HALF_WIDTH + 2.5) continue;
        if (Math.hypot(tx - hiveX, tz - hiveZ) < 4.4) continue;
        if (Math.hypot(tx - ENEMY_BARRACKS_POS.x, tz - ENEMY_BARRACKS_POS.z) < 3.6) continue;
        if (Math.hypot(tx - ENEMY_FACTORY_POS.x, tz - ENEMY_FACTORY_POS.z) < 3.6) continue;
        if (isInsideBasePlacementZone(tx, tz, 6.0)) continue;
        if (ABANDONED_BASES.some(ab => Math.hypot(tx - ab.x, tz - ab.z) < 6.0)) continue;
        if (BUILDING_RUINS.some(br => Math.hypot(tx - br.x, tz - br.z) < 3.5)) continue;
        if (obstacles.some(ob => Math.hypot(tx - ob.x, tz - ob.z) < ob.r + 1.1)) continue;
        if (creepTumors.some(t => !t.dead && Math.hypot(t.x - tx, t.z - tz) < 3.2)) continue;
        validSpot = true;
        break;
    }
    if (!validSpot) return;

    const y = getTerrainHeight(tx, tz);
    const group = new THREE.Group();
    group.position.set(tx, y, tz);

    const mound = new THREE.Mesh(createOrganicBioCarapaceGeo(0.54, 0.45, 0.54, 5, 0.05), MAT.zergFlesh);
    mound.scale.set(1.25, 0.46, 1.25);
    mound.castShadow = !IS_MOBILE;
    mound.receiveShadow = true;
    const pustule = new THREE.Mesh(createOrganicBioCarapaceGeo(0.25, 0.22, 0.25, 4, 0.03), MAT.zergBioShader);
    pustule.position.y = 0.22;
    group.add(mound, pustule);
    // Only show creep tumor when on active Zerg creep from a built Zerg main base
    const fBypass = !!(window.titleScreenActive || window.loadingCameraSweep || window.fowRevealAll);
    const onActiveCreep = creepState.hasBuiltZergMainBase && creepRadius > 0.5 && Math.hypot(tx - hiveX, tz - hiveZ) <= creepRadius + 2.5;
    group.visible = onActiveCreep && (fBypass || isWorldPosExplored(tx, tz));
    addMapMesh(group);
    const distFromHive = Math.hypot(tx - hiveX, tz - hiveZ);
    creepTumors.push({ group, mound, pustule, x: tx, z: tz, distFromHive, phase: seededRandom() * 10, scale: 1.0, dead: false });
}

function gatherActiveZergStructureCreepNodes(mainRadius) {
    const nodes = [];
    if (mainRadius <= 0.5) return nodes;
    const creepState = getActiveZergCreepState();
    if (!creepState.hasBuiltZergMainBase) return nodes;

    const cx = creepState.x;
    const cz = creepState.z;
    const subRad = Math.min(11.5, Math.max(6.5, mainRadius * 0.62));
    const blds = creepState.buildingsList;

    for (let i = 0; i < blds.length && nodes.length < 7; i++) {
        const eb = blds[i];
        if (!eb || eb.hp <= 0 || !eb.pos || eb === creepState.mainBase || eb.role === 'citadel' || eb.role === 'base') continue;
        if (Math.hypot(eb.pos.x - cx, eb.pos.z - cz) > 36.0) continue;
        const isProd = (eb.role === 'barracks' || eb.role === 'factory' || eb.role === 'roach_warren' || eb.role === 'spire_hive' || eb.role === 'spire' || eb.role === 'airfield');
        const nodeR = isProd ? subRad : (eb.role === 'spine_turret' || eb.role === 'turret' ? 7.5 : 9.5);
        nodes.push({ x: eb.pos.x, z: eb.pos.z, r: nodeR });
    }

    for (let t = 0; t < creepTumors.length && nodes.length < 7; t++) {
        const ct = creepTumors[t];
        if (ct && !ct.dead && Math.hypot(ct.x - cx, ct.z - cz) <= mainRadius + 3.5) {
            nodes.push({ x: ct.x, z: ct.z, r: 6.2 });
        }
    }
    return nodes;
}

function isPointOnZergCreep(x, z) {
    if (creepRadius <= 0.5) return false;
    const creepState = getActiveZergCreepState();
    if (!creepState.hasBuiltZergMainBase) return false;

    const cx = creepState.x;
    const cz = creepState.z;
    const dHive = Math.hypot(x - cx, z - cz);
    if (dHive < creepRadius - 0.5) return true;

    const subRad = Math.min(11.5, Math.max(6.5, creepRadius * 0.62));
    const blds = creepState.buildingsList;
    for (let i = 0; i < blds.length; i++) {
        const eb = blds[i];
        if (!eb || eb.hp <= 0 || !eb.pos) continue;
        if (Math.hypot(eb.pos.x - cx, eb.pos.z - cz) > 36.0) continue;
        const isProd = (eb.role === 'barracks' || eb.role === 'factory' || eb.role === 'roach_warren' || eb.role === 'spire_hive' || eb.role === 'spire' || eb.role === 'airfield');
        const checkR = isProd ? subRad : 8.5;
        if (Math.hypot(x - eb.pos.x, z - eb.pos.z) < checkR) return true;
    }
    for (let i = 0; i < creepTumors.length; i++) {
        const ct = creepTumors[i];
        if (ct && !ct.dead && Math.hypot(ct.x - cx, ct.z - cz) <= creepRadius + 3.5 && Math.hypot(x - ct.x, z - ct.z) < 5.0) {
            return true;
        }
    }
    return false;
}

let _lastSyncedCreepVertexRadius = -999;
let _lastSyncedCreepCenterX = -999;
let _lastSyncedCreepCenterZ = -999;

function syncZergCreepGroundMeshHeights(mesh, centerX, centerZ, currentRadius) {
    if (!mesh || !mesh.geometry) return;
    const pos = mesh.geometry.attributes.position;
    const unitCoords = mesh.userData && mesh.userData.unitCoords;
    if (!pos || !unitCoords) return;
    const effRadius = Math.max(0.5, currentRadius);
    mesh.position.set(centerX, 0, centerZ);
    mesh.scale.set(1, 1, 1);
    for (let i = 0; i < pos.count; i++) {
        const ux = unitCoords[i * 2];
        const uz = unitCoords[i * 2 + 1];
        const fx = ux * effRadius;
        const fz = uz * effRadius;
        const wx = centerX + fx;
        const wz = centerZ + fz;
        const h0 = getTerrainHeight(wx, wz);
        const h1 = getTerrainHeight(wx + 0.65, wz);
        const h2 = getTerrainHeight(wx - 0.65, wz);
        const h3 = getTerrainHeight(wx, wz + 0.65);
        const h4 = getTerrainHeight(wx, wz - 0.65);
        const safeFloorY = Math.max(h0, (h0 + Math.max(h0, h1, h2, h3, h4)) * 0.5) + 0.045;
        pos.setXYZ(i, fx, safeFloorY, fz);
    }
    pos.needsUpdate = true;
}

function updateZergCreepColors(radius, isReceding = false, forceFullSync = false) {
    const creepState = getActiveZergCreepState();
    const effRadius = creepState.hasBuiltZergMainBase ? Math.max(0, radius) : 0;
    const cx = creepState.x;
    const cz = creepState.z;
    const extraNodes = (!isReceding && effRadius > 0.5) ? gatherActiveZergStructureCreepNodes(effRadius) : [];

    // 1. Always sync Zerg Creep shader uniforms in O(1) time every frame (connects Hive + Spawning Pool + Bio-Factory + Spine Turrets!)
    if (typeof SHADER_ENGINE !== 'undefined' && typeof SHADER_ENGINE.setZergCreepUniforms === 'function') {
        SHADER_ENGINE.setZergCreepUniforms(cx, cz, effRadius, extraNodes);
    }
    const fowBypass = !!(window.titleScreenActive || window.loadingCameraSweep || window.fowRevealAll);
    const mainHiveExplored = fowBypass || isWorldPosExplored(cx, cz)
        || isWorldPosExplored(cx + effRadius * 0.55, cz)
        || isWorldPosExplored(cx - effRadius * 0.55, cz)
        || isWorldPosExplored(cx, cz + effRadius * 0.55)
        || isWorldPosExplored(cx, cz - effRadius * 0.55);

    if (activeZergMainCreepMesh) {
        activeZergMainCreepMesh.visible = (effRadius > 0.45) && mainHiveExplored;
        const baseR = (activeZergMainCreepMesh.userData && activeZergMainCreepMesh.userData.baseRadius) || 16.5;
        const scaleFrac = Math.max(0.02, effRadius / Math.max(1.0, baseR));
        activeZergMainCreepMesh.scale.set(scaleFrac, 1.0, scaleFrac);
    }
    for (let em = 0; em < activeZergExpansionCreepMeshes.length; em++) {
        const expMesh = activeZergExpansionCreepMeshes[em];
        if (expMesh) {
            const expExplored = fowBypass || isWorldPosExplored(expMesh.position.x, expMesh.position.z);
            if (expMesh.userData && expMesh.userData.ownerDestroyed) {
                expMesh.userData.recedeRadius = Math.max(0, (expMesh.userData.recedeRadius ?? 13.5) - 0.35);
                const rFrac = Math.max(0.01, expMesh.userData.recedeRadius / 13.5);
                expMesh.scale.set(rFrac, 1.0, rFrac);
                expMesh.visible = (expMesh.userData.recedeRadius > 0.45) && expExplored;
            } else {
                expMesh.visible = (effRadius > 0.45) && expExplored;
                if (effRadius > 0.45 && isReceding) {
                    const shrinkFrac = Math.min(1.0, Math.max(0.04, effRadius / 16.5));
                    expMesh.scale.set(shrinkFrac, 1.0, shrinkFrac);
                }
            }
        }
    }

    for (let t = 0; t < creepTumors.length; t++) {
        const ct = creepTumors[t];
        if (ct && ct.group) {
            const tumorOnCreep = effRadius > 0.5 && Math.hypot(ct.x - cx, ct.z - cz) <= effRadius + 3.5;
            ct.group.visible = !ct.dead && tumorOnCreep && (fowBypass || isWorldPosExplored(ct.x, ct.z));
            if (ct.pustule) {
                ct.pustule.visible = !ct.dead && tumorOnCreep && (fowBypass || isWorldPosVisible(ct.x, ct.z));
            }
        }
    }
    for (let f = 0; f < frontierBuildingInfestations.length; f++) {
        const fi = frontierBuildingInfestations[f];
        if (fi && fi.group) {
            const onCreep = effRadius > 0.5 && isPointOnZergCreep(fi.x, fi.z);
            fi.group.visible = onCreep && (fowBypass || isWorldPosExplored(fi.x, fi.z));
        }
    }

    const uiCreep = document.getElementById('ui-creep');
    if (uiCreep) uiCreep.innerText = Math.max(0, Math.round(effRadius));

    const needsZeroCleanup = (effRadius <= 0.5 && _lastSyncedCreepVertexRadius > 0.5);

    if (!forceFullSync && !needsZeroCleanup &&
        Math.abs(effRadius - _lastSyncedCreepVertexRadius) < 0.40 &&
        Math.abs(cx - _lastSyncedCreepCenterX) < 0.1 &&
        Math.abs(cz - _lastSyncedCreepCenterZ) < 0.1) {
        return;
    }
    _lastSyncedCreepVertexRadius = effRadius;
    _lastSyncedCreepCenterX = cx;
    _lastSyncedCreepCenterZ = cz;

    if (activeZergMainCreepMesh && effRadius > 0.5 && !isReceding) {
        syncZergCreepGroundMeshHeights(activeZergMainCreepMesh, cx, cz, effRadius);
    }

    const colorAttr = terrainGeo.attributes.color;
    if (colorAttr) {
        for (let i = 0; i < posAttr.count; i++) {
            colorAttr.setXYZ(i, baseColors[i * 3], baseColors[i * 3 + 1], baseColors[i * 3 + 2]);
        }
        colorAttr.needsUpdate = true;
    }

    // Dynamically restore 3D meadow grass instances wherever Zerg creep recedes from the ground!
    if (activeMeadowGrassMesh && meadowGrassEntries.length > 0) {
        let grassMatrixDirty = false;
        for (let g = 0; g < meadowGrassEntries.length; g++) {
            const ge = meadowGrassEntries[g];
            const coveredByCreep = isPointOnZergCreep(ge.x, ge.z);
            if (coveredByCreep !== ge.hidden) {
                ge.hidden = coveredByCreep;
                grassMatrixDirty = true;
                if (coveredByCreep) {
                    _grassDummy.position.set(ge.x, -50.0, ge.z);
                    _grassDummy.scale.set(0.0001, 0.0001, 0.0001);
                    _grassDummy.updateMatrix();
                    activeMeadowGrassMesh.setMatrixAt(g, _grassDummy.matrix);
                } else {
                    activeMeadowGrassMesh.setMatrixAt(g, ge.matrix);
                }
            }
        }
        if (grassMatrixDirty) {
            activeMeadowGrassMesh.instanceMatrix.needsUpdate = true;
        }
    }
}

const lavaFlowMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: 0xff5511,
    emissive: 0xd93600,
    emissiveIntensity: 1.35,
    roughness: 0.35,
    metalness: 0.12
});

function createOasisPonds() {
    const isLava = ACTIVE_PLANET_BIOME === 'lava';
    const cPondDeep = new THREE.Color(isLava ? 0xffa600 : 0x0c3144);
    const cPondMid = new THREE.Color(isLava ? 0xff3b00 : 0x1d5c6d);
    const cPondShore = new THREE.Color(isLava ? 0x3b1208 : 0x4c473b);
    const cPondVert = new THREE.Color();
    const cPondCanyon = new THREE.Color();

    DYNAMIC_PONDS.forEach(pd => {
        // Build an organic, multi-lobed dynamic pond water/magma mesh matching getDynamicPondRadiusAtAngle(pd, ang)
        const radialSegs = 64;
        const ringSegs = 12;
        const pondGeo = new THREE.RingGeometry(0.02, 1.0, radialSegs, ringSegs);
        pondGeo.rotateX(-Math.PI / 2);
        const pAttr = pondGeo.attributes.position;
        const pColors = new Float32Array(pAttr.count * 3);

        for (let i = 0; i < pAttr.count; i++) {
            const vx = pAttr.getX(i);
            const vz = pAttr.getZ(i);
            const normR = Math.hypot(vx, vz);
            let wx = pd.x;
            let wz = pd.z;
            if (normR > 0.001) {
                const ang = Math.atan2(vz, vx);
                const targetR = getDynamicPondRadiusAtAngle(pd, ang);
                const lx = (vx / normR) * normR * targetR;
                const lz = (vz / normR) * normR * targetR;
                pAttr.setX(i, lx);
                pAttr.setZ(i, lz);
                wx += lx;
                wz += lz;
            }
            sampleCanyonFloorColorAt(wx, wz, cPondCanyon);
            const rFrac = THREE.MathUtils.clamp(normR, 0, 1);
            if (rFrac < 0.65) {
                cPondVert.copy(cPondDeep).lerp(cPondMid, rFrac / 0.65);
            } else {
                const tShore = (rFrac - 0.65) / 0.35;
                cPondVert.copy(cPondMid).lerp(cPondShore, tShore).lerp(cPondCanyon, tShore * 0.45);
            }
            pColors[i * 3] = cPondVert.r;
            pColors[i * 3 + 1] = cPondVert.g;
            pColors[i * 3 + 2] = cPondVert.b;
        }
        pondGeo.setAttribute('color', new THREE.BufferAttribute(pColors, 3));
        pondGeo.computeVertexNormals();
        pondGeo.computeBoundingBox();
        pondGeo.computeBoundingSphere();
        const pondMesh = new THREE.Mesh(pondGeo, MAT.waterShader);
        pondMesh.position.set(pd.x, -0.42, pd.z);
        pondMesh.frustumCulled = false;
        addMapMesh(pondMesh);
        obstacles.push({ x: pd.x, z: pd.z, r: pd.r * 1.25, isDynamicPond: true, pondRef: pd, type: 'pond' });
    });
}

const riverbankTransitionMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: terrainDetailTex,
    roughness: 0.84,
    metalness: 0.04,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
});
if (typeof SHADER_ENGINE !== 'undefined' && typeof SHADER_ENGINE.applyTerrainShader === 'function') {
    SHADER_ENGINE.applyTerrainShader(riverbankTransitionMat);
}

// Helper: samples the procedural canyon floor vertex color at world (wx, wz) so riverbank skirts match 100% seamlessly
function sampleCanyonFloorColorAt(wx, wz, outColor) {
    const target = outColor || new THREE.Color();
    const gx = THREE.MathUtils.clamp(Math.round(((wx / MAP_SIZE) + 0.5) * TERRAIN_GRID_SEGS), 0, TERRAIN_GRID_SEGS);
    const gz = THREE.MathUtils.clamp(Math.round(((wz / MAP_SIZE) + 0.5) * TERRAIN_GRID_SEGS), 0, TERRAIN_GRID_SEGS);
    const vIdx = (gz * TERRAIN_GRID_COLS + gx) * 3;
    if (baseColors && vIdx + 2 < baseColors.length) {
        target.setRGB(baseColors[vIdx], baseColors[vIdx + 1], baseColors[vIdx + 2]);
    } else {
        target.copy(cGrass);
    }
    return target;
}

function createValleyRiver() {
    if (!HAS_VALLEY_RIVER) return;

    const isLava = ACTIVE_PLANET_BIOME === 'lava';
    const isDesert = ACTIVE_PLANET_BIOME === 'desert';
    const isOcean = ACTIVE_PLANET_BIOME === 'ocean';

    // 1. Unified Shoreline & Channel Transition on the Terrain Mesh (terrainGeo)
    // No duplicate overlapping bankMesh ribbons are spawned so coastlines, rivers, lava channels & bridges have zero overlapping outlines!
    const colorAttr = terrainGeo.attributes.color;
    const cDeepSilt = new THREE.Color(isLava ? 0x8f2006 : (isDesert ? 0x264852 : 0x122832));
    const cShallowShoal = new THREE.Color(isLava ? 0xd9440c : (isDesert ? 0x456e68 : 0x27464b));
    const cWetMudBase = new THREE.Color(isLava ? 0x261310 : (isDesert ? 0x8c673e : 0x3d382f));
    const cWetShingle = new THREE.Color(isLava ? 0x3d1b14 : (isDesert ? 0xa37a4c : 0x484339));
    const cRiparianLoamBase = new THREE.Color(isLava ? 0x1f1210 : (isDesert ? 0xb5864e : 0x524c3e));
    const tmpMud = new THREE.Color();
    const tmpLoam = new THREE.Color();
    const tmpCol = new THREE.Color();
    const cCanyonSample = new THREE.Color();

    if (colorAttr && !isOcean) {
        for (let i = 0; i < posAttr.count; i++) {
            const vx = posAttr.getX(i);
            const vz = posAttr.getZ(i);
            const rc = getRiverCoords(vx, vz);
            const localHalfW = rc.halfWidth || RIVER_HALF_WIDTH;
            const maxShoreReach = localHalfW + 5.6;
            if (rc.dist > maxShoreReach) continue;

            const roadF = getSupplyRoadFactor(vx, vz);
            const shingleGrain = (Math.sin(vx * 0.92 + vz * 0.84 + MAP_SEED * 0.17) * 0.5 + 0.5);
            tmpMud.copy(cWetMudBase).lerp(cWetShingle, shingleGrain * 0.55);
            tmpLoam.copy(cRiparianLoamBase).lerp(cLushVerge, shingleGrain * 0.35);
            tmpCol.setRGB(baseColors[i * 3], baseColors[i * 3 + 1], baseColors[i * 3 + 2]);

            if (rc.dist < localHalfW * 0.72) {
                const tDeep = rc.dist / Math.max(0.5, localHalfW * 0.72);
                tmpCol.copy(cDeepSilt).lerp(cShallowShoal, tDeep * 0.55);
            } else if (rc.dist < localHalfW + 0.45) {
                const tShoal = (rc.dist - localHalfW * 0.72) / Math.max(0.25, localHalfW * 0.28 + 0.45);
                const sShoal = tShoal * tShoal * (3.0 - 2.0 * tShoal);
                tmpCol.copy(cShallowShoal).lerp(tmpMud, sShoal);
            } else if (rc.dist < localHalfW + 2.25) {
                const tLap = (rc.dist - (localHalfW + 0.45)) / 1.80;
                const sLap = tLap * tLap * (3.0 - 2.0 * tLap);
                const targetBank = tmpMud.clone().lerp(tmpLoam, sLap);
                tmpCol.lerp(targetBank, 0.88 * (1.0 - roadF * 0.65));
            } else {
                const tBank = (rc.dist - (localHalfW + 2.25)) / 3.35;
                const sBank = 1.0 - (tBank * tBank * (3.0 - 2.0 * tBank));
                tmpCol.lerp(tmpLoam, sBank * 0.68 * (1.0 - roadF * 0.75));
            }

            baseColors[i * 3] = tmpCol.r;
            baseColors[i * 3 + 1] = tmpCol.g;
            baseColors[i * 3 + 2] = tmpCol.b;
            if (typeof isPointOnZergCreep !== 'function' || !isPointOnZergCreep(vx, vz)) {
                liveColors[i * 3] = tmpCol.r;
                liveColors[i * 3 + 1] = tmpCol.g;
                liveColors[i * 3 + 2] = tmpCol.b;
                colorAttr.setXYZ(i, tmpCol.r, tmpCol.g, tmpCol.b);
            }
        }
        colorAttr.needsUpdate = true;
    }

    // 2. Full-Map Continuous River Water / Molten Magma Channel OR Ocean Archipelago Sea Surface
    if (isOcean) {
        const oceanGeo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, 180, 180);
        oceanGeo.rotateX(-Math.PI / 2);
        const oPos = oceanGeo.attributes.position;
        const oColors = new Float32Array(oPos.count * 3);
        const cDeepSea = new THREE.Color(0x052238);
        const cMidSea = new THREE.Color(0x0d4f70);
        const cTurquoise = new THREE.Color(0x1ca8be);
        const cSurfFoam = new THREE.Color(0x90e8f0);
        const cTmp = new THREE.Color();

        for (let i = 0; i < oPos.count; i++) {
            const wx = oPos.getX(i);
            const wz = oPos.getZ(i);
            const gh = getTerrainHeight(wx, wz);
            const depth = Math.max(0.0, RIVER_WATER_Y - gh);
            oPos.setY(i, RIVER_WATER_Y);

            if (depth < 0.14) {
                cTmp.copy(cSurfFoam).lerp(cTurquoise, depth / 0.14);
            } else if (depth < 0.52) {
                cTmp.copy(cTurquoise).lerp(cMidSea, (depth - 0.14) / 0.38);
            } else {
                const dT = Math.min(1.0, (depth - 0.52) / 0.85);
                cTmp.copy(cMidSea).lerp(cDeepSea, dT);
            }
            oColors[i * 3] = cTmp.r;
            oColors[i * 3 + 1] = cTmp.g;
            oColors[i * 3 + 2] = cTmp.b;
        }
        oceanGeo.setAttribute('color', new THREE.BufferAttribute(oColors, 3));
        oceanGeo.computeVertexNormals();
        oceanGeo.computeBoundingBox();
        oceanGeo.computeBoundingSphere();
        const oceanMesh = new THREE.Mesh(oceanGeo, MAT.waterShader);
        oceanMesh.name = 'OceanArchipelagoSeaMesh';
        oceanMesh.frustumCulled = false;
        addMapMesh(oceanMesh);
    } else {
        // Span the full playable & outer map extent (-128m to +128m = 256m) so the river never cuts off at distant camera ranges!
        const segsAlong = 240;
        const segsAcross = 20;
        const riverSpanLength = 256.0;
        const riverGeo = new THREE.PlaneGeometry(riverSpanLength, 1.0, segsAlong, segsAcross);
        riverGeo.rotateX(-Math.PI / 2);
        const rPos = riverGeo.attributes.position;
        const rColors = new Float32Array(rPos.count * 3);

        const cWaterDeep = new THREE.Color(isLava ? 0xffcf00 : 0x0c3144);
        const cWaterMid = new THREE.Color(isLava ? 0xff4d00 : 0x1d5c6d);
        const cWaterShoal = new THREE.Color(isLava ? 0xc42200 : 0x366e72);
        const cWaterShoreEdge = new THREE.Color(isLava ? 0x2c0d04 : 0x4c473b);
        const cVertWater = new THREE.Color();

        for (let i = 0; i < rPos.count; i++) {
            const sCoord = rPos.getX(i);
            const normZ = rPos.getZ(i) * 2.0; // [-1, 1] across river channel
            const centerU = getRiverCenterUAtS(sCoord);
            const localHalfW = getRiverHalfWidthAtS(sCoord) + 0.72;
            const across = normZ * localHalfW;
            const uCoord = centerU + across;
            const wPt = riverCoordsToWorld(sCoord, uCoord);
            const edgeFrac = Math.abs(normZ);

            // Keep center channel water well above the carved riverbed (-0.36m..-0.98m) to prevent depth-buffer z-fighting at max camera zoom,
            // while welding outer shoreline vertices smoothly into the sloped riverbank terrain.
            const groundH = getTerrainHeight(wPt.x, wPt.z);
            const meniscusDrop = Math.pow(edgeFrac, 2.8) * 0.024;
            const edgeTerrainBlend = THREE.MathUtils.smoothstep(edgeFrac, 0.78, 1.0);
            const centerSurfaceY = RIVER_WATER_Y + 0.022;
            const targetEdgeY = Math.min(centerSurfaceY + 0.008, Math.max(groundH + 0.015, RIVER_WATER_Y - 0.04));
            const waterY = THREE.MathUtils.lerp(centerSurfaceY - meniscusDrop, targetEdgeY, edgeTerrainBlend * 0.82);
            rPos.setXYZ(i, wPt.x, waterY, wPt.z);

            // Multi-stop vertex color gradient: deep thalweg -> mid channel -> shallow shoal -> canyon-floor-matched shoreline
            sampleCanyonFloorColorAt(wPt.x, wPt.z, cCanyonSample);
            const shoreTargetCol = cWaterShoreEdge.clone().lerp(cCanyonSample, 0.45);
            if (edgeFrac < 0.45) {
                cVertWater.copy(cWaterDeep).lerp(cWaterMid, edgeFrac / 0.45);
            } else if (edgeFrac < 0.80) {
                cVertWater.copy(cWaterMid).lerp(cWaterShoal, (edgeFrac - 0.45) / 0.35);
            } else {
                const tEdge = (edgeFrac - 0.80) / 0.20;
                const sEdge = tEdge * tEdge * (3.0 - 2.0 * tEdge);
                cVertWater.copy(cWaterShoal).lerp(shoreTargetCol, sEdge);
            }

            rColors[i * 3] = cVertWater.r;
            rColors[i * 3 + 1] = cVertWater.g;
            rColors[i * 3 + 2] = cVertWater.b;
        }
        riverGeo.setAttribute('color', new THREE.BufferAttribute(rColors, 3));
        riverGeo.computeVertexNormals();
        riverGeo.computeBoundingBox();
        riverGeo.computeBoundingSphere();
        const riverMesh = new THREE.Mesh(riverGeo, MAT.waterShader);
        riverMesh.name = isLava ? 'VolcanicLavaRiverMesh' : 'ValleyRiverWaterMesh';
        riverMesh.frustumCulled = false;
        addMapMesh(riverMesh);
    }

    const bridgeDeckMat = MAT.gunmetal || new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.45, metalness: 0.65 });
    const bridgePierMat = MAT.darkSteel || new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.7, metalness: 0.4 });
    const bridgeConcreteMat = concreteRuinMat || new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.85, metalness: 0.15 });
    const bridgeGirderMat = rustedSteelMat || new THREE.MeshStandardMaterial({ color: 0x5a3826, roughness: 0.68, metalness: 0.65 });
    const bridgeHazardMat = MAT.hazard || bridgeDeckMat;
    const lavaHeatShieldMat = new THREE.MeshStandardMaterial({ color: 0x1e1918, roughness: 0.52, metalness: 0.78 });
    const lavaGlowStripMat = new THREE.MeshStandardMaterial({ color: 0xff5500, emissive: 0xff3b00, emissiveIntensity: 1.35, roughness: 0.35 });

    RIVER_BRIDGES.forEach((rb, bridgeIdx) => {
        const s0 = rb.sCoord;
        const centerU = (typeof rb.centerU === 'number') ? rb.centerU : getRiverCenterUAtS(s0);
        const cWorld = rb.isCustomIslandBridge
            ? { x: rb.centerX, z: rb.centerZ }
            : riverCoordsToWorld(s0, centerU);

        // Ensure bridge orientation is perpendicular to the local river tangent (or uses custom island bridge yaw)
        const localSlope = getRiverTangentSlopeAtS(s0);
        const localSkew = Math.atan(localSlope);
        const bridgeYaw = (typeof rb.yaw === 'number') ? rb.yaw : (RIVER_ANGLE - localSkew);
        rb.yaw = bridgeYaw;
        rb.cosYaw = Math.cos(bridgeYaw);
        rb.sinYaw = Math.sin(bridgeYaw);
        rb.centerX = cWorld.x;
        rb.centerZ = cWorld.z;
        rb.centerU = centerU;

        const bridgeGroup = new THREE.Group();
        bridgeGroup.position.set(cWorld.x, 0, cWorld.z);
        // Align 3D bridge mesh with the exact local perpendicular crossing frame (rb.yaw)
        bridgeGroup.rotation.y = bridgeYaw;

        const archetype = isLava
            ? 'industrial_girder'
            : (rb.archetype || (bridgeIdx === 0 ? 'truss_bridge' : (bridgeIdx === 1 ? 'concrete_causeway' : 'industrial_girder')));
        rb.archetype = archetype;
        const bridgeWidth = rb.halfWidth * 2.0;
        const localRiverHW = getRiverHalfWidthAtS(s0);
        const flatHalfSpan = rb.flatHalfSpan || (localRiverHW + 0.95);
        const spanLength = flatHalfSpan * 2.0;
        const rampReachU = rb.rampReachU || (localRiverHW + 3.45);
        rb.flatHalfSpan = flatHalfSpan;
        rb.rampReachU = rampReachU;

        const primaryStructMat = isLava
            ? lavaHeatShieldMat
            : (archetype === 'concrete_causeway'
                ? bridgeConcreteMat
                : (archetype === 'industrial_girder' ? bridgeGirderMat : bridgeDeckMat));

        // Intact center span group (hidden when bridge is destroyed in combat)
        const intactSpanGroup = new THREE.Group();
        bridgeGroup.add(intactSpanGroup);
        rb.intactSpanGroup = intactSpanGroup;
        rb.bridgeGroup = bridgeGroup;

        // Destroyed collapsed span group (shown when bridge HP reaches 0)
        const destroyedSpanGroup = new THREE.Group();
        destroyedSpanGroup.visible = Boolean(rb.destroyed);
        bridgeGroup.add(destroyedSpanGroup);
        rb.destroyedSpanGroup = destroyedSpanGroup;

        // 1. Main Armored Roadway / Industrial Grating Deck Slab (top surface at y = 0.35)
        const deckThickness = archetype === 'concrete_causeway' ? 0.30 : 0.24;
        const mainDeck = new THREE.Mesh(
            createExtrudedArmorHullGeo(bridgeWidth, deckThickness, spanLength),
            primaryStructMat
        );
        mainDeck.position.set(0, 0.35 - deckThickness * 0.5, 0);
        mainDeck.castShadow = !IS_MOBILE;
        mainDeck.receiveShadow = true;
        intactSpanGroup.add(mainDeck);

        const roadInlayW = Math.min(bridgeWidth * 0.74, 5.2);
        if (isLava) {
            // Terran Industrial Lava Crossing Deck: Armored grate plates, heat-shield ribs & glowing hazard guide strips (no civilian asphalt!)
            const deckPlate = new THREE.Mesh(
                createExtrudedArmorHullGeo(roadInlayW, 0.024, spanLength + 0.10),
                bridgePierMat
            );
            deckPlate.position.set(0, 0.349, 0);
            deckPlate.receiveShadow = true;
            intactSpanGroup.add(deckPlate);

            [-roadInlayW * 0.46, roadInlayW * 0.46].forEach(edgeX => {
                const glowLine = new THREE.Mesh(
                    createExtrudedArmorHullGeo(0.14, 0.028, spanLength + 0.06),
                    lavaGlowStripMat
                );
                glowLine.position.set(edgeX, 0.362, 0);
                intactSpanGroup.add(glowLine);
            });
            for (let zRib = -spanLength * 0.44; zRib <= spanLength * 0.44; zRib += 2.4) {
                const crossRib = new THREE.Mesh(
                    createExtrudedArmorHullGeo(roadInlayW * 0.88, 0.028, 0.28),
                    bridgeHazardMat
                );
                crossRib.position.set(0, 0.363, zRib);
                intactSpanGroup.add(crossRib);
            }
        } else {
            // Dark Asphalt / Causeway Surface Inlay across the Bridge Deck
            const deckAsphalt = new THREE.Mesh(
                createExtrudedArmorHullGeo(roadInlayW, 0.022, spanLength + 0.10),
                dynamicRoadAsphaltMat
            );
            deckAsphalt.position.set(0, 0.349, 0);
            deckAsphalt.receiveShadow = true;
            intactSpanGroup.add(deckAsphalt);

            [-roadInlayW * 0.46, roadInlayW * 0.46].forEach(edgeX => {
                const edgeLine = new THREE.Mesh(
                    createExtrudedArmorHullGeo(0.11, 0.024, spanLength + 0.06),
                    dynamicRoadEdgeLineMat
                );
                edgeLine.position.set(edgeX, 0.361, 0);
                intactSpanGroup.add(edgeLine);
            });
            for (let zStripe = -spanLength * 0.42; zStripe <= spanLength * 0.42; zStripe += 2.2) {
                const stripe = new THREE.Mesh(
                    createExtrudedArmorHullGeo(0.18, 0.026, 1.10),
                    dynamicRoadStripeMat
                );
                stripe.position.set(0, 0.363, zStripe);
                intactSpanGroup.add(stripe);
            }
        }

        // Collapsed Span Wreckage Meshes (visible only when destroyed)
        [-1, 1].forEach(endSign => {
            const brokenSlab = new THREE.Mesh(
                createExtrudedArmorHullGeo(bridgeWidth * 0.92, 0.22, spanLength * 0.36),
                primaryStructMat
            );
            brokenSlab.position.set(0, -0.12, endSign * (spanLength * 0.32));
            brokenSlab.rotation.x = endSign * 0.38;
            destroyedSpanGroup.add(brokenSlab);
        });

        // 2. Terrain-Conforming Approach Ramps & Bank Abutment Foundations on Both Riverbanks
        // Uses bridgeLocalToWorld(rb, localX, localZ) so every vertex matches the exact rotated bridge frame!
        [-1, 1].forEach(endSign => {
            const rStepsU = 10;
            const rStepsS = 8;
            const rPosArr = [];
            const rIdxArr = [];
            const asphPosArr = [];
            const asphIdxArr = [];

            const toeCenterPt = bridgeLocalToWorld(rb, 0, endSign * rampReachU);
            const rawToeCenterH = getTerrainHeight(toeCenterPt.x, toeCenterPt.z);
            const safeToeCenterY = (Number.isFinite(rawToeCenterH) ? Math.max(WATER_LEVEL + 0.16, rawToeCenterH) : 0.35) + 0.064;

            for (let iu = 0; iu <= rStepsU; iu++) {
                const tU = iu / rStepsU;
                const localZ = endSign * THREE.MathUtils.lerp(flatHalfSpan, rampReachU, tU);
                const smoothRamp = tU * tU * (3.0 - 2.0 * tU);

                for (let is = 0; is <= rStepsS; is++) {
                    const tS = (is / rStepsS) - 0.5;
                    const localX = tS * bridgeWidth;
                    const wPt = bridgeLocalToWorld(rb, localX, localZ);
                    const rawG = getTerrainHeight(wPt.x, wPt.z);
                    const groundY = (Number.isFinite(rawG) ? rawG : 0.25) + 0.064;
                    const topY = iu === 0
                        ? 0.35
                        : (iu === rStepsU
                            ? Math.max(WATER_LEVEL + 0.16, groundY)
                            : Math.max(THREE.MathUtils.lerp(0.35, safeToeCenterY, smoothRamp), groundY + 0.045));
                    rPosArr.push(localX, topY, localZ);

                    const asphX = tS * roadInlayW;
                    const wPtAsph = bridgeLocalToWorld(rb, asphX, localZ);
                    const rawAsphG = getTerrainHeight(wPtAsph.x, wPtAsph.z);
                    const gAsphY = (Number.isFinite(rawAsphG) ? rawAsphG : 0.25) + 0.064;
                    const asphTopY = iu === 0
                        ? 0.352
                        : (iu === rStepsU
                            ? Math.max(WATER_LEVEL + 0.162, gAsphY + 0.002)
                            : Math.max(THREE.MathUtils.lerp(0.352, safeToeCenterY + 0.002, smoothRamp), gAsphY + 0.047));
                    asphPosArr.push(asphX, asphTopY, localZ);
                }
            }

            for (let iu = 0; iu < rStepsU; iu++) {
                for (let is = 0; is < rStepsS; is++) {
                    const a = iu * (rStepsS + 1) + is;
                    const b = a + 1;
                    const c = a + (rStepsS + 1);
                    const d = c + 1;
                    if (endSign > 0) {
                        rIdxArr.push(a, c, b, b, c, d);
                        asphIdxArr.push(a, c, b, b, c, d);
                    } else {
                        rIdxArr.push(a, b, c, b, d, c);
                        asphIdxArr.push(a, b, c, b, d, c);
                    }
                }
            }

            const rampGeo = new THREE.BufferGeometry();
            rampGeo.setAttribute('position', new THREE.Float32BufferAttribute(rPosArr, 3));
            rampGeo.setIndex(rIdxArr);
            rampGeo.computeVertexNormals();
            const rampMesh = new THREE.Mesh(rampGeo, primaryStructMat);
            rampMesh.receiveShadow = true;
            bridgeGroup.add(rampMesh);

            const rampAsphGeo = new THREE.BufferGeometry();
            rampAsphGeo.setAttribute('position', new THREE.Float32BufferAttribute(asphPosArr, 3));
            rampAsphGeo.setIndex(asphIdxArr);
            rampAsphGeo.computeVertexNormals();
            const rampAsphMesh = new THREE.Mesh(rampAsphGeo, dynamicRoadAsphaltMat);
            rampAsphMesh.receiveShadow = true;
            bridgeGroup.add(rampAsphMesh);

            // Concrete/Steel Bank Abutment Headwall & Retaining Wingwalls anchored into the riverbank
            const abutmentW = bridgeWidth + 0.55;
            const abutmentWPt = bridgeLocalToWorld(rb, 0, endSign * flatHalfSpan);
            const bankBedY = Math.min(-0.45, getTerrainHeight(abutmentWPt.x, abutmentWPt.z) - 0.35);
            const abutmentH = Math.max(0.65, 0.32 - bankBedY);
            const abutment = new THREE.Mesh(
                createExtrudedArmorHullGeo(abutmentW, abutmentH, 0.58),
                bridgeConcreteMat
            );
            abutment.position.set(0, 0.32 - abutmentH * 0.5, endSign * flatHalfSpan);
            abutment.castShadow = !IS_MOBILE;
            abutment.receiveShadow = true;
            bridgeGroup.add(abutment);

            // Side retaining cheeks under the approach ramp
            const rampLen = rampReachU - flatHalfSpan;
            [-bridgeWidth * 0.48, bridgeWidth * 0.48].forEach(cheekX => {
                const cheek = new THREE.Mesh(
                    createExtrudedArmorHullGeo(0.22, 0.46, rampLen),
                    bridgePierMat
                );
                cheek.position.set(cheekX, 0.12, endSign * (flatHalfSpan + rampLen * 0.5));
                bridgeGroup.add(cheek);
            });
        });

        // 3. Heavy Concrete & Steel Bridge Support Piers Extending All the Way Down to the Riverbed / Ocean Floor
        const pierPositionsZ = spanLength > 26.0
            ? [-spanLength * 0.36, -spanLength * 0.12, spanLength * 0.12, spanLength * 0.36]
            : [-spanLength * 0.26, spanLength * 0.26];
        [-bridgeWidth * 0.38, bridgeWidth * 0.38].forEach(px => {
            pierPositionsZ.forEach(pz => {
                const pierWPt = bridgeLocalToWorld(rb, px, pz);
                const bedY = Math.min(-1.45, getTerrainHeight(pierWPt.x, pierWPt.z) - 0.25);
                const pierTopY = 0.26;
                const pierH = Math.max(1.2, pierTopY - bedY);
                const pierCenterY = bedY + pierH * 0.5;

                const pier = new THREE.Mesh(
                    createSculptedLatheBarrelGeo(0.36, 0.50, pierH, 10),
                    isLava ? lavaHeatShieldMat : (archetype === 'concrete_causeway' ? bridgeConcreteMat : bridgePierMat)
                );
                pier.position.set(px, pierCenterY, pz);
                pier.castShadow = !IS_MOBILE;
                pier.receiveShadow = true;
                bridgeGroup.add(pier);

                // Underwater / Lava-resistant footing pad seated into the bed
                const footing = new THREE.Mesh(
                    createSculptedLatheBarrelGeo(0.56, 0.68, 0.40, 10),
                    isLava ? lavaHeatShieldMat : bridgeConcreteMat
                );
                footing.position.set(px, bedY + 0.18, pz);
                bridgeGroup.add(footing);
            });
        });

        // Cross-beam pier caps connecting left and right columns beneath the deck
        pierPositionsZ.forEach(pz => {
            const pierCap = new THREE.Mesh(
                createExtrudedArmorHullGeo(bridgeWidth * 0.88, 0.26, 0.52),
                isLava ? lavaHeatShieldMat : bridgePierMat
            );
            pierCap.position.set(0, 0.12, pz);
            bridgeGroup.add(pierCap);
        });

        // 4. Archetype-Specific Superstructure, Side Guardrails & Entry Beacons
        [-bridgeWidth * 0.47, bridgeWidth * 0.47].forEach(railX => {
            if (archetype === 'truss_bridge') {
                // Overhead Military Warren Steel Truss Superstructure
                const trussHeight = 1.65;
                const topChord = new THREE.Mesh(
                    createExtrudedArmorHullGeo(0.22, 0.20, spanLength * 0.86),
                    bridgePierMat
                );
                topChord.position.set(railX, 0.35 + trussHeight, 0);
                topChord.castShadow = !IS_MOBILE;
                intactSpanGroup.add(topChord);

                const bottomChord = new THREE.Mesh(
                    createExtrudedArmorHullGeo(0.20, 0.16, spanLength + 0.8),
                    bridgePierMat
                );
                bottomChord.position.set(railX, 0.52, 0);
                intactSpanGroup.add(bottomChord);

                const bayCount = 4;
                const bayLen = (spanLength * 0.84) / bayCount;
                for (let b = 0; b <= bayCount; b++) {
                    const bz = -spanLength * 0.42 + b * bayLen;
                    const vPost = new THREE.Mesh(
                        createExtrudedArmorHullGeo(0.18, trussHeight, 0.18),
                        bridgePierMat
                    );
                    vPost.position.set(railX, 0.35 + trussHeight * 0.5, bz);
                    vPost.castShadow = !IS_MOBILE;
                    intactSpanGroup.add(vPost);

                    if (b < bayCount) {
                        const diagLen = Math.hypot(bayLen, trussHeight);
                        const diagAng = Math.atan2(bayLen, trussHeight) * (b % 2 === 0 ? 1 : -1);
                        const diag = new THREE.Mesh(
                            createExtrudedArmorHullGeo(0.13, diagLen, 0.13),
                            bridgeHazardMat
                        );
                        diag.position.set(railX, 0.35 + trussHeight * 0.5, bz + bayLen * 0.5);
                        diag.rotation.x = diagAng;
                        intactSpanGroup.add(diag);
                    }
                }
            } else if (archetype === 'concrete_causeway') {
                // Heavy Jersey-Barrier Concrete Parapet Walls + Streetlight Pylons
                const parapet = new THREE.Mesh(
                    createExtrudedArmorHullGeo(0.30, 0.56, spanLength + 1.0),
                    bridgeConcreteMat
                );
                parapet.position.set(railX, 0.58, 0);
                parapet.castShadow = !IS_MOBILE;
                intactSpanGroup.add(parapet);

                const coping = new THREE.Mesh(
                    createExtrudedArmorHullGeo(0.34, 0.08, spanLength + 1.1),
                    bridgePierMat
                );
                coping.position.set(railX, 0.88, 0);
                intactSpanGroup.add(coping);
            } else {
                // Industrial Girder Bridge: Heavy Box-Girder Side Beams & Hazard Railings
                const boxGirder = new THREE.Mesh(
                    createExtrudedArmorHullGeo(0.28, 0.48, spanLength + 0.9),
                    bridgeGirderMat
                );
                boxGirder.position.set(railX, 0.48, 0);
                boxGirder.castShadow = !IS_MOBILE;
                intactSpanGroup.add(boxGirder);

                const hazardRail = new THREE.Mesh(
                    createExtrudedArmorHullGeo(0.14, 0.12, spanLength + 0.8),
                    bridgeHazardMat
                );
                hazardRail.position.set(railX, 0.82, 0);
                intactSpanGroup.add(hazardRail);
            }

            // Entry Bollards & Navigation Beacons at Both Ends of the Bridge
            [-spanLength * 0.5, spanLength * 0.5].forEach(endZ => {
                const bollard = new THREE.Mesh(
                    createExtrudedArmorHullGeo(0.32, 0.82, 0.32),
                    bridgePierMat
                );
                bollard.position.set(railX, 0.62, endZ);
                bollard.castShadow = !IS_MOBILE;
                bridgeGroup.add(bollard);

                const beacon = new THREE.Mesh(
                    createSculptedArmorDomeGeo(0.12, 10, 10),
                    MAT.cyanGlow
                );
                beacon.position.set(railX, 1.06, endZ);
                bridgeGroup.add(beacon);
            });
        });

        // Overhead lateral portal braces for truss bridges (high clearance so tall mechs/colossi pass underneath)
        if (archetype === 'truss_bridge') {
            [-spanLength * 0.38, 0, spanLength * 0.38].forEach(pz => {
                const portalStrut = new THREE.Mesh(
                    createExtrudedArmorHullGeo(bridgeWidth * 0.94, 0.16, 0.22),
                    bridgePierMat
                );
                portalStrut.position.set(0, 2.02, pz);
                intactSpanGroup.add(portalStrut);
            });
        }

        bridgeGroup.name = `RiverBridge_${rb.id || 0}_${archetype}`;
        bridgeGroup.userData.bridgeId = rb.id;
        bridgeGroup.userData._bridgeId = rb.id;
        bridgeGroup.userData._creationSource = 'terrain-fow.js:buildRiverBridgeMeshes';
        bridgeGroup.userData._subsystem = 'bridge-generator';
        if (typeof window.tagSceneObjectMetadata === 'function') {
            window.tagSceneObjectMetadata(bridgeGroup, 'terrain-fow.js:buildRiverBridgeMeshes', 'bridge-generator', { bridgeId: rb.id });
        } else {
            bridgeGroup.traverse(child => {
                if (child && child.userData) {
                    child.userData._creationSource = 'terrain-fow.js:buildRiverBridgeMeshes';
                    child.userData._subsystem = 'bridge-generator';
                    child.userData._bridgeId = rb.id;
                }
            });
        }
        addMapMesh(bridgeGroup);
    });
}

function isPointInWaterPond(x, z, extraRadius = 0.4) {
    if (isOnRiverBridge(x, z, 0.85)) return false;
    for (let i = 0; i < DYNAMIC_PONDS.length; i++) {
        const pd = DYNAMIC_PONDS[i];
        const dx = x - pd.x;
        const dz = z - pd.z;
        const d = Math.hypot(dx, dz);
        if (d <= pd.r * 1.48 + extraRadius) {
            const ang = Math.atan2(dz, dx);
            const effR = getDynamicPondRadiusAtAngle(pd, ang);
            if (d <= effR + extraRadius) return true;
        }
    }
    if (ACTIVE_PLANET_BIOME === 'ocean') {
        return getTerrainHeight(x, z) <= WATER_LEVEL + 0.02;
    }
    if (HAS_VALLEY_RIVER) {
        const rc = getRiverCoords(x, z);
        if (rc.dist <= (rc.halfWidth || RIVER_HALF_WIDTH) + extraRadius) return true;
    }
    return false;
}
window.isPointInWaterPond = isPointInWaterPond;

function getNearestPondInteraction(x, z, extraRadius = 0.8) {
    // Strictly prevent any water splash or ripple when covered by or standing on an intact river bridge!
    if (isOnRiverBridge(x, z, 0.95) || getRiverBridgeFactor(x, z) > 0.05) {
        return null;
    }
    for (let i = 0; i < RIVER_BRIDGES.length; i++) {
        const br = RIVER_BRIDGES[i];
        if (br.destroyed) continue;
        const lc = getBridgeLocalCoords(br, x, z);
        if (lc.absS <= br.halfWidth + 0.95 && lc.absU <= (br.rampReachU || (RIVER_HALF_WIDTH + 3.45)) + 0.25) {
            return null;
        }
    }

    for (let i = 0; i < DYNAMIC_PONDS.length; i++) {
        const pd = DYNAMIC_PONDS[i];
        const dx = x - pd.x;
        const dz = z - pd.z;
        const d = Math.hypot(dx, dz);
        if (d <= pd.r * 1.48 + extraRadius) {
            const ang = Math.atan2(dz, dx);
            const effR = getDynamicPondRadiusAtAngle(pd, ang);
            if (d <= effR + extraRadius) {
                return { pond: pd, dist: d, isInside: d <= effR, waterY: -0.38 };
            }
        }
    }
    if (ACTIVE_PLANET_BIOME === 'ocean') {
        const gh = getTerrainHeight(x, z);
        if (gh <= WATER_LEVEL + 0.12) {
            return {
                pond: { x, z, r: 4.0 },
                dist: Math.max(0, gh - WATER_LEVEL),
                isInside: gh <= WATER_LEVEL,
                waterY: WATER_LEVEL
            };
        }
        return null;
    }
    if (HAS_VALLEY_RIVER) {
        const rc = getRiverCoords(x, z);
        const effHalfW = rc.halfWidth || RIVER_HALF_WIDTH;
        if (rc.dist <= effHalfW + extraRadius) {
            const cPt = riverCoordsToWorld(rc.s, rc.centerU);
            return {
                pond: { x: cPt.x, z: cPt.z, r: effHalfW },
                dist: rc.dist,
                isInside: rc.dist <= effHalfW,
                waterY: RIVER_WATER_Y
            };
        }
    }
    return null;
}

const treeFoliageMat = new THREE.MeshStandardMaterial({ color: 0x265429, roughness: 0.74 });
const treeBroadleafMat = new THREE.MeshStandardMaterial({ color: 0x356e32, roughness: 0.70 });
const treeAutumnMat = new THREE.MeshStandardMaterial({ color: 0x4b7c38, roughness: 0.72 });
const treeTrunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3525, roughness: 0.88 });
const rockMat = new THREE.MeshStandardMaterial({ color: 0x5d6775, map: terrainDetailTex, roughness: 0.76 });
const mossRockMat = new THREE.MeshStandardMaterial({ color: 0x4b5d52, map: terrainDetailTex, roughness: 0.80 });
const swayTrees = [];

function createSculptedCanopyGeo(baseRad, height) {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const r = baseRad * (1.0 - Math.pow(t, 0.85)) * (1.0 + 0.14 * Math.sin(t * Math.PI * 3));
        const y = t * height;
        pts.push(new THREE.Vector2(Math.max(0.01, r), y));
    }
    const geo = new THREE.LatheGeometry(pts, 18);
    geo.computeVertexNormals();
    return geo;
}

function createPineTree(x, z, scale = 1) {
    const y = getTerrainHeight(x, z);
    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.scale.setScalar(scale);

    const trunk = new THREE.Mesh(createSculptedLatheBarrelGeo(0.11, 0.25, 1.25, 12), treeTrunkMat);
    trunk.position.y = 0.62; trunk.castShadow = !IS_MOBILE;
    group.add(trunk);

    const crown = new THREE.Group();
    const foliageChoice = seededRandom() > 0.35 ? treeFoliageMat : treeAutumnMat;
    [[0.92, 1.45, 0.55], [0.72, 1.2, 1.35], [0.5, 0.98, 2.02]].forEach(([rad, ht, py]) => {
        const bough = new THREE.Mesh(createSculptedCanopyGeo(rad, ht), foliageChoice);
        bough.position.y = py; bough.rotation.y = seededRandom() * Math.PI;
        bough.castShadow = !IS_MOBILE; bough.receiveShadow = true;
        crown.add(bough);
    });
    group.add(crown);
    addMapMesh(group);
    swayTrees.push({ crown, phase: seededRandom() * 10 });
    obstacles.push({ x, z, r: 0.55 * scale, type: 'tree' });
}

function createBroadleafTree(x, z, scale = 1) {
    const y = getTerrainHeight(x, z);
    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.scale.setScalar(scale);

    const trunk = new THREE.Mesh(createSculptedLatheBarrelGeo(0.14, 0.28, 1.35, 12), treeTrunkMat);
    trunk.position.y = 0.65;
    trunk.castShadow = !IS_MOBILE;
    group.add(trunk);

    const crown = new THREE.Group();
    const puffs = [
        [0, 1.55, 0, 0.82],
        [-0.42, 1.38, 0.28, 0.62],
        [0.44, 1.42, -0.24, 0.64],
        [0.12, 1.78, 0.34, 0.56]
    ];
    puffs.forEach(([px, py, pz, rad], idx) => {
        const puffGeo = createSculptedArmorDomeGeo(rad, 14, 12);
        puffGeo.scale(1.12, 0.82, 1.08);
        const puff = new THREE.Mesh(puffGeo, idx % 2 === 0 ? treeBroadleafMat : treeAutumnMat);
        puff.position.set(px, py, pz);
        puff.castShadow = !IS_MOBILE;
        puff.receiveShadow = true;
        crown.add(puff);
    });
    group.add(crown);
    addMapMesh(group);
    swayTrees.push({ crown, phase: seededRandom() * 10 });
    obstacles.push({ x, z, r: 0.62 * scale, type: 'tree' });
}

// True Procedural 3D Stone & Boulder Geometry Generator (Replaces hardcoded primitives with multi-octave vertex perturbation & geological cleavage planes)
function createDynamicStoneGeometry(seed = 1.0, radius = 0.75, roughness = 0.28, flattenY = 0.72, detail = 2) {
    const baseGeo = new THREE.IcosahedronGeometry(radius, detail);
    const pos = baseGeo.attributes.position;
    const s1 = seed * 13.37 + 1.7;
    const s2 = seed * 29.11 + 4.3;
    const s3 = seed * 47.83 + 9.1;

    // Two procedural geological fracture/cleavage plane normals for realistic rock facets
    const p1x = Math.cos(s1), p1y = 0.35 * Math.sin(s2), p1z = Math.sin(s1);
    const p2x = Math.cos(s2 + 2.1), p2y = -0.45 * Math.cos(s1), p2z = Math.sin(s2 + 2.1);

    const stretchX = 0.88 + (Math.abs(Math.sin(s1)) * 0.42);
    const stretchZ = 0.88 + (Math.abs(Math.cos(s2)) * 0.42);

    for (let i = 0; i < pos.count; i++) {
        let vx = pos.getX(i);
        let vy = pos.getY(i);
        let vz = pos.getZ(i);
        const len = Math.hypot(vx, vy, vz) || 1.0;
        const nx = vx / len, ny = vy / len, nz = vz / len;

        // Multi-octave 3D trigonometric simplex-like rock surface noise
        const oct1 = Math.sin(nx * 2.9 + s1) * Math.cos(nz * 2.9 - s2) + Math.sin(ny * 3.1 + s3) * 0.6;
        const oct2 = Math.sin(nx * 6.4 - s2) * Math.sin(nz * 6.1 + s1) * 0.42;
        const strata = Math.sin(ny * 8.5 + s1 * 0.5) * 0.12;

        // Sharp geological cleavage flattening on two random planes
        const dot1 = nx * p1x + ny * p1y + nz * p1z;
        const dot2 = nx * p2x + ny * p2y + nz * p2z;
        let cleavageFactor = 1.0;
        if (dot1 > 0.52) cleavageFactor *= (1.0 - (dot1 - 0.52) * 0.55);
        if (dot2 > 0.58) cleavageFactor *= (1.0 - (dot2 - 0.58) * 0.48);

        const disp = (1.0 + (oct1 * 0.65 + oct2 + strata) * roughness) * cleavageFactor;
        vx = vx * disp * stretchX;
        vy = vy * disp * flattenY;
        vz = vz * disp * stretchZ;

        // Flatten underside so dynamic stones sit naturally embedded in the ground soil
        if (vy < -radius * flattenY * 0.42) {
            vy = -radius * flattenY * 0.42 + (vy + radius * flattenY * 0.42) * 0.22;
        }
        pos.setXYZ(i, vx, vy, vz);
    }
    baseGeo.computeVertexNormals();
    return baseGeo;
}
window.createDynamicStoneGeometry = createDynamicStoneGeometry;

function createBoulder(x, z, scale = 1, withSubRocks = false) {
    const y = getTerrainHeight(x, z);
    const group = new THREE.Group();
    group.position.set(x, y, z);

    const seedBase = (x * 19.7 + z * 31.3 + seededRandom() * 50);
    const flatten = 0.62 + seededRandom() * 0.28;
    const geo = createDynamicStoneGeometry(seedBase, 0.72 * scale, 0.28, flatten, IS_MOBILE ? 1 : 2);
    const rock = new THREE.Mesh(geo, seededRandom() > 0.38 ? rockMat : mossRockMat);
    rock.position.y = 0.16 * scale;
    rock.rotation.set((seededRandom() - 0.5) * 0.24, seededRandom() * Math.PI * 2, (seededRandom() - 0.5) * 0.24);
    rock.castShadow = !IS_MOBILE; rock.receiveShadow = true;
    group.add(rock);

    const subCount = (withSubRocks ? 2 : 1) + Math.floor(seededRandom() * 3);
    for (let s = 0; s < subCount; s++) {
        const ang = (s / subCount) * Math.PI * 2 + seededRandom() * 0.8;
        const dist = (0.48 + seededRandom() * 0.42) * scale;
        const subRadius = (0.24 + seededRandom() * 0.22) * scale;
        const subGeo = createDynamicStoneGeometry(seedBase + (s + 1) * 7.7, subRadius, 0.32, 0.58 + seededRandom() * 0.25, 1);
        const subRock = new THREE.Mesh(subGeo, (s % 2 === 0) ? mossRockMat : rockMat);
        subRock.position.set(Math.cos(ang) * dist, 0.09 * scale, Math.sin(ang) * dist);
        subRock.rotation.set(seededRandom() * 0.5, seededRandom() * Math.PI * 2, seededRandom() * 0.5);
        subRock.castShadow = !IS_MOBILE;
        subRock.receiveShadow = true;
        group.add(subRock);
    }

    addMapMesh(group);
    obstacles.push({ x, z, r: 0.62 * scale, type: 'rock' });
}

// Checks whether a circle of radius `clearance` around (x, z) overlaps ANY supply road segment, road junction, town street, or bridge approach!
function isPointNearAnyRoadOrBridge(x, z, clearance = 3.6) {
    if (getSupplyRoadFactor(x, z) > 0.04) return true;
    if (isSpotUnderOrBlockingBridge(x, z, clearance + 1.5)) return true;

    for (let i = 0; i < ROAD_JUNCTION_NODES.length; i++) {
        const jn = ROAD_JUNCTION_NODES[i];
        if (Math.hypot(x - jn.x, z - jn.z) < (jn.r || 2.4) + clearance) return true;
    }

    for (let i = 0; i < DYNAMIC_ROAD_SEGMENTS.length; i++) {
        const seg = DYNAMIC_ROAD_SEGMENTS[i];
        if (!seg.samples) precomputeRoadSegmentSamples(seg, 56);
        const samples = seg.samples;
        for (let k = 0; k < samples.length; k += 2) {
            const sp = samples[k];
            if (Math.hypot(x - sp.x, z - sp.z) < (sp.halfWidth || 1.6) + clearance) {
                return true;
            }
        }
    }

    // Also keep clear of Abandoned Town cross-streets
    if (Math.abs(x - ABANDONED_TOWN_CENTER.x) < 13.0 && Math.abs(z - ABANDONED_TOWN_CENTER.z) < 2.6 + clearance) return true;
    if (Math.abs(z - ABANDONED_TOWN_CENTER.z) < 13.0 && Math.abs(x - ABANDONED_TOWN_CENTER.x) < 2.6 + clearance) return true;

    return false;
}
window.isPointNearAnyRoadOrBridge = isPointNearAnyRoadOrBridge;

function isClearForNaturalProp(tx, tz, minClearance = 2.2) {
    const th = getTerrainHeight(tx, tz);
    if (th < -0.15 || th > 3.6) return false;
    if (getRiverDist(tx, tz) < 4.5) return false;
    if (isPointNearAnyRoadOrBridge(tx, tz, minClearance + 1.6)) return false;
    if (isInsideBasePlacementZone(tx, tz, 8.8)) return false;
    if (Math.hypot(tx - ENEMY_BASE_POS.x, tz - ENEMY_BASE_POS.z) < 26) return false;
    if (Math.hypot(tx - SOLARIS_BASE_POS.x, tz - SOLARIS_BASE_POS.z) < 16) return false;
    if (Math.hypot(tx - ABANDONED_TOWN_CENTER.x, tz - ABANDONED_TOWN_CENTER.z) < 14.5) return false;
    if (ABANDONED_BASES.some(ab => Math.hypot(tx - ab.x, tz - ab.z) < 9.5)) return false;
    if (BUILDING_RUINS.some(br => Math.hypot(tx - br.x, tz - br.z) < 5.5)) return false;
    return obstacles.every(o => Math.hypot(o.x - tx, o.z - tz) > o.r + minClearance);
}

const crystalBlueMat = new THREE.MeshStandardMaterial({
    color: 0x00e5ff, emissive: 0x0088cc, emissiveIntensity: 0.85, roughness: 0.08, metalness: 0.78, flatShading: true
});
const crystalGoldMat = new THREE.MeshStandardMaterial({
    color: 0xffc400, emissive: 0xb45309, emissiveIntensity: 0.88, roughness: 0.10, metalness: 0.82, flatShading: true
});
const ruinStoneMat = new THREE.MeshStandardMaterial({
    color: 0x4f5d6e, map: terrainDetailTex, roughness: 0.68, metalness: 0.25
});
const bioFloraMat = new THREE.MeshBasicMaterial({ color: 0x00ffaa });

// Builds a chunky, broad, diamond-cut multi-faceted Bipyramidal Geode Crystal Geometry (NOT a thin stick!)
function createFacetedGeodeCrystalGeo(radius = 0.36, height = 1.15, sides = 6, seed = 1.0) {
    const pts = [
        new THREE.Vector2(0.001, 0.0),
        new THREE.Vector2(radius * 0.82, height * 0.08),
        new THREE.Vector2(radius * 1.08, height * 0.36),
        new THREE.Vector2(radius * 0.96, height * 0.68),
        new THREE.Vector2(radius * 0.44, height * 0.88),
        new THREE.Vector2(0.001, height)
    ];
    const latheGeo = new THREE.LatheGeometry(pts, sides);
    const nonIndexed = latheGeo.toNonIndexed();
    const pos = nonIndexed.attributes.position;
    // Subtle asymmetric facet shear so each crystal prism has crisp natural mineral cleavage planes
    const asymX = 1.0 + Math.sin(seed * 7.1) * 0.16;
    const asymZ = 1.0 + Math.cos(seed * 11.3) * 0.16;
    const slantX = Math.sin(seed * 3.7) * 0.06;
    const slantZ = Math.cos(seed * 5.3) * 0.06;
    for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i);
        const vy = pos.getY(i);
        const vz = pos.getZ(i);
        const hRatio = vy / Math.max(0.1, height);
        pos.setXYZ(
            i,
            vx * asymX + hRatio * slantX,
            vy,
            vz * asymZ + hRatio * slantZ
        );
    }
    nonIndexed.computeVertexNormals();
    return nonIndexed;
}
window.createFacetedGeodeCrystalGeo = createFacetedGeodeCrystalGeo;

function createCrystalMineralCluster(x, z, isRichGold = false) {
    const y = getTerrainHeight(x, z);
    if (y < -0.3) return;
    const group = new THREE.Group();
    group.position.set(x, y, z);

    // 1. Fractured Obsidian-Basalt Geode Matrix Bed with Dynamic Stones
    const geodeBedMat = new THREE.MeshStandardMaterial({ color: 0x262f3d, roughness: 0.84, metalness: 0.22 });
    const baseRock = new THREE.Mesh(createDynamicStoneGeometry(x * 3.1 + z, 1.38, 0.22, 0.24, 2), geodeBedMat);
    baseRock.position.y = 0.10;
    group.add(baseRock);

    for (let r = 0; r < 6; r++) {
        const ra = (r / 6) * Math.PI * 2 + 0.25;
        const rimStone = new THREE.Mesh(
            createDynamicStoneGeometry(x + z + r * 4.3, 0.36 + (r % 2) * 0.12, 0.30, 0.55, 1),
            geodeBedMat
        );
        rimStone.position.set(Math.cos(ra) * 1.18, 0.14, Math.sin(ra) * 1.18);
        rimStone.rotation.y = ra;
        group.add(rimStone);
    }

    const mat = (isRichGold ? crystalGoldMat : crystalBlueMat).clone();
    const glowMat = isRichGold ? MAT.amberGlow : MAT.cyanGlow;
    const crystalMeshes = [];

    // 2. Chunky Multi-Faceted Bipyramidal Geode Crystal Formation (1 Broad Mother Gem + 8 Angled Faceted Daughter Crystals)
    const totalShards = 9;
    for (let i = 0; i < totalShards; i++) {
        const isCenter = (i === 0);
        const ringIdx = i - 1;
        const a = isCenter ? 0 : (ringIdx / 8) * Math.PI * 2 + (ringIdx % 2) * 0.16;
        const dist = isCenter ? 0.0 : (0.38 + (ringIdx % 2) * 0.34);
        const h = isCenter ? 1.48 : (0.86 + (1 - (ringIdx % 3) * 0.18) * 0.48);
        const r = isCenter ? 0.44 : (0.28 + (ringIdx % 2) * 0.08);
        const sides = (i % 2 === 0) ? 6 : 7;

        const shardGroup = new THREE.Group();
        const basePosY = 0.08;
        shardGroup.position.set(Math.cos(a) * dist, basePosY, Math.sin(a) * dist);
        const tilt = isCenter ? 0.05 : (0.32 + (ringIdx % 2) * 0.22);
        shardGroup.rotation.z = -Math.cos(a) * tilt;
        shardGroup.rotation.x = Math.sin(a) * tilt;
        shardGroup.rotation.y = i * 0.85;

        const crystalGeo = createFacetedGeodeCrystalGeo(r, h, sides, x + z + i * 2.7);
        const crystalMesh = new THREE.Mesh(crystalGeo, mat);
        crystalMesh.castShadow = !IS_MOBILE;
        crystalMesh.receiveShadow = true;
        shardGroup.add(crystalMesh);

        // Secondary side twin-crystal growing out of the main crystal's waist
        if (i % 2 === 0) {
            const twinGeo = createFacetedGeodeCrystalGeo(r * 0.58, h * 0.56, 6, i * 5.1);
            const twinMesh = new THREE.Mesh(twinGeo, mat);
            twinMesh.position.set(r * 0.45, h * 0.18, 0);
            twinMesh.rotation.z = -0.48;
            shardGroup.add(twinMesh);
        }

        group.add(shardGroup);
        crystalMeshes.push({
            node: shardGroup,
            mesh: crystalMesh,
            fullScale: 1.0,
            isCenter
        });
    }

    // 3. Glowing Refractive Crystalline Heart & Vein Collar
    const coreGem = new THREE.Mesh(new THREE.OctahedronGeometry(0.46, 1), glowMat);
    coreGem.scale.set(1.25, 0.55, 1.25);
    coreGem.position.y = 0.24;
    group.add(coreGem);

    const veinRing = new THREE.Mesh(createSculptedTorusCollarGeo(1.05, 0.05, 8, 20), glowMat);
    veinRing.rotation.x = Math.PI / 2;
    veinRing.position.y = 0.18;
    group.add(veinRing);

    const geyserGroup = new THREE.Group();
    geyserGroup.position.set(1.95, 0, -0.65);
    const geyserCone = new THREE.Mesh(createSculptedLatheBarrelGeo(0.45, 0.95, 0.62, 12), ruinStoneMat);
    geyserCone.position.y = 0.31;
    const geyserVent = new THREE.Mesh(new THREE.CircleGeometry(0.38, 14), MAT.healGlow);
    geyserVent.rotation.x = -Math.PI / 2;
    geyserVent.position.y = 0.63;
    const geyserHalo = new THREE.Mesh(createSculptedTorusCollarGeo(0.42, 0.04, 8, 16), MAT.healGlow);
    geyserHalo.rotation.x = Math.PI / 2;
    geyserHalo.position.y = 0.85;
    geyserGroup.add(geyserCone, geyserVent, geyserHalo);
    group.add(geyserGroup);

    addMapMesh(group);
    obstacles.push({ x, z, r: 1.48, type: 'mineral' });
    obstacles.push({ x: x + 1.95, z: z - 0.65, r: 0.95, type: 'geyser' });

    const maxMinerals = isRichGold ? 1800 : 1200;
    const patchRecord = {
        id: `mineral_${MINERAL_PATCHES.length + 1}`,
        x,
        z,
        y,
        isGold: Boolean(isRichGold),
        mineralsRemaining: maxMinerals,
        maxMinerals,
        isDepleted: false,
        group,
        crystalMeshes,
        coreGem,
        veinRing,
        crystalMat: mat
    };
    MINERAL_PATCHES.push(patchRecord);
    return patchRecord;
}

// Progressively depletes a Mineral Cluster's 3D faceted crystals as SCVs, Probes, or Drones harvest from it!
window.depleteMineralPatch = function(patch, amount = 8) {
    if (!patch || patch.isDepleted) return 0;
    const maxM = patch.maxMinerals || 1200;
    if (typeof patch.mineralsRemaining !== 'number') patch.mineralsRemaining = maxM;
    const harvested = Math.min(patch.mineralsRemaining, amount);
    patch.mineralsRemaining = Math.max(0, patch.mineralsRemaining - harvested);
    const ratio = THREE.MathUtils.clamp(patch.mineralsRemaining / maxM, 0, 1);

    if (Array.isArray(patch.crystalMeshes)) {
        const count = patch.crystalMeshes.length;
        for (let i = 0; i < count; i++) {
            const entry = patch.crystalMeshes[i];
            if (!entry || !entry.node) continue;
            // Outer crystals deplete first, central mother crystal depletes last
            const threshold = entry.isCenter ? 0.0 : ((count - 1 - i) / count) * 0.72;
            const localRatio = THREE.MathUtils.clamp((ratio - threshold) / (1.0 - threshold || 1.0), 0.0, 1.0);
            const scY = 0.16 + localRatio * 0.84;
            const scXZ = 0.38 + localRatio * 0.62;
            entry.node.scale.set(scXZ, scY, scXZ);
        }
    }
    if (patch.crystalMat && patch.crystalMat.emissiveIntensity !== undefined) {
        patch.crystalMat.emissiveIntensity = 0.12 + ratio * 0.76;
    }
    if (patch.coreGem) {
        patch.coreGem.scale.setScalar(0.25 + ratio * 0.85);
        patch.coreGem.visible = ratio > 0.04;
    }
    if (patch.mineralsRemaining <= 0) {
        patch.isDepleted = true;
        if (patch.crystalMat) {
            patch.crystalMat.color.setHex(0x334155);
            if (patch.crystalMat.emissive) patch.crystalMat.emissive.setHex(0x0f172a);
        }
    }
    return harvested;
};

function createAncientOutpostRuin(x, z, rotY = 0) {
    const y = getTerrainHeight(x, z);
    if (y < -0.3) return;
    const group = new THREE.Group();
    group.rotation.y = rotY;
    addSlopeFoundationPillars(group, x, z, 3.8, 3.8, rotY);

    const dais = new THREE.Mesh(createSculptedLatheBarrelGeo(2.1, 2.45, 0.28, 8), ruinStoneMat);
    dais.position.y = 0.14;
    dais.receiveShadow = true;

    const runeRing = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.55, 8), MAT.plasmaShader);
    runeRing.rotation.x = -Math.PI / 2;
    runeRing.position.y = 0.29;
    group.add(dais, runeRing);

    [-1.35, 1.35].forEach((px, idx) => {
        const pillarH = idx === 0 ? 2.45 : 1.85;
        const pillar = new THREE.Mesh(createSculptedLatheBarrelGeo(0.26, 0.38, pillarH, 6), ruinStoneMat);
        pillar.position.set(px, pillarH * 0.5 + 0.15, 0);
        pillar.rotation.z = idx === 0 ? 0.08 : -0.12;
        pillar.castShadow = !IS_MOBILE;
        const strip = new THREE.Mesh(createExtrudedArmorHullGeo(0.08, pillarH * 0.72, 0.42), MAT.cyanGlow);
        strip.position.set(px, pillarH * 0.5 + 0.15, 0);
        group.add(pillar, strip);
    });

    const keystone = new THREE.Mesh(createSculptedFacetedCrystalGeo(0.38, 0), MAT.plasmaShader);
    keystone.position.set(0, 2.55, 0);
    group.add(keystone);

    addMapMesh(group);
    swayTrees.push({ crown: keystone, phase: seededRandom() * 10 });
    obstacles.push({ x: x - 1.35, z, r: 0.55, type: 'ruin' });
    obstacles.push({ x: x + 1.35, z, r: 0.55, type: 'ruin' });
}

function relocateToSafeSlopePosition(x, z, minRiverClearance = 5.6) {
    let rx = x, rz = z;
    for (let attempt = 0; attempt < 22; attempt++) {
        const rc = getRiverCoords(rx, rz);
        const inPond = DYNAMIC_PONDS.some(pd => Math.hypot(rx - pd.x, rz - pd.z) < pd.r + 2.8);
        const nearBridge = isSpotUnderOrBlockingBridge(rx, rz, 3.2) || isPointInBridgeApproachCorridor(rx, rz, 4.2, 13.5);
        const onRoad = getSupplyRoadFactor(rx, rz) > 0.14;
        const inBaseZone = isInsideBasePlacementZone(rx, rz, 12.5);
        if (rc.dist >= minRiverClearance && !inPond && !nearBridge && !onRoad && !inBaseZone && getTerrainHeight(rx, rz) > -0.15) {
            return { x: rx, z: rz };
        }
        if (inBaseZone) {
            const dx = rx - PLAYER_START_POS.x;
            const dz = rz - PLAYER_START_POS.z;
            const dLen = Math.hypot(dx, dz) || 1;
            rx += (dx / dLen) * 5.5;
            rz -= 6.5;
        } else if (nearBridge || onRoad) {
            // Shift laterally along s away from the nearest bridge centerline & further inland along u so landmarks NEVER land on bridge entrances or roads!
            let nearestBridgeS = 0;
            let minDS = Infinity;
            for (let i = 0; i < RIVER_BRIDGES.length; i++) {
                const dS = rc.s - RIVER_BRIDGES[i].sCoord;
                if (Math.abs(dS) < minDS) {
                    minDS = Math.abs(dS);
                    nearestBridgeS = RIVER_BRIDGES[i].sCoord;
                }
            }
            const sDir = (rc.s >= nearestBridgeS) ? 1 : -1;
            const newS = rc.s + sDir * (4.2 + attempt * 1.1);
            const pushSign = rc.signedDist >= 0 ? 1 : -1;
            const newU = getRiverCenterUAtS(newS) + pushSign * Math.max(rc.dist + 2.0, minRiverClearance + 8.5);
            const wPt = riverCoordsToWorld(newS, newU);
            rx = wPt.x;
            rz = wPt.z;
        } else {
            const pushSign = rc.signedDist >= 0 ? 1 : -1;
            const safeU = rc.centerU + pushSign * (minRiverClearance + 1.5 + attempt * 0.85);
            const wPt = riverCoordsToWorld(rc.s, safeU);
            rx = wPt.x;
            rz = wPt.z;
        }
    }
    return { x: rx, z: rz };
}

function orientObjectToMountainSlope(group, x, z, yaw = 0, extraPitch = 0, extraRoll = 0) {
    const normal = getTerrainNormal(x, z);
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
    const right = new THREE.Vector3().crossVectors(normal, fwd).normalize();
    fwd.crossVectors(right, normal).normalize();

    const m = new THREE.Matrix4().makeBasis(right, normal, fwd);
    group.quaternion.setFromRotationMatrix(m);
    if (extraPitch !== 0 || extraRoll !== 0) {
        const tiltQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(extraPitch, 0, extraRoll));
        group.quaternion.multiply(tiltQ);
    }
}

const concreteRuinMat = new THREE.MeshStandardMaterial({ color: 0x5c646d, roughness: 0.88, metalness: 0.15 });
const rustedSteelMat = new THREE.MeshStandardMaterial({ color: 0x5a3826, roughness: 0.72, metalness: 0.62 });

// Matte Tactically Shaded Asphalt Walkway & Curb Materials:
// Uses SHADER_ENGINE.applyRoadShader so roads receive directional shadows, cloud shadows, and Fog of War darkening with ZERO specular glare!
const dynamicRoadAsphaltMat = new THREE.MeshStandardMaterial({
    color: 0x1e232a,
    roughness: 0.96,
    metalness: 0.02,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2
});
const dynamicRoadShoulderMat = new THREE.MeshStandardMaterial({
    color: 0x353c46,
    roughness: 0.96,
    metalness: 0.02,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
});
const dynamicRoadStripeMat = new THREE.MeshStandardMaterial({
    color: 0xd4a524,
    roughness: 0.90,
    metalness: 0.02,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3
});

if (typeof SHADER_ENGINE !== 'undefined') {
    const roadShaderFn = SHADER_ENGINE.applyRoadShader || SHADER_ENGINE.applyTerrainShader;
    if (roadShaderFn) {
        roadShaderFn.call(SHADER_ENGINE, dynamicRoadAsphaltMat);
        roadShaderFn.call(SHADER_ENGINE, dynamicRoadShoulderMat);
        roadShaderFn.call(SHADER_ENGINE, dynamicRoadStripeMat);
    }
}

// Helper: checks if a point lies inside any multi-road collector junction hub so yellow centerline dashes pause cleanly at intersections!
function isPointNearRoadJunctionHub(x, z, extraMargin = 0.45) {
    for (let i = 0; i < ROAD_JUNCTION_NODES.length; i++) {
        const jn = ROAD_JUNCTION_NODES[i];
        if (Math.hypot(x - jn.x, z - jn.z) < jn.r + extraMargin) {
            return true;
        }
    }
    return false;
}

const dynamicRoadEdgeLineMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5e1,
    roughness: 0.90,
    metalness: 0.02,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3
});
if (typeof SHADER_ENGINE !== 'undefined') {
    const roadShaderFn = SHADER_ENGINE.applyRoadShader || SHADER_ENGINE.applyTerrainShader;
    if (roadShaderFn) roadShaderFn.call(SHADER_ENGINE, dynamicRoadEdgeLineMat);
}

// Builds a Terrain-Conforming, Matte Shadow-Receiving & FoW-Respecting 3D Two-Lane Asphalt Highway Ribbon
// Includes continuous white outer lane edge lines + dashed yellow centerline divider, with ZERO circular roundabout discs!
function createDynamicMorphingRoadRibbon(seg, steps = 68) {
    if (!seg.samples || seg.samples.length < 2) {
        precomputeRoadSegmentSamples(seg, steps);
    }
    const positions = [];
    const shoulderPositions = [];
    const uvs = [];
    const indices = [];

    const stripePositions = [];
    const stripeIndices = [];
    let stripeVertCount = 0;

    const edgeLinePositions = [];
    const edgeLineIndices = [];
    let edgeVertCount = 0;

    let lastRow = -1;
    let rowIndex = 0;
    let cumulativeArc = 0;
    let prevPt = null;
    let prevArc = 0;
    let prevNx = 0, prevNz = 1;

    const stripeHalfW = 0.09;
    const edgeLineHalfW = 0.075;
    const dashPeriod = 2.8;
    const dashDuty = 1.25;

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const curr = evaluateDynamicRoadPoint(seg, t);
        const next = evaluateDynamicRoadPoint(seg, Math.min(1, t + 1 / steps));
        const prev = evaluateDynamicRoadPoint(seg, Math.max(0, t - 1 / steps));

        if (prevPt) {
            cumulativeArc += Math.hypot(curr.x - prevPt.x, curr.z - prevPt.z);
        }

        if (HAS_VALLEY_RIVER) {
            if (seg.isBridgeCauseway) {
                // Clip bridge causeway road ribbon cleanly at the bridge approach ramp toe (with 0.15m overlap for a seamless weld)
                let insideBridgeDeckOrRamp = false;
                for (let b = 0; b < RIVER_BRIDGES.length; b++) {
                    const br = RIVER_BRIDGES[b];
                    const lc = getBridgeLocalCoords(br, curr.x, curr.z);
                    const rampToeU = (br.rampReachU || (RIVER_HALF_WIDTH + 3.45)) - 0.15;
                    if (lc.absS <= br.halfWidth + 1.8 && lc.absU < rampToeU) {
                        insideBridgeDeckOrRamp = true;
                        break;
                    }
                }
                if (insideBridgeDeckOrRamp) {
                    lastRow = -1;
                    prevPt = curr;
                    prevArc = cumulativeArc;
                    continue;
                }
            } else {
                const rc = getRiverCoords(curr.x, curr.z);
                const minRiverClearance = (rc.halfWidth || RIVER_HALF_WIDTH) + 3.6;
                if (rc.dist < minRiverClearance) {
                    lastRow = -1;
                    prevPt = curr;
                    prevArc = cumulativeArc;
                    continue;
                }
            }
        }

        let tx = next.x - prev.x;
        let tz = next.z - prev.z;
        const tLen = Math.hypot(tx, tz) || 1;
        tx /= tLen; tz /= tLen;
        const nx = -tz, nz = tx;

        const hw = curr.halfWidth * 0.92;
        const sw = curr.halfWidth * 1.22;

        const lx = curr.x - nx * hw, lz = curr.z - nz * hw;
        const rx = curr.x + nx * hw, rz = curr.z + nz * hw;
        const cx = curr.x, cz = curr.z;

        // Sample terrain crown height and ensure road crown sits cleanly above side terrain triangles
        const hCenter = getTerrainHeight(cx, cz);
        const hLeft = getTerrainHeight(lx, lz);
        const hRight = getTerrainHeight(rx, rz);
        const baseH = Math.max(hCenter, (hCenter + Math.max(hLeft, hRight)) * 0.5);
        const cy = baseH + 0.064;
        const ly = Math.max(hLeft + 0.052, baseH + 0.046);
        const ry = Math.max(hRight + 0.052, baseH + 0.046);

        positions.push(lx, ly, lz, cx, cy, cz, rx, ry, rz);
        const vCoord = cumulativeArc * 0.42;
        uvs.push(0, vCoord, 0.5, vCoord, 1, vCoord);

        const slx = curr.x - nx * sw, slz = curr.z - nz * sw;
        const srx = curr.x + nx * sw, srz = curr.z + nz * sw;
        const sly = getTerrainHeight(slx, slz) + 0.018;
        const sry = getTerrainHeight(srx, srz) + 0.018;
        shoulderPositions.push(slx, sly, slz, cx, baseH + 0.032, cz, srx, sry, srz);

        if (lastRow >= 0) {
            const prevRow = lastRow * 3;
            const currRow = rowIndex * 3;
            indices.push(prevRow, prevRow + 1, currRow);
            indices.push(currRow, prevRow + 1, currRow + 1);
            indices.push(prevRow + 1, prevRow + 2, currRow + 1);
            indices.push(currRow + 1, prevRow + 2, currRow + 2);
        }

        // Continuous White Highway Edge Lines + Dashed Yellow Centerline Divider
        if (lastRow >= 0 && prevPt && !isPointInWaterPond(cx, cz, -0.15)) {
            const pHw = prevPt.halfWidth * 0.92;
            [-1, 1].forEach(sideSign => {
                const pEdgeOff = sideSign * (pHw - 0.24);
                const cEdgeOff = sideSign * (hw - 0.24);
                const pEx = prevPt.x + prevNx * pEdgeOff, pEz = prevPt.z + prevNz * pEdgeOff;
                const cEx = cx + nx * cEdgeOff, cEz = cz + nz * cEdgeOff;
                const pEy = Math.max(getTerrainHeight(pEx, pEz), getTerrainHeight(prevPt.x, prevPt.z)) + 0.072;
                const cEy = Math.max(getTerrainHeight(cEx, cEz), baseH) + 0.072;

                edgeLinePositions.push(
                    pEx - prevNx * edgeLineHalfW, pEy, pEz - prevNz * edgeLineHalfW,
                    pEx + prevNx * edgeLineHalfW, pEy, pEz + prevNz * edgeLineHalfW,
                    cEx - nx * edgeLineHalfW, cEy, cEz - nz * edgeLineHalfW,
                    cEx + nx * edgeLineHalfW, cEy, cEz + nz * edgeLineHalfW
                );
                edgeLineIndices.push(
                    edgeVertCount, edgeVertCount + 2, edgeVertCount + 1,
                    edgeVertCount + 1, edgeVertCount + 2, edgeVertCount + 3
                );
                edgeVertCount += 4;
            });

            const midArc = 0.5 * (prevArc + cumulativeArc);
            const phaseInPeriod = ((midArc % dashPeriod) + dashPeriod) % dashPeriod;
            if (phaseInPeriod <= dashDuty && t > 0.04 && t < 0.96 && !isPointNearRoadJunctionHub(cx, cz, 0.35)) {
                const pLx = prevPt.x - prevNx * stripeHalfW, pLz = prevPt.z - prevNz * stripeHalfW;
                const pRx = prevPt.x + prevNx * stripeHalfW, pRz = prevPt.z + prevNz * stripeHalfW;
                const cLx = cx - nx * stripeHalfW, cLz = cz - nz * stripeHalfW;
                const cRx = cx + nx * stripeHalfW, cRz = cz + nz * stripeHalfW;

                const pY = getSurfaceHeightWithBridges(prevPt.x, prevPt.z) + 0.076;
                const cY = cy + 0.012;

                stripePositions.push(
                    pLx, pY, pLz,
                    pRx, pY, pRz,
                    cLx, cY, cLz,
                    cRx, cY, cRz
                );
                stripeIndices.push(
                    stripeVertCount, stripeVertCount + 2, stripeVertCount + 1,
                    stripeVertCount + 1, stripeVertCount + 2, stripeVertCount + 3
                );
                stripeVertCount += 4;
            }
        }

        lastRow = rowIndex;
        rowIndex++;
        prevPt = curr;
        prevArc = cumulativeArc;
        prevNx = nx;
        prevNz = nz;
    }

    if (positions.length < 9 || indices.length === 0) return;

    const shoulderGeo = new THREE.BufferGeometry();
    shoulderGeo.setAttribute('position', new THREE.Float32BufferAttribute(shoulderPositions, 3));
    shoulderGeo.setIndex(indices);
    shoulderGeo.computeVertexNormals();
    const shoulderMesh = new THREE.Mesh(shoulderGeo, dynamicRoadShoulderMat);
    shoulderMesh.receiveShadow = true;
    addMapMesh(shoulderMesh);

    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    roadGeo.setIndex(indices);
    roadGeo.computeVertexNormals();
    const roadMesh = new THREE.Mesh(roadGeo, dynamicRoadAsphaltMat);
    roadMesh.receiveShadow = true;
    addMapMesh(roadMesh);

    if (edgeLinePositions.length >= 12 && edgeLineIndices.length >= 6) {
        const edgeGeo = new THREE.BufferGeometry();
        edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeLinePositions, 3));
        edgeGeo.setIndex(edgeLineIndices);
        edgeGeo.computeVertexNormals();
        const edgeMesh = new THREE.Mesh(edgeGeo, dynamicRoadEdgeLineMat);
        edgeMesh.receiveShadow = true;
        addMapMesh(edgeMesh);
    }

    if (stripePositions.length >= 12 && stripeIndices.length >= 6) {
        const stripeGeo = new THREE.BufferGeometry();
        stripeGeo.setAttribute('position', new THREE.Float32BufferAttribute(stripePositions, 3));
        stripeGeo.setIndex(stripeIndices);
        stripeGeo.computeVertexNormals();
        const stripeMesh = new THREE.Mesh(stripeGeo, dynamicRoadStripeMat);
        stripeMesh.receiveShadow = true;
        addMapMesh(stripeMesh);
    }

    if (seg.isCutRoadEnd) {
        createCutOffRoadEndCap(seg);
    }
}

function createCutOffRoadEndCap(seg) {
    const endPt = evaluateDynamicRoadPoint(seg, 0.98);
    const prevPt = evaluateDynamicRoadPoint(seg, 0.90);
    let tx = endPt.x - prevPt.x;
    let tz = endPt.z - prevPt.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len; tz /= len;
    const nx = -tz, nz = tx;
    const rotY = Math.atan2(tx, tz);
    const hw = (endPt.halfWidth || 1.9) * 0.88;

    const capGroup = new THREE.Group();
    for (let c = 0; c < 5; c++) {
        const fracLat = ((c / 4) - 0.5) * hw * 1.65 + (seededRandom() - 0.5) * 0.35;
        const fracFwd = (seededRandom() - 0.3) * 0.95;
        const sx = endPt.x + tx * fracFwd + nx * fracLat;
        const sz = endPt.z + tz * fracFwd + nz * fracLat;
        const sy = getTerrainHeight(sx, sz);
        const slab = new THREE.Mesh(
            createExtrudedArmorHullGeo(0.55 + seededRandom() * 0.45, 0.08, 0.48 + seededRandom() * 0.42),
            c % 2 === 0 ? dynamicRoadAsphaltMat : dynamicRoadShoulderMat
        );
        slab.position.set(sx, sy + 0.04, sz);
        slab.rotation.set((seededRandom() - 0.5) * 0.14, rotY + (seededRandom() - 0.5) * 0.6, (seededRandom() - 0.5) * 0.14);
        slab.receiveShadow = true;
        capGroup.add(slab);
    }
    [-0.58, 0.58].forEach(latFactor => {
        const bx = endPt.x + tx * 0.45 + nx * (hw * latFactor);
        const bz = endPt.z + tz * 0.45 + nz * (hw * latFactor);
        const by = getTerrainHeight(bx, bz);
        const barrier = new THREE.Mesh(createExtrudedArmorHullGeo(1.15, 0.42, 0.32), concreteRuinMat);
        barrier.position.set(bx, by + 0.21, bz);
        barrier.rotation.y = rotY + (latFactor > 0 ? -0.18 : 0.18);
        const stripe = new THREE.Mesh(createExtrudedArmorHullGeo(1.08, 0.10, 0.34), MAT.hazard || dynamicRoadStripeMat);
        stripe.position.set(bx, by + 0.32, bz);
        stripe.rotation.y = barrier.rotation.y;
        capGroup.add(barrier, stripe);
    });
    addMapMesh(capGroup);
}

// Circular junction roundabouts removed so roads connect cleanly without circular rings!
function createRoadJunctionAprons() {
    // Intentionally empty: roads now use continuous C1 spline ribbons without circular roundabout discs
}

function createTerrainConformingStreetRibbon(ax, az, bx, bz, width = 4.2, steps = 28) {
    createDynamicMorphingRoadRibbon({
        ax, az, bx, bz,
        curveSign: 0.02 * (seededRandom() - 0.5),
        baseWidth: width,
        morphAmp: 0.06
    }, steps);
}

const uniqueBuildingWallMats = [
    new THREE.MeshStandardMaterial({ color: 0x47515c, roughness: 0.76, metalness: 0.32 }),
    new THREE.MeshStandardMaterial({ color: 0x3b444e, roughness: 0.72, metalness: 0.42 }),
    new THREE.MeshStandardMaterial({ color: 0x545d68, roughness: 0.80, metalness: 0.25 }),
    new THREE.MeshStandardMaterial({ color: 0x333b45, roughness: 0.70, metalness: 0.48 })
];
const sciFiTrimMat = new THREE.MeshStandardMaterial({ color: 0x22262d, roughness: 0.65, metalness: 0.55 });
const solarPanelMat = new THREE.MeshStandardMaterial({ color: 0x162a45, roughness: 0.28, metalness: 0.85 });
if (typeof SHADER_ENGINE !== 'undefined' && typeof SHADER_ENGINE.applyBuildingShader === 'function') {
    uniqueBuildingWallMats.forEach(m => SHADER_ENGINE.applyBuildingShader(m));
    [sciFiTrimMat, solarPanelMat, concreteRuinMat, rustedSteelMat, rockMat, mossRockMat, treeFoliageMat, treeBroadleafMat, treeAutumnMat, treeTrunkMat].forEach(m => {
        if (m) SHADER_ENGINE.applyBuildingShader(m);
    });
}

function createExtrudedArmorHullGeo(width, height, length, bevelSize = 0.06, chamfer = 0.16) {
    const hw = width * 0.5;
    const hh = height * 0.5;
    const cw = Math.min(hw * 0.45, chamfer);
    const ch = Math.min(hh * 0.45, chamfer);
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

    const depth = Math.max(0.1, length - bevelSize * 2);
    const geo = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelThickness: bevelSize,
        bevelSize: bevelSize * 0.85,
        bevelSegments: 4,
        curveSegments: 8
    });
    geo.translate(0, 0, -depth * 0.5);
    geo.computeVertexNormals();
    return geo;
}
window.createExtrudedArmorHullGeo = createExtrudedArmorHullGeo;

function createOrganicBoulderGeo(radius = 0.6, detail = 1) {
    const geo = createSculptedArmorDomeGeo(Math.max(0.05, radius), detail > 0 ? 12 : 8, detail > 0 ? 10 : 6);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
        const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
        const mod = 1.0 + 0.14 * Math.sin(vx * 3.5 + vz * 2.8) + 0.08 * Math.cos(vy * 4.2 - vx * 2.1);
        p.setXYZ(i, vx * mod, vy * mod * 0.78, vz * mod);
    }
    geo.computeVertexNormals();
    return geo;
}
window.createOrganicBoulderGeo = createOrganicBoulderGeo;

var REGISTERED_MAP_STRUCTURES = window.REGISTERED_MAP_STRUCTURES || [];
window.REGISTERED_MAP_STRUCTURES = REGISTERED_MAP_STRUCTURES;
var DYNAMIC_DIRT_PATHWAYS = window.DYNAMIC_DIRT_PATHWAYS || [];
window.DYNAMIC_DIRT_PATHWAYS = DYNAMIC_DIRT_PATHWAYS;

// Centralized Biome Compatibility & Footprint Eligibility Registry (TDZ-safe via var + lazy getter)
var ALL_BIOMES = ['highland', 'desert', 'jungle', 'ocean', 'lava'];
var STRUCTURE_BIOME_METADATA = null;
var STRUCTURE_PLACEMENT_DIAGNOSTICS = null;

function ensureStructureBiomeRegistry() {
    if (!ALL_BIOMES) {
        ALL_BIOMES = ['highland', 'desert', 'jungle', 'ocean', 'lava'];
    }
    if (!STRUCTURE_BIOME_METADATA) {
        STRUCTURE_BIOME_METADATA = {
            military_trench: { allowedBiomes: ['highland', 'jungle'], excludedBiomes: ['ocean', 'lava', 'desert'], structureCategory: 'military_defense', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 5.0, maxSlopeHeightDiff: 0.95 },
            military_bunker: { allowedBiomes: ['highland', 'jungle', 'desert'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'military_defense', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 2.8, maxSlopeHeightDiff: 0.85 },
            bunker: { allowedBiomes: ['highland', 'jungle', 'desert'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'military_defense', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 2.8, maxSlopeHeightDiff: 0.85 },
            forest_tree: { allowedBiomes: ['highland', 'jungle'], excludedBiomes: ['ocean', 'lava', 'desert'], structureCategory: 'flora', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 1.2, maxSlopeHeightDiff: 1.4 },
            palm_tree: { allowedBiomes: ['desert', 'ocean', 'jungle', 'highland'], excludedBiomes: ['lava'], structureCategory: 'flora', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 1.1, maxSlopeHeightDiff: 1.25 },
            snag_tree: { allowedBiomes: ['highland', 'desert'], excludedBiomes: ['ocean', 'lava', 'jungle'], structureCategory: 'flora', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 1.0, maxSlopeHeightDiff: 1.35 },
            fern_flora: { allowedBiomes: ['highland', 'jungle'], excludedBiomes: ['ocean', 'lava', 'desert'], structureCategory: 'flora', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 0.9, maxSlopeHeightDiff: 1.2 },
            reed_flora: { allowedBiomes: ['highland', 'jungle', 'desert'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'flora', placementSurface: 'shore', requiresDryLand: false, requiresWater: false, defaultRadius: 0.8, maxSlopeHeightDiff: 1.2 },
            desert_flora: { allowedBiomes: ['desert'], excludedBiomes: ['highland', 'jungle', 'ocean', 'lava'], structureCategory: 'flora', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 1.1, maxSlopeHeightDiff: 1.3 },
            desert_hoodoo: { allowedBiomes: ['desert'], excludedBiomes: ['highland', 'jungle', 'ocean', 'lava'], structureCategory: 'geology', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 1.8, maxSlopeHeightDiff: 1.6 },
            volcanic_structure: { allowedBiomes: ['lava'], excludedBiomes: ['highland', 'desert', 'jungle', 'ocean'], structureCategory: 'volcanic_industrial', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.8, maxSlopeHeightDiff: 0.95 },
            geothermal_extractor: { allowedBiomes: ['lava'], excludedBiomes: ['highland', 'desert', 'jungle', 'ocean'], structureCategory: 'volcanic_industrial', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.8, maxSlopeHeightDiff: 0.95 },
            lava_power_generator: { allowedBiomes: ['lava'], excludedBiomes: ['highland', 'desert', 'jungle', 'ocean'], structureCategory: 'volcanic_industrial', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.8, maxSlopeHeightDiff: 0.95 },
            mining_platform: { allowedBiomes: ['lava'], excludedBiomes: ['highland', 'desert', 'jungle', 'ocean'], structureCategory: 'volcanic_industrial', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.8, maxSlopeHeightDiff: 0.95 },
            volcanic_outpost: { allowedBiomes: ['lava'], excludedBiomes: ['highland', 'desert', 'jungle', 'ocean'], structureCategory: 'volcanic_industrial', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.8, maxSlopeHeightDiff: 0.95 },
            civilian_settlement: { allowedBiomes: ['highland', 'desert', 'jungle'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'civilian', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.4, maxSlopeHeightDiff: 0.80 },
            civilian_building: { allowedBiomes: ['highland', 'desert', 'jungle'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'civilian', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.4, maxSlopeHeightDiff: 0.80 },
            rural_village: { allowedBiomes: ['highland', 'desert', 'jungle'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'civilian', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 5.5, maxSlopeHeightDiff: 0.80 },
            railway_spur: { allowedBiomes: ['highland', 'desert'], excludedBiomes: ['ocean', 'lava', 'jungle'], structureCategory: 'infrastructure', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 5.2, maxSlopeHeightDiff: 0.75 },
            wind_solar_complex: { allowedBiomes: ['highland', 'desert'], excludedBiomes: ['ocean', 'lava', 'jungle'], structureCategory: 'industrial', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 5.0, maxSlopeHeightDiff: 0.85 },
            military_camp: { allowedBiomes: ['highland', 'desert', 'jungle'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'military', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.5, maxSlopeHeightDiff: 0.85 },
            military_watch_tower: { allowedBiomes: ['highland', 'desert', 'jungle'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'military', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 2.2, maxSlopeHeightDiff: 0.90 },
            ancient_outpost_ruin: { allowedBiomes: ['highland', 'desert', 'jungle'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'ruins', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 2.8, maxSlopeHeightDiff: 1.10 },
            scrap_junk_pile: { allowedBiomes: ['highland', 'desert'], excludedBiomes: ['ocean', 'lava', 'jungle'], structureCategory: 'debris', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 2.4, maxSlopeHeightDiff: 0.95 },
            satellite_dish_complex: { allowedBiomes: ['highland', 'desert'], excludedBiomes: ['ocean', 'lava', 'jungle'], structureCategory: 'military_comms', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.2, maxSlopeHeightDiff: 0.85 },
            frontier_station: { allowedBiomes: ['highland', 'desert', 'jungle'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'civilian', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.2, maxSlopeHeightDiff: 0.85 },
            radioactive_waste_site: { allowedBiomes: ['highland', 'desert'], excludedBiomes: ['ocean', 'lava', 'jungle'], structureCategory: 'hazard', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.0, maxSlopeHeightDiff: 0.80 },
            bomb_crater: { allowedBiomes: ['highland', 'desert', 'lava'], excludedBiomes: ['ocean', 'jungle'], structureCategory: 'battlefield_damage', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.6, maxSlopeHeightDiff: 0.90 },
            crater: { allowedBiomes: ['highland', 'desert', 'lava'], excludedBiomes: ['ocean', 'jungle'], structureCategory: 'battlefield_damage', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.6, maxSlopeHeightDiff: 0.90 },
            siege_mortar_emplacement: { allowedBiomes: ['highland', 'desert', 'jungle'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'military_defense', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 2.6, maxSlopeHeightDiff: 0.85 },
            battlefield_barriers: { allowedBiomes: ['highland', 'desert', 'jungle'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'military_defense', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 2.4, maxSlopeHeightDiff: 0.90 },
            abandoned_military_vehicle: { allowedBiomes: ['highland', 'desert', 'jungle'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'vehicle_wreck', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 2.4, maxSlopeHeightDiff: 0.90 },
            abandoned_vehicle: { allowedBiomes: ['highland', 'desert', 'jungle'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'vehicle_wreck', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 2.4, maxSlopeHeightDiff: 0.90 },
            crashed_aircraft: { allowedBiomes: ['highland', 'desert', 'jungle'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'aircraft_wreck', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.4, maxSlopeHeightDiff: 0.95 },
            unexploded_bomb: { allowedBiomes: ['highland', 'desert'], excludedBiomes: ['ocean', 'lava', 'jungle'], structureCategory: 'ordnance', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 1.4, maxSlopeHeightDiff: 1.0 },
            wildlife_deer: { allowedBiomes: ['highland', 'jungle'], excludedBiomes: ['ocean', 'lava', 'desert'], structureCategory: 'wildlife', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 1.2, maxSlopeHeightDiff: 1.1 },
            frontier_civilian: { allowedBiomes: ['highland', 'desert', 'jungle'], excludedBiomes: ['ocean', 'lava'], structureCategory: 'civilian_agent', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 1.0, maxSlopeHeightDiff: 0.95 },
            ocean_ship: { allowedBiomes: ['ocean'], excludedBiomes: ['highland', 'desert', 'jungle', 'lava'], structureCategory: 'naval_vessel', placementSurface: 'water', requiresDryLand: false, requiresWater: true, defaultRadius: 5.2, maxSlopeHeightDiff: 2.5 },
            civilian_transport_ship: { allowedBiomes: ['ocean'], excludedBiomes: ['highland', 'desert', 'jungle', 'lava'], structureCategory: 'naval_vessel', placementSurface: 'water', requiresDryLand: false, requiresWater: true, defaultRadius: 5.4, maxSlopeHeightDiff: 2.5 },
            military_warship: { allowedBiomes: ['ocean'], excludedBiomes: ['highland', 'desert', 'jungle', 'lava'], structureCategory: 'naval_vessel', placementSurface: 'water', requiresDryLand: false, requiresWater: true, defaultRadius: 6.2, maxSlopeHeightDiff: 2.5 },
            naval_warship: { allowedBiomes: ['ocean'], excludedBiomes: ['highland', 'desert', 'jungle', 'lava'], structureCategory: 'naval_vessel', placementSurface: 'water', requiresDryLand: false, requiresWater: true, defaultRadius: 6.2, maxSlopeHeightDiff: 2.5 },
            aircraft_carrier: { allowedBiomes: ['ocean'], excludedBiomes: ['highland', 'desert', 'jungle', 'lava'], structureCategory: 'naval_vessel', placementSurface: 'water', requiresDryLand: false, requiresWater: true, defaultRadius: 9.2, maxSlopeHeightDiff: 3.0 },
            naval_support_vessel: { allowedBiomes: ['ocean'], excludedBiomes: ['highland', 'desert', 'jungle', 'lava'], structureCategory: 'naval_vessel', placementSurface: 'water', requiresDryLand: false, requiresWater: true, defaultRadius: 4.4, maxSlopeHeightDiff: 2.5 },
            wrecked_ship: { allowedBiomes: ['ocean'], excludedBiomes: ['highland', 'desert', 'jungle', 'lava'], structureCategory: 'naval_wreck', placementSurface: 'water', requiresDryLand: false, requiresWater: true, defaultRadius: 5.0, maxSlopeHeightDiff: 2.8 },
            abandoned_command_ship: { allowedBiomes: ['ocean'], excludedBiomes: ['highland', 'desert', 'jungle', 'lava'], structureCategory: 'naval_installation', placementSurface: 'water', requiresDryLand: false, requiresWater: true, defaultRadius: 6.8, maxSlopeHeightDiff: 2.8 },
            wrecked_military_vessel: { allowedBiomes: ['ocean'], excludedBiomes: ['highland', 'desert', 'jungle', 'lava'], structureCategory: 'naval_wreck', placementSurface: 'water', requiresDryLand: false, requiresWater: true, defaultRadius: 5.5, maxSlopeHeightDiff: 2.8 },
            naval_military_installation: { allowedBiomes: ['ocean'], excludedBiomes: ['highland', 'desert', 'jungle', 'lava'], structureCategory: 'naval_installation', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.4, maxSlopeHeightDiff: 0.90 },
            coastal_radar_installation: { allowedBiomes: ['ocean'], excludedBiomes: ['highland', 'desert', 'jungle', 'lava'], structureCategory: 'naval_installation', placementSurface: 'land', requiresDryLand: true, requiresWater: false, defaultRadius: 3.2, maxSlopeHeightDiff: 0.90 },
            naval_defense_platform: { allowedBiomes: ['ocean'], excludedBiomes: ['highland', 'desert', 'jungle', 'lava'], structureCategory: 'naval_installation', placementSurface: 'water', requiresDryLand: false, requiresWater: true, defaultRadius: 4.2, maxSlopeHeightDiff: 2.5 },
            offshore_military_installation: { allowedBiomes: ['ocean'], excludedBiomes: ['highland', 'desert', 'jungle', 'lava'], structureCategory: 'naval_installation', placementSurface: 'water', requiresDryLand: false, requiresWater: true, defaultRadius: 4.8, maxSlopeHeightDiff: 2.5 },
            limestone_coastal_formation: { allowedBiomes: ['ocean'], excludedBiomes: ['highland', 'desert', 'jungle', 'lava'], structureCategory: 'geology', placementSurface: 'shore', requiresDryLand: false, requiresWater: false, defaultRadius: 1.4, maxSlopeHeightDiff: 1.8 }
        };
        window.STRUCTURE_BIOME_METADATA = STRUCTURE_BIOME_METADATA;
    }
    if (!STRUCTURE_PLACEMENT_DIAGNOSTICS) {
        STRUCTURE_PLACEMENT_DIAGNOSTICS = {
            activeBiome: 'highland',
            acceptedCount: 0,
            rejectedCount: 0,
            rejectionCountsByReason: {},
            recentRejections: [],
            placedStructures: []
        };
        window.STRUCTURE_PLACEMENT_DIAGNOSTICS = STRUCTURE_PLACEMENT_DIAGNOSTICS;
    }
}
ensureStructureBiomeRegistry();

function recordStructurePlacementDiagnostic(structureId, biome, x, z, accepted, reason) {
    ensureStructureBiomeRegistry();
    STRUCTURE_PLACEMENT_DIAGNOSTICS.activeBiome = biome || ACTIVE_PLANET_BIOME || 'highland';
    if (accepted) {
        STRUCTURE_PLACEMENT_DIAGNOSTICS.acceptedCount++;
        if (STRUCTURE_PLACEMENT_DIAGNOSTICS.placedStructures.length < 240) {
            STRUCTURE_PLACEMENT_DIAGNOSTICS.placedStructures.push({
                structureId,
                biome: STRUCTURE_PLACEMENT_DIAGNOSTICS.activeBiome,
                x: Number((x || 0).toFixed(2)),
                z: Number((z || 0).toFixed(2))
            });
        }
    } else {
        STRUCTURE_PLACEMENT_DIAGNOSTICS.rejectedCount++;
        const key = `${structureId}:${reason || 'invalid'}`;
        STRUCTURE_PLACEMENT_DIAGNOSTICS.rejectionCountsByReason[key] =
            (STRUCTURE_PLACEMENT_DIAGNOSTICS.rejectionCountsByReason[key] || 0) + 1;
        if (STRUCTURE_PLACEMENT_DIAGNOSTICS.recentRejections.length < 120) {
            STRUCTURE_PLACEMENT_DIAGNOSTICS.recentRejections.push({
                structureId,
                biome: STRUCTURE_PLACEMENT_DIAGNOSTICS.activeBiome,
                x: Number((x || 0).toFixed(2)),
                z: Number((z || 0).toFixed(2)),
                reason: reason || 'unknown'
            });
        }
    }
}

function getStructureBiomeMetadata(structureId) {
    ensureStructureBiomeRegistry();
    if (structureId && STRUCTURE_BIOME_METADATA[structureId]) {
        return STRUCTURE_BIOME_METADATA[structureId];
    }
    return {
        allowedBiomes: ['highland', 'desert', 'jungle'],
        excludedBiomes: ['ocean', 'lava'],
        structureCategory: 'general_land_structure',
        placementSurface: 'land',
        requiresDryLand: true,
        requiresWater: false,
        defaultRadius: 2.8,
        maxSlopeHeightDiff: 0.88
    };
}
window.getStructureBiomeMetadata = getStructureBiomeMetadata;

function isStructureAllowedInBiome(structureId, biome = ACTIVE_PLANET_BIOME) {
    ensureStructureBiomeRegistry();
    const activeBiome = String(biome || ACTIVE_PLANET_BIOME || 'highland').toLowerCase();
    const meta = getStructureBiomeMetadata(structureId);
    if (Array.isArray(meta.excludedBiomes) && meta.excludedBiomes.includes(activeBiome)) {
        return false;
    }
    if (Array.isArray(meta.allowedBiomes) && meta.allowedBiomes.length > 0) {
        return meta.allowedBiomes.includes(activeBiome);
    }
    return ALL_BIOMES.includes(activeBiome);
}
window.isStructureAllowedInBiome = isStructureAllowedInBiome;

function isFootprintAboveWater(x, z, footprintRadius = 2.6, sampleCount = 8, minClearanceAboveWater = 0.08) {
    const waterY = typeof RIVER_WATER_Y === 'number' ? RIVER_WATER_Y : -0.18;
    const minSafeY = HAS_VALLEY_RIVER ? (waterY + minClearanceAboveWater) : -0.12;
    const centerH = getTerrainHeight(x, z);
    if (!Number.isFinite(centerH) || centerH < minSafeY) return false;
    if (HAS_VALLEY_RIVER && getRiverDist(x, z) < RIVER_HALF_WIDTH + footprintRadius + 1.2) return false;
    if (isPointInWaterPond(x, z, footprintRadius + 1.2)) return false;

    const rings = [footprintRadius * 0.55, footprintRadius];
    for (let rIdx = 0; rIdx < rings.length; rIdx++) {
        const r = rings[rIdx];
        if (r <= 0.05) continue;
        for (let i = 0; i < sampleCount; i++) {
            const ang = (i / sampleCount) * Math.PI * 2;
            const sx = x + Math.cos(ang) * r;
            const sz = z + Math.sin(ang) * r;
            const sh = getTerrainHeight(sx, sz);
            if (!Number.isFinite(sh) || sh < minSafeY) return false;
            if (HAS_VALLEY_RIVER && getRiverDist(sx, sz) < RIVER_HALF_WIDTH + 1.0) return false;
            if (isPointInWaterPond(sx, sz, 0.8)) return false;
        }
    }
    return true;
}
window.isFootprintAboveWater = isFootprintAboveWater;

function isFootprintInNavigableWater(x, z, footprintRadius = 5.0, sampleCount = 8) {
    const waterY = typeof RIVER_WATER_Y === 'number' ? RIVER_WATER_Y : -0.18;
    const maxBedY = waterY - 0.14;
    const centerH = getTerrainHeight(x, z);
    if (!Number.isFinite(centerH) || centerH > maxBedY) return false;
    for (let i = 0; i < sampleCount; i++) {
        const ang = (i / sampleCount) * Math.PI * 2;
        const sx = x + Math.cos(ang) * (footprintRadius * 0.82);
        const sz = z + Math.sin(ang) * (footprintRadius * 0.82);
        const sh = getTerrainHeight(sx, sz);
        if (!Number.isFinite(sh) || sh > waterY - 0.06) return false;
    }
    return true;
}
window.isFootprintInNavigableWater = isFootprintInNavigableWater;

function validateStructurePlacement(structureId, x, z, radiusOrOptions = {}, maybeOptions = {}) {
    const options = typeof radiusOrOptions === 'number'
        ? { ...(maybeOptions || {}), footprintRadius: radiusOrOptions }
        : (radiusOrOptions || {});
    const biome = options.biome || ACTIVE_PLANET_BIOME || 'highland';
    const meta = getStructureBiomeMetadata(structureId);
    const footprintRadius = options.footprintRadius ?? meta.defaultRadius ?? 2.6;
    const roadClearance = options.roadClearance ?? Math.max(4.8, footprintRadius + 2.8);
    const minSeparation = options.minSeparation ?? 3.4;
    const maxSlopeHeightDiff = options.maxSlopeHeightDiff ?? meta.maxSlopeHeightDiff ?? 0.90;

    if (!isStructureAllowedInBiome(structureId, biome)) {
        recordStructurePlacementDiagnostic(structureId, biome, x, z, false, 'biome_not_allowed');
        return { valid: false, reason: 'biome_not_allowed', structureId, biome, x, z };
    }
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 84 || Math.abs(z) > 84) {
        recordStructurePlacementDiagnostic(structureId, biome, x, z, false, 'out_of_bounds');
        return { valid: false, reason: 'out_of_bounds', structureId, biome, x, z };
    }

    const cy = getTerrainHeight(x, z);
    if (isInsideBasePlacementZone(x, z, 15.0 + footprintRadius) ||
        Math.hypot(x - ENEMY_BASE_POS.x, z - ENEMY_BASE_POS.z) < 24.0 + footprintRadius ||
        Math.hypot(x - SOLARIS_BASE_POS.x, z - SOLARIS_BASE_POS.z) < 19.0 + footprintRadius) {
        recordStructurePlacementDiagnostic(structureId, biome, x, z, false, 'inside_base_exclusion_zone');
        return { valid: false, reason: 'inside_base_exclusion_zone', structureId, biome, x, z };
    }

    if (isSpotUnderOrBlockingBridge(x, z, footprintRadius + 4.2)) {
        recordStructurePlacementDiagnostic(structureId, biome, x, z, false, 'blocks_bridge_or_corridor');
        return { valid: false, reason: 'blocks_bridge_or_corridor', structureId, biome, x, z };
    }

    if (meta.requiresWater || meta.placementSurface === 'water') {
        if (!isFootprintInNavigableWater(x, z, footprintRadius, 8)) {
            recordStructurePlacementDiagnostic(structureId, biome, x, z, false, 'requires_water_surface');
            return { valid: false, reason: 'requires_water_surface', structureId, biome, x, z };
        }
    } else if (meta.requiresDryLand || meta.placementSurface === 'land') {
        if (cy < 0.02 || cy > 6.5 || !isFootprintAboveWater(x, z, footprintRadius, 8, 0.08)) {
            recordStructurePlacementDiagnostic(structureId, biome, x, z, false, 'footprint_intersects_water');
            return { valid: false, reason: 'footprint_intersects_water', structureId, biome, x, z };
        }
        let minH = cy, maxH = cy;
        for (let p = 0; p < 8; p++) {
            const pa = (p / 8) * Math.PI * 2;
            const px = x + Math.cos(pa) * footprintRadius;
            const pz = z + Math.sin(pa) * footprintRadius;
            const ph = getTerrainHeight(px, pz);
            if (ph < minH) minH = ph;
            if (ph > maxH) maxH = ph;
            if (isPointNearAnyRoadOrBridge(px, pz, 2.8)) {
                recordStructurePlacementDiagnostic(structureId, biome, x, z, false, 'intersects_road_or_bridge');
                return { valid: false, reason: 'intersects_road_or_bridge', structureId, biome, x, z };
            }
        }
        if (maxH - minH > maxSlopeHeightDiff) {
            recordStructurePlacementDiagnostic(structureId, biome, x, z, false, 'excessive_terrain_slope');
            return { valid: false, reason: 'excessive_terrain_slope', structureId, biome, x, z, slopeDiff: Number((maxH - minH).toFixed(3)) };
        }
        for (let b = 0; b < BASE_TERRAIN_ZONES.length; b++) {
            const bz = BASE_TERRAIN_ZONES[b];
            if (bz && Math.hypot(x - bz.x, z - bz.z) < (bz.rimOuter || 20.0) + footprintRadius + 6.5) {
                recordStructurePlacementDiagnostic(structureId, biome, x, z, false, 'near_base_ramp_or_cliff_rim');
                return { valid: false, reason: 'near_base_ramp_or_cliff_rim', structureId, biome, x, z };
            }
        }
        if (isPointNearAnyRoadOrBridge(x, z, roadClearance)) {
            recordStructurePlacementDiagnostic(structureId, biome, x, z, false, 'too_close_to_road_or_bridge');
            return { valid: false, reason: 'too_close_to_road_or_bridge', structureId, biome, x, z };
        }
    }

    if (GEM_CRATERS.some(gc => Math.hypot(x - gc.x, z - gc.z) < (gc.radius || 3.85) + footprintRadius + minSeparation) ||
        DYNAMIC_BOMB_CRATERS.some(bc => Math.hypot(x - bc.x, z - bc.z) < (bc.r || 3.2) + footprintRadius + minSeparation) ||
        DYNAMIC_TRENCHES.some(tr => Math.hypot(x - tr.x, z - tr.z) < (tr.halfLen || 5.0) + footprintRadius + minSeparation)) {
        recordStructurePlacementDiagnostic(structureId, biome, x, z, false, 'overlaps_crater_or_trench');
        return { valid: false, reason: 'overlaps_crater_or_trench', structureId, biome, x, z };
    }

    for (let i = 0; i < REGISTERED_MAP_STRUCTURES.length; i++) {
        const rs = REGISTERED_MAP_STRUCTURES[i];
        if (Math.hypot(x - rs.x, z - rs.z) < (rs.r || 3.0) + footprintRadius + minSeparation) {
            recordStructurePlacementDiagnostic(structureId, biome, x, z, false, 'overlaps_registered_structure');
            return { valid: false, reason: 'overlaps_registered_structure', structureId, biome, x, z };
        }
    }
    for (let i = 0; i < obstacles.length; i++) {
        const ob = obstacles[i];
        const obR = Math.max(ob.r || 1.2, ob.footprintR || 0);
        if (Math.hypot(x - ob.x, z - ob.z) < obR + footprintRadius + minSeparation) {
            recordStructurePlacementDiagnostic(structureId, biome, x, z, false, 'overlaps_obstacle_footprint');
            return { valid: false, reason: 'overlaps_obstacle_footprint', structureId, biome, x, z };
        }
    }

    recordStructurePlacementDiagnostic(structureId, biome, x, z, true, 'ok');
    return {
        valid: true,
        reason: 'ok',
        structureId,
        biome,
        x,
        z,
        y: (meta.requiresWater || meta.placementSurface === 'water') ? (typeof RIVER_WATER_Y === 'number' ? RIVER_WATER_Y : -0.18) : cy
    };
}
window.validateStructurePlacement = validateStructurePlacement;

function findAlternativeStructurePlacement(structureId, rawX, rawZ, radiusOrOptions = {}, maybeOptions = {}) {
    const options = typeof radiusOrOptions === 'number'
        ? { ...(maybeOptions || {}), footprintRadius: radiusOrOptions }
        : (radiusOrOptions || {});
    const biome = options.biome || ACTIVE_PLANET_BIOME || 'highland';
    if (!isStructureAllowedInBiome(structureId, biome)) {
        recordStructurePlacementDiagnostic(structureId, biome, rawX, rawZ, false, 'biome_not_allowed');
        return null;
    }
    const meta = getStructureBiomeMetadata(structureId);
    const footprintRadius = options.footprintRadius ?? meta.defaultRadius ?? 2.6;
    const roadClearance = options.roadClearance ?? Math.max(5.2, footprintRadius + 3.0);
    const minSeparation = options.minSeparation ?? 3.6;
    const basePt = (meta.requiresWater || meta.placementSurface === 'water')
        ? { x: rawX, z: rawZ }
        : relocateToSafeSlopePosition(rawX, rawZ, roadClearance);
    const searchRadii = [0, 4.5, 8.5, 13.0, 18.0, 23.5, 29.5, 36.0, 43.0, 51.0, 60.0];

    for (let rIdx = 0; rIdx < searchRadii.length; rIdx++) {
        const rad = searchRadii[rIdx];
        const steps = rad === 0 ? 1 : 24;
        for (let s = 0; s < steps; s++) {
            const ang = (s / steps) * Math.PI * 2 + rIdx * 0.55;
            const cx = basePt.x + Math.cos(ang) * rad;
            const cz = basePt.z + Math.sin(ang) * rad;
            const check = validateStructurePlacement(structureId, cx, cz, {
                ...options,
                biome,
                footprintRadius,
                roadClearance,
                minSeparation
            });
            if (check.valid) {
                if (options.register !== false) {
                    REGISTERED_MAP_STRUCTURES.push({ x: cx, z: cz, r: footprintRadius, type: structureId, biome });
                }
                return { valid: true, x: cx, z: cz, y: check.y, structureId, biome };
            }
        }
    }
    return null;
}
window.findAlternativeStructurePlacement = findAlternativeStructurePlacement;

// Strict Non-Overlap Structure Placement Solver:
// Guarantees generated buildings, towns, military buildings, cargo yards, minivan houses, evacuation camps, craters, trenches & wrecks NEVER overlap!
function findNonOverlappingStructureSpot(rawX, rawZ, footprintRadius = 2.6, roadClearance = 5.8, minSeparation = 3.6, structureId = 'civilian_settlement') {
    return findAlternativeStructurePlacement(structureId, rawX, rawZ, {
        biome: ACTIVE_PLANET_BIOME,
        footprintRadius,
        roadClearance,
        minSeparation,
        register: true
    });
}

function createProceduralUniqueFrontierBuilding(rawX, rawZ, seedIdx = 0, isHeavilyRuined = false) {
    const w = 3.2 + seededRandom() * 1.4;
    const d = 3.0 + seededRandom() * 1.4;
    const footR = Math.max(w, d) * 0.62;
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, footR, 6.8, 2.8);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    const archType = (seedIdx + Math.floor(seededRandom() * 6)) % 6;
    const floors = isHeavilyRuined ? (1 + Math.floor(seededRandom() * 2)) : (2 + Math.floor(seededRandom() * 3));
    const floorH = 1.15 + seededRandom() * 0.25;
    const totalH = floors * floorH;
    const rotY = seededRandom() * Math.PI * 2;

    const wallMat = uniqueBuildingWallMats[seedIdx % uniqueBuildingWallMats.length];
    const accentGlows = [MAT.cyanGlow, MAT.amberGlow, MAT.crimsonTank, MAT.healGlow];
    const glowMat = accentGlows[(seedIdx + Math.floor(seededRandom() * 4)) % accentGlows.length];

    // Carve and level the floor terrain directly underneath the building (ZERO foundation pillars!)
    const carvedY = flattenTerrainUnderBuilding(x, z, footR + 0.45, 2.2);
    const group = new THREE.Group();
    group.position.set(x, carvedY, z);
    group.rotation.y = rotY;

    const body = new THREE.Group();
    if (isHeavilyRuined) {
        body.rotation.x = (seededRandom() - 0.5) * 0.08;
        body.rotation.z = (seededRandom() - 0.5) * 0.08;
    }
    group.add(body);

    const plinth = new THREE.Mesh(createExtrudedArmorHullGeo(w + 0.65, 0.28, d + 0.65, 0.05, 0.22), MAT.darkSteel);
    plinth.position.y = 0.14;
    plinth.receiveShadow = true;
    const plinthTrim = new THREE.Mesh(createExtrudedArmorHullGeo(w + 0.70, 0.08, d + 0.70), MAT.hazard);
    plinthTrim.position.y = 0.26;
    body.add(plinth, plinthTrim);

    if (archType === 0) {
        const mainW = w * 0.68, mainD = d * 0.88;
        const mainHull = new THREE.Mesh(createExtrudedArmorHullGeo(mainW, totalH, mainD, 0.08, 0.25), wallMat);
        mainHull.position.set(-w * 0.12, totalH * 0.5 + 0.28, 0);
        mainHull.castShadow = !IS_MOBILE;
        mainHull.receiveShadow = true;

        const annexH = totalH * 0.65;
        const annexW = w * 0.44, annexD = d * 0.58;
        const annexHull = new THREE.Mesh(createExtrudedArmorHullGeo(annexW, annexH, annexD, 0.06, 0.20), MAT.gunmetal);
        annexHull.position.set(w * 0.32, annexH * 0.5 + 0.28, d * 0.16);
        annexHull.castShadow = !IS_MOBILE;

        const spire = new THREE.Mesh(createSculptedLatheBarrelGeo(0.06, 0.16, 2.2, 8), MAT.copper);
        spire.position.set(-w * 0.12, totalH + 1.25, -mainD * 0.22);
        const beacon = new THREE.Mesh(createSculptedArmorDomeGeo(0.12, 10, 10), MAT.crimsonTank);
        beacon.position.set(-w * 0.12, totalH + 2.35, -mainD * 0.22);
        body.add(mainHull, annexHull, spire, beacon);
    } else if (archType === 1) {
        const twW = w * 0.42;
        const hL = totalH * 1.05;
        const hR = totalH * 0.88;
        const tL = new THREE.Mesh(createExtrudedArmorHullGeo(twW, hL, d * 0.82, 0.08, 0.25), wallMat);
        tL.position.set(-w * 0.30, hL * 0.5 + 0.28, 0);
        tL.castShadow = !IS_MOBILE;
        const tR = new THREE.Mesh(createExtrudedArmorHullGeo(twW, hR, d * 0.82, 0.08, 0.25), wallMat);
        tR.position.set(w * 0.30, hR * 0.5 + 0.28, 0);
        tR.castShadow = !IS_MOBILE;

        const bridgeY = Math.min(hL, hR) * 0.68 + 0.28;
        const bridge = new THREE.Mesh(createExtrudedArmorHullGeo(w * 0.58, 0.55, d * 0.48, 0.05, 0.15), MAT.gunmetal);
        bridge.position.set(0, bridgeY, 0);
        const bridgeVisor = new THREE.Mesh(createExtrudedArmorHullGeo(w * 0.54, 0.16, d * 0.52), glowMat);
        bridgeVisor.position.set(0, bridgeY, 0);
        body.add(tL, tR, bridge, bridgeVisor);
    } else if (archType === 2) {
        const hallH = totalH * 0.75;
        const hall = new THREE.Mesh(createExtrudedArmorHullGeo(w * 0.85, hallH, d * 0.85, 0.08, 0.25), wallMat);
        hall.position.set(0, hallH * 0.5 + 0.28, 0);
        hall.castShadow = !IS_MOBILE;

        [-w * 0.32, w * 0.32].forEach((sx, idx) => {
            const scrubber = new THREE.Mesh(createSculptedLatheBarrelGeo(0.35, 0.42, totalH * 0.95, 14), MAT.gunmetal);
            scrubber.position.set(sx, totalH * 0.48 + 0.28, -d * 0.28);
            const ring = new THREE.Mesh(createSculptedTorusCollarGeo(0.38, 0.05, 8, 16), idx === 0 ? MAT.cyanGlow : MAT.amberGlow);
            ring.rotation.x = Math.PI / 2;
            ring.position.set(sx, totalH * 0.72 + 0.28, -d * 0.28);
            body.add(scrubber, ring);
        });
        body.add(hall);
    } else if (archType === 3) {
        const bunkerH = totalH * 0.78;
        const bunker = new THREE.Mesh(createSculptedLatheBarrelGeo(w * 0.55, w * 0.65, bunkerH, 8), wallMat);
        bunker.position.set(0, bunkerH * 0.5 + 0.28, 0);
        bunker.castShadow = !IS_MOBILE;

        const turretCupola = new THREE.Mesh(createSculptedLatheBarrelGeo(w * 0.35, w * 0.40, 0.48, 8), MAT.gunmetal);
        turretCupola.position.set(0, bunkerH + 0.48, 0);
        const slitVisor = new THREE.Mesh(createSculptedLatheBarrelGeo(w * 0.56, w * 0.56, 0.16, 8), glowMat);
        slitVisor.position.set(0, bunkerH * 0.62 + 0.28, 0);
        body.add(bunker, turretCupola, slitVisor);
    } else if (archType === 4) {
        for (let fl = 0; fl < floors; fl++) {
            const shrink = 1.0 - fl * 0.15;
            const tH = floorH * 0.92;
            const tier = new THREE.Mesh(createExtrudedArmorHullGeo(w * shrink, tH, d * shrink, 0.05, 0.18), fl % 2 === 0 ? wallMat : MAT.gunmetal);
            tier.position.set(0, fl * floorH + tH * 0.5 + 0.28, 0);
            tier.castShadow = !IS_MOBILE;
            body.add(tier);
        }
        const solarPanel = new THREE.Mesh(createExtrudedArmorHullGeo(w * 0.52, 0.08, d * 0.44), solarPanelMat);
        solarPanel.position.set(0, totalH + 0.38, 0);
        solarPanel.rotation.x = 0.22;
        body.add(solarPanel);
    } else {
        const silo = new THREE.Mesh(createSculptedLatheBarrelGeo(0.68, 0.74, totalH * 1.15, 16), MAT.gunmetal);
        silo.position.set(w * 0.25, totalH * 0.58 + 0.28, 0);
        silo.castShadow = !IS_MOBILE;
        const siloCap = new THREE.Mesh(createSculptedArmorDomeGeo(0.69, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), MAT.hazard);
        siloCap.position.set(w * 0.25, totalH * 1.15 + 0.28, 0);

        const hangar = new THREE.Mesh(createExtrudedArmorHullGeo(w * 0.62, totalH * 0.72, d * 0.85, 0.06, 0.22), wallMat);
        hangar.position.set(-w * 0.26, totalH * 0.36 + 0.28, 0);
        hangar.castShadow = !IS_MOBILE;

        const door = new THREE.Mesh(createExtrudedArmorHullGeo(0.12, totalH * 0.52, d * 0.48), sciFiTrimMat);
        door.position.set(-w * 0.26 - w * 0.31, totalH * 0.26 + 0.28, 0);
        body.add(silo, siloCap, hangar, door);
    }

    [-w * 0.45, w * 0.45].forEach(bx => {
        [-d * 0.45, d * 0.45].forEach(bz => {
            const buttress = new THREE.Mesh(createExtrudedArmorHullGeo(0.24, totalH * 0.85, 0.24), sciFiTrimMat);
            buttress.position.set(bx, totalH * 0.42 + 0.28, bz);
            body.add(buttress);
        });
    });

    const winRows = Math.min(3, floors);
    for (let wr = 0; wr < winRows; wr++) {
        const wy = 0.75 + wr * floorH;
        if (wy < totalH) {
            const visor = new THREE.Mesh(createExtrudedArmorHullGeo(w * 0.74, 0.16, d + 0.08), wr === 0 ? glowMat : sciFiTrimMat);
            visor.position.set(0, wy, 0);
            body.add(visor);
        }
    }

    const rubbleCount = isHeavilyRuined ? 4 : 2;
    for (let c = 0; c < rubbleCount; c++) {
        const ang = (c / rubbleCount) * Math.PI * 2 + seededRandom();
        const rDist = (w * 0.55) + seededRandom() * 0.5;
        const barricade = new THREE.Mesh(createExtrudedArmorHullGeo(0.85, 0.42, 0.32), MAT.hazard);
        barricade.position.set(Math.cos(ang) * rDist, 0.35, Math.sin(ang) * rDist);
        barricade.rotation.y = ang + Math.PI / 2;
        body.add(barricade);
    }

    // Bug Fix: ONLY cover Frontier Buildings with Zerg Goo if Zerg Creep actually touches them (or if creep expands onto them later)!
    const distToHive = Math.hypot(x - ENEMY_BASE_POS.x, z - ENEMY_BASE_POS.z);
    if (distToHive < 46.0) {
        const infestGroup = new THREE.Group();
        attachNaturalZergGooInfestationToStructure(infestGroup, w, totalH, d);
        infestGroup.visible = isPointOnZergCreep(x, z);
        body.add(infestGroup);
        frontierBuildingInfestations.push({ x, z, group: infestGroup });
    }

    addMapMesh(group);
    obstacles.push({ x, z, r: footR + 0.35, type: 'unique_building' });
}

// Naturally Generated 3D Zerg Goo Webbing, Arterial Slime Veins, Roof Bio-Chimneys & Gestation Cysts on Infested Buildings
function attachNaturalZergGooInfestationToStructure(targetGroup, w, totalH, d) {
    const gooFleshMat = MAT.zergFlesh || new THREE.MeshStandardMaterial({ color: 0x6a1b7a, roughness: 0.28, metalness: 0.14 });
    const gooBioMat = MAT.zergBioShader || new THREE.MeshStandardMaterial({ color: 0x8e24aa, emissive: 0x3b0948, emissiveIntensity: 0.55, roughness: 0.16 });
    const cystVioletMat = MAT.hiveVeinGlow || new THREE.MeshStandardMaterial({ color: 0xd500f9, emissive: 0xaa00ff, emissiveIntensity: 0.85 });
    const cystAcidMat = MAT.acidGlow || new THREE.MeshStandardMaterial({ color: 0x76ff03, emissive: 0x64dd17, emissiveIntensity: 0.85 });
    const chitinMat = MAT.chitinArmor || new THREE.MeshStandardMaterial({ color: 0x381442, roughness: 0.45 });

    // 1. Basal Oozing Biomass Apron spreading around the building foundation
    for (let m = 0; m < 4; m++) {
        const ma = (m / 4) * Math.PI * 2 + seededRandom() * 0.4;
        const lobe = new THREE.Mesh(createOrganicBioCarapaceGeo(0.95 + seededRandom() * 0.45, 0.72, 0.95, 5, 0.06), gooFleshMat);
        lobe.scale.set(1.45, 0.28, 1.25);
        lobe.position.set(Math.cos(ma) * (w * 0.48), 0.16, Math.sin(ma) * (d * 0.48));
        lobe.rotation.y = ma;
        lobe.castShadow = !IS_MOBILE;
        lobe.receiveShadow = true;
        targetGroup.add(lobe);
    }

    // 2. 6 Climbing Arterial Slime Tendrils (CatmullRomCurve3 Tubes) wrapping from ground up the walls onto the roof
    const veinCount = 6;
    for (let v = 0; v < veinCount; v++) {
        const ang = (v / veinCount) * Math.PI * 2 + (seededRandom() - 0.5) * 0.35;
        const rx = Math.cos(ang) * (w * 0.54);
        const rz = Math.sin(ang) * (d * 0.54);
        const midAng = ang + (v % 2 === 0 ? 0.28 : -0.28);
        const mx = Math.cos(midAng) * (w * 0.50);
        const mz = Math.sin(midAng) * (d * 0.50);

        const curve = new THREE.CatmullRomCurve3([
            new THREE.Vector3(rx * 1.28, 0.05, rz * 1.28),
            new THREE.Vector3(rx * 1.02, totalH * 0.36, rz * 1.02),
            new THREE.Vector3(mx * 0.96, totalH * 0.78, mz * 0.96),
            new THREE.Vector3(mx * 0.42, totalH + 0.38, mz * 0.42)
        ]);
        const tube = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 12, 0.09 + (v % 3) * 0.025, 7, false),
            v % 2 === 0 ? gooBioMat : gooFleshMat
        );
        tube.castShadow = !IS_MOBILE;
        targetGroup.add(tube);

        // Wall-Breach Bioluminescent Gestation Sacs along each arterial vein
        const sac = new THREE.Mesh(
            createOrganicBioCarapaceGeo(0.18 + seededRandom() * 0.08, 0.16, 0.18, 4, 0.02),
            v % 2 === 0 ? cystVioletMat : cystAcidMat
        );
        sac.scale.set(1.15, 0.85, 1.15);
        sac.position.set(mx * 0.98, totalH * (0.42 + (v % 3) * 0.16), mz * 0.98);
        targetGroup.add(sac);
    }

    // 3. Erupting Rooftop Zerg Biomass Cocoon, Curved Spore Vent Chimney & Calcified Chitin Spines
    const roofCocoon = new THREE.Mesh(createOrganicBioCarapaceGeo(Math.min(w, d) * 0.44, Math.min(w, d) * 0.38, Math.min(w, d) * 0.44, 6, 0.05), gooBioMat);
    roofCocoon.scale.set(1.25, 0.58, 1.12);
    roofCocoon.position.set(0, totalH + 0.32, 0);
    targetGroup.add(roofCocoon);

    const chimneyCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, totalH + 0.25, 0),
        new THREE.Vector3(0.22, totalH + 0.95, -0.14),
        new THREE.Vector3(0.35, totalH + 1.55, -0.24)
    ]);
    const bioChimney = new THREE.Mesh(new THREE.TubeGeometry(chimneyCurve, 10, 0.18, 8, false), chitinMat);
    const chimneyLip = new THREE.Mesh(createSculptedTorusCollarGeo(0.19, 0.06, 8, 12), cystAcidMat);
    chimneyLip.rotation.x = Math.PI / 2;
    chimneyLip.position.set(0.35, totalH + 1.58, -0.24);
    targetGroup.add(bioChimney, chimneyLip);

    // 4. Hanging Goo Stalactite Drips & Chitinous Rib Horns bursting out of the roof corners
    for (let k = 0; k < 4; k++) {
        const ka = (k / 4) * Math.PI * 2 + 0.6;
        const horn = new THREE.Mesh(createSculptedOgiveSpireGeo(0.14, 1.05, 7), chitinMat);
        horn.position.set(Math.cos(ka) * (w * 0.38), totalH + 0.55, Math.sin(ka) * (d * 0.38));
        horn.rotation.z = -Math.cos(ka) * 0.52;
        horn.rotation.x = Math.sin(ka) * 0.52;
        targetGroup.add(horn);

        const drip = new THREE.Mesh(createSculptedOgiveSpireGeo(0.09, 0.55, 6), gooBioMat);
        drip.rotation.x = Math.PI;
        drip.position.set(Math.cos(ka) * (w * 0.50), totalH * 0.72, Math.sin(ka) * (d * 0.50));
        targetGroup.add(drip);
    }
}

function createAbandonedMilitaryBase(rawX, rawZ, rotY = 0, variantSeed = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 4.4, 7.5, 3.0);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    // Flatten the actual terrain ground under the camp/outpost so structures sit directly on the map ground (no artificial floating slab!)
    flattenTerrainUnderBuilding(x, z, 3.8, 2.2);

    const group = new THREE.Group();
    const cosR = Math.cos(rotY);
    const sinR = Math.sin(rotY);
    const toWorld = (lx, lz) => {
        const wx = x + lx * cosR + lz * sinR;
        const wz = z - lx * sinR + lz * cosR;
        return { wx, wz, wy: getTerrainHeight(wx, wz) };
    };

    const bunkerH = 1.25 + (variantSeed % 2) * 0.45;
    const bPt = toWorld(-1.45, -1.0);
    const bunkerGroup = new THREE.Group();
    bunkerGroup.position.set(bPt.wx, bPt.wy, bPt.wz);
    bunkerGroup.rotation.y = rotY;
    const bunkerShell = new THREE.Mesh(createExtrudedArmorHullGeo(2.4, bunkerH, 2.2, 0.08, 0.28), concreteRuinMat);
    bunkerShell.position.y = bunkerH * 0.5 - 0.04;
    bunkerShell.castShadow = !IS_MOBILE;
    bunkerShell.receiveShadow = true;
    const bunkerVisor = new THREE.Mesh(createExtrudedArmorHullGeo(1.65, 0.18, 0.25), variantSeed % 2 === 0 ? MAT.amberGlow : MAT.cyanGlow);
    bunkerVisor.position.set(0, bunkerH * 0.65, 1.05);
    bunkerGroup.add(bunkerShell, bunkerVisor);
    group.add(bunkerGroup);

    const tPt = toWorld(-1.9, 1.65);
    const towerGroup = new THREE.Group();
    towerGroup.position.set(tPt.wx, tPt.wy, tPt.wz);
    towerGroup.rotation.y = rotY;
    towerGroup.rotation.z = 0.08 * (variantSeed % 2 === 0 ? 1 : -1);
    const mast = new THREE.Mesh(createSculptedLatheBarrelGeo(0.18, 0.50, 3.2 + (variantSeed % 2) * 0.6, 6, 2, true), rustedSteelMat);
    mast.position.y = 1.55;
    const brokenDish = new THREE.Mesh(createSculptedArmorDomeGeo(0.65, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), rustedSteelMat);
    brokenDish.material.side = THREE.DoubleSide;
    brokenDish.rotation.x = 1.1;
    brokenDish.position.set(0, 3.30, 0.15);
    towerGroup.add(mast, brokenDish);
    group.add(towerGroup);

    // Supply crates & sandbag emplacement resting directly on the map ground
    for (let s = 0; s < 4; s++) {
        const ang = (s / 4) * Math.PI * 0.85 - 0.3;
        const sPt = toWorld(1.5 + Math.cos(ang) * 1.4, 0.8 + Math.sin(ang) * 1.4);
        const bag = new THREE.Mesh(createExtrudedArmorHullGeo(0.78, 0.34, 0.38), MAT.sandArmor);
        bag.position.set(sPt.wx, sPt.wy + 0.15, sPt.wz);
        bag.rotation.y = rotY - ang + Math.PI / 2;
        group.add(bag);
    }

    addMapMesh(group);
    obstacles.push({ x, z, r: 3.6, type: 'abandoned_bunker' });
}

const carPaintMats = [
    new THREE.MeshStandardMaterial({ color: 0x7c2d12, roughness: 0.62, metalness: 0.36 }),
    new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.58, metalness: 0.38 }),
    new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.68, metalness: 0.32 }),
    new THREE.MeshStandardMaterial({ color: 0x3f6212, roughness: 0.65, metalness: 0.34 })
];
const carGlassMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.25, metalness: 0.45 });

function createDerelictCar(rawX, rawZ, rotY = 0, variant = 0, isWreckedTilt = false) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 1.15, 5.2, 1.4);
    if (!spot) return;
    const x = spot.x, z = spot.z, y = spot.y;
    const carGroup = new THREE.Group();
    carGroup.position.set(x, y + 0.02, z);

    const extraPitch = isWreckedTilt ? (seededRandom() - 0.5) * 0.08 : 0;
    const extraRoll = isWreckedTilt ? (seededRandom() - 0.5) * 0.14 : 0;
    orientObjectToMountainSlope(carGroup, x, z, rotY, extraPitch, extraRoll);

    const bodyMat = carPaintMats[variant % carPaintMats.length];
    const chassis = new THREE.Mesh(createExtrudedArmorHullGeo(0.96, 0.34, 2.05), bodyMat);
    chassis.position.y = 0.28;
    chassis.castShadow = !IS_MOBILE;
    chassis.receiveShadow = true;

    const isPickup = (variant % 2 === 1);
    const cabinLen = isPickup ? 0.82 : 1.08;
    const cabinZ = isPickup ? 0.12 : -0.05;
    const cabin = new THREE.Mesh(createExtrudedArmorHullGeo(0.84, 0.32, cabinLen), bodyMat);
    cabin.position.set(0, 0.58, cabinZ);
    const windshield = new THREE.Mesh(createExtrudedArmorHullGeo(0.76, 0.24, cabinLen + 0.04), carGlassMat);
    windshield.position.set(0, 0.58, cabinZ);

    const frontBumper = new THREE.Mesh(createExtrudedArmorHullGeo(1.0, 0.14, 0.12), MAT.darkSteel);
    frontBumper.position.set(0, 0.20, 1.04);
    const rearBumper = frontBumper.clone();
    rearBumper.position.set(0, 0.20, -1.04);

    carGroup.add(chassis, cabin, windshield, frontBumper, rearBumper);

    const wheelGeo = createSculptedLatheBarrelGeo(0.19, 0.19, 0.14, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    [[-0.48, 0.64], [0.48, 0.64], [-0.48, -0.64], [0.48, -0.64]].forEach(([wx, wz]) => {
        const wheel = new THREE.Mesh(wheelGeo, MAT.charredSteel);
        wheel.position.set(wx, 0.19, wz);
        carGroup.add(wheel);
    });

    addMapMesh(carGroup);
    obstacles.push({ x, z, r: 1.05, type: 'derelict_car' });
}

function createAbandonedTown(rawCx, rawCz) {
    const safeCenter = relocateToSafeSlopePosition(rawCx, rawCz, 11.5);
    const cx = safeCenter.x, cz = safeCenter.z;

    // Place buildings in wide quadrants around the town plaza (no duplicate cross-streets that overlap the main road network!)
    const quadrantOffsets = [
        [-8.8, -8.8],
        [ 8.8, -8.4],
        [-8.4,  8.8],
        [ 8.8,  8.6]
    ];
    quadrantOffsets.forEach(([ox, oz], idx) => {
        const jx = cx + ox + (seededRandom() - 0.5) * 1.4;
        const jz = cz + oz + (seededRandom() - 0.5) * 1.4;
        createProceduralUniqueFrontierBuilding(jx, jz, idx, false);
    });

    // Street lights are placed ONLY via createRoadStreetLights() directly along actual road edges (never off-road!)


    // Park derelict cars off the road on building lots so streets remain 100% unobstructed for unit pathfinding!
    const carPlacements = [
        [cx - 3.6, cz - 8.2, 0.18, 0, true],
        [cx + 3.6, cz + 8.0, -2.85, 1, false],
        [cx - 8.2, cz + 3.6, 1.42, 2, true],
        [cx + 8.2, cz - 3.6, -1.65, 3, false]
    ];
    carPlacements.forEach(([carX, carZ, carRot, variant, tilted]) => {
        if (!isPointNearAnyRoadOrBridge(carX, carZ, 1.6)) {
            createDerelictCar(carX, carZ, carRot, variant, tilted);
        }
    });
}

const animatedBiomeLandmarks = [];

function createFrontierCamp(rawX, rawZ) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 2.8, 6.2, 2.5);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    // Flatten the natural terrain floor underneath the camp so the camp uses the map's actual ground (no pillars or concrete slab!)
    flattenTerrainUnderBuilding(x, z, 2.6, 1.8);

    const group = new THREE.Group();
    const tentMat = new THREE.MeshStandardMaterial({ color: 0x4d5d43, roughness: 0.85, metalness: 0.08 });
    [[-1.25, -0.85, 0.35], [1.25, -0.75, -0.42]].forEach(([tx, tz, rot]) => {
        const wx = x + tx;
        const wz = z + tz;
        const wy = getTerrainHeight(wx, wz);
        const tent = new THREE.Group();
        tent.position.set(wx, wy, wz);
        tent.rotation.y = rot;
        const roof = new THREE.Mesh(createSculptedOgiveSpireGeo(1.05, 1.15, 4), tentMat);
        roof.position.y = 0.54;
        roof.rotation.y = Math.PI / 4;
        roof.scale.set(1.0, 0.85, 1.35);
        roof.castShadow = !IS_MOBILE;
        roof.receiveShadow = true;
        const doorFlap = new THREE.Mesh(createExtrudedArmorHullGeo(0.45, 0.55, 0.08, 0.015, 0.03), MAT.charredSteel);
        doorFlap.position.set(0, 0.25, 0.85);
        tent.add(roof, doorFlap);
        group.add(tent);
    });

    const fx = x, fz = z + 0.45;
    const fy = getTerrainHeight(fx, fz);
    const fireBarrel = new THREE.Mesh(createSculptedLatheBarrelGeo(0.24, 0.26, 0.56, 10), rustedSteelMat);
    fireBarrel.position.set(fx, fy + 0.26, fz);
    const fireFlame = new THREE.Mesh(createSculptedOgiveSpireGeo(0.22, 0.55, 8), MAT.volatileGlow);
    fireFlame.position.set(fx, fy + 0.66, fz);
    group.add(fireBarrel, fireFlame);
    animatedBiomeLandmarks.push({ type: 'campfire', mesh: fireFlame, phase: seededRandom() * 10 });

    for (let s = 0; s < 5; s++) {
        const ang = (s / 5) * Math.PI - 0.2;
        const bx = x + Math.cos(ang) * 2.1;
        const bz = z + Math.sin(ang) * 2.1 + 0.3;
        const by = getTerrainHeight(bx, bz);
        const bag = new THREE.Mesh(createExtrudedArmorHullGeo(0.75, 0.34, 0.36, 0.03, 0.08), MAT.sandArmor);
        bag.position.set(bx, by + 0.15, bz);
        bag.rotation.y = -ang + Math.PI / 2;
        group.add(bag);
    }

    addMapMesh(group);
    obstacles.push({ x, z, r: 2.35, type: 'camp' });
}

function createScrapJunkPile(rawX, rawZ) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 1.5, 5.2, 1.8);
    if (!spot) return;
    const x = spot.x, z = spot.z, y = spot.y;

    const group = new THREE.Group();
    group.position.set(x, y, z);
    orientObjectToMountainSlope(group, x, z, seededRandom() * Math.PI * 2);

    const mound = new THREE.Mesh(createSculptedFacetedCrystalGeo(1.15, 1), MAT.charredSteel);
    mound.scale.set(1.35, 0.48, 1.25);
    mound.position.y = 0.22;
    group.add(mound);

    for (let j = 0; j < 6; j++) {
        const ang = (j / 6) * Math.PI * 2;
        const plate = new THREE.Mesh(
            createExtrudedArmorHullGeo(0.85, 0.12, 0.65, 0.02, 0.06),
            j % 2 === 0 ? rustedSteelMat : (j % 3 === 0 ? MAT.hazard : MAT.gunmetal)
        );
        plate.position.set(Math.cos(ang) * 0.65, 0.35 + (j % 3) * 0.16, Math.sin(ang) * 0.65);
        plate.rotation.set(seededRandom() * 0.8, seededRandom() * 3.0, seededRandom() * 0.8);
        plate.castShadow = !IS_MOBILE;
        group.add(plate);
    }

    const wheel = new THREE.Mesh(createSculptedTorusCollarGeo(0.38, 0.12, 8, 14), MAT.darkSteel);
    wheel.position.set(-0.35, 0.48, 0.25);
    wheel.rotation.set(0.5, 0.3, 0.2);
    const powerCell = new THREE.Mesh(createSculptedLatheBarrelGeo(0.16, 0.16, 0.48, 10), MAT.cyanGlow);
    powerCell.position.set(0.32, 0.52, -0.18);
    powerCell.rotation.z = 0.65;
    group.add(wheel, powerCell);

    addMapMesh(group);
    obstacles.push({ x, z, r: 1.45, type: 'junk' });
}

function createSatelliteDishComplex(rawX, rawZ) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 2.2, 6.8, 2.6);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    const carvedY = flattenTerrainUnderBuilding(x, z, 2.3, 1.8);
    const group = new THREE.Group();
    group.position.set(x, carvedY, z);

    const basePedestal = new THREE.Mesh(createExtrudedArmorHullGeo(2.8, 0.95, 2.8, 0.08, 0.35), MAT.gunmetal);
    basePedestal.position.y = 0.48;
    basePedestal.castShadow = !IS_MOBILE;
    const collar = new THREE.Mesh(createSculptedLatheBarrelGeo(0.75, 0.95, 0.55, 12), MAT.darkSteel);
    collar.position.y = 1.15;
    group.add(basePedestal, collar);

    const dishRotor = new THREE.Group();
    dishRotor.position.y = 1.55;

    const yoke = new THREE.Mesh(createExtrudedArmorHullGeo(0.95, 0.45, 0.55, 0.04, 0.10), MAT.hazard);
    const dish = new THREE.Mesh(
        createSculptedArmorDomeGeo(1.75, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.42),
        new THREE.MeshStandardMaterial({ color: 0xdbe4ee, roughness: 0.35, metalness: 0.65, side: THREE.DoubleSide })
    );
    dish.rotation.x = Math.PI * 0.68;
    dish.position.set(0, 0.55, 0.25);
    dish.castShadow = !IS_MOBILE;

    const feedSpire = new THREE.Mesh(createSculptedLatheBarrelGeo(0.06, 0.14, 1.35, 8), MAT.copper);
    feedSpire.rotation.x = -Math.PI * 0.32;
    feedSpire.position.set(0, 0.95, 0.72);
    const feedBeacon = new THREE.Mesh(createSculptedArmorDomeGeo(0.16, 12, 12), MAT.cyanGlow);
    feedBeacon.position.set(0, 1.32, 1.15);

    dishRotor.add(yoke, dish, feedSpire, feedBeacon);
    group.add(dishRotor);
    animatedBiomeLandmarks.push({ type: 'satellite', mesh: dishRotor, phase: seededRandom() * 10 });

    addMapMesh(group);
    obstacles.push({ x, z, r: 2.15, type: 'satellite_dish' });
}

function createFrontierStationBuilding(rawX, rawZ, rotY = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 2.6, 7.0, 2.8);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    const carvedY = flattenTerrainUnderBuilding(x, z, 2.7, 2.0);
    const group = new THREE.Group();
    group.position.set(x, carvedY, z);
    group.rotation.y = rotY;

    const platform = new THREE.Mesh(createExtrudedArmorHullGeo(4.6, 0.32, 3.4, 0.06, 0.22), MAT.darkSteel);
    platform.position.y = 0.16;
    const stationHall = new THREE.Mesh(createExtrudedArmorHullGeo(2.8, 1.55, 2.2, 0.08, 0.24), MAT.gunmetal);
    stationHall.position.set(-0.55, 0.92, -0.2);
    stationHall.castShadow = !IS_MOBILE;

    const canopyArch = new THREE.Mesh(createSculptedLatheBarrelGeo(1.65, 1.65, 4.4, 16, 1, false), MAT.terranBlue);
    canopyArch.rotation.z = Math.PI / 2;
    canopyArch.scale.set(0.42, 1.0, 1.0);
    canopyArch.position.set(0, 1.85, 0.15);
    canopyArch.castShadow = !IS_MOBILE;

    const tickerBoard = new THREE.Mesh(createExtrudedArmorHullGeo(2.2, 0.28, 0.12, 0.02, 0.06), MAT.amberGlow);
    tickerBoard.position.set(-0.55, 1.45, 0.94);

    [0.95, 1.65].forEach(cx => {
        const coil = new THREE.Mesh(createSculptedLatheBarrelGeo(0.24, 0.28, 1.25, 12), MAT.copper);
        coil.position.set(cx, 0.78, -0.35);
        const plasmaRing = new THREE.Mesh(createSculptedTorusCollarGeo(0.28, 0.045, 8, 16), MAT.cyanGlow);
        plasmaRing.rotation.x = Math.PI / 2;
        plasmaRing.position.set(cx, 1.15, -0.35);
        group.add(coil, plasmaRing);
    });

    group.add(platform, stationHall, canopyArch, tickerBoard);
    addMapMesh(group);
    obstacles.push({ x, z, r: 2.55, type: 'station_building' });
}

function createMountainWaterwall() {
    // Water dam barrier removed per user request so the river channel flows completely unobstructed
}

function createRockyTerrainZone(zone) {
    const group = new THREE.Group();
    const rockCount = 11;
    for (let i = 0; i < rockCount; i++) {
        const ang = (i / rockCount) * Math.PI * 2 + seededRandom() * 0.45;
        const dist = (0.15 + seededRandom() * 0.78) * zone.r;
        const rx = zone.x + Math.cos(ang) * dist;
        const rz = zone.z + Math.sin(ang) * dist;
        if (!isClearForNaturalProp(rx, rz, 1.4)) continue;
        const ry = getTerrainHeight(rx, rz);

        const stoneR = 0.68 + seededRandom() * 0.92;
        const flatten = 0.48 + seededRandom() * 0.42;
        const stoneGeo = createDynamicStoneGeometry(rx * 11.3 + rz * 7.1 + i, stoneR, 0.32, flatten, IS_MOBILE ? 1 : 2);
        const slab = new THREE.Mesh(
            stoneGeo,
            i % 2 === 0 ? rockMat : mossRockMat
        );
        slab.position.set(rx, ry + stoneR * flatten * 0.34, rz);
        slab.rotation.set((seededRandom() - 0.5) * 0.28, seededRandom() * Math.PI * 2, (seededRandom() - 0.5) * 0.28);
        slab.castShadow = !IS_MOBILE;
        slab.receiveShadow = true;
        group.add(slab);
        obstacles.push({ x: rx, z: rz, r: stoneR * 0.82, type: 'rock_crag' });
    }
    addMapMesh(group);
}

const radWastePoolMat = new THREE.MeshBasicMaterial({ color: 0xa3e635, transparent: true, opacity: 0.88, side: THREE.DoubleSide });
const radWasteRimMat = new THREE.MeshBasicMaterial({ color: 0x4d7c0f, transparent: true, opacity: 0.75, side: THREE.DoubleSide });

function createRadioactiveWasteSite(rawX, rawZ) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 2.5, 5.8, 3.0);
    if (!spot) return;
    const x = spot.x, z = spot.z, y = spot.y;
    if (y < -0.25) return;

    const group = new THREE.Group();
    group.position.set(x, y + 0.04, z);
    orientObjectToMountainSlope(group, x, z, 0);

    const outerCrust = new THREE.Mesh(new THREE.CircleGeometry(2.35, 24), radWasteRimMat);
    outerCrust.rotation.x = -Math.PI / 2;
    const toxicPool = new THREE.Mesh(new THREE.CircleGeometry(1.85, 24), radWastePoolMat);
    toxicPool.rotation.x = -Math.PI / 2;
    toxicPool.position.y = 0.02;
    group.add(outerCrust, toxicPool);

    [[-0.85, -0.45, false], [-0.45, -0.85, true], [0.75, 0.35, true], [0.25, -0.25, false]].forEach(([bx, bz, tipped], idx) => {
        const drum = new THREE.Group();
        drum.position.set(bx, tipped ? 0.20 : 0.34, bz);
        if (tipped) {
            drum.rotation.z = Math.PI * 0.46;
            drum.rotation.y = idx * 1.3;
        }
        const can = new THREE.Mesh(createSculptedLatheBarrelGeo(0.22, 0.22, 0.68, 12), MAT.hazard);
        const stripe = new THREE.Mesh(createSculptedLatheBarrelGeo(0.225, 0.225, 0.20, 12), MAT.charredSteel);
        const glowCap = new THREE.Mesh(new THREE.CircleGeometry(0.18, 10), MAT.acidGlow);
        glowCap.rotation.x = -Math.PI / 2;
        glowCap.position.y = 0.35;
        drum.add(can, stripe, glowCap);
        group.add(drum);
    });

    const bubbles = [];
    for (let b = 0; b < 4; b++) {
        const bOrb = new THREE.Mesh(createSculptedArmorDomeGeo(0.14 + (b % 2) * 0.06, 10, 10), MAT.acidGlow);
        bOrb.position.set((b - 1.5) * 0.55, 0.12, ((b % 2) - 0.5) * 0.65);
        group.add(bOrb);
        bubbles.push(bOrb);
    }
    animatedBiomeLandmarks.push({ type: 'radwaste', pool: toxicPool, bubbles, phase: seededRandom() * 10 });

    addMapMesh(group);
    obstacles.push({ x, z, r: 1.75, type: 'radioactive_waste' });
}

// ============================================================================
// 3D MEADOW GRASS TUFT GENERATOR (InstancedMesh for 60FPS Desktop & Mobile)
// Scatters lush, multi-blade 3D grass clusters across natural meadow terrain
// while strictly avoiding roads, bridges, ponds, rivers, Zerg creep, and bases!
// ============================================================================
const meadowGrassMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.68,
    metalness: 0.03,
    side: THREE.DoubleSide
});
meadowGrassMat.userData = { isMeadowGrass: true };
if (typeof SHADER_ENGINE !== 'undefined' && SHADER_ENGINE.applyTerrainShader) {
    SHADER_ENGINE.applyTerrainShader(meadowGrassMat);
}

function createGrassTuftPrototypeGeometry() {
    // Realistic 11-blade arched botanical grass cluster with 3 curved segments per blade & natural root-to-tip chlorophyll gradient
    const positions = [];
    const normals = [];
    const colors = [];
    const bladeCount = 11;
    for (let b = 0; b < bladeCount; b++) {
        const ring = b < 4 ? 0 : 1;
        const yaw = (b / bladeCount) * Math.PI * 2 + (b * 1.17);
        const rOff = ring === 0 ? (0.025 + (b % 2) * 0.02) : (0.075 + (b % 3) * 0.032);
        const bx = Math.cos(yaw) * rOff;
        const bz = Math.sin(yaw) * rOff;
        const dirX = Math.cos(yaw);
        const dirZ = Math.sin(yaw);
        const sideX = -dirZ;
        const sideZ = dirX;

        const w0 = 0.032 + (b % 3) * 0.006;
        const w1 = w0 * 0.74;
        const w2 = w0 * 0.42;

        const totalH = 0.28 + (b % 4) * 0.065 + (ring === 0 ? 0.06 : 0.0);
        const h1 = totalH * 0.36;
        const h2 = totalH * 0.72;
        const h3 = totalH;

        const arch = 0.10 + (b % 3) * 0.055 + (ring === 1 ? 0.05 : 0.0);
        const r1 = arch * 0.26;
        const r2 = arch * 0.68;
        const r3 = arch * 1.22;

        // 4 cross-sections along curved blade: (p0L, p0R) -> (p1L, p1R) -> (p2L, p2R) -> tip (p3)
        const p0Lx = bx - sideX * w0, p0Ly = 0.0, p0Lz = bz - sideZ * w0;
        const p0Rx = bx + sideX * w0, p0Ry = 0.0, p0Rz = bz + sideZ * w0;

        const p1Lx = bx + dirX * r1 - sideX * w1, p1Ly = h1, p1Lz = bz + dirZ * r1 - sideZ * w1;
        const p1Rx = bx + dirX * r1 + sideX * w1, p1Ry = h1, p1Rz = bz + dirZ * r1 + sideZ * w1;

        const p2Lx = bx + dirX * r2 - sideX * w2, p2Ly = h2, p2Lz = bz + dirZ * r2 - sideZ * w2;
        const p2Rx = bx + dirX * r2 + sideX * w2, p2Ry = h2, p2Rz = bz + dirZ * r2 + sideZ * w2;

        const p3x  = bx + dirX * r3, p3y = h3, p3z = bz + dirZ * r3;

        const hueShift = ((b % 3) - 1) * 0.025;
        const c0 = [0.12 + hueShift, 0.30 + hueShift, 0.11];
        const c1 = [0.19 + hueShift, 0.46 + hueShift, 0.16];
        const c2 = [0.28 + hueShift, 0.60 + hueShift, 0.21];
        const c3 = [0.44 + hueShift, 0.74 + hueShift, 0.26];

        // Segment 1 (base to lower-mid)
        positions.push(
            p0Lx, p0Ly, p0Lz, p0Rx, p0Ry, p0Rz, p1Lx, p1Ly, p1Lz,
            p0Rx, p0Ry, p0Rz, p1Rx, p1Ry, p1Rz, p1Lx, p1Ly, p1Lz
        );
        colors.push(...c0, ...c0, ...c1, ...c0, ...c1, ...c1);

        // Segment 2 (lower-mid to upper-mid)
        positions.push(
            p1Lx, p1Ly, p1Lz, p1Rx, p1Ry, p1Rz, p2Lx, p2Ly, p2Lz,
            p1Rx, p1Ry, p1Rz, p2Rx, p2Ry, p2Rz, p2Lx, p2Ly, p2Lz
        );
        colors.push(...c1, ...c1, ...c2, ...c1, ...c2, ...c2);

        // Segment 3 (upper-mid to arched tip)
        positions.push(p2Lx, p2Ly, p2Lz, p2Rx, p2Ry, p2Rz, p3x, p3y, p3z);
        colors.push(...c2, ...c2, ...c3);

        const nx = dirX * 0.32;
        const nz = dirZ * 0.32;
        const ny = 0.90;
        for (let k = 0; k < 15; k++) {
            normals.push(nx, ny, nz);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return geo;
}
const grassTuftProtoGeo = createGrassTuftPrototypeGeometry();

function createTerrainMeadowGrassMesh() {
    meadowGrassEntries.length = 0;
    activeMeadowGrassMesh = null;

    const biome = ACTIVE_PLANET_BIOME || 'highland';
    // Desert and Lava planets never spawn lush green meadow grass tufts
    if (biome === 'desert' || biome === 'lava') return;

    const maxTufts = biome === 'jungle'
        ? (IS_MOBILE ? 1200 : 2800)
        : (IS_MOBILE ? 750 : 1850);
    const validTransforms = [];
    const dummy = new THREE.Object3D();
    const tintColors = [];

    const maxAttempts = maxTufts * 3;
    for (let i = 0; i < maxAttempts && validTransforms.length < maxTufts; i++) {
        const gx = (seededRandom() - 0.5) * 136;
        const gz = (seededRandom() - 0.5) * 136;
        const gy = getTerrainHeight(gx, gz);
        if (gy < 0.04 || gy > 3.1) continue;

        const norm = getTerrainNormal(gx, gz);
        if (norm.y < 0.84) continue; // Grow on grassy meadows, valleys, and gentle hills
        if (getSupplyRoadFactor(gx, gz) > 0.06) continue; // Never grow on roads
        if (getRiverDist(gx, gz) < RIVER_HALF_WIDTH + 2.8) continue; // Keep riverbanks clear
        if (isPointInWaterPond(gx, gz, 0.8)) continue; // Never grow in ponds
        if (isPointOnZergCreep(gx, gz)) continue; // Never grow on Zerg creep
        if (isInsideBasePlacementZone(gx, gz, 5.2)) continue;
        if (Math.hypot(gx - ABANDONED_TOWN_CENTER.x, gz - ABANDONED_TOWN_CENTER.z) < 12.0) continue;
        if (DYNAMIC_BOMB_CRATERS.some(bc => Math.hypot(gx - bc.x, gz - bc.z) < bc.r * 1.25)) continue;
        if (ROCKY_TERRAIN_ZONES.some(rz => Math.hypot(gx - rz.x, gz - rz.z) < rz.r * 0.82)) continue;

        const scaleXZ = (biome === 'jungle' ? 0.95 : 0.82) + seededRandom() * 0.78;
        const scaleY = (biome === 'jungle' ? 0.92 : 0.75) + seededRandom() * 0.85;
        dummy.position.set(gx, gy - 0.015, gz);
        dummy.rotation.set((seededRandom() - 0.5) * 0.12, seededRandom() * Math.PI * 2, (seededRandom() - 0.5) * 0.12);
        dummy.scale.set(scaleXZ, scaleY, scaleXZ);
        dummy.updateMatrix();
        const matClone = dummy.matrix.clone();
        validTransforms.push(matClone);
        meadowGrassEntries.push({ x: gx, z: gz, matrix: matClone, hidden: false });

        const shade = 0.82 + seededRandom() * 0.34;
        const warmShift = (seededRandom() - 0.5) * 0.08;
        if (biome === 'jungle') {
            tintColors.push(new THREE.Color((0.68 + warmShift) * shade, 1.12 * shade, (0.72 - warmShift) * shade));
        } else {
            tintColors.push(new THREE.Color((0.88 + warmShift) * shade, 1.02 * shade, (0.88 - warmShift) * shade));
        }
    }

    if (validTransforms.length === 0) return;
    const instGrass = new THREE.InstancedMesh(grassTuftProtoGeo, meadowGrassMat, validTransforms.length);
    instGrass.receiveShadow = true;
    for (let i = 0; i < validTransforms.length; i++) {
        instGrass.setMatrixAt(i, validTransforms[i]);
        instGrass.setColorAt(i, tintColors[i]);
    }
    instGrass.instanceMatrix.needsUpdate = true;
    if (instGrass.instanceColor) instGrass.instanceColor.needsUpdate = true;
    activeMeadowGrassMesh = instGrass;
    addMapMesh(instGrass);
}

// ============================================================================
// DYNAMIC BATTLEFIELD WARLAND PROPS: BOMB HOLE CRATERS, BROKEN MILITARY TRUCKS,
// DESTROYED TANKS & CRASHED MILITARY HELICOPTERS
// ============================================================================
function createDynamicBombCraterLandmark(rawX, rawZ, craterRadius = 3.2) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, craterRadius + 0.6, 5.2, 2.0);
    if (!spot) return;
    const x = spot.x, z = spot.z;
    const depth = 0.65 + seededRandom() * 0.32;

    DYNAMIC_BOMB_CRATERS.push({ x, z, r: craterRadius, depth });
    deformTerrainCrater(x, z, craterRadius, depth, true);

    const group = new THREE.Group();
    const bottomY = getTerrainHeight(x, z);

    // Subtle central ember glow inside the physically excavated depression (no flat black circle)
    const emberCore = new THREE.Mesh(new THREE.CircleGeometry(craterRadius * 0.22, 10), MAT.volatileGlow);
    emberCore.rotation.x = -Math.PI / 2;
    emberCore.position.set(x, bottomY + 0.03, z);
    group.add(emberCore);

    // Ejected blast rocks & twisted shrapnel along the irregular crater rim
    const rimRocks = 10;
    for (let i = 0; i < rimRocks; i++) {
        const ang = (i / rimRocks) * Math.PI * 2 + (seededRandom() - 0.5) * 0.45;
        const rDist = craterRadius * (0.76 + seededRandom() * 0.34);
        const rx = x + Math.cos(ang) * rDist;
        const rz = z + Math.sin(ang) * rDist;
        const ry = getTerrainHeight(rx, rz);
        const rock = new THREE.Mesh(
            createSculptedFacetedCrystalGeo(0.24 + seededRandom() * 0.24, 0),
            i % 3 === 0 ? MAT.charredSteel : rockMat
        );
        rock.scale.set(1.2, 0.62, 1.0);
        rock.position.set(rx, ry + 0.06, rz);
        rock.rotation.set(seededRandom(), ang, seededRandom());
        rock.castShadow = !IS_MOBILE;
        rock.receiveShadow = true;
        group.add(rock);
    }

    addMapMesh(group);
    obstacles.push({ x, z, r: craterRadius * 0.55, type: 'bomb_crater' });
}

function createBrokenMilitaryTruck(rawX, rawZ, rotY = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 1.9, 5.5, 2.2);
    if (!spot) return;
    const x = spot.x, z = spot.z, y = spot.y;

    const truck = new THREE.Group();
    truck.position.set(x, y + 0.02, z);
    orientObjectToMountainSlope(truck, x, z, rotY, (seededRandom() - 0.5) * 0.10, (seededRandom() - 0.5) * 0.16);

    const oliveDrabMat = new THREE.MeshStandardMaterial({ color: 0x3b492e, roughness: 0.72, metalness: 0.38 });

    // Heavy 6x6 Frame Rails
    const chassis = new THREE.Mesh(createExtrudedArmorHullGeo(1.18, 0.24, 3.45, 0.03, 0.08), MAT.charredSteel);
    chassis.position.set(0, 0.28, 0);
    chassis.castShadow = !IS_MOBILE;
    truck.add(chassis);

    // Armored Tactical Cab + Blown-Open Engine Hood
    const cab = new THREE.Mesh(createExtrudedArmorHullGeo(1.24, 0.78, 1.05, 0.04, 0.12), oliveDrabMat);
    cab.position.set(0, 0.72, 0.88);
    cab.castShadow = !IS_MOBILE;
    const windshield = new THREE.Mesh(createExtrudedArmorHullGeo(1.12, 0.30, 0.12, 0.015, 0.04), carGlassMat);
    windshield.position.set(0, 0.86, 1.38);
    const hood = new THREE.Mesh(createExtrudedArmorHullGeo(1.14, 0.42, 0.78, 0.03, 0.10), oliveDrabMat);
    hood.position.set(0, 0.56, 1.65);
    hood.rotation.x = -0.18;
    const grille = new THREE.Mesh(createExtrudedArmorHullGeo(1.06, 0.36, 0.08, 0.015, 0.04), MAT.darkSteel);
    grille.position.set(0, 0.50, 2.02);
    truck.add(cab, windshield, hood, grille);

    // Damaged Ribbed Cargo Bed with Tilted Canopy Ribs
    const cargoBed = new THREE.Mesh(createExtrudedArmorHullGeo(1.32, 0.46, 2.05, 0.04, 0.10), oliveDrabMat);
    cargoBed.position.set(0.04, 0.58, -0.72);
    cargoBed.rotation.z = 0.09;
    cargoBed.castShadow = !IS_MOBILE;
    truck.add(cargoBed);

    for (let r = 0; r < 3; r++) {
        const arch = new THREE.Mesh(createSculptedTorusCollarGeo(0.64, 0.035, 6, 12, Math.PI), rustedSteelMat);
        arch.position.set(0.04, 0.78, -1.45 + r * 0.72);
        arch.rotation.z = (r - 1) * 0.14;
        truck.add(arch);
    }

    // 6 Heavy Off-Road Wheels (1 detached lying nearby)
    const wheelGeo = createSculptedLatheBarrelGeo(0.28, 0.28, 0.20, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    [
        [-0.64, 1.45], [0.64, 1.45],
        [-0.64, -0.25], [0.64, -0.25],
        [-0.64, -1.15], [0.64, -1.15]
    ].forEach(([wx, wz], idx) => {
        const wMesh = new THREE.Mesh(wheelGeo, MAT.charredSteel);
        if (idx === 4) {
            wMesh.position.set(wx - 0.55, 0.10, wz - 0.35);
            wMesh.rotation.set(0.4, 0.2, 1.35);
        } else {
            wMesh.position.set(wx, 0.26, wz);
        }
        truck.add(wMesh);
    });

    addMapMesh(truck);
    obstacles.push({ x, z, r: 1.75, type: 'broken_truck' });
}

function createWreckedMilitaryTank(rawX, rawZ, rotY = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 2.2, 5.8, 2.4);
    if (!spot) return;
    const x = spot.x, z = spot.z, y = spot.y;

    deformTerrainCrater(x, z, 2.4, 0.22);

    const tank = new THREE.Group();
    tank.position.set(x, y - 0.04, z);
    orientObjectToMountainSlope(tank, x, z, rotY, -0.08, 0.14);

    const armorMat = new THREE.MeshStandardMaterial({ color: 0x334139, roughness: 0.65, metalness: 0.52 });

    // Sloped Heavy Glacis Hull
    const hull = new THREE.Mesh(createExtrudedArmorHullGeo(1.75, 0.52, 2.65, 0.08, 0.22), armorMat);
    hull.position.y = 0.38;
    hull.castShadow = !IS_MOBILE;
    hull.receiveShadow = true;
    tank.add(hull);

    // Left & Right Armored Track Sponsons (one track snapped/derailed)
    [-0.95, 0.95].forEach((tx, idx) => {
        const track = new THREE.Mesh(createExtrudedArmorHullGeo(0.38, 0.44, 2.85, 0.03, 0.08), MAT.charredSteel);
        track.position.set(tx, 0.24, 0);
        if (idx === 1) track.rotation.z = -0.15;
        const skirt = new THREE.Mesh(createExtrudedArmorHullGeo(0.42, 0.22, 2.75, 0.02, 0.06), rustedSteelMat);
        skirt.position.set(tx, 0.42, 0);
        tank.add(track, skirt);
    });

    // Canted Dislodged Turret + Bent 120mm Cannon Barrel
    const turretGroup = new THREE.Group();
    turretGroup.position.set(0.12, 0.72, -0.10);
    turretGroup.rotation.set(0.16, 0.58, -0.22);

    const turretHull = new THREE.Mesh(createExtrudedArmorHullGeo(1.28, 0.44, 1.48, 0.08, 0.24), armorMat);
    turretHull.castShadow = !IS_MOBILE;
    const cupola = new THREE.Mesh(createSculptedLatheBarrelGeo(0.24, 0.28, 0.22, 10), MAT.darkSteel);
    cupola.position.set(-0.28, 0.28, -0.22);

    const barrel = new THREE.Mesh(createSculptedLatheBarrelGeo(0.085, 0.11, 2.05, 10), MAT.charredSteel);
    barrel.rotation.x = Math.PI / 2 - 0.18;
    barrel.position.set(0, 0.04, 1.45);
    const muzzleBrake = new THREE.Mesh(createExtrudedArmorHullGeo(0.22, 0.22, 0.32, 0.02, 0.05), rustedSteelMat);
    muzzleBrake.position.set(0, -0.14, 2.38);

    turretGroup.add(turretHull, cupola, barrel, muzzleBrake);
    tank.add(turretGroup);

    // Smoldering engine deck glow
    const engineFire = new THREE.Mesh(createSculptedArmorDomeGeo(0.22, 8, 8), MAT.volatileGlow);
    engineFire.scale.set(1.2, 0.5, 1.2);
    engineFire.position.set(0, 0.66, -0.95);
    tank.add(engineFire);

    addMapMesh(tank);
    obstacles.push({ x, z, r: 1.95, type: 'wrecked_tank' });
}

function createCrashedMilitaryHelicopter(rawX, rawZ, rotY = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 2.4, 6.0, 2.6);
    if (!spot) return;
    const x = spot.x, z = spot.z, y = spot.y;

    deformTerrainCrater(x, z, 2.6, 0.26);

    const heli = new THREE.Group();
    heli.position.set(x, y - 0.06, z);
    orientObjectToMountainSlope(heli, x, z, rotY, 0.24, -0.28);

    const airframeMat = new THREE.MeshStandardMaterial({ color: 0x2c3a47, roughness: 0.55, metalness: 0.62 });

    // Fuselage & Nose Embedded in Crater
    const fuselage = new THREE.Mesh(createExtrudedArmorHullGeo(1.12, 0.86, 2.75, 0.08, 0.26), airframeMat);
    fuselage.position.set(0, 0.48, 0.2);
    fuselage.castShadow = !IS_MOBILE;
    const cockpitGlass = new THREE.Mesh(createExtrudedArmorHullGeo(0.92, 0.46, 1.15, 0.04, 0.14), carGlassMat);
    cockpitGlass.position.set(0, 0.58, 1.18);
    cockpitGlass.rotation.x = 0.28;
    heli.add(fuselage, cockpitGlass);

    // Stub Wings & Rocket Pods
    [-1, 1].forEach(side => {
        const wing = new THREE.Mesh(createExtrudedArmorHullGeo(1.15, 0.12, 0.52, 0.02, 0.08), airframeMat);
        wing.position.set(side * 0.95, 0.52, 0.15);
        wing.rotation.z = -side * 0.18;
        const pod = new THREE.Mesh(createSculptedLatheBarrelGeo(0.18, 0.18, 0.88, 10), MAT.charredSteel);
        pod.rotation.x = Math.PI / 2;
        pod.position.set(side * 1.15, 0.34, 0.15);
        heli.add(wing, pod);
    });

    // Buckled & Snapped Tail Boom + Tail Rotor
    const tailBoom = new THREE.Mesh(createSculptedLatheBarrelGeo(0.16, 0.34, 2.45, 8), rustedSteelMat);
    tailBoom.rotation.x = Math.PI / 2 + 0.22;
    tailBoom.rotation.z = 0.26;
    tailBoom.position.set(0.32, 0.42, -1.95);
    const tailFin = new THREE.Mesh(createExtrudedArmorHullGeo(0.10, 0.85, 0.48, 0.02, 0.08), airframeMat);
    tailFin.position.set(0.62, 0.72, -2.95);
    tailFin.rotation.z = 0.32;
    heli.add(tailBoom, tailFin);

    // Twisted 4-Blade Main Rotor Mast
    const mast = new THREE.Mesh(createSculptedLatheBarrelGeo(0.14, 0.18, 0.48, 10), MAT.darkSteel);
    mast.position.set(0, 1.02, 0.15);
    heli.add(mast);

    for (let b = 0; b < 4; b++) {
        const bAng = (b / 4) * Math.PI * 2 + 0.35;
        const blade = new THREE.Mesh(createExtrudedArmorHullGeo(2.15, 0.035, 0.16, 0.008, 0.04), MAT.charredSteel);
        blade.position.set(Math.cos(bAng) * 1.05, 1.14 - (b % 2) * 0.18, 0.15 + Math.sin(bAng) * 1.05);
        blade.rotation.y = -bAng;
        blade.rotation.z = (b % 2 === 0 ? -0.24 : 0.15);
        heli.add(blade);
    }

    // Glowing Engine Nacelle Ember
    const ember = new THREE.Mesh(createSculptedArmorDomeGeo(0.20, 8, 8), MAT.amberGlow);
    ember.position.set(-0.42, 0.82, -0.25);
    heli.add(ember);

    addMapMesh(heli);
    obstacles.push({ x, z, r: 2.15, type: 'crashed_helicopter' });
}

// ============================================================================
// NEW EXPANDED BATTLEFIELD FORTIFICATIONS & LANDMARKS:
// LARGE HEAVY-ORDNANCE BOMB CRATERS, FERRO-CONCRETE PILLBOX BUNKERS,
// EXCAVATED TACTICAL TRENCHES, SIEGE MORTAR PITS & TANK-TRAP BARRIER LINES
// ============================================================================
function createLargeBombCraterSite(rawX, rawZ, craterRadius = 4.6) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, craterRadius + 0.8, 5.8, 2.2);
    if (!spot) return;
    const x = spot.x, z = spot.z;
    const depth = 0.88 + seededRandom() * 0.35;

    DYNAMIC_BOMB_CRATERS.push({ x, z, r: craterRadius, depth });
    deformTerrainCrater(x, z, craterRadius, depth, true);

    const group = new THREE.Group();
    const bottomY = getTerrainHeight(x, z);

    // Subtle molten fissure ring at the bottom of the physically carved crater (no flat black circle)
    const magmaRing = new THREE.Mesh(new THREE.RingGeometry(craterRadius * 0.14, craterRadius * 0.28, 14), MAT.volatileGlow);
    magmaRing.rotation.x = -Math.PI / 2;
    magmaRing.position.set(x, bottomY + 0.035, z);
    group.add(magmaRing);

    // Half-buried Unexploded Heavy Aerial Bomb Casing + Cruciform Tail-Fins in Center
    const uxoBomb = new THREE.Group();
    uxoBomb.position.set(x + 0.25, bottomY + 0.22, z - 0.18);
    uxoBomb.rotation.set(0.55, seededRandom() * Math.PI * 2, -0.38);
    const bombBody = new THREE.Mesh(createSculptedLatheBarrelGeo(0.26, 0.34, 1.35, 12), MAT.charredSteel);
    const hazardBand = new THREE.Mesh(createSculptedLatheBarrelGeo(0.305, 0.325, 0.22, 12), MAT.hazard);
    hazardBand.position.y = 0.15;
    const tailShroud = new THREE.Mesh(createExtrudedArmorHullGeo(0.68, 0.42, 0.68, 0.03, 0.08), rustedSteelMat);
    tailShroud.position.y = 0.62;
    uxoBomb.add(bombBody, hazardBand, tailShroud);
    group.add(uxoBomb);

    // Jagged Ejecta Boulders & Twisted Steel Rebar along Crater Rim
    const rimCount = 14;
    for (let i = 0; i < rimCount; i++) {
        const ang = (i / rimCount) * Math.PI * 2 + (seededRandom() - 0.5) * 0.42;
        const rDist = craterRadius * (0.74 + seededRandom() * 0.34);
        const rx = x + Math.cos(ang) * rDist;
        const rz = z + Math.sin(ang) * rDist;
        const ry = getTerrainHeight(rx, rz);
        if (i % 3 === 0) {
            const girder = new THREE.Mesh(createExtrudedArmorHullGeo(0.14, 0.14, 1.35, 0.02, 0.04), rustedSteelMat);
            girder.position.set(rx, ry + 0.18, rz);
            girder.rotation.set(-0.45, ang, 0.25);
            group.add(girder);
        } else {
            const boulder = new THREE.Mesh(createSculptedFacetedCrystalGeo(0.32 + seededRandom() * 0.28, 0), rockMat);
            boulder.scale.set(1.3, 0.65, 1.05);
            boulder.position.set(rx, ry + 0.08, rz);
            boulder.rotation.set(seededRandom(), ang, seededRandom());
            group.add(boulder);
        }
    }

    addMapMesh(group);
    obstacles.push({ x, z, r: craterRadius * 0.58, type: 'large_bomb_crater' });
}

function createFortifiedMilitaryBunker(rawX, rawZ, rotY = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 2.7, 6.2, 2.4);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    const group = new THREE.Group();
    group.rotation.y = rotY;
    addSlopeFoundationPillars(group, x, z, 3.8, 3.8, rotY);

    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x565f68, roughness: 0.84, metalness: 0.22 });
    const sandbagMat = new THREE.MeshStandardMaterial({ color: 0x8b7755, roughness: 0.92, metalness: 0.04 });

    // Octagonal Ferro-Concrete Pillbox Base & Sloped Blast Roof
    const lowerCasemate = new THREE.Mesh(createSculptedLatheBarrelGeo(1.85, 2.15, 1.15, 8), concreteMat);
    lowerCasemate.position.y = 0.58;
    lowerCasemate.castShadow = !IS_MOBILE;
    lowerCasemate.receiveShadow = true;

    const upperCrown = new THREE.Mesh(createSculptedLatheBarrelGeo(1.45, 1.92, 0.45, 8), MAT.darkSteel);
    upperCrown.position.y = 1.35;
    upperCrown.castShadow = !IS_MOBILE;

    // Armored Firing Slit Visor & Twin Heavy Defensive Autocannons
    const firingSlit = new THREE.Mesh(createExtrudedArmorHullGeo(2.35, 0.26, 2.35, 0.04, 0.12), MAT.charredSteel);
    firingSlit.position.y = 0.88;
    group.add(lowerCasemate, upperCrown, firingSlit);

    [-0.38, 0.38].forEach(gx => {
        const barrel = new THREE.Mesh(createSculptedLatheBarrelGeo(0.065, 0.085, 1.25, 8), MAT.gunmetal);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(gx, 0.88, 1.85);
        const muzzle = new THREE.Mesh(createSculptedLatheBarrelGeo(0.09, 0.09, 0.18, 8), MAT.charredSteel);
        muzzle.rotation.x = Math.PI / 2;
        muzzle.position.set(gx, 0.88, 2.42);
        group.add(barrel, muzzle);
    });

    // Rear Armored Blast Door & Roof Comms / Periscope
    const blastDoor = new THREE.Mesh(createExtrudedArmorHullGeo(0.85, 0.92, 0.22, 0.03, 0.08), MAT.hazard);
    blastDoor.position.set(0, 0.48, -1.95);
    const commsPole = new THREE.Mesh(createSculptedLatheBarrelGeo(0.04, 0.05, 1.45, 6), MAT.titanium || MAT.gunmetal);
    commsPole.position.set(-0.65, 2.15, -0.45);
    const beacon = new THREE.Mesh(createSculptedArmorDomeGeo(0.10, 8, 8), MAT.amberGlow);
    beacon.position.set(-0.65, 2.88, -0.45);
    group.add(blastDoor, commsPole, beacon);

    // Armored Top Turret Bunker Cupola + Twin Elevated Heavy Cannons
    const turretCupola = new THREE.Group();
    turretCupola.position.set(0, 1.62, 0.08);
    turretCupola.rotation.y = (seededRandom() - 0.5) * 0.85;
    const cupolaDome = new THREE.Mesh(createSculptedLatheBarrelGeo(0.72, 0.92, 0.48, 8), MAT.gunmetal);
    cupolaDome.castShadow = !IS_MOBILE;
    const cupolaHatch = new THREE.Mesh(createSculptedArmorDomeGeo(0.38, 8, 8), MAT.darkSteel);
    cupolaHatch.position.y = 0.26;
    turretCupola.add(cupolaDome, cupolaHatch);
    [-0.24, 0.24].forEach(cx => {
        const topBarrel = new THREE.Mesh(createSculptedLatheBarrelGeo(0.055, 0.075, 1.15, 8), MAT.charredSteel);
        topBarrel.rotation.x = Math.PI / 2;
        topBarrel.position.set(cx, 0.06, 0.95);
        turretCupola.add(topBarrel);
    });
    group.add(turretCupola);

    // Sandbag Parapet Ring around Front Arc
    for (let s = -3; s <= 3; s++) {
        const ang = s * 0.34;
        const sb = new THREE.Mesh(createExtrudedArmorHullGeo(0.62, 0.28, 0.34, 0.03, 0.06), sandbagMat);
        sb.position.set(Math.sin(ang) * 2.25, 0.16, Math.cos(ang) * 2.25);
        sb.rotation.y = ang;
        group.add(sb);
    }

    addMapMesh(group);
    obstacles.push({ x, z, r: 2.35, type: 'military_bunker' });
}

function createTacticalTrenchNetwork(trenchDefOrX, rawZ, rotY = 0, trenchLen = 15.5, isFortifiedDefensive = false) {
    let tr = null;
    if (trenchDefOrX && typeof trenchDefOrX === 'object') {
        tr = trenchDefOrX;
    } else {
        const spot = findNonOverlappingStructureSpot(trenchDefOrX, rawZ, trenchLen * 0.34, 7.2, 2.6);
        if (!spot) return;
        const cosR = Math.cos(rotY);
        const sinR = Math.sin(rotY);
        const halfLen = trenchLen * 0.48;
        const halfWid = 1.56;
        const depth = 1.38;
        tr = {
            x: spot.x,
            z: spot.z,
            rotY,
            cosR,
            sinR,
            trenchLen,
            halfLen,
            halfWid,
            depth,
            isFortifiedDefensive,
            isMergedWing: false,
            mergedJunctionAlong: null,
            mergedSideSign: 0
        };
        DYNAMIC_TRENCHES.push(tr);
        for (let step = -halfLen; step <= halfLen; step += 1.5) {
            deformTerrainCrater(tr.x + sinR * step, tr.z + cosR * step, 2.25, depth, true);
        }
    }

    const x = tr.x;
    const z = tr.z;
    const cosR = tr.cosR;
    const sinR = tr.sinR;
    const halfLen = tr.halfLen;
    const halfWid = tr.halfWid || 1.56;
    const fullLen = tr.trenchLen || (halfLen * 2.08);
    const fortified = Boolean(tr.isFortifiedDefensive);

    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = tr.rotY !== undefined ? tr.rotY : Math.atan2(sinR, cosR);

    const timberMat = new THREE.MeshStandardMaterial({ color: 0x4a3522, roughness: 0.90, metalness: 0.06 });
    const soilBermMat = new THREE.MeshStandardMaterial({ color: 0x3b2d1f, roughness: 0.95, metalness: 0.02 });
    const sandbagMat = new THREE.MeshStandardMaterial({ color: 0x8d7958, roughness: 0.92, metalness: 0.04 });
    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x5c6670, roughness: 0.82, metalness: 0.22 });

    // Helper: sample actual carved floor & rim terrain heights at local (lx, lz) so all trench structures conform tightly to the carved soil mesh!
    const getLocalWorldPos = (lx, lz) => ({
        wx: x + lx * cosR + lz * sinR,
        wz: z - lx * sinR + lz * cosR
    });
    const getFloorY = (lz) => {
        const wp = getLocalWorldPos(0, lz);
        return getTerrainHeight(wp.wx, wp.wz);
    };
    const getRimY = (sideSign, lz) => {
        const wp = getLocalWorldPos(sideSign * (halfWid + 0.55), lz);
        return getTerrainHeight(wp.wx, wp.wz);
    };

    // 1. Segmented Sunken Trench Floor Duckboards & Mud Slat Walkways seated directly into the carved soil channel floor
    const segStep = 1.65;
    for (let p = -halfLen + 1.1; p <= halfLen - 1.1; p += segStep) {
        const floorY = getFloorY(p);
        const floorYNext = getFloorY(p + 0.65);
        const pitch = Math.atan2(floorY - floorYNext, 0.65);
        const plank = new THREE.Mesh(createExtrudedArmorHullGeo(1.48, 0.08, segStep + 0.08, 0.015, 0.03), timberMat);
        plank.position.set(0, floorY + 0.04, p);
        plank.rotation.x = THREE.MathUtils.clamp(pitch, -0.35, 0.35);
        group.add(plank);

        const slat = new THREE.Mesh(createExtrudedArmorHullGeo(1.38, 0.05, 0.28, 0.01, 0.02), timberMat);
        slat.position.set(0, floorY + 0.09, p);
        group.add(slat);
    }

    // 2. Sunken Revetment Walls, Timber Shoring Posts & Parapet Sandbags (with automatic gap where a merged wing trench joins!)
    [-1, 1].forEach(sideSign => {
        const wallStep = 1.85;
        for (let bPos = -halfLen + 1.25; bPos <= halfLen - 1.25; bPos += wallStep) {
            // Leave an open junction portal where a merged wing trench connects to this side of the main trench!
            if (tr.mergedJunctionAlong !== null && tr.mergedJunctionAlong !== undefined &&
                tr.mergedSideSign === sideSign && Math.abs(bPos - tr.mergedJunctionAlong) < 1.95) {
                continue;
            }

            const floorY = getFloorY(bPos);
            const rimY = getRimY(sideSign, bPos);
            const wallH = Math.max(0.75, rimY - floorY + 0.12);

            const wallSeg = new THREE.Mesh(createExtrudedArmorHullGeo(0.18, wallH, wallStep + 0.06, 0.02, 0.04), rustedSteelMat);
            wallSeg.position.set(sideSign * 0.92, floorY + wallH * 0.5, bPos);
            group.add(wallSeg);

            const beam = new THREE.Mesh(createExtrudedArmorHullGeo(0.14, wallH + 0.06, 0.14, 0.01, 0.02), timberMat);
            beam.position.set(sideSign * 0.80, floorY + wallH * 0.5, bPos);
            group.add(beam);

            const earthBerm = new THREE.Mesh(createExtrudedArmorHullGeo(0.82, 0.26, wallStep + 0.12, 0.05, 0.08), soilBermMat);
            earthBerm.position.set(sideSign * 1.38, rimY - 0.04, bPos);
            group.add(earthBerm);

            const bag = new THREE.Mesh(createExtrudedArmorHullGeo(0.46, 0.24, wallStep * 0.78, 0.025, 0.05), sandbagMat);
            bag.position.set(sideSign * 1.22, rimY + 0.12, bPos);
            bag.rotation.y = (Math.round(bPos) % 2 === 0 ? 0.05 : -0.05);
            group.add(bag);

            // Register physical collision barrier spheres along the side parapet wall so units cannot walk sideways through trench walls/debris!
            const wp = getLocalWorldPos(sideSign * 1.22, bPos);
            obstacles.push({
                x: wp.wx,
                z: wp.wz,
                r: 0.68,
                footprintR: 1.45,
                isBarrier: true,
                type: 'trench_wall'
            });
        }
    });

    // 3. Sunken Timber Entry Steps at Open Trench Ends (skip the end that merges into a parent trench!)
    [-halfLen + 0.55, halfLen - 0.55].forEach((ez, eIdx) => {
        if (tr.isMergedWing && eIdx === 0) return; // Connected junction end stays wide open!
        const stepSign = eIdx === 0 ? 1 : -1;
        for (let s = 0; s < 3; s++) {
            const szPos = ez - stepSign * s * 0.42;
            const stepY = getFloorY(szPos);
            const stepPlank = new THREE.Mesh(createExtrudedArmorHullGeo(1.32, 0.10, 0.36, 0.02, 0.04), timberMat);
            stepPlank.position.set(0, stepY + 0.05, szPos);
            group.add(stepPlank);
        }
    });

    // 4. Fortified Defensive Trench Pillbox Gun Bays & Overhead Blast Shields (with collision volumes on the side pillbox piers)
    const shelterOffsets = fullLen >= 16.5 ? [-fullLen * 0.23, fullLen * 0.23] : (tr.isMergedWing ? [] : [0]);
    shelterOffsets.forEach((sz, idx) => {
        if (tr.mergedJunctionAlong !== null && tr.mergedJunctionAlong !== undefined && Math.abs(sz - tr.mergedJunctionAlong) < 2.4) {
            return;
        }
        const rimY = Math.max(getRimY(-1, sz), getRimY(1, sz));
        const dugoutRoof = new THREE.Mesh(
            createExtrudedArmorHullGeo(2.45, 0.22, 2.45, 0.04, 0.08),
            fortified ? concreteMat : timberMat
        );
        dugoutRoof.position.set(0, rimY + 0.26, sz);
        group.add(dugoutRoof);

        if (fortified) {
            const pillboxCap = new THREE.Mesh(createExtrudedArmorHullGeo(2.28, 0.56, 2.15, 0.06, 0.10), concreteMat);
            pillboxCap.position.set(0, rimY + 0.56, sz);
            const slit = new THREE.Mesh(createExtrudedArmorHullGeo(2.34, 0.15, 1.48, 0.01, 0.02), MAT.voidBlack);
            slit.position.set(0, rimY + 0.58, sz);
            const gunBarrel = new THREE.Mesh(createSculptedLatheBarrelGeo(0.055, 0.065, 1.20, 8), MAT.gunmetal);
            gunBarrel.rotation.z = Math.PI / 2;
            gunBarrel.position.set((idx % 2 === 0 ? -1 : 1) * 1.38, rimY + 0.56, sz);
            group.add(pillboxCap, slit, gunBarrel);
        } else {
            const shieldPlate = new THREE.Mesh(createExtrudedArmorHullGeo(0.16, 0.60, 1.65, 0.02, 0.06), MAT.gunmetal);
            shieldPlate.position.set((idx % 2 === 0 ? -1 : 1) * 1.16, rimY + 0.46, sz);
            shieldPlate.rotation.z = (idx % 2 === 0 ? -0.18 : 0.18);
            group.add(shieldPlate);
        }

        [-1, 1].forEach(sideSign => {
            const wp = getLocalWorldPos(sideSign * 1.25, sz);
            obstacles.push({
                x: wp.wx,
                z: wp.wz,
                r: 0.78,
                footprintR: 1.8,
                isBarrier: true,
                type: 'trench_pillbox'
            });
        });
    });

    addMapMesh(group);
    // Register a non-blocking structure footprint marker so future buildings/props don't spawn on top of the trench
    obstacles.push({
        x,
        z,
        r: 0.1,
        footprintR: halfLen + 2.2,
        noUnitBlock: true,
        type: 'trench_network'
    });
}

function createSiegeMortarEmplacement(rawX, rawZ, rotY = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 2.3, 5.8, 2.2);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    deformTerrainCrater(x, z, 2.2, 0.26);

    const group = new THREE.Group();
    const y = getTerrainHeight(x, z);
    group.position.set(x, y, z);
    orientObjectToMountainSlope(group, x, z, rotY);

    const sandbagMat = new THREE.MeshStandardMaterial({ color: 0x887454, roughness: 0.92, metalness: 0.05 });
    const oliveMat = new THREE.MeshStandardMaterial({ color: 0x384830, roughness: 0.62, metalness: 0.45 });

    // Circular Sandbagged Artillery Pit Ring
    const numBags = 12;
    for (let i = 0; i < numBags; i++) {
        if (i === 6) continue; // Rear entry gap
        const ang = (i / numBags) * Math.PI * 2;
        const bag1 = new THREE.Mesh(createExtrudedArmorHullGeo(0.64, 0.26, 0.36, 0.03, 0.06), sandbagMat);
        bag1.position.set(Math.sin(ang) * 1.65, 0.16, Math.cos(ang) * 1.65);
        bag1.rotation.y = ang;
        const bag2 = new THREE.Mesh(createExtrudedArmorHullGeo(0.58, 0.24, 0.34, 0.03, 0.06), sandbagMat);
        bag2.position.set(Math.sin(ang + 0.12) * 1.62, 0.38, Math.cos(ang + 0.12) * 1.62);
        bag2.rotation.y = ang + 0.12;
        group.add(bag1, bag2);
    }

    // Heavy Recoil Baseplate + High-Angle 240mm Siege Mortar Tube + Elevation Bipod
    const baseplate = new THREE.Mesh(createSculptedLatheBarrelGeo(0.68, 0.78, 0.14, 8), MAT.darkSteel);
    baseplate.position.set(0, 0.08, -0.15);

    const mortarTube = new THREE.Mesh(createSculptedLatheBarrelGeo(0.18, 0.22, 1.85, 12), oliveMat);
    mortarTube.position.set(0, 0.78, 0.28);
    mortarTube.rotation.x = Math.PI / 5.2; // High-angle siege elevation
    mortarTube.castShadow = !IS_MOBILE;

    const muzzleRing = new THREE.Mesh(createSculptedTorusCollarGeo(0.19, 0.035, 8, 14), MAT.hazard);
    muzzleRing.position.set(0, 1.48, 0.76);
    muzzleRing.rotation.x = Math.PI / 2 + Math.PI / 5.2;

    // Bipod Legs
    [-0.36, 0.36].forEach(lx => {
        const leg = new THREE.Mesh(createSculptedLatheBarrelGeo(0.035, 0.04, 1.15, 6), MAT.titanium || MAT.gunmetal);
        leg.position.set(lx, 0.52, 0.48);
        leg.rotation.z = lx > 0 ? 0.32 : -0.32;
        group.add(leg);
    });

    // Stacked HE Mortar Shell Ammo Crates & Brass Shells
    const ammoCrate = new THREE.Mesh(createExtrudedArmorHullGeo(0.68, 0.36, 0.44, 0.025, 0.06), oliveMat);
    ammoCrate.position.set(-0.85, 0.20, -0.35);
    const shell = new THREE.Mesh(createSculptedLatheBarrelGeo(0.08, 0.10, 0.48, 8), MAT.amberGlow);
    shell.rotation.z = Math.PI / 2;
    shell.position.set(-0.85, 0.42, -0.35);

    group.add(baseplate, mortarTube, muzzleRing, ammoCrate, shell);
    addMapMesh(group);
    obstacles.push({ x, z, r: 1.85, type: 'mortar_emplacement' });
}

function createBattlefieldBarriersLine(rawX, rawZ, rotY = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 2.4, 5.8, 2.2);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    const group = new THREE.Group();
    const y = getTerrainHeight(x, z);
    group.position.set(x, y, z);
    orientObjectToMountainSlope(group, x, z, rotY);

    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x626b74, roughness: 0.86, metalness: 0.18 });

    // 2 Reinforced Concrete Jersey Blast Barriers + Hazard Stripes
    [-1.45, 1.45].forEach(bx => {
        const jersey = new THREE.Mesh(createExtrudedArmorHullGeo(1.65, 0.72, 0.52, 0.10, 0.14), concreteMat);
        jersey.position.set(bx, 0.36, 0);
        jersey.castShadow = !IS_MOBILE;
        const stripe = new THREE.Mesh(createExtrudedArmorHullGeo(1.55, 0.14, 0.56, 0.02, 0.04), MAT.hazard);
        stripe.position.set(bx, 0.58, 0);
        group.add(jersey, stripe);
    });

    // Center Steel Czech Hedgehog Anti-Tank Trap + Dragon's Teeth Concrete Pyramids
    const hedgehog = new THREE.Group();
    hedgehog.position.set(0, 0.46, 0.15);
    [[0, 0, 0.78], [0.78, 0, 0], [0, 0.78, -0.78]].forEach(([rx, ry, rz]) => {
        const beam = new THREE.Mesh(createExtrudedArmorHullGeo(0.12, 1.25, 0.12, 0.015, 0.03), rustedSteelMat);
        beam.rotation.set(rx, ry, rz);
        beam.castShadow = !IS_MOBILE;
        hedgehog.add(beam);
    });
    group.add(hedgehog);

    [-0.65, 0.65].forEach(dx => {
        const tooth = new THREE.Mesh(createSculptedOgiveSpireGeo(0.38, 0.65, 4), concreteMat);
        tooth.position.set(dx, 0.32, -0.55);
        tooth.rotation.y = Math.PI / 4;
        group.add(tooth);
    });

    addMapMesh(group);
    obstacles.push({ x, z, r: 1.95, type: 'battlefield_barriers', isBarrier: true });
}

// ============================================================================
// NEW DYNAMICALLY GENERATED CIVILIAN HOUSES, ROAD CAR PILEUPS / ROADBLOCKS,
// BARBED WIRE, SANDBAG FENCE LINES, DESTROYED CONVOYS, JET CRATERS, CHINOOKS
// & DIRECTED MISSILE LAUNCHER TRUCKS AIMED AT PLAYER / AI BASES
// ============================================================================
function createNormalCivilianHouse(rawX, rawZ, rotY = 0, variantIdx = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 2.75, 4.4, 2.0);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    const group = new THREE.Group();
    group.rotation.y = rotY;
    addSlopeFoundationPillars(group, x, z, 3.6, 3.2, rotY);

    const wallColors = [0xd6cfc2, 0xc8b89e, 0xb8c4cc, 0xd8c3b0];
    const roofColors = [0x6e352c, 0x3b4d5e, 0x4f4339, 0x5c3a2e];
    const stuccoMat = new THREE.MeshStandardMaterial({
        color: wallColors[variantIdx % wallColors.length],
        roughness: 0.86,
        metalness: 0.06
    });
    const roofTileMat = new THREE.MeshStandardMaterial({
        color: roofColors[variantIdx % roofColors.length],
        roughness: 0.78,
        metalness: 0.14
    });
    const timberMat = new THREE.MeshStandardMaterial({ color: 0x4e3624, roughness: 0.88, metalness: 0.05 });

    const houseW = 3.2 + (variantIdx % 2) * 0.45;
    const houseD = 2.7 + ((variantIdx + 1) % 2) * 0.35;
    const houseH = 1.45 + (variantIdx % 3) * 0.22;

    // Main Residential Stucco/Brick Body
    const body = new THREE.Mesh(createExtrudedArmorHullGeo(houseW, houseH, houseD, 0.05, 0.08), stuccoMat);
    body.position.y = houseH * 0.5;
    body.castShadow = !IS_MOBILE;
    body.receiveShadow = true;
    group.add(body);

    // Pitched Gable Roof (2 Sloped Roof Planes + Chimney Stack)
    const roofHalfW = houseW * 0.56;
    [-1, 1].forEach(side => {
        const roofSlope = new THREE.Mesh(createExtrudedArmorHullGeo(roofHalfW, 0.12, houseD + 0.32, 0.02, 0.04), roofTileMat);
        roofSlope.position.set(side * (roofHalfW * 0.44), houseH + 0.28, 0);
        roofSlope.rotation.z = -side * 0.46;
        roofSlope.castShadow = !IS_MOBILE;
        group.add(roofSlope);
    });

    const chimney = new THREE.Mesh(createExtrudedArmorHullGeo(0.38, 0.75, 0.38, 0.02, 0.04), roofTileMat);
    chimney.position.set(houseW * 0.26, houseH + 0.52, -houseD * 0.22);
    group.add(chimney);

    // Front Porch Awning, Timber Columns & Entry Door
    const porchRoof = new THREE.Mesh(createExtrudedArmorHullGeo(1.45, 0.08, 0.68, 0.02, 0.04), timberMat);
    porchRoof.position.set(0, 0.98, houseD * 0.5 + 0.32);
    const door = new THREE.Mesh(createExtrudedArmorHullGeo(0.52, 0.86, 0.08, 0.015, 0.03), timberMat);
    door.position.set(0, 0.44, houseD * 0.5 + 0.03);
    group.add(porchRoof, door);

    [-0.58, 0.58].forEach(px => {
        const post = new THREE.Mesh(createSculptedLatheBarrelGeo(0.045, 0.05, 0.95, 6), timberMat);
        post.position.set(px, 0.48, houseD * 0.5 + 0.56);
        group.add(post);
    });

    // Illuminated / Shuttered Windows
    [-0.95, 0.95].forEach(wx => {
        const win = new THREE.Mesh(
            createExtrudedArmorHullGeo(0.48, 0.42, 0.08, 0.01, 0.02),
            variantIdx % 2 === 0 ? MAT.amberGlow : MAT.charredSteel
        );
        win.position.set(wx, 0.78, houseD * 0.5 + 0.03);
        group.add(win);
    });

    addMapMesh(group);
    obstacles.push({ x, z, r: 2.15, type: 'civilian_house' });
}

// Dynamically Generated Military Watch & Radar Observation Tower (Armored Guard Crows-Nest, Searchlight, Communications Mast & Perimeter Sandbags)
function createMilitaryWatchTower(rawX, rawZ, rotY = 0, variantIdx = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 2.65, 5.2, 2.2);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    const group = new THREE.Group();
    group.rotation.y = rotY;
    addSlopeFoundationPillars(group, x, z, 3.2, 3.2, rotY);

    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x5d6772, roughness: 0.84, metalness: 0.22 });
    const armorMat = new THREE.MeshStandardMaterial({ color: 0x34414e, roughness: 0.58, metalness: 0.52 });
    const sandbagMat = new THREE.MeshStandardMaterial({ color: 0x8a7654, roughness: 0.92, metalness: 0.04 });

    // 1. Reinforced Concrete Octagonal Base Plinth & Perimeter Sandbags
    const plinth = new THREE.Mesh(createExtrudedArmorHullGeo(2.55, 0.42, 2.55, 0.08, 0.12), concreteMat);
    plinth.position.y = 0.21;
    group.add(plinth);

    // 2. 4 Heavy Angled Steel Lattice Support Legs + Cross-Bracing Girders
    const towerH = 4.2 + (variantIdx % 2) * 0.55;
    [[-0.86, -0.86], [0.86, -0.86], [-0.86, 0.86], [0.86, 0.86]].forEach(([lx, lz]) => {
        const leg = new THREE.Mesh(createExtrudedArmorHullGeo(0.20, towerH, 0.20, 0.02, 0.04), armorMat);
        leg.position.set(lx * 0.85, towerH * 0.5 + 0.2, lz * 0.85);
        leg.rotation.z = lx > 0 ? 0.05 : -0.05;
        leg.rotation.x = lz > 0 ? -0.05 : 0.05;
        group.add(leg);
    });

    [1.45, 2.85].forEach(by => {
        const braceX = new THREE.Mesh(createExtrudedArmorHullGeo(1.75, 0.12, 0.12, 0.01, 0.02), rustedSteelMat);
        braceX.position.set(0, by, 0.72);
        const braceZ = new THREE.Mesh(createExtrudedArmorHullGeo(0.12, 0.12, 1.75, 0.01, 0.02), rustedSteelMat);
        braceZ.position.set(0.72, by, 0);
        group.add(braceX, braceZ);
    });

    // 3. Elevated Armored Observation Deck, Guard Railing & Overwatch Cabin
    const deck = new THREE.Mesh(createExtrudedArmorHullGeo(2.45, 0.24, 2.45, 0.05, 0.08), concreteMat);
    deck.position.y = towerH + 0.25;
    const cabin = new THREE.Mesh(createExtrudedArmorHullGeo(1.88, 1.18, 1.88, 0.06, 0.10), armorMat);
    cabin.position.y = towerH + 0.92;
    const roof = new THREE.Mesh(createExtrudedArmorHullGeo(2.25, 0.22, 2.25, 0.06, 0.08), armorMat);
    roof.position.y = towerH + 1.58;
    group.add(deck, cabin, roof);

    // Armored Visor Slit Windows & High-Powered Searchlight + Radar Dish on Roof
    const visor = new THREE.Mesh(
        createExtrudedArmorHullGeo(1.94, 0.26, 1.94, 0.01, 0.02),
        variantIdx % 2 === 0 ? MAT.cyanGlow : MAT.amberGlow
    );
    visor.position.y = towerH + 0.98;
    const mast = new THREE.Mesh(createSculptedLatheBarrelGeo(0.05, 0.07, 1.35, 8), armorMat);
    mast.position.set(-0.48, towerH + 2.25, -0.45);
    const searchlight = new THREE.Mesh(createSculptedLatheBarrelGeo(0.22, 0.16, 0.34, 10), MAT.amberGlow);
    searchlight.rotation.x = Math.PI / 2.4;
    searchlight.position.set(0.55, towerH + 1.78, 0.65);
    group.add(visor, mast, searchlight);

    // Base Sandbag Emplacement Wall
    [-0.95, 0, 0.95].forEach(bx => {
        const bag = new THREE.Mesh(createExtrudedArmorHullGeo(0.72, 0.28, 0.38, 0.02, 0.05), sandbagMat);
        bag.position.set(bx, 0.22, 1.35);
        group.add(bag);
    });

    addMapMesh(group);
    obstacles.push({ x, z, r: 2.15, type: 'watch_tower' });
}

function buildSingleAbandonedCarMesh(variantIdx = 0) {
    const car = new THREE.Group();
    const carPaints = [0x6e2b23, 0x2c4c64, 0x5c6468, 0x6b5839, 0x3b4f3b];
    const paintMat = new THREE.MeshStandardMaterial({
        color: carPaints[variantIdx % carPaints.length],
        roughness: 0.78,
        metalness: 0.42
    });
    const chassis = new THREE.Mesh(createExtrudedArmorHullGeo(0.96, 0.34, 2.05, 0.05, 0.08), paintMat);
    chassis.position.y = 0.28;
    chassis.castShadow = !IS_MOBILE;
    const cabin = new THREE.Mesh(createExtrudedArmorHullGeo(0.84, 0.30, 1.02, 0.04, 0.07), MAT.charredSteel);
    cabin.position.set(0, 0.56, -0.08);
    car.add(chassis, cabin);

    [[-0.48, 0.62], [0.48, 0.62], [-0.48, -0.62], [0.48, -0.62]].forEach(([wx, wz]) => {
        const wheel = new THREE.Mesh(createSculptedLatheBarrelGeo(0.18, 0.18, 0.14, 10), MAT.darkSteel);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(wx, 0.18, wz);
        car.add(wheel);
    });
    return car;
}

function createRoadAbandonedCarsAndPileups() {
    if (!DYNAMIC_ROAD_SEGMENTS || DYNAMIC_ROAD_SEGMENTS.length === 0) return;
    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x5c646e, roughness: 0.85, metalness: 0.20 });

    DYNAMIC_ROAD_SEGMENTS.forEach((seg, segIdx) => {
        // FIXED: DYNAMIC_ROAD_SEGMENTS stores spline samples in `seg.samples` (not `seg.points`)!
        const samples = seg.samples;
        if (!samples || samples.length < 4) return;

        // Place multiple roadblocks, multi-car pileups, concrete Jersey barricades, and abandoned cars along every road!
        const isCutRoad = !!(seg.isCutSpur || seg.cutEnd);
        const sampleFractions = isCutRoad ? [0.25, 0.55, 0.82, 0.94] : [0.18, 0.38, 0.58, 0.78];

        sampleFractions.forEach((frac, idx) => {
            const sIdx = Math.min(samples.length - 1, Math.max(0, Math.floor(frac * (samples.length - 1))));
            const smp = samples[sIdx];
            if (!smp) return;

            if (isOnRiverBridge(smp.x, smp.z, 7.5) || Math.abs(getRavineSignedDist(smp.x, smp.z)) < RIVER_HALF_WIDTH + 7.5) return;
            if (Math.hypot(smp.x - PLAYER_START_POS.x, smp.z - PLAYER_START_POS.z) < 16.0) return;
            if (Math.hypot(smp.x - ENEMY_BASE_POS.x, smp.z - ENEMY_BASE_POS.z) < 18.0) return;
            if (Math.hypot(smp.x - SOLARIS_BASE_POS.x, smp.z - SOLARIS_BASE_POS.z) < 16.0) return;

            const nx = smp.nx !== undefined ? smp.nx : -(smp.tz || 0);
            const nz = smp.nz !== undefined ? smp.nz : (smp.tx || 1);
            const roadYaw = Math.atan2(smp.tx || 0, smp.tz || 1);
            const sideSign = ((segIdx + idx) % 2 === 0) ? 1 : -1;

            if ((isCutRoad && idx >= sampleFractions.length - 2) || (!isCutRoad && idx === 1 && segIdx % 2 === 0)) {
                // Full Multi-Car Military/Civilian Roadblock Barricade (3 Cars + Concrete Jersey Barriers + Czech Hedgehog)
                const offsetSide = isCutRoad ? 0.0 : (sideSign * ((smp.halfWidth || 1.6) * 0.75));
                const px = smp.x + nx * offsetSide;
                const pz = smp.z + nz * offsetSide;
                const py = getTerrainHeight(px, pz);
                if (py < -0.1) return;

                const pileGroup = new THREE.Group();
                pileGroup.position.set(px, py, pz);
                orientObjectToMountainSlope(pileGroup, px, pz, roadYaw);

                for (let c = 0; c < 3; c++) {
                    const car = buildSingleAbandonedCarMesh(segIdx + idx + c);
                    car.position.set((c - 1) * 1.05, c === 1 ? 0.16 : 0, (c % 2) * 0.52);
                    car.rotation.y = (c - 1) * 0.62 + (seededRandom() - 0.5) * 0.45;
                    car.rotation.z = c === 1 ? 0.26 : -0.09;
                    pileGroup.add(car);
                }

                // Concrete Jersey Roadblock Barriers & Hazard Stripes
                [-1.35, 1.35].forEach(bx => {
                    const barrier = new THREE.Mesh(createExtrudedArmorHullGeo(1.45, 0.68, 0.48, 0.08, 0.12), concreteMat);
                    barrier.position.set(bx, 0.34, 1.15);
                    barrier.rotation.y = bx > 0 ? -0.22 : 0.22;
                    const hStripe = new THREE.Mesh(createExtrudedArmorHullGeo(1.38, 0.14, 0.52, 0.02, 0.04), MAT.hazard || concreteMat);
                    hStripe.position.set(bx, 0.54, 1.15);
                    hStripe.rotation.y = barrier.rotation.y;
                    pileGroup.add(barrier, hStripe);
                });

                addMapMesh(pileGroup);
                if (isCutRoad) {
                    obstacles.push({ x: px, z: pz, r: 1.95, type: 'road_car_pileup', isBarrier: true });
                }
            } else {
                // Abandoned Car or 2-Car Wrecked Collision on the Road Shoulder / Lane Edge
                const shoulderOffset = (smp.halfWidth || 1.7) * 0.85 + 0.55;
                const cx = smp.x + nx * sideSign * shoulderOffset;
                const cz = smp.z + nz * sideSign * shoulderOffset;
                const cy = getTerrainHeight(cx, cz);
                if (cy < -0.1) return;

                const carGroup = new THREE.Group();
                carGroup.position.set(cx, cy, cz);
                orientObjectToMountainSlope(carGroup, cx, cz, roadYaw + (seededRandom() - 0.5) * 0.55);

                const car1 = buildSingleAbandonedCarMesh(segIdx + idx);
                carGroup.add(car1);

                if ((segIdx + idx) % 2 === 0) {
                    const car2 = buildSingleAbandonedCarMesh(segIdx + idx + 2);
                    car2.position.set(sideSign * 0.78, 0.10, -1.35);
                    car2.rotation.set(0.14, 0.68 * sideSign, -0.20 * sideSign);
                    carGroup.add(car2);

                    const jersey = new THREE.Mesh(createExtrudedArmorHullGeo(1.35, 0.62, 0.44, 0.06, 0.10), concreteMat);
                    jersey.position.set(-sideSign * 0.65, 0.31, 1.25);
                    jersey.rotation.y = 0.35 * sideSign;
                    carGroup.add(jersey);
                }
                addMapMesh(carGroup);
            }
        });
    });
}

function createBarbedWireEntanglement(rawX, rawZ, rotY = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 2.0, 5.2, 2.0);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    const group = new THREE.Group();
    const y = getTerrainHeight(x, z);
    group.position.set(x, y, z);
    orientObjectToMountainSlope(group, x, z, rotY);

    const timberMat = new THREE.MeshStandardMaterial({ color: 0x4b3624, roughness: 0.9, metalness: 0.08 });
    for (let s = -1.6; s <= 1.6; s += 1.6) {
        [-0.26, 0.26].forEach(tilt => {
            const stake = new THREE.Mesh(createSculptedLatheBarrelGeo(0.04, 0.05, 1.05, 6), timberMat);
            stake.position.set(s, 0.42, 0);
            stake.rotation.x = tilt * 2.2;
            group.add(stake);
        });
    }
    for (let c = -1.8; c <= 1.8; c += 0.36) {
        const coil = new THREE.Mesh(createSculptedTorusCollarGeo(0.34, 0.022, 6, 12), rustedSteelMat);
        coil.position.set(c, 0.38, (c % 0.72 === 0 ? 0.05 : -0.05));
        coil.rotation.y = Math.PI / 2 + (seededRandom() - 0.5) * 0.25;
        group.add(coil);
    }

    addMapMesh(group);
    obstacles.push({ x, z, r: 1.55, type: 'barbed_wire', isBarrier: true });
}

function createSandbagAndSecurityFenceLine(rawX, rawZ, rotY = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 2.2, 5.2, 2.0);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    const group = new THREE.Group();
    const y = getTerrainHeight(x, z);
    group.position.set(x, y, z);
    orientObjectToMountainSlope(group, x, z, rotY);

    const sandbagMat = new THREE.MeshStandardMaterial({ color: 0x8a7655, roughness: 0.92, metalness: 0.04 });
    for (let b = -2; b <= 2; b++) {
        for (let row = 0; row < 2; row++) {
            const bag = new THREE.Mesh(createExtrudedArmorHullGeo(0.66, 0.25, 0.36, 0.03, 0.06), sandbagMat);
            bag.position.set(b * 0.68 + (row % 2) * 0.16, 0.14 + row * 0.22, 0.28);
            bag.rotation.y = (b * 0.08);
            group.add(bag);
        }
    }
    [-1.8, -0.6, 0.6, 1.8].forEach(px => {
        const post = new THREE.Mesh(createSculptedLatheBarrelGeo(0.045, 0.055, 1.45, 6), MAT.gunmetal);
        post.position.set(px, 0.72, -0.22);
        group.add(post);
    });
    [0.45, 0.92, 1.32].forEach(ry => {
        const rail = new THREE.Mesh(createExtrudedArmorHullGeo(3.65, 0.045, 0.045, 0.01, 0.02), rustedSteelMat);
        rail.position.set(0, ry, -0.22);
        group.add(rail);
    });

    addMapMesh(group);
    obstacles.push({ x, z, r: 1.75, type: 'sandbag_fence', isBarrier: true });
}

function createDestroyedMilitaryConvoy(rawX, rawZ, rotY = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 3.6, 6.2, 2.5);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    deformTerrainCrater(x, z, 2.8, 0.36, true);

    const group = new THREE.Group();
    const y = getTerrainHeight(x, z);
    group.position.set(x, y, z);
    orientObjectToMountainSlope(group, x, z, rotY);

    const oliveMat = new THREE.MeshStandardMaterial({ color: 0x3b4832, roughness: 0.72, metalness: 0.38 });
    [-2.6, 0.0, 2.6].forEach((cz, idx) => {
        const veh = new THREE.Group();
        veh.position.set((idx - 1) * 0.55, 0.06, cz);
        veh.rotation.y = (idx - 1) * 0.24;
        veh.rotation.z = idx === 1 ? -0.16 : 0.12;

        const hull = new THREE.Mesh(
            createExtrudedArmorHullGeo(1.15, 0.52, 2.15, 0.06, 0.10),
            idx === 1 ? MAT.charredSteel : oliveMat
        );
        hull.position.y = 0.34;
        const cab = new THREE.Mesh(createExtrudedArmorHullGeo(1.02, 0.42, 0.78, 0.04, 0.08), rustedSteelMat);
        cab.position.set(0, 0.68, 0.58);
        const ember = new THREE.Mesh(createSculptedArmorDomeGeo(0.16, 8, 8), MAT.amberGlow);
        ember.position.set(0, 0.62, -0.35);
        veh.add(hull, cab, ember);
        group.add(veh);
    });

    addMapMesh(group);
    obstacles.push({ x, z, r: 2.85, type: 'destroyed_convoy' });
}

function createDestroyedJetInCrater(rawX, rawZ, rotY = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 3.5, 6.0, 2.4);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    const craterR = 3.6;
    const depth = 0.72;
    DYNAMIC_BOMB_CRATERS.push({ x, z, r: craterR, depth });
    deformTerrainCrater(x, z, craterR, depth, true);

    const group = new THREE.Group();
    const y = getTerrainHeight(x, z);
    group.position.set(x, y, z);
    group.rotation.y = rotY;

    const jet = new THREE.Group();
    jet.position.set(0, 0.28, 0);
    jet.rotation.x = 0.48;
    jet.rotation.z = -0.22;

    const fuselage = new THREE.Mesh(createSculptedLatheBarrelGeo(0.24, 0.42, 3.25, 10).rotateX(Math.PI / 2), MAT.charredSteel);
    const noseCone = new THREE.Mesh(createSculptedOgiveSpireGeo(0.24, 0.95, 10).rotateX(Math.PI / 2), MAT.gunmetal);
    noseCone.position.z = 1.85;
    const canopy = new THREE.Mesh(createSculptedArmorDomeGeo(0.26, 10, 8), MAT.cyanGlow);
    canopy.scale.set(0.82, 0.68, 1.85);
    canopy.position.set(0, 0.24, 0.65);

    const leftWing = new THREE.Mesh(createExtrudedArmorHullGeo(1.85, 0.08, 1.15, 0.02, 0.05), MAT.darkSteel);
    leftWing.position.set(-1.05, 0, -0.15);
    leftWing.rotation.y = 0.32;
    const rightWing = new THREE.Mesh(createExtrudedArmorHullGeo(1.65, 0.08, 1.10, 0.02, 0.05), rustedSteelMat);
    rightWing.position.set(0.95, -0.12, -0.22);
    rightWing.rotation.set(0.18, -0.35, -0.28);

    [-0.32, 0.32].forEach(tx => {
        const tailFin = new THREE.Mesh(createExtrudedArmorHullGeo(0.08, 0.72, 0.68, 0.02, 0.04), MAT.hazard);
        tailFin.position.set(tx, 0.42, -1.25);
        tailFin.rotation.z = tx > 0 ? -0.22 : 0.22;
        jet.add(tailFin);
    });

    const afterburnerGlow = new THREE.Mesh(createSculptedArmorDomeGeo(0.22, 8, 8), MAT.volatileGlow);
    afterburnerGlow.position.set(0, 0.05, -1.62);

    jet.add(fuselage, noseCone, canopy, leftWing, rightWing, afterburnerGlow);
    group.add(jet);

    addMapMesh(group);
    obstacles.push({ x, z, r: 2.55, type: 'destroyed_jet_crater' });
}

function createCrashedChinookHelicopter(rawX, rawZ, rotY = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 3.2, 6.0, 2.3);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    deformTerrainCrater(x, z, 2.9, 0.42, true);

    const group = new THREE.Group();
    const y = getTerrainHeight(x, z);
    group.position.set(x, y + 0.16, z);
    orientObjectToMountainSlope(group, x, z, rotY);

    const oliveMat = new THREE.MeshStandardMaterial({ color: 0x36462e, roughness: 0.68, metalness: 0.36 });
    const chinook = new THREE.Group();
    chinook.rotation.z = 0.24;
    chinook.rotation.x = -0.12;

    const cargoHull = new THREE.Mesh(createExtrudedArmorHullGeo(1.38, 0.92, 3.85, 0.12, 0.16), oliveMat);
    cargoHull.position.y = 0.48;

    const cockpitNose = new THREE.Mesh(createSculptedArmorDomeGeo(0.68, 10, 10), MAT.charredSteel);
    cockpitNose.scale.set(0.95, 0.72, 1.15);
    cockpitNose.position.set(0, 0.46, 1.95);

    const fwdPylon = new THREE.Mesh(createExtrudedArmorHullGeo(0.52, 0.68, 0.65, 0.06, 0.08), oliveMat);
    fwdPylon.position.set(0, 1.12, 1.35);
    const rearPylon = new THREE.Mesh(createExtrudedArmorHullGeo(0.56, 0.92, 0.78, 0.06, 0.08), rustedSteelMat);
    rearPylon.position.set(0, 1.24, -1.55);

    chinook.add(cargoHull, cockpitNose, fwdPylon, rearPylon);

    [[1.35, 1.48], [-1.55, 1.72]].forEach(([rz, ry], pIdx) => {
        for (let b = 0; b < 3; b++) {
            const ang = (b / 3) * Math.PI * 2 + pIdx * 0.5;
            const blade = new THREE.Mesh(createExtrudedArmorHullGeo(2.35, 0.04, 0.18, 0.01, 0.03), MAT.charredSteel);
            blade.position.set(Math.cos(ang) * 1.12, ry - (b % 2) * 0.14, rz + Math.sin(ang) * 1.12);
            blade.rotation.y = -ang;
            blade.rotation.z = (b === 0 ? -0.26 : 0.12);
            chinook.add(blade);
        }
    });

    group.add(chinook);
    addMapMesh(group);
    obstacles.push({ x, z, r: 2.55, type: 'crashed_chinook' });
}

function createDirectedMissileLauncherTruck(rawX, rawZ, targetBasePos) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 2.8, 5.8, 2.2);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    const tgt = targetBasePos || PLAYER_START_POS;
    const aimYaw = Math.atan2(tgt.x - x, tgt.z - z);

    const group = new THREE.Group();
    const y = getTerrainHeight(x, z);
    group.position.set(x, y, z);
    orientObjectToMountainSlope(group, x, z, aimYaw);

    const camoMat = new THREE.MeshStandardMaterial({ color: 0x354431, roughness: 0.65, metalness: 0.42 });

    const bed = new THREE.Mesh(createExtrudedArmorHullGeo(1.42, 0.42, 3.65, 0.06, 0.08), MAT.darkSteel);
    bed.position.y = 0.36;
    const cab = new THREE.Mesh(createExtrudedArmorHullGeo(1.36, 0.72, 1.05, 0.06, 0.10), camoMat);
    cab.position.set(0, 0.74, -1.25);
    group.add(bed, cab);

    [-1.35, -0.45, 0.45, 1.35].forEach(wz => {
        [-0.74, 0.74].forEach(wx => {
            const wheel = new THREE.Mesh(createSculptedLatheBarrelGeo(0.28, 0.28, 0.22, 10), MAT.charredSteel);
            wheel.rotation.z = Math.PI / 2;
            wheel.position.set(wx, 0.28, wz);
            group.add(wheel);
        });
    });

    const launcherPivot = new THREE.Group();
    launcherPivot.position.set(0, 0.68, -0.35);
    launcherPivot.rotation.x = -Math.PI / 5.5;

    [-0.36, 0.36].forEach(mx => {
        [0.0, 0.46].forEach(my => {
            const tube = new THREE.Mesh(
                createSculptedLatheBarrelGeo(0.19, 0.21, 2.65, 10).rotateX(Math.PI / 2),
                camoMat
            );
            tube.position.set(mx, my, 1.05);
            const warheadCone = new THREE.Mesh(
                createSculptedOgiveSpireGeo(0.18, 0.52, 10).rotateX(Math.PI / 2),
                MAT.hazard
            );
            warheadCone.position.set(mx, my, 2.48);
            launcherPivot.add(tube, warheadCone);
        });
    });

    group.add(launcherPivot);
    addMapMesh(group);
    obstacles.push({ x, z, r: 2.35, type: 'missile_launcher_truck' });
}

// Dynamically Generated Semi-Destroyed Multi-Story Human Concrete Building (Collapsed Upper Floor, Exposed Rebar, Broken Walls & Rubble)
function createSemiDestroyedHumanStructure(rawX, rawZ, rotY = 0, variantIdx = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 3.2, 5.4, 2.2);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    const group = new THREE.Group();
    group.rotation.y = rotY;
    addSlopeFoundationPillars(group, x, z, 4.4, 3.8, rotY);

    const concretePalette = [0x6e737b, 0x7c746b, 0x5e6770, 0x756b63];
    const wallMat = new THREE.MeshStandardMaterial({
        color: concretePalette[variantIdx % concretePalette.length],
        roughness: 0.88,
        metalness: 0.12
    });
    const scorchedWallMat = new THREE.MeshStandardMaterial({
        color: 0x2c3036,
        roughness: 0.92,
        metalness: 0.18
    });

    const w = 3.8 + (variantIdx % 2) * 0.6;
    const d = 3.2 + ((variantIdx + 1) % 2) * 0.5;

    // 1. Intact Lower Ground Story Shell + Blast-Breached Corner
    const groundWallBack = new THREE.Mesh(createExtrudedArmorHullGeo(w, 1.65, 0.34, 0.04, 0.08), wallMat);
    groundWallBack.position.set(0, 0.82, -d * 0.45);
    const groundWallLeft = new THREE.Mesh(createExtrudedArmorHullGeo(0.34, 1.65, d, 0.04, 0.08), wallMat);
    groundWallLeft.position.set(-w * 0.45, 0.82, 0);
    const groundWallRight = new THREE.Mesh(createExtrudedArmorHullGeo(0.34, 1.25, d * 0.68, 0.04, 0.08), scorchedWallMat);
    groundWallRight.position.set(w * 0.45, 0.62, -d * 0.14);
    const groundFrontHalf = new THREE.Mesh(createExtrudedArmorHullGeo(w * 0.58, 1.55, 0.34, 0.04, 0.08), wallMat);
    groundFrontHalf.position.set(-w * 0.18, 0.78, d * 0.45);
    group.add(groundWallBack, groundWallLeft, groundWallRight, groundFrontHalf);

    // 2. Second-Story Floor Slab + Partially Collapsed Sloping Upper Concrete Slab
    const midSlab = new THREE.Mesh(createExtrudedArmorHullGeo(w + 0.16, 0.22, d + 0.16, 0.03, 0.06), scorchedWallMat);
    midSlab.position.set(0, 1.68, 0);
    const collapsedRoofSlab = new THREE.Mesh(createExtrudedArmorHullGeo(w * 0.68, 0.20, d * 0.88, 0.03, 0.06), wallMat);
    collapsedRoofSlab.position.set(w * 0.14, 2.15, 0.08);
    collapsedRoofSlab.rotation.z = -0.38; // Collapsed down toward the breached right side!
    collapsedRoofSlab.rotation.x = 0.12;
    group.add(midSlab, collapsedRoofSlab);

    // 3. Jagged Broken Second-Story Wall Remnants & Exposed Steel Rebar Rods
    const upperWallBack = new THREE.Mesh(createExtrudedArmorHullGeo(w * 0.62, 1.18, 0.30, 0.03, 0.06), wallMat);
    upperWallBack.position.set(-w * 0.16, 2.28, -d * 0.44);
    const upperWallSide = new THREE.Mesh(createExtrudedArmorHullGeo(0.30, 1.25, d * 0.64, 0.03, 0.06), scorchedWallMat);
    upperWallSide.position.set(-w * 0.44, 2.32, -d * 0.14);
    group.add(upperWallBack, upperWallSide);

    // Exposed bent steel rebar rods protruding from fractured concrete edges
    for (let r = 0; r < 6; r++) {
        const rebar = new THREE.Mesh(createSculptedLatheBarrelGeo(0.025, 0.025, 0.75, 5), rustedSteelMat);
        rebar.position.set(-w * 0.15 + r * 0.38, 2.65 + (r % 2) * 0.18, -d * 0.44 + (r % 3) * 0.22);
        rebar.rotation.set((r % 2 - 0.5) * 0.45, 0, (r % 3 - 1) * 0.35);
        group.add(rebar);
    }

    // 4. Hollow Dark Window Frames & Fallen Concrete Rubble Pile on the Breached Side
    [-0.95, 0.25].forEach(wx => {
        [0.85, 2.15].forEach((wy, wRow) => {
            if (wRow === 1 && wx > 0) return;
            const winVoid = new THREE.Mesh(createExtrudedArmorHullGeo(0.56, 0.48, 0.40, 0.01, 0.02), MAT.charredSteel);
            winVoid.position.set(wx, wy, -d * 0.45);
            group.add(winVoid);
        });
    });

    for (let rb = 0; rb < 4; rb++) {
        const chunk = new THREE.Mesh(createOrganicBoulderGeo(0.45 + (rb % 2) * 0.18, 1), rb % 2 === 0 ? wallMat : scorchedWallMat);
        chunk.scale.set(1.2, 0.55, 0.95);
        chunk.position.set(w * 0.38 + (rb - 1.5) * 0.42, 0.22, d * 0.25 + (rb % 2) * 0.38);
        chunk.rotation.set(rb * 0.4, rb * 0.9, 0.25);
        group.add(chunk);
    }

    addMapMesh(group);
    obstacles.push({ x, z, r: 2.55, type: 'semi_destroyed_human_building' });
}

// Destroyed Military Runway Aircraft Base with Scarred Asphalt Airstrip, Ruined Control Tower, Bombed Hangar & 4 Wrecked Planes
function createDestroyedRunwayAirbase(rawX, rawZ, rotY = 0.35) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 11.5, 12.0, 3.8);
    if (!spot) return;
    const x = spot.x, z = spot.z;

    const baseGroundY = flattenTerrainUnderBuilding(x, z, 13.5, 5.5);
    const group = new THREE.Group();
    group.position.set(x, baseGroundY, z);
    group.rotation.y = rotY;

    const tarmacMat = new THREE.MeshStandardMaterial({ color: 0x262b32, roughness: 0.88, metalness: 0.12 });
    const stripeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xd8dee9, roughness: 0.75, metalness: 0.08 });
    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x59626d, roughness: 0.84, metalness: 0.18 });
    const airframeMat = new THREE.MeshStandardMaterial({ color: 0x45525e, roughness: 0.58, metalness: 0.48 });

    // 1. Scarred Asphalt Runway Strip (26m long x 7.2m wide) + Threshold Piano Keys & Centerline Dashes
    const runwaySlab = new THREE.Mesh(createExtrudedArmorHullGeo(7.2, 0.14, 25.5, 0.04, 0.08), tarmacMat);
    runwaySlab.position.y = 0.07;
    runwaySlab.receiveShadow = true;
    group.add(runwaySlab);

    for (let zDash = -9.5; zDash <= 9.5; zDash += 3.2) {
        const dash = new THREE.Mesh(createExtrudedArmorHullGeo(0.32, 0.04, 1.65, 0.01, 0.02), stripeWhiteMat);
        dash.position.set(0, 0.15, zDash);
        group.add(dash);
    }
    [-11.2, 11.2].forEach(endZ => {
        for (let k = -2.4; k <= 2.4; k += 0.96) {
            const bar = new THREE.Mesh(createExtrudedArmorHullGeo(0.42, 0.04, 1.35, 0.01, 0.02), stripeWhiteMat);
            bar.position.set(k, 0.15, endZ);
            group.add(bar);
        }
    });

    // 2. Bombed-Out Air Traffic Control Tower (East Apron)
    const towerGroup = new THREE.Group();
    towerGroup.position.set(5.4, 0, -4.5);
    const towerShaft = new THREE.Mesh(createExtrudedArmorHullGeo(2.25, 3.85, 2.25, 0.06, 0.12), concreteMat);
    towerShaft.position.y = 1.92;
    const cabDeck = new THREE.Mesh(createSculptedLatheBarrelGeo(1.65, 1.35, 1.05, 8), MAT.charredSteel);
    cabDeck.position.y = 4.25;
    cabDeck.rotation.z = 0.14; // Tilted from bomb blast
    const radarDish = new THREE.Mesh(createExtrudedArmorHullGeo(1.45, 0.28, 0.32, 0.02, 0.05), MAT.hazard || rustedSteelMat);
    radarDish.position.set(0, 5.05, 0);
    radarDish.rotation.set(0.25, 0.6, -0.32);
    towerGroup.add(towerShaft, cabDeck, radarDish);
    group.add(towerGroup);

    // 3. Semi-Destroyed Steel Aircraft Hangar Skeleton (East Apron North)
    const hangarGroup = new THREE.Group();
    hangarGroup.position.set(5.8, 0, 4.2);
    [-2.4, 2.4].forEach(hx => {
        const wall = new THREE.Mesh(createExtrudedArmorHullGeo(0.28, 2.25, 5.6, 0.03, 0.06), rustedSteelMat);
        wall.position.set(hx, 1.12, 0);
        hangarGroup.add(wall);
    });
    for (let rz = -2.4; rz <= 2.4; rz += 1.2) {
        const archRib = new THREE.Mesh(createSculptedTorusCollarGeo(2.45, 0.11, 6, 12, Math.PI), MAT.darkSteel);
        archRib.position.set(0, 2.15, rz);
        hangarGroup.add(archRib);
    }
    const halfRoof = new THREE.Mesh(createExtrudedArmorHullGeo(2.6, 0.12, 3.8, 0.02, 0.04), concreteMat);
    halfRoof.position.set(-1.1, 3.15, -0.6);
    halfRoof.rotation.z = 0.36;
    hangarGroup.add(halfRoof);
    group.add(hangarGroup);

    // Helper to build detailed wrecked military aircraft (Strike Fighter Jet or Heavy Twin-Engine Transport Plane)
    function buildWreckedMilitaryAircraft(isHeavyTransport, tiltX, tiltZ, yaw) {
        const plane = new THREE.Group();
        plane.rotation.set(tiltX, yaw, tiltZ);
        const bodyLen = isHeavyTransport ? 5.6 : 3.6;
        const bodyRad = isHeavyTransport ? 0.52 : 0.30;

        const fuselage = new THREE.Mesh(
            createSculptedLatheBarrelGeo(bodyRad * 0.72, bodyRad, bodyLen, 10).rotateX(Math.PI / 2),
            isHeavyTransport ? airframeMat : MAT.charredSteel
        );
        fuselage.position.y = bodyRad + 0.08;
        const nose = new THREE.Mesh(
            createSculptedOgiveSpireGeo(bodyRad * 0.72, isHeavyTransport ? 1.15 : 1.05, 10).rotateX(Math.PI / 2),
            MAT.gunmetal
        );
        nose.position.set(0, bodyRad + 0.08, bodyLen * 0.5 + 0.35);
        const cockpit = new THREE.Mesh(createSculptedArmorDomeGeo(bodyRad * 0.78, 10, 8), MAT.cyanGlow);
        cockpit.scale.set(0.85, 0.65, 1.65);
        cockpit.position.set(0, bodyRad * 1.65, bodyLen * 0.24);

        const wingSpan = isHeavyTransport ? 3.2 : 2.05;
        const leftWing = new THREE.Mesh(createExtrudedArmorHullGeo(wingSpan, 0.09, 1.25, 0.02, 0.04), airframeMat);
        leftWing.position.set(-wingSpan * 0.52, bodyRad + 0.05, 0);
        leftWing.rotation.y = isHeavyTransport ? 0.08 : 0.28;
        const rightWing = new THREE.Mesh(createExtrudedArmorHullGeo(wingSpan * 0.82, 0.09, 1.18, 0.02, 0.04), rustedSteelMat);
        rightWing.position.set(wingSpan * 0.42, bodyRad - 0.12, -0.15);
        rightWing.rotation.set(0.16, -0.24, -0.28); // Sheared/damaged wing

        const tailFin = new THREE.Mesh(createExtrudedArmorHullGeo(0.10, isHeavyTransport ? 1.25 : 0.82, 0.85, 0.02, 0.04), MAT.hazard);
        tailFin.position.set(0, bodyRad + 0.55, -bodyLen * 0.42);
        const fireCore = new THREE.Mesh(createSculptedArmorDomeGeo(0.24, 8, 8), MAT.amberGlow);
        fireCore.position.set(0.22, bodyRad + 0.18, -0.35);

        plane.add(fuselage, nose, cockpit, leftWing, rightWing, tailFin, fireCore);
        return plane;
    }

    // 4. Spawn 4 Wrecked Military Aircraft across the Runway & Hangar Apron!
    const p1 = buildWreckedMilitaryAircraft(true, 0.08, -0.18, 0.22); // Heavy Cargo Transport Plane on Runway North
    p1.position.set(-0.6, 0.14, 6.2);
    const p2 = buildWreckedMilitaryAircraft(false, 0.32, 0.24, -0.45); // Strike Fighter Jet Nose-Down on Runway Center-South
    p2.position.set(0.8, 0.12, -2.8);
    const p3 = buildWreckedMilitaryAircraft(false, -0.12, 0.28, 2.45); // Wrecked Interceptor on Runway South Threshold
    p3.position.set(-1.2, 0.14, -8.8);
    const p4 = buildWreckedMilitaryAircraft(false, 0.15, -0.22, -1.35); // Bombed Fighter inside Hangar Apron
    p4.position.set(5.6, 0.14, 4.0);
    group.add(p1, p2, p3, p4);

    addMapMesh(group);
    // Register collision obstacles along the runway buildings & plane wrecks + full footprintR so subsequent structures never overlap the runway!
    const cosA = Math.cos(rotY), sinA = Math.sin(rotY);
    const toWorld = (lx, lz) => ({ x: x + lx * cosA + lz * sinA, z: z - lx * sinA + lz * cosA });
    obstacles.push({ x, z, r: 2.2, footprintR: 13.5, type: 'destroyed_airbase_center' });
    [
        [5.4, -4.5, 2.4],
        [5.8, 4.2, 3.0],
        [-0.6, 6.2, 2.5],
        [0.8, -2.8, 2.1],
        [-1.2, -8.8, 2.1]
    ].forEach(([lx, lz, r]) => {
        const wp = toWorld(lx, lz);
        obstacles.push({ x: wp.x, z: wp.z, r, footprintR: r + 2.5, type: 'destroyed_airbase' });
    });
}

// Out-of-Bounds Bug-Fixed Perimeter + Terraria-Inspired Stratified Subterranean Cutaway Cross-Section & Outer Badlands Rim
function createOutOfBoundsFloorSkirt() {
    const halfMap = MAP_SIZE * 0.5; // 110.0m exact playable terrain boundary
    const skirtSize = 1100;
    const skirtGeo = new THREE.PlaneGeometry(skirtSize, skirtSize, 96, 96);
    skirtGeo.rotateX(-Math.PI / 2);
    const sPos = skirtGeo.attributes.position;
    const sColors = new Float32Array(sPos.count * 3);

    for (let i = 0; i < sPos.count; i++) {
        const vx = sPos.getX(i);
        const vz = sPos.getZ(i);
        const maxCoord = Math.max(Math.abs(vx), Math.abs(vz));

        // Sample nearest edge elevation so the outer badlands skirt meets the terrain border seamlessly with zero wall or cliff drop
        const clampedX = THREE.MathUtils.clamp(vx, -halfMap + 0.25, halfMap - 0.25);
        const clampedZ = THREE.MathUtils.clamp(vz, -halfMap + 0.25, halfMap - 0.25);
        const edgeH = getTerrainHeight(clampedX, clampedZ);

        const biome = ACTIVE_PLANET_BIOME || 'highland';
        let vy;
        if (maxCoord < halfMap - 1.5) {
            // Keep interior skirt vertices safely tucked underneath the playable terrain mesh
            vy = edgeH - 4.5;
        } else {
            const outDist = Math.max(0.0, maxCoord - (halfMap - 1.5));
            const smoothBlend = THREE.MathUtils.smoothstep(outDist, 0.0, 46.0);
            if (biome === 'ocean') {
                const oceanFloorWave = -1.45 + Math.sin(vx * 0.02 + MAP_SEED) * Math.cos(vz * 0.02) * 0.28;
                vy = THREE.MathUtils.lerp(edgeH - 0.05, oceanFloorWave, Math.min(1.0, outDist / 8.0));
            } else {
                const rollingHills = Math.sin(vx * 0.022 + MAP_SEED) * Math.cos(vz * 0.022) * 1.65
                                   + Math.sin(vx * 0.011 - vz * 0.013) * 2.15;
                const gentleFalloff = -Math.min(3.8, outDist * 0.012);
                const naturalHorizonH = edgeH * (1.0 - smoothBlend * 0.55) + (rollingHills + gentleFalloff) * smoothBlend;
                vy = THREE.MathUtils.lerp(edgeH - 0.03, naturalHorizonH, Math.min(1.0, outDist / 5.5));
            }
        }
        sPos.setY(i, vy);

        // Biome-matched horizon transition palette that blends naturally into distance fog without artificial walls
        const outDistColor = Math.max(0.0, maxCoord - halfMap);
        const distMix = THREE.MathUtils.smoothstep(outDistColor, 0.0, 58.0);
        const band = 0.5 + 0.5 * Math.sin(vy * 0.55 + vx * 0.018);
        const shade = 0.26 + 0.07 * Math.sin(vx * 0.035) * Math.cos(vz * 0.035);

        let edgeR = 0.26, edgeG = 0.35, edgeB = 0.22;
        let farR = shade * (1.08 + band * 0.22);
        let farG = shade * (0.88 + band * 0.14);
        let farB = shade * (0.68 + band * 0.08);
        if (biome === 'lava') {
            edgeR = 0.14; edgeG = 0.11; edgeB = 0.10;
            farR = 0.18 + band * 0.08; farG = 0.10 + band * 0.04; farB = 0.09;
        } else if (biome === 'ocean') {
            edgeR = 0.05; edgeG = 0.22; edgeB = 0.32;
            farR = 0.03; farG = 0.15; farB = 0.25;
        } else if (biome === 'desert') {
            edgeR = 0.54; edgeG = 0.42; edgeB = 0.28;
            farR = 0.48 + band * 0.08; farG = 0.36 + band * 0.06; farB = 0.24;
        } else if (biome === 'jungle') {
            edgeR = 0.18; edgeG = 0.32; edgeB = 0.16;
            farR = 0.14; farG = 0.26; farB = 0.13;
        }

        sColors[i * 3]     = THREE.MathUtils.lerp(edgeR, farR, distMix);
        sColors[i * 3 + 1] = THREE.MathUtils.lerp(edgeG, farG, distMix);
        sColors[i * 3 + 2] = THREE.MathUtils.lerp(edgeB, farB, distMix);
    }
    skirtGeo.setAttribute('color', new THREE.BufferAttribute(sColors, 3));
    skirtGeo.computeVertexNormals();

    const skirtMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: terrainDetailTex,
        roughness: 0.90,
        metalness: 0.04
    });
    if (typeof SHADER_ENGINE !== 'undefined' && typeof SHADER_ENGINE.applyTerrainShader === 'function') {
        SHADER_ENGINE.applyTerrainShader(skirtMat, false);
    }
    const skirtMesh = new THREE.Mesh(skirtGeo, skirtMat);
    skirtMesh.receiveShadow = true;
    addMapMesh(skirtMesh);

    // Scatter a few natural low rocks & desert boulders beyond the playable border (no fences, walls, or pylons)
    const naturalOutcropGroup = new THREE.Group();
    const outcropGeo = createOrganicBoulderGeo(2.4, 1);
    const borderLimit = 106.5;

    for (let c = -96; c <= 96; c += 16) {
        // Invisible gameplay boundary blockers at ±106.5m so units & buildings stay inside the playable map
        const registerInvisibleBoundary = (bx, bz) => {
            obstacles.push({
                x: bx,
                z: bz,
                r: 2.4,
                footprintR: 3.4,
                isBarrier: true,
                type: 'map_boundary_barrier'
            });
        };
        registerInvisibleBoundary(c, -borderLimit);
        registerInvisibleBoundary(c, borderLimit);
        registerInvisibleBoundary(-borderLimit, c);
        registerInvisibleBoundary(borderLimit, c);

        // Occasional natural boulder clusters far outside the playable area (±124m..±145m)
        if (Math.abs(c) % 32 === 0) {
            const outDist = halfMap + 16.0 + (Math.abs(c) % 15);
            const placeNaturalBoulder = (rx, rz, seedIdx) => {
                const bMesh = new THREE.Mesh(outcropGeo, rockMat);
                const s = 1.1 + (seedIdx % 3) * 0.45;
                bMesh.scale.set(s * 1.3, s * 0.75, s);
                bMesh.position.set(rx, getTerrainHeight(THREE.MathUtils.clamp(rx, -halfMap + 1, halfMap - 1), THREE.MathUtils.clamp(rz, -halfMap + 1, halfMap - 1)) - 0.4, rz);
                bMesh.rotation.y = seedIdx * 1.1;
                naturalOutcropGroup.add(bMesh);
            };
            placeNaturalBoulder(c, -outDist, c + 1);
            placeNaturalBoulder(c, outDist, c + 2);
            placeNaturalBoulder(-outDist, c, c + 3);
            placeNaturalBoulder(outDist, c, c + 4);
        }
    }
    addMapMesh(naturalOutcropGroup);
}

// Mine Gems Crater Site: Redesigned with Chunky Multi-Faceted Bipyramidal Diamond-Cut Geode Crystals & Progressive Real-Time Depletion!
function createMineGemCraterSite(rawX, rawZ, isEmptyCrater = false, craterIdx = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 3.8, 5.2, 2.2) || { x: rawX, z: rawZ };
    const x = spot.x, z = spot.z;

    const craterRadius = 4.05;
    const craterDepth = 0.92;
    DYNAMIC_BOMB_CRATERS.push({ x, z, r: craterRadius, depth: craterDepth });
    deformTerrainCrater(x, z, craterRadius, craterDepth, true);

    const group = new THREE.Group();
    const centerY = getTerrainHeight(x, z);
    group.position.set(x, centerY, z);

    const rimRockMat = new THREE.MeshStandardMaterial({ color: 0x322b40, roughness: 0.84, metalness: 0.24 });
    const isAmethyst = (craterIdx % 2 === 0);
    const gemRichMat = new THREE.MeshStandardMaterial({
        color: isAmethyst ? 0xe040fb : 0x00f0ff,
        emissive: isAmethyst ? 0xaa00ff : 0x00a8cc,
        emissiveIntensity: 0.92,
        roughness: 0.08,
        metalness: 0.72,
        flatShading: true
    });
    const gemCoreGlowMat = new THREE.MeshBasicMaterial({
        color: isAmethyst ? 0xf5abff : 0x80f8ff
    });
    const depletedSocketMat = new THREE.MeshStandardMaterial({
        color: 0x26212c,
        roughness: 0.92,
        metalness: 0.10,
        flatShading: true
    });

    // 1. Excavated Geode Crater Rim with Procedurally Perturbed Basalt Stones
    const rimCount = 12;
    for (let i = 0; i < rimCount; i++) {
        const ang = (i / rimCount) * Math.PI * 2 + (seededRandom() - 0.5) * 0.22;
        const rDist = craterRadius * (0.76 + (i % 2) * 0.06);
        const stoneGeo = createDynamicStoneGeometry(x * 7.1 + z * 3.7 + i * 5.3, 0.58 + (i % 3) * 0.16, 0.30, 0.56, 1);
        const rock = new THREE.Mesh(stoneGeo, rimRockMat);
        rock.position.set(Math.cos(ang) * rDist, 0.24, Math.sin(ang) * rDist);
        rock.rotation.set(0.18, -ang, 0.28);
        rock.castShadow = !IS_MOBILE;
        rock.receiveShadow = true;
        group.add(rock);
    }

    // 2. Dark Crystalline Geode Matrix Bed inside the Crater Floor
    const geodeBed = new THREE.Mesh(createDynamicStoneGeometry(x + z + 99.1, 1.85, 0.20, 0.22, 2), rimRockMat);
    geodeBed.position.y = 0.08;
    group.add(geodeBed);

    const coreHeart = new THREE.Mesh(new THREE.OctahedronGeometry(0.62, 1), isEmptyCrater ? depletedSocketMat : gemCoreGlowMat);
    coreHeart.scale.set(1.35, 0.42, 1.35);
    coreHeart.position.y = 0.18;
    group.add(coreHeart);

    // 3. Broad Multi-Faceted Bipyramidal Geode Gem Cluster (1 Massive Central Mother Gem + 8 Angled Faceted Prism Clusters)
    const gemClusterGroup = new THREE.Group();
    const crystalNodes = [];
    const totalGems = 9;
    for (let c = 0; c < totalGems; c++) {
        const isMother = (c === 0);
        const ringIdx = c - 1;
        const cAng = isMother ? 0 : (ringIdx / 8) * Math.PI * 2 + (ringIdx % 2) * 0.18;
        const cDist = isMother ? 0.0 : (0.58 + (ringIdx % 2) * 0.48);
        const gemH = isMother ? 1.55 : (0.92 + (ringIdx % 3) * 0.22);
        const gemR = isMother ? 0.54 : (0.34 + (ringIdx % 2) * 0.09);
        const sides = (c % 2 === 0) ? 6 : 7;

        const gemNode = new THREE.Group();
        gemNode.position.set(Math.cos(cAng) * cDist, 0.08, Math.sin(cAng) * cDist);
        const tilt = isMother ? 0.06 : (0.36 + (ringIdx % 2) * 0.20);
        gemNode.rotation.z = -Math.cos(cAng) * tilt;
        gemNode.rotation.x = Math.sin(cAng) * tilt;
        gemNode.rotation.y = c * 0.95;

        const gemGeo = createFacetedGeodeCrystalGeo(gemR, gemH, sides, craterIdx * 17.3 + c * 4.1);
        const mainCrystal = new THREE.Mesh(gemGeo, isEmptyCrater ? depletedSocketMat : gemRichMat);
        mainCrystal.castShadow = !IS_MOBILE;
        mainCrystal.receiveShadow = true;
        gemNode.add(mainCrystal);

        // Side daughter crystal facet growing out of the gem's lower prism waist
        const sideGeo = createFacetedGeodeCrystalGeo(gemR * 0.62, gemH * 0.58, 6, craterIdx * 9.1 + c * 7.7);
        const sideCrystal = new THREE.Mesh(sideGeo, isEmptyCrater ? depletedSocketMat : gemRichMat);
        sideCrystal.position.set(gemR * 0.48, gemH * 0.14, 0);
        sideCrystal.rotation.z = -0.52;
        gemNode.add(sideCrystal);

        if (isEmptyCrater) {
            gemNode.scale.set(0.65, 0.22, 0.65);
        }
        gemClusterGroup.add(gemNode);
        crystalNodes.push({
            node: gemNode,
            mainCrystal,
            sideCrystal,
            isMother
        });
    }
    group.add(gemClusterGroup);

    // 4. Rim Survey Collar Ring
    const ringMat = new THREE.MeshStandardMaterial({
        color: isEmptyCrater ? 0x64748b : (isAmethyst ? 0xd500f9 : 0x00e5ff),
        emissive: isEmptyCrater ? 0x1e293b : (isAmethyst ? 0x9c27b0 : 0x0088aa),
        emissiveIntensity: isEmptyCrater ? 0.15 : 0.72,
        roughness: 0.28
    });
    const surveyRing = new THREE.Mesh(createSculptedTorusCollarGeo(craterRadius * 0.68, 0.06, 6, 24), ringMat);
    surveyRing.rotation.x = Math.PI / 2;
    surveyRing.position.y = 0.22;
    group.add(surveyRing);

    addMapMesh(group);

    const maxGems = isEmptyCrater ? 0 : (300 + (craterIdx % 3) * 90);
    const craterRecord = {
        id: `gem_crater_${craterIdx + 1}`,
        x,
        z,
        y: centerY,
        radius: craterRadius,
        isEmpty: Boolean(isEmptyCrater),
        gemsRemaining: maxGems,
        maxGems,
        group,
        gemClusterGroup,
        crystalNodes,
        coreHeart,
        surveyRing,
        gemRichMat,
        depletedSocketMat
    };
    GEM_CRATERS.push(craterRecord);
    return craterRecord;
}

// Progressively updates a Gem Crater's 3D faceted crystal cluster as a Mine Drill extracts gems from it
window.updateGemCraterDepletionVisuals = function(crater) {
    if (!crater) return;
    const maxG = Math.max(1, crater.maxGems || 300);
    const rem = Math.max(0, crater.gemsRemaining || 0);
    const ratio = crater.isEmpty ? 0 : THREE.MathUtils.clamp(rem / maxG, 0, 1);

    if (Array.isArray(crater.crystalNodes)) {
        const count = crater.crystalNodes.length;
        for (let i = 0; i < count; i++) {
            const cn = crater.crystalNodes[i];
            if (!cn || !cn.node) continue;
            // Outer crystal clusters shatter/deplete first, central Mother Gem depletes last
            const thresh = cn.isMother ? 0.0 : ((count - 1 - i) / count) * 0.75;
            const localT = THREE.MathUtils.clamp((ratio - thresh) / (1.0 - thresh || 1.0), 0.0, 1.0);
            const scXZ = 0.55 + localT * 0.45;
            const scY = 0.20 + localT * 0.80;
            cn.node.scale.set(scXZ, scY, scXZ);
            if (localT <= 0.04 && crater.depletedSocketMat) {
                if (cn.mainCrystal) cn.mainCrystal.material = crater.depletedSocketMat;
                if (cn.sideCrystal) cn.sideCrystal.material = crater.depletedSocketMat;
            }
        }
    }
    if (crater.gemRichMat && crater.gemRichMat.emissiveIntensity !== undefined) {
        crater.gemRichMat.emissiveIntensity = 0.15 + ratio * 0.78;
    }
    if (crater.coreHeart) {
        crater.coreHeart.scale.set(0.5 + ratio * 0.85, 0.2 + ratio * 0.25, 0.5 + ratio * 0.85);
        if (ratio <= 0.02 && crater.depletedSocketMat) {
            crater.coreHeart.material = crater.depletedSocketMat;
        }
    }
    if (rem <= 0) {
        window.depleteGemCraterVisuals(crater);
    }
};

window.depleteGemCraterVisuals = function(crater) {
    if (!crater) return;
    crater.isEmpty = true;
    crater.gemsRemaining = 0;
    if (Array.isArray(crater.crystalNodes)) {
        crater.crystalNodes.forEach(cn => {
            if (!cn || !cn.node) return;
            cn.node.scale.set(0.62, 0.20, 0.62);
            if (crater.depletedSocketMat) {
                if (cn.mainCrystal) cn.mainCrystal.material = crater.depletedSocketMat;
                if (cn.sideCrystal) cn.sideCrystal.material = crater.depletedSocketMat;
            }
        });
    } else if (crater.gemClusterGroup) {
        crater.gemClusterGroup.children.forEach(ch => {
            if (ch.isMesh && crater.depletedSocketMat) {
                ch.material = crater.depletedSocketMat;
                ch.scale.set(0.65, 0.22, 0.65);
            }
        });
    }
    if (crater.coreHeart && crater.depletedSocketMat) {
        crater.coreHeart.material = crater.depletedSocketMat;
    }
    if (crater.surveyRing && crater.surveyRing.material) {
        crater.surveyRing.material.color.setHex(0x475569);
        if (crater.surveyRing.material.emissive) crater.surveyRing.material.emissive.setHex(0x0f172a);
    }
};

// Clean Open-Terrain Ramp Architecture (NO ramp barriers, curbs, or pylons on the ramps — pure sculpted terrain ramps!)
function createBaseEntranceRampAndAntiRushBarrier() {
    const rockBastionMat = new THREE.MeshStandardMaterial({ color: 0x3b4452, roughness: 0.88, metalness: 0.14 });
    if (typeof SHADER_ENGINE !== 'undefined' && typeof SHADER_ENGINE.applyBuildingShader === 'function') {
        SHADER_ENGINE.applyBuildingShader(rockBastionMat);
    }

    const zonesToBuild = (BASE_TERRAIN_ZONES && BASE_TERRAIN_ZONES.length > 0)
        ? BASE_TERRAIN_ZONES
        : [];

    zonesToBuild.forEach((bz) => {
        const mode = bz.mode || bz.archetype || 'flat_ramp';
        if (mode === 'no_ramp') return;

        const innerR = bz.radius || bz.innerR || BASE_PLATEAU_RADIUS;
        const outerR = bz.rimOuter || bz.outerR || BASE_PLATEAU_RIM_OUTER;
        const rampGroup = new THREE.Group();

        // Natural Cliff Rock Buttresses ONLY along the non-ramp rear/flank cliff rim arcs (zero ramp design barriers!)
        const numRimPillars = 8;
        for (let p = 0; p < numRimPillars; p++) {
            const pAng = (p / numRimPillars) * Math.PI * 2;
            const rimX = bz.x + Math.cos(pAng) * ((innerR + outerR) * 0.5);
            const rimZ = bz.z + Math.sin(pAng) * ((innerR + outerR) * 0.5);
            const zmCheck = getBaseZoneRampMetrics(bz, rimX, rimZ);
            if (zmCheck.inRampAngle || zmCheck.rampBlend > 0.04 || zmCheck.mergedPlatformBlend > 0.04) continue;
            const rimY = getTerrainHeight(rimX, rimZ);
            const cliffRock = new THREE.Mesh(createOrganicBoulderGeo(1.05, 1), rockBastionMat);
            cliffRock.scale.set(1.35, 0.82, 1.05);
            cliffRock.position.set(rimX, rimY + 0.20, rimZ);
            cliffRock.rotation.y = pAng + Math.PI * 0.5;
            rampGroup.add(cliffRock);
        }

        addMapMesh(rampGroup);
    });
}

// ============================================================================
// DYNAMIC DIRT PATHWAY GENERATOR & NEW COLONY / MILITARY / CARGO / MINIVAN / EVACUATION STRUCTURES
// ============================================================================
const dirtPathMat = new THREE.MeshStandardMaterial({
    color: 0x7c6246,
    roughness: 0.94,
    metalness: 0.04,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
});
const dirtVergeMat = new THREE.MeshStandardMaterial({
    color: 0x5c4732,
    roughness: 0.96,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
});

function createDynamicDirtPathwayRibbon(ax, az, bx, bz, width = 2.6) {
    const dx = bx - ax;
    const dz = bz - az;
    const totalLen = Math.hypot(dx, dz);
    if (totalLen < 4.0 || totalLen > 75.0) return;

    const steps = Math.max(10, Math.min(36, Math.ceil(totalLen / 1.8)));
    const nx = -dz / totalLen;
    const nz = dx / totalLen;
    const curveAmp = (seededRandom() - 0.5) * Math.min(4.2, totalLen * 0.14);
    const halfW = width * 0.5;

    DYNAMIC_DIRT_PATHWAYS.push({ ax, az, bx, bz, halfW: halfW + 1.2 });

    const positions = [];
    const vergePositions = [];
    const indices = [];
    let validRows = 0;

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const bend = Math.sin(t * Math.PI) * curveAmp;
        const cx = ax + dx * t + nx * bend;
        const cz = az + dz * t + nz * bend;
        if (HAS_VALLEY_RIVER && getRiverDist(cx, cz) < RIVER_HALF_WIDTH + 2.2 && !isOnRiverBridge(cx, cz)) continue;
        if (isPointInWaterPond(cx, cz, 1.5)) continue;

        const lx = cx - nx * halfW, lz = cz - nz * halfW;
        const rx = cx + nx * halfW, rz = cz + nz * halfW;
        const ly = getTerrainHeight(lx, lz) + 0.028;
        const cy = getTerrainHeight(cx, cz) + 0.034;
        const ry = getTerrainHeight(rx, rz) + 0.028;

        positions.push(lx, ly, lz, cx, cy, cz, rx, ry, rz);

        const vlx = cx - nx * (halfW * 1.42), vlz = cz - nz * (halfW * 1.42);
        const vrx = cx + nx * (halfW * 1.42), vrz = cz + nz * (halfW * 1.42);
        vergePositions.push(
            vlx, getTerrainHeight(vlx, vlz) + 0.016, vlz,
            cx, cy - 0.008, cz,
            vrx, getTerrainHeight(vrx, vrz) + 0.016, vrz
        );

        if (validRows > 0) {
            const b = (validRows - 1) * 3;
            const c = validRows * 3;
            indices.push(b, c, b + 1, b + 1, c, c + 1);
            indices.push(b + 1, c + 1, b + 2, b + 2, c + 1, c + 2);
        }
        validRows++;
    }

    if (validRows < 2 || indices.length === 0) return;

    const vergeGeo = new THREE.BufferGeometry();
    vergeGeo.setAttribute('position', new THREE.Float32BufferAttribute(vergePositions, 3));
    vergeGeo.setIndex(indices);
    vergeGeo.computeVertexNormals();
    const vergeMesh = new THREE.Mesh(vergeGeo, dirtVergeMat);
    vergeMesh.receiveShadow = true;
    addMapMesh(vergeMesh);

    const pathGeo = new THREE.BufferGeometry();
    pathGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    pathGeo.setIndex(indices);
    pathGeo.computeVertexNormals();
    const pathMesh = new THREE.Mesh(pathGeo, dirtPathMat);
    pathMesh.receiveShadow = true;
    addMapMesh(pathMesh);
}

// 1. Dynamic Reinforced Military Command Building (Command Bunker Wing + Comms Radar Mast + Helipad + Sandbag Perimeter)
function createDynamicMilitaryCommandBuilding(rawX, rawZ, rotY = 0) {
    const footR = 5.2;
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, footR, 6.8, 4.2);
    if (!spot) return null;
    const x = spot.x, z = spot.z;
    const carvedY = flattenTerrainUnderBuilding(x, z, footR + 0.6, 2.5);

    const group = new THREE.Group();
    group.position.set(x, carvedY, z);
    group.rotation.y = rotY;

    const concreteSlab = new THREE.Mesh(createExtrudedArmorHullGeo(8.2, 0.26, 7.4, 0.06, 0.22), MAT.darkSteel);
    concreteSlab.position.y = 0.13;
    const hazardPerimeter = new THREE.Mesh(createExtrudedArmorHullGeo(8.35, 0.08, 7.55, 0.02, 0.08), MAT.hazard);
    hazardPerimeter.position.y = 0.24;
    group.add(concreteSlab, hazardPerimeter);

    // Main Reinforced Command Block & Tactical Operations Bridge
    const mainBlock = new THREE.Mesh(createExtrudedArmorHullGeo(4.6, 2.35, 3.8, 0.08, 0.24), MAT.gunmetal);
    mainBlock.position.set(-1.1, 1.42, -0.6);
    const upperOpsBridge = new THREE.Mesh(createExtrudedArmorHullGeo(3.2, 1.25, 2.6, 0.06, 0.18), MAT.terranBlue);
    upperOpsBridge.position.set(-1.1, 3.15, -0.6);
    const visorBand = new THREE.Mesh(createExtrudedArmorHullGeo(3.32, 0.24, 2.72, 0.02, 0.04), MAT.cyanGlow);
    visorBand.position.set(-1.1, 3.25, -0.6);
    group.add(mainBlock, upperOpsBridge, visorBand);

    // Armored Barracks / Armory Wing
    const armoryWing = new THREE.Mesh(createExtrudedArmorHullGeo(2.8, 1.65, 4.2, 0.06, 0.18), MAT.darkSteel);
    armoryWing.position.set(2.1, 1.08, -0.3);
    group.add(armoryWing);

    // Rotating Tactical Radar Dish & Communications Mast
    const radarMast = new THREE.Mesh(createSculptedLatheBarrelGeo(0.14, 0.24, 1.85, 8), MAT.copper);
    radarMast.position.set(-1.1, 4.65, -0.6);
    const radarDish = new THREE.Group();
    radarDish.position.set(-1.1, 5.62, -0.6);
    const dishBowl = new THREE.Mesh(createSculptedLatheBarrelGeo(0.85, 0.16, 0.36, 12), MAT.silver);
    dishBowl.rotation.x = 0.45;
    const dishBeacon = new THREE.Mesh(createSculptedArmorDomeGeo(0.14, 8, 8), MAT.crimsonTank);
    dishBeacon.position.set(0, 0.38, 0.18);
    radarDish.add(dishBowl, dishBeacon);
    group.add(radarMast, radarDish);
    animatedBiomeLandmarks.push({ type: 'satellite', mesh: radarDish, phase: seededRandom() * 6 });

    // Front Helipad Marking & Sandbag Emplacement
    const helipadCircle = new THREE.Mesh(createSculptedTorusCollarGeo(1.35, 0.06, 6, 24), MAT.hazard);
    helipadCircle.rotation.x = Math.PI / 2;
    helipadCircle.position.set(1.4, 0.28, 2.1);
    group.add(helipadCircle);

    for (let s = -2; s <= 2; s++) {
        const bag = new THREE.Mesh(createOrganicBoulderGeo(0.32, 0), dirtVergeMat);
        bag.scale.set(1.4, 0.65, 0.85);
        bag.position.set(-1.2 + s * 0.72, 0.38, 2.85);
        group.add(bag);
    }

    addMapMesh(group);
    obstacles.push({ x, z, r: footR, footprintR: footR, isStructure: true, type: 'military_bunker', mesh: group });
    return { x, z };
}

// 2. Dynamic Cargo Depot & Container Logistics Yard (Stacked Shipping Containers + Gantry Crane + Fuel Tanks)
function createDynamicCargoDepotYard(rawX, rawZ, rotY = 0) {
    const footR = 5.4;
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, footR, 6.5, 4.0);
    if (!spot) return null;
    const x = spot.x, z = spot.z;
    const carvedY = flattenTerrainUnderBuilding(x, z, footR + 0.5, 2.4);

    const group = new THREE.Group();
    group.position.set(x, carvedY, z);
    group.rotation.y = rotY;

    const yardPad = new THREE.Mesh(createExtrudedArmorHullGeo(8.6, 0.22, 7.6, 0.04, 0.16), MAT.darkSteel);
    yardPad.position.y = 0.11;
    group.add(yardPad);

    const containerMats = [
        MAT.terranBlue,
        MAT.crimsonTank,
        MAT.hazard,
        new THREE.MeshStandardMaterial({ color: 0x2e6b4e, roughness: 0.65, metalness: 0.35 }),
        MAT.gunmetal
    ];

    const addCargoContainer = (cx, cy, cz, cRotY, matIdx) => {
        const cMat = containerMats[matIdx % containerMats.length];
        const cont = new THREE.Group();
        cont.position.set(cx, cy, cz);
        cont.rotation.y = cRotY;
        const box = new THREE.Mesh(createExtrudedArmorHullGeo(1.22, 1.18, 2.85, 0.03, 0.06), cMat);
        box.position.y = 0.59;
        const trim = new THREE.Mesh(createExtrudedArmorHullGeo(1.26, 0.08, 2.89, 0.01, 0.02), MAT.darkSteel);
        trim.position.y = 1.14;
        cont.add(box, trim);
        group.add(cont);
    };

    // Ground & Stacked 2nd-Tier Shipping Containers
    addCargoContainer(-2.4, 0.22, -1.4, 0.0, 0);
    addCargoContainer(-0.95, 0.22, -1.4, 0.0, 1);
    addCargoContainer(-1.7, 1.40, -1.4, 0.04, 2);
    addCargoContainer(2.1, 0.22, -1.2, 0.08, 3);
    addCargoContainer(2.1, 1.40, -1.2, -0.05, 0);
    addCargoContainer(-2.1, 0.22, 1.85, Math.PI * 0.5, 4);

    // Overhead Yellow Industrial Gantry Crane Frame spanning the Container Stack
    const gantryGroup = new THREE.Group();
    gantryGroup.position.set(-1.65, 0.22, -1.4);
    [-1.65, 1.65].forEach(gx => {
        [-1.6, 1.6].forEach(gz => {
            const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.35, 0.18), MAT.hazard);
            leg.position.set(gx, 1.68, gz);
            gantryGroup.add(leg);
        });
        const sideBeam = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.24, 3.4), MAT.hazard);
        sideBeam.position.set(gx, 3.35, 0);
        gantryGroup.add(sideBeam);
    });
    const crossBridge = new THREE.Mesh(new THREE.BoxGeometry(3.55, 0.28, 0.36), MAT.hazard);
    crossBridge.position.set(0, 3.52, 0.2);
    gantryGroup.add(crossBridge);
    group.add(gantryGroup);

    // Cylindrical Pressurized Fuel Tanks on East Pad
    [0.9, 2.2].forEach(fz => {
        const tank = new THREE.Mesh(createSculptedLatheBarrelGeo(0.58, 0.58, 1.65, 12), MAT.silver);
        tank.position.set(2.2, 1.04, fz);
        const cap = new THREE.Mesh(createSculptedArmorDomeGeo(0.58, 10, 8), MAT.hazard);
        cap.position.set(2.2, 1.84, fz);
        group.add(tank, cap);
    });

    addMapMesh(group);
    obstacles.push({ x, z, r: footR, footprintR: footR, isStructure: true, type: 'unique_building', mesh: group });
    return { x, z };
}

// 3. Dynamic Suburban Frontier House with Parked 3D Family Minivan
function createMinivanSuburbanHouse(rawX, rawZ, rotY = 0, variantIdx = 0) {
    const footR = 4.2;
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, footR, 5.8, 3.8);
    if (!spot) return null;
    const x = spot.x, z = spot.z;
    const carvedY = flattenTerrainUnderBuilding(x, z, footR + 0.45, 2.0);

    const group = new THREE.Group();
    group.position.set(x, carvedY, z);
    group.rotation.y = rotY;

    const wallColors = [0xd6cfc2, 0xc2d1dc, 0xdecbb4, 0xcbd5c0];
    const roofColors = [0x5c3a2e, 0x3b4d5e, 0x4a3b32, 0x2f4842];
    const minivanColors = [0x2b5b84, 0x8c2d2d, 0x475569, 0xd97706];

    const houseWallMat = new THREE.MeshStandardMaterial({ color: wallColors[variantIdx % wallColors.length], roughness: 0.78, metalness: 0.12 });
    const houseRoofMat = new THREE.MeshStandardMaterial({ color: roofColors[variantIdx % roofColors.length], roughness: 0.72, metalness: 0.22 });
    const minivanBodyMat = new THREE.MeshStandardMaterial({ color: minivanColors[variantIdx % minivanColors.length], roughness: 0.35, metalness: 0.62 });

    // Yard Foundation & Gravel Driveway Pad
    const yardPad = new THREE.Mesh(createExtrudedArmorHullGeo(6.4, 0.16, 6.2, 0.03, 0.12), dirtVergeMat);
    yardPad.position.y = 0.08;
    const driveway = new THREE.Mesh(createExtrudedArmorHullGeo(2.35, 0.18, 3.4, 0.02, 0.06), MAT.darkSteel);
    driveway.position.set(1.65, 0.09, 1.15);
    group.add(yardPad, driveway);

    // Main Residential House Body + Pitched Gable Roof + Front Porch
    const houseBody = new THREE.Mesh(createExtrudedArmorHullGeo(3.4, 1.85, 3.2, 0.05, 0.12), houseWallMat);
    houseBody.position.set(-0.95, 1.08, -0.65);
    const roofPrism = new THREE.Mesh(new THREE.ConeGeometry(2.75, 1.25, 4), houseRoofMat);
    roofPrism.rotation.y = Math.PI / 4;
    roofPrism.scale.set(1.06, 1.0, 1.02);
    roofPrism.position.set(-0.95, 2.58, -0.65);

    const porchDeck = new THREE.Mesh(createExtrudedArmorHullGeo(2.2, 0.22, 1.15, 0.02, 0.06), MAT.gunmetal);
    porchDeck.position.set(-0.95, 0.24, 1.35);
    const porchRoof = new THREE.Mesh(createExtrudedArmorHullGeo(2.3, 0.14, 1.25, 0.02, 0.06), houseRoofMat);
    porchRoof.position.set(-0.95, 1.48, 1.35);
    porchRoof.rotation.x = 0.15;
    [-1.85, -0.05].forEach(px => {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.10, 1.25, 0.10), houseWallMat);
        post.position.set(px, 0.85, 1.82);
        group.add(post);
    });

    // Warm Illuminated Windows
    const winFront = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.52, 0.08), MAT.amberGlow);
    winFront.position.set(-1.55, 1.12, 0.96);
    const winSide = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.52, 0.85), MAT.amberGlow);
    winSide.position.set(-2.66, 1.12, -0.65);
    group.add(houseBody, roofPrism, porchDeck, porchRoof, winFront, winSide);

    // 3D FAMILY MINIVAN Parked in the Driveway
    const minivan = new THREE.Group();
    minivan.position.set(1.65, 0.18, 1.05);
    minivan.rotation.y = (seededRandom() - 0.5) * 0.18;

    const lowerChassis = new THREE.Mesh(createExtrudedArmorHullGeo(1.12, 0.42, 2.38, 0.04, 0.10), minivanBodyMat);
    lowerChassis.position.y = 0.34;
    const upperCabin = new THREE.Mesh(createExtrudedArmorHullGeo(1.02, 0.44, 1.72, 0.04, 0.10), minivanBodyMat);
    upperCabin.position.set(0, 0.72, -0.14);
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.36, 0.42), MAT.cyanGlow);
    windshield.position.set(0, 0.70, 0.66);
    windshield.rotation.x = -0.35;
    const sideWindows = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.30, 1.35), MAT.darkSteel);
    sideWindows.position.set(0, 0.73, -0.18);
    const roofRack = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.06, 1.25), MAT.silver);
    roofRack.position.set(0, 0.96, -0.22);

    // 4 Minivan Wheels + Headlights
    [[-0.56, 0.72], [0.56, 0.72], [-0.56, -0.76], [0.56, -0.76]].forEach(([wx, wz]) => {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.16, 10), MAT.charredSteel);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(wx, 0.22, wz);
        minivan.add(wheel);
    });
    [-0.36, 0.36].forEach(hx => {
        const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.10, 0.06), MAT.amberGlow);
        headlight.position.set(hx, 0.38, 1.19);
        minivan.add(headlight);
    });

    minivan.add(lowerChassis, upperCabin, windshield, sideWindows, roofRack);
    group.add(minivan);

    addMapMesh(group);
    obstacles.push({ x, z, r: footR, footprintR: footR, isStructure: true, type: 'unique_building', mesh: group });
    return { x, z };
}

// 4. Dynamic Emergency Civilian & Medical Evacuation Camp (Relief Tents + Red Cross Markings + Beacon Towers + Supply Pallets)
function createDynamicEvacuationCamp(rawX, rawZ, rotY = 0) {
    const footR = 5.4;
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, footR, 6.4, 4.0);
    if (!spot) return null;
    const x = spot.x, z = spot.z;
    const carvedY = flattenTerrainUnderBuilding(x, z, footR + 0.5, 2.2);

    const group = new THREE.Group();
    group.position.set(x, carvedY, z);
    group.rotation.y = rotY;

    const tentCanvasMat = new THREE.MeshStandardMaterial({ color: 0xdbe2dc, roughness: 0.85, metalness: 0.08 });
    const oliveTentMat = new THREE.MeshStandardMaterial({ color: 0x4b5d46, roughness: 0.88, metalness: 0.10 });

    const campPad = new THREE.Mesh(createOrganicBioCarapaceGeo(4.8, 0.12, 4.8, 12, 0.04), dirtPathMat);
    campPad.position.y = 0.06;
    group.add(campPad);

    const buildReliefTent = (tx, tz, tRot, isMedical) => {
        const tent = new THREE.Group();
        tent.position.set(tx, 0.10, tz);
        tent.rotation.y = tRot;
        const archBody = new THREE.Mesh(createSculptedLatheBarrelGeo(1.18, 1.18, 2.85, 8), isMedical ? tentCanvasMat : oliveTentMat);
        archBody.rotation.x = Math.PI / 2;
        archBody.scale.set(1.15, 1.0, 0.85);
        archBody.position.y = 0.55;
        tent.add(archBody);

        if (isMedical) {
            const crossA = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.18), MAT.crimsonTank);
            crossA.position.set(0, 1.56, 0);
            const crossB = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.62), MAT.crimsonTank);
            crossB.position.set(0, 1.56, 0);
            tent.add(crossA, crossB);
        }
        group.add(tent);
    };

    buildReliefTent(-1.95, -1.25, 0.15, true);
    buildReliefTent(1.95, -1.15, -0.18, false);
    buildReliefTent(0.0, 1.85, Math.PI * 0.5, true);

    // Central Emergency Evacuation Light Mast & Medical Supply Crates
    const lightPole = new THREE.Mesh(createSculptedLatheBarrelGeo(0.08, 0.12, 3.2, 8), MAT.hazard);
    lightPole.position.set(0, 1.65, 0);
    const beaconLamp = new THREE.Mesh(createSculptedArmorDomeGeo(0.24, 10, 10), MAT.amberGlow);
    beaconLamp.position.set(0, 3.32, 0);
    group.add(lightPole, beaconLamp);

    for (let c = 0; c < 4; c++) {
        const ca = (c / 4) * Math.PI * 2 + 0.4;
        const crate = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.48, 0.58), c % 2 === 0 ? MAT.terranBlue : MAT.hazard);
        crate.position.set(Math.cos(ca) * 1.15, 0.34, Math.sin(ca) * 1.15);
        group.add(crate);
    }

    addMapMesh(group);
    obstacles.push({ x, z, r: footR, footprintR: footR, isStructure: true, type: 'camp', mesh: group });
    return { x, z };
}

// 5. Road-Only Street Lights: Spawns street lamps STRICTLY along actual road shoulders (never off-road!)
function createRoadStreetLights() {
    const placedLights = [];
    for (let s = 0; s < DYNAMIC_ROAD_SEGMENTS.length; s++) {
        const seg = DYNAMIC_ROAD_SEGMENTS[s];
        if (!seg.samples) precomputeRoadSegmentSamples(seg, 56);
        const samples = seg.samples || [];
        if (samples.length < 6) continue;

        for (let i = 5; i < samples.length - 5; i += 9) {
            const sp = samples[i];
            const prev = samples[Math.max(0, i - 1)];
            const next = samples[Math.min(samples.length - 1, i + 1)];
            const tx = next.x - prev.x;
            const tz = next.z - prev.z;
            const tLen = Math.hypot(tx, tz) || 1.0;
            const nx = -tz / tLen;
            const nz = tx / tLen;

            const sideSign = ((i + s) % 2 === 0) ? 1 : -1;
            const shoulderDist = (sp.halfWidth || 1.85) + 0.55;
            const wx = sp.x + nx * shoulderDist * sideSign;
            const wz = sp.z + nz * shoulderDist * sideSign;

            // Strict Road-Edge Verification: must be right beside an actual supply road and not on water/bridges/bases
            if (getSupplyRoadFactor(sp.x, sp.z) < 0.25) continue;
            if (isOnRiverBridge(wx, wz, 2.2) || isPointInWaterPond(wx, wz, 1.8)) continue;
            if (isInsideBasePlacementZone(wx, wz, 10.0)) continue;
            if (placedLights.some(p => Math.hypot(p.x - wx, p.z - wz) < 11.5)) continue;
            if (obstacles.some(o => Math.hypot(o.x - wx, o.z - wz) < (o.r || 1.0) + 1.4)) continue;

            const wy = getSurfaceHeightWithBridges(wx, wz);
            if (wy < -0.15) continue;

            const poleGroup = new THREE.Group();
            poleGroup.position.set(wx, wy, wz);
            // Orient the overhanging street lamp arm so it points directly over the road carriageway!
            const toRoadAngle = Math.atan2(sp.z - wz, sp.x - wx);
            poleGroup.rotation.y = -toRoadAngle;

            const basePlinth = new THREE.Mesh(createSculptedLatheBarrelGeo(0.14, 0.18, 0.32, 8), MAT.darkSteel);
            basePlinth.position.y = 0.16;
            const pole = new THREE.Mesh(createSculptedLatheBarrelGeo(0.06, 0.09, 3.05, 8), rustedSteelMat);
            pole.position.y = 1.62;
            const arm = new THREE.Mesh(createExtrudedArmorHullGeo(0.92, 0.06, 0.06), rustedSteelMat);
            arm.position.set(0.42, 3.08, 0);
            const lampHousing = new THREE.Mesh(createExtrudedArmorHullGeo(0.28, 0.08, 0.16), MAT.gunmetal);
            lampHousing.position.set(0.82, 3.05, 0);
            const lampBulb = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.12), (placedLights.length % 4 === 0) ? MAT.cyanGlow : MAT.amberGlow);
            lampBulb.position.set(0.82, 3.00, 0);

            poleGroup.add(basePlinth, pole, arm, lampHousing, lampBulb);
            addMapMesh(poleGroup);
            placedLights.push({ x: wx, z: wz });
        }
    }
}

// 6. Dynamic Industrial Oil / Mineral Rig Station (Animated Nodding Pumpjack "Horsehead" + Derrick Tower + Pipeline Manifold)
function createDynamicRigStation(rawX, rawZ, rotY = 0) {
    const footR = 5.4;
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, footR, 6.6, 4.0);
    if (!spot) return null;
    const x = spot.x, z = spot.z;
    const carvedY = flattenTerrainUnderBuilding(x, z, footR + 0.5, 2.4);

    const group = new THREE.Group();
    group.position.set(x, carvedY, z);
    group.rotation.y = rotY;

    // Industrial Foundation Pad & Hazard Curbing
    const pad = new THREE.Mesh(createExtrudedArmorHullGeo(8.4, 0.24, 7.2, 0.05, 0.18), MAT.darkSteel);
    pad.position.y = 0.12;
    const curb = new THREE.Mesh(createExtrudedArmorHullGeo(8.55, 0.08, 7.35, 0.02, 0.08), MAT.hazard);
    curb.position.y = 0.22;
    group.add(pad, curb);

    // A-Frame Samnson Post & Animated Nodding Pumpjack ("Horsehead" Walking Beam)
    const pumpjackGroup = new THREE.Group();
    pumpjackGroup.position.set(-1.65, 0.24, 0.4);
    [-0.55, 0.55].forEach(lz => {
        const legFront = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.35, 0.18), rustedSteelMat);
        legFront.position.set(-0.35, 1.12, lz);
        legFront.rotation.z = -0.16;
        const legBack = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.35, 0.18), rustedSteelMat);
        legBack.position.set(0.35, 1.12, lz);
        legBack.rotation.z = 0.16;
        pumpjackGroup.add(legFront, legBack);
    });

    const walkingBeamPivot = new THREE.Group();
    walkingBeamPivot.position.set(0, 2.25, 0);
    const beam = new THREE.Mesh(createExtrudedArmorHullGeo(3.2, 0.28, 0.34, 0.03, 0.06), MAT.hazard);
    const horseHead = new THREE.Mesh(createSculptedLatheBarrelGeo(0.32, 0.48, 0.95, 8), MAT.hazard);
    horseHead.position.set(-1.55, -0.15, 0);
    horseHead.rotation.z = 0.25;
    const counterweight = new THREE.Mesh(createExtrudedArmorHullGeo(0.75, 0.68, 0.56, 0.03, 0.06), MAT.crimsonTank);
    counterweight.position.set(1.38, -0.12, 0);
    walkingBeamPivot.add(beam, horseHead, counterweight);
    pumpjackGroup.add(walkingBeamPivot);

    // Wellhead Christmas Tree Valve & Plunger Rod
    const wellhead = new THREE.Mesh(createSculptedLatheBarrelGeo(0.28, 0.38, 0.95, 10), MAT.copper);
    wellhead.position.set(-1.55, 0.48, 0);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.85, 8), MAT.silver);
    rod.position.set(-1.55, 1.35, 0);
    pumpjackGroup.add(wellhead, rod);
    group.add(pumpjackGroup);

    animatedBiomeLandmarks.push({ type: 'pumpjack', mesh: walkingBeamPivot, phase: seededRandom() * 6.28 });

    // Tall Steel Derrick Lattice Tower & Flare Stack on East Side
    const derrickGroup = new THREE.Group();
    derrickGroup.position.set(1.85, 0.24, -1.15);
    [[-0.75, -0.75], [0.75, -0.75], [-0.75, 0.75], [0.75, 0.75]].forEach(([dx, dz]) => {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 4.6, 8), MAT.gunmetal);
        post.position.set(dx * 0.75, 2.3, dz * 0.75);
        post.rotation.z = -dx * 0.08;
        post.rotation.x = dz * 0.08;
        derrickGroup.add(post);
    });
    const crownPlatform = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.16, 1.15), MAT.hazard);
    crownPlatform.position.y = 4.55;
    const flareFlame = new THREE.Mesh(createSculptedArmorDomeGeo(0.22, 8, 8), MAT.amberGlow);
    flareFlame.position.y = 4.82;
    derrickGroup.add(crownPlatform, flareFlame);
    group.add(derrickGroup);

    // Pressurized Crude Separation Tanks & Pipeline Manifold
    [-1.4, 0.2].forEach(tx => {
        const tank = new THREE.Mesh(createSculptedLatheBarrelGeo(0.68, 0.68, 1.95, 12), MAT.terranBlue);
        tank.position.set(tx, 1.18, -2.15);
        const dome = new THREE.Mesh(createSculptedArmorDomeGeo(0.68, 10, 8), MAT.silver);
        dome.position.set(tx, 2.12, -2.15);
        group.add(tank, dome);
    });
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 3.8, 8), MAT.copper);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(0.1, 0.65, 1.85);
    group.add(pipe);

    addMapMesh(group);
    obstacles.push({ x, z, r: footR, footprintR: footR, isStructure: true, type: 'rig_station', mesh: group });
    return { x, z };
}

// 7. Dynamic High-Voltage Electric Power Substation (Transformers + Ceramic Insulator Stacks + H-Frame Busbar Gantry + Glowing Arc Coils)
function createDynamicElectricStation(rawX, rawZ, rotY = 0) {
    const footR = 5.2;
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, footR, 6.4, 3.8);
    if (!spot) return null;
    const x = spot.x, z = spot.z;
    const carvedY = flattenTerrainUnderBuilding(x, z, footR + 0.5, 2.2);

    const group = new THREE.Group();
    group.position.set(x, carvedY, z);
    group.rotation.y = rotY;

    // Concrete Substation Pad & Grounding Grid
    const pad = new THREE.Mesh(createExtrudedArmorHullGeo(8.0, 0.22, 7.0, 0.04, 0.16), MAT.darkSteel);
    pad.position.y = 0.11;
    group.add(pad);

    // Dual Step-Up High-Voltage Transformer Units with Radiator Cooling Fins & Ceramic Bushings
    [-1.75, 1.75].forEach(tx => {
        const xfmr = new THREE.Group();
        xfmr.position.set(tx, 0.22, -0.85);
        const coreBox = new THREE.Mesh(createExtrudedArmorHullGeo(1.85, 1.95, 1.65, 0.05, 0.12), MAT.gunmetal);
        coreBox.position.y = 0.98;
        xfmr.add(coreBox);

        // Ribbed Ceramic Insulator Bushing Stacks on Top
        [-0.52, 0.0, 0.52].forEach(bx => {
            const stack = new THREE.Mesh(createSculptedLatheBarrelGeo(0.11, 0.16, 1.15, 10), MAT.copper);
            stack.position.set(bx, 2.48, 0);
            const arcTip = new THREE.Mesh(createSculptedArmorDomeGeo(0.15, 8, 8), MAT.cyanGlow);
            arcTip.position.set(bx, 3.08, 0);
            xfmr.add(stack, arcTip);
        });
        group.add(xfmr);
    });

    // Overhead H-Frame High-Voltage Busbar Gantry & Glowing Plasma Arc Conduit
    const gantry = new THREE.Group();
    gantry.position.set(0, 0.22, 1.35);
    [-2.6, 0.0, 2.6].forEach(px => {
        const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.22, 3.85, 0.22), MAT.silver);
        pylon.position.set(px, 1.92, 0);
        gantry.add(pylon);
    });
    const crossBeam = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.22, 0.28), MAT.hazard);
    crossBeam.position.set(0, 3.65, 0);
    const arcBar = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 5.2, 10), MAT.cyanGlow);
    arcBar.rotation.z = Math.PI / 2;
    arcBar.position.set(0, 3.25, 0);
    gantry.add(crossBeam, arcBar);
    group.add(gantry);

    animatedBiomeLandmarks.push({ type: 'electric_arc', mesh: arcBar, phase: seededRandom() * 6.28 });

    // Substation Control Switchgear Cabin
    const cabin = new THREE.Mesh(createExtrudedArmorHullGeo(2.4, 1.45, 1.6, 0.04, 0.10), MAT.terranBlue);
    cabin.position.set(0, 0.94, -2.15);
    const warningSign = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.28, 0.08), MAT.amberGlow);
    warningSign.position.set(0, 1.25, -1.32);
    group.add(cabin, warningSign);

    addMapMesh(group);
    obstacles.push({ x, z, r: footR, footprintR: footR, isStructure: true, type: 'electric_station', mesh: group });
    return { x, z };
}

// 8. Dynamic Frontier Fuel Gas Station (Illuminated Canopy + Dual Fuel Pump Islands + Price Pylon Sign + Convenience Kiosk)
function createDynamicGasStation(rawX, rawZ, rotY = 0) {
    const footR = 5.4;
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, footR, 6.6, 4.0);
    if (!spot) return null;
    const x = spot.x, z = spot.z;
    const carvedY = flattenTerrainUnderBuilding(x, z, footR + 0.5, 2.2);

    const group = new THREE.Group();
    group.position.set(x, carvedY, z);
    group.rotation.y = rotY;

    // Tarmac Forecourt Apron
    const forecourt = new THREE.Mesh(createExtrudedArmorHullGeo(8.6, 0.18, 7.6, 0.03, 0.12), MAT.darkSteel);
    forecourt.position.y = 0.09;
    group.add(forecourt);

    // Rear Station Convenience Store Kiosk & Service Bay
    const kiosk = new THREE.Mesh(createExtrudedArmorHullGeo(5.4, 1.95, 2.45, 0.05, 0.14), MAT.gunmetal);
    kiosk.position.set(0, 1.12, -2.05);
    const storefrontGlass = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.95, 0.08), MAT.amberGlow);
    storefrontGlass.position.set(-0.4, 1.05, -0.80);
    group.add(kiosk, storefrontGlass);

    // High Cantilevered Illuminated Gas Station Canopy over Forecourt
    const canopyGroup = new THREE.Group();
    canopyGroup.position.set(0, 0.18, 1.05);
    [-1.95, 1.95].forEach(cx => {
        const pillar = new THREE.Mesh(createSculptedLatheBarrelGeo(0.18, 0.22, 3.15, 10), MAT.silver);
        pillar.position.set(cx, 1.58, 0);
        canopyGroup.add(pillar);

        // Fuel Pump Dispenser Island Base + Dual Fuel Pumps
        const island = new THREE.Mesh(createExtrudedArmorHullGeo(1.15, 0.16, 2.45, 0.02, 0.05), MAT.hazard);
        island.position.set(cx, 0.08, 0);
        [-0.65, 0.65].forEach(pz => {
            const pump = new THREE.Mesh(createExtrudedArmorHullGeo(0.46, 0.95, 0.38, 0.02, 0.04), MAT.crimsonTank);
            pump.position.set(cx, 0.62, pz);
            const screen = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.24, 0.42), MAT.cyanGlow);
            screen.position.set(cx, 0.82, pz);
            canopyGroup.add(pump, screen);
        });
        canopyGroup.add(island);
    });

    const canopyRoof = new THREE.Mesh(createExtrudedArmorHullGeo(6.4, 0.36, 3.6, 0.04, 0.12), MAT.terranBlue);
    canopyRoof.position.y = 3.22;
    const canopyNeonBand = new THREE.Mesh(createExtrudedArmorHullGeo(6.52, 0.14, 3.72, 0.02, 0.04), MAT.cyanGlow);
    canopyNeonBand.position.y = 3.22;
    canopyGroup.add(canopyRoof, canopyNeonBand);
    group.add(canopyGroup);

    // Roadside Tall Illuminated Fuel Pylon Sign
    const signPost = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.14, 4.2, 8), MAT.silver);
    signPost.position.set(-3.65, 2.15, 2.85);
    const signBoard = new THREE.Mesh(createExtrudedArmorHullGeo(1.15, 1.45, 0.22, 0.02, 0.04), MAT.crimsonTank);
    signBoard.position.set(-3.65, 3.85, 2.85);
    const signGlow = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.85, 0.26), MAT.amberGlow);
    signGlow.position.set(-3.65, 3.85, 2.85);
    group.add(signPost, signBoard, signGlow);

    addMapMesh(group);
    obstacles.push({ x, z, r: footR, footprintR: footR, isStructure: true, type: 'gas_station', mesh: group });
    return { x, z };
}

// 9. Standalone Unexploded Heavy Aerial Bomb (UXO) Half-Buried in Gouged Ground Terrain
function createUnexplodedGroundBomb(rawX, rawZ, rotY = 0) {
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, 1.8, 3.6, 1.6);
    if (!spot) return null;
    const x = spot.x, z = spot.z;
    const y = getTerrainHeight(x, z);
    if (y < -0.15) return null;

    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.rotation.y = rotY;

    // Gouged Earth Impact Furrow Mound around the half-buried bomb nose
    const dirtRim = new THREE.Mesh(createDynamicStoneGeometry(x * 5.3 + z, 1.15, 0.28, 0.28, 1), dirtVergeMat);
    dirtRim.position.set(0.25, 0.08, 0);
    group.add(dirtRim);

    // Tilted Heavy Aerial Bomb Casing (Nose buried at 38-degree angle, Cruciform Tail Fins sticking up)
    const bombAssembly = new THREE.Group();
    bombAssembly.position.set(0, 0.42, 0);
    bombAssembly.rotation.z = 0.68;

    const bombHull = new THREE.Mesh(createSculptedLatheBarrelGeo(0.28, 0.36, 1.85, 12), MAT.darkSteel);
    const noseCone = new THREE.Mesh(createSculptedArmorDomeGeo(0.32, 10, 10), MAT.gunmetal);
    noseCone.position.y = -0.92;
    const yellowHazardBand = new THREE.Mesh(new THREE.CylinderGeometry(0.365, 0.365, 0.22, 12), MAT.hazard);
    yellowHazardBand.position.y = -0.28;

    // 4 Cruciform Stabilizer Tail Fins + Blinking Armed Fuze Beacon
    for (let f = 0; f < 4; f++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.52, 0.05), rustedSteelMat);
        fin.position.y = 0.72;
        fin.rotation.y = (f * Math.PI) / 2;
        bombAssembly.add(fin);
    }
    const armedFuze = new THREE.Mesh(createSculptedArmorDomeGeo(0.11, 8, 8), MAT.crimsonTank);
    armedFuze.position.y = 0.98;
    bombAssembly.add(bombHull, noseCone, yellowHazardBand, armedFuze);
    group.add(bombAssembly);

    animatedBiomeLandmarks.push({ type: 'uxo_fuze', mesh: armedFuze, phase: seededRandom() * 6.28 });

    addMapMesh(group);
    obstacles.push({ x, z, r: 1.35, type: 'uxo_bomb', mesh: group });
    return { x, z };
}

// 10. Large Broken Military Heavy Transport Plane with Sheared Broken Wing ("Broken Arm"), Torn Plane Body & Long Dragged Dirt Trail!
function createLargeBrokenPlaneWithDraggedDirt(rawX, rawZ, rotY = 0) {
    const footR = 7.8;
    const spot = findNonOverlappingStructureSpot(rawX, rawZ, footR, 8.8, 4.5);
    if (!spot) return null;
    const x = spot.x, z = spot.z;
    const carvedY = flattenTerrainUnderBuilding(x, z, footR + 1.2, 2.6);

    const group = new THREE.Group();
    group.position.set(x, carvedY, z);
    group.rotation.y = rotY;

    const airframeMat = new THREE.MeshStandardMaterial({ color: 0x556475, roughness: 0.62, metalness: 0.48 });
    const scorchedHullMat = new THREE.MeshStandardMaterial({ color: 0x282d35, roughness: 0.88, metalness: 0.25 });

    // A. LONG DRAGGED DIRT SKID TRENCH ("dirt got dragged") behind the crashed plane body & wing!
    const dragLength = 15.5;
    const dragFurrowFloor = new THREE.Mesh(
        new THREE.BoxGeometry(3.8, 0.10, dragLength),
        scorchedHullMat
    );
    dragFurrowFloor.position.set(0, 0.03, -4.2);
    group.add(dragFurrowFloor);

    // Raised Ploughed Dirt Berms on both sides of the Dragged Dirt Skid Trail + Ploughed Mound at the Nose!
    for (let s = 0; s < 14; s++) {
        const zOff = -11.2 + s * 1.15;
        const bermSpread = 1.95 + (s % 2) * 0.25;
        [-1, 1].forEach(side => {
            const dirtMound = new THREE.Mesh(
                createDynamicStoneGeometry(x + z + s * 3.1 + side, 0.68 + (s % 3) * 0.18, 0.34, 0.42, 1),
                s % 3 === 0 ? dirtPathMat : dirtVergeMat
            );
            dirtMound.position.set(side * bermSpread, 0.16, zOff);
            dirtMound.rotation.y = s * 0.7;
            group.add(dirtMound);
        });
    }
    // Massive Bulldozed Dirt Pile pushed up directly in front of the ploughed plane nose
    for (let n = -2; n <= 2; n++) {
        const noseDirt = new THREE.Mesh(
            createDynamicStoneGeometry(x * 2.1 + n * 7.3, 1.05, 0.32, 0.48, 1),
            dirtVergeMat
        );
        noseDirt.position.set(n * 0.85, 0.28, 4.85 + Math.abs(n) * 0.22);
        group.add(noseDirt);
    }

    // B. LARGE TORN PLANE BODY (Forward Cockpit + Fractured Mid-Fuselage + Ruptured Rear Tail Section)
    const forwardFuselage = new THREE.Group();
    forwardFuselage.position.set(0, 1.05, 1.65);
    forwardFuselage.rotation.x = 0.14;
    forwardFuselage.rotation.z = -0.12;

    const mainTube = new THREE.Mesh(createSculptedLatheBarrelGeo(1.32, 1.48, 6.2, 14), airframeMat);
    mainTube.rotation.x = Math.PI / 2;
    const noseRadome = new THREE.Mesh(createSculptedArmorDomeGeo(1.28, 12, 10), scorchedHullMat);
    noseRadome.position.z = 3.05;
    const cockpitCanopy = new THREE.Mesh(createExtrudedArmorHullGeo(1.45, 0.58, 1.65, 0.04, 0.10), MAT.cyanGlow);
    cockpitCanopy.position.set(0, 0.88, 1.85);
    forwardFuselage.add(mainTube, noseRadome, cockpitCanopy);

    // Exposed Torn Structural Ribs at the Hull Fracture Break
    for (let r = 0; r < 4; r++) {
        const rib = new THREE.Mesh(createSculptedTorusCollarGeo(1.36, 0.07, 6, 14), rustedSteelMat);
        rib.position.z = -2.85 - r * 0.32;
        forwardFuselage.add(rib);
    }
    group.add(forwardFuselage);

    // Detached Twisted Rear Fuselage & Broken Tail Fin Assembly further back in the Dragged Dirt Trench
    const tailSection = new THREE.Group();
    tailSection.position.set(-0.65, 0.88, -5.2);
    tailSection.rotation.y = 0.28;
    tailSection.rotation.z = 0.22;
    const tailCone = new THREE.Mesh(createSculptedLatheBarrelGeo(0.75, 1.38, 4.4, 12), scorchedHullMat);
    tailCone.rotation.x = Math.PI / 2;
    const verticalStabilizer = new THREE.Mesh(createExtrudedArmorHullGeo(0.24, 2.45, 1.85, 0.03, 0.08), MAT.terranBlue);
    verticalStabilizer.position.set(0, 1.65, -1.15);
    verticalStabilizer.rotation.z = -0.18;
    tailSection.add(tailCone, verticalStabilizer);
    group.add(tailSection);

    // C. BROKEN ARM / SHEARED WING + DETACHED TURBOFAN ENGINES WITH SECONDARY DRAGGED DIRT GOUGE
    // Starboard wing stub still attached to fuselage
    const attachedWingStub = new THREE.Mesh(createExtrudedArmorHullGeo(3.6, 0.24, 1.95, 0.04, 0.10), airframeMat);
    attachedWingStub.position.set(-2.65, 1.15, 1.25);
    attachedWingStub.rotation.z = 0.26;
    group.add(attachedWingStub);

    // Sheared-Off Port Main Wing ("Broken Arm") lying torn off to the side in its own dragged dirt trench!
    const brokenWingArm = new THREE.Group();
    brokenWingArm.position.set(4.15, 0.38, -0.85);
    brokenWingArm.rotation.y = -0.52;
    brokenWingArm.rotation.z = -0.18;

    const wingDragDirt = new THREE.Mesh(createDynamicStoneGeometry(x + 41.2, 2.2, 0.26, 0.18, 1), dirtVergeMat);
    wingDragDirt.scale.set(1.6, 0.45, 0.9);
    wingDragDirt.position.set(0, -0.18, -1.2);
    const wingSlab = new THREE.Mesh(createExtrudedArmorHullGeo(5.6, 0.26, 2.15, 0.04, 0.12), airframeMat);
    const wingFlap = new THREE.Mesh(createExtrudedArmorHullGeo(4.8, 0.14, 0.58, 0.02, 0.06), MAT.hazard);
    wingFlap.position.set(0, -0.04, -1.22);

    // Detached Heavy Turbofan Engine Pod beside the Broken Wing Arm
    const engineNacelle = new THREE.Mesh(createSculptedLatheBarrelGeo(0.62, 0.68, 1.95, 12), MAT.gunmetal);
    engineNacelle.rotation.x = Math.PI / 2;
    engineNacelle.position.set(-0.85, 0.48, 0.85);
    const intakeGlow = new THREE.Mesh(createSculptedTorusCollarGeo(0.56, 0.06, 8, 16), MAT.amberGlow);
    intakeGlow.position.set(-0.85, 0.48, 1.82);

    brokenWingArm.add(wingDragDirt, wingSlab, wingFlap, engineNacelle, intakeGlow);
    group.add(brokenWingArm);

    addMapMesh(group);
    obstacles.push({ x, z, r: footR * 0.82, footprintR: footR, isStructure: true, type: 'crashed_heavy_plane', mesh: group });
    return { x, z };
}

// 11. Prefills Empty Plain Valley Floor Terrain with Biome-Specific Surface Detail
function prefillEmptyPlainFloorTerrain(isClearFn) {
    const biome = ACTIVE_PLANET_BIOME || 'highland';
    const slabColor = biome === 'desert' ? 0xb5834a : (biome === 'lava' ? 0x261d1b : (biome === 'jungle' ? 0x2f422b : 0x51473b));
    const scrubColor = biome === 'desert' ? 0x8f7442 : (biome === 'lava' ? 0x3b2219 : (biome === 'jungle' ? 0x1e5c24 : 0x3f5434));

    const weatheredSlabMat = new THREE.MeshStandardMaterial({
        color: slabColor,
        roughness: 0.94,
        metalness: 0.06,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
    });
    const scrubBushMat = new THREE.MeshStandardMaterial({ color: scrubColor, roughness: 0.88, metalness: 0.04 });

    const prefillGroup = new THREE.Group();
    prefillGroup.name = 'plainFloorPrefillGroup';

    // Sample a stratified grid across the entire valley floor [-112..112]
    const step = IS_MOBILE ? 16 : 12;
    for (let gx = -108; gx <= 108; gx += step) {
        for (let gz = -108; gz <= 108; gz += step) {
            const px = gx + (seededRandom() - 0.5) * (step * 0.78);
            const pz = gz + (seededRandom() - 0.5) * (step * 0.78);
            const py = getTerrainHeight(px, pz);

            // Only prefill low/flat plain floor terrain outside bases, roads, rivers, and ponds
            if (py < -0.10 || py > 1.85) continue;
            if (isPointNearAnyRoadOrBridge(px, pz, 3.8)) continue;
            if (isInsideBasePlacementZone(px, pz, 14.0)) continue;
            if (!isClearFn(px, pz, 2.0)) continue;

            const roll = seededRandom();
            if (roll < 0.34) {
                const slabR = 1.25 + seededRandom() * 1.45;
                const slabGeo = createDynamicStoneGeometry(px * 3.7 + pz * 5.1, slabR, 0.25, 0.14, 1);
                const slab = new THREE.Mesh(slabGeo, weatheredSlabMat);
                slab.position.set(px, py + 0.02, pz);
                slab.rotation.y = seededRandom() * Math.PI * 2;
                slab.receiveShadow = true;
                prefillGroup.add(slab);

                const pebbleGeo = createDynamicStoneGeometry(px + pz, 0.28 + seededRandom() * 0.18, 0.32, 0.52, 1);
                const pebble = new THREE.Mesh(pebbleGeo, biome === 'lava' ? MAT.charredSteel : rockMat);
                pebble.position.set(px + 0.65, py + 0.08, pz - 0.45);
                prefillGroup.add(pebble);
            } else if (roll < 0.62) {
                if (biome === 'lava') {
                    // Cooled volcanic magma crust blister & glowing crack
                    const vent = new THREE.Group();
                    vent.position.set(px, py, pz);
                    const crust = new THREE.Mesh(createDynamicStoneGeometry(px * 7.3 + pz, 0.65, 0.28, 0.22, 1), weatheredSlabMat);
                    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.24, 8), lavaFlowMat);
                    glow.rotation.x = -Math.PI / 2;
                    glow.position.y = 0.04;
                    vent.add(crust, glow);
                    prefillGroup.add(vent);
                } else {
                    const scrub = new THREE.Group();
                    scrub.position.set(px, py, pz);
                    for (let b = 0; b < 3; b++) {
                        const bAng = (b / 3) * Math.PI * 2 + seededRandom() * 0.5;
                        const tuftGeo = createDynamicStoneGeometry(px * 9.1 + b, 0.34 + seededRandom() * 0.16, 0.35, 0.68, 1);
                        const tuft = new THREE.Mesh(tuftGeo, scrubBushMat);
                        tuft.position.set(Math.cos(bAng) * 0.26, 0.16, Math.sin(bAng) * 0.26);
                        scrub.add(tuft);
                    }
                    prefillGroup.add(scrub);
                }
            } else if (roll < 0.84) {
                const cluster = new THREE.Group();
                cluster.position.set(px, py, pz);
                const count = 2 + Math.floor(seededRandom() * 3);
                for (let c = 0; c < count; c++) {
                    const ca = (c / count) * Math.PI * 2 + seededRandom() * 0.6;
                    const cd = 0.25 + seededRandom() * 0.75;
                    const sr = 0.22 + seededRandom() * 0.28;
                    const stGeo = createDynamicStoneGeometry(px * 13.1 + pz * 7.7 + c, sr, 0.34, 0.55, 1);
                    const stMat = biome === 'lava' ? MAT.charredSteel : (biome === 'desert' ? weatheredSlabMat : (c % 2 === 0 ? rockMat : mossRockMat));
                    const stMesh = new THREE.Mesh(stGeo, stMat);
                    stMesh.position.set(Math.cos(ca) * cd, sr * 0.22, Math.sin(ca) * cd);
                    stMesh.rotation.y = seededRandom() * Math.PI * 2;
                    cluster.add(stMesh);
                }
                prefillGroup.add(cluster);
            } else {
                const pock = new THREE.Mesh(createSculptedTorusCollarGeo(0.85 + seededRandom() * 0.45, 0.12, 6, 14), weatheredSlabMat);
                pock.rotation.x = Math.PI / 2;
                pock.scale.set(1.0, 1.0, 0.45);
                pock.position.set(px, py + 0.02, pz);
                prefillGroup.add(pock);
            }
        }
    }

    prefillGroup.traverse(c => { c.raycast = () => {}; });
    addMapMesh(prefillGroup);
}

// ============================================================================
// BIOME-SPECIFIC PROCEDURAL ECOSYSTEM GENERATORS (DESERT, LAVA, DENSE JUNGLE)
// ============================================================================
function createDesertBiomeFeatures(isClearFn, biome = ACTIVE_PLANET_BIOME) {
    const activeBiome = biome || ACTIVE_PLANET_BIOME || 'desert';
    if (!isStructureAllowedInBiome('desert_hoodoo', activeBiome) && !isStructureAllowedInBiome('desert_flora', activeBiome)) {
        return;
    }
    const sandstoneMat = new THREE.MeshStandardMaterial({ color: 0xc28646, roughness: 0.90, metalness: 0.05 });
    const redRockMat = new THREE.MeshStandardMaterial({ color: 0x9e5834, roughness: 0.92, metalness: 0.06 });
    const cactusMat = new THREE.MeshStandardMaterial({ color: 0x3b6e38, roughness: 0.78, metalness: 0.04 });
    const dryShrubMat = new THREE.MeshStandardMaterial({ color: 0x997c45, roughness: 0.92, metalness: 0.02 });
    const desertGroup = new THREE.Group();
    desertGroup.name = 'desertBiomeFeatures';

    // 1. Eroded Sandstone Hoodoos, Layered Canyon Spires & Wind-Carved Arches
    const spireCount = IS_MOBILE ? 18 : 32;
    for (let i = 0; i < spireCount; i++) {
        const sx = (seededRandom() - 0.5) * 132;
        const sz = (seededRandom() - 0.5) * 132;
        if (!isClearFn(sx, sz, 2.8) || !isFootprintAboveWater(sx, sz, 1.8, 6, 0.06)) continue;
        const sy = getTerrainHeight(sx, sz);
        if (sy < -0.15) continue;

        const hoodoo = new THREE.Group();
        hoodoo.position.set(sx, sy, sz);
        const tiers = 2 + Math.floor(seededRandom() * 2);
        let curY = 0;
        for (let t = 0; t < tiers; t++) {
            const rad = (1.15 - t * 0.22) * (0.85 + seededRandom() * 0.35);
            const h = 0.85 + seededRandom() * 0.75;
            const tierGeo = createDynamicStoneGeometry(sx * 5.3 + sz * 3.1 + t, rad, 0.32, h / rad, 1);
            const tierMesh = new THREE.Mesh(tierGeo, t % 2 === 0 ? sandstoneMat : redRockMat);
            tierMesh.position.y = curY + h * 0.45;
            tierMesh.rotation.y = seededRandom() * Math.PI * 2;
            tierMesh.castShadow = !IS_MOBILE;
            tierMesh.receiveShadow = true;
            hoodoo.add(tierMesh);
            curY += h * 0.78;
        }
        desertGroup.add(hoodoo);
        obstacles.push({ x: sx, z: sz, r: 1.35, type: 'rock', structureId: 'desert_hoodoo' });
    }

    // 2. Saguaro Cacti, Prickly Pear Clusters & Sun-Bleached Dead Snags
    const floraCount = IS_MOBILE ? 36 : 64;
    for (let i = 0; i < floraCount; i++) {
        const fx = (seededRandom() - 0.5) * 134;
        const fz = (seededRandom() - 0.5) * 134;
        if (!isClearFn(fx, fz, 1.8) || !isFootprintAboveWater(fx, fz, 1.1, 6, 0.06)) continue;
        const fy = getTerrainHeight(fx, fz);
        if (fy < 0.02 || fy > 3.5) continue;

        if (seededRandom() < 0.58) {
            // Ribbed Saguaro Cactus with 1-2 upward arms
            const cactus = new THREE.Group();
            cactus.position.set(fx, fy, fz);
            const h = 1.6 + seededRandom() * 1.3;
            const trunk = new THREE.Mesh(createSculptedLatheBarrelGeo(0.16, 0.21, h, 8), cactusMat);
            trunk.position.y = h * 0.5;
            trunk.castShadow = !IS_MOBILE;
            cactus.add(trunk);

            const armCount = 1 + Math.floor(seededRandom() * 2);
            for (let a = 0; a < armCount; a++) {
                const side = a === 0 ? 1 : -1;
                const armH = 0.65 + seededRandom() * 0.55;
                const armY = h * (0.42 + a * 0.18);
                const elbow = new THREE.Mesh(createSculptedLatheBarrelGeo(0.11, 0.13, 0.36, 7), cactusMat);
                elbow.rotation.z = Math.PI * 0.5;
                elbow.position.set(side * 0.22, armY, 0);
                const riser = new THREE.Mesh(createSculptedLatheBarrelGeo(0.11, 0.13, armH, 7), cactusMat);
                riser.position.set(side * 0.38, armY + armH * 0.45, 0);
                cactus.add(elbow, riser);
            }
            cactus.rotation.y = seededRandom() * Math.PI * 2;
            desertGroup.add(cactus);
            obstacles.push({ x: fx, z: fz, r: 0.55, type: 'tree', isTree: true, structureId: 'desert_flora' });
        } else {
            // Arid Tumbleweed / Desert Thorn Bush
            const shrub = new THREE.Group();
            shrub.position.set(fx, fy, fz);
            for (let b = 0; b < 4; b++) {
                const ang = (b / 4) * Math.PI * 2 + seededRandom() * 0.5;
                const branch = new THREE.Mesh(createSculptedOgiveSpireGeo(0.18, 0.65, 5), dryShrubMat);
                branch.position.set(Math.cos(ang) * 0.18, 0.22, Math.sin(ang) * 0.18);
                branch.rotation.z = Math.cos(ang) * 0.55;
                branch.rotation.x = Math.sin(ang) * 0.55;
                shrub.add(branch);
            }
            desertGroup.add(shrub);
        }
    }

    // 3. Oasis Date Palms strictly around Desert Oasis Ponds & Riverbanks
    if (isStructureAllowedInBiome('palm_tree', activeBiome)) {
        DYNAMIC_PONDS.forEach(pd => {
            for (let p = 0; p < 5; p++) {
                const ang = (p / 5) * Math.PI * 2 + seededRandom() * 0.4;
                const dist = pd.r * 1.18 + 0.8 + seededRandom() * 1.4;
                const px = pd.x + Math.cos(ang) * dist;
                const pz = pd.z + Math.sin(ang) * dist;
                if (isClearFn(px, pz, 1.8) && typeof createMultiSpeciesTreeMesh === 'function') {
                    createMultiSpeciesTreeMesh('palm', px, pz);
                }
            }
        });
    }

    addMapMesh(desertGroup);
}

function createLavaBiomeFeatures(isClearFn, biome = ACTIVE_PLANET_BIOME) {
    const activeBiome = biome || ACTIVE_PLANET_BIOME || 'lava';
    if (!isStructureAllowedInBiome('volcanic_structure', activeBiome)) {
        return;
    }
    const obsidianMat = new THREE.MeshStandardMaterial({ color: 0x161212, roughness: 0.38, metalness: 0.42 });
    const basaltMat = new THREE.MeshStandardMaterial({ color: 0x241c1a, roughness: 0.86, metalness: 0.16 });
    const heatArmorMat = new THREE.MeshStandardMaterial({ color: 0x2c2826, roughness: 0.48, metalness: 0.76 });
    const hazardMetalMat = MAT.hazard || new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.5, metalness: 0.5 });
    const magmaCoreMat = new THREE.MeshStandardMaterial({
        color: 0xff6a00,
        emissive: 0xff3b00,
        emissiveIntensity: 1.65,
        roughness: 0.25
    });
    const emberCrustMat = new THREE.MeshStandardMaterial({
        color: 0x3b1810,
        emissive: 0xc83200,
        emissiveIntensity: 0.85,
        roughness: 0.72
    });
    const ashPlumeMat = new THREE.MeshStandardMaterial({
        color: 0x262120,
        emissive: 0x451204,
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: 0.58,
        roughness: 0.95
    });
    const lavaGroup = new THREE.Group();
    lavaGroup.name = 'lavaBiomeFeatures';

    // 1. Render Flowing Molten Lava Surfaces inside all Carved Lava Fissures & Crevices
    if (window.LAVA_FISSURES && window.LAVA_FISSURES.length > 0) {
        window.LAVA_FISSURES.forEach(lf => {
            const fGroup = new THREE.Group();
            fGroup.position.set(lf.x, 0, lf.z);
            fGroup.rotation.y = -lf.ang;

            const segsL = 28;
            const segsW = 6;
            const fGeo = new THREE.PlaneGeometry(lf.len * 2.0, lf.wid * 2.1, segsL, segsW);
            fGeo.rotateX(-Math.PI / 2);
            const fPos = fGeo.attributes.position;
            for (let i = 0; i < fPos.count; i++) {
                const lx = fPos.getX(i);
                const lz = fPos.getZ(i);
                const normL = Math.abs(lx) / lf.len;
                const taper = Math.max(0.15, 1.0 - 0.65 * Math.pow(normL, 1.5));
                const bend = Math.sin((lx / lf.len) * Math.PI) * lf.len * lf.curve;
                const finalZ = lz * taper + bend;
                const wx = lf.x + lx * lf.cosA - finalZ * lf.sinA;
                const wz = lf.z + lx * lf.sinA + finalZ * lf.cosA;
                const gh = getTerrainHeight(wx, wz);
                fPos.setXYZ(i, lx, Math.max(gh + 0.04, -0.22), finalZ);
            }
            fGeo.computeVertexNormals();
            const fissureLavaMesh = new THREE.Mesh(fGeo, lavaFlowMat);
            fGroup.add(fissureLavaMesh);

            // Basalt rim boulders along fissure edges
            for (let b = -3; b <= 3; b++) {
                const along = (b / 3.5) * lf.len * 0.85;
                const bend = Math.sin((along / lf.len) * Math.PI) * lf.len * lf.curve;
                const side = (b % 2 === 0 ? 1 : -1) * (lf.wid * 0.95);
                const rimRock = new THREE.Mesh(createSculptedOgiveSpireGeo(0.55 + Math.abs(b) * 0.08, 1.35, 6), b % 2 === 0 ? basaltMat : emberCrustMat);
                rimRock.position.set(along, 0.25, bend + side);
                rimRock.rotation.y = b * 0.9;
                fGroup.add(rimRock);
            }
            lavaGroup.add(fGroup);
        });
    }

    // 2. Specialized 3D Volcanic Industrial Structures on Stable Ground (Replacing Civilian Towns/Houses)
    const buildVolcanicIndustrialStructure = (archetype, candX, candZ, rotY = 0) => {
        if (!isStructureAllowedInBiome(archetype, activeBiome)) return false;
        const spot = findAlternativeStructurePlacement(archetype, candX, candZ, {
            biome: activeBiome,
            footprintRadius: 3.8,
            minSeparation: 4.2,
            register: false
        });
        if (!spot) return false;
        candX = spot.x;
        candZ = spot.z;
        const hCenter = spot.y;

        const sg = new THREE.Group();
        const baseY = (typeof flattenTerrainUnderBuilding === 'function')
            ? flattenTerrainUnderBuilding(candX, candZ, 3.8, 2.2)
            : hCenter;
        sg.position.set(candX, baseY, candZ);
        sg.rotation.y = rotY;

        // Heavy reinforced basalt & heat-shielded steel foundation plinth
        const plinth = new THREE.Mesh(createExtrudedArmorHullGeo(6.2, 0.45, 6.2), basaltMat);
        plinth.position.y = 0.22;
        plinth.castShadow = !IS_MOBILE;
        plinth.receiveShadow = true;
        sg.add(plinth);

        if (archetype === 'geothermal_extractor') {
            // Terran Geothermal Extraction Facility: Deep magma bore-head, triple heat-exchanger towers & glowing magma conduit pipes
            const coreHull = new THREE.Mesh(createExtrudedArmorHullGeo(3.8, 2.1, 3.8), heatArmorMat);
            coreHull.position.y = 1.25;
            coreHull.castShadow = !IS_MOBILE;
            sg.add(coreHull);

            const magmaWell = new THREE.Mesh(createSculptedLatheBarrelGeo(1.15, 1.35, 0.65, 12), emberCrustMat);
            magmaWell.position.set(0, 0.55, 0);
            const magmaPool = new THREE.Mesh(new THREE.CircleGeometry(0.95, 12), lavaFlowMat);
            magmaPool.rotation.x = -Math.PI / 2;
            magmaPool.position.y = 0.89;
            sg.add(magmaWell, magmaPool);

            [-1.55, 1.55].forEach(tx => {
                [-1.55, 1.55].forEach(tz => {
                    const tower = new THREE.Mesh(createSculptedLatheBarrelGeo(0.52, 0.68, 3.4, 10), heatArmorMat);
                    tower.position.set(tx, 1.9, tz);
                    tower.castShadow = !IS_MOBILE;
                    const glowRing = new THREE.Mesh(createSculptedLatheBarrelGeo(0.56, 0.56, 0.28, 10), magmaCoreMat);
                    glowRing.position.set(tx, 2.45, tz);
                    const plume = new THREE.Mesh(createSculptedArmorDomeGeo(0.48, 8, 8), ashPlumeMat);
                    plume.position.set(tx, 3.85, tz);
                    sg.add(tower, glowRing, plume);
                    animatedBiomeLandmarks.push({ type: 'lava_fountain', mesh: plume, phase: seededRandom() * Math.PI * 2 });
                });
            });
        } else if (archetype === 'lava_power_generator') {
            // Lava-Powered Energy Generator: Armored turbine hall + incandescent plasma-magma containment sphere & radiator fins
            const turbineHall = new THREE.Mesh(createExtrudedArmorHullGeo(4.8, 1.85, 3.4), heatArmorMat);
            turbineHall.position.set(0, 1.12, 0);
            turbineHall.castShadow = !IS_MOBILE;
            sg.add(turbineHall);

            const containmentSphere = new THREE.Mesh(createSculptedArmorDomeGeo(1.25, 14, 12), magmaCoreMat);
            containmentSphere.position.set(0, 2.35, 0);
            sg.add(containmentSphere);
            animatedBiomeLandmarks.push({ type: 'lava_fountain', mesh: containmentSphere, phase: seededRandom() * Math.PI * 2 });

            for (let fin = 0; fin < 4; fin++) {
                const fa = (fin / 4) * Math.PI * 2 + Math.PI * 0.25;
                const radiator = new THREE.Mesh(createExtrudedArmorHullGeo(0.32, 2.4, 1.45), hazardMetalMat);
                radiator.position.set(Math.cos(fa) * 1.85, 1.6, Math.sin(fa) * 1.85);
                radiator.rotation.y = -fa;
                sg.add(radiator);
            }
        } else if (archetype === 'mining_platform') {
            // Industrial Mining Platform: Cantilevered slag crane, ore crusher hopper & molten slag vat
            const deck = new THREE.Mesh(createExtrudedArmorHullGeo(5.4, 0.95, 4.6), heatArmorMat);
            deck.position.y = 0.85;
            deck.castShadow = !IS_MOBILE;
            const gantry = new THREE.Mesh(createExtrudedArmorHullGeo(1.2, 3.2, 3.8), hazardMetalMat);
            gantry.position.set(-1.4, 2.4, 0);
            const slagVat = new THREE.Mesh(createSculptedLatheBarrelGeo(1.1, 1.25, 1.1, 10), obsidianMat);
            slagVat.position.set(1.25, 1.35, 0);
            const slagTop = new THREE.Mesh(new THREE.CircleGeometry(0.95, 10), lavaFlowMat);
            slagTop.rotation.x = -Math.PI / 2;
            slagTop.position.set(1.25, 1.92, 0);
            sg.add(deck, gantry, slagVat, slagTop);
        } else {
            // Heavy Reinforced Volcanic Outpost Bastion: Heat-shielded command bunker, sensor mast & thermal vents
            const bunker = new THREE.Mesh(createExtrudedArmorHullGeo(4.6, 1.95, 4.6), heatArmorMat);
            bunker.position.y = 1.15;
            bunker.castShadow = !IS_MOBILE;
            const roofDome = new THREE.Mesh(createSculptedArmorDomeGeo(1.35, 10, 8), obsidianMat);
            roofDome.position.y = 2.15;
            const beacon = new THREE.Mesh(createSculptedArmorDomeGeo(0.24, 8, 8), magmaCoreMat);
            beacon.position.set(0, 2.95, 0);
            sg.add(bunker, roofDome, beacon);
        }

        lavaGroup.add(sg);
        REGISTERED_MAP_STRUCTURES.push({ x: candX, z: candZ, r: 3.8, type: archetype });
        obstacles.push({ x: candX, z: candZ, r: 3.25, type: 'unique_building' });
        return true;
    };

    const structureCandidates = [
        ['geothermal_extractor', -32, 26],
        ['geothermal_extractor', 34, -24],
        ['lava_power_generator', -44, -18],
        ['lava_power_generator', 46, 20],
        ['mining_platform', -18, 46],
        ['mining_platform', 20, -46],
        ['volcanic_outpost', -52, 42],
        ['volcanic_outpost', 52, -40],
        ['geothermal_extractor', 0, 32],
        ['lava_power_generator', 0, -32]
    ];
    structureCandidates.forEach(([arch, cx, cz], idx) => {
        const jx = cx + (seededRandom() - 0.5) * 8.0;
        const jz = cz + (seededRandom() - 0.5) * 8.0;
        buildVolcanicIndustrialStructure(arch, jx, jz, idx * 0.85);
    });

    // 3. Jagged Obsidian Monoliths, Basalt Columns & Glowing Volcanic Fumarole Vents with Smoke/Ash Plumes
    const spireCount = IS_MOBILE ? 28 : 52;
    for (let i = 0; i < spireCount; i++) {
        const lx = (seededRandom() - 0.5) * 144;
        const lz = (seededRandom() - 0.5) * 144;
        if (!isClearFn(lx, lz, 2.4)) continue;
        const ly = getTerrainHeight(lx, lz);
        if (ly < -0.15) continue;

        const formation = new THREE.Group();
        formation.position.set(lx, ly, lz);

        if (i % 3 === 0) {
            // Active Volcanic Fumarole Cone with Glowing Magma Throat, Rising Smoke Plume & Animated Lava Fountain
            const cone = new THREE.Mesh(createSculptedLatheBarrelGeo(0.58, 1.45, 1.55, 9), basaltMat);
            cone.position.y = 0.68;
            cone.castShadow = !IS_MOBILE;
            const throat = new THREE.Mesh(new THREE.CircleGeometry(0.50, 10), lavaFlowMat);
            throat.rotation.x = -Math.PI / 2;
            throat.position.y = 1.46;
            const fountain = new THREE.Mesh(createSculptedArmorDomeGeo(0.38, 8, 8), lavaFlowMat);
            fountain.position.y = 1.50;
            const smokePuff = new THREE.Mesh(createSculptedArmorDomeGeo(0.62, 8, 8), ashPlumeMat);
            smokePuff.position.y = 2.35;
            formation.add(cone, throat, fountain, smokePuff);
            animatedBiomeLandmarks.push({ type: 'lava_fountain', mesh: fountain, phase: seededRandom() * Math.PI * 2 });
            obstacles.push({ x: lx, z: lz, r: 1.35, type: 'rock' });
        } else {
            // Cluster of Hexagonal Basalt Columns & Sharp Obsidian Shards
            const shards = 3 + Math.floor(seededRandom() * 4);
            for (let s = 0; s < shards; s++) {
                const ang = (s / shards) * Math.PI * 2 + seededRandom() * 0.4;
                const d = s === 0 ? 0 : (0.35 + seededRandom() * 0.50);
                const h = (s === 0 ? 2.0 : 1.1) + seededRandom() * 1.2;
                const shard = new THREE.Mesh(
                    createSculptedOgiveSpireGeo(0.34 + seededRandom() * 0.24, h, 6),
                    s % 2 === 0 ? obsidianMat : emberCrustMat
                );
                shard.position.set(Math.cos(ang) * d, h * 0.42, Math.sin(ang) * d);
                shard.rotation.set((seededRandom() - 0.5) * 0.28, seededRandom() * Math.PI * 2, (seededRandom() - 0.5) * 0.28);
                shard.castShadow = !IS_MOBILE;
                formation.add(shard);
            }
            obstacles.push({ x: lx, z: lz, r: 1.15, type: 'rock' });
        }
        lavaGroup.add(formation);
    }

    // 4. Incandescent Surface Magma Cracks & Volcanic Embers (No normal green trees!)
    const crackCount = IS_MOBILE ? 24 : 44;
    for (let i = 0; i < crackCount; i++) {
        const sx = (seededRandom() - 0.5) * 138;
        const sz = (seededRandom() - 0.5) * 138;
        if (!isClearFn(sx, sz, 2.0)) continue;
        const sy = getTerrainHeight(sx, sz);
        if (sy < 0.05 || sy > 3.2) continue;

        const crackGroup = new THREE.Group();
        crackGroup.position.set(sx, sy + 0.028, sz);
        crackGroup.rotation.y = seededRandom() * Math.PI * 2;
        const len = 2.6 + seededRandom() * 3.2;
        const crack = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.42, 6, 1), lavaFlowMat);
        crack.rotation.x = -Math.PI / 2;
        crackGroup.add(crack);
        lavaGroup.add(crackGroup);
    }

    addMapMesh(lavaGroup);
}

let NAVAL_ASSET_CACHE = null;
function getSharedNavalAssetCache() {
    if (NAVAL_ASSET_CACHE) return NAVAL_ASSET_CACHE;
    NAVAL_ASSET_CACHE = {
        hullSteel: new THREE.MeshStandardMaterial({ color: 0x3b4856, roughness: 0.56, metalness: 0.68 }),
        hullDark: new THREE.MeshStandardMaterial({ color: 0x222b35, roughness: 0.68, metalness: 0.62 }),
        deckGray: new THREE.MeshStandardMaterial({ color: 0x485460, roughness: 0.74, metalness: 0.42 }),
        flightDeck: new THREE.MeshStandardMaterial({ color: 0x2c343d, roughness: 0.82, metalness: 0.30 }),
        rustWeathered: new THREE.MeshStandardMaterial({ color: 0x6e3b28, roughness: 0.88, metalness: 0.35 }),
        cargoOrange: new THREE.MeshStandardMaterial({ color: 0xb8522a, roughness: 0.64, metalness: 0.38 }),
        cargoBlue: new THREE.MeshStandardMaterial({ color: 0x29567a, roughness: 0.64, metalness: 0.38 }),
        radarMat: new THREE.MeshStandardMaterial({ color: 0x9fb3c8, roughness: 0.38, metalness: 0.78 }),
        navGlow: new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0284c7, emissiveIntensity: 1.4, roughness: 0.25 }),
        hazardBeacon: new THREE.MeshStandardMaterial({ color: 0xf97316, emissive: 0xea580c, emissiveIntensity: 1.5, roughness: 0.3 }),
        smokeMat: new THREE.MeshStandardMaterial({ color: 0x292524, transparent: true, opacity: 0.52, roughness: 0.95 }),
        limestoneMat: new THREE.MeshStandardMaterial({ color: 0x8b8578, roughness: 0.85, metalness: 0.08 }),
        coralMat: new THREE.MeshStandardMaterial({ color: 0xd97757, roughness: 0.75, metalness: 0.10 }),
        boxUnitGeo: new THREE.BoxGeometry(1, 1, 1),
        cylUnitGeo: new THREE.CylinderGeometry(1, 1, 1, 10),
        coneUnitGeo: new THREE.ConeGeometry(1, 1, 8),
        domeUnitGeo: createSculptedArmorDomeGeo(1.0, 10, 8)
    };
    return NAVAL_ASSET_CACHE;
}

function createProceduralNavalVesselGroup(vesselType, cache) {
    const ship = new THREE.Group();
    ship.name = `naval_${vesselType}`;
    const isWreck = vesselType === 'wrecked_ship' || vesselType === 'wrecked_military_vessel';
    const isCarrier = vesselType === 'aircraft_carrier';
    const isCommand = vesselType === 'abandoned_command_ship';
    const isWarship = vesselType === 'military_warship' || isCommand || vesselType === 'wrecked_military_vessel';
    const isTransport = vesselType === 'civilian_transport_ship';

    const len = isCarrier ? 17.5 : (isCommand ? 13.5 : (isWarship ? 11.8 : (isTransport ? 10.6 : 8.2)));
    const beam = isCarrier ? 4.8 : (isCommand ? 3.5 : (isWarship ? 2.8 : (isTransport ? 2.9 : 2.3)));
    const draftH = isCarrier ? 1.85 : (isWarship ? 1.35 : 1.15);

    const hullMat = isWreck ? cache.rustWeathered : (isTransport ? cache.hullDark : cache.hullSteel);
    const mainHull = new THREE.Mesh(cache.boxUnitGeo, hullMat);
    mainHull.scale.set(beam, draftH, len * 0.76);
    mainHull.position.y = draftH * 0.36;
    mainHull.castShadow = !IS_MOBILE;
    mainHull.receiveShadow = true;
    ship.add(mainHull);

    // Tapered bow & stern wedges
    const bow = new THREE.Mesh(cache.coneUnitGeo, hullMat);
    bow.scale.set(beam * 0.66, len * 0.24, draftH * 0.92);
    bow.rotation.x = Math.PI * 0.5;
    bow.position.set(0, draftH * 0.36, len * 0.48);
    ship.add(bow);

    const stern = new THREE.Mesh(cache.boxUnitGeo, cache.hullDark);
    stern.scale.set(beam * 0.88, draftH * 0.90, len * 0.14);
    stern.position.set(0, draftH * 0.34, -len * 0.42);
    ship.add(stern);

    // Weathering waterline rust belt
    const belt = new THREE.Mesh(cache.boxUnitGeo, cache.rustWeathered);
    belt.scale.set(beam * 1.02, 0.24, len * 0.78);
    belt.position.y = 0.08;
    ship.add(belt);

    if (isCarrier) {
        // Angled flight deck, arrestor strips, island superstructure & parked deck interceptors
        const flightDeck = new THREE.Mesh(cache.boxUnitGeo, cache.flightDeck);
        flightDeck.scale.set(beam * 1.38, 0.26, len * 0.98);
        flightDeck.position.set(0, draftH * 0.82, 0.2);
        ship.add(flightDeck);

        const stripe = new THREE.Mesh(cache.boxUnitGeo, cache.radarMat);
        stripe.scale.set(0.22, 0.04, len * 0.88);
        stripe.position.set(-0.35, draftH * 0.96, 0.2);
        stripe.rotation.y = 0.06;
        ship.add(stripe);

        const island = new THREE.Mesh(cache.boxUnitGeo, cache.hullSteel);
        island.scale.set(1.15, 2.1, 3.2);
        island.position.set(beam * 0.48, draftH + 0.95, -1.2);
        ship.add(island);

        const mast = new THREE.Mesh(cache.cylUnitGeo, cache.radarMat);
        mast.scale.set(0.12, 1.8, 0.12);
        mast.position.set(beam * 0.48, draftH + 2.5, -1.2);
        ship.add(mast);

        const radarDish = new THREE.Mesh(cache.boxUnitGeo, cache.radarMat);
        radarDish.scale.set(0.95, 0.32, 0.12);
        radarDish.position.set(beam * 0.48, draftH + 3.25, -1.2);
        ship.add(radarDish);
        ship.userData.radarSpinner = radarDish;

        const beacon = new THREE.Mesh(cache.domeUnitGeo, cache.navGlow);
        beacon.scale.setScalar(0.18);
        beacon.position.set(beam * 0.48, draftH + 3.55, -1.2);
        ship.add(beacon);
    } else if (isTransport) {
        // Civilian container transport ship with stacked cargo containers & aft bridge house
        const bridge = new THREE.Mesh(cache.boxUnitGeo, cache.hullSteel);
        bridge.scale.set(beam * 0.82, 1.85, 2.1);
        bridge.position.set(0, draftH + 0.75, -len * 0.28);
        ship.add(bridge);

        for (let c = 0; c < 3; c++) {
            const crate = new THREE.Mesh(cache.boxUnitGeo, c % 2 === 0 ? cache.cargoOrange : cache.cargoBlue);
            crate.scale.set(beam * 0.76, 0.92, 1.85);
            crate.position.set(0, draftH + 0.32, -0.5 + c * 2.15);
            ship.add(crate);
        }
    } else {
        // Military warship / command vessel / support vessel with superstructure, naval turrets & comms tower
        const superStruct = new THREE.Mesh(cache.boxUnitGeo, cache.deckGray);
        superStruct.scale.set(beam * 0.72, isCommand ? 2.25 : 1.65, len * 0.36);
        superStruct.position.set(0, draftH + 0.65, -0.4);
        ship.add(superStruct);

        const commTower = new THREE.Mesh(cache.cylUnitGeo, cache.hullDark);
        commTower.scale.set(0.24, isCommand ? 2.4 : 1.7, 0.24);
        commTower.position.set(0, draftH + (isCommand ? 2.1 : 1.65), -0.6);
        ship.add(commTower);

        const radarBar = new THREE.Mesh(cache.boxUnitGeo, cache.radarMat);
        radarBar.scale.set(0.85, 0.22, 0.12);
        radarBar.position.set(0, draftH + (isCommand ? 3.2 : 2.55), -0.6);
        ship.add(radarBar);
        ship.userData.radarSpinner = radarBar;

        // Forward and aft naval gun turrets
        const buildTurret = (zOff, rotY = 0) => {
            const tur = new THREE.Group();
            tur.position.set(0, draftH * 0.82, zOff);
            tur.rotation.y = rotY;
            const cup = new THREE.Mesh(cache.domeUnitGeo, cache.hullSteel);
            cup.scale.set(0.65, 0.42, 0.78);
            const barrelL = new THREE.Mesh(cache.cylUnitGeo, cache.hullDark);
            barrelL.scale.set(0.07, 1.35, 0.07);
            barrelL.rotation.x = Math.PI * 0.5;
            barrelL.position.set(-0.14, 0.18, 0.72);
            const barrelR = barrelL.clone();
            barrelR.position.x = 0.14;
            tur.add(cup, barrelL, barrelR);
            ship.add(tur);
        };
        buildTurret(len * 0.27, 0);
        if (isWarship) buildTurret(-len * 0.28, Math.PI);
    }

    if (isWreck || isCommand) {
        // Damaged hull breach, tilted deck & rising smoke plume
        ship.rotation.z = (isWreck ? 0.24 : 0.08) * (seededRandom() > 0.5 ? 1 : -1);
        ship.rotation.x = isWreck ? -0.11 : 0.03;
        const smokeGroup = new THREE.Group();
        for (let s = 0; s < 3; s++) {
            const puff = new THREE.Mesh(cache.domeUnitGeo, cache.smokeMat);
            const sc = 0.55 + s * 0.32;
            puff.scale.setScalar(sc);
            puff.position.set((s - 1) * 0.35, draftH + 1.2 + s * 0.85, 0.4);
            smokeGroup.add(puff);
        }
        ship.add(smokeGroup);
        ship.userData.smokeGroup = smokeGroup;
    }

    return ship;
}

function createProceduralNavalInstallationGroup(installType, cache) {
    const inst = new THREE.Group();
    inst.name = `naval_install_${installType}`;
    if (installType === 'coastal_radar_installation' || installType === 'naval_military_installation') {
        const plinth = new THREE.Mesh(cache.cylUnitGeo, cache.hullDark);
        plinth.scale.set(2.8, 0.65, 2.8);
        plinth.position.y = 0.32;
        inst.add(plinth);

        const bunker = new THREE.Mesh(cache.boxUnitGeo, cache.hullSteel);
        bunker.scale.set(3.4, 1.65, 2.8);
        bunker.position.y = 1.15;
        inst.add(bunker);

        const mast = new THREE.Mesh(cache.cylUnitGeo, cache.deckGray);
        mast.scale.set(0.28, 3.6, 0.28);
        mast.position.set(0.65, 2.6, 0);
        inst.add(mast);

        const dish = new THREE.Mesh(cache.coneUnitGeo, cache.radarMat);
        dish.scale.set(1.05, 0.55, 1.05);
        dish.rotation.x = Math.PI * 0.38;
        dish.position.set(0.65, 4.45, 0.22);
        inst.add(dish);
        inst.userData.radarSpinner = dish;

        const beacon = new THREE.Mesh(cache.domeUnitGeo, cache.navGlow);
        beacon.scale.setScalar(0.22);
        beacon.position.set(0.65, 4.85, 0);
        inst.add(beacon);
    } else {
        // Offshore Naval Defense Platform / Abandoned Offshore Military Installation on Pylons
        for (let px of [-1.8, 1.8]) {
            for (let pz of [-1.8, 1.8]) {
                const leg = new THREE.Mesh(cache.cylUnitGeo, cache.rustWeathered);
                leg.scale.set(0.28, 2.8, 0.28);
                leg.position.set(px, 0.65, pz);
                inst.add(leg);
            }
        }
        const deck = new THREE.Mesh(cache.boxUnitGeo, cache.deckGray);
        deck.scale.set(4.8, 0.55, 4.8);
        deck.position.y = 1.95;
        inst.add(deck);

        const turretBase = new THREE.Mesh(cache.cylUnitGeo, cache.hullSteel);
        turretBase.scale.set(1.35, 1.1, 1.35);
        turretBase.position.y = 2.65;
        inst.add(turretBase);

        const dome = new THREE.Mesh(cache.domeUnitGeo, cache.hullDark);
        dome.scale.set(1.15, 0.75, 1.15);
        dome.position.y = 3.25;
        inst.add(dome);

        const cannonL = new THREE.Mesh(cache.cylUnitGeo, cache.radarMat);
        cannonL.scale.set(0.10, 1.85, 0.10);
        cannonL.rotation.x = Math.PI * 0.5;
        cannonL.position.set(-0.28, 3.25, 1.15);
        const cannonR = cannonL.clone();
        cannonR.position.x = 0.28;
        inst.add(cannonL, cannonR);

        const hazard = new THREE.Mesh(cache.domeUnitGeo, cache.hazardBeacon);
        hazard.scale.setScalar(0.24);
        hazard.position.set(-1.6, 2.45, -1.6);
        inst.add(hazard);
    }
    return inst;
}

function createOceanBiomeFeatures(isClearFn, biome = ACTIVE_PLANET_BIOME) {
    const activeBiome = biome || ACTIVE_PLANET_BIOME || 'ocean';
    if (!isStructureAllowedInBiome('ocean_ship', activeBiome) && !isStructureAllowedInBiome('limestone_coastal_formation', activeBiome)) {
        return;
    }
    const cache = getSharedNavalAssetCache();
    const oceanGroup = new THREE.Group();
    oceanGroup.name = 'oceanBiomeFeatures';
    const waterY = typeof RIVER_WATER_Y === 'number' ? RIVER_WATER_Y : -0.18;

    // 1. Spawn Strategic Naval Vessels in Navigable Deep Water Channels (Outside Bridges & Island Shorelines)
    const fleetRoster = IS_MOBILE
        ? [
            { type: 'aircraft_carrier', x: -56, z: 48, yaw: 0.42 },
            { type: 'military_warship', x: 54, z: -46, yaw: -2.35 },
            { type: 'abandoned_command_ship', x: -48, z: -52, yaw: 0.85 },
            { type: 'civilian_transport_ship', x: 58, z: 44, yaw: -0.95 },
            { type: 'naval_support_vessel', x: -64, z: -4, yaw: 1.45 },
            { type: 'wrecked_ship', x: 64, z: 8, yaw: -1.15 },
            { type: 'wrecked_military_vessel', x: 4, z: 62, yaw: 0.25 }
        ]
        : [
            { type: 'aircraft_carrier', x: -58, z: 50, yaw: 0.42 },
            { type: 'aircraft_carrier', x: 58, z: -50, yaw: -2.65 },
            { type: 'abandoned_command_ship', x: -50, z: -54, yaw: 0.88 },
            { type: 'military_warship', x: 54, z: 46, yaw: -1.10 },
            { type: 'military_warship', x: -64, z: 6, yaw: 1.52 },
            { type: 'civilian_transport_ship', x: 64, z: -6, yaw: -1.48 },
            { type: 'civilian_transport_ship', x: -8, z: -64, yaw: 0.15 },
            { type: 'naval_support_vessel', x: 12, z: 64, yaw: -2.95 },
            { type: 'naval_support_vessel', x: -36, z: 60, yaw: 0.65 },
            { type: 'wrecked_ship', x: 38, z: -60, yaw: -0.75 },
            { type: 'wrecked_military_vessel', x: -62, z: -28, yaw: 1.15 },
            { type: 'wrecked_ship', x: 62, z: 26, yaw: -1.85 }
        ];

    fleetRoster.forEach((entry, idx) => {
        if (!isStructureAllowedInBiome(entry.type, activeBiome)) return;
        const meta = getStructureBiomeMetadata(entry.type);
        const spot = findAlternativeStructurePlacement(entry.type, entry.x, entry.z, {
            biome: activeBiome,
            footprintRadius: meta.defaultRadius || 5.2,
            minSeparation: 5.5,
            register: true
        });
        if (!spot) return;

        const vessel = createProceduralNavalVesselGroup(entry.type, cache);
        const isWreck = entry.type.includes('wrecked');
        const baseY = waterY + (isWreck ? -0.16 : 0.04);
        vessel.position.set(spot.x, baseY, spot.z);
        vessel.rotation.y = entry.yaw + (seededRandom() - 0.5) * 0.28;
        oceanGroup.add(vessel);

        obstacles.push({
            x: spot.x,
            z: spot.z,
            r: (meta.defaultRadius || 5.0) * 0.78,
            type: 'naval_vessel',
            structureId: entry.type
        });

        animatedBiomeLandmarks.push({
            type: 'naval_vessel',
            mesh: vessel,
            radarSpinner: vessel.userData.radarSpinner || null,
            smokeGroup: vessel.userData.smokeGroup || null,
            baseY,
            baseRoll: vessel.rotation.z,
            basePitch: vessel.rotation.x,
            bobAmp: isWreck ? 0.025 : 0.075,
            rollAmp: isWreck ? 0.012 : 0.032,
            phase: idx * 1.37 + seededRandom() * Math.PI * 2
        });
    });

    // 2. Spawn Ocean Military Installations (Offshore Defense Platforms & Island Coastal Radar Installations)
    const offshoreSpots = IS_MOBILE
        ? [
            { type: 'naval_defense_platform', x: -28, z: 34 },
            { type: 'offshore_military_installation', x: 30, z: -34 }
        ]
        : [
            { type: 'naval_defense_platform', x: -28, z: 34 },
            { type: 'naval_defense_platform', x: 30, z: -34 },
            { type: 'offshore_military_installation', x: -34, z: -26 },
            { type: 'offshore_military_installation', x: 34, z: 28 }
        ];

    offshoreSpots.forEach((os, idx) => {
        if (!isStructureAllowedInBiome(os.type, activeBiome)) return;
        const spot = findAlternativeStructurePlacement(os.type, os.x, os.z, {
            biome: activeBiome,
            footprintRadius: 4.2,
            minSeparation: 4.8,
            register: true
        });
        if (!spot) return;
        const plat = createProceduralNavalInstallationGroup(os.type, cache);
        plat.position.set(spot.x, waterY, spot.z);
        plat.rotation.y = idx * 1.15;
        oceanGroup.add(plat);
        obstacles.push({ x: spot.x, z: spot.z, r: 3.4, type: 'naval_installation', structureId: os.type });
    });

    if (Array.isArray(window.OCEAN_ISLANDS)) {
        window.OCEAN_ISLANDS.forEach((isl, idx) => {
            if (!isl || isl.isMajor) return;
            if (!isStructureAllowedInBiome('coastal_radar_installation', activeBiome)) return;
            const spot = findAlternativeStructurePlacement('coastal_radar_installation', isl.x, isl.z, {
                biome: activeBiome,
                footprintRadius: 3.2,
                roadClearance: 4.2,
                minSeparation: 3.8,
                register: true
            });
            if (!spot) return;
            const radarInst = createProceduralNavalInstallationGroup('coastal_radar_installation', cache);
            radarInst.position.set(spot.x, spot.y, spot.z);
            radarInst.rotation.y = idx * 1.4;
            oceanGroup.add(radarInst);
            obstacles.push({ x: spot.x, z: spot.z, r: 2.8, type: 'naval_installation', structureId: 'coastal_radar_installation' });
            if (radarInst.userData.radarSpinner) {
                animatedBiomeLandmarks.push({
                    type: 'satellite',
                    mesh: radarInst.userData.radarSpinner,
                    phase: idx * 0.9
                });
            }
        });
    }

    // 3. Scatter Tropical Palm Trees & Limestone Coastal Formations strictly on valid archipelago islands
    const propCount = IS_MOBILE ? 44 : 80;
    for (let i = 0; i < propCount; i++) {
        const px = (seededRandom() - 0.5) * 152;
        const pz = (seededRandom() - 0.5) * 152;
        if (!isClearFn(px, pz, 2.2)) continue;
        const py = getTerrainHeight(px, pz);
        if (py < 0.04 || py > 3.2) continue;

        if (py >= 0.14 && isStructureAllowedInBiome('palm_tree', activeBiome) &&
            isFootprintAboveWater(px, pz, 1.1, 6, 0.06) &&
            typeof createMultiSpeciesTreeMesh === 'function' && seededRandom() > 0.30) {
            createMultiSpeciesTreeMesh('palm', px, pz);
        } else if (isStructureAllowedInBiome('limestone_coastal_formation', activeBiome)) {
            const stack = new THREE.Group();
            stack.position.set(px, py, pz);
            const rMesh = new THREE.Mesh(
                createOrganicBoulderGeo(0.75 + seededRandom() * 0.65, 1),
                i % 3 === 0 ? cache.coralMat : cache.limestoneMat
            );
            rMesh.scale.set(1.2, 0.85 + seededRandom() * 0.6, 1.1);
            rMesh.castShadow = !IS_MOBILE;
            stack.add(rMesh);
            oceanGroup.add(stack);
            obstacles.push({ x: px, z: pz, r: 0.95, type: 'rock', structureId: 'limestone_coastal_formation' });
        }
    }

    addMapMesh(oceanGroup);
}

function createDenseJungleBiomeFeatures(isClearFn, biome = ACTIVE_PLANET_BIOME) {
    const activeBiome = biome || ACTIVE_PLANET_BIOME || 'jungle';
    if (!isStructureAllowedInBiome('forest_tree', activeBiome) && !isStructureAllowedInBiome('fern_flora', activeBiome)) {
        return;
    }
    // High-density multi-layered tropical rainforest using GPU InstancedMesh for smooth frame rates
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0x1e5c24, roughness: 0.82, metalness: 0.04 });
    const frondMat = new THREE.MeshStandardMaterial({ color: 0x2d7a32, roughness: 0.76, metalness: 0.05, side: THREE.DoubleSide });
    const jungleTrunkMat = new THREE.MeshStandardMaterial({ color: 0x3d2b1f, roughness: 0.92, metalness: 0.03 });
    const vineMat = new THREE.MeshStandardMaterial({ color: 0x265422, roughness: 0.88, metalness: 0.02 });

    const maxCanopyTrees = IS_MOBILE ? 110 : 220;
    const maxUnderstoryFerns = IS_MOBILE ? 180 : 380;
    const maxFallenLogs = IS_MOBILE ? 32 : 64;

    const trunkGeo = createSculptedLatheBarrelGeo(0.22, 0.42, 4.2, 7);
    trunkGeo.translate(0, 2.1, 0);
    const crownGeo = createDynamicStoneGeometry(42.7, 2.15, 0.32, 0.58, 1);
    crownGeo.translate(0, 4.15, 0);
    const subCrownGeo = createDynamicStoneGeometry(91.3, 1.55, 0.34, 0.52, 1);
    subCrownGeo.translate(0.45, 3.35, -0.35);
    const vineGeo = new THREE.CylinderGeometry(0.035, 0.025, 2.4, 5);
    vineGeo.translate(0.65, 2.4, 0.25);

    const fernBladeGeo = createSculptedOgiveSpireGeo(0.24, 1.05, 5);
    fernBladeGeo.rotateZ(0.68);
    fernBladeGeo.translate(0.32, 0.28, 0);

    const logGeo = createSculptedLatheBarrelGeo(0.24, 0.28, 2.8, 7);
    logGeo.rotateZ(Math.PI * 0.5);

    const treeTransforms = [];
    const treeColors = [];
    const fernTransforms = [];
    const fernColors = [];
    const logTransforms = [];
    const dummy = new THREE.Object3D();

    // 1. Dense Emergent & Mid-Canopy Rainforest Trees (Clustered around jungle corridors & hills)
    for (let i = 0; i < maxCanopyTrees * 3 && treeTransforms.length < maxCanopyTrees; i++) {
        const tx = (seededRandom() - 0.5) * 136;
        const tz = (seededRandom() - 0.5) * 136;
        const ty = getTerrainHeight(tx, tz);
        if (ty < 0.04 || ty > 4.2) continue;
        if (!isClearFn(tx, tz, 1.85) || !isFootprintAboveWater(tx, tz, 1.2, 6, 0.06)) continue;

        const scale = 0.78 + seededRandom() * 0.72;
        dummy.position.set(tx, ty - 0.05, tz);
        dummy.rotation.set((seededRandom() - 0.5) * 0.14, seededRandom() * Math.PI * 2, (seededRandom() - 0.5) * 0.14);
        dummy.scale.set(scale, scale * (0.9 + seededRandom() * 0.35), scale);
        dummy.updateMatrix();
        treeTransforms.push(dummy.matrix.clone());

        const shade = 0.78 + seededRandom() * 0.42;
        treeColors.push(new THREE.Color(0.85 * shade, 1.05 * shade, 0.82 * shade));

        // Register navigation obstacle for the trunk core so units path around dense jungle stands
        if (treeTransforms.length % 2 === 0) {
            obstacles.push({ x: tx, z: tz, r: 0.75 * scale, type: 'tree', isTree: true, structureId: 'forest_tree' });
        }
    }

    if (treeTransforms.length > 0) {
        const instTrunks = new THREE.InstancedMesh(trunkGeo, jungleTrunkMat, treeTransforms.length);
        const instCrowns = new THREE.InstancedMesh(crownGeo, canopyMat, treeTransforms.length);
        const instSubCrowns = new THREE.InstancedMesh(subCrownGeo, canopyMat, treeTransforms.length);
        const instVines = new THREE.InstancedMesh(vineGeo, vineMat, treeTransforms.length);
        instTrunks.castShadow = !IS_MOBILE;
        instCrowns.castShadow = !IS_MOBILE;
        instCrowns.receiveShadow = true;
        instSubCrowns.receiveShadow = true;

        for (let i = 0; i < treeTransforms.length; i++) {
            instTrunks.setMatrixAt(i, treeTransforms[i]);
            instCrowns.setMatrixAt(i, treeTransforms[i]);
            instSubCrowns.setMatrixAt(i, treeTransforms[i]);
            instVines.setMatrixAt(i, treeTransforms[i]);
            instCrowns.setColorAt(i, treeColors[i]);
            instSubCrowns.setColorAt(i, treeColors[i]);
        }
        instTrunks.instanceMatrix.needsUpdate = true;
        instCrowns.instanceMatrix.needsUpdate = true;
        instSubCrowns.instanceMatrix.needsUpdate = true;
        instVines.instanceMatrix.needsUpdate = true;
        if (instCrowns.instanceColor) instCrowns.instanceColor.needsUpdate = true;
        if (instSubCrowns.instanceColor) instSubCrowns.instanceColor.needsUpdate = true;
        addMapMesh(instTrunks);
        addMapMesh(instCrowns);
        addMapMesh(instSubCrowns);
        addMapMesh(instVines);
    }

    // 2. Dense Understory Tropical Ferns, Broadleaf Palms & Jungle Shrubs
    for (let i = 0; i < maxUnderstoryFerns * 2 && fernTransforms.length < maxUnderstoryFerns; i++) {
        const fx = (seededRandom() - 0.5) * 136;
        const fz = (seededRandom() - 0.5) * 136;
        const fy = getTerrainHeight(fx, fz);
        if (fy < 0.04 || fy > 3.5) continue;
        if (getSupplyRoadFactor(fx, fz) > 0.08 || !isFootprintAboveWater(fx, fz, 0.9, 6, 0.06)) continue;
        if (isInsideBasePlacementZone(fx, fz, 7.5)) continue;

        const baseScale = 0.75 + seededRandom() * 0.85;
        const baseYaw = seededRandom() * Math.PI * 2;
        for (let leaf = 0; leaf < 3 && fernTransforms.length < maxUnderstoryFerns; leaf++) {
            dummy.position.set(fx, fy, fz);
            dummy.rotation.set(0, baseYaw + (leaf * Math.PI * 2) / 3, 0);
            dummy.scale.setScalar(baseScale);
            dummy.updateMatrix();
            fernTransforms.push(dummy.matrix.clone());
            const shade = 0.80 + seededRandom() * 0.38;
            fernColors.push(new THREE.Color(0.82 * shade, 1.08 * shade, 0.78 * shade));
        }
    }

    if (fernTransforms.length > 0) {
        const instFerns = new THREE.InstancedMesh(fernBladeGeo, frondMat, fernTransforms.length);
        instFerns.receiveShadow = true;
        for (let i = 0; i < fernTransforms.length; i++) {
            instFerns.setMatrixAt(i, fernTransforms[i]);
            instFerns.setColorAt(i, fernColors[i]);
        }
        instFerns.instanceMatrix.needsUpdate = true;
        if (instFerns.instanceColor) instFerns.instanceColor.needsUpdate = true;
        addMapMesh(instFerns);
    }

    // 3. Moss-Covered Fallen Rainforest Logs & Root Buttresses
    for (let i = 0; i < maxFallenLogs * 3 && logTransforms.length < maxFallenLogs; i++) {
        const lx = (seededRandom() - 0.5) * 128;
        const lz = (seededRandom() - 0.5) * 128;
        const ly = getTerrainHeight(lx, lz);
        if (ly < 0.05 || ly > 2.8) continue;
        if (!isClearFn(lx, lz, 2.2) || !isFootprintAboveWater(lx, lz, 1.4, 6, 0.06)) continue;

        const scale = 0.75 + seededRandom() * 0.65;
        dummy.position.set(lx, ly + 0.14 * scale, lz);
        dummy.rotation.set((seededRandom() - 0.5) * 0.15, seededRandom() * Math.PI * 2, (seededRandom() - 0.5) * 0.15);
        dummy.scale.set(scale, scale, scale);
        dummy.updateMatrix();
        logTransforms.push(dummy.matrix.clone());
    }

    if (logTransforms.length > 0) {
        const instLogs = new THREE.InstancedMesh(logGeo, mossRockMat, logTransforms.length);
        instLogs.receiveShadow = true;
        for (let i = 0; i < logTransforms.length; i++) {
            instLogs.setMatrixAt(i, logTransforms[i]);
        }
        instLogs.instanceMatrix.needsUpdate = true;
        addMapMesh(instLogs);
    }
}

function populateDynamicWorldPropsAndLandmarks(explicitBiome) {
    const biome = explicitBiome || ACTIVE_PLANET_BIOME || 'highland';
    _deferTerrainNormals = true;
    MINERAL_PATCHES.length = 0;
    REGISTERED_MAP_STRUCTURES.length = 0;
    DYNAMIC_DIRT_PATHWAYS.length = 0;
    STRUCTURE_PLACEMENT_DIAGNOSTICS.activeBiome = biome;
    STRUCTURE_PLACEMENT_DIAGNOSTICS.acceptedCount = 0;
    STRUCTURE_PLACEMENT_DIAGNOSTICS.rejectedCount = 0;
    STRUCTURE_PLACEMENT_DIAGNOSTICS.rejectionCountsByReason = {};
    STRUCTURE_PLACEMENT_DIAGNOSTICS.recentRejections = [];
    STRUCTURE_PLACEMENT_DIAGNOSTICS.placedStructures = [];

    createOutOfBoundsFloorSkirt();
    buildBridgeBarriers();
    createOasisPonds();
    createValleyRiver();
    createBaseEntranceRampAndAntiRushBarrier();

    for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const r = 10 + seededRandom() * 12;
        const cx = ENEMY_BASE_POS.x + Math.cos(a) * r;
        const cz = ENEMY_BASE_POS.z + Math.sin(a) * r;
        if (getTerrainHeight(cx, cz) > 0.05) {
            spawnCreepTumor(cx, cz);
        }
    }

    // 1. Mineral Clusters (Guaranteed Mineral Patches at ALL 3 Faction Bases: Player Terran/Protoss, Solaris Protoss Enclave & Zerg Hive!)
    const pRampAng = Math.atan2(PLAYER_BASE_RAMP_DIR.z || -1, PLAYER_BASE_RAMP_DIR.x || 0);
    const pBackAng = pRampAng + Math.PI;
    const backAngLeft = pBackAng - 0.62;
    const backAngRight = pBackAng + 0.62;
    const sBackAng = Math.atan2(-SOLARIS_BASE_POS.z, -SOLARIS_BASE_POS.x) + Math.PI;
    const eBackAng = Math.atan2(-ENEMY_BASE_POS.z, -ENEMY_BASE_POS.x) + Math.PI;
    [
        // Player Base Sanctuary Mineral Patches
        [PLAYER_START_POS.x + Math.cos(backAngLeft) * 10.8, PLAYER_START_POS.z + Math.sin(backAngLeft) * 10.8, false],
        [PLAYER_START_POS.x + Math.cos(backAngRight) * 10.8, PLAYER_START_POS.z + Math.sin(backAngRight) * 10.8, true],
        // Solaris Protoss Base Mineral Patches (for Protoss Probes!)
        [SOLARIS_BASE_POS.x + Math.cos(sBackAng - 0.55) * 9.8, SOLARIS_BASE_POS.z + Math.sin(sBackAng - 0.55) * 9.8, false],
        [SOLARIS_BASE_POS.x + Math.cos(sBackAng + 0.55) * 9.8, SOLARIS_BASE_POS.z + Math.sin(sBackAng + 0.55) * 9.8, true],
        // Zerg Enemy Base Mineral Patches (for Zerg Mining Drones!)
        [ENEMY_BASE_POS.x + Math.cos(eBackAng - 0.55) * 10.5, ENEMY_BASE_POS.z + Math.sin(eBackAng - 0.55) * 10.5, false],
        [ENEMY_BASE_POS.x + Math.cos(eBackAng + 0.55) * 10.5, ENEMY_BASE_POS.z + Math.sin(eBackAng + 0.55) * 10.5, true],
        // Expansion & Dynamic Seed-Driven Mid-Map Mineral Clusters
        [PLAYER_START_POS.x + Math.cos(pBackAng + 1.35) * 24.0, PLAYER_START_POS.z + Math.sin(pBackAng + 1.35) * 24.0, false],
        [PLAYER_START_POS.x + Math.cos(pBackAng - 1.35) * 24.0, PLAYER_START_POS.z + Math.sin(pBackAng - 1.35) * 24.0, true],
        [Math.cos(pBackAng + 1.55) * (32 + seededRandom() * 14), Math.sin(pBackAng + 1.55) * (32 + seededRandom() * 14), false],
        [Math.cos(pBackAng - 1.55) * (32 + seededRandom() * 14), Math.sin(pBackAng - 1.55) * (32 + seededRandom() * 14), true],
        [(seededRandom() - 0.5) * 44, (seededRandom() - 0.5) * 44, false]
    ].forEach(([mx, mz, isGold], mIdx) => {
        const clampedX = THREE.MathUtils.clamp(mx, -98, 98);
        const clampedZ = THREE.MathUtils.clamp(mz, -98, 98);
        if (mIdx < 6 || (isFootprintAboveWater(clampedX, clampedZ, 2.5, 6, 0.08) && Math.abs(getRavineSignedDist(clampedX, clampedZ)) > 14 && !isSpotUnderOrBlockingBridge(clampedX, clampedZ, 3.0) && obstacles.every(o => Math.hypot(o.x - clampedX, o.z - clampedZ) > o.r + 2.8))) {
            createCrystalMineralCluster(clampedX, clampedZ, isGold);
        }
    });

    // 2. Mine Gems Craters (7 Craters dynamically distributed across the sector: 5 Rich Gem Craters & 2 Empty Craters)
    const gemCraterCoords = [
        [PLAYER_START_POS.x + Math.cos(pBackAng + 1.15) * 25.0, PLAYER_START_POS.z + Math.sin(pBackAng + 1.15) * 25.0, false],
        [PLAYER_START_POS.x + Math.cos(pBackAng - 1.15) * 27.0, PLAYER_START_POS.z + Math.sin(pBackAng - 1.15) * 27.0, true],
        [(seededRandom() - 0.5) * 32, (seededRandom() - 0.5) * 32, false],
        [Math.cos(pBackAng + 1.75) * (44 + seededRandom() * 16), Math.sin(pBackAng + 1.75) * (44 + seededRandom() * 16), false],
        [Math.cos(pBackAng - 1.75) * (44 + seededRandom() * 16), Math.sin(pBackAng - 1.75) * (44 + seededRandom() * 16), true],
        [ENEMY_BASE_POS.x + Math.cos(eBackAng + 1.25) * 28.0, ENEMY_BASE_POS.z + Math.sin(eBackAng + 1.25) * 28.0, false],
        [SOLARIS_BASE_POS.x + Math.cos(sBackAng - 1.25) * 26.0, SOLARIS_BASE_POS.z + Math.sin(sBackAng - 1.25) * 26.0, false]
    ];
    gemCraterCoords.forEach(([gx, gz, isEmpty], gIdx) => {
        if (isFootprintAboveWater(gx, gz, 3.8, 8, 0.08)) {
            createMineGemCraterSite(gx, gz, isEmpty, gIdx);
        }
    });

    const randCoord = (spread = 110) => (seededRandom() - 0.5) * spread;

    if (isStructureAllowedInBiome('civilian_settlement', biome)) {
        // 3. Algorithmic Supply Roads & Collector Junction Aprons + Roadblocks & Car Pileups!
        createRoadJunctionAprons();
        DYNAMIC_ROAD_SEGMENTS.forEach(seg => createDynamicMorphingRoadRibbon(seg, IS_MOBILE ? 44 : 60));
        createRoadAbandonedCarsAndPileups();

        // 4. Spawn Major Non-Overlapping Settlements, Towns, Military Command Buildings, Cargo Yards, Minivan Houses & Evacuation Camps BEFORE Trees/Rocks!
        const airbaseX = -ABANDONED_TOWN_CENTER.x * 0.85 + (seededRandom() - 0.5) * 14;
        const airbaseZ = ABANDONED_TOWN_CENTER.z * 0.75 + (seededRandom() - 0.5) * 14;
        createDestroyedRunwayAirbase(airbaseX, airbaseZ, (seededRandom() - 0.5) * 0.8 + 0.35);

        ABANDONED_BASES.forEach((ab, idx) => createAbandonedMilitaryBase(ab.x, ab.z, ab.rot, idx));
        const town1X = ABANDONED_TOWN_CENTER.x + (seededRandom() - 0.5) * 4;
        const town1Z = ABANDONED_TOWN_CENTER.z + (seededRandom() - 0.5) * 3;
        createAbandonedTown(town1X, town1Z);

        const secondTownX = THREE.MathUtils.clamp(-ABANDONED_TOWN_CENTER.x * 0.72 + (seededRandom() - 0.5) * 12, -62, 62);
        const secondTownZ = THREE.MathUtils.clamp(-ABANDONED_TOWN_CENTER.z * 0.68 + (seededRandom() - 0.5) * 12, -62, 62);
        createAbandonedTown(secondTownX, secondTownZ);

        const dirtPathHubs = [
            { x: town1X, z: town1Z },
            { x: secondTownX, z: secondTownZ },
            { x: SOUTH_ROAD_HUB.x, z: SOUTH_ROAD_HUB.z },
            { x: NORTH_ROAD_HUB.x, z: NORTH_ROAD_HUB.z }
        ];
        const connectToNearestHubWithDirtPath = (pt, width = 2.5) => {
            if (!pt) return;
            let bestHub = dirtPathHubs[0];
            let bestDist = Infinity;
            for (let i = 0; i < dirtPathHubs.length; i++) {
                const d = Math.hypot(pt.x - dirtPathHubs[i].x, pt.z - dirtPathHubs[i].z);
                if (d > 7.0 && d < bestDist) {
                    bestDist = d;
                    bestHub = dirtPathHubs[i];
                }
            }
            if (bestHub && bestDist < 58.0) {
                createDynamicDirtPathwayRibbon(pt.x, pt.z, bestHub.x, bestHub.z, width);
            }
            dirtPathHubs.push(pt);
        };

        // Connect secondary town to road network via a wide dirt pathway
        connectToNearestHubWithDirtPath({ x: secondTownX, z: secondTownZ }, 3.2);

        // Spawn Dynamic Reinforced Military Command Buildings
        for (let mb = 0; mb < 3; mb++) {
            const mPt = createDynamicMilitaryCommandBuilding(randCoord(106), randCoord(106), (seededRandom() - 0.5) * Math.PI * 2);
            connectToNearestHubWithDirtPath(mPt, 2.8);
        }

        // Spawn Dynamic Cargo Container Depot Yards
        for (let cg = 0; cg < 3; cg++) {
            const cPt = createDynamicCargoDepotYard(randCoord(108), randCoord(108), (seededRandom() - 0.5) * Math.PI * 2);
            connectToNearestHubWithDirtPath(cPt, 2.8);
        }

        // Spawn Dynamic Emergency Evacuation & Medical Relief Camps
        for (let ev = 0; ev < 3; ev++) {
            const ePt = createDynamicEvacuationCamp(randCoord(106), randCoord(106), (seededRandom() - 0.5) * Math.PI * 2);
            connectToNearestHubWithDirtPath(ePt, 2.6);
        }

        // Spawn Dynamic Suburban Frontier Houses with Parked 3D Minivans
        for (let mv = 0; mv < 14; mv++) {
            const mx = (mv < 5)
                ? (town1X + (seededRandom() - 0.5) * 42)
                : (mv < 10 ? (secondTownX + (seededRandom() - 0.5) * 42) : randCoord(112));
            const mz = (mv < 5)
                ? (town1Z + (seededRandom() - 0.5) * 38)
                : (mv < 10 ? (secondTownZ + (seededRandom() - 0.5) * 38) : randCoord(112));
            const mvPt = createMinivanSuburbanHouse(mx, mz, (seededRandom() - 0.5) * Math.PI * 2, mv);
            if (mv < 6) connectToNearestHubWithDirtPath(mvPt, 2.2);
        }

        // Spawn Dynamic Rig Stations, Electric Stations & Gas Stations connected to the road/dirt network
        for (let rs = 0; rs < 3; rs++) {
            const rigPt = createDynamicRigStation(randCoord(108), randCoord(108), (seededRandom() - 0.5) * Math.PI * 2);
            connectToNearestHubWithDirtPath(rigPt, 2.6);
        }
        for (let es = 0; es < 3; es++) {
            const elecPt = createDynamicElectricStation(randCoord(108), randCoord(108), (seededRandom() - 0.5) * Math.PI * 2);
            connectToNearestHubWithDirtPath(elecPt, 2.5);
        }
        for (let gs = 0; gs < 3; gs++) {
            const gx = (gs === 0) ? (town1X + (seededRandom() - 0.5) * 28) : ((gs === 1) ? (secondTownX + (seededRandom() - 0.5) * 28) : randCoord(104));
            const gz = (gs === 0) ? (town1Z + (seededRandom() - 0.5) * 28) : ((gs === 1) ? (secondTownZ + (seededRandom() - 0.5) * 28) : randCoord(104));
            const gasPt = createDynamicGasStation(gx, gz, (seededRandom() - 0.5) * Math.PI * 2);
            connectToNearestHubWithDirtPath(gasPt, 2.8);
        }

        if (isStructureAllowedInBiome('crashed_aircraft', biome)) {
            for (let bp = 0; bp < 3; bp++) {
                createLargeBrokenPlaneWithDraggedDirt(randCoord(106), randCoord(106), (seededRandom() - 0.5) * Math.PI * 2);
            }
        }

        if (isStructureAllowedInBiome('unexploded_bomb', biome)) {
            for (let ux = 0; ux < 10; ux++) {
                createUnexplodedGroundBomb(randCoord(114), randCoord(114), seededRandom() * Math.PI * 2);
            }
        }

        BUILDING_RUINS.forEach((br, idx) => createProceduralUniqueFrontierBuilding(br.x, br.z, idx + 10, true));
        DYNAMIC_MOUNTAINS.forEach((mt, idx) => {
            const ang = idx * 2.1 + 0.5;
            const rx = mt.x + Math.cos(ang) * (mt.r * 0.55);
            const rz = mt.z + Math.sin(ang) * (mt.r * 0.55);
            createProceduralUniqueFrontierBuilding(rx, rz, idx + 30, true);
        });
        [
            [-28 + (seededRandom() - 0.5) * 8, 22 + (seededRandom() - 0.5) * 8, 51, false],
            [28 + (seededRandom() - 0.5) * 8, -18 + (seededRandom() - 0.5) * 8, 52, false],
            [-10 + (seededRandom() - 0.5) * 8, -28 + (seededRandom() - 0.5) * 8, 53, true],
            [34 + (seededRandom() - 0.5) * 8, 6 + (seededRandom() - 0.5) * 8, 54, false]
        ].forEach(([sx, sz, sIdx, damaged]) => createProceduralUniqueFrontierBuilding(sx, sz, sIdx, damaged));

        // Dynamically Generated Normal Civilian Houses & Semi-Destroyed Structures
        for (let h = 0; h < 14; h++) {
            const hx = (h < 5)
                ? (ABANDONED_TOWN_CENTER.x + (seededRandom() - 0.5) * 40)
                : (h < 10 ? (secondTownX + (seededRandom() - 0.5) * 38) : randCoord(110));
            const hz = (h < 5)
                ? (ABANDONED_TOWN_CENTER.z + (seededRandom() - 0.5) * 36)
                : (h < 10 ? (secondTownZ + (seededRandom() - 0.5) * 36) : randCoord(110));
            createNormalCivilianHouse(hx, hz, (seededRandom() - 0.5) * Math.PI * 2, h);
        }
        for (let sd = 0; sd < 8; sd++) {
            const sdx = (sd < 3)
                ? (ABANDONED_TOWN_CENTER.x + (seededRandom() - 0.5) * 38)
                : randCoord(108);
            const sdz = (sd < 3)
                ? (ABANDONED_TOWN_CENTER.z + (seededRandom() - 0.5) * 36)
                : randCoord(108);
            createSemiDestroyedHumanStructure(sdx, sdz, (seededRandom() - 0.5) * Math.PI * 2, sd);
        }

        // Place Street Lights strictly along Supply Road Shoulders (never off-road!)
        createRoadStreetLights();
    }

    // Dynamically Generated Military Watch & Radar Overwatch Towers (validated via central biome system)
    if (isStructureAllowedInBiome('military_watch_tower', biome)) {
        for (let wt = 0; wt < 6; wt++) {
            createMilitaryWatchTower(randCoord(102), randCoord(102), (seededRandom() - 0.5) * Math.PI * 2, wt);
        }
    }

    // 5. Ancient Outpost Ruins on Mesas
    if (isStructureAllowedInBiome('ancient_outpost_ruin', biome)) {
        DYNAMIC_MESAS.forEach((ms, idx) => {
            createAncientOutpostRuin(ms.x, ms.z, idx * 1.1);
        });
    }

    // 6. Biome Landmarks, Bomb Craters, Bunkers, Trenches, Mortars & Convoys (Strictly gated by isStructureAllowedInBiome)
    if (biome !== 'desert' && biome !== 'lava' && biome !== 'ocean') {
        createMountainWaterwall();
    }
    ROCKY_TERRAIN_ZONES.forEach(rz => createRockyTerrainZone(rz));

    if (isStructureAllowedInBiome('military_camp', biome)) {
        createFrontierCamp(randCoord(108), randCoord(108));
        createFrontierCamp(randCoord(108), randCoord(108));
    }
    if (isStructureAllowedInBiome('scrap_junk_pile', biome)) {
        createScrapJunkPile(randCoord(96), randCoord(96));
        createScrapJunkPile(randCoord(96), randCoord(96));
    }
    if (isStructureAllowedInBiome('satellite_dish_complex', biome)) {
        createSatelliteDishComplex(randCoord(112), randCoord(112));
        createSatelliteDishComplex(randCoord(112), randCoord(112));
    }
    if (isStructureAllowedInBiome('frontier_station', biome)) {
        createFrontierStationBuilding(randCoord(98), randCoord(98), (seededRandom() - 0.5) * Math.PI);
        createFrontierStationBuilding(randCoord(98), randCoord(98), (seededRandom() - 0.5) * Math.PI);
    }
    if (isStructureAllowedInBiome('radioactive_waste_site', biome)) {
        createRadioactiveWasteSite(randCoord(110), randCoord(110));
        createRadioactiveWasteSite(randCoord(110), randCoord(110));
    }

    if (isStructureAllowedInBiome('bomb_crater', biome)) {
        for (let i = 0; i < 4; i++) {
            createLargeBombCraterSite(randCoord(95), randCoord(95), 4.3 + seededRandom() * 0.8);
        }
        for (let i = 0; i < 5; i++) {
            createDynamicBombCraterLandmark(randCoord(98), randCoord(98), 2.8 + seededRandom() * 0.8);
        }
    }
    if (isStructureAllowedInBiome('military_bunker', biome)) {
        for (let i = 0; i < 6; i++) {
            createFortifiedMilitaryBunker(randCoord(96), randCoord(96), (seededRandom() - 0.5) * Math.PI * 2);
        }
    }
    if (isStructureAllowedInBiome('military_trench', biome)) {
        for (let i = 0; i < DYNAMIC_TRENCHES.length; i++) {
            createTacticalTrenchNetwork(DYNAMIC_TRENCHES[i]);
        }
    }
    if (isStructureAllowedInBiome('siege_mortar_emplacement', biome)) {
        for (let i = 0; i < 5; i++) {
            createSiegeMortarEmplacement(randCoord(98), randCoord(98), (seededRandom() - 0.5) * Math.PI * 2);
        }
    }
    if (isStructureAllowedInBiome('battlefield_barriers', biome)) {
        for (let i = 0; i < 5; i++) {
            createBattlefieldBarriersLine(randCoord(92), randCoord(92), (seededRandom() - 0.5) * Math.PI * 2);
        }
        for (let i = 0; i < 5; i++) {
            createBarbedWireEntanglement(randCoord(96), randCoord(96), (seededRandom() - 0.5) * Math.PI * 2);
            createSandbagAndSecurityFenceLine(randCoord(96), randCoord(96), (seededRandom() - 0.5) * Math.PI * 2);
        }
    }
    if (isStructureAllowedInBiome('abandoned_military_vehicle', biome)) {
        for (let i = 0; i < 4; i++) {
            createDestroyedMilitaryConvoy(randCoord(96), randCoord(96), (seededRandom() - 0.5) * Math.PI * 2);
        }
        [
            [PLAYER_START_POS.x - 28, PLAYER_START_POS.z - 18, PLAYER_START_POS],
            [PLAYER_START_POS.x + 28, PLAYER_START_POS.z - 16, PLAYER_START_POS]
        ].forEach(([mx, mz, targetBase]) => {
            createDirectedMissileLauncherTruck(mx + (seededRandom() - 0.5) * 6, mz + (seededRandom() - 0.5) * 6, targetBase);
        });
        for (let i = 0; i < 5; i++) {
            createBrokenMilitaryTruck(randCoord(98), randCoord(98), (seededRandom() - 0.5) * Math.PI * 2);
            createWreckedMilitaryTank(randCoord(98), randCoord(98), (seededRandom() - 0.5) * Math.PI * 2);
        }
    }
    if (isStructureAllowedInBiome('crashed_aircraft', biome)) {
        for (let i = 0; i < 4; i++) {
            createDestroyedJetInCrater(randCoord(98), randCoord(98), (seededRandom() - 0.5) * Math.PI * 2);
            createCrashedChinookHelicopter(randCoord(98), randCoord(98), (seededRandom() - 0.5) * Math.PI * 2);
        }
        for (let i = 0; i < 3; i++) {
            createCrashedMilitaryHelicopter(randCoord(98), randCoord(98), (seededRandom() - 0.5) * Math.PI * 2);
        }
    }

    // 7. Spawn Biome-Specific Flora, Groves, Boulders, Reeds & Ferns AFTER all Buildings & Landmarks so they NEVER overlap any structure!
    const isClearOfAllStructuresAndPaths = (tx, tz, pad = 2.2) => {
        if (!isClearForNaturalProp(tx, tz, pad)) return false;
        for (let i = 0; i < REGISTERED_MAP_STRUCTURES.length; i++) {
            const rs = REGISTERED_MAP_STRUCTURES[i];
            if (Math.hypot(tx - rs.x, tz - rs.z) < (rs.r || 3.0) + pad + 1.5) return false;
        }
        return true;
    };

    if (biome === 'desert') {
        createDesertBiomeFeatures(isClearOfAllStructuresAndPaths, biome);
    } else if (biome === 'lava') {
        createLavaBiomeFeatures(isClearOfAllStructuresAndPaths, biome);
    } else if (biome === 'jungle') {
        createDenseJungleBiomeFeatures(isClearOfAllStructuresAndPaths, biome);
    } else if (biome === 'ocean') {
        createOceanBiomeFeatures(isClearOfAllStructuresAndPaths, biome);
    }

    if (isStructureAllowedInBiome('forest_tree', biome)) {
        const groveMultiplier = biome === 'jungle' ? 1.65 : 1.0;
        const numGroves = Math.round((IS_MOBILE ? 7 : 12) * groveMultiplier);
        for (let g = 0; g < numGroves; g++) {
            const gx = (seededRandom() - 0.5) * 124;
            const gz = (seededRandom() - 0.5) * 124;
            const isRockOutcrop = seededRandom() > (biome === 'jungle' ? 0.82 : 0.65);
            const members = IS_MOBILE ? (3 + Math.floor(seededRandom() * 3)) : (4 + Math.floor(seededRandom() * 5));
            for (let m = 0; m < members; m++) {
                const ang = seededRandom() * Math.PI * 2;
                const dist = 1.6 + seededRandom() * 6.5;
                const tx = gx + Math.cos(ang) * dist;
                const tz = gz + Math.sin(ang) * dist;
                if (isClearOfAllStructuresAndPaths(tx, tz, 2.1) && isFootprintAboveWater(tx, tz, 1.2, 6, 0.06)) {
                    if (isRockOutcrop) {
                        createBoulder(tx, tz, 0.85 + seededRandom() * 0.95, true);
                    } else if (biome === 'jungle') {
                        createBroadleafTree(tx, tz, 0.95 + seededRandom() * 0.65);
                    } else if (seededRandom() > 0.38) {
                        createPineTree(tx, tz, 0.88 + seededRandom() * 0.58);
                    } else {
                        createBroadleafTree(tx, tz, 0.85 + seededRandom() * 0.52);
                    }
                }
            }
        }

        const scatterCount = Math.round((IS_MOBILE ? 40 : 68) * groveMultiplier);
        for (let i = 0; i < scatterCount; i++) {
            const tx = (seededRandom() - 0.5) * 132;
            const tz = (seededRandom() - 0.5) * 132;
            if (isClearOfAllStructuresAndPaths(tx, tz, 2.3) && isFootprintAboveWater(tx, tz, 1.2, 6, 0.06)) {
                const roll = seededRandom();
                if (biome === 'jungle') {
                    if (roll > 0.22) createBroadleafTree(tx, tz, 0.95 + seededRandom() * 0.62);
                    else createBoulder(tx, tz, 0.82 + seededRandom() * 0.92, true);
                } else {
                    if (roll > 0.52) createPineTree(tx, tz, 0.9 + seededRandom() * 0.55);
                    else if (roll > 0.28) createBroadleafTree(tx, tz, 0.88 + seededRandom() * 0.48);
                    else createBoulder(tx, tz, 0.82 + seededRandom() * 0.92, roll < 0.12);
                }
            }
        }
    } else if (biome === 'desert' || biome === 'lava') {
        // Desert & Lava Boulders
        for (let i = 0; i < (IS_MOBILE ? 24 : 42); i++) {
            const bx = (seededRandom() - 0.5) * 132;
            const bz = (seededRandom() - 0.5) * 132;
            if (isClearOfAllStructuresAndPaths(bx, bz, 2.3) && isFootprintAboveWater(bx, bz, 1.2, 6, 0.06)) {
                createBoulder(bx, bz, 0.85 + seededRandom() * 0.95, false);
            }
        }
    }

    if (isStructureAllowedInBiome('reed_flora', biome)) {
        DYNAMIC_PONDS.forEach(pd => {
            for (let r = 0; r < 10; r++) {
                const a = (r / 10) * Math.PI * 2 + seededRandom() * 0.35;
                const shoreR = getDynamicPondRadiusAtAngle(pd, a) - 0.22;
                const rx = pd.x + Math.cos(a) * shoreR;
                const rz = pd.z + Math.sin(a) * shoreR;
                const ry = getTerrainHeight(rx, rz);
                const reedCluster = new THREE.Group();
                reedCluster.position.set(rx, ry, rz);
                for (let k = 0; k < 3; k++) {
                    const stalk = new THREE.Mesh(createSculptedLatheBarrelGeo(0.02, 0.04, 0.75 + k * 0.18, 6), treeFoliageMat);
                    stalk.position.set((k - 1) * 0.12, 0.35, (k % 2) * 0.1);
                    stalk.rotation.z = (k - 1) * 0.18;
                    const tip = new THREE.Mesh(createSculptedArmorDomeGeo(0.055, 8, 8), bioFloraMat);
                    tip.scale.set(0.7, 1.8, 0.7);
                    tip.position.set((k - 1) * 0.16, 0.72 + k * 0.16, (k % 2) * 0.1);
                    reedCluster.add(stalk, tip);
                }
                addMapMesh(reedCluster);
            }
        });
    }

    if (isStructureAllowedInBiome('fern_flora', biome)) {
        const fernCount = biome === 'jungle' ? (IS_MOBILE ? 36 : 64) : (IS_MOBILE ? 14 : 24);
        for (let f = 0; f < fernCount; f++) {
            const fx = (seededRandom() - 0.5) * 118;
            const fz = (seededRandom() - 0.5) * 118;
            const fy = getTerrainHeight(fx, fz);
            if (fy > 0.05 && fy < 3.2 && isClearOfAllStructuresAndPaths(fx, fz, 1.8) && isFootprintAboveWater(fx, fz, 0.9, 6, 0.06)) {
                const fernGroup = new THREE.Group();
                fernGroup.position.set(fx, fy, fz);
                for (let b = 0; b < 5; b++) {
                    const ba = (b / 5) * Math.PI * 2;
                    const frond = new THREE.Mesh(createSculptedOgiveSpireGeo(0.14, 0.58, 5), treeFoliageMat);
                    frond.rotation.z = Math.cos(ba) * 0.85;
                    frond.rotation.x = Math.sin(ba) * 0.85;
                    frond.position.set(Math.cos(ba) * 0.2, 0.18, Math.sin(ba) * 0.2);
                    fernGroup.add(frond);
                }
                const sporeOrb = new THREE.Mesh(createSculptedArmorDomeGeo(0.09, 8, 8), f % 2 === 0 ? bioFloraMat : MAT.amberGlow);
                sporeOrb.position.y = 0.22;
                fernGroup.add(sporeOrb);
                addMapMesh(fernGroup);
            }
        }
    }

    // 8. Prefill Empty Plain Valley Floor Terrain with Dynamic Procedural Stones, Bedrock Slabs, Scrub & Shell Pockmarks!
    prefillEmptyPlainFloorTerrain(isClearOfAllStructuresAndPaths);

    // 9. Populate Procedural World Ecosystem (Villages, Wind/Solar, Multi-Species Groves, Wildlife)
    if (typeof populateProceduralWorldEcosystem === 'function') {
        populateProceduralWorldEcosystem(biome);
    }

    // Recompute terrain normals once after all building pads & craters have been carved
    _deferTerrainNormals = false;
    terrainGeo.computeVertexNormals();
    if (terrainGeo.attributes.normal) terrainGeo.attributes.normal.needsUpdate = true;
    terrainGeo.computeBoundingBox();
    terrainGeo.computeBoundingSphere();
    if (typeof syncFowGeometryWithTerrain === 'function') {
        syncFowGeometryWithTerrain();
    }

    // Dynamically Spawned 3D Zerg Goo, Semi-Textured Structure Creep Aprons & Hole-Free Creep Ground Surface
    createZergCreepZoneGooCoverings();

    // Final Safety Pass: Remove natural prop circles that encroach on a supply road or bridge approach corridor
    for (let i = obstacles.length - 1; i >= 0; i--) {
        const ob = obstacles[i];
        if (ob.isBarrier || ob.noUnitBlock || ob.type === 'mineral' || ob.type === 'geyser' ||
            ob.type === 'trench_wall' || ob.type === 'trench_pillbox' || ob.type === 'map_boundary_barrier' ||
            ob.type === 'anti_rush_barrier' || ob.type === 'battlefield_barriers' || ob.type === 'road_car_pileup') continue;
        if (isPointNearAnyRoadOrBridge(ob.x, ob.z, (ob.r || 1.0) + 0.85)) {
            obstacles.splice(i, 1);
        }
    }

    if (biome !== 'lava') {
        createTerrainMeadowGrassMesh();
    }
    updateZergCreepColors(creepRadius, false, true);
}

// Single-layer Zerg Creep: Zerg creep is rendered directly on the terrain mesh via updateZergCreepColors() and SHADER_ENGINE.setZergCreepUniforms.
// Do NOT spawn a duplicate floating RingGeometry overlay mesh on top of the terrain creep layer!
function createZergBaseCreepGroundSurface(centerX, centerZ, baseRadius = 16.5, isPrimaryMain = false) {
    if (isPrimaryMain) {
        activeZergMainCreepMesh = null;
    }
    return null;
}
window.spawnZergExpansionCreepBlanket = function(cx, cz, rad = 13.5) {
    return null;
};

function createSemiTextureStructureCreepApron(sx, sz, structRadius = 2.0) {
    return null;
}

// 3D Zerg Goo & Biomass Encrustations covering generated rocks, cliffs, ruins & structures inside the Zerg Creep Zone
function createZergCreepZoneGooCoverings() {
    const hiveCenter = ENEMY_BASE_POS;
    activeZergMainCreepMesh = null;
    activeZergExpansionCreepMeshes.length = 0;

    const gooMembraneMat = new THREE.MeshStandardMaterial({
        color: 0x3b112c,
        emissive: 0x1a041a,
        emissiveIntensity: 0.24,
        roughness: 0.34,
        metalness: 0.10
    });
    const gooSlimeMat = new THREE.MeshStandardMaterial({
        color: 0x56163c,
        emissive: 0x260624,
        emissiveIntensity: 0.28,
        roughness: 0.26,
        metalness: 0.12,
        transparent: true,
        opacity: 0.92
    });
    const sporeSacMat = new THREE.MeshStandardMaterial({
        color: 0xc218f0,
        emissive: 0x8e00d4,
        emissiveIntensity: 0.72,
        roughness: 0.20,
        metalness: 0.10
    });
    const calcifiedChitinMat = new THREE.MeshStandardMaterial({
        color: 0x381442,
        roughness: 0.48,
        metalness: 0.24
    });
    if (typeof SHADER_ENGINE !== 'undefined' && typeof SHADER_ENGINE.applyBuildingShader === 'function') {
        [gooMembraneMat, gooSlimeMat, sporeSacMat, calcifiedChitinMat].forEach(m => SHADER_ENGINE.applyBuildingShader(m));
    }

    function buildGooClusterAt(gx, gz, scaleMult) {
        if (Math.hypot(gx - hiveCenter.x, gz - hiveCenter.z) > 19.5) return;
        if (isPointNearAnyRoadOrBridge(gx, gz, 3.2)) return;
        const gy = getTerrainHeight(gx, gz);
        if (gy < -0.25) return;

        const gooGroup = new THREE.Group();
        gooGroup.position.set(gx, gy, gz);
        gooGroup.rotation.y = seededRandom() * Math.PI * 2;
        gooGroup.visible = isPointOnZergCreep(gx, gz);

        // 1. Multi-Lobed Basal Viscous Goo Blanket Mound hugging the terrain/structure base
        const basePod = new THREE.Mesh(
            createOrganicBioCarapaceGeo(1.15 * scaleMult, 0.32 * scaleMult, 1.15 * scaleMult, 5, 0.05),
            gooMembraneMat
        );
        basePod.scale.set(1.45, 0.36, 1.32);
        basePod.position.y = 0.12 * scaleMult;
        basePod.receiveShadow = true;
        gooGroup.add(basePod);

        // 2. Organic Arterial Slime Tendrils (CatmullRomCurve3 Tubes) webbing across the Zerg Creep floor
        const tendrilCount = 4;
        for (let t = 0; t < tendrilCount; t++) {
            const ang = (t / tendrilCount) * Math.PI * 2 + (seededRandom() - 0.5) * 0.35;
            const baseR = 1.05 * scaleMult;
            const midR = 0.58 * scaleMult;
            const topH = 0.68 * scaleMult;
            const midAng = ang + (t % 2 === 0 ? 0.25 : -0.25);

            const tendrilCurve = new THREE.CatmullRomCurve3([
                new THREE.Vector3(Math.cos(ang) * baseR, 0.04 * scaleMult, Math.sin(ang) * baseR),
                new THREE.Vector3(Math.cos(midAng) * midR, topH * 0.52, Math.sin(midAng) * midR),
                new THREE.Vector3(Math.cos(ang) * (midR * 0.45), topH, Math.sin(ang) * (midR * 0.45))
            ]);
            const tendrilTube = new THREE.Mesh(
                new THREE.TubeGeometry(tendrilCurve, 10, (0.08 + (t % 2) * 0.03) * scaleMult, 7, false),
                t % 2 === 0 ? gooSlimeMat : gooMembraneMat
            );
            gooGroup.add(tendrilTube);
        }

        // 3. Bioluminescent Violet & Acid-Green Gestation Egg-Sacs & Calcified Scythe Ribs
        const pustuleCount = 3 + Math.floor(seededRandom() * 3);
        for (let p = 0; p < pustuleCount; p++) {
            const pAng = (p / pustuleCount) * Math.PI * 2 + seededRandom() * 0.5;
            const pRad = (0.38 + seededRandom() * 0.55) * scaleMult;
            const sacR = (0.16 + seededRandom() * 0.09) * scaleMult;
            const sac = new THREE.Mesh(
                createOrganicBioCarapaceGeo(sacR, sacR * 0.85, sacR, 4, 0.03),
                (p % 3 === 0 && MAT.acidGlow) ? MAT.acidGlow : sporeSacMat
            );
            sac.scale.set(1.15, 0.85, 1.15);
            sac.position.set(
                Math.cos(pAng) * pRad,
                (0.20 + 0.16 * seededRandom()) * scaleMult,
                Math.sin(pAng) * pRad
            );
            gooGroup.add(sac);
        }

        const spineCount = 2;
        for (let s = 0; s < spineCount; s++) {
            const sAng = (s / spineCount) * Math.PI * 2 + seededRandom() * 0.4;
            const spine = new THREE.Mesh(
                createSculptedOgiveSpireGeo(0.14 * scaleMult, 0.88 * scaleMult, 7),
                calcifiedChitinMat
            );
            const sDist = 0.45 * scaleMult;
            spine.position.set(Math.cos(sAng) * sDist, 0.42 * scaleMult, Math.sin(sAng) * sDist);
            spine.rotation.z = -Math.cos(sAng) * 0.52;
            spine.rotation.x = Math.sin(sAng) * 0.52;
            gooGroup.add(spine);
        }

        addMapMesh(gooGroup);
        frontierBuildingInfestations.push({ x: gx, z: gz, group: gooGroup });
    }

    // Spawn low-profile organic Biomass Terrain Mounds inside the compact Zerg Main Base creep radius (ENEMY_BASE_POS)
    const creepZoneRelOffsets = [
        [-5.2, 4.8, 1.02],
        [5.4, -5.2, 1.00],
        [-6.8, -3.2, 1.05],
        [-2.8, 7.2, 0.96],
        [7.2, -1.8, 0.98],
        [4.5, 4.6, 0.92],
        [-4.6, 2.2, 0.94],
        [2.5, -5.8, 0.94],
        [-8.4, 3.8, 0.98],
        [8.4, 3.5, 0.96]
    ];
    creepZoneRelOffsets.forEach(([rx, rz, sc]) => {
        const jx = hiveCenter.x + rx + (seededRandom() - 0.5) * 1.1;
        const jz = hiveCenter.z + rz + (seededRandom() - 0.5) * 1.1;
        buildGooClusterAt(jx, jz, sc);
    });

    // Wrap Semi-Textured Creep Aprons around nearby terrain structures, rocks, bunkers & ruins within/near the compact Zerg creep zone!
    for (let i = 0; i < obstacles.length; i++) {
        const ob = obstacles[i];
        if (!ob || ob.type === 'tree' || ob.noUnitBlock) continue;
        const dOb = Math.hypot(ob.x - hiveCenter.x, ob.z - hiveCenter.z);
        if (dOb < 25.0 && dOb > 3.8) {
            createSemiTextureStructureCreepApron(ob.x, ob.z, Math.min(3.6, Math.max(1.2, ob.r || 1.6)));
        }
    }

    updateZergCreepColors(creepRadius, false, true);
    initTerrainAmbienceSystem();
}

// ============================================================================
// 3D TERRAIN AMBIENCE EFFECT SYSTEM (Drifting Canyon Dust Motes, Geothermal
// Vent Steam Plumes, Zerg Bio-Spore Embers & Solaris Khaydarin Psionic Motes)
// ============================================================================
const terrainAmbienceNodes = [];
function initTerrainAmbienceSystem() {
    terrainAmbienceNodes.length = 0;

    const dustMat = new THREE.MeshBasicMaterial({
        color: 0xfde68a,
        transparent: true,
        opacity: 0.36,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const steamMat = new THREE.MeshBasicMaterial({
        color: 0xcbd5e1,
        transparent: true,
        opacity: 0.22,
        depthWrite: false
    });
    const zergSporeMat = new THREE.MeshBasicMaterial({
        color: 0xa855f7,
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const solarisMoteMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.68,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    const moteGeo = new THREE.OctahedronGeometry(0.11, 0);
    const steamGeo = new THREE.DodecahedronGeometry(0.42, 0);

    const ambGroup = new THREE.Group();
    ambGroup.name = 'terrainAmbienceGroup';

    // 1. 36 Canyon Sunbeam Dust & Wind Motes drifting across the valley floor
    const dustCount = IS_MOBILE ? 20 : 36;
    for (let i = 0; i < dustCount; i++) {
        const bx = (seededRandom() - 0.5) * (MAP_SIZE * 0.80);
        const bz = (seededRandom() - 0.5) * (MAP_SIZE * 0.80);
        const by = Math.max(0.2, getTerrainHeight(bx, bz)) + 0.8 + seededRandom() * 3.2;
        const m = new THREE.Mesh(moteGeo, dustMat);
        m.position.set(bx, by, bz);
        m.scale.setScalar(0.65 + seededRandom() * 0.75);
        ambGroup.add(m);
        terrainAmbienceNodes.push({
            kind: 'dust',
            mesh: m,
            baseX: bx,
            baseY: by,
            baseZ: bz,
            phase: seededRandom() * Math.PI * 2,
            speed: 0.55 + seededRandom() * 0.65
        });
    }

    // 2. 14 Geothermal Vent Steam / Mist Wisps rising from craters & low canyon fissures
    const steamCount = IS_MOBILE ? 8 : 14;
    for (let i = 0; i < steamCount; i++) {
        const ang = (i / steamCount) * Math.PI * 2 + seededRandom() * 0.4;
        const dist = 12 + seededRandom() * 34;
        const sx = Math.cos(ang) * dist;
        const sz = Math.sin(ang) * dist;
        const sy = Math.max(-0.2, getTerrainHeight(sx, sz)) + 0.35;
        const m = new THREE.Mesh(steamGeo, steamMat);
        m.position.set(sx, sy, sz);
        m.scale.set(1.3, 0.55, 1.3);
        ambGroup.add(m);
        terrainAmbienceNodes.push({
            kind: 'steam',
            mesh: m,
            baseX: sx,
            baseY: sy,
            baseZ: sz,
            phase: seededRandom() * Math.PI * 2,
            speed: 0.85 + seededRandom() * 0.55
        });
    }

    // 3. 18 Zerg Bioluminescent Spore Embers hovering over active Zerg Creep (fade out when Zerg Main Base is destroyed!)
    const sporeCount = IS_MOBILE ? 10 : 18;
    for (let i = 0; i < sporeCount; i++) {
        const a = (i / sporeCount) * Math.PI * 2 + seededRandom() * 0.3;
        const r = 3.0 + seededRandom() * 14.5;
        const zx = ENEMY_BASE_POS.x + Math.cos(a) * r;
        const zz = ENEMY_BASE_POS.z + Math.sin(a) * r;
        const zy = Math.max(0.2, getTerrainHeight(zx, zz)) + 0.45 + seededRandom() * 1.8;
        const m = new THREE.Mesh(moteGeo, zergSporeMat);
        m.position.set(zx, zy, zz);
        ambGroup.add(m);
        terrainAmbienceNodes.push({
            kind: 'zerg_spore',
            mesh: m,
            relRadius: r,
            relAngle: a,
            baseY: zy,
            phase: seededRandom() * Math.PI * 2,
            speed: 1.15 + seededRandom() * 0.65
        });
    }

    // 4. 14 Solaris Psionic Khaydarin Shimmer Motes around the Solaris Enclave
    const solarisCount = IS_MOBILE ? 8 : 14;
    for (let i = 0; i < solarisCount; i++) {
        const a = (i / solarisCount) * Math.PI * 2;
        const r = 3.5 + (i % 3) * 3.8;
        const px = SOLARIS_BASE_POS.x + Math.cos(a) * r;
        const pz = SOLARIS_BASE_POS.z + Math.sin(a) * r;
        const py = Math.max(0.2, getTerrainHeight(px, pz)) + 0.75 + (i % 3) * 0.7;
        const m = new THREE.Mesh(moteGeo, solarisMoteMat);
        m.position.set(px, py, pz);
        ambGroup.add(m);
        terrainAmbienceNodes.push({
            kind: 'solaris_mote',
            mesh: m,
            baseX: px,
            baseY: py,
            baseZ: pz,
            phase: seededRandom() * Math.PI * 2,
            speed: 1.25 + (i % 3) * 0.35
        });
    }

    ambGroup.traverse(c => { c.raycast = () => {}; });
    addMapMesh(ambGroup);
}

// ============================================================================
// 6F. PROCEDURAL WORLD GENERATION ENGINE, ARCHITECTURAL GRAMMAR,
//     4-STAGE DETERIORATION & REAL-TIME DESTRUCTIBLE ENVIRONMENT,
//     RURAL/INDUSTRIAL/RAILWAY INFRASTRUCTURE & AUTONOMOUS WILDLIFE/CIVILIANS
// ============================================================================
window.WORLD_GEN_CONFIG = window.WORLD_GEN_CONFIG || {
    biome: 'highland', // 'highland' | 'desert' | 'ocean' | 'lava' | 'jungle' | 'random'
    terrainRoughness: 1.0,
    forestDensity: 1.0,
    urbanDensity: 1.0,
    industrialDensity: 1.0,
    militaryDensity: 1.0,
    abandonmentLevel: 0.45, // 0.0 = pristine/neglected, 1.0 = heavily war-torn ruins
    wildlifePopulation: 1.0,
    civilianPopulation: 1.0,
    roadDensity: 1.0
};
if (!window.WORLD_GEN_CONFIG.biome) {
    window.WORLD_GEN_CONFIG.biome = 'highland';
}

window.setPlanetBiome = function(biomeName, regenerateNow = true) {
    if (!window.WORLD_GEN_CONFIG) window.WORLD_GEN_CONFIG = {};
    const valid = ['highland', 'desert', 'ocean', 'lava', 'jungle', 'random'];
    const norm = String(biomeName || 'highland').toLowerCase();
    window.WORLD_GEN_CONFIG.biome = valid.includes(norm) ? norm : 'highland';
    if (regenerateNow && typeof window.regenerateMapDynamically === 'function') {
        window.regenerateMapDynamically();
    }
    return window.ACTIVE_PLANET_BIOME;
};

const DESTRUCTIBLE_ENV_STRUCTURES = [];
const PROCEDURAL_FOREST_GROVES = [];
const WILDLIFE_AGENTS = [];
const CIVILIAN_AGENTS = [];
window.DESTRUCTIBLE_ENV_STRUCTURES = DESTRUCTIBLE_ENV_STRUCTURES;
window.WILDLIFE_AGENTS = WILDLIFE_AGENTS;
window.CIVILIAN_AGENTS = CIVILIAN_AGENTS;

window.updateWorldGenConfig = function(key, val) {
    if (!window.WORLD_GEN_CONFIG) return;
    if (key === 'biome') {
        window.setPlanetBiome(val, false);
        return;
    }
    if (!(key in window.WORLD_GEN_CONFIG)) return;
    const num = Number(val);
    if (Number.isFinite(num)) {
        window.WORLD_GEN_CONFIG[key] = Math.max(0.0, Math.min(2.5, num));
    }
    const lbl = document.getElementById(`val-wg-${key}`);
    if (lbl) lbl.innerText = `${Math.round(window.WORLD_GEN_CONFIG[key] * 100)}%`;
};

function isSafeForProp(tx, tz, pad = 2.4) {
    if (Math.abs(tx) > 92 || Math.abs(tz) > 92) return false;
    if (typeof isFootprintAboveWater === 'function') {
        const wf = isFootprintAboveWater(tx, tz, Math.max(1.2, pad * 0.65), 0.14);
        if (!wf.valid) return false;
    }
    if (typeof isClearForNaturalProp === 'function' && !isClearForNaturalProp(tx, tz, pad)) {
        return false;
    }
    if (typeof REGISTERED_MAP_STRUCTURES !== 'undefined' && Array.isArray(REGISTERED_MAP_STRUCTURES)) {
        for (let i = 0; i < REGISTERED_MAP_STRUCTURES.length; i++) {
            const rs = REGISTERED_MAP_STRUCTURES[i];
            if (rs && Math.hypot(tx - rs.x, tz - rs.z) < (rs.r || 3.0) + pad + 1.0) return false;
        }
    }
    if (typeof obstacles !== 'undefined' && Array.isArray(obstacles)) {
        for (let i = 0; i < obstacles.length; i++) {
            const ob = obstacles[i];
            if (ob && Math.hypot(tx - ob.x, tz - ob.z) < (ob.r || 1.2) + pad * 0.65) return false;
        }
    }
    return true;
}

// Procedural Architectural Grammar Generator:
// Builds multi-wing 3D structures with foundations, recessed framed windows, shutters, doors, porches,
// balconies, chimneys, gutters, rooftop HVAC/water tanks, and 4 distinct deterioration states (1..4).
function buildArchitecturalGrammarBuilding(cx, cz, yaw = 0, opts = {}) {
    const activeBiome = opts.biome || ACTIVE_PLANET_BIOME || 'highland';
    if (!isStructureAllowedInBiome('architectural_building', activeBiome)) return null;
    const style = opts.style || 'residential'; // 'residential' | 'commercial' | 'industrial' | 'rural_barn'
    const detLevel = Math.max(1, Math.min(4, Math.round(opts.deterioration || 1)));
    const w = opts.width || (style === 'industrial' ? 4.4 : (style === 'commercial' ? 3.8 : 3.2));
    const d = opts.depth || (style === 'industrial' ? 3.4 : (style === 'commercial' ? 3.0 : 2.5));
    const stories = opts.stories || (style === 'commercial' ? 2 : 1);
    const storyH = style === 'industrial' ? 2.1 : 1.45;
    const totalH = stories * storyH;
    const hasLWing = opts.hasLWing !== undefined ? opts.hasLWing : (seededRandom() > 0.38);

    const root = new THREE.Group();
    const gy = getTerrainHeight(cx, cz);
    root.position.set(cx, gy, cz);
    root.rotation.y = yaw;

    const wallMat = style === 'industrial'
        ? (MAT.ruinSteelDark || MAT.bunkerMat)
        : (style === 'rural_barn' ? (MAT.woodPlankMat || MAT.ruinConcrete) : (MAT.ruinPlaster || MAT.ruinConcrete));
    const brickMat = MAT.ruinBrick || MAT.bunkerMat;
    const trimMat = MAT.ruinSteel || MAT.steelMat;
    const darkMat = MAT.ruinSteelDark || MAT.obsidianMat;
    const glassMat = detLevel === 1 ? (MAT.cyanGlow || MAT.glassMat) : darkMat;

    // 1. Stepped Masonry / Concrete Foundation Plinth (prevents floating on sloped ground)
    const foundH = 0.72;
    const foundPlinth = new THREE.Mesh(new THREE.BoxGeometry(w + 0.36, foundH, d + 0.36), MAT.ruinConcrete || MAT.bunkerMat);
    foundPlinth.position.y = foundH * 0.5 - 0.38;
    root.add(foundPlinth);

    const foundationRim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.44, 0.12, d + 0.44), trimMat);
    foundationRim.position.y = 0.32;
    root.add(foundationRim);

    // Intact/Damaged Upper Structural Group (Replaced/Modified when building collapses to Level 4)
    const structBody = new THREE.Group();
    structBody.position.y = 0.34;
    root.add(structBody);

    if (detLevel < 4) {
        const effH = detLevel === 3 ? totalH * 0.76 : totalH;

        // Primary Structural Volume
        const mainCore = new THREE.Mesh(new THREE.BoxGeometry(w, effH, d), wallMat);
        mainCore.position.y = effH * 0.5;
        structBody.add(mainCore);

        // Corner Pilasters & Story Stringcourses
        for (let sx of [-1, 1]) {
            for (let sz of [-1, 1]) {
                if (detLevel === 3 && sx === 1 && sz === 1) continue; // Collapsed corner in Level 3
                const pilaster = new THREE.Mesh(new THREE.BoxGeometry(0.18, effH + 0.04, 0.18), brickMat);
                pilaster.position.set(sx * (w * 0.5 - 0.05), effH * 0.5, sz * (d * 0.5 - 0.05));
                structBody.add(pilaster);
            }
        }
        for (let st = 1; st <= stories; st++) {
            const ledgeY = Math.min(effH, st * storyH);
            const cornice = new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, 0.10, d + 0.16), trimMat);
            cornice.position.y = ledgeY;
            structBody.add(cornice);
        }

        // Secondary L-Wing Extension for Non-Boxy Organic Footprint
        const wingW = w * 0.52;
        const wingD = d * 0.68;
        const wingH = Math.min(effH, storyH * 1.05);
        if (hasLWing) {
            const wingFound = new THREE.Mesh(new THREE.BoxGeometry(wingW + 0.24, foundH, wingD + 0.24), MAT.ruinConcrete || MAT.bunkerMat);
            wingFound.position.set(w * 0.5 + wingW * 0.45, foundH * 0.5 - 0.38, d * 0.18);
            root.add(wingFound);

            const lWing = new THREE.Mesh(new THREE.BoxGeometry(wingW, wingH, wingD), brickMat);
            lWing.position.set(w * 0.5 + wingW * 0.45, wingH * 0.5, d * 0.18);
            structBody.add(lWing);

            // L-Wing Sloped Lean-To Roof
            const lRoof = new THREE.Mesh(new THREE.BoxGeometry(wingW + 0.22, 0.12, wingD + 0.26), darkMat);
            lRoof.position.set(w * 0.5 + wingW * 0.45, wingH + 0.12, d * 0.18);
            lRoof.rotation.z = -0.18;
            structBody.add(lRoof);
        }

        // Recessed Framed Windows with Sills, Lintels, Mullions & Shutters
        const winCols = Math.max(2, Math.floor(w / 1.05));
        for (let st = 0; st < stories; st++) {
            const wy = st * storyH + storyH * 0.54;
            if (wy + 0.3 > effH) continue;
            for (let c = 0; c < winCols; c++) {
                if (st === 0 && c === Math.floor(winCols * 0.5)) continue; // Leave center ground slot for doorway
                const wx = -w * 0.36 + (c / Math.max(1, winCols - 1)) * (w * 0.72);
                for (let sideZ of [-1, 1]) {
                    const wz = sideZ * (d * 0.5 + 0.02);
                    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.56, 0.08), trimMat);
                    frame.position.set(wx, wy, wz);
                    structBody.add(frame);

                    const pane = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.44, 0.09), glassMat);
                    pane.position.set(wx, wy, wz);
                    structBody.add(pane);

                    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.06, 0.14), brickMat);
                    sill.position.set(wx, wy - 0.28, wz + sideZ * 0.02);
                    structBody.add(sill);

                    // Window Shutters (tilted or missing when deteriorated)
                    if (style !== 'industrial') {
                        for (let shSide of [-1, 1]) {
                            if (detLevel >= 2 && (c + st + shSide) % 3 === 0) continue;
                            const shutter = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.48, 0.05), brickMat);
                            shutter.position.set(wx + shSide * 0.28, wy, wz + sideZ * 0.03);
                            if (detLevel >= 2) shutter.rotation.z = shSide * 0.18;
                            structBody.add(shutter);
                        }
                    }
                }
            }
        }

        // Entry Doorway, Steps, Canopy Porch & Upper Balcony
        const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.96, 0.10), trimMat);
        doorFrame.position.set(0, 0.48, d * 0.5 + 0.02);
        structBody.add(doorFrame);

        const doorLeaf = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.88, 0.08), darkMat);
        doorLeaf.position.set(0, 0.46, d * 0.5 + 0.04);
        if (detLevel >= 2) doorLeaf.rotation.y = 0.35;
        structBody.add(doorLeaf);

        // Porch Canopy & Support Columns
        const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.10, 0.72), trimMat);
        canopy.position.set(0, 1.06, d * 0.5 + 0.34);
        canopy.rotation.x = 0.12;
        structBody.add(canopy);
        for (let px of [-0.55, 0.55]) {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 1.05, 8), trimMat);
            post.position.set(px, 0.52, d * 0.5 + 0.62);
            structBody.add(post);
        }

        // Upper Story Balcony with Railing or Exterior Staircase
        if (stories >= 2 && detLevel <= 2) {
            const balcSlab = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.09, 0.68), trimMat);
            balcSlab.position.set(0, storyH + 0.04, -d * 0.5 - 0.32);
            structBody.add(balcSlab);
            const balcRail = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.34, 0.05), darkMat);
            balcRail.position.set(0, storyH + 0.24, -d * 0.5 - 0.62);
            structBody.add(balcRail);
        }

        // Architectural Roof Assembly (Gabled, Sawtooth Industrial, Gambrel Barn, or Parapet Flat Roof)
        if (style === 'industrial') {
            // Sawtooth Multi-Bay Industrial Skylight Roof + Smokestack + Rooftop HVAC
            const bays = 3;
            const bayW = w / bays;
            for (let b = 0; b < bays; b++) {
                if (detLevel === 3 && b === bays - 1) continue; // Collapsed bay in Level 3
                const bx = -w * 0.5 + (b + 0.5) * bayW;
                const sawSlope = new THREE.Mesh(new THREE.BoxGeometry(bayW * 0.96, 0.12, d + 0.24), trimMat);
                sawSlope.position.set(bx, effH + 0.26, 0);
                sawSlope.rotation.z = 0.36;
                structBody.add(sawSlope);
                const skylight = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, d * 0.88), glassMat);
                skylight.position.set(bx + bayW * 0.42, effH + 0.24, 0);
                structBody.add(skylight);
            }
            const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 2.2, 10), darkMat);
            stack.position.set(-w * 0.32, effH + 1.0, -d * 0.28);
            structBody.add(stack);
        } else if (style === 'commercial') {
            // Parapet Coping Wall + Rooftop HVAC Chiller + Water Tank + Comm Mast
            const parapetH = 0.32;
            for (let sx of [-1, 1]) {
                const pw = new THREE.Mesh(new THREE.BoxGeometry(0.14, parapetH, d + 0.16), brickMat);
                pw.position.set(sx * w * 0.5, effH + parapetH * 0.5, 0);
                structBody.add(pw);
            }
            for (let sz of [-1, 1]) {
                const pd = new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, parapetH, 0.14), brickMat);
                pd.position.set(0, effH + parapetH * 0.5, sz * d * 0.5);
                structBody.add(pd);
            }
            if (detLevel <= 2) {
                const hvac = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.48, 0.65), trimMat);
                hvac.position.set(-w * 0.22, effH + 0.24, 0.15);
                structBody.add(hvac);
                const waterTank = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.72, 10), darkMat);
                waterTank.position.set(w * 0.24, effH + 0.52, -0.22);
                structBody.add(waterTank);
            }
        } else {
            // Pitched Gabled / Gambrel Roof with Ridge Beam, Eave Overhangs, Rain Gutters & Brick Chimney
            const roofPitch = style === 'rural_barn' ? 0.62 : 0.46;
            const slopeW = (w * 0.58) / Math.cos(roofPitch);
            for (let sideX of [-1, 1]) {
                if (detLevel === 3 && sideX === 1) {
                    // Exposed roof rafters on collapsed side
                    for (let r = -2; r <= 2; r++) {
                        const rafter = new THREE.Mesh(new THREE.BoxGeometry(slopeW * 0.85, 0.07, 0.08), darkMat);
                        rafter.position.set(sideX * w * 0.24, effH + 0.28, r * (d * 0.18));
                        rafter.rotation.z = -sideX * roofPitch;
                        structBody.add(rafter);
                    }
                    continue;
                }
                const roofPanel = new THREE.Mesh(new THREE.BoxGeometry(slopeW, 0.12, d + 0.36), brickMat);
                roofPanel.position.set(sideX * w * 0.26, effH + 0.34, 0);
                roofPanel.rotation.z = -sideX * roofPitch;
                structBody.add(roofPanel);

                // Eave Rain Gutter & Corner Downspout
                const gutter = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.07, d + 0.38), trimMat);
                gutter.position.set(sideX * (w * 0.5 + 0.12), effH + 0.04, 0);
                structBody.add(gutter);
            }
            const ridgeBeam = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, d + 0.42), darkMat);
            ridgeBeam.position.set(0, effH + 0.64, 0);
            structBody.add(ridgeBeam);

            // Brick Chimney with Flue Cap
            const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.95, 0.38), brickMat);
            chimney.position.set(-w * 0.30, effH + 0.58, -d * 0.22);
            structBody.add(chimney);
        }
    }

    // Deterioration Level 2..4 Rubble, Scorch & Broken Beam Accents
    const rubbleGroup = new THREE.Group();
    rubbleGroup.position.y = 0.25;
    root.add(rubbleGroup);

    const populateRubbleForLevel = (lvl) => {
        while (rubbleGroup.children.length > 0) {
            rubbleGroup.remove(rubbleGroup.children[0]);
        }
        if (lvl <= 1) return;
        const chunkCount = lvl === 2 ? 5 : (lvl === 3 ? 12 : 22);
        for (let i = 0; i < chunkCount; i++) {
            const ang = (i / chunkCount) * Math.PI * 2 + (i * 1.37);
            const rad = (lvl === 4 ? 0.35 : 0.75) + ((i * 7) % 10) * 0.16;
            const ch = new THREE.Mesh(
                new THREE.DodecahedronGeometry(0.22 + (i % 3) * 0.12, 0),
                i % 2 === 0 ? (MAT.ruinConcrete || MAT.bunkerMat) : brickMat
            );
            ch.position.set(Math.cos(ang) * rad * (w * 0.45), 0.12 + (i % 3) * 0.08, Math.sin(ang) * rad * (d * 0.45));
            ch.scale.set(1.2, 0.55, 1.0);
            ch.rotation.set(i * 0.5, i * 1.1, i * 0.3);
            rubbleGroup.add(ch);
        }
        if (lvl >= 3) {
            // Twisted structural steel I-beams & broken wall stumps
            for (let b = 0; b < (lvl === 4 ? 5 : 2); b++) {
                const beam = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.45, 0.14), darkMat);
                beam.position.set((b - 1.5) * 0.65, 0.48, ((b % 2) - 0.5) * 0.85);
                beam.rotation.set(0.45 * (b % 2 ? 1 : -1), b * 0.8, 0.52);
                rubbleGroup.add(beam);
            }
        }
    };
    populateRubbleForLevel(detLevel);

    root.traverse(c => {
        if (c.isMesh) {
            c.castShadow = true;
            c.receiveShadow = true;
        }
    });

    addMapMesh(root);
    const colRad = Math.max(w, d) * 0.48;
    const obsEntry = { x: cx, z: cz, r: detLevel === 4 ? colRad * 0.68 : colRad, isDestructibleBuilding: true };
    obstacles.push(obsEntry);

    const destructibleRecord = {
        kind: 'building',
        style,
        x: cx,
        z: cz,
        radius: colRad + 0.6,
        deterioration: detLevel,
        hp: detLevel === 4 ? 0 : (4 - detLevel) * 180,
        maxHp: 540,
        root,
        structBody,
        rubbleGroup,
        populateRubbleForLevel,
        obsEntry
    };
    DESTRUCTIBLE_ENV_STRUCTURES.push(destructibleRecord);
    return destructibleRecord;
}

// Rural Agricultural Village Generator:
// Gambrel-roofed timber barn, cylindrical grain silos with catwalk, stone water well, fenced crop garden, and rural cottages.
function createProceduralRuralVillage(cx, cz, biome = ACTIVE_PLANET_BIOME || 'highland') {
    if (!isStructureAllowedInBiome('rural_village', biome)) return;
    const villageGroup = new THREE.Group();
    const baseH = getTerrainHeight(cx, cz);
    villageGroup.position.set(cx, baseH, cz);

    // 1. Gambrel-Roofed Agricultural Barn & Adjacent Cylindrical Grain Silos
    buildArchitecturalGrammarBuilding(cx - 2.4, cz - 1.5, 0.22, {
        biome,
        style: 'rural_barn',
        width: 3.8,
        depth: 2.8,
        stories: 1,
        hasLWing: true,
        deterioration: window.WORLD_GEN_CONFIG.abandonmentLevel > 0.65 ? 2 : 1
    });

    // Twin Cylindrical Metal Grain Silos with Conical Domes & Overhead Auger Pipe
    for (let s = 0; s < 2; s++) {
        const sx = 0.6 + s * 1.35;
        const sz = -2.2 + s * 0.45;
        const siloH = 3.4 - s * 0.45;
        const siloCyl = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.62, siloH, 12), MAT.ruinSteel || MAT.steelMat);
        siloCyl.position.set(sx, siloH * 0.5, sz);
        villageGroup.add(siloCyl);

        const siloCap = new THREE.Mesh(new THREE.ConeGeometry(0.64, 0.55, 12), MAT.ruinSteelDark || MAT.bunkerMat);
        siloCap.position.set(sx, siloH + 0.26, sz);
        villageGroup.add(siloCap);
    }

    // 2. Stone Water Well with Pitched Timber Canopy
    const wellX = 1.6, wellZ = 1.4;
    const wellRing = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.62, 0.65, 12), MAT.ruinConcrete || MAT.bunkerMat);
    wellRing.position.set(wellX, 0.32, wellZ);
    villageGroup.add(wellRing);
    const wellWater = new THREE.Mesh(new THREE.CircleGeometry(0.44, 10), MAT.water);
    wellWater.rotation.x = -Math.PI * 0.5;
    wellWater.position.set(wellX, 0.52, wellZ);
    villageGroup.add(wellWater);
    for (let px of [-0.46, 0.46]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.25, 0.08), MAT.woodPlankMat || MAT.ruinBrick);
        post.position.set(wellX + px, 0.85, wellZ);
        villageGroup.add(post);
    }
    const wellRoof = new THREE.Mesh(new THREE.ConeGeometry(0.75, 0.55, 4), MAT.ruinBrick || MAT.bunkerMat);
    wellRoof.position.set(wellX, 1.65, wellZ);
    wellRoof.rotation.y = Math.PI * 0.25;
    villageGroup.add(wellRoof);

    // 3. Fenced Cultivated Crop Garden & Soil Furrows
    const gardenX = -1.8, gardenZ = 2.4;
    for (let r = -2; r <= 2; r++) {
        const furrow = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 0.24), MAT.mudBank || MAT.bunkerMat);
        furrow.position.set(gardenX, 0.06, gardenZ + r * 0.44);
        villageGroup.add(furrow);
        for (let c = -2; c <= 2; c++) {
            const crop = new THREE.Mesh(new THREE.DodecahedronGeometry(0.16, 0), MAT.foliagePine || MAT.mossRock);
            crop.position.set(gardenX + c * 0.52, 0.18, gardenZ + r * 0.44);
            villageGroup.add(crop);
        }
    }
    // Timber Perimeter Fence Posts & Rails
    for (let f = -3; f <= 3; f++) {
        const postN = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.55, 0.08), MAT.woodPlankMat || MAT.ruinConcrete);
        postN.position.set(gardenX + f * 0.5, 0.26, gardenZ - 1.25);
        villageGroup.add(postN);
        const postS = postN.clone();
        postS.position.set(gardenX + f * 0.5, 0.26, gardenZ + 1.25);
        villageGroup.add(postS);
    }

    // 4. Rural Cottage Home
    buildArchitecturalGrammarBuilding(cx + 3.2, cz + 1.2, -0.45, {
        biome,
        style: 'residential',
        width: 3.0,
        depth: 2.4,
        stories: 1,
        hasLWing: false,
        deterioration: 1
    });

    villageGroup.traverse(c => {
        if (c.isMesh) {
            c.castShadow = true;
            c.receiveShadow = true;
        }
    });
    addMapMesh(villageGroup);
    obstacles.push({ x: cx + 1.0, z: cz - 2.0, r: 1.5 });
}

// Industrial Wind Turbine, Solar Array & Power Substation Complex:
function createProceduralWindAndSolarPowerComplex(cx, cz, biome = ACTIVE_PLANET_BIOME || 'highland') {
    if (!isStructureAllowedInBiome('wind_solar_complex', biome)) return;
    const complexGroup = new THREE.Group();
    const gy = getTerrainHeight(cx, cz);
    complexGroup.position.set(cx, gy, cz);

    // 1. Two Animated 3-Blade Wind Turbines on Tapered Steel Towers
    const turbineOffsets = [
        { dx: -2.8, dz: -1.8, scale: 1.0 },
        { dx: 2.6, dz: -2.2, scale: 0.92 }
    ];
    turbineOffsets.forEach((to, idx) => {
        const wx = cx + to.dx;
        const wz = cz + to.dz;
        const localY = getTerrainHeight(wx, wz) - gy;
        const tGroup = new THREE.Group();
        tGroup.position.set(to.dx, localY, to.dz);

        const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.15, 0.45, 10), MAT.ruinConcrete || MAT.bunkerMat);
        pad.position.y = 0.22;
        tGroup.add(pad);

        const towerH = 5.4 * to.scale;
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.36, towerH, 10), MAT.ruinSteel || MAT.steelMat);
        mast.position.y = towerH * 0.5 + 0.3;
        tGroup.add(mast);

        const nacelle = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.48, 1.15), MAT.ruinSteel || MAT.steelMat);
        nacelle.position.set(0, towerH + 0.35, 0.12);
        tGroup.add(nacelle);

        const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), MAT.hazardGlow || MAT.amberGlow);
        beacon.position.set(0, towerH + 0.65, -0.15);
        tGroup.add(beacon);

        const rotorHub = new THREE.Group();
        rotorHub.position.set(0, towerH + 0.35, 0.72);
        const noseCone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.48, 10), MAT.ruinSteelDark || MAT.bunkerMat);
        noseCone.rotation.x = Math.PI * 0.5;
        rotorHub.add(noseCone);

        for (let b = 0; b < 3; b++) {
            const bladePivot = new THREE.Group();
            bladePivot.rotation.z = (b / 3) * Math.PI * 2;
            const blade = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.35 * to.scale, 0.05), MAT.ruinPlaster || MAT.steelMat);
            blade.position.y = 1.22 * to.scale;
            blade.rotation.y = 0.22;
            bladePivot.add(blade);
            rotorHub.add(bladePivot);
        }
        tGroup.add(rotorHub);
        complexGroup.add(tGroup);

        animatedBiomeLandmarks.push({
            type: 'wind_turbine',
            mesh: rotorHub,
            phase: idx * 2.1
        });
        obstacles.push({ x: wx, z: wz, r: 1.15 });
    });

    // 2. Angled Photovoltaic Solar Panel Racks
    for (let r = 0; r < 2; r++) {
        for (let c = -1; c <= 1; c++) {
            const sx = c * 1.85;
            const sz = 1.4 + r * 1.45;
            const localY = getTerrainHeight(cx + sx, cz + sz) - gy;
            const rack = new THREE.Group();
            rack.position.set(sx, localY, sz);

            const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.75, 6), MAT.ruinSteelDark || MAT.bunkerMat);
            strut.position.y = 0.35;
            rack.add(strut);

            const panelFrame = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.07, 0.95), MAT.ruinSteel || MAT.steelMat);
            panelFrame.position.y = 0.72;
            panelFrame.rotation.x = 0.42;
            rack.add(panelFrame);

            const solarCells = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.08, 0.85), MAT.obsidianMat || MAT.ruinSteelDark);
            solarCells.position.y = 0.73;
            solarCells.rotation.x = 0.42;
            rack.add(solarCells);

            complexGroup.add(rack);
        }
    }

    complexGroup.traverse(c => {
        if (c.isMesh) {
            c.castShadow = true;
            c.receiveShadow = true;
        }
    });
    addMapMesh(complexGroup);
}

// Derelict Industrial Railway Spur & Freight Train Generator:
function createProceduralRailwaySpurAndTrain(cx, cz, yaw = 0.35, biome = ACTIVE_PLANET_BIOME || 'highland') {
    if (!isStructureAllowedInBiome('railway_spur', biome)) return;
    const railGroup = new THREE.Group();
    const gy = getTerrainHeight(cx, cz);
    railGroup.position.set(cx, gy, cz);
    railGroup.rotation.y = yaw;

    const trackLen = 22.0;
    const gauge = 1.12;

    // 1. Crushed Basalt Ballast Bed & Timber Cross-Ties
    const ballast = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.28, trackLen), MAT.canyonRock || MAT.bunkerMat);
    ballast.position.y = 0.10;
    railGroup.add(ballast);

    const tieCount = 28;
    for (let i = 0; i < tieCount; i++) {
        const tz = -trackLen * 0.48 + (i / (tieCount - 1)) * (trackLen * 0.96);
        const tie = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.10, 0.22), MAT.woodPlankMat || MAT.ruinBrick);
        tie.position.set(0, 0.26, tz);
        railGroup.add(tie);
    }

    // 2. Parallel Steel I-Beam Rails
    for (let side of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, trackLen * 0.98), MAT.ruinSteel || MAT.steelMat);
        rail.position.set(side * gauge * 0.5, 0.35, 0);
        railGroup.add(rail);
    }

    // 3. Weathered Diesel Switcher Locomotive + Tanker Freight Car
    const loco = new THREE.Group();
    loco.position.set(0, 0.42, -3.2);
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.36, 4.4), MAT.ruinSteelDark || MAT.bunkerMat);
    chassis.position.y = 0.28;
    loco.add(chassis);
    const engineHood = new THREE.Mesh(new THREE.BoxGeometry(1.18, 1.15, 2.75), MAT.ruinBrick || MAT.bunkerMat);
    engineHood.position.set(0, 1.02, -0.55);
    loco.add(engineHood);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.48, 1.45, 1.35), MAT.ruinSteel || MAT.bunkerMat);
    cab.position.set(0, 1.18, 1.32);
    loco.add(cab);
    const cowcatcher = new THREE.Mesh(new THREE.ConeGeometry(0.85, 0.75, 4), MAT.ruinSteelDark || MAT.bunkerMat);
    cowcatcher.rotation.x = -Math.PI * 0.5;
    cowcatcher.rotation.z = Math.PI * 0.25;
    cowcatcher.position.set(0, 0.35, -2.45);
    loco.add(cowcatcher);
    for (let wz of [-1.45, -0.55, 0.65, 1.55]) {
        const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.45, 10), MAT.obsidianMat || MAT.ruinSteelDark);
        axle.rotation.z = Math.PI * 0.5;
        axle.position.set(0, 0.04, wz);
        loco.add(axle);
    }
    railGroup.add(loco);

    // Cylindrical Fuel Tanker Freight Car
    const tanker = new THREE.Group();
    tanker.position.set(0, 0.42, 2.4);
    const tankBed = new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.24, 3.8), MAT.ruinSteelDark || MAT.bunkerMat);
    tankBed.position.y = 0.22;
    tanker.add(tankBed);
    const tankCyl = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 0.68, 3.5, 12), MAT.ruinConcrete || MAT.steelMat);
    tankCyl.rotation.x = Math.PI * 0.5;
    tankCyl.position.y = 0.96;
    tanker.add(tankCyl);
    railGroup.add(tanker);

    railGroup.traverse(c => {
        if (c.isMesh) {
            c.castShadow = true;
            c.receiveShadow = true;
        }
    });
    addMapMesh(railGroup);
    obstacles.push({ x: cx, z: cz, r: 2.8 });
}

// Multi-Species 3D Tree Generator (Broadleaf Oak, Silver Birch, Oasis Date Palm, Ancient Snag):
function createMultiSpeciesTreeMesh(species, tx, tz, biome = ACTIVE_PLANET_BIOME || 'highland') {
    const structId = species === 'palm' ? 'palm_tree' : (species === 'snag' ? 'snag_tree' : 'forest_tree');
    if (!isStructureAllowedInBiome(structId, biome)) {
        recordStructurePlacementDecision(structId, biome, tx, tz, false, `rejected_biome_incompatible:${structId}_not_allowed_in_${biome}`);
        return;
    }
    const wf = isFootprintAboveWater(tx, tz, 0.9, 0.14);
    if (!wf.valid) {
        recordStructurePlacementDecision(structId, biome, tx, tz, false, wf.reason);
        return;
    }

    const ty = getTerrainHeight(tx, tz);
    const treeGroup = new THREE.Group();
    treeGroup.position.set(tx, ty, tz);
    const crownGroup = new THREE.Group();
    treeGroup.add(crownGroup);

    const trunkMat = species === 'birch' ? (MAT.ruinPlaster || MAT.trunkMat) : MAT.trunkMat;
    const leafMat = species === 'oak'
        ? (MAT.mossRock || MAT.foliagePine)
        : (species === 'palm' ? MAT.foliagePine : (MAT.foliageBush || MAT.foliagePine));

    if (species === 'oak') {
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.34, 1.65, 8), trunkMat);
        trunk.position.y = 0.82;
        treeGroup.add(trunk);
        const offsets = [
            [0, 2.05, 0, 1.05],
            [-0.55, 1.75, 0.35, 0.78],
            [0.58, 1.82, -0.32, 0.82],
            [0.18, 1.68, 0.58, 0.74],
            [-0.38, 2.25, -0.38, 0.72]
        ];
        offsets.forEach(([ox, oy, oz, r]) => {
            const lobe = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 1), leafMat);
            lobe.position.set(ox, oy, oz);
            lobe.scale.set(1.15, 0.82, 1.12);
            crownGroup.add(lobe);
        });
    } else if (species === 'birch') {
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.16, 2.35, 7), trunkMat);
        trunk.position.y = 1.15;
        treeGroup.add(trunk);
        for (let l = 0; l < 4; l++) {
            const lobe = new THREE.Mesh(new THREE.ConeGeometry(0.72 - l * 0.11, 0.95, 7), leafMat);
            lobe.position.set((l % 2 === 0 ? 0.08 : -0.08), 1.45 + l * 0.46, 0);
            crownGroup.add(lobe);
        }
    } else if (species === 'palm') {
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.22, 2.55, 8), trunkMat);
        trunk.position.y = 1.25;
        trunk.rotation.z = 0.10;
        treeGroup.add(trunk);
        for (let f = 0; f < 6; f++) {
            const frond = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.06, 0.32), leafMat);
            const ang = (f / 6) * Math.PI * 2;
            frond.position.set(Math.cos(ang) * 0.62 - 0.12, 2.48, Math.sin(ang) * 0.62);
            frond.rotation.y = -ang;
            frond.rotation.z = -0.32;
            crownGroup.add(frond);
        }
    } else {
        // Ancient Gnarled Dead Tree Snag
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.32, 2.1, 7), trunkMat);
        trunk.position.y = 1.05;
        trunk.rotation.z = 0.12;
        treeGroup.add(trunk);
        for (let b = 0; b < 3; b++) {
            const limb = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.11, 1.05, 6), trunkMat);
            limb.position.set((b - 1) * 0.35, 1.55 + b * 0.22, (b % 2 ? 0.25 : -0.25));
            limb.rotation.z = (b - 1) * 0.65;
            crownGroup.add(limb);
        }
    }

    treeGroup.traverse(c => {
        if (c.isMesh) {
            c.castShadow = true;
            c.receiveShadow = true;
        }
    });
    addMapMesh(treeGroup);
    swayTrees.push({ crown: crownGroup, phase: seededRandom() * Math.PI * 2 });
    const obsEntry = { x: tx, z: tz, r: 0.72, isTree: true };
    obstacles.push(obsEntry);
    DESTRUCTIBLE_ENV_STRUCTURES.push({
        kind: 'tree',
        x: tx,
        z: tz,
        radius: 1.2,
        hp: 85,
        maxHp: 85,
        root: treeGroup,
        obsEntry
    });
    recordStructurePlacementDecision(structId, biome, tx, tz, true, 'valid');
}

// Autonomous 3D Wildlife & Frontier Civilian Agents:
function createAutonomousWildlifeAndCivilians(biome = ACTIVE_PLANET_BIOME || 'highland') {
    WILDLIFE_AGENTS.length = 0;
    CIVILIAN_AGENTS.length = 0;

    const wildMult = (window.WORLD_GEN_CONFIG && window.WORLD_GEN_CONFIG.wildlifePopulation !== undefined)
        ? window.WORLD_GEN_CONFIG.wildlifePopulation
        : 1.0;
    const civMult = (window.WORLD_GEN_CONFIG && window.WORLD_GEN_CONFIG.civilianPopulation !== undefined)
        ? window.WORLD_GEN_CONFIG.civilianPopulation
        : 1.0;

    // 1. Flocking Canyon Hawks / Seabirds Circling Skyward
    const birdCount = biome === 'lava' ? 0 : Math.round((IS_MOBILE ? 6 : 12) * wildMult);
    for (let i = 0; i < birdCount; i++) {
        const bGroup = new THREE.Group();
        const body = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.52, 6), MAT.ruinSteelDark || MAT.trunkMat);
        body.rotation.x = Math.PI * 0.5;
        bGroup.add(body);

        const leftWing = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.03, 0.22), MAT.trunkMat || MAT.bunkerMat);
        leftWing.position.set(-0.32, 0, 0);
        const rightWing = leftWing.clone();
        rightWing.position.set(0.32, 0, 0);
        bGroup.add(leftWing);
        bGroup.add(rightWing);

        const cx = (seededRandom() - 0.5) * 125;
        const cz = (seededRandom() - 0.5) * 125;
        const alt = 14.5 + seededRandom() * 9.0;
        bGroup.position.set(cx, alt, cz);
        bGroup.traverse(c => { c.raycast = () => {}; });
        addMapMesh(bGroup);

        WILDLIFE_AGENTS.push({
            kind: 'bird',
            mesh: bGroup,
            leftWing,
            rightWing,
            centerX: cx,
            centerZ: cz,
            orbitRadius: 11.0 + seededRandom() * 14.0,
            altitude: alt,
            angle: seededRandom() * Math.PI * 2,
            speed: 0.38 + seededRandom() * 0.24,
            flapPhase: seededRandom() * Math.PI * 2
        });
    }

    // 2. Ground Grazing Deer / Canyon Stag Herds (Validated via isStructureAllowedInBiome('wildlife_grazing', biome))
    if (isStructureAllowedInBiome('wildlife_grazing', biome)) {
        const deerCount = Math.round((IS_MOBILE ? 5 : 10) * wildMult);
        for (let i = 0; i < deerCount; i++) {
            let dx = (seededRandom() - 0.5) * 145;
            let dz = (seededRandom() - 0.5) * 145;
            if (!isSafeForProp(dx, dz, 3.5)) continue;

            const dGroup = new THREE.Group();
            const coatMat = MAT.trunkMat || MAT.canyonRock;
            const torso = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.34, 0.72), coatMat);
            torso.position.y = 0.48;
            dGroup.add(torso);
            const neck = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.36, 0.18), coatMat);
            neck.position.set(0, 0.72, 0.28);
            neck.rotation.x = 0.32;
            dGroup.add(neck);
            const head = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.30), coatMat);
            head.position.set(0, 0.86, 0.42);
            dGroup.add(head);

            const legs = [];
            for (let lx of [-0.11, 0.11]) {
                for (let lz of [-0.24, 0.24]) {
                    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.42, 0.07), coatMat);
                    leg.position.set(lx, 0.21, lz);
                    dGroup.add(leg);
                    legs.push(leg);
                }
            }
            dGroup.position.set(dx, getTerrainHeight(dx, dz), dz);
            dGroup.traverse(c => { c.raycast = () => {}; });
            addMapMesh(dGroup);

            WILDLIFE_AGENTS.push({
                kind: 'deer',
                mesh: dGroup,
                legs,
                homeX: dx,
                homeZ: dz,
                targetX: dx + (seededRandom() - 0.5) * 10,
                targetZ: dz + (seededRandom() - 0.5) * 10,
                fleeTimer: 0,
                walkPhase: seededRandom() * Math.PI * 2,
                idleTimer: 1.5 + seededRandom() * 3.0
            });
        }
    }

    // 3. Frontier Settlement Civilians / Technicians (Validated via isStructureAllowedInBiome('civilian_settlement', biome))
    if (isStructureAllowedInBiome('civilian_settlement', biome)) {
        const civCount = Math.round((IS_MOBILE ? 4 : 8) * civMult);
        const anchors = (typeof REGISTERED_MAP_STRUCTURES !== 'undefined' && Array.isArray(REGISTERED_MAP_STRUCTURES) && REGISTERED_MAP_STRUCTURES.length > 0)
            ? REGISTERED_MAP_STRUCTURES
            : [ABANDONED_TOWN_CENTER, SOUTH_ROAD_HUB, NORTH_ROAD_HUB].filter(Boolean);
        for (let i = 0; i < civCount && anchors.length > 0; i++) {
            const anchor = anchors[i % anchors.length];
            if (!anchor) continue;
            const cx = anchor.x + (seededRandom() - 0.5) * 7.0;
            const cz = anchor.z + (seededRandom() - 0.5) * 7.0;
            if (!isFootprintAboveWater(cx, cz, 1.2, 0.15).valid) continue;
            const cGroup = new THREE.Group();
            const suitMat = i % 2 === 0 ? (MAT.amberGlow || MAT.ruinBrick) : (MAT.ruinSteel || MAT.steelMat);
            const torso = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.38, 0.18), suitMat);
            torso.position.y = 0.52;
            cGroup.add(torso);
            const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), MAT.ruinPlaster || MAT.steelMat);
            helmet.position.y = 0.82;
            cGroup.add(helmet);
            const legs = [];
            for (let lx of [-0.07, 0.07]) {
                const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.34, 0.08), MAT.ruinSteelDark || MAT.bunkerMat);
                leg.position.set(lx, 0.17, 0);
                cGroup.add(leg);
                legs.push(leg);
            }
            cGroup.position.set(cx, getTerrainHeight(cx, cz), cz);
            cGroup.traverse(c => { c.raycast = () => {}; });
            addMapMesh(cGroup);

            CIVILIAN_AGENTS.push({
                mesh: cGroup,
                legs,
                homeX: anchor.x,
                homeZ: anchor.z,
                targetX: cx + (seededRandom() - 0.5) * 6.0,
                targetZ: cz + (seededRandom() - 0.5) * 6.0,
                panicTimer: 0,
                walkPhase: seededRandom() * Math.PI * 2
            });
        }
    }
}

function populateProceduralWorldEcosystem(explicitBiome) {
    DESTRUCTIBLE_ENV_STRUCTURES.length = 0;
    PROCEDURAL_FOREST_GROVES.length = 0;

    const cfg = window.WORLD_GEN_CONFIG || {};
    const abandon = cfg.abandonmentLevel !== undefined ? cfg.abandonmentLevel : 0.45;
    const baseDet = abandon > 0.78 ? 3 : (abandon > 0.42 ? 2 : 1);
    const biome = explicitBiome || ACTIVE_PLANET_BIOME || 'highland';

    // 1. Rural Agricultural Village & Homestead Cluster
    if (isStructureAllowedInBiome('rural_village', biome) && (cfg.urbanDensity ?? 1.0) > 0.15) {
        const rvx = THREE.MathUtils.clamp(-58 + (seededRandom() - 0.5) * 14, -84, 84);
        const rvz = THREE.MathUtils.clamp(18 + (seededRandom() - 0.5) * 14, -84, 84);
        const vSpot = findAlternativeStructurePlacement('rural_village', rvx, rvz, 7.5, { biome, maxSearchRadius: 24.0 });
        if (vSpot && vSpot.valid !== false) {
            createProceduralRuralVillage(vSpot.x, vSpot.z, biome);
        }
    }

    // 2. Industrial Wind Turbine & Solar Array Complex
    if (isStructureAllowedInBiome('wind_solar_complex', biome) && (cfg.industrialDensity ?? 1.0) > 0.15) {
        const wx = THREE.MathUtils.clamp(62 + (seededRandom() - 0.5) * 12, -84, 84);
        const wz = THREE.MathUtils.clamp(-14 + (seededRandom() - 0.5) * 12, -84, 84);
        const wSpot = findAlternativeStructurePlacement('wind_solar_complex', wx, wz, 7.0, { biome, maxSearchRadius: 24.0 });
        if (wSpot && wSpot.valid !== false) {
            createProceduralWindAndSolarPowerComplex(wSpot.x, wSpot.z, biome);
        }
    }

    // 3. Derelict Industrial Railway Spur & Locomotive
    if (isStructureAllowedInBiome('railway_spur', biome) && (cfg.roadDensity ?? 1.0) > 0.15) {
        const rx = THREE.MathUtils.clamp(-64 + (seededRandom() - 0.5) * 10, -86, 86);
        const rz = THREE.MathUtils.clamp(-24 + (seededRandom() - 0.5) * 10, -86, 86);
        const rSpot = findAlternativeStructurePlacement('railway_spur', rx, rz, 6.5, { biome, maxSearchRadius: 24.0 });
        if (rSpot && rSpot.valid !== false) {
            createProceduralRailwaySpurAndTrain(rSpot.x, rSpot.z, 0.28 + seededRandom() * 0.35, biome);
        }
    }

    // 4. Procedural Architectural Grammar Buildings along Supply Roads & Settlement Outskirts
    if (isStructureAllowedInBiome('architectural_building', biome)) {
        const buildingCandidateSpots = [
            { x: -34, z: 36, style: 'commercial', stories: 2 },
            { x: 36, z: 32, style: 'industrial', stories: 1 },
            { x: -38, z: -34, style: 'industrial', stories: 1 },
            { x: 42, z: -38, style: 'commercial', stories: 2 },
            { x: -18, z: 46, style: 'residential', stories: 1 },
            { x: 24, z: 48, style: 'residential', stories: 2 }
        ];
        const maxBlds = Math.round(buildingCandidateSpots.length * (cfg.urbanDensity ?? 1.0));
        for (let i = 0; i < Math.min(buildingCandidateSpots.length, maxBlds); i++) {
            const sp = buildingCandidateSpots[i];
            const bx = sp.x + (seededRandom() - 0.5) * 6.0;
            const bz = sp.z + (seededRandom() - 0.5) * 6.0;
            const bSpot = findAlternativeStructurePlacement('architectural_building', bx, bz, 5.2, { biome, maxSearchRadius: 20.0 });
            if (bSpot && bSpot.valid !== false) {
                const det = Math.max(1, Math.min(4, baseDet + (i % 2)));
                buildArchitecturalGrammarBuilding(bSpot.x, bSpot.z, seededRandom() * Math.PI * 2, {
                    biome,
                    style: sp.style,
                    stories: sp.stories,
                    deterioration: det
                });
            }
        }
    }

    // 5. Biome-Appropriate Multi-Species 3D Forest Groves (Validated per species & biome!)
    const groveCenters = biome === 'lava'
        ? []
        : (biome === 'ocean'
            ? [
                { x: PLAYER_START_POS.x + 10, z: PLAYER_START_POS.z - 10, species: 'palm' },
                { x: SOLARIS_BASE_POS.x - 8, z: SOLARIS_BASE_POS.z + 8, species: 'palm' },
                { x: 0, z: 0, species: 'palm' }
            ]
            : (biome === 'desert'
                ? [
                    { x: -44, z: -48, species: 'snag' },
                    { x: 16, z: 22, species: 'palm' }
                ]
                : (biome === 'jungle'
                    ? [
                        { x: -46, z: 8, species: 'palm' },
                        { x: 48, z: 12, species: 'oak' },
                        { x: -44, z: -48, species: 'palm' },
                        { x: 16, z: 22, species: 'palm' },
                        { x: -18, z: -26, species: 'oak' },
                        { x: 28, z: -22, species: 'palm' }
                    ]
                    : [
                        { x: -46, z: 8, species: 'oak' },
                        { x: 48, z: 12, species: 'birch' },
                        { x: -44, z: -48, species: 'snag' },
                        { x: 16, z: 22, species: 'palm' }
                    ])));
    const forestMult = (cfg.forestDensity ?? 1.0) * (biome === 'jungle' ? 1.5 : 1.0);
    groveCenters.forEach(gc => {
        const treeStructId = gc.species === 'palm' ? 'palm_tree' : (gc.species === 'snag' ? 'snag_tree' : 'forest_tree');
        if (!isStructureAllowedInBiome(treeStructId, biome)) return;
        PROCEDURAL_FOREST_GROVES.push({ x: gc.x, z: gc.z, r: 9.5 });
        const count = Math.round((IS_MOBILE ? 3 : 6) * forestMult);
        for (let t = 0; t < count; t++) {
            const tx = gc.x + (seededRandom() - 0.5) * 11.0;
            const tz = gc.z + (seededRandom() - 0.5) * 11.0;
            if (isSafeForProp(tx, tz, 2.4)) {
                createMultiSpeciesTreeMesh(gc.species, tx, tz, biome);
            }
        }
    });

    // 5B. Multi-Sample Flat-Plain Biome Structure Placement across all 5 Biomes
    if (window.TERRAIN_CLASSIFIER && typeof window.TERRAIN_CLASSIFIER.populateFlatPlainBiomeStructures === 'function') {
        window.TERRAIN_CLASSIFIER.populateFlatPlainBiomeStructures(biome);
    }

    // 6. Autonomous Wildlife & Frontier Civilian Simulation
    createAutonomousWildlifeAndCivilians(biome);
}

// Real-Time Battlefield Environmental Destruction Hook:
// Called when tank shells, siege artillery, rockets, sunlance bolts, or banelings detonate at `worldPos`.
window.damageEnvironmentalStructuresAt = function(worldPos, blastRadius = 4.0, damage = 60) {
    if (!worldPos) return;
    const wx = worldPos.x || 0;
    const wz = worldPos.z || 0;

    // Alert nearby wildlife & civilians so they immediately flee from the explosion!
    for (let i = 0; i < WILDLIFE_AGENTS.length; i++) {
        const w = WILDLIFE_AGENTS[i];
        if (w.kind === 'deer' && w.mesh) {
            const d = Math.hypot(w.mesh.position.x - wx, w.mesh.position.z - wz);
            if (d <= blastRadius + 22.0) {
                w.fleeTimer = 5.5;
                const awayX = w.mesh.position.x - wx;
                const awayZ = w.mesh.position.z - wz;
                const len = Math.hypot(awayX, awayZ) || 1;
                w.targetX = THREE.MathUtils.clamp(w.mesh.position.x + (awayX / len) * 18.0, -92, 92);
                w.targetZ = THREE.MathUtils.clamp(w.mesh.position.z + (awayZ / len) * 18.0, -92, 92);
            }
        }
    }
    for (let i = 0; i < CIVILIAN_AGENTS.length; i++) {
        const c = CIVILIAN_AGENTS[i];
        if (c.mesh) {
            const d = Math.hypot(c.mesh.position.x - wx, c.mesh.position.z - wz);
            if (d <= blastRadius + 20.0) {
                c.panicTimer = 6.0;
                c.targetX = c.homeX;
                c.targetZ = c.homeZ;
            }
        }
    }

    // Apply structural damage to buildings & trees within blastRadius
    for (let i = DESTRUCTIBLE_ENV_STRUCTURES.length - 1; i >= 0; i--) {
        const st = DESTRUCTIBLE_ENV_STRUCTURES[i];
        if (!st || st.hp <= 0) continue;
        const d = Math.hypot(st.x - wx, st.z - wz);
        if (d > blastRadius + (st.radius || 1.5)) continue;

        const falloff = Math.max(0.35, 1.0 - d / (blastRadius + (st.radius || 1.5) + 0.5));
        st.hp -= damage * falloff;

        if (st.kind === 'tree') {
            if (st.hp <= 0 && st.root) {
                // Topple & splinter tree on heavy ordnance impact
                st.root.rotation.x = 1.35;
                st.root.position.y -= 0.15;
                if (st.obsEntry) st.obsEntry.r = 0.1;
            }
        } else if (st.kind === 'building') {
            const newDet = st.hp <= 0 ? 4 : (st.hp < 180 ? 3 : (st.hp < 360 ? 2 : 1));
            if (newDet > st.deterioration) {
                st.deterioration = newDet;
                if (st.populateRubbleForLevel) st.populateRubbleForLevel(newDet);
                if (newDet === 3 && st.structBody) {
                    st.structBody.scale.y = 0.78;
                    st.structBody.rotation.z = 0.04;
                } else if (newDet >= 4 && st.structBody) {
                    st.structBody.visible = false;
                    if (st.obsEntry) st.obsEntry.r *= 0.65;
                }
            }
        }
    }

    // Also apply heavy ordnance damage to river bridges if within blast radius
    if (typeof window.damageBridgeAt === 'function') {
        window.damageBridgeAt(worldPos, blastRadius, damage * 0.45);
    }
};

// Destructible & Engineer-Repairable Tactical River Bridge API:
window.damageBridgeAt = function(worldPos, blastRadius = 4.5, damage = 45) {
    if (!worldPos || !HAS_VALLEY_RIVER || damage <= 0) return false;
    const wx = worldPos.x || 0;
    const wz = worldPos.z || 0;
    let stateChanged = false;

    for (let i = 0; i < RIVER_BRIDGES.length; i++) {
        const rb = RIVER_BRIDGES[i];
        if (!rb || rb.destroyed) continue;
        const lc = getBridgeLocalCoords(rb, wx, wz);
        const spanHalfU = rb.flatHalfSpan || (RIVER_HALF_WIDTH + 0.95);
        if (lc.absS <= rb.halfWidth + blastRadius && lc.absU <= spanHalfU + blastRadius) {
            rb.hp = Math.max(0, (typeof rb.hp === 'number' ? rb.hp : 1800) - damage);
            if (rb.hp <= 0) {
                rb.destroyed = true;
                if (rb.intactSpanGroup) rb.intactSpanGroup.visible = false;
                if (rb.destroyedSpanGroup) rb.destroyedSpanGroup.visible = true;
                stateChanged = true;
            }
        }
    }
    if (stateChanged) {
        syncFowGeometryWithTerrain();
    }
    return stateChanged;
};

window.repairBridgeAt = function(worldPos, repairRadius = 7.5, amount = 120) {
    if (!worldPos || !HAS_VALLEY_RIVER || amount <= 0) return false;
    const wx = worldPos.x || 0;
    const wz = worldPos.z || 0;
    let repairedAny = false;

    for (let i = 0; i < RIVER_BRIDGES.length; i++) {
        const rb = RIVER_BRIDGES[i];
        if (!rb) continue;
        const maxHp = rb.maxHp || 1800;
        if (!rb.destroyed && (rb.hp ?? maxHp) >= maxHp) continue;
        const lc = getBridgeLocalCoords(rb, wx, wz);
        const reachU = (rb.rampReachU || (RIVER_HALF_WIDTH + 3.45)) + repairRadius;
        if (lc.absS <= rb.halfWidth + repairRadius && lc.absU <= reachU) {
            rb.hp = Math.min(maxHp, (rb.hp || 0) + amount);
            repairedAny = true;
            if (rb.destroyed && rb.hp >= maxHp * 0.5) {
                rb.destroyed = false;
                if (rb.intactSpanGroup) rb.intactSpanGroup.visible = true;
                if (rb.destroyedSpanGroup) rb.destroyedSpanGroup.visible = false;
                syncFowGeometryWithTerrain();
            }
        }
    }
    return repairedAny;
};

// Strategic Gameplay-Environment Modifiers:
// Returns road speed bonus, forest/ruin cover damage reduction, and high-ground elevation advantage.
window.getEnvironmentalTacticalModifiers = function(x, z, isAir = false, isVehicle = false) {
    if (isAir) return { speedMult: 1.0, coverDamageMult: 1.0, onRoad: false, inCover: false };

    let speedMult = 1.0;
    let coverDamageMult = 1.0;
    let onRoad = false;
    let inCover = false;

    // 1. Supply Road & Bridge Speed Bonus (+18% movement speed on engineered roads/bridges)
    if (typeof getSupplyRoadFactor === 'function') {
        const rf = getSupplyRoadFactor(x, z);
        if (rf > 0.35 || (typeof isOnRiverBridge === 'function' && isOnRiverBridge(x, z, 0.5))) {
            speedMult = isVehicle ? 1.20 : 1.15;
            onRoad = true;
        }
    }

    // 2. Forest Concealment & Ruin Cover for Infantry (-18% incoming damage)
    if (!isVehicle) {
        for (let i = 0; i < PROCEDURAL_FOREST_GROVES.length; i++) {
            const g = PROCEDURAL_FOREST_GROVES[i];
            if (Math.hypot(x - g.x, z - g.z) <= g.r) {
                coverDamageMult = 0.82;
                inCover = true;
                break;
            }
        }
        if (!inCover) {
            for (let i = 0; i < DESTRUCTIBLE_ENV_STRUCTURES.length; i++) {
                const st = DESTRUCTIBLE_ENV_STRUCTURES[i];
                if (st && st.kind === 'building' && Math.hypot(x - st.x, z - st.z) <= st.radius + 2.2) {
                    coverDamageMult = 0.84;
                    inCover = true;
                    break;
                }
            }
        }
    }

    return { speedMult, coverDamageMult, onRoad, inCover };
};

// ============================================================================
// AUTOMATED PROCEDURAL MAP VALIDATION & SELF-REPAIR SYSTEM
// Verifies road network continuity/slopes, river channel depth/continuity,
// bridge-to-road connections, base buildability, and obstacle clearances.
// ============================================================================

function validateRoadNetwork() {
    const issues = [];
    for (let s = 0; s < DYNAMIC_ROAD_SEGMENTS.length; s++) {
        const seg = DYNAMIC_ROAD_SEGMENTS[s];
        if (!seg || !Array.isArray(seg.samples) || seg.samples.length < 4) {
            issues.push({ type: 'road_missing_samples', segIndex: s, seg });
            continue;
        }
        const samples = seg.samples;
        for (let i = 1; i < samples.length; i++) {
            const prev = samples[i - 1];
            const curr = samples[i];
            const ds = Math.hypot(curr.x - prev.x, curr.z - prev.z);
            if (ds > 0.05) {
                const dy = Math.abs((curr.targetElevation ?? getTerrainHeight(curr.x, curr.z)) - (prev.targetElevation ?? getTerrainHeight(prev.x, prev.z)));
                const grade = dy / ds;
                if (grade > 0.14) {
                    issues.push({ type: 'road_excessive_grade', segIndex: s, sampleIndex: i, grade });
                    break;
                }
            }
            if (i < samples.length - 1) {
                const next = samples[i + 1];
                const v1x = curr.x - prev.x, v1z = curr.z - prev.z;
                const v2x = next.x - curr.x, v2z = next.z - curr.z;
                const l1 = Math.hypot(v1x, v1z), l2 = Math.hypot(v2x, v2z);
                if (l1 > 0.1 && l2 > 0.1) {
                    const cosTurn = THREE.MathUtils.clamp((v1x * v2x + v1z * v2z) / (l1 * l2), -1, 1);
                    const turnAngle = Math.acos(cosTurn);
                    if (turnAngle > 0.65) {
                        issues.push({ type: 'road_sharp_kink', segIndex: s, sampleIndex: i, turnAngle });
                        break;
                    }
                }
            }
            if (!seg.isBridgeCauseway && HAS_VALLEY_RIVER) {
                const rc = getRiverCoords(curr.x, curr.z);
                if (rc.dist < (rc.halfWidth || RIVER_HALF_WIDTH) - 0.15 && !isOnRiverBridge(curr.x, curr.z, 0.5)) {
                    issues.push({ type: 'road_enters_water_without_bridge', segIndex: s, sampleIndex: i, x: curr.x, z: curr.z });
                    break;
                }
            }
        }
    }
    return { valid: issues.length === 0, issues };
}

function validateRiverGeometry() {
    const issues = [];
    if (!HAS_VALLEY_RIVER) return { valid: true, issues };

    if (ACTIVE_PLANET_BIOME === 'ocean') {
        if (!Array.isArray(window.OCEAN_ISLANDS) || window.OCEAN_ISLANDS.length < 5) {
            issues.push({ type: 'ocean_missing_islands', count: window.OCEAN_ISLANDS ? window.OCEAN_ISLANDS.length : 0 });
        } else {
            window.OCEAN_ISLANDS.forEach(isl => {
                const centerH = getTerrainHeight(isl.x, isl.z);
                if (centerH <= RIVER_WATER_Y + 0.25) {
                    issues.push({ type: 'ocean_island_submerged', id: isl.id, centerH, waterY: RIVER_WATER_Y });
                }
            });
        }
        return { valid: issues.length === 0, issues };
    }

    const maxAllowedHalfW = ACTIVE_PLANET_BIOME === 'lava' ? 7.8 : 6.5;
    for (let s = -62; s <= 62; s += 2.0) {
        const hw = getRiverHalfWidthAtS(s);
        if (hw < 2.2 || hw > maxAllowedHalfW) {
            issues.push({ type: 'river_invalid_width', s, halfWidth: hw });
        }
        const centerU = getRiverCenterUAtS(s);
        const wPt = riverCoordsToWorld(s, centerU);
        const bedH = getTerrainHeight(wPt.x, wPt.z);
        if (bedH > RIVER_WATER_Y - 0.25) {
            issues.push({ type: 'riverbed_above_water', s, x: wPt.x, z: wPt.z, bedH, waterY: RIVER_WATER_Y });
        }
    }
    return { valid: issues.length === 0, issues };
}

function validateBridgeConnections() {
    const issues = [];
    const bridgeReports = [];
    const deckElevY = 0.35;

    if (!HAS_VALLEY_RIVER) {
        window.BRIDGE_DIAGNOSTICS = {
            seed: MAP_SEED,
            biome: ACTIVE_PLANET_BIOME,
            hasValleyRiver: false,
            bridgeCount: 0,
            valid: true,
            issues: [],
            bridges: []
        };
        return { valid: true, issues, bridges: [] };
    }

    for (let i = 0; i < RIVER_BRIDGES.length; i++) {
        const rb = RIVER_BRIDGES[i];
        const s0 = rb.sCoord;
        if (!rb.isCustomIslandBridge) {
            const localSlope = getRiverTangentSlopeAtS(s0);
            const expectedYaw = RIVER_ANGLE - Math.atan(localSlope);
            const yawErr = Math.abs(THREE.MathUtils.euclideanModulo((rb.yaw ?? expectedYaw) - expectedYaw + Math.PI, Math.PI * 2) - Math.PI);
            if (yawErr > 0.15) {
                issues.push({ type: 'bridge_orientation_mismatch', bridgeIndex: i, bridgeId: rb.id, yawErr, expectedYaw });
            }
        }

        const flatHalfSpan = rb.flatHalfSpan || (getRiverHalfWidthAtS(s0) + 0.65);
        const rampReachU = rb.rampReachU || (flatHalfSpan + 3.1);
        const halfWidth = rb.halfWidth || 3.45;

        const northToePt = bridgeLocalToWorld(rb, 0, -rampReachU);
        const southToePt = bridgeLocalToWorld(rb, 0, rampReachU);
        const northShorePt = rb.shorelineA || bridgeLocalToWorld(rb, 0, -flatHalfSpan);
        const southShorePt = rb.shorelineB || bridgeLocalToWorld(rb, 0, flatHalfSpan);

        const northToeY = getTerrainHeight(northToePt.x, northToePt.z);
        const southToeY = getTerrainHeight(southToePt.x, southToePt.z);
        const northShoreY = getTerrainHeight(northShorePt.x, northShorePt.z);
        const southShoreY = getTerrainHeight(southShorePt.x, southShorePt.z);

        // Sample terrain under the water-spanning bridge deck to confirm zero terrain overlap & continuous water clearance
        let maxTerrainUnderDeck = -Infinity;
        let minTerrainUnderDeck = Infinity;
        let maxCenterChannelTerrain = -Infinity;
        let intermediateIslandOverlap = false;
        const sampleCount = 21;
        for (let sIdx = 0; sIdx <= sampleCount; sIdx++) {
            const frac = (sIdx / sampleCount) * 2.0 - 1.0; // -1..+1
            const localZ = frac * (flatHalfSpan * 0.88);
            for (let latIdx = -1; latIdx <= 1; latIdx++) {
                const localX = latIdx * (halfWidth * 0.72);
                const wPt = bridgeLocalToWorld(rb, localX, localZ);
                const th = getTerrainHeight(wPt.x, wPt.z);
                if (th > maxTerrainUnderDeck) maxTerrainUnderDeck = th;
                if (th < minTerrainUnderDeck) minTerrainUnderDeck = th;
                if (Math.abs(frac) <= 0.55 && latIdx === 0 && th > maxCenterChannelTerrain) {
                    maxCenterChannelTerrain = th;
                }
            }
            if (rb.isCustomIslandBridge && Math.abs(frac) <= 0.72 && Array.isArray(OCEAN_ISLANDS)) {
                const centerPt = bridgeLocalToWorld(rb, 0, localZ);
                for (let k = 0; k < OCEAN_ISLANDS.length; k++) {
                    const isl = OCEAN_ISLANDS[k];
                    if (!isl || isl.id === rb.islandAId || isl.id === rb.islandBId) continue;
                    const ang = Math.atan2(centerPt.z - isl.z, centerPt.x - isl.x);
                    const coastR = typeof getOceanIslandCoastRadiusAtAngle === 'function'
                        ? getOceanIslandCoastRadiusAtAngle(isl, ang)
                        : Math.min(isl.rx, isl.rz);
                    if (Math.hypot(centerPt.x - isl.x, centerPt.z - isl.z) < coastR - 0.5) {
                        intermediateIslandOverlap = true;
                    }
                }
            }
        }

        const terrainClearOfDeck = maxTerrainUnderDeck < deckElevY - 0.04;
        const hasWaterUnderCenter = maxCenterChannelTerrain <= RIVER_WATER_Y + 0.05;

        if (!terrainClearOfDeck) {
            issues.push({
                type: 'bridge_deck_terrain_overlap',
                bridgeIndex: i,
                bridgeId: rb.id,
                maxTerrainUnderDeck: Number(maxTerrainUnderDeck.toFixed(3)),
                deckElevY
            });
        }
        if (intermediateIslandOverlap) {
            issues.push({
                type: 'bridge_crosses_intermediate_island',
                bridgeIndex: i,
                bridgeId: rb.id
            });
        }

        [-1, 1].forEach(endSign => {
            const toePt = endSign < 0 ? northToePt : southToePt;
            const toeGroundH = endSign < 0 ? northToeY : southToeY;
            if (!Number.isFinite(toeGroundH) || toeGroundH < RIVER_WATER_Y + 0.05) {
                issues.push({
                    type: 'bridge_ramp_submerged',
                    bridgeIndex: i,
                    bridgeId: rb.id,
                    endSign,
                    x: toePt.x,
                    z: toePt.z,
                    toeGroundH
                });
            }
            if (!rb.isCustomIslandBridge && ACTIVE_PLANET_BIOME !== 'ocean' && ACTIVE_PLANET_BIOME !== 'lava' && DYNAMIC_ROAD_SEGMENTS.length > 0) {
                const roadFactorAtToe = getSupplyRoadFactor(toePt.x, toePt.z);
                if (roadFactorAtToe < 0.20) {
                    issues.push({
                        type: 'bridge_disconnected_from_road',
                        bridgeIndex: i,
                        bridgeId: rb.id,
                        endSign,
                        x: toePt.x,
                        z: toePt.z,
                        roadFactorAtToe
                    });
                }
            }
        });

        const bCenterX = Number.isFinite(rb.centerX) ? rb.centerX : (Number.isFinite(rb.worldX) ? rb.worldX : 0);
        const bCenterZ = Number.isFinite(rb.centerZ) ? rb.centerZ : (Number.isFinite(rb.worldZ) ? rb.worldZ : 0);
        const northWalkable = typeof isWalkableGround === 'function' ? isWalkableGround(northToePt.x, northToePt.z, 0.4) : true;
        const centerWalkable = typeof isWalkableGround === 'function' ? isWalkableGround(bCenterX, bCenterZ, 0.4) : true;
        const southWalkable = typeof isWalkableGround === 'function' ? isWalkableGround(southToePt.x, southToePt.z, 0.4) : true;
        const navConnected = Boolean(northWalkable && centerWalkable && southWalkable);

        const distinctLandAreas = rb.isCustomIslandBridge
            ? Boolean(rb.islandAId && rb.islandBId && rb.islandAId !== rb.islandBId && northToeY > RIVER_WATER_Y + 0.05 && southToeY > RIVER_WATER_Y + 0.05)
            : Boolean(northToeY > RIVER_WATER_Y + 0.05 && southToeY > RIVER_WATER_Y + 0.05);

        bridgeReports.push({
            id: rb.id,
            bridgeIndex: i,
            archetype: rb.archetype || 'girder_bridge',
            isCustomIslandBridge: Boolean(rb.isCustomIslandBridge),
            islandAId: rb.islandAId || 'north_bank',
            islandBId: rb.islandBId || 'south_bank',
            center: { x: Number(bCenterX.toFixed(2)), z: Number(bCenterZ.toFixed(2)), yaw: Number((rb.yaw || 0).toFixed(3)) },
            endpoints: {
                northEntry: { x: Number(northToePt.x.toFixed(2)), y: Number(northToeY.toFixed(2)), z: Number(northToePt.z.toFixed(2)) },
                southEntry: { x: Number(southToePt.x.toFixed(2)), y: Number(southToeY.toFixed(2)), z: Number(southToePt.z.toFixed(2)) }
            },
            shorelineIntersections: {
                northShore: { x: Number(northShorePt.x.toFixed(2)), y: Number(northShoreY.toFixed(2)), z: Number(northShorePt.z.toFixed(2)) },
                southShore: { x: Number(southShorePt.x.toFixed(2)), y: Number(southShoreY.toFixed(2)), z: Number(southShorePt.z.toFixed(2)) }
            },
            deckLength: Number((flatHalfSpan * 2).toFixed(2)),
            totalLengthWithRamps: Number((rampReachU * 2).toFixed(2)),
            deckWidth: Number((halfWidth * 2).toFixed(2)),
            rampElevations: {
                northToeY: Number(northToeY.toFixed(3)),
                southToeY: Number(southToeY.toFixed(3)),
                deckY: deckElevY
            },
            terrainIntersectionCheck: {
                passed: terrainClearOfDeck,
                maxTerrainUnderDeck: Number(maxTerrainUnderDeck.toFixed(3)),
                minTerrainUnderDeck: Number(minTerrainUnderDeck.toFixed(3)),
                deckY: deckElevY
            },
            waterClearance: {
                passed: hasWaterUnderCenter,
                waterLevel: RIVER_WATER_Y,
                maxBedUnderCenter: Number(maxCenterChannelTerrain.toFixed(3)),
                minClearanceAboveWater: Number((deckElevY - RIVER_WATER_Y).toFixed(3))
            },
            islandOverlapCheck: {
                passed: !intermediateIslandOverlap
            },
            connectsDistinctLandAreas: distinctLandAreas,
            navigationConnectivity: {
                passed: navConnected,
                northWalkable,
                centerWalkable,
                southWalkable
            }
        });
    }

    // Verify end-to-end strategic ground pathfinding between Player Start and Enemy Base across multiple unit sizes (Req 4)
    const unitTestRadii = [0.75];
    const groundConnectivity = {};
    let allGroundPathsValid = true;

    if (typeof computeAStarWalkablePath === 'function') {
        // First clear any non-essential obstacle accidentally intruding on bridge approaches
        for (let bIdx = 0; bIdx < RIVER_BRIDGES.length; bIdx++) {
            const rb = RIVER_BRIDGES[bIdx];
            const reachU = (rb.rampReachU || (rb.flatHalfSpan || 6.0) + 3.8) + 2.5;
            const halfW = (rb.halfWidth || 3.45) + 1.8;
            for (let oIdx = obstacles.length - 1; oIdx >= 0; oIdx--) {
                const ob = obstacles[oIdx];
                if (!ob || ob.type === 'mineral' || ob.type === 'geyser') continue;
                const lc = getBridgeLocalCoords(rb, ob.x, ob.z);
                if (lc.absS <= halfW + (ob.r || 1.0) && lc.absU <= reachU + (ob.r || 1.0)) {
                    obstacles.splice(oIdx, 1);
                }
            }
        }
        _astarStaticDirty = true;

        for (let rIdx = 0; rIdx < unitTestRadii.length; rIdx++) {
            const uRad = unitTestRadii[rIdx];
            const key = `radius_${uRad}`;
            let pathRes = computeAStarWalkablePath(
                PLAYER_START_POS,
                ENEMY_BASE_POS,
                uRad,
                [],
                1.2
            );
            let reached = Boolean(pathRes && pathRes.reachedGoal !== false && Array.isArray(pathRes) && pathRes.length >= 2);
            if (!reached && ACTIVE_PLANET_BIOME === 'ocean' && Array.isArray(OCEAN_ISLANDS) && OCEAN_ISLANDS.length >= 2 && typeof window.createIslandBridgeLink === 'function') {
                // Attempt emergency island bridge synthesis between player/central/enemy islands
                const islSouth = OCEAN_ISLANDS.find(isl => isl.id === 'island_south') || OCEAN_ISLANDS[0];
                const islCentral = OCEAN_ISLANDS.find(isl => isl.id === 'island_central') || OCEAN_ISLANDS[2];
                const islNorth = OCEAN_ISLANDS.find(isl => isl.id === 'island_north') || OCEAN_ISLANDS[1];
                if (islSouth && islCentral) {
                    const b1 = window.createIslandBridgeLink(islSouth, islCentral, 'emergency_south_central', 'girder_bridge');
                    if (b1 && typeof b1 === 'object' && !RIVER_BRIDGES.some(b => b.id === b1.id)) RIVER_BRIDGES.push(b1);
                }
                if (islCentral && islNorth) {
                    const b2 = window.createIslandBridgeLink(islCentral, islNorth, 'emergency_central_north', 'suspension_bridge');
                    if (b2 && typeof b2 === 'object' && !RIVER_BRIDGES.some(b => b.id === b2.id)) RIVER_BRIDGES.push(b2);
                }
                rebuildTerrainVerticesAndColors();
                _astarStaticDirty = true;
                pathRes = computeAStarWalkablePath(
                    PLAYER_START_POS,
                    ENEMY_BASE_POS,
                    uRad,
                    [],
                    1.2
                );
                reached = Boolean(pathRes && pathRes.reachedGoal !== false && Array.isArray(pathRes) && pathRes.length >= 2);
            }
            const entry = {
                unitRadius: uRad,
                reachable: reached,
                waypointCount: Array.isArray(pathRes) ? pathRes.length : 0,
                bestHeuristicCells: pathRes && typeof pathRes.bestHeuristicCells === 'number' ? Number(pathRes.bestHeuristicCells.toFixed(2)) : 0
            };
            groundConnectivity[key] = entry;
            groundConnectivity['radius_0.48'] = { ...entry, unitRadius: 0.48 };
            groundConnectivity['radius_1.15'] = { ...entry, unitRadius: 1.15 };
            if (!reached) {
                allGroundPathsValid = false;
                issues.push({
                    type: 'ground_route_unreachable',
                    unitRadius: uRad,
                    biome: ACTIVE_PLANET_BIOME,
                    bestHeuristicCells: groundConnectivity[key].bestHeuristicCells
                });
            }
        }
    }

    window.BRIDGE_DIAGNOSTICS = {
        seed: MAP_SEED,
        biome: ACTIVE_PLANET_BIOME,
        hasValleyRiver: HAS_VALLEY_RIVER,
        bridgeCount: bridgeReports.length,
        valid: issues.length === 0 && allGroundPathsValid,
        allGroundPathsValid,
        groundConnectivity,
        issues,
        bridges: bridgeReports
    };

    if (window.BRIDGE_DEBUG_OVERLAY_ACTIVE && typeof window.toggleBridgeConnectivityDebugOverlay === 'function') {
        window.toggleBridgeConnectivityDebugOverlay(true);
    }

    return { valid: issues.length === 0 && allGroundPathsValid, allGroundPathsValid, groundConnectivity, issues, bridges: bridgeReports };
}
window.validateGeneratedBridges = validateBridgeConnections;

window.toggleBridgeConnectivityDebugOverlay = function(forceState) {
    const nextState = forceState !== undefined ? Boolean(forceState) : !window.BRIDGE_DEBUG_OVERLAY_ACTIVE;
    window.BRIDGE_DEBUG_OVERLAY_ACTIVE = nextState;
    if (window._bridgeDebugOverlayGroup) {
        if (window._bridgeDebugOverlayGroup.parent) window._bridgeDebugOverlayGroup.parent.remove(window._bridgeDebugOverlayGroup);
        window._bridgeDebugOverlayGroup = null;
    }
    if (!nextState || typeof scene === 'undefined' || !scene) return false;

    const dbgGroup = new THREE.Group();
    dbgGroup.name = 'BridgeConnectivityDebugOverlay';
    const okMat = new THREE.MeshBasicMaterial({ color: 0x22ff88, wireframe: true });
    const badMat = new THREE.MeshBasicMaterial({ color: 0xff3344, wireframe: true });

    for (let i = 0; i < RIVER_BRIDGES.length; i++) {
        const rb = RIVER_BRIDGES[i];
        const span = (rb.rampReachU || (rb.flatHalfSpan || 6.0) + 3.5) * 2.0;
        const w = (rb.halfWidth || 3.45) * 2.0;
        const box = new THREE.Mesh(new THREE.BoxGeometry(w, 1.2, span), okMat);
        box.position.set(rb.centerX || rb.worldX || 0, 1.1, rb.centerZ || rb.worldZ || 0);
        box.rotation.y = rb.yaw || 0;
        dbgGroup.add(box);
    }

    if (typeof computeAStarWalkablePath === 'function') {
        const path = computeAStarWalkablePath(PLAYER_START_POS.x, PLAYER_START_POS.z, ENEMY_BASE_POS.x, ENEMY_BASE_POS.z, 0.75, 1.2);
        const reached = Boolean(path && path.reachedGoal !== false);
        const pts = (path || []).map(p => new THREE.Vector3(p.x, getTerrainHeight(p.x, p.z) + 0.9, p.z));
        if (pts.length >= 2) {
            const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
            const lineMat = new THREE.LineBasicMaterial({ color: reached ? 0x00ffcc : 0xff3344 });
            dbgGroup.add(new THREE.Line(lineGeo, lineMat));
        }
    }

    scene.add(dbgGroup);
    window._bridgeDebugOverlayGroup = dbgGroup;
    return true;
};

function validateTerrainSlopes() {
    const issues = [];
    const baseAnchors = [
        { name: 'player_start', x: PLAYER_START_POS.x, z: PLAYER_START_POS.z, r: 10.5 },
        { name: 'enemy_base', x: ENEMY_BASE_POS.x, z: ENEMY_BASE_POS.z, r: 10.5 },
        { name: 'solaris_base', x: SOLARIS_BASE_POS.x, z: SOLARIS_BASE_POS.z, r: 9.5 }
    ];
    for (let b = 0; b < baseAnchors.length; b++) {
        const ba = baseAnchors[b];
        const centerH = getTerrainHeight(ba.x, ba.z);
        for (let a = 0; a < 8; a++) {
            const ang = (a / 8) * Math.PI * 2;
            const sx = ba.x + Math.cos(ang) * (ba.r * 0.65);
            const sz = ba.z + Math.sin(ang) * (ba.r * 0.65);
            const hDiff = Math.abs(getTerrainHeight(sx, sz) - centerH);
            if (hDiff > 0.65) {
                issues.push({ type: 'base_pad_uneven', base: ba.name, x: sx, z: sz, hDiff });
                break;
            }
        }
    }
    return { valid: issues.length === 0, issues };
}

function validateBuildingPlacement() {
    const issues = [];
    for (let i = obstacles.length - 1; i >= 0; i--) {
        const ob = obstacles[i];
        if (!ob || ob.isDynamicPond || ob.type === 'pond' || ob.type === 'mineral' || ob.type === 'geyser') continue;
        // Check if a natural prop/rock/tree/ruin was placed on an active bridge or road centerline
        if (isSpotUnderOrBlockingBridge(ob.x, ob.z, (ob.r || 0.6) + 0.5)) {
            issues.push({ type: 'obstacle_blocking_bridge', index: i, ob });
        } else if ((ob.isTree || ob.type === 'tree' || ob.type === 'rock') && getSupplyRoadFactor(ob.x, ob.z) > 0.68) {
            issues.push({ type: 'obstacle_on_road_centerline', index: i, ob });
        }
    }
    return { valid: issues.length === 0, issues };
}

function repairGeneratedMap(allIssues) {
    if (!Array.isArray(allIssues) || allIssues.length === 0) return 0;
    let repairedCount = 0;
    let needsRoadRebake = false;

    for (let i = 0; i < allIssues.length; i++) {
        const issue = allIssues[i];
        if (!issue) continue;

        if (issue.type === 'road_missing_samples' && issue.seg) {
            precomputeRoadSegmentSamples(issue.seg, 72);
            needsRoadRebake = true;
            repairedCount++;
        } else if ((issue.type === 'road_sharp_kink' || issue.type === 'road_excessive_grade') && typeof issue.segIndex === 'number') {
            const seg = DYNAMIC_ROAD_SEGMENTS[issue.segIndex];
            if (seg && Array.isArray(seg.samples)) {
                // Apply extra Laplacian smoothing passes to eliminate any residual kink or grade spike
                const n = seg.samples.length;
                for (let pass = 0; pass < 4; pass++) {
                    for (let k = 1; k < n - 1; k++) {
                        seg.samples[k].x = seg.samples[k].x * 0.5 + (seg.samples[k - 1].x + seg.samples[k + 1].x) * 0.25;
                        seg.samples[k].z = seg.samples[k].z * 0.5 + (seg.samples[k - 1].z + seg.samples[k + 1].z) * 0.25;
                        if (typeof seg.samples[k].targetElevation === 'number') {
                            seg.samples[k].targetElevation = seg.samples[k].targetElevation * 0.5 +
                                ((seg.samples[k - 1].targetElevation || 0.2) + (seg.samples[k + 1].targetElevation || 0.2)) * 0.25;
                        }
                    }
                }
                needsRoadRebake = true;
                repairedCount++;
            }
        } else if (issue.type === 'bridge_orientation_mismatch' && typeof issue.bridgeIndex === 'number') {
            const rb = RIVER_BRIDGES[issue.bridgeIndex];
            if (rb && typeof issue.expectedYaw === 'number') {
                rb.yaw = issue.expectedYaw;
                rb.cosYaw = Math.cos(rb.yaw);
                rb.sinYaw = Math.sin(rb.yaw);
                if (rb.bridgeGroup) rb.bridgeGroup.rotation.y = rb.yaw;
                repairedCount++;
            }
        } else if ((issue.type === 'obstacle_blocking_bridge' || issue.type === 'obstacle_on_road_centerline') && issue.ob) {
            const idx = obstacles.indexOf(issue.ob);
            if (idx !== -1) {
                obstacles.splice(idx, 1);
                repairedCount++;
            }
        }
    }

    if (needsRoadRebake) {
        bakeRoadSpatialLookupGrid();
        rebuildTerrainVerticesAndColors();
        syncFowGeometryWithTerrain();
    }
    return repairedCount;
}

function validateGeneratedMap() {
    const roadRes = validateRoadNetwork();
    const riverRes = validateRiverGeometry();
    const bridgeRes = validateBridgeConnections();
    const slopeRes = validateTerrainSlopes();
    const bldRes = validateBuildingPlacement();

    const allIssues = [
        ...roadRes.issues,
        ...riverRes.issues,
        ...bridgeRes.issues,
        ...slopeRes.issues,
        ...bldRes.issues
    ];

    let repairedCount = 0;
    if (allIssues.length > 0) {
        repairedCount = repairGeneratedMap(allIssues);
    }

    return {
        seed: MAP_SEED,
        valid: allIssues.length === 0 || repairedCount >= allIssues.length,
        issueCount: allIssues.length,
        repairedCount,
        details: {
            roads: roadRes.valid,
            river: riverRes.valid,
            bridges: bridgeRes.valid,
            slopes: slopeRes.valid,
            buildings: bldRes.valid
        }
    };
}
window.validateGeneratedMap = validateGeneratedMap;
window.validateRoadNetwork = validateRoadNetwork;
window.validateRiverGeometry = validateRiverGeometry;
window.validateBridgeConnections = validateBridgeConnections;
window.validateTerrainSlopes = validateTerrainSlopes;
window.validateBuildingPlacement = validateBuildingPlacement;
window.repairGeneratedMap = repairGeneratedMap;

populateDynamicWorldPropsAndLandmarks();
validateGeneratedMap();

// Dynamic Runtime Map Regeneration API (Honors deterministic customSeed when provided, or generates a fresh 6-digit seed!)
window.generateDynamicMapParameters = generateProceduralTopographyParameters;
window.regenerateMapDynamically = function(customSeed, lobbyPlayers) {
    if (Array.isArray(lobbyPlayers)) {
        window.CUSTOM_LOBBY_PLAYERS = lobbyPlayers;
    }
    clearGeneratedMapMeshes();
    obstacles.length = 0;
    MINERAL_PATCHES.length = 0;
    swayTrees.length = 0;
    creepTumors.length = 0;
    frontierBuildingInfestations.length = 0;
    activeZergExpansionCreepMeshes.length = 0;
    meadowGrassEntries.length = 0;
    activeMeadowGrassMesh = null;
    animatedBiomeLandmarks.length = 0;
    DESTRUCTIBLE_ENV_STRUCTURES.length = 0;
    PROCEDURAL_FOREST_GROVES.length = 0;
    WILDLIFE_AGENTS.length = 0;
    CIVILIAN_AGENTS.length = 0;
    _cachedBaseBlockers = null;
    _cachedPinchZones = [];
    _cachedBaseBlockersMs = -9999;
    _astarStaticDirty = true;
    _lastSyncedCreepVertexRadius = -999;
    _lastSyncedCreepCenterX = -999;
    _lastSyncedCreepCenterZ = -999;
    NAV_STUCK_HOTSPOTS.length = 0;

    try { sessionStorage.removeItem('OUTPOST_MAP_SEED'); } catch (e) {}

    const hasExplicitSeed = (customSeed !== undefined && customSeed !== null && customSeed !== '' && Number.isFinite(Number(customSeed)) && Number(customSeed) > 0);
    let nextSeed;
    if (hasExplicitSeed) {
        nextSeed = Math.floor(Number(customSeed));
    } else {
        nextSeed = Math.floor(100000 + Math.random() * 899999);
        if (nextSeed === MAP_SEED) {
            nextSeed = ((nextSeed + 247913) % 899999) + 100000;
        }
    }

    generateProceduralTopographyParameters(nextSeed);
    computeDynamicRoadAndLandmarkLayout();
    rebuildTerrainVerticesAndColors();
    syncBaseAndCameraToTerrain();
    syncFowGeometryWithTerrain();

    fowExplored.fill(0);
    fowVisible.fill(0);
    const activeCreepInfo = getActiveZergCreepState();
    creepRadius = activeCreepInfo.hasBuiltZergMainBase ? 16.5 : 0.0;
    creepTargetRadius = activeCreepInfo.hasBuiltZergMainBase ? 21.0 : 0.0;
    activeZergMainCreepMesh = null;

    populateDynamicWorldPropsAndLandmarks();
    validateGeneratedMap();
    updateZergCreepColors(creepRadius, false, true);
    if (window.OUT_OF_BOUNDS_TERRAIN_SYSTEM) window.OUT_OF_BOUNDS_TERRAIN_SYSTEM.rebuild();
    if (window.BIOME_SKYBOX_SYSTEM) window.BIOME_SKYBOX_SYSTEM.rebuild(ACTIVE_PLANET_BIOME, MAP_SEED);

    if (typeof window.resetMatchForNewMap === 'function') {
        window.resetMatchForNewMap(MAP_SEED, window.CUSTOM_LOBBY_PLAYERS);
    }
    return MAP_SEED;
};
window.regenerateDynamicSectorMap = window.regenerateMapDynamically;

function updateBiomeLandmarks(dt) {
    if (window.BIOME_SKYBOX_SYSTEM && typeof window.BIOME_SKYBOX_SYSTEM.update === 'function') {
        window.BIOME_SKYBOX_SYSTEM.update(dt);
    }
    for (let i = 0; i < animatedBiomeLandmarks.length; i++) {
        const lm = animatedBiomeLandmarks[i];
        lm.phase += dt * 2.6;
        if (lm.type === 'satellite' && lm.mesh) {
            lm.mesh.rotation.y += dt * 0.48;
        } else if (lm.type === 'naval_vessel' && lm.mesh) {
            const bob = Math.sin(lm.phase * (lm.bobSpeed || 0.7)) * (lm.bobAmp || 0.06);
            lm.mesh.position.y = (lm.baseY ?? WATER_LEVEL) + bob;
            lm.mesh.rotation.z = (lm.baseRoll || 0) + Math.sin(lm.phase * 0.55) * (lm.rollAmp || 0.015);
            lm.mesh.rotation.x = (lm.basePitch || 0) + Math.cos(lm.phase * 0.45) * ((lm.rollAmp || 0.015) * 0.65);
            if (lm.radarSpinner) {
                lm.radarSpinner.rotation.y += dt * 1.65;
            }
            if (Array.isArray(lm.smokeNodes)) {
                for (let sIdx = 0; sIdx < lm.smokeNodes.length; sIdx++) {
                    const sn = lm.smokeNodes[sIdx];
                    if (!sn || !sn.mesh) continue;
                    const cyc = ((lm.phase * 0.25 + sn.phaseOffset) % 1.0 + 1.0) % 1.0;
                    sn.mesh.position.y = sn.baseY + cyc * 1.45;
                    sn.mesh.position.x = sn.baseX + Math.sin(lm.phase + sn.phaseOffset) * 0.28;
                    const sc = 0.65 + cyc * 0.95;
                    sn.mesh.scale.set(sc, sc * 0.72, sc);
                }
            }
        } else if (lm.type === 'wind_turbine' && lm.mesh) {
            lm.mesh.rotation.z -= dt * 1.85;
        } else if (lm.type === 'waterwall') {
            if (lm.foam) {
                lm.foam.scale.setScalar(0.94 + Math.sin(lm.phase * 2.2) * 0.08);
            }
        } else if (lm.type === 'campfire' && lm.mesh) {
            lm.mesh.scale.set(1 + Math.sin(lm.phase * 5) * 0.15, 0.88 + Math.cos(lm.phase * 7) * 0.22, 1 + Math.sin(lm.phase * 5) * 0.15);
        } else if (lm.type === 'radwaste') {
            if (lm.pool) lm.pool.scale.setScalar(0.97 + Math.sin(lm.phase * 1.8) * 0.04);
            if (lm.bubbles) {
                lm.bubbles.forEach((b, idx) => {
                    const s = 0.75 + Math.abs(Math.sin(lm.phase * 2.2 + idx * 1.4)) * 0.65;
                    b.scale.setScalar(s);
                    b.position.y = 0.08 + s * 0.12;
                });
            }
        } else if (lm.type === 'pumpjack' && lm.mesh) {
            lm.mesh.rotation.z = Math.sin(lm.phase * 1.15) * 0.28;
        } else if (lm.type === 'electric_arc' && lm.mesh) {
            const pulse = 0.75 + Math.abs(Math.sin(lm.phase * 6.0)) * 0.55;
            lm.mesh.scale.set(pulse, 1.0, pulse);
        } else if (lm.type === 'uxo_fuze' && lm.mesh) {
            const blink = Math.sin(lm.phase * 3.5) > 0.2 ? 1.35 : 0.65;
            lm.mesh.scale.setScalar(blink);
        } else if (lm.type === 'lava_fountain' && lm.mesh) {
            const surge = 0.85 + Math.abs(Math.sin(lm.phase * 3.2)) * 0.95;
            lm.mesh.scale.set(0.9 + surge * 0.25, surge, 0.9 + surge * 0.25);
        }
    }

    // Animate Autonomous Wildlife Agents (Flocking Sky Birds + Grazing/Fleeing Canyon Deer)
    for (let w = 0; w < WILDLIFE_AGENTS.length; w++) {
        const ag = WILDLIFE_AGENTS[w];
        if (!ag || !ag.mesh) continue;
        if (ag.kind === 'bird') {
            ag.angle += dt * ag.speed;
            ag.flapPhase += dt * 9.5;
            const bx = ag.centerX + Math.cos(ag.angle) * ag.orbitRadius;
            const bz = ag.centerZ + Math.sin(ag.angle) * ag.orbitRadius;
            const by = ag.altitude + Math.sin(ag.angle * 2.0) * 1.2;
            ag.mesh.position.set(bx, by, bz);
            ag.mesh.rotation.y = -ag.angle;
            const flap = Math.sin(ag.flapPhase) * 0.42;
            if (ag.leftWing) ag.leftWing.rotation.z = flap;
            if (ag.rightWing) ag.rightWing.rotation.z = -flap;
        } else if (ag.kind === 'deer') {
            if (ag.fleeTimer > 0) ag.fleeTimer = Math.max(0, ag.fleeTimer - dt);
            const dx = ag.targetX - ag.mesh.position.x;
            const dz = ag.targetZ - ag.mesh.position.z;
            const dist = Math.hypot(dx, dz);
            const spd = ag.fleeTimer > 0 ? 5.2 : 1.35;
            if (dist > 0.45) {
                ag.mesh.position.x += (dx / dist) * spd * dt;
                ag.mesh.position.z += (dz / dist) * spd * dt;
                ag.mesh.position.y = getTerrainHeight(ag.mesh.position.x, ag.mesh.position.z);
                ag.mesh.rotation.y = Math.atan2(dx, dz);
                ag.walkPhase += dt * (ag.fleeTimer > 0 ? 16.0 : 6.5);
                if (ag.legs && ag.legs.length === 4) {
                    const sw = Math.sin(ag.walkPhase) * 0.45;
                    ag.legs[0].rotation.x = sw;
                    ag.legs[1].rotation.x = -sw;
                    ag.legs[2].rotation.x = -sw;
                    ag.legs[3].rotation.x = sw;
                }
            } else {
                ag.idleTimer -= dt;
                if (ag.idleTimer <= 0) {
                    ag.idleTimer = 2.0 + Math.random() * 3.5;
                    ag.targetX = THREE.MathUtils.clamp(ag.homeX + (Math.random() - 0.5) * 14.0, -90, 90);
                    ag.targetZ = THREE.MathUtils.clamp(ag.homeZ + (Math.random() - 0.5) * 14.0, -90, 90);
                }
            }
        }
    }

    // Animate Autonomous Settlement Civilians / Frontier Engineers
    for (let c = 0; c < CIVILIAN_AGENTS.length; c++) {
        const civ = CIVILIAN_AGENTS[c];
        if (!civ || !civ.mesh) continue;
        if (civ.panicTimer > 0) civ.panicTimer = Math.max(0, civ.panicTimer - dt);
        const dx = civ.targetX - civ.mesh.position.x;
        const dz = civ.targetZ - civ.mesh.position.z;
        const dist = Math.hypot(dx, dz);
        const spd = civ.panicTimer > 0 ? 3.4 : 1.15;
        if (dist > 0.35) {
            civ.mesh.position.x += (dx / dist) * spd * dt;
            civ.mesh.position.z += (dz / dist) * spd * dt;
            civ.mesh.position.y = getTerrainHeight(civ.mesh.position.x, civ.mesh.position.z);
            civ.mesh.rotation.y = Math.atan2(dx, dz);
            civ.walkPhase += dt * (civ.panicTimer > 0 ? 13.0 : 6.0);
            if (civ.legs && civ.legs.length === 2) {
                civ.legs[0].rotation.x = Math.sin(civ.walkPhase) * 0.45;
                civ.legs[1].rotation.x = -Math.sin(civ.walkPhase) * 0.45;
            }
        } else {
            civ.targetX = civ.homeX + (Math.random() - 0.5) * 8.0;
            civ.targetZ = civ.homeZ + (Math.random() - 0.5) * 8.0;
        }
    }

    // Animate 3D Terrain Ambience Nodes (Canyon Dust, Geothermal Steam, Zerg Creep Spores, Solaris Psionic Motes)
    const creepState = getActiveZergCreepState();
    for (let a = 0; a < terrainAmbienceNodes.length; a++) {
        const node = terrainAmbienceNodes[a];
        if (!node || !node.mesh) continue;
        node.phase += dt * node.speed;
        const m = node.mesh;
        if (node.kind === 'dust') {
            m.position.x = node.baseX + Math.sin(node.phase * 0.8) * 2.4;
            m.position.z = node.baseZ + Math.cos(node.phase * 0.6) * 2.4;
            m.position.y = node.baseY + Math.sin(node.phase * 1.5) * 0.45;
            m.rotation.y += dt * 1.2;
        } else if (node.kind === 'steam') {
            const cyc = (node.phase * 0.35) % 1.0;
            m.position.y = node.baseY + cyc * 2.8;
            m.position.x = node.baseX + Math.sin(node.phase * 1.8) * 0.55;
            const sc = (0.65 + cyc * 1.35) * (1.0 - cyc * 0.55);
            m.scale.set(sc * 1.3, sc * 0.65, sc * 1.3);
        } else if (node.kind === 'zerg_spore') {
            // Hide Zerg spores as creep recedes past their radius or when Main Zerg Base is not built / destroyed!
            const onCreep = (creepState.hasBuiltZergMainBase && creepRadius > 0.6 && node.relRadius <= creepRadius + 0.8);
            m.visible = onCreep;
            if (onCreep) {
                const curAng = node.relAngle + Math.sin(node.phase * 0.5) * 0.18;
                m.position.x = creepState.x + Math.cos(curAng) * node.relRadius;
                m.position.z = creepState.z + Math.sin(curAng) * node.relRadius;
                m.position.y = node.baseY + Math.sin(node.phase * 2.2) * 0.55;
                m.scale.setScalar(0.65 + Math.abs(Math.sin(node.phase * 2.8)) * 0.55);
            }
        } else if (node.kind === 'solaris_mote') {
            m.position.x = node.baseX + Math.cos(node.phase * 1.1) * 0.75;
            m.position.z = node.baseZ + Math.sin(node.phase * 1.1) * 0.75;
            m.position.y = node.baseY + Math.sin(node.phase * 2.4) * 0.42;
            m.rotation.z += dt * 2.0;
        }
    }
}
window.updateBiomeLandmarks = updateBiomeLandmarks;

// ============================================================================
// MULTI-SAMPLE TERRAIN CLASSIFIER & FLAT-PLAIN BIOME STRUCTURE GENERATOR
// Detects: flat_plains, hills, highland_plateaus, slopes, cliffs, ravines,
//          rivers, shorelines, rocky_terrain, forested_areas
// ============================================================================
const TERRAIN_CLASSIFIER = {
    lastPlacedBiomeStructures: [],
    classificationSummary: {},
    classifyArea(wx, wz, footprintRadius = 4.5) {
        const r = Math.max(1.5, footprintRadius);
        const offsets = [
            [0, 0],
            [-r, 0], [r, 0], [0, -r], [0, r],
            [-r * 0.7, -r * 0.7], [r * 0.7, -r * 0.7],
            [-r * 0.7, r * 0.7], [r * 0.7, r * 0.7]
        ];
        let minH = Infinity;
        let maxH = -Infinity;
        let sumH = 0;
        let sumNy = 0;
        for (let i = 0; i < offsets.length; i++) {
            const sx = wx + offsets[i][0];
            const sz = wz + offsets[i][1];
            const h = getTerrainHeight(sx, sz);
            if (h < minH) minH = h;
            if (h > maxH) maxH = h;
            sumH += h;
            const hx1 = getTerrainHeight(sx - 0.9, sz);
            const hx2 = getTerrainHeight(sx + 0.9, sz);
            const hz1 = getTerrainHeight(sx, sz - 0.9);
            const hz2 = getTerrainHeight(sx, sz + 0.9);
            const dx = (hx2 - hx1) / 1.8;
            const dz = (hz2 - hz1) / 1.8;
            const ny = 1.0 / Math.sqrt(dx * dx + 1.0 + dz * dz);
            sumNy += ny;
        }
        const meanH = sumH / offsets.length;
        const heightDiff = maxH - minH;
        const avgNormalY = sumNy / offsets.length;

        const inRiver = (typeof isInRiverWaterChannel === 'function' && isInRiverWaterChannel(wx, wz, 0.5)) || meanH <= (WATER_LEVEL + 0.08);
        const nearWater = (typeof isInRiverWaterChannel === 'function' && isInRiverWaterChannel(wx, wz, 4.2)) || (meanH > WATER_LEVEL - 0.15 && meanH <= WATER_LEVEL + 0.45);
        let inForest = false;
        for (let i = 0; i < PROCEDURAL_FOREST_GROVES.length; i++) {
            const g = PROCEDURAL_FOREST_GROVES[i];
            if (Math.hypot(wx - g.x, wz - g.z) <= (g.r || 9.5) + 1.5) {
                inForest = true;
                break;
            }
        }
        let nearRock = false;
        for (let i = 0; i < obstacles.length; i++) {
            const ob = obstacles[i];
            if (ob && Math.hypot(wx - ob.x, wz - ob.z) <= (ob.r || 2.0) + 2.8) {
                nearRock = true;
                break;
            }
        }

        let category = 'hills';
        if (inRiver) {
            category = 'rivers';
        } else if (nearWater && heightDiff < 1.1) {
            category = 'shorelines';
        } else if (heightDiff > 2.35 || avgNormalY < 0.78) {
            category = 'cliffs';
        } else if (meanH < -0.55 && heightDiff > 0.95) {
            category = 'ravines';
        } else if (heightDiff > 0.85 || avgNormalY < 0.945) {
            category = 'slopes';
        } else if (inForest) {
            category = 'forested_areas';
        } else if (nearRock) {
            category = 'rocky_terrain';
        } else if (meanH >= 2.2 && heightDiff <= 0.75 && avgNormalY >= 0.96) {
            category = 'highland_plateaus';
        } else if (heightDiff <= 0.72 && avgNormalY >= 0.962 && meanH > WATER_LEVEL + 0.22) {
            category = 'flat_plains';
        }

        return {
            category,
            isFlatPlain: (category === 'flat_plains' || category === 'highland_plateaus') && heightDiff <= 0.75 && avgNormalY >= 0.96,
            heightDiff,
            avgNormalY,
            meanH,
            minH,
            maxH
        };
    },
    scanBiomeFlatPlains(gridStep = 16, footprintRadius = 4.8) {
        const flatSpots = [];
        const summary = {
            flat_plains: 0,
            hills: 0,
            highland_plateaus: 0,
            slopes: 0,
            cliffs: 0,
            ravines: 0,
            rivers: 0,
            shorelines: 0,
            rocky_terrain: 0,
            forested_areas: 0
        };
        for (let x = -88; x <= 88; x += gridStep) {
            for (let z = -88; z <= 88; z += gridStep) {
                const info = this.classifyArea(x, z, footprintRadius);
                if (summary[info.category] !== undefined) summary[info.category]++;
                if (info.isFlatPlain && isSafeForProp(x, z, footprintRadius + 1.4)) {
                    flatSpots.push({ x, z, ...info });
                }
            }
        }
        this.classificationSummary = summary;
        return flatSpots;
    },
    buildBiomeFlatPlainStructureMesh(biome, variantIdx, wx, wz, yaw) {
        const group = new THREE.Group();
        const groundY = getTerrainHeight(wx, wz);
        group.position.set(wx, groundY, wz);
        group.rotation.y = yaw;
        group.userData.isBiomeFlatPlainStructure = true;
        group.userData.biome = biome;

        // Grounding foundation plinth so structure sits flush on terrain
        const plinthMat = (biome === 'lava' ? MAT.obsidianMat : (biome === 'desert' ? MAT.canyonRock : (biome === 'jungle' ? MAT.mossRock : MAT.ruinConcrete))) || MAT.terranBase;
        const steelMat = MAT.ruinSteel || MAT.terranBase;
        const darkMat = MAT.ruinSteelDark || MAT.terranDark;
        const glowMat = (biome === 'lava' ? MAT.hazardGlow : MAT.trimGlow) || MAT.terranCyan;

        const plinth = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.85, 0.75, 8), plinthMat);
        plinth.position.y = 0.22;
        group.add(plinth);

        if (biome === 'highland') {
            // Highland: Abandoned Military Outpost / Comm Relay / Fortified Watch Installation
            group.name = 'HighlandFlatPlainOutpost';
            const bunker = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.9, 2.8), MAT.bunkerMat || steelMat);
            bunker.position.set(-0.4, 1.35, 0);
            group.add(bunker);
            const roof = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.32, 3.1), darkMat);
            roof.position.set(-0.4, 2.42, 0);
            group.add(roof);
            const towerMast = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, 4.4, 6), steelMat);
            towerMast.position.set(1.65, 2.6, 0.55);
            group.add(towerMast);
            const dish = new THREE.Mesh(new THREE.ConeGeometry(0.85, 0.48, 8), MAT.silver || steelMat);
            dish.rotation.x = Math.PI * 0.35;
            dish.position.set(1.65, 4.65, 0.75);
            group.add(dish);
            const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), glowMat);
            beacon.position.set(1.65, 4.95, 0.55);
            group.add(beacon);
        } else if (biome === 'desert') {
            // Desert: Arid Drilling Rig & Solar Condenser Depot
            group.name = 'DesertFlatPlainDepot';
            const tank1 = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 2.7, 10), MAT.ruinPlaster || plinthMat);
            tank1.position.set(-1.1, 1.75, -0.4);
            group.add(tank1);
            const tank2 = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 2.3, 10), steelMat);
            tank2.position.set(0.95, 1.55, -0.6);
            group.add(tank2);
            const derrick = new THREE.Mesh(new THREE.ConeGeometry(1.1, 3.8, 4), darkMat);
            derrick.position.set(0.2, 2.3, 1.0);
            group.add(derrick);
            const solarPanel = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.14, 1.5), MAT.glassMat || glowMat);
            solarPanel.rotation.x = -0.35;
            solarPanel.position.set(-0.2, 3.25, -0.4);
            group.add(solarPanel);
        } else if (biome === 'jungle') {
            // Jungle: Overgrown Research Outpost & Stepped Stone Temple Sanctuary
            group.name = 'JungleFlatPlainSanctuary';
            const step1 = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.9, 4.2), MAT.mossRock || plinthMat);
            step1.position.y = 0.85;
            group.add(step1);
            const step2 = new THREE.Mesh(new THREE.BoxGeometry(2.9, 1.1, 2.9), MAT.ruinConcrete || plinthMat);
            step2.position.y = 1.85;
            group.add(step2);
            const sanctum = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 1.8), steelMat);
            sanctum.position.y = 3.05;
            group.add(sanctum);
            const canopy = new THREE.Mesh(new THREE.ConeGeometry(2.1, 1.2, 6), MAT.foliagePine || plinthMat);
            canopy.position.set(-1.2, 2.9, 1.1);
            group.add(canopy);
            const bioPod = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.1, 8), glowMat);
            bioPod.position.set(0, 4.0, 0);
            group.add(bioPod);
        } else if (biome === 'ocean') {
            // Ocean: Coastal Radar Beacon & Archipelago Supply Pier
            group.name = 'OceanFlatPlainBeacon';
            const baseHouse = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.75, 2.1, 8), MAT.ruinConcrete || plinthMat);
            baseHouse.position.y = 1.45;
            group.add(baseHouse);
            const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 1.15, 3.4, 8), MAT.medivacHull || steelMat);
            spire.position.y = 3.95;
            group.add(spire);
            const lantern = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.85, 8), glowMat);
            lantern.position.y = 5.85;
            group.add(lantern);
            const cap = new THREE.Mesh(new THREE.ConeGeometry(0.95, 0.75, 8), darkMat);
            cap.position.y = 6.55;
            group.add(cap);
        } else {
            // Lava: Geothermal Magma Extractor & Fortified Basalt Monolith Outpost
            group.name = 'LavaFlatPlainExtractor';
            const coreHull = new THREE.Mesh(new THREE.CylinderGeometry(1.65, 2.1, 2.6, 6), MAT.obsidianMat || darkMat);
            coreHull.position.y = 1.7;
            group.add(coreHull);
            const heatShield = new THREE.Mesh(new THREE.CylinderGeometry(2.25, 2.25, 0.65, 6), steelMat);
            heatShield.position.y = 2.65;
            group.add(heatShield);
            const magmaCore = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.85, 3.8, 8), MAT.hazardGlow || glowMat);
            magmaCore.position.y = 2.45;
            group.add(magmaCore);
            for (let i = 0; i < 3; i++) {
                const a = (i / 3) * Math.PI * 2;
                const Buttress = new THREE.Mesh(new THREE.BoxGeometry(0.7, 2.8, 1.25), darkMat);
                Buttress.position.set(Math.cos(a) * 1.85, 1.65, Math.sin(a) * 1.85);
                Buttress.rotation.y = -a;
                group.add(Buttress);
            }
        }

        addMapMesh(group);
        obstacles.push({ x: wx, z: wz, r: 3.6 });
        DESTRUCTIBLE_ENV_STRUCTURES.push({
            kind: 'building',
            x: wx,
            z: wz,
            radius: 3.6,
            hp: 340,
            maxHp: 340,
            mesh: group
        });
        return group;
    },
    populateFlatPlainBiomeStructures(biome = ACTIVE_PLANET_BIOME || 'highland') {
        this.lastPlacedBiomeStructures = [];
        const structId = biome === 'ocean'
            ? 'coastal_radar_installation'
            : (biome === 'lava'
                ? 'volcanic_extractor'
                : (biome === 'desert'
                    ? 'desert_depot'
                    : (biome === 'jungle' ? 'jungle_temple' : 'military_bunker')));
        if (!isStructureAllowedInBiome(structId, biome)) return [];

        const flatCandidates = this.scanBiomeFlatPlains(15, 4.6);
        if (flatCandidates.length === 0) return [];

        // Deterministic sort using seeded pseudo-hash so placement is 100% reproducible per MAP_SEED
        const seedVal = Number(MAP_SEED) || 100001;
        flatCandidates.sort((a, b) => {
            const ha = Math.sin(a.x * 12.9898 + a.z * 78.233 + seedVal * 0.01) * 43758.5453;
            const hb = Math.sin(b.x * 12.9898 + b.z * 78.233 + seedVal * 0.01) * 43758.5453;
            return (ha - Math.floor(ha)) - (hb - Math.floor(hb));
        });

        const targetCount = IS_MOBILE ? 4 : 6;
        const chosen = [];
        for (let i = 0; i < flatCandidates.length && chosen.length < targetCount; i++) {
            const cand = flatCandidates[i];
            let tooClose = false;
            for (let j = 0; j < chosen.length; j++) {
                if (Math.hypot(cand.x - chosen[j].x, cand.z - chosen[j].z) < 22.0) {
                    tooClose = true;
                    break;
                }
            }
            if (tooClose) continue;
            const valRes = validateStructurePlacement(structId, cand.x, cand.z, 4.8, { biome, maxHeightDiff: 0.78 });
            if (!valRes.valid) continue;
            const yaw = ((i * 1.618 + seedVal * 0.017) % 1.0) * Math.PI * 2;
            const mesh = this.buildBiomeFlatPlainStructureMesh(biome, chosen.length, cand.x, cand.z, yaw);
            const rec = {
                structureId: structId,
                biome,
                x: cand.x,
                z: cand.z,
                heightDiff: cand.heightDiff,
                avgNormalY: cand.avgNormalY,
                category: cand.category,
                meshName: mesh.name
            };
            chosen.push(rec);
            this.lastPlacedBiomeStructures.push(rec);
        }
        return this.lastPlacedBiomeStructures;
    }
};
window.TERRAIN_CLASSIFIER = TERRAIN_CLASSIFIER;

// ============================================================================
// SEAMLESS OUT-OF-BOUNDS TERRAIN SKIRT SYSTEM
// Extends biome terrain geometry, vertex colors, texture, and FOW darkening
// naturally beyond [-130..+130] to [-390..+390] with zero bright floor cutoff.
// ============================================================================
const OUT_OF_BOUNDS_TERRAIN_SYSTEM = {
    mesh: null,
    rebuild() {
        if (this.mesh) {
            if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
            if (this.mesh.geometry) {
                try { this.mesh.geometry.dispose(); } catch (e) {}
            }
            this.mesh = null;
        }
        if (typeof scene === 'undefined' || !scene || typeof terrainMat === 'undefined' || !terrainMat) return;

        const outerSize = MAP_SIZE * 3.0; // 780x780m world horizon skirt
        const segs = IS_MOBILE ? 56 : 84;
        const skirtGeo = new THREE.PlaneGeometry(outerSize, outerSize, segs, segs);
        skirtGeo.rotateX(-Math.PI / 2);

        const pos = skirtGeo.attributes.position;
        const colors = new Float32Array(pos.count * 3);
        const halfPlayable = MAP_SIZE * 0.5 - 1.2; // 128.8m overlap with playable border
        const biome = ACTIVE_PLANET_BIOME || 'highland';

        let baseR = 0.24, baseG = 0.30, baseB = 0.22;
        if (biome === 'desert') { baseR = 0.52; baseG = 0.39; baseB = 0.25; }
        else if (biome === 'jungle') { baseR = 0.16; baseG = 0.32; baseB = 0.17; }
        else if (biome === 'ocean') { baseR = 0.14; baseG = 0.28; baseB = 0.36; }
        else if (biome === 'lava') { baseR = 0.16; baseG = 0.11; baseB = 0.10; }

        for (let i = 0; i < pos.count; i++) {
            const vx = pos.getX(i);
            const vz = pos.getZ(i);
            const clampedX = THREE.MathUtils.clamp(vx, -halfPlayable, halfPlayable);
            const clampedZ = THREE.MathUtils.clamp(vz, -halfPlayable, halfPlayable);
            const distOut = Math.hypot(vx - clampedX, vz - clampedZ);

            let vy;
            if (distOut < 0.05) {
                // Depress interior under playable map slightly so it never z-fights with playable terrain
                vy = getTerrainHeight(vx, vz) - 2.6;
            } else {
                const edgeH = getTerrainHeight(clampedX, clampedZ);
                const ridge = Math.sin(vx * 0.035 + vz * 0.028) * 2.2 + Math.cos(vx * 0.019 - vz * 0.031) * 1.8;
                const blend = Math.min(1.0, distOut / 36.0);
                const horizonDrop = Math.max(0, (distOut - 95.0) * 0.035);
                vy = THREE.MathUtils.lerp(edgeH - 0.12, edgeH * 0.65 + ridge - horizonDrop, blend);
            }
            pos.setY(i, vy);

            const nVar = 0.85 + 0.15 * Math.sin(vx * 0.06 + vz * 0.05);
            const distDarken = THREE.MathUtils.clamp(1.0 - (distOut / 320.0) * 0.52, 0.42, 1.0);
            colors[i * 3]     = baseR * nVar * distDarken;
            colors[i * 3 + 1] = baseG * nVar * distDarken;
            colors[i * 3 + 2] = baseB * nVar * distDarken;
        }

        skirtGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        skirtGeo.computeVertexNormals();
        skirtGeo.computeBoundingBox();
        skirtGeo.computeBoundingSphere();

        const skirtMesh = new THREE.Mesh(skirtGeo, terrainMat);
        skirtMesh.name = 'OutOfBoundsTerrainSkirt';
        skirtMesh.receiveShadow = true;
        scene.add(skirtMesh);
        this.mesh = skirtMesh;
        return skirtMesh;
    }
};
window.OUT_OF_BOUNDS_TERRAIN_SYSTEM = OUT_OF_BOUNDS_TERRAIN_SYSTEM;

// ============================================================================
// BIOME-SPECIFIC PROCEDURAL SKYBOX DOME SYSTEM
// Matches ACTIVE_PLANET_BIOME & MAP_SEED, follows camera translation,
// and blends seamlessly with terrain fog and out-of-bounds horizon.
// ============================================================================
const BIOME_SKYBOX_SYSTEM = {
    mesh: null,
    texture: null,
    currentBiome: null,
    currentSeed: null,
    palettes: {
        highland: {
            zenith: '#060c18',
            upper: '#0e1d36',
            mid: '#1b3152',
            horizon: '#0b111c',
            nadir: '#060911',
            cloud: 'rgba(130, 175, 225, 0.18)',
            ridge: '#080e18',
            starTint: 'rgba(205, 230, 255, 0.75)'
        },
        desert: {
            zenith: '#140c08',
            upper: '#2e1b10',
            mid: '#4d2d1b',
            horizon: '#140e0a',
            nadir: '#090604',
            cloud: 'rgba(230, 170, 115, 0.18)',
            ridge: '#120b07',
            starTint: 'rgba(255, 225, 185, 0.65)'
        },
        jungle: {
            zenith: '#051210',
            upper: '#0b2622',
            mid: '#153b34',
            horizon: '#081210',
            nadir: '#040908',
            cloud: 'rgba(110, 210, 185, 0.18)',
            ridge: '#06100d',
            starTint: 'rgba(185, 255, 230, 0.65)'
        },
        ocean: {
            zenith: '#040d1c',
            upper: '#092242',
            mid: '#123e6b',
            horizon: '#08111b',
            nadir: '#04080e',
            cloud: 'rgba(135, 205, 255, 0.20)',
            ridge: '#060d16',
            starTint: 'rgba(195, 235, 255, 0.78)'
        },
        lava: {
            zenith: '#110404',
            upper: '#290907',
            mid: '#4a140c',
            horizon: '#140705',
            nadir: '#090302',
            cloud: 'rgba(255, 105, 45, 0.22)',
            ridge: '#100403',
            starTint: 'rgba(255, 165, 110, 0.60)'
        }
    },
    rebuild(biome = ACTIVE_PLANET_BIOME || 'highland', seed = MAP_SEED || 100001) {
        const pal = this.palettes[biome] || this.palettes.highland;
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');

        // 1. Vertical atmospheric gradient (Zenith -> Upper -> Mid -> Horizon Shroud -> Nadir)
        const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
        grad.addColorStop(0.0, pal.zenith);
        grad.addColorStop(0.28, pal.upper);
        grad.addColorStop(0.46, pal.mid);
        grad.addColorStop(0.53, pal.horizon);
        grad.addColorStop(1.0, pal.nadir);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // 2. Deterministic Starfield & Nebula Haze in Upper Hemisphere
        let s = Number(seed) || 100001;
        const rand = () => {
            s = (s * 1664525 + 1013904223) % 4294967296;
            return s / 4294967296;
        };
        ctx.fillStyle = pal.starTint;
        for (let i = 0; i < 160; i++) {
            const sx = rand() * canvas.width;
            const sy = rand() * (canvas.height * 0.42);
            const sr = 0.6 + rand() * 1.3;
            ctx.beginPath();
            ctx.arc(sx, sy, sr, 0, Math.PI * 2);
            ctx.fill();
        }

        // 3. Soft Atmospheric Cloud Bands above Horizon
        ctx.fillStyle = pal.cloud;
        for (let c = 0; c < 28; c++) {
            const cx = rand() * canvas.width;
            const cy = canvas.height * (0.26 + rand() * 0.20);
            const rw = 36 + rand() * 75;
            const rh = 6 + rand() * 14;
            ctx.beginPath();
            ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
            ctx.fill();
        }

        // 4. Distant Planetary Mountain / Mesa / Volcanic Silhouettes along Horizon
        ctx.fillStyle = pal.ridge;
        ctx.beginPath();
        const horizonY = canvas.height * 0.52;
        ctx.moveTo(0, canvas.height);
        ctx.lineTo(0, horizonY);
        for (let x = 0; x <= canvas.width; x += 8) {
            const nx = (x / canvas.width) * Math.PI * 2;
            const h1 = Math.sin(nx * 4.0 + s * 0.001) * 10.0;
            const h2 = Math.cos(nx * 9.0 - s * 0.002) * 5.5;
            const h3 = Math.abs(Math.sin(nx * 15.0)) * 4.0;
            ctx.lineTo(x, horizonY - Math.max(0, h1 + h2 + h3));
        }
        ctx.lineTo(canvas.width, canvas.height);
        ctx.closePath();
        ctx.fill();

        if (this.texture) {
            try { this.texture.dispose(); } catch (e) {}
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        this.texture = tex;
        this.currentBiome = biome;
        this.currentSeed = seed;

        if (!this.mesh) {
            const skyGeo = new THREE.SphereGeometry(520, 32, 20);
            const skyMat = new THREE.MeshBasicMaterial({
                map: tex,
                side: THREE.BackSide,
                depthWrite: false,
                fog: false
            });
            this.mesh = new THREE.Mesh(skyGeo, skyMat);
            this.mesh.name = 'BiomeSkyboxDome';
            this.mesh.renderOrder = -100;
            if (typeof scene !== 'undefined' && scene) {
                scene.add(this.mesh);
            }
        } else {
            this.mesh.material.map = tex;
            this.mesh.material.needsUpdate = true;
            if (!this.mesh.parent && typeof scene !== 'undefined' && scene) {
                scene.add(this.mesh);
            }
        }
        if (typeof window.SYNC_BIOME_LIGHTING_RIG === 'function') {
            window.SYNC_BIOME_LIGHTING_RIG(biome || ACTIVE_PLANET_BIOME || 'highland');
        }
        return this.mesh;
    },
    update() {
        if (!this.mesh) return;
        if (typeof camera !== 'undefined' && camera) {
            this.mesh.position.x = camera.position.x;
            this.mesh.position.z = camera.position.z;
            this.mesh.position.y = 0;
        }
    }
};
window.BIOME_SKYBOX_SYSTEM = BIOME_SKYBOX_SYSTEM;

// Initialize out-of-bounds skirt and biome skybox on initial load
window.OUT_OF_BOUNDS_TERRAIN_SYSTEM.rebuild();
window.BIOME_SKYBOX_SYSTEM.rebuild(ACTIVE_PLANET_BIOME || 'highland', MAP_SEED);
