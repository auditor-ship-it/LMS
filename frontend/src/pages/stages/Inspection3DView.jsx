import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { isFaultStatus } from './stageFields.js';
import crystalLogoUrl from '../../assets/inspection3d/crystal-logo.png';
import styles from './Inspection3DView.module.css';

/**
 * The real, live-data version of the standalone 3D inspection preview —
 * explicit request 2026-11-17 ("inspection ke liye maine 360 banaya tha na
 * woh stage 4 mai details jaise hi file karenge na tho mera dry and refer
 * ka woh jana chahiye hai... check damage raha tho image woh hai na mujhe
 * mere iske niche dikhne chahiye hai"). Same Three.js model validated in
 * that preview (brand navy/white, ISO dimensions, corrugated dry vs plain
 * reefer skin, the full Thermo-King-style machine end) — ported here
 * verbatim, but:
 *
 *  - Container type comes from the REAL record (`containerType`, the
 *    Deployed sheet's own Type column), not a toggle — a Dry container
 *    always renders the dry shell, a Reefer always gets the machine.
 *  - Markers are placed on the REAL 12 Inspection Checklist points and 14
 *    Machine Check points (stageFields.js's INSPECTION_POINTS/
 *    MACHINE_POINTS), not the standalone preview's smaller sample set —
 *    see MARKER_POSITIONS below.
 *  - A marker's colour comes from the ACTUAL condition just picked on the
 *    form below it (`values[row.status.key]`), live, not sample data —
 *    green while Good/OK, red the moment Damage (or any fault wording) is
 *    selected, grey until a choice is made at all.
 *
 * Marker placement for items with no single obvious physical part (the
 * machine's internal checks — Refrigerant Gas Charge, Temperature Sensors,
 * Defrost System, Motor Condition, Contractor, ISO Plug, Cable 4 Core) is a
 * reasonable visual approximation clustered around the real part they test
 * (coil / controller / compressor / copper lines), not an engineering-exact
 * position — there is no distinct visible 3D part for some of these to sit
 * on. Good enough to orient an inspector; not a wiring diagram.
 */

const NAVY = '#0F2854', WHITE_BODY = '#f3f6fa';
const C_GALV = 0xA3ABB5, C_GRILLE = 0xE4E7EB, C_GASKET = 0x15171A,
  C_CASING = 0xDDE2E6, C_COPPER = 0xB87333, C_CABLE = 0xE9ECEE,
  C_MACHINE = 0xC8CDD2, C_FRAME = 0x2c3138, C_DARK = 0x202328, C_COIL = 0x6b7177;

const DATA_DRY = {
  S: 6.06, W: 2.44, H: 2.59, intL: 5.90, intW: 2.33, intH: 2.39,
  body: NAVY, door: NAVY, logoTint: '#FFFFFF', machine: false, floor: 'wood', corrugated: true
};
const DATA_REEFER = {
  S: 12.19, W: 2.44, H: 2.90, intL: 11.50, intW: 2.29, intH: 2.31,
  body: WHITE_BODY, door: WHITE_BODY, logoTint: '#15181b', machine: true, floor: 'tbar', corrugated: false
};

/** Every real checklist item -> its [x,y,z] on the model, derived from the
 *  SAME geometry formulas buildContainer() below uses to place the actual
 *  parts — a marker always lands on (or right beside) the thing it names. */
function buildMarkerPositions(d) {
  const S = d.S, W = d.W, H = d.H, intL = d.intL, intH = d.intH;
  const base = 0.17, roofT = 0.1;
  const floorTop = base + 0.04;
  const wallH = H - base - roofT - 0.02;
  const A = -S / 2;
  const pos = {};

  pos['Outside / Undercarriage'] = [0, 0.09, 0];
  pos['Inside and Outside Doors'] = [S / 2 + 0.06, 1.3, -0.65];
  pos['Right Side'] = [S * 0.15, base + wallH / 2, W / 2 + 0.04];
  pos['Left Side'] = [-S * 0.15, base + wallH / 2, -W / 2 - 0.04];
  pos['Ceiling / Roof'] = [S * 0.1, H + 0.04, 0];
  pos['Floor (Inside)'] = [S * 0.2, floorTop + 0.05, 0.3];
  pos['Contamination'] = [-S * 0.15, 1.0, -0.4];
  pos['Gasket Door'] = [S / 2 + 0.06, 1.3, 0.9];

  if (d.machine) {
    const X = H - 0.95, Ke = H - 0.02;
    const b = (S / 2 - 0.1) - intL, ne = Math.max(A + 0.3, b - 0.17);
    const he = 0.75 + (X - 0.75) / 2;
    const Ze = ne - A;

    pos['Front Wall'] = [A + Ze / 2, X + (Ke - X) / 2, 0];
    pos.Curtain = [S / 2 - 0.35, floorTop + (intH - 0.1) / 2, 0];
    pos['Tube Light'] = [b + intL * 0.5, H - 0.03, 0];
    pos.Mantrap = [S / 2 - 0.3, floorTop + 0.1, 0.35];

    pos.Compressor = [ne - 0.2, 0.42, -0.55];
    pos['Condenser Coil'] = [ne - 0.05, (0.75 + X) / 2, 0.98];
    pos['Evaporator Coil'] = [b + 0.02, floorTop + intH - 0.14, 0];
    pos['Condenser Fan'] = [A - 0.06, he, 0.42];
    pos['Evaporator Fan'] = [b + 0.08, floorTop + intH * 0.55, 0.2];
    pos['Controller / Microprocessor'] = [A - 0.02, 1.32, -0.62];
    pos['Power Cable & Plug'] = [ne - 0.12, 0.43, 0.68];
    pos['Refrigerant Gas Charge'] = [ne - 0.08, 0.78, -0.3];
    pos['Temperature Sensors / Probes'] = [b + 0.15, floorTop + intH * 0.5, -0.3];
    pos['Defrost System'] = [b + 0.02, floorTop + intH - 0.04, 0.25];
    pos['Cable 4 Core 4mm 18Mtr'] = [ne - 0.08, 1.08, -0.13];
    pos['Motor Condition'] = [A + 0.14, he, 0.58];
    pos.Contractor = [A + 0.17, 0.95, -0.62];
    pos['ISO Plug'] = [ne - 0.15, 0.2, 0.68];
  } else {
    pos['Front Wall'] = [A + 0.035, base + wallH / 2, 0];
  }
  return pos;
}

/* ---------- canvas texture helpers (ported as-is) ---------- */
function cv(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function ribNormal(ribs, repX, repY) {
  const w = 512, h = 8;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'), img = ctx.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    const nx = Math.sin((x / w) * Math.PI * 2 * ribs);
    const r = Math.round((nx * 0.5 + 0.5) * 255);
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      img.data[i] = r; img.data[i + 1] = 128; img.data[i + 2] = 235; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repX || 1, repY || 1);
  return t;
}
function paintTex(color) {
  return cv(256, 256, (x, w, h) => {
    x.fillStyle = color; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(0,0,0,0.04)';
    for (let i = 0; i < 140; i++) x.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  });
}
function aluTex() {
  return cv(512, 256, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#c9d1d8'); g.addColorStop(0.5, '#dde3e9'); g.addColorStop(1, '#bcc5cd');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.strokeStyle = 'rgba(255,255,255,0.35)'; x.lineWidth = 1;
    for (let i = 0; i < 90; i++) { const yy = Math.random() * h; x.beginPath(); x.moveTo(0, yy); x.lineTo(w, yy); x.stroke(); }
    x.strokeStyle = 'rgba(0,0,0,0.10)';
    for (let j = 0; j < 60; j++) { const yy = Math.random() * h; x.beginPath(); x.moveTo(0, yy); x.lineTo(w, yy); x.stroke(); }
  });
}
function tbarTex(repeat) {
  const t = cv(64, 512, (x, w, h) => {
    x.fillStyle = '#8f979e'; x.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 26) {
      x.fillStyle = '#b4bcc3'; x.fillRect(0, y, w, 17);
      x.fillStyle = 'rgba(255,255,255,0.45)'; x.fillRect(0, y, w, 3);
      x.fillStyle = 'rgba(0,0,0,0.42)'; x.fillRect(0, y + 17, w, 9);
    }
    x.fillStyle = 'rgba(0,0,0,0.05)';
    for (let i = 0; i < 70; i++) x.fillRect(Math.random() * w, Math.random() * h, 10, 2);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, repeat || 8);
  return t;
}
function woodTex(repeat) {
  const t = cv(128, 512, (x, w, h) => {
    x.fillStyle = '#c79d6b'; x.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 42) {
      x.fillStyle = Math.random() > 0.5 ? '#b88a52' : '#e2c79f';
      x.fillRect(0, y, w, 40);
      x.strokeStyle = '#5c4126'; x.lineWidth = 1.5;
      x.beginPath(); x.moveTo(0, y + 41); x.lineTo(w, y + 41); x.stroke();
    }
    x.strokeStyle = 'rgba(92,65,38,0.25)'; x.lineWidth = 1;
    for (let i = 0; i < 120; i++) { const yy = Math.random() * h; x.beginPath(); x.moveTo(0, yy); x.lineTo(w, yy); x.stroke(); }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, repeat || 6);
  return t;
}
function roofTex(color, repeat) {
  const t = cv(64, 256, (x, w, h) => {
    x.fillStyle = color; x.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 18) {
      x.fillStyle = 'rgba(0,0,0,0.16)'; x.fillRect(0, y, w, 4);
      x.fillStyle = 'rgba(255,255,255,0.14)'; x.fillRect(0, y + 4, w, 3);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, repeat || 10);
  return t;
}
function displayTex() {
  return cv(256, 110, (x, w, h) => {
    x.fillStyle = '#0b0d10'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#ffb21a';
    x.font = 'bold 64px "Courier New", monospace';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('-18.0°C', w / 2, h / 2 + 2);
  });
}
function cautionTex() {
  return cv(256, 160, (x, w, h) => {
    x.fillStyle = '#f5c400'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#111';
    x.font = '800 44px Inter, sans-serif'; x.textAlign = 'center';
    x.fillText('CAUTION', w / 2, 62);
    x.fillRect(24, 84, w - 48, 6); x.fillRect(24, 104, w - 80, 6); x.fillRect(24, 124, w - 64, 6);
  });
}
function plateTex(rows) {
  return cv(400, 470, (x, w, h) => {
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#111'; x.lineWidth = 10; x.strokeRect(5, 5, w - 10, h - 10);
    x.fillStyle = '#111'; x.font = '700 38px Inter, sans-serif';
    rows.forEach((r, i) => {
      const y = 80 + i * 120;
      x.textAlign = 'left'; x.fillText(r[0], 30, y);
      x.textAlign = 'right'; x.fillText(r[1], w - 30, y + 46);
      x.fillRect(30, y + 66, w - 60, 3);
    });
  });
}

function mat(o) { return new THREE.MeshStandardMaterial(o); }

export function Inspection3DView({ containerType, checklists, values }) {
  const holderRef = useRef(null);
  const stageRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const [preset, setPreset] = useState('reset');
  const [doorsOpen, setDoorsOpen] = useState(false);

  /* Three.js state that outlives renders — this scene is imperative, not
     declarative; React only owns the mount point and the marker DOM. */
  const three = useRef({}).current;

  const isReefer = /reefer/i.test(containerType || '');
  const d = isReefer ? DATA_REEFER : DATA_DRY;

  /* The real rows actually on the form right now (reeferOnly ones already
     absent for a Dry container, same filtering the form itself applies) —
     one marker per row that has a known 3D position. */
  const rows = (checklists || []).flatMap((c) => (c.rows || []).map((r) => ({ ...r, group: c.group })));
  const markerPositions = buildMarkerPositions(d);
  const markerRows = rows.filter((r) => markerPositions[r.item]);

  /* ---- one-time Three.js setup / teardown ---- */
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return undefined;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, holder.clientWidth / Math.max(holder.clientHeight, 1), 0.05, 200);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(holder.clientWidth, holder.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    holder.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.enablePan = false;

    scene.add(new THREE.HemisphereLight(0xdfeaf7, 0x55606b, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(9, 13, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -12, right: 12, top: 10, bottom: -6, near: 1, far: 45 });
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbcd8f5, 0.55);
    rim.position.set(-10, 5, -8);
    scene.add(rim);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(26, 56), new THREE.ShadowMaterial({ opacity: 0.22 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    Object.assign(three, {
      scene, camera, renderer, controls,
      group: null, doorL: null, doorR: null, interiorLights: [], fanSpin: null,
      doorOpen: 0, doorTarget: 0, logoTex: null,
      raycaster: new THREE.Raycaster(), occFrame: 0,
      markerEls: new Map(), // item -> {el, vec3}
      rafId: null, disposed: false
    });

    const onResize = () => {
      const w = holder.clientWidth, h = holder.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(holder);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (three.disposed) return;
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      x.globalCompositeOperation = 'source-in';
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, c.width, c.height);
      three.logoTex = new THREE.CanvasTexture(c);
      three.logoTex.colorSpace = THREE.SRGBColorSpace;
      three.logoTex.anisotropy = 8;
      setLoaded(true);
    };
    img.onerror = () => setLoaded(true);
    img.src = crystalLogoUrl;

    const animate = () => {
      if (three.disposed) return;
      three.rafId = requestAnimationFrame(animate);
      controls.update();
      three.doorOpen += (three.doorTarget - three.doorOpen) * 0.07;
      applyDoor(three);
      if (three.fanSpin) three.fanSpin.rotation.x += 0.04;
      renderer.render(scene, camera);
      projectMarkers(three, stageRef.current, camera);
    };
    animate();

    return () => {
      three.disposed = true;
      if (three.rafId) cancelAnimationFrame(three.rafId);
      window.removeEventListener('resize', onResize);
      resizeObserver.disconnect();
      disposeGroup(three);
      renderer.dispose();
      if (renderer.domElement?.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- rebuild the container whenever its TYPE changes (or once loaded) ---- */
  useEffect(() => {
    if (!loaded || !three.scene) return;
    buildContainer(three, d);
    applyPreset(three, 'reset', d);
    setPreset('reset');
    three.doorTarget = 0;
    setDoorsOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, isReefer]);

  /* ---- marker DOM: rebuilt whenever the set of real rows changes ---- */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !three.scene) return;
    stage.querySelectorAll(`.${styles.marker}`).forEach((m) => m.remove());
    three.markerEls = new Map();
    markerRows.forEach((r) => {
      const p = markerPositions[r.item];
      const el = document.createElement('div');
      el.className = styles.marker;
      el.title = r.item;
      el.textContent = String(r.n);
      el.addEventListener('click', () => {
        const row = document.getElementById(`insp3d-row-${r.status.key}`);
        if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
      stage.appendChild(el);
      three.markerEls.set(r.item, { el, vec3: new THREE.Vector3(p[0], p[1], p[2]) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, isReefer, markerRows.map((r) => r.item).join('|')]);

  /* ---- marker colour: live off the real form, cheap, no rebuild ---- */
  useEffect(() => {
    markerRows.forEach((r) => {
      const m = three.markerEls.get(r.item);
      if (!m) return;
      const status = String(values?.[r.status.key] || '').trim();
      m.el.classList.remove(styles.markerGood, styles.markerDamage, styles.markerUnset);
      m.el.classList.add(!status ? styles.markerUnset : isFaultStatus(status) ? styles.markerDamage : styles.markerGood);
    });
  });

  const goPreset = (name) => { applyPreset(three, name, d); setPreset(name); };
  const toggleDoors = () => {
    const next = !doorsOpen;
    three.doorTarget = next ? 1 : 0;
    setDoorsOpen(next);
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <h3 className={styles.title}>{isReefer ? 'Reefer Container' : 'Dry Container'} — 360° Model</h3>
        <span className={styles.sub}>{isReefer ? '40 FT · High Cube · Refrigerated' : '20 FT · General Purpose'}</span>
      </div>
      <div className={styles.controls}>
        <button type="button" className={preset === 'reset' ? styles.active : ''} onClick={() => goPreset('reset')}>Reset view</button>
        {isReefer && <button type="button" className={preset === 'machine' ? styles.active : ''} onClick={() => goPreset('machine')}>Machine end</button>}
        <button type="button" className={preset === 'door' ? styles.active : ''} onClick={() => goPreset('door')}>Door end</button>
        <button type="button" className={preset === 'inside' ? styles.active : ''} onClick={() => goPreset('inside')}>Step inside</button>
        <button type="button" className={doorsOpen ? styles.active : ''} onClick={toggleDoors}>{doorsOpen ? 'Close doors' : 'Open doors'}</button>
      </div>
      <div className={styles.stage} ref={stageRef}>
        {!loaded && <div className={styles.loading}>Loading 360° view…</div>}
        <div className={styles.holder} ref={holderRef} />
        <div className={styles.hint}>Drag to rotate · scroll to zoom · click a marker to jump to its row</div>
      </div>
      <div className={styles.legend}>
        <span><span className={`${styles.dot} ${styles.dotGood}`} />Good</span>
        <span><span className={`${styles.dot} ${styles.dotDamage}`} />Damage</span>
        <span><span className={`${styles.dot} ${styles.dotUnset}`} />Not checked yet</span>
      </div>
    </div>
  );
}

function applyDoor(three) {
  const a = three.doorOpen * Math.PI * 0.62;
  if (three.doorR) three.doorR.rotation.y = -a;
  if (three.doorL) three.doorL.rotation.y = a;
}

function disposeGroup(three) {
  if (!three.group) return;
  three.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) [].concat(o.material).forEach((m) => m?.dispose?.());
  });
  three.scene.remove(three.group);
  three.group = null;
}

function buildContainer(three, d) {
  disposeGroup(three);
  three.interiorLights = [];
  three.fanSpin = null;
  three.doorL = null;
  three.doorR = null;
  const group = new THREE.Group();
  three.scene.add(group);
  three.group = group;

  const { S, W, H, intW, intH, intL } = d;
  const ae = 0.13, base = 0.17, floorTop = base + 0.04, roofT = 0.1;
  const ceil = H - 0.02 - roofT;
  const A = -S / 2;
  const D = W / 2 - ae;
  const doorH = H - base - 0.2;

  const corr = d.corrugated;
  const mPaintPlain = mat({ map: paintTex(d.body), roughness: corr ? 0.55 : 0.44, metalness: corr ? 0.32 : 0.16 });
  const mPaint = corr
    ? mat({ color: d.body, roughness: 0.52, metalness: 0.35, normalMap: ribNormal(Math.max(14, Math.round(S * 5)), 1, 1), normalScale: new THREE.Vector2(1.4, 1.4) })
    : mPaintPlain;
  const mPaintEnd = corr
    ? mat({ color: d.body, roughness: 0.52, metalness: 0.35, normalMap: ribNormal(12, 1, 1), normalScale: new THREE.Vector2(1.3, 1.3) })
    : mPaintPlain;
  const mDoorOuter = corr
    ? mat({ color: d.body, roughness: 0.52, metalness: 0.35, normalMap: ribNormal(7, 1, 1), normalScale: new THREE.Vector2(1.3, 1.3) })
    : mPaintPlain;
  const mAlu = mat({ map: aluTex(), roughness: 0.38, metalness: 0.78 });
  const mRoof = corr
    ? mat({ map: roofTex(d.body, Math.max(8, Math.round(S * 1.6))), roughness: 0.55, metalness: 0.35 })
    : mat({ map: paintTex(d.body), roughness: 0.46, metalness: 0.16 });
  const mFloor = d.floor === 'tbar'
    ? mat({ map: tbarTex(Math.round(intL / 1.1)), roughness: 0.45, metalness: 0.72 })
    : mat({ map: woodTex(Math.round(intL / 1.2)), roughness: 0.82, metalness: 0.04 });
  const mFrame = mat({ color: C_FRAME, roughness: 0.5, metalness: 0.75 });
  const mDark = mat({ color: C_DARK, roughness: 0.6, metalness: 0.5 });
  const mGalv = mat({ color: C_GALV, roughness: 0.32, metalness: 0.9 });
  const mGrille = mat({ color: C_GRILLE, roughness: 0.4, metalness: 0.5 });
  const mGasket = mat({ color: C_GASKET, roughness: 0.85, metalness: 0 });
  const mMachine = mat({ color: C_MACHINE, roughness: 0.45, metalness: 0.5 });
  const mCasing = mat({ color: C_CASING, roughness: 0.5, metalness: 0.15 });
  const mCopper = mat({ color: C_COPPER, roughness: 0.35, metalness: 0.9 });
  const mCable = mat({ color: C_CABLE, roughness: 0.6, metalness: 0.05 });
  const mCoil = mat({ color: C_COIL, roughness: 0.55, metalness: 0.7 });

  function box(w, h, l, m, x, y, z, parent) {
    const g = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m);
    g.position.set(x, y, z);
    g.castShadow = true; g.receiveShadow = true;
    (parent || group).add(g);
    return g;
  }
  function cyl(r, len, m, x, y, z, axis, parent, seg) {
    const g = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg || 20), m);
    if (axis === 'x') g.rotation.z = Math.PI / 2;
    if (axis === 'z') g.rotation.x = Math.PI / 2;
    g.position.set(x, y, z);
    g.castShadow = true;
    (parent || group).add(g);
    return g;
  }
  function decal(tex, w, h, x, y, z, rotY, parent, extra) {
    const o = { map: tex, roughness: 0.5, metalness: 0.05, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 };
    Object.assign(o, extra);
    const g = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial(o));
    g.position.set(x, y, z);
    g.rotation.y = rotY;
    (parent || group).add(g);
    return g;
  }

  box(S - 0.36, 0.12, W - 0.3, mDark, 0, 0.08, 0);
  for (let e1 = -1; e1 <= 1; e1 += 2) {
    box(S - 0.356, 0.17, 0.1, mFrame, 0, 0.085, e1 * (W / 2 - 0.05));
    box(S - 0.356, 0.09, 0.09, mFrame, 0, H - 0.045, e1 * (W / 2 - 0.045));
    box(0.12, 0.17, W - 0.324, mFrame, e1 * (S / 2 - 0.06), 0.085, 0);
    if (!d.machine) {
      [-S * 0.18, S * 0.18].forEach((fx) => {
        box(0.4, 0.13, 0.012, mFrame, fx, 0.085, e1 * (W / 2 + 0.004));
        box(0.34, 0.09, 0.012, mDark, fx, 0.08, e1 * (W / 2 + 0.008));
      });
    }
    for (let e2 = -1; e2 <= 1; e2 += 2) {
      box(ae, H - 0.236, ae, mFrame, e2 * (S / 2 - ae / 2), H / 2, e1 * (W / 2 - ae / 2));
      [0.059, H - 0.059].forEach((yy) => {
        box(0.178, 0.118, 0.162, mFrame, e2 * (S / 2 - 0.089), yy, e1 * (W / 2 - 0.081));
      });
    }
  }

  const wallH = H - base - roofT - 0.02;
  for (let e = -1; e <= 1; e += 2) {
    const sideMats = [mPaintPlain, mPaintPlain, mPaintPlain, mPaintPlain, e > 0 ? mPaint : mAlu, e > 0 ? mAlu : mPaint];
    box(S - 0.12, wallH, 0.07, sideMats, 0, base + wallH / 2, e * (W / 2 - 0.035));
  }

  box(S - 0.12, roofT, W - 0.04, [mPaintPlain, mPaintPlain, mRoof, mAlu, mPaintPlain, mPaintPlain], 0, H - 0.02 - roofT / 2, 0);
  const fStart = d.machine ? (S / 2 - 0.1) - intL : -S / 2 + 0.1;
  const fEnd = S / 2 - 0.06;
  box(fEnd - fStart, 0.05, intW + 0.02, [mFrame, mFrame, mFloor, mFrame, mFrame, mFrame], (fStart + fEnd) / 2, floorTop - 0.025, 0);

  if (three.logoTex) {
    const lw = Math.min(1.9, S * 0.52), lh = lw * 0.75;
    for (let el = -1; el <= 1; el += 2) {
      decal(three.logoTex, lw, lh, 0, base + wallH / 2, el * (W / 2 + 0.004), el > 0 ? 0 : Math.PI, group, { color: new THREE.Color(d.logoTint) });
    }
  }
  decal(plateTex([['TARE', d.machine ? '4 800 KG' : '2 200 KG'], ['PAYLOAD', d.machine ? '29 200 KG' : '28 280 KG'], ['MAX GROSS', d.machine ? '34 000 KG' : '30 480 KG']]),
    0.34, 0.4, S / 2 + 0.041, 1.75, -0.78, Math.PI / 2);
  decal(cautionTex(), 0.3, 0.19, S / 2 + 0.041, 1.2, 0.85, Math.PI / 2);

  if (d.machine) {
    const X = H - 0.95, Ke = H - 0.02, h0 = 0.16;
    const b = (S / 2 - 0.1) - intL, ne = Math.max(A + 0.3, b - 0.17);
    const he = 0.75 + (X - 0.75) / 2, xe = Math.min(0.33, (X - 0.75) / 2 - 0.02);
    const Ze = ne - A;

    box(b - ne, H - 0.23, W - 0.1, [mAlu, mMachine, mPaintPlain, mPaintPlain, mPaintPlain, mPaintPlain], (ne + b) / 2, base + (H - 0.23) / 2, 0);
    box(0.02, 0.1, intW * 0.78, mCoil, b + 0.01, h0 + 0.07, 0);
    box(0.03, 0.16, intW * 0.6, mGalv, b + 0.015, h0 + intH - 0.14, 0);
    const ledMat = mat({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.4 });
    const led1 = box(intL * 0.3, 0.02, 0.08, ledMat, b + intL * 0.3, ceil - 0.01, 0); led1.castShadow = false;
    const led2 = box(intL * 0.3, 0.02, 0.08, ledMat, b + intL * 0.72, ceil - 0.01, 0); led2.castShadow = false;
    const pl = new THREE.PointLight(0xffffff, 0, intL * 1.6, 2);
    pl.position.set((b + (S / 2 - 0.1)) / 2, ceil - 0.25, 0);
    group.add(pl); three.interiorLights.push(pl);

    box(Ze, Ke - X, W - 2 * ae, mPaintEnd, A + Ze / 2, X + (Ke - X) / 2, 0);
    box(Ze, 0.02, W - 2 * ae, mMachine, A + Ze / 2, 0.18, 0);
    box(0.08, X - 0.75, 1.15, mCoil, ne - 0.05, (0.75 + X) / 2, 0.42);

    const shroud = new THREE.Mesh(
      new THREE.CylinderGeometry(xe + 0.03, xe + 0.03, 0.16, 48, 1, true),
      mat({ color: 0xE9EBEF, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide })
    );
    shroud.rotation.z = Math.PI / 2;
    shroud.position.set(A + 0.12, he, 0.42);
    group.add(shroud);

    const grille = new THREE.Group();
    grille.position.set(A + 0.04, he, 0.42);
    group.add(grille);
    for (let r = 0.07; r <= xe + 0.01; r += 0.065) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.006, 6, 48), mGrille);
      ring.rotation.y = Math.PI / 2;
      grille.add(ring);
    }
    for (let ib = 0; ib < 4; ib++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.01, xe * 2, 0.014), mGrille);
      bar.rotation.x = ib * Math.PI / 4;
      grille.add(bar);
    }

    const fanSpin = new THREE.Group();
    fanSpin.position.set(A + 0.14, he, 0.42);
    group.add(fanSpin);
    three.fanSpin = fanSpin;
    for (let ibl = 0; ibl < 5; ibl++) {
      const holder2 = new THREE.Group();
      holder2.rotation.x = ibl * Math.PI * 2 / 5;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.012, xe * 0.8, 0.11), mMachine);
      blade.position.y = xe * 0.48;
      blade.rotation.y = 0.5;
      holder2.add(blade);
      fanSpin.add(holder2);
    }
    cyl(0.05, 0.06, mMachine, 0, 0, 0, 'x', fanSpin);

    box(0.2, 0.46, 0.38, mCasing, A + 0.17, 1.2, -0.62);
    decal(displayTex(), 0.2, 0.086, A + 0.069, 1.32, -0.62, -Math.PI / 2, group,
      { emissive: 0xffffff, emissiveMap: displayTex(), emissiveIntensity: 0.9, transparent: false });
    for (let ik = 0; ik < 3; ik++) box(0.012, 0.03, 0.04, mDark, A + 0.065, 1.2, -0.7 + ik * 0.08);

    cyl(0.16, 0.42, mMachine, ne - 0.2, 0.42, -0.55, 'z');
    cyl(0.07, 0.5, mGalv, ne - 0.15, 0.45, -0.08, 'y');
    for (let ic = 0; ic < 3; ic++) {
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.028, 10, 36), mCable);
      coil.rotation.y = Math.PI / 2;
      coil.position.set(ne - 0.12 - ic * 0.045, 0.43, 0.48);
      coil.castShadow = true;
      group.add(coil);
    }
    cyl(0.012, 0.6, mCopper, ne - 0.08, 0.78, -0.3, 'y', group, 10);
    cyl(0.012, 0.35, mCopper, ne - 0.08, 1.08, -0.13, 'z', group, 10);

    if (three.logoTex) decal(three.logoTex, 0.5, 0.375, A - 0.016, X + 0.45, 0.08, -Math.PI / 2, group, { color: new THREE.Color(d.logoTint) });

    const curtainMat = mat({ color: 0xdfe6ec, roughness: 0.15, metalness: 0, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false });
    const cx = S / 2 - 0.35;
    for (let sx = -d.intW / 2 + 0.08; sx < d.intW / 2; sx += 0.17) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.16, intH - 0.1), curtainMat);
      strip.position.set(cx, floorTop + (intH - 0.1) / 2, sx);
      strip.rotation.y = Math.PI / 2;
      group.add(strip);
    }
  } else {
    box(0.07, wallH, W - 0.1, [mAlu, mPaintEnd, mPaintPlain, mPaintPlain, mPaintPlain, mPaintPlain], A + 0.035, base + wallH / 2, 0);
  }

  const doorMats = [mDoorOuter, mAlu, mPaintPlain, mPaintPlain, mPaintPlain, mPaintPlain];
  for (let ed = -1; ed <= 1; ed += 2) {
    const pivot = new THREE.Group();
    pivot.position.set(S / 2 - 0.035, base, ed * D);
    group.add(pivot);
    const panel = box(0.07, doorH, D - 0.01, doorMats, 0, doorH / 2, -ed * D / 2, pivot);
    panel.castShadow = true;
    box(0.012, 0.045, D - 0.01, mGasket, 0.04, 0.02, -ed * D / 2, pivot);
    box(0.012, 0.045, D - 0.01, mGasket, 0.04, doorH - 0.02, -ed * D / 2, pivot);
    [0.42, 0.82].forEach((f) => {
      const z = -ed * D * f;
      cyl(0.02, doorH + 0.06, mGalv, 0.055, doorH / 2, z, 'y', pivot, 12);
      [0.25, doorH / 2, doorH - 0.25].forEach((yy) => box(0.03, 0.05, 0.07, mGalv, 0.04, yy, z, pivot));
      [-0.01, doorH + 0.01].forEach((yy) => box(0.05, 0.08, 0.06, mGalv, 0.05, yy, z, pivot));
      box(0.03, 0.04, 0.3, mGalv, 0.08, doorH * 0.45, z, pivot);
    });
    if (ed > 0) three.doorR = pivot; else three.doorL = pivot;
  }

  applyDoor(three);
}

function applyPreset(three, name, d) {
  const { camera, controls } = three;
  const { S, H, W } = d;
  const A = -S / 2;
  controls.minPolarAngle = 0;
  if (name === 'inside') {
    three.doorTarget = 1;
    camera.position.set(S / 2 - 1.1, 1.5, 0.55);
    controls.target.set(-S / 2 + 1.2, 1.35, 0);
    controls.minDistance = 0.5;
    controls.maxDistance = Math.max(4, d.intL * 0.95);
    controls.maxPolarAngle = Math.PI * 0.9;
  } else if (name === 'machine') {
    camera.position.set(A - 3.0, 2.0, 2.9);
    controls.target.set(A + 0.25, 1.35, 0);
    controls.minDistance = 1.6;
    controls.maxDistance = 12;
    controls.maxPolarAngle = Math.PI * 0.56;
  } else if (name === 'door') {
    camera.position.set(S / 2 + 3.6, 2.1, 3.2);
    controls.target.set(S / 2 - 0.4, 1.3, 0);
    controls.minDistance = 1.6;
    controls.maxDistance = 14;
    controls.maxPolarAngle = Math.PI * 0.56;
  } else {
    camera.position.set(d.machine ? -S * 0.62 : S * 0.78, H * 1.15, W * 2.9);
    controls.target.set(d.machine ? -S * 0.06 : 0, H * 0.46, 0);
    controls.minDistance = Math.max(4, S * 0.35);
    controls.maxDistance = S * 2.1;
    controls.maxPolarAngle = Math.PI * 0.52;
  }
  three.interiorLights.forEach((l) => { l.intensity = name === 'inside' ? 1.15 : 0.35; });
  controls.update();
}

function projectMarkers(three, stage, camera) {
  if (!three.group || !stage) return;
  const rect = stage.getBoundingClientRect();
  three.occFrame++;
  const doOcc = three.occFrame % 3 === 0;
  three.markerEls.forEach((m) => {
    const world = m.vec3.clone();
    const ndc = world.clone().project(camera);
    if (ndc.z > 1) { m.el.style.display = 'none'; return; }
    if (doOcc) {
      const dir = world.clone().sub(camera.position);
      const dist = dir.length();
      three.raycaster.set(camera.position, dir.normalize());
      three.raycaster.far = dist - 0.22;
      m.hidden = three.raycaster.intersectObjects(three.group.children, true).length > 0;
    }
    if (m.hidden) { m.el.style.display = 'none'; return; }
    m.el.style.display = 'flex';
    m.el.style.left = `${(ndc.x * 0.5 + 0.5) * rect.width}px`;
    m.el.style.top = `${(-(ndc.y * 0.5) + 0.5) * rect.height}px`;
  });
}
