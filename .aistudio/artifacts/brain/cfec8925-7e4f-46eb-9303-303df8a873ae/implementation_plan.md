# StarCraft II 3D Rendering, Model Remake & Simulated Explosions Plan

## 1. Visual Direction & Core Overhaul Goals

To eliminate the artificial "AI-generated primitive" look and achieve authentic **StarCraft II** visual fidelity, this overhaul replaces three foundational layers of the 3D engine:
1. **Full 3D Model Remake for Units & Buildings**: Replace primitive box/sphere/cone assemblies with sculpted, multi-part silhouettes featuring compound beveled armor hulls, recessed mechanical joints, hydraulic actuators, layered organic chitin carapaces, and levitating Protoss Solaris arches.
2. **Full PBR Texture & Material Remake**: Rebuild all procedural surface textures from scratch—generating matched Albedo, Normal/Bump, and Roughness maps paired with a procedural Koprulu Sector HDR sky environment (`PMREMGenerator`) and `ACESFilmicToneMapping`.
3. **Simulated Fluid/Volumetric Explosions (No Primitive Shapes)**: Replace rigid geometric explosion shapes (`SphereGeometry` fireballs, `RingGeometry` shockwaves, `DodecahedronGeometry` puffs) with a **physics-simulated turbulent combustion & soft-particle system** driven by curl-noise velocity fields, thermal blackbody cooling, buoyant smoke plumes, and ballistic spark trajectories with ground bounce.

```
┌──────────────────────────────────────────────────────────────────────────┐
│           STARCRAFT II 3D MODEL, TEXTURE & VFX REMAKE ARCHITECTURE       │
├──────────────────────────────────────────────────────────────────────────┤
│  1. Sculpted 3D Unit & Building Mesh Remake                              │
│     ├─ Terran Dominion: Multi-bevel sloped armor, hydraulic legs,        │
│     │                   recessed turbine pods, articulated siege barrels │
│     ├─ Zerg Swarm: Segmented dorsal carapaces, sinewy spline limbs,      │
│     │              pulsing brood sacs, organic spire & hive architecture │
│     └─ Protoss Solaris: Swept golden crescents, levitating crystal cores,│
│                         segmented robotics & warp-conduit pylons         │
│                                                                          │
│  2. Rebuilt Multi-Channel PBR Texture Synthesis & HDR Sky Reflections    │
│     ├─ Matched Albedo + Normal/Bump + Roughness Canvas Generators        │
│     ├─ PMREM Sky/Canyon Environment Map + ACES Filmic Tone Mapping       │
│     └─ Zero Unlit Neon (`MeshBasicMaterial` ──► Grounded PBR)            │
│                                                                          │
│  3. Simulated Turbulent Explosions & Soft-Particle VFX (No 3D Shapes)    │
│     ├─ Custom GLSL FBM/Curl-Noise Fireball & Soot Plume Billboards       │
│     ├─ Blackbody Thermal Decay (White-Hot Core ──► Incandescent Orange   │
│     │                           ──► Turbulent Charcoal Smoke)            │
│     ├─ Physics-Driven Ember & Debris Simulation (Gravity, Drag, Bounce)  │
│     └─ Soft-Edge Ground Scorch Decals & Heat-Distortion Blast Waves      │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Complete Remake of 3D Unit & Building Models

### Sculpted Geometry Primitives & Compound Hulls
- Introduce reusable high-detail geometry builders (`createCompoundBeveledHull`, `createLatheTurretBarrel`, `createSegmentedCarapacePlate`, `createSweptSolarisCrescent`, `createArticulatedLimbSegment`) so every unit and structure has authentic StarCraft II silhouette read from top-down RTS camera angles.

### Terran Dominion Model Remakes
- **Structures (Command Center, Barracks, Factory, Bio-Factory, Turrets, Bunkers)**:
  - Rebuild with octagonal/buttressed command citadels, heavy blast doors with recessed docking bays, angled corner armor bastions, rotating radar arrays, and glowing recessed furnace vents instead of stacked boxes.
- **Infantry & Mechs (Marine, Medic, Marauder, Firebat, Ghost, Siege Tank, Goliath, Valkyrie)**:
  - **Infantry**: Broad-shouldered CMC-400 powered combat suits with pauldrons, curved visor domes, dorsal thruster packs, and detailed Gauss/concussive weaponry.
  - **Vehicles & Walkers**: Sloped reactive tank hulls with independent dual-tread bogie housings, muzzle-braked 120mm twin cannons, reverse-jointed Goliath walker legs with twin autocannon pods, and twin-boom swept-wing Valkyrie gunships.

### Zerg Swarm Model Remakes
- **Structures (Hatchery/Hive, Spawning Pool, Roach Warren, Hydralisk Den, Spire, Spine Crawler)**:
  - Sculpted ribbed organic domes, breathing muscular orifices, toweringcurved bone horn crowns, arterial tendril roots anchored into the creep, and coiled peristaltic sacs.
- **Bio-Strains (Zergling, Baneling, Roach, Hydralisk, Mutalisk, Ultralisk, Brood Lord)**:
  - Layered overlapping dorsal chitin plates, curved scythe-talons, serpentine ribbed tails, volatile acid-filled abdomen sacs with translucent membrane shaders, and massive twin Kaiser blades on Ultralisks.

### Protoss Solaris Model Remakes
- **Structures (Nexus, Pylon, Gateway, Cybernetics Core, Robotics Facility, Stargate, Photon Cannon)**:
  - Swept crescent-arch architecture with chamfered gold/ivorybuttresses, floating Khaydarin crystal matrices held in energy suspension, and geometric warp apertures.
- **Warriors & Robotics (Zealot, Stalker, Sentry, Immortal, Colossus, Void Ray, Archon)**:
  - Sleek armored torsos with glowing psi-blade gauntlets, quadripedal reverse-jointed Stalker/Immortal chassis with rotating phase disruptor turrets, towering multi-jointed Colossus walkers, and swirling plasma-core Archons.

---

## 3. Complete Remake of Procedural PBR Textures & Lighting

### Multi-Channel PBR Texture Generators
- Remake all procedural textures to output high-contrast, weathered surface detail without harsh cartoon lines:
  - **Terran Brushed Titanium & Camo Armor**: Anisotropic brushed steel grain, recessed panel seams with baked ambient occlusion, micro-rivets, chipped paint edges, and oil/soot weathering.
  - **Zerg Chitin, Flesh & Creep Biomass**: Porous organic cellular relief, wet mucous specular maps, striated bone ridges, and deep bruised-violet/crimson capillary webs.
  - **Protoss Solaris Filigree & Crystal Facets**: Precision-engraved golden geometric conduits, satin ivory plating, and internally refractive turquoise/gold crystal facets.
  - **Canyon Terrain, Stratified Cliffs & Botanical Turf**: Multi-octave sedimentary rock strata, crevice AO, natural highland grass/clover variation, and wet riverbed stones.

### StarCraft II PBR Lighting & Sky Reflections
- Configure `THREE.ACESFilmicToneMapping` and generate a procedural Koprulu Sector sky & canyon cubemap via `THREE.PMREMGenerator` bound to `scene.environment`.
- Convert flat unlit `MeshBasicMaterial` trims and canisters to grounded `MeshStandardMaterial` so metallic and organic surfaces respond naturally to the directional sun, hemisphere fill, and `2048x2048` soft shadows.

---

## 4. Simulated Explosive Effects (Replacing Rigid 3D Shapes)

### Eliminating Primitive Explosion Geometries
- Remove rigid `SphereGeometry` fireballs, flat `RingGeometry` shockwaves, and blocky `DodecahedronGeometry` smoke balls that make combat look like expanding 3D primitives.

### Physics-Simulated Turbulent Combustion & Soft-Particle Shader System
- Build a unified **Simulated Explosion & Combustion Engine** using custom GLSL animated shaders and physics-simulated particle emitters:
  - **Turbulent Volumetric Fireball & Smoke Plumes**: Camera-facing soft-particle billboards rendered with a custom multi-octave Fractional Brownian Motion (FBM) & curl-noise shader. Each plume evolves continuously through a **Blackbody Temperature Curve**:
    1. *Detonation Ignition (`0.0s – 0.12s`)*: Blinding white-yellow thermal flash (`5500K`) with rapid radial expansion.
    2. *Rolling Fireball (`0.12s – 0.45s`)*: Churning incandescent orange/crimson plasma (`2200K`) with internal vortex rotation and upward buoyancy.
    3. *Billowing Soot & Ash Dissipation (`0.45s – 1.8s`)*: Cools into dark, sun-shaded charcoal smoke (`400K`) with eroded turbulent edges that dissolve organically into the air—never rendering as a hard sphere.
  - **Physics-Driven Ballistic Embers, Sparks & Shrapnel Trails**: High-velocity spark streaks and burning debris particles simulated with gravity, air drag, ground collision bounce, and cooling tail trails.
  - **Simulated Acid & Bio-Plasma Bursts**: Zerg Baneling/Roach/Ravager detonations simulate pressurized liquid aerosol mist, viscoelastic acid droplets with parabolic splash arcs, and dissolving corrosive vapor clouds.
  - **Refractive Blast Shockwave & Scorch Decals**: Soft-gradient expanding pressure waves and feathered ground scorch marks that conform to the terrain surface.
