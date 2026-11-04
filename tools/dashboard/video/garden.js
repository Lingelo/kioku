// Jardin zen 3D partagé par les deux compositions (kioku-explainer.html, kioku-explainer.en.html) :
// îlot sacré (torii, pagode, lanternes, rochers, pin, cerisier, bambous), Fuji et vallées au lavis, nuages,
// grues, ondes, pétales. Matériaux scannés (Poly Haven, CC0) en projection triplanaire (pbr.js), éclairés
// par un HDRI couvert ; le fond reste du papier washi. Les assets se téléchargent avec fetch-assets.mjs.
// Une retouche du décor se fait ici, une fois, pour les deux langues.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { loadSet, triMaterial } from './pbr.js';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const UP = new THREE.Vector3(0, 1, 0);
export const PAPER = 0xF4EFE6;

/** Réglages de rendu attendus par les matériaux du jardin. */
export function setupRenderer(renderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Khronos PBR Neutral : garde les tons chauds tels qu'écrits (le gravier reste accordé au washi autour)
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

/**
 * Charge les assets puis construit la scène. loadAsync seulement : un chargeur qui attendrait un setTimeout
 * resterait bloqué sous l'horloge virtuelle du rendu.
 * @returns {Promise<{ scene: THREE.Scene, update: (t: number) => void }>}  update(t) anime le décor au temps t (s).
 */
export async function createGarden() {
  // ---------------------------------------------------------------- assets (CC0, Poly Haven, voir fetch-assets.mjs)
    const SETS = ['sandy_gravel', 'rock_08', 'mossy_rock', 'sakura_bark', 'pine_bark',
      'grey_roof_tiles_02', 'red_plaster_weathered', 'dark_wooden_planks', 'rock_boulder_dry'];
    const texLoader = new THREE.TextureLoader();
    const A = await Promise.all([new RGBELoader().loadAsync('assets/belfast_open_field_1k.hdr'), ...SETS.map((d) => loadSet(texLoader, d))])
      .then(([hdr, ...sets]) => ({ hdr, ...Object.fromEntries(SETS.map((d, i) => [d, sets[i]])) }))
      ;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PAPER);
    scene.fog = new THREE.Fog(PAPER, 6500, 30000);

    // ciel couvert (HDRI) pour le remplissage doux et les reflets, plus un soleil pour les volumes et les ombres.
    // Le HDRI éclaire sans être montré : le fond reste du papier washi.
    A.hdr.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = A.hdr;
    scene.environmentIntensity = 1.0;
    scene.add(new THREE.HemisphereLight(0xfffaf2, 0xd9d0c0, 0.8));
    const sun = new THREE.DirectionalLight(0xffeccc, 2.6); sun.position.set(4000, 7000, 5000); scene.add(sun);
    // ombres portees : la boite d'ombre couvre l'ilot seulement (resolution utile)
    sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 3;
    Object.assign(sun.shadow.camera, { left: -3900, right: 3900, top: 3900, bottom: -3900, near: 2000, far: 19000 });

    // ---------------------------------------------------------------- materiaux
    // Scans Poly Haven en projection triplanaire (pbr.js). Échelle de la scène : 1 unité ≈ 1 cm (base de la
    // pagode : 1000 unités, une dizaine de mètres), donc « scale » est donné en répétitions par mètre, / 100.
    const PB = (set, o) => triMaterial(A[set], { ...o, scale: o.scale / 100 });
    const M = {
      shu: PB('red_plaster_weathered', { scale: 1.4, tint: new THREE.Color(1.5, 0.62, 0.36), rough: 0.75, normal: 0.6, clearcoat: 0.7 }),   // laque vermillon
      sumi: PB('dark_wooden_planks', { scale: 1.3, tint: new THREE.Color(0.45, 0.42, 0.4), rough: 0.8, clearcoat: 0.5 }),                  // bois laqué noir
      stone: PB('rock_boulder_dry', { scale: 1.1, tint: 0xd8d4cc, normal: 1.4, moss: { set: A.mossy_rock, amount: 0.6 } }),               // granit patiné
      stoneDark: PB('rock_boulder_dry', { scale: 1.1, tint: 0xb4ada3, normal: 1.4, moss: { set: A.mossy_rock, amount: 0.9 } }),
      island: new THREE.MeshStandardMaterial({ roughness: 0.9,  color: 0xDAD1C0 }),
      water: new THREE.MeshStandardMaterial({ roughness: 0.9,  color: 0xE6DFD1 }),
      wall: new THREE.MeshStandardMaterial({ color: 0xF2ECDF, roughness: 0.95 }),   // enduit uni : le scan de plâtre marbrait les murs
      lamp: new THREE.MeshBasicMaterial({ color: 0xF3C979 }),
      gravel: PB('sandy_gravel', { scale: 1.6, tint: new THREE.Color(1.45, 1.38, 1.25), gray: 0.55, normal: 0.8 }),
      moss: new THREE.MeshStandardMaterial({ roughness: 0.9,  color: 0x6F7F4F }),
      pine: new THREE.MeshStandardMaterial({ roughness: 0.9,  color: 0x3F5B3C }),
      bark: new THREE.MeshStandardMaterial({ roughness: 0.9,  color: 0x4A3A30 }),
      blossom: new THREE.MeshStandardMaterial({ roughness: 0.9,  color: 0xEBC3BE, flatShading: true }),
    };

    // ---------------------------------------------------------------- outils de modelage
    // Bruit deterministe : fonction de la position, pas de Math.random. Un rocher garde sa forme
    // d'un rendu a l'autre, et deux faces voisines recoivent le meme deplacement (aucune fissure).
    const hash = (x, y, z) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); };
    function noise3(x, y, z) {
      const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
      const fx = x - xi, fy = y - yi, fz = z - zi;
      const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
      const c = (i, j, k) => hash(xi + i, yi + j, zi + k);
      return lerp(lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
                  lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v), w) * 2 - 1;
    }
    const fbm = (x, y, z) => noise3(x, y, z) * 0.6 + noise3(x * 2.1 + 5, y * 2.1, z * 2.1) * 0.28 + noise3(x * 4.3, y * 4.3 + 9, z * 4.3) * 0.12;
    // tirages de placement : generateur propre a chaque objet (ajouter un objet ne deplace pas les autres)
    const rng = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

    // couleur par sommet (matiere : mousse, ecorce, tuiles) sur un materiau commun
    const VC = new THREE.MeshStandardMaterial({ roughness: 0.9,  vertexColors: true });
    const VC2 = new THREE.MeshStandardMaterial({ roughness: 0.9,  vertexColors: true, side: THREE.DoubleSide });
    function paint(geo, fn) {
      const p = geo.attributes.position, nrm = geo.attributes.normal, col = new Float32Array(p.count * 3);
      const v = new THREE.Vector3(), n = new THREE.Vector3(), c = new THREE.Color();
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); if (nrm) n.fromBufferAttribute(nrm, i); fn(v, n, c); col.set([c.r, c.g, c.b], i * 3); }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return geo;
    }
    // tube effile le long d'une courbe : troncs, branches
    function limb(pts, r0, r1, mat, seg = 20, radial = 10) {
      const curve = new THREE.CatmullRomCurve3(pts);
      const g = new THREE.TubeGeometry(curve, seg, 1, radial, false);
      const p = g.attributes.position, c = new THREE.Vector3(), v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        const ring = Math.floor(i / (radial + 1));
        curve.getPointAt(ring / seg, c);
        v.fromBufferAttribute(p, i).sub(c).multiplyScalar(lerp(r0, r1, ring / seg)).add(c);
        p.setXYZ(i, v.x, v.y, v.z);
      }
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat); m.userData.curve = curve;
      return m;
    }
    const barkPaint = (geo) => paint(geo, (v, n, c) => c.setHex(0x4A3A30).multiplyScalar(0.72 + 0.4 * (0.5 + 0.5 * noise3(v.x * 0.03, v.y * 0.006, v.z * 0.03))));
    // nuage de touffes (pin, cerisier, bambou) : une seule geometrie instanciee, une couleur par touffe
    function clumps(geo, list, mat) {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), col = new THREE.Color();
      list.forEach(({ p, s, r, c }, i) => { q.setFromEuler(e.set(r[0], r[1], r[2])); m4.compose(p, q, s); im.setMatrixAt(i, m4); im.setColorAt(i, col.setHex(c)); });
      return im;
    }
    const mix = (a, b, k) => new THREE.Color(a).lerp(new THREE.Color(b), clamp(k)).getHex();

    // ---------------------------------------------------------------- elements japonais
    const GROUND = -900;
    M.shuDark = PB('red_plaster_weathered', { scale: 1.4, tint: new THREE.Color(1.05, 0.42, 0.26), rough: 0.75, normal: 0.6, clearcoat: 0.6 });
    M.straw = new THREE.MeshStandardMaterial({ color: 0xC9B27C, roughness: 0.95 });
    M.washi = new THREE.MeshStandardMaterial({ color: 0xF7F3EA, roughness: 0.9, side: THREE.DoubleSide });
    M.gold = new THREE.MeshStandardMaterial({ color: 0xC9A04E, metalness: 0.9, roughness: 0.35 });
    M.bronze = new THREE.MeshStandardMaterial({ color: 0x7A6440, metalness: 0.85, roughness: 0.45 });
    M.rock = PB('rock_boulder_dry', { scale: 1.1, tint: 0xd8d4cc, normal: 1.4, moss: { set: A.mossy_rock, amount: 1.8 } });
    M.mound = PB('mossy_rock', { scale: 2.2, tint: new THREE.Color(0.85, 0.95, 0.7), normal: 0.8, moss: { set: A.mossy_rock, amount: 3 } });
    M.step = PB('rock_08', { scale: 1.2, tint: 0xe6e0d6, normal: 1.2 });
    M.roof = PB('grey_roof_tiles_02', { scale: 2.4, tint: 0x8f8f8b, side: THREE.DoubleSide });
    M.pineBark = PB('pine_bark', { scale: 2.2, normal: 1.3 });
    M.sakuraBark = PB('sakura_bark', { scale: 2.2, normal: 1.2 });
    const BARK = M.pineBark;
    M.door = new THREE.MeshStandardMaterial({ roughness: 0.9,  color: 0x5A2E24 });

    // torii myojin : kasagi incurve aux extremites relevees, daiwa, kusabi, gaku, shimenawa et shide
    const bend = (geo, f) => { const p = geo.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + f(p.getX(i))); geo.computeVertexNormals(); return geo; };
    function torii(scale = 1) {
      const g = new THREE.Group();
      const add = (geo, mat, x, y, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
      for (const sx of [-700, 700]) {
        add(new THREE.CylinderGeometry(150, 165, 60, 8), M.stone, sx, 10);                 // kiso
        add(new THREE.CylinderGeometry(76, 80, 180, 28), M.sumi, sx, 90);                  // kamaki
        add(new THREE.TorusGeometry(78, 8, 8, 32), M.sumi, sx, 182).rotation.x = Math.PI / 2;
        add(new THREE.CylinderGeometry(50, 62, 1540, 28), M.shu, sx, 950);                 // hashira, legere conicite
        add(new THREE.CylinderGeometry(64, 58, 60, 28), M.sumi, sx, 1690);                 // daiwa
        for (const s of [-1, 1]) add(new THREE.BoxGeometry(34, 116, 76), M.shuDark, sx + s * 74, 1480);   // kusabi
      }
      add(new THREE.BoxGeometry(1780, 90, 66), M.shu, 0, 1480);                            // nuki
      add(new THREE.BoxGeometry(76, 190, 52), M.shu, 0, 1620);                             // gakuzuka
      add(new THREE.BoxGeometry(170, 250, 34), M.sumi, 0, 1612, 34);                       // gaku
      add(new THREE.BoxGeometry(120, 196, 8), M.gold, 0, 1612, 54);
      add(bend(new THREE.BoxGeometry(1980, 80, 112, 40, 1, 1), (x) => 30 * Math.pow(Math.abs(x) / 990, 2.4)), M.shu, 0, 1745);   // shimaki
      add(bend(new THREE.BoxGeometry(2300, 104, 150, 56, 1, 1), (x) => 150 * Math.pow(Math.abs(x) / 1150, 3.2) + 14 * Math.pow(Math.abs(x) / 1150, 2)), M.sumi, 0, 1838);   // kasagi
      add(bend(new THREE.BoxGeometry(2260, 22, 166, 56, 1, 1), (x) => 150 * Math.pow(Math.abs(x) / 1130, 3.2) + 14 * Math.pow(Math.abs(x) / 1130, 2)), M.sumi, 0, 1896);    // chapeau du kasagi
      // shimenawa : deux torons tresses qui pendent entre les piliers
      const sag = (t) => V3(lerp(-640, 640, t), 1395 - Math.sin(Math.PI * t) * 70, 46);
      for (const ph of [0, Math.PI]) {
        const pts = Array.from({ length: 90 }, (_, k) => { const t = k / 89, a = t * 44 + ph; return sag(t).add(V3(0, Math.cos(a) * 13, Math.sin(a) * 13)); });
        g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 220, 15, 8), M.straw));
      }
      const shide = new THREE.Shape(), off = [0, 16, 0, 16], SW = 32, SH = 52;
      shide.moveTo(off[0] + SW, 0);
      off.forEach((o, k) => { shide.lineTo(o + SW, -SH * k); shide.lineTo(o + SW, -SH * (k + 1)); });
      [...off].reverse().forEach((o, j) => { const k = off.length - 1 - j; shide.lineTo(o, -SH * (k + 1)); shide.lineTo(o, -SH * k); });
      const shideGeo = new THREE.ShapeGeometry(shide);
      for (const t of [0.2, 0.4, 0.6, 0.8]) { const p = sag(t); const m = new THREE.Mesh(shideGeo, M.washi); m.position.set(p.x - 20, p.y - 10, p.z + 18); g.add(m); }
      g.scale.setScalar(scale);
      return g;
    }

    // kasuga-doro : kiso, sao tourne avec sa bague, chudai, hibukuro a six montants, kasa concave, hoju
    function lantern(h = 1) {
      const g = new THREE.Group(), S = M.stone, D = M.stoneDark;
      const add = (geo, mat, y, x = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
      const lathe = (pts, seg) => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg);
      add(new THREE.CylinderGeometry(108, 128, 50, 6), D, 25);
      add(new THREE.CylinderGeometry(80, 102, 30, 6), S, 65);
      add(lathe([[46, 0], [38, 30], [36, 150], [45, 158], [45, 176], [36, 184], [34, 290], [44, 320]], 20), S, 80);
      add(new THREE.CylinderGeometry(98, 60, 60, 6), S, 430);
      add(new THREE.CylinderGeometry(58, 58, 118, 6), M.lamp, 520);
      for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + Math.PI / 6; add(new THREE.BoxGeometry(22, 120, 22), S, 520, Math.cos(a) * 66, Math.sin(a) * 66).rotation.y = -a; }
      add(new THREE.CylinderGeometry(82, 82, 16, 6), S, 586);
      add(new THREE.CylinderGeometry(176, 176, 10, 6), D, 598);
      add(lathe([[178, 0], [150, 20], [112, 44], [64, 78], [26, 108], [0, 116]], 6), D, 602);
      for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; add(new THREE.SphereGeometry(19, 10, 8), D, 618, Math.sin(a) * 178, Math.cos(a) * 178); }   // warabite
      add(lathe([[0, 0], [30, 0], [34, 12], [22, 24], [26, 32], [40, 50], [38, 72], [22, 94], [0, 118]], 16), D, 712);
      g.scale.setScalar(h);
      return g;
    }

    // rocher : surface sculptee par le bruit, assise plate, mousse sur les faces tournees vers le ciel
    function rockGeo(r, seed, mossy = 1, flat = 1) {
      let g = new THREE.IcosahedronGeometry(1, 4);
      g.deleteAttribute('normal'); g.deleteAttribute('uv'); g = mergeVertices(g);
      const p = g.attributes.position, v = new THREE.Vector3();
      const tall = 0.72 + 0.4 * hash(seed, 1, 2);
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const d = fbm(v.x * 1.3 + seed, v.y * 1.3 + seed * 0.7, v.z * 1.3 - seed);
        const strata = Math.abs(noise3(v.x * 2.4 + seed, v.y * 6.5, v.z * 2.4)) * 0.09;     // aretes et strates
        v.multiplyScalar(1 + 0.34 * d - strata);
        v.y = v.y < 0 ? v.y * 0.3 : v.y * tall * flat;
        p.setXYZ(i, v.x * r, v.y * r, v.z * r * 0.92);
      }
      g.computeVertexNormals();
      return paint(g, (v, n, c) => {
        const t = fbm(v.x / r * 3 + seed, v.y / r * 3, v.z / r * 3);
        c.setHex(0x9C958B).multiplyScalar(0.74 + 0.2 * t + 0.14 * clamp(v.y / r + 0.3));
        c.lerp(new THREE.Color(0x63744A), clamp((n.y - 0.62) * 2.6 + 0.7 * t) * mossy);
      });
    }
    // tertre de mousse au contour irregulier
    function mossGeo(span, seed) {
      const g = new THREE.SphereGeometry(1, 64, 10, 0, Math.PI * 2, 0, Math.PI / 2);
      const p = g.attributes.position, v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const a = Math.atan2(v.z, v.x), k = 1 + 0.16 * noise3(Math.cos(a) * 1.7 + seed, Math.sin(a) * 1.7, seed);
        p.setXYZ(i, v.x * span * k, v.y * 46 + 7 * noise3(v.x * 6, seed, v.z * 6), v.z * span * 0.85 * k);
      }
      g.computeVertexNormals();
      return paint(g, (v, n, c) => c.setHex(mix(0x56663C, 0x86915C, 0.5 + 0.6 * fbm(v.x * 0.01, seed, v.z * 0.01))));
    }

    // jardin zen (karesansui) : gravier ratisse, rochers moussus, torii, pagode, lanternes, pin, cerisier, bambous
    const garden = new THREE.Group(); scene.add(garden);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(120000, 120000), M.water);
    water.rotation.x = -Math.PI / 2; water.position.y = GROUND - 60; scene.add(water);
    const BED = 3000;
    const bed = new THREE.Mesh(new THREE.CylinderGeometry(BED, BED + 40, 70, 96), M.gravel);
    bed.position.y = GROUND - 35; bed.receiveShadow = true; scene.add(bed);
    const border = new THREE.Mesh(new THREE.TorusGeometry(BED + 20, 46, 8, 160), M.stoneDark);
    border.rotation.x = Math.PI / 2; border.position.y = GROUND + 2; garden.add(border);

    // groupes de rochers, chacun entoure de cercles ratisses
    const GROUPS = [
      { x: -1350, z: -350, rocks: [[0, 0, 260], [330, 140, 150], [-230, 220, 110]] },
      { x: 1150, z: 900, rocks: [[0, 0, 200], [-260, -90, 120]] },
      { x: 450, z: -1750, rocks: [[0, 0, 170]] },
      { x: -500, z: 1700, rocks: [[0, 0, 140], [210, 60, 90]] },
    ];
    const rakeCircles = [];
    GROUPS.forEach((gp, gi) => {
      const span = gp.rocks.reduce((m, [, , r]) => Math.max(m, r), 0) * 2.1;
      const moss = new THREE.Mesh(mossGeo(span, gi * 3.1), M.mound); moss.position.set(gp.x, GROUND + 2, gp.z); garden.add(moss);
      gp.rocks.forEach(([dx, dz, r], k) => {
        const rock = new THREE.Mesh(rockGeo(r, gi * 7.3 + k * 2.9), M.rock);
        rock.position.set(gp.x + dx, GROUND + 8, gp.z + dz); rock.rotation.y = k * 1.9 + gp.x; garden.add(rock);
      });
      rakeCircles.push({ x: gp.x, z: gp.z, r0: span * 0.75, n: 6 });
    });
    // sillons : cercles autour des groupes, lignes droites ailleurs (coupees pres des cercles)
    const pts = [];
    const RY = GROUND + 1.5, STEP = 70;
    for (const c of rakeCircles) for (let k = 0; k < c.n; k++) {
      const r = c.r0 + k * STEP, segs = 96;
      for (let s = 0; s < segs; s++) {
        const a0 = (s / segs) * 6.2832, a1 = ((s + 1) / segs) * 6.2832;
        pts.push(c.x + Math.cos(a0) * r, RY, c.z + Math.sin(a0) * r, c.x + Math.cos(a1) * r, RY, c.z + Math.sin(a1) * r);
      }
    }
    for (let z = -BED + 60; z < BED - 60; z += STEP) {
      const half = Math.sqrt(BED * BED - z * z) - 40;
      let cuts = rakeCircles
        .filter((c) => Math.abs(z - c.z) < c.r0 + c.n * STEP)
        .map((c) => { const R = c.r0 + c.n * STEP - STEP * 0.5, d = Math.sqrt(Math.max(0, R * R - (z - c.z) ** 2)); return [c.x - d, c.x + d]; })
        .sort((a, b) => a[0] - b[0]);
      let x = -half;
      for (const [a, b] of cuts) { if (a > x) pts.push(x, RY, z, Math.min(a, half), RY, z); x = Math.max(x, b); }
      if (x < half) pts.push(x, RY, z, half, RY, z);
    }
    const rakeGeo = new THREE.BufferGeometry();
    rakeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    scene.add(new THREE.LineSegments(rakeGeo, new THREE.LineBasicMaterial({ color: 0xBDB3A1 })));

    // un torii, face a l'allee, et la pagode dans son axe
    const bigTorii = torii(1.2); bigTorii.position.set(150, GROUND, 2350); garden.add(bigTorii);

    // toit a quatre pans : pans concaves, coins releves, rangs de tuiles peints
    function roofGeo(Wd, Ht) {
      const g = new THREE.PlaneGeometry(Wd, Wd, 28, 28); g.rotateX(-Math.PI / 2);
      const p = g.attributes.position, hw = Wd / 2;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), z = p.getZ(i), m = Math.max(Math.abs(x), Math.abs(z)) / hw, c = Math.min(Math.abs(x), Math.abs(z)) / hw;
        p.setY(i, Ht * Math.pow(1 - m, 1.7) + Ht * 0.42 * Math.pow(m, 5) * Math.pow(c, 2.5));
      }
      g.computeVertexNormals();
      return paint(g, (v, n, c) => {
        const along = Math.abs(v.z) > Math.abs(v.x) ? v.x : v.z, ridge = Math.abs(Math.abs(v.x) - Math.abs(v.z)) < Wd * 0.012;
        c.setHex(ridge ? 0x24211F : 0x3D3936).multiplyScalar(0.82 + 0.22 * (0.5 + 0.5 * Math.sin(along * 0.11)));
      });
    }
    function pagoda() {
      const g = new THREE.Group();
      const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
      add(new THREE.BoxGeometry(1000, 110, 1000), M.stone, 0, 55, 0);
      add(new THREE.BoxGeometry(320, 55, 170), M.stone, 0, 27, 585);
      let y = 110;
      for (const [w, h] of [[620, 200], [570, 175], [520, 160], [470, 148], [420, 138]]) {
        add(new THREE.BoxGeometry(w, h, w), M.wall, 0, y + h / 2, 0);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(new THREE.BoxGeometry(34, h, 34), M.shu, sx * w / 2, y + h / 2, sz * w / 2);
        add(new THREE.BoxGeometry(w + 24, 30, w + 24), M.shu, 0, y + h - 15, 0);
        add(new THREE.BoxGeometry(w + 24, 18, w + 24), M.shu, 0, y + 9, 0);
        for (const [dx, dz, ry] of [[0, 1, 0], [1, 0, Math.PI / 2], [0, -1, 0], [-1, 0, Math.PI / 2]]) {
          add(new THREE.BoxGeometry(w * 0.2, h * 0.58, 8), M.door, dx * (w / 2 + 3), y + h * 0.42, dz * (w / 2 + 3)).rotation.y = ry;
        }
        y += h;
        add(new THREE.BoxGeometry(w + 120, 40, w + 120), M.sumi, 0, y + 10, 0);               // masu (consoles)
        add(roofGeo(w + 400, 135), M.roof, 0, y + 22, 0);
        y += 100;
      }
      add(new THREE.CylinderGeometry(12, 18, 640, 10), M.bronze, 0, y + 320, 0);             // sorin
      add(new THREE.CylinderGeometry(70, 80, 50, 12), M.bronze, 0, y + 30, 0);
      for (let k = 0; k < 9; k++) add(new THREE.CylinderGeometry(46 - k * 2, 46 - k * 2, 12, 16), M.bronze, 0, y + 150 + k * 44, 0);
      add(new THREE.SphereGeometry(30, 14, 10), M.bronze, 0, y + 660, 0);
      return g;
    }
    const tower = pagoda(); tower.position.set(150, GROUND, -150); garden.add(tower);

    // pas japonais (tobi-ishi) du torii a la pagode
    { const R = rng(31);
      for (let k = 0; k < 7; k++) {
        const s = new THREE.Mesh(rockGeo(95 + R() * 40, 40 + k * 3.7, 0.25, 0.28), M.step);
        s.position.set(150 + Math.sin(k * 1.3) * 70, GROUND + 4, 2050 - k * 215); s.rotation.y = R() * 6.28; garden.add(s);
      } }

    // lanternes de pierre
    for (const [x, z] of [[-1900, 1900], [1950, -1300], [-2200, -1500], [2300, 1700], [-150, -2500], [520, 2050], [-220, 2050]]) {
      const l = lantern(Math.abs(x) < 600 ? 0.8 : 1); l.position.set(x, GROUND, z); garden.add(l);
    }

    // pin taille (niwaki) : tronc sinueux, branches, plateaux en nuages de touffes
    function pine() {
      const g = new THREE.Group(), R = rng(7);
      const trunk = limb([V3(0, -40, 0), V3(90, 320, 30), V3(-30, 700, -10), V3(120, 1050, 40), V3(40, 1420, 0), V3(-20, 1700, -20)], 86, 24, BARK, 36, 12);
      barkPaint(trunk.geometry); g.add(trunk);
      const pads = [[-460, 820, 70, 470], [430, 1120, -50, 420], [-300, 1380, 90, 360], [300, 1560, -40, 300], [-10, 1790, 0, 250], [560, 760, -130, 300]];
      const list = [];
      for (const [x, y, z, r] of pads) {
        const from = trunk.userData.curve.getPointAt(clamp((y - 220) / 1740));
        const to = V3(x * 0.88, y - 20, z), mid = from.clone().lerp(to, 0.5).add(V3(0, 70, 0));
        const br = limb([from, mid, to], 30, 12, BARK, 10, 8); barkPaint(br.geometry); g.add(br);
        for (let k = 0; k < 80; k++) {
          const a = R() * 6.2832, rad = Math.sqrt(R()) * r, f = rad / r;
          const s = r * (0.17 + 0.1 * R()) * (1 - 0.35 * f), hy = (1 - f * f) * r * 0.2 + R() * 18;
          list.push({ p: V3(x + Math.cos(a) * rad, y + hy, z + Math.sin(a) * rad * 0.8), s: V3(s, s * 0.5, s), r: [R() * 0.4, R() * 6.28, R() * 0.4],
            c: mix(0x2B442D, 0x5E8249, hy / (r * 0.2) * 0.8 + R() * 0.3) });
        }
      }
      g.add(clumps(new THREE.IcosahedronGeometry(1, 1), list, new THREE.MeshStandardMaterial({ roughness: 0.9,  color: 0xffffff })));
      return g;
    }
    const tree = pine(); tree.position.set(-2150, GROUND, 250); garden.add(tree);

    // cerisier : branches ramifiees, grappes de fleurs, tapis de petales (d'ou tombent les petales animes)
    function sakura() {
      const g = new THREE.Group(), R = rng(11);
      const trunk = limb([V3(0, -40, 0), V3(50, 360, 10), V3(-20, 700, -20), V3(30, 960, 10)], 82, 44, M.sakuraBark, 20, 12);
      barkPaint(trunk.geometry); g.add(trunk);
      const flowers = [];
      const bloom = (at, n, spread) => { for (let k = 0; k < n; k++) {
        const s = 15 + R() * 22;
        flowers.push({ p: at.clone().add(V3((R() - 0.5) * spread * 2, (R() - 0.35) * spread * 1.2, (R() - 0.5) * spread * 2)), s: V3(s, s * 0.8, s),
          r: [R() * 6.28, R() * 6.28, 0], c: [0xF2C9CF, 0xE8AEB7, 0xF7DDE0, 0xDC9BA8, 0xF4D3D3][Math.floor(R() * 5)] });
      } };
      function branch(from, dir, len, r, depth) {
        const end = from.clone().addScaledVector(dir, len);
        const mid = from.clone().lerp(end, 0.5).add(V3((R() - 0.5) * len * 0.25, len * 0.1, (R() - 0.5) * len * 0.25));
        const b = limb([from, mid, end], r, r * 0.62, M.sakuraBark, 8, 8); barkPaint(b.geometry); g.add(b);
        if (depth === 0) { bloom(end, 130, 210); return; }
        bloom(end, 45, 170);
        for (let k = 0; k < (depth === 2 ? 3 : 2); k++) branch(end, dir.clone().add(V3((R() - 0.5) * 1.2, R() * 0.45, (R() - 0.5) * 1.2)).normalize(), len * 0.66, r * 0.6, depth - 1);
      }
      for (let k = 0; k < 5; k++) { const a = k * 1.2566 + 0.3; branch(V3(30, 940, 10), V3(Math.cos(a) * 0.95, 0.7, Math.sin(a) * 0.75).normalize(), 520, 36, 2); }
      g.add(clumps(new THREE.IcosahedronGeometry(1, 2), flowers, new THREE.MeshStandardMaterial({ roughness: 0.85, color: 0xffffff })));
      // petales tombes, portes vers l'ouest comme ceux qui volent
      const fallen = [];
      for (let k = 0; k < 420; k++) {
        const a = R() * 6.28, rad = Math.sqrt(R()) * 1000;
        fallen.push({ p: V3(Math.cos(a) * rad * 1.3 - 250, 3 + R() * 2, Math.sin(a) * rad), s: V3(30, 20, 1), r: [-Math.PI / 2 + (R() - 0.5) * 0.3, 0, R() * 6.28],
          c: [0xEBC0BA, 0xF2D0CB, 0xE3AFAA][Math.floor(R() * 3)] });
      }
      g.add(clumps(new THREE.PlaneGeometry(1, 1), fallen, new THREE.MeshStandardMaterial({ roughness: 0.9,  color: 0xffffff, side: THREE.DoubleSide })));
      return g;
    }
    const cherry = sakura(); cherry.position.set(1900, GROUND, -400); garden.add(cherry);

    // bosquet de bambous, en lisiere
    function bamboo() {
      const g = new THREE.Group(), R = rng(23), leaves = [];
      for (let k = 0; k < 13; k++) {
        const x = (R() - 0.5) * 600, z = (R() - 0.5) * 440, h = 1250 + R() * 550, r = 15 + R() * 8;
        const culm = new THREE.Group(); culm.position.set(x, 0, z); culm.rotation.set((R() - 0.5) * 0.09, 0, (R() - 0.5) * 0.09);
        const tone = new THREE.MeshStandardMaterial({ roughness: 0.9,  color: [0x7F9A50, 0x8DA65B, 0x6E8A45][k % 3] });
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.75, r, h, 10), tone); stem.position.y = h / 2; culm.add(stem);
        for (let y = 200; y < h - 80; y += 210 + R() * 50) { const n = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.12, r * 1.12, 12, 10), M.moss); n.position.y = y; culm.add(n); }
        culm.updateMatrixWorld(true);
        for (let j = 0; j < 40; j++) {
          const y = h * (0.5 + R() * 0.52), a = R() * 6.28, d = 30 + R() * 190;
          const p = V3(Math.cos(a) * d, y, Math.sin(a) * d).applyMatrix4(culm.matrix);
          leaves.push({ p, s: V3(80, 9, 22), r: [0, a, -0.5 - R() * 0.6], c: mix(0x5E7A3A, 0x9AAE63, R()) });
        }
        g.add(culm);
      }
      g.add(clumps(new THREE.IcosahedronGeometry(1, 0), leaves, new THREE.MeshStandardMaterial({ roughness: 0.9,  color: 0xffffff, flatShading: true })));
      return g;
    }
    const grove = bamboo(); grove.position.set(-2450, GROUND, -800); garden.add(grove);

    // tout le jardin porte et recoit l'ombre du soleil
    garden.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

    // anneaux enso, au-dessus du jardin (ils ne traversent plus les slides)
    const ensos = [
      { r: 3600, tube: 20, arc: 5.55, color: 0x24211F, y: 2900, tilt: 0.05, speed: 0.04 },
      { r: 4100, tube: 12, arc: 4.6, color: 0xC9402E, y: 3500, tilt: -0.08, speed: -0.028 },
    ].map((e) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(e.r, e.tube, 10, 220, e.arc), new THREE.MeshStandardMaterial({ roughness: 0.9,  color: e.color }));
      const pivot = new THREE.Group(); pivot.position.y = e.y; pivot.rotation.z = e.tilt;
      m.rotation.x = Math.PI / 2; pivot.add(m); scene.add(pivot);
      return { pivot, ...e };
    });
    // mont Fuji (profil concave, sommet tronque enneige) et soleil, au lavis
    const FX = -4000, FZ = -52000, FB = GROUND - 60, FR = 25000, FH = 15000;
    const fujiProfile = (steps) => Array.from({ length: steps + 1 }, (_, k) => {
      const u = k / steps;                                     // 0 : pied, 1 : cratere
      return new THREE.Vector2(FR * (0.08 + 0.92 * Math.pow(1 - u, 1.55)), FH * u);
    });
    // ravines : le lavis n'est pas eclaire, ce sont les couleurs par sommet qui dessinent le relief
    const gully = (phi) => Math.pow(0.5 + 0.5 * Math.sin(phi * 38 + 2.5 * Math.sin(phi * 9)), 3);
    const fujiGeo = paint(new THREE.LatheGeometry(fujiProfile(60), 240), (v, n, c) => {
      const u = v.y / FH, phi = Math.atan2(v.x, v.z);
      c.setHex(0xA9A9A6).multiplyScalar(1 - 0.13 * gully(phi) * clamp((u - 0.12) / 0.5)).lerp(new THREE.Color(0xC9C6BC), (1 - u) * 0.3);
    });
    const fuji = new THREE.Mesh(fujiGeo, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
    fuji.position.set(FX, FB, FZ); scene.add(fuji);
    const SNOWLINE = 0.68;                                        // la neige couvre le tiers superieur
    const capPts = fujiProfile(60).filter((p) => p.y >= FH * SNOWLINE).map((p) => new THREE.Vector2(p.x + 50, p.y - FH * SNOWLINE));
    const capGeo = new THREE.LatheGeometry(capPts, 240);
    { // langues de neige qui descendent dans les ravines : le bord bas glisse le long du profil
      const p = capGeo.attributes.position, radiusAt = (u) => FR * (0.08 + 0.92 * Math.pow(1 - u, 1.55)) + 50;
      for (let i = 0; i < p.count; i++) {
        if (p.getY(i) > 1) continue;
        const phi = Math.atan2(p.getX(i), p.getZ(i)), drop = FH * (0.03 + 0.11 * gully(phi + 0.04));
        const r = radiusAt(SNOWLINE - drop / FH);
        p.setXYZ(i, Math.sin(phi) * r, -drop, Math.cos(phi) * r);
      }
    }
    const cap = new THREE.Mesh(capGeo, new THREE.MeshBasicMaterial({ color: 0xE1E6EB, fog: false, side: THREE.DoubleSide }));
    cap.position.set(FX, FB + FH * SNOWLINE + 4, FZ); scene.add(cap);
    const sunDisk = new THREE.Mesh(new THREE.CircleGeometry(3300, 64), new THREE.MeshBasicMaterial({ color: 0xE27B63, fog: false }));
    sunDisk.position.set(9000, 9800, -60000); sunDisk.lookAt(0, 0, 0); scene.add(sunDisk);

    // vallees : trois chaines de cretes en anneau, au lavis : crete accidentee, sombre en haut, fondue
    // dans la brume en bas ; des cedres en silhouette sur les deux plus proches
    const RIDGES = [
      { R: 21000, amp: 2600, base: 900, color: 0xB0AE9A, seed: 1.3, trees: 1 },
      { R: 29000, amp: 3600, base: 1500, color: 0xC8C3B2, seed: 4.1, trees: 0.7 },
      { R: 38000, amp: 5200, base: 2200, color: 0xDCD6C9, seed: 7.7, trees: 0 },
    ];
    const SEGS = 1440, FUJI_A = Math.atan2(FX, FZ), PAPER_C = new THREE.Color(PAPER);
    const BASIC_VC = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
    RIDGES.forEach(({ R, amp, base, color, seed, trees }) => {
      const pos = [], col = [], idx = [], crest = [];
      const top = new THREE.Color(color).multiplyScalar(0.93), mid = new THREE.Color(color).lerp(PAPER_C, 0.3), low = new THREE.Color(color).lerp(PAPER_C, 0.8);
      for (let k = 0; k <= SEGS; k++) {
        const ang = (k / SEGS) * Math.PI * 2;
        let n = 0.5 * Math.sin(ang * 3 + seed) + 0.3 * Math.sin(ang * 7 + seed * 2) + 0.2 * Math.sin(ang * 17 + seed * 3);
        n += 0.12 * fbm(Math.cos(ang) * 9 + seed, Math.sin(ang) * 9, seed) + 0.035 * noise3(Math.cos(ang) * 60, Math.sin(ang) * 60, seed);   // crete accidentee
        n -= Math.max(0, Math.cos(ang - FUJI_A) - 0.93) * 16;   // la vallee s'ouvre face au Fuji
        const h = Math.max(120, base + amp * (0.5 + 0.5 * n));
        const x = Math.sin(ang) * R, z = Math.cos(ang) * R;
        pos.push(x, FB, z, x, FB + h * 0.55, z, x, FB + h, z);
        col.push(low.r, low.g, low.b, mid.r, mid.g, mid.b, top.r, top.g, top.b);
        crest.push([x, h, z, ang]);
        if (k < SEGS) { const i = k * 3; idx.push(i, i + 1, i + 3, i + 1, i + 4, i + 3, i + 1, i + 2, i + 4, i + 2, i + 5, i + 4); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
      scene.add(new THREE.Mesh(g, BASIC_VC));
      if (!trees) return;
      const R2 = rng(Math.round(seed * 100)), list = [];
      crest.forEach(([x, h, z], k) => {
        if (k % 2 || noise3(k * 0.05, seed, 0) < -0.15 || h < base * 0.6) return;
        const th = (260 + R2() * 380) * trees, tw = th * 0.32;
        list.push({ p: V3(x, FB + h + th * 0.35 - 40, z), s: V3(tw, th, tw), r: [0, R2() * 6.28, 0], c: top.clone().multiplyScalar(0.94 + R2() * 0.05).getHex() });
      });
      scene.add(clumps(new THREE.ConeGeometry(1, 1, 5), list, new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false })));
    });
    [[16500, 25000, 650, 0.5], [25000, 33500, 1250, 0.42]].forEach(([r0, r1, y, o]) => {
      const mist = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 128), new THREE.MeshBasicMaterial({ color: PAPER, transparent: true, opacity: o, fog: false, side: THREE.DoubleSide, depthWrite: false }));
      mist.rotation.x = -Math.PI / 2; mist.position.y = FB + y; scene.add(mist);
    });

    // nuages : trainees d'encre diluee, peintes une fois sur un canvas, qui derivent devant les montagnes
    const cloudTex = (() => {
      const c = document.createElement('canvas'); c.width = 1024; c.height = 160;
      const g = c.getContext('2d'), R = rng(5);
      for (let k = 0; k < 26; k++) {
        const x = 120 + R() * 780, y = 50 + R() * 60, w = 140 + R() * 300, h = 14 + R() * 26;
        const gr = g.createRadialGradient(x, y, 0, x, y, w);
        gr.addColorStop(0, `rgba(172,166,154,${0.08 + R() * 0.07})`); gr.addColorStop(1, 'rgba(172,166,154,0)');
        g.fillStyle = gr; g.save(); g.translate(x, y); g.scale(1, h / w); g.translate(-x, -y);
        g.beginPath(); g.arc(x, y, w, 0, Math.PI * 2); g.fill(); g.restore();
      }
      // masque : les quatre bords fondent a zero, aucune trainee n'est coupee net
      g.globalCompositeOperation = 'destination-in';
      const fx = g.createLinearGradient(0, 0, c.width, 0); fx.addColorStop(0, 'rgba(0,0,0,0)'); fx.addColorStop(0.25, '#000'); fx.addColorStop(0.75, '#000'); fx.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = fx; g.fillRect(0, 0, c.width, c.height);
      const fy = g.createLinearGradient(0, 0, 0, c.height); fy.addColorStop(0, 'rgba(0,0,0,0)'); fy.addColorStop(0.35, '#000'); fy.addColorStop(0.65, '#000'); fy.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = fy; g.fillRect(0, 0, c.width, c.height);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const CLOUDS = Array.from({ length: 12 }, (_, k) => {
      const R = rng(100 + k);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, opacity: 0.45 + R() * 0.3, fog: false, depthWrite: false }));
      m.scale.set(11000 + R() * 9000, 1500 + R() * 900, 1); m.renderOrder = 1; scene.add(m);
      return { m, a: k * 0.52 + R() * 0.3, r: 26000 + R() * 8000, y: FB + 4800 + R() * 4200, sp: 0.0015 + R() * 0.0015 };
    });

    // vol de grues : un V qui tourne lentement autour de l'ile, battement d'ailes fonction de t
    const wingGeo = new THREE.BufferGeometry().setFromPoints([V3(0, 0, -18), V3(0, 0, 22), V3(130, 10, 4)]);
    const BIRD_M = new THREE.MeshBasicMaterial({ color: 0x2E2A27, side: THREE.DoubleSide, fog: false });
    const BIRDS = Array.from({ length: 7 }, (_, k) => {
      const b = new THREE.Group(), l = new THREE.Mesh(wingGeo, BIRD_M), r = new THREE.Mesh(wingGeo, BIRD_M);
      r.scale.x = -1; b.add(l, r, new THREE.Mesh(new THREE.BoxGeometry(14, 12, 70), BIRD_M));
      b.scale.setScalar(1.9); scene.add(b);
      const row = Math.ceil(k / 2), side = k % 2 ? 1 : -1;
      return { b, l, r, back: row * 480, lat: k ? side * row * 420 : 0, ph: k * 0.9 };
    });

    // ondes sur l'eau : des cercles naissent au bord de l'ile et s'effacent en s'eloignant
    const ringGeo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 256 }, (_, k) => V3(Math.cos(k / 256 * 6.2832), 0, Math.sin(k / 256 * 6.2832))));
    const RIPPLES = Array.from({ length: 7 }, (_, k) => {
      const m = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: 0xB8AE9C, transparent: true }));
      m.position.y = GROUND - 58; scene.add(m); return { m, k };
    });

    function updateSky(t) {
      CLOUDS.forEach((c) => {
        const a = c.a + t * c.sp;
        c.m.position.set(Math.sin(a) * c.r, c.y, Math.cos(a) * c.r); c.m.lookAt(0, c.y, 0);
      });
      const fa = t * 0.045 + 0.66,   // cale pour traverser le plan de conclusion
        FR2 = 9500, fy = GROUND + 4700 + Math.sin(t * 0.3) * 200;
      const head = V3(Math.sin(fa) * FR2, fy, Math.cos(fa) * FR2), fwd = V3(Math.cos(fa), 0, -Math.sin(fa)), side = V3().crossVectors(fwd, UP);
      BIRDS.forEach((d) => {
        d.b.position.copy(head).addScaledVector(fwd, -d.back).addScaledVector(side, d.lat);
        d.b.position.y += Math.sin(t * 0.9 + d.ph) * 40;
        d.b.lookAt(d.b.position.clone().add(fwd));
        const flap = Math.sin(t * 5.5 + d.ph) * 0.55;
        d.l.rotation.z = flap; d.r.rotation.z = -flap;
      });
      RIPPLES.forEach(({ m, k }) => {
        const f = ((t * 0.035 + k / RIPPLES.length) % 1);
        m.scale.setScalar(3150 + f * 5200);
        m.material.opacity = 0.5 * (1 - f) * Math.min(1, f * 8);
      });
    }
    // petales : ils partent du cerisier et derivent sur le jardin
    const PETALS = 260;
    const petals = new THREE.InstancedMesh(new THREE.PlaneGeometry(34, 22), new THREE.MeshBasicMaterial({ color: 0xE8B8B2, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }), PETALS);
    const pd = Array.from({ length: PETALS }, () => ({ ox: (Math.random() - 0.5) * 1400, oz: (Math.random() - 0.5) * 1000, drift: 0.4 + Math.random() * 1.6, ph: Math.random() * 30, sp: 0.6 + Math.random() * 0.6, sw: Math.random() * 6.28, rot: Math.random() * 6.28 }));
    scene.add(petals);
    const dummy = new THREE.Object3D();
    function updatePetals(t) {
      pd.forEach((p, i) => {
        const life = ((p.ph + t * p.sp * 0.12) % 1);                 // 0 -> 1 : du houppier au sol
        const x = 1900 + p.ox - life * 3800 * p.drift * 0.6 + Math.sin(t * 0.8 + p.sw) * 120;
        const z = -400 + p.oz + Math.cos(t * 0.5 + p.sw) * 140 + life * 900;
        dummy.position.set(x, GROUND + 1700 - life * 1700, z);
        dummy.rotation.set(t * 1.1 + p.rot, t * 0.7 + p.rot * 2, t * 0.4);
        dummy.updateMatrix(); petals.setMatrixAt(i, dummy.matrix);
      });
      petals.instanceMatrix.needsUpdate = true;
    }

  return {
    scene,
    update(t) {
      ensos.forEach((e) => { e.pivot.rotation.y = t * e.speed; });
      updatePetals(t);
      updateSky(t);
    },
  };
}
