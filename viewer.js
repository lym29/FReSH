import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';

// Static prediction exports only. Coordinates are never aligned or accumulated.
// Binary descriptors use byte offsets, element lengths and little-endian arrays.
const TYPE = { float32: Float32Array, uint8: Uint8Array, uint16: Uint16Array, uint32: Uint32Array };
const HAND_COLOR = { left: 0xe7a24d, right: 0x508eca };
const byId = (id) => document.getElementById(id);
const host = byId('scene-canvas');
const status = byId('scene-status');

function say(message, error = false) {
  if (!status) return;
  status.textContent = message;
  status.dataset.state = error ? 'error' : 'ready';
}

async function readJSON(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Could not load the reconstruction (${response.status}).`);
  return response.json();
}

function array(value, buffer, label, fallback = []) {
  if (value == null) return fallback;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value;
  const Constructor = TYPE[value.dtype];
  const offset = value.offset ?? value.byteOffset;
  if (!Constructor || !buffer || !Number.isInteger(offset) || !Number.isInteger(value.length)
      || offset < 0 || value.length < 0 || offset % Constructor.BYTES_PER_ELEMENT
      || offset + value.length * Constructor.BYTES_PER_ELEMENT > buffer.byteLength) {
    throw new Error(`The ${label} data are incomplete or use an unsupported format.`);
  }
  return new Constructor(buffer, offset, value.length);
}

function xyz(value, buffer, label) {
  const result = array(value, buffer, label);
  if (result.length % 3 || !result.every(Number.isFinite)) {
    throw new Error(`The ${label} coordinates are invalid.`);
  }
  return result instanceof Float32Array ? result : Float32Array.from(result);
}

function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose();
    if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
    else child.material?.dispose();
  });
}

function clearGroup(group) {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
}

function finiteVector(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

async function start() {
  if (!host) return;
  const ui = {
    select: byId('scene-select'), play: byId('play-scene'), slider: byId('frame-slider'),
    label: byId('frame-label'), reset: byId('reset-scene'), fullscreen: byId('fullscreen-scene'),
    points: byId('layer-points'), hands: byId('layer-hands'), cameras: byId('layer-cameras'),
    pointSize: byId('point-size'), pointSizeLabel: byId('point-size-label'),
  };
  if (Object.values(ui).some((element) => !element)) throw new Error('The 3D viewer controls are unavailable.');
  status?.setAttribute('role', 'status');
  status?.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-busy', 'true');
  host.setAttribute('role', 'group');
  host.removeAttribute('tabindex');
  ui.play.disabled = true;
  ui.slider.disabled = true;
  ui.select.disabled = true;
  say('Loading the interactive reconstruction…');

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  } catch {
    throw new Error('Interactive 3D requires WebGL. Please enable graphics acceleration or use another browser.');
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0xf5f6f7, 1);
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline-offset:-4px';
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', 'Interactive predicted scene and hands. Drag to orbit, right-drag to pan, and scroll to zoom. Space plays or pauses; left and right arrows step through saved moments; plus and minus zoom; R resets the view.');
  renderer.domElement.title = 'Drag: orbit · Right-drag: pan · Scroll: zoom · Space: play/pause · ←/→: step · +/−: zoom · R: reset';
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.001, 1000);
  camera.up.set(0, -1, 0); // OpenCV world convention used by the source exports.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.8;
  controls.panSpeed = 0.8;
  controls.minDistance = 0.025;
  const pointLayer = new THREE.Group();
  const handLayer = new THREE.Group();
  const cameraLayer = new THREE.Group();
  scene.add(pointLayer, handLayer, cameraLayer);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb6bec9, 2.0));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.3);
  const fillLight = new THREE.DirectionalLight(0xffffff, 1.0);
  keyLight.position.set(-1, -3, -2);
  fillLight.position.set(2, 0.5, 1);
  scene.add(keyLight, fillLight);

  // A round point sprite is a display marker, never a synthetic scene sample.
  const spriteCanvas = document.createElement('canvas');
  spriteCanvas.width = spriteCanvas.height = 32;
  const spriteContext = spriteCanvas.getContext('2d');
  spriteContext.fillStyle = '#fff';
  spriteContext.beginPath();
  spriteContext.arc(16, 16, 15, 0, Math.PI * 2);
  spriteContext.fill();
  const pointSprite = new THREE.CanvasTexture(spriteCanvas);

  const input = byId('input-video');
  const follow = byId('sync-video');
  const samples = byId('reconstruction-samples');
  const inputCatalog = await readJSON(new URL('assets/inputs/catalog.json', document.baseURI));
  let inputScene = null;
  let current = null;
  function followInput() {
    if (!follow.checked || !current || !inputScene) return;
    const time = input.currentTime;
    const index = current.manifest.frames.reduce((n, frame, i) => frame.source_position / 30 <= time + .001 ? i : n, 0);
    if (index !== frameIndex) setFrame(index, false);
    else {
      const held = current.manifest.frames[frameIndex].source_position / 30;
      say(`${current.description} · 3D sample: ${held.toFixed(2)} s · Input: ${time.toFixed(2)} s${Math.abs(held-time) > .04 ? ' (3D held)' : ''}`);
    }
  }
  input.addEventListener('timeupdate', followInput);
  input.addEventListener('seeked', followInput);
  follow.addEventListener('change', followInput);
  input.addEventListener('play', () => setPlaying(false));
  let frameIndex = 0;
  let playing = false;
  let renderingFrame = false;
  let nextFrameAt = 0;
  let frameRequest = 0;
  let sceneRequest = 0;
  let controller = null;
  let animation = 0;
  let disposed = false;
  let contextLost = false;
  const cache = new Map();
  const fullscreenTarget = host.closest('[data-scene-viewer]') || host.parentElement;

  function layers() {
    pointLayer.visible = ui.points.checked;
    handLayer.visible = ui.hands.checked;
    cameraLayer.visible = ui.cameras.checked;
  }
  [ui.points, ui.hands, ui.cameras].forEach((input) => input.addEventListener('change', layers));
  layers();

  function pointSize() { return Number(ui.pointSize.value) / 1000; }
  function updatePointSize() {
    const size = pointSize();
    ui.pointSizeLabel.textContent = `${Math.round(size * 1000)} mm`;
    ui.pointSize.setAttribute('aria-valuetext', `${Math.round(size * 1000)} millimetres`);
    pointLayer.traverse((object) => { if (object.isPoints) object.material.size = size; });
  }
  ui.pointSize.addEventListener('input', updatePointSize);
  updatePointSize();

  function setPlaying(value) {
    playing = Boolean(value && current && current.manifest.frames.length > 1 && !contextLost);
    ui.play.textContent = playing ? 'Pause' : 'Play';
    ui.play.setAttribute('aria-label', playing ? 'Pause reconstruction playback' : 'Play saved reconstruction moments');
    ui.play.setAttribute('aria-pressed', String(playing));
    nextFrameAt = performance.now() + 1000 / (current?.fps || 5);
  }

  function resize() {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight || 480);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  function resetView() {
    if (!current) return;
    const preset = current.preset;
    controls.target.fromArray(preset.target);
    camera.position.fromArray(preset.position);
    camera.up.fromArray(preset.up || [0, -1, 0]);
    camera.near = Math.max(0.0005, current.radius / 10000);
    camera.far = Math.max(100, current.radius * 100);
    camera.updateProjectionMatrix();
    controls.maxDistance = Math.max(20, current.radius * 30);
    controls.update();
  }

  function makeCameraLines(cameras) {
    const coordinates = [];
    const depth = current.manifest.camera_frustum_depth || 0.06;
    for (const item of cameras || []) {
      if (item.valid === false) continue;
      const matrix = array(item.matrix ?? item.T_c2w, current.buffer, 'camera matrix');
      const intrinsic = array(item.intrinsics ?? item.K, current.buffer, 'camera intrinsics');
      const width = item.width || current.manifest.image_width;
      const height = item.height || current.manifest.image_height;
      if (matrix.length !== 16 || intrinsic.length !== 9 || !matrix.every(Number.isFinite)
          || !intrinsic.every(Number.isFinite) || !(width > 0 && height > 0)) {
        throw new Error('A camera is missing its predicted pose or intrinsics.');
      }
      const world = new THREE.Matrix4().set(...matrix);
      const inverseK = new THREE.Matrix3().set(...intrinsic);
      if (Math.abs(inverseK.determinant()) < 1e-12) throw new Error('A predicted camera has invalid intrinsics.');
      inverseK.invert();
      const vertices = [new THREE.Vector3().applyMatrix4(world)];
      for (const [x, y] of [[0, 0], [width, 0], [width, height], [0, height]]) {
        const ray = new THREE.Vector3(x, y, 1).applyMatrix3(inverseK);
        if (!Number.isFinite(ray.z) || Math.abs(ray.z) < 1e-12) throw new Error('A predicted camera ray is invalid.');
        vertices.push(ray.multiplyScalar(depth / ray.z).applyMatrix4(world));
      }
      for (const [a, b] of [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [2, 3], [3, 4], [4, 1]]) {
        coordinates.push(...vertices[a].toArray(), ...vertices[b].toArray());
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(coordinates, 3));
    return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x3d4857, transparent: true, opacity: 0.8 }));
  }

  async function frameData(data, index) {
    const descriptor = data.manifest.frames[index];
    if (!descriptor.url) return descriptor;
    if (!data.frameCache.has(index)) {
      data.frameCache.set(index, readJSON(new URL(descriptor.url, data.url)));
    }
    try { return await data.frameCache.get(index); }
    catch (error) { data.frameCache.delete(index); throw error; }
  }

  async function setFrame(index, seekInput = true) {
    if (!current || contextLost) return;
    const owner = current;
    const ticket = ++frameRequest;
    const nextIndex = Math.max(0, Math.min(owner.manifest.frames.length - 1, Math.round(index)));
    renderingFrame = true;
    let temporary = null;
    try {
      const frame = await frameData(owner, nextIndex);
      if (owner !== current || ticket !== frameRequest) return;
      // Stage all geometry before changing the displayed frame. Invalid data remain explicit.
      temporary = new THREE.Group();
      const nextPoints = new THREE.Group();
      const nextHands = new THREE.Group();
      const nextCameras = new THREE.Group();
      temporary.add(nextPoints, nextHands, nextCameras);
      const positions = xyz(frame.points, owner.buffer, 'point cloud');
      const rawColors = array(frame.colors, owner.buffer, 'point colors');
      if (rawColors.length !== positions.length) throw new Error('Point positions and colors do not match.');
      const colors = new Float32Array(rawColors.length);
      for (let i = 0; i < rawColors.length; i++) {
        const channel = rawColors[i] / 255;
        if (!(channel >= 0 && channel <= 1)) throw new Error('Point colors are invalid.');
        colors[i] = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      }
      if (positions.length) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        nextPoints.add(new THREE.Points(geometry, new THREE.PointsMaterial({
          vertexColors: true, size: pointSize(),
          sizeAttenuation: true, map: pointSprite, alphaTest: 0.4,
          transparent: false, depthWrite: true, toneMapped: false,
        })));
      }
      for (const [handIndex, hand] of (frame.hands || []).entries()) {
        if (hand.valid === false) continue;
        const vertices = xyz(hand.vertices, owner.buffer, 'hand mesh');
        const faces = array(hand.faces ?? owner.manifest.faces, owner.buffer, 'hand faces');
        if (!vertices.length || !faces.length || faces.length % 3
            || !faces.every((value) => Number.isInteger(value) && value >= 0 && value < vertices.length / 3)) {
          throw new Error('The hand mesh topology is invalid.');
        }
        const rawSide = hand.side ?? owner.manifest.hand_sides?.[handIndex];
        const side = rawSide === 0 || rawSide === 'left' ? 'left' : rawSide === 1 || rawSide === 'right' ? 'right' : null;
        if (!side) throw new Error('A hand is missing its left/right identity.');
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(faces), 1));
        geometry.computeVertexNormals();
        nextHands.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
          color: HAND_COLOR[side], roughness: 0.68, metalness: 0,
          side: THREE.DoubleSide, flatShading: false,
        })));
      }
      nextCameras.add(makeCameraLines(frame.cameras));
      for (const [target, staged] of [[pointLayer, nextPoints], [handLayer, nextHands], [cameraLayer, nextCameras]]) {
        clearGroup(target);
        for (const child of [...staged.children]) target.add(child);
      }
      temporary = null;
      frameIndex = nextIndex;
      ui.slider.value = String(frameIndex);
      const sourceFrame = owner.manifest.frame_ids?.[frameIndex] ?? frame.frame_id;
      const frameText = sourceFrame == null ? `Moment ${frameIndex + 1} / ${owner.manifest.frames.length}`
        : `Frame ${sourceFrame} · ${frameIndex + 1} / ${owner.manifest.frames.length}`;
      ui.label.textContent = frameText;
      ui.slider.setAttribute('aria-valuetext', frameText);
      host.querySelector('.canvas-placeholder')?.remove();
      if (seekInput && inputScene) {
        input.pause();
        input.currentTime = owner.manifest.frames[frameIndex].source_position / 30;
      }
      samples.querySelectorAll('button').forEach((button, i) => button.setAttribute('aria-pressed', String(i === frameIndex)));
      const heldTime = owner.manifest.frames[frameIndex].source_position / 30;
      say(`${owner.description} · 3D sample: ${heldTime.toFixed(2)} s · Input: ${input.currentTime.toFixed(2)} s${Math.abs(heldTime-input.currentTime) > .04 ? ' (3D held)' : ''}`);
    } catch (error) {
      if (ticket === frameRequest) {
        setPlaying(false);
        // Do not silently show an earlier frame under a later frame label.
        clearGroup(pointLayer); clearGroup(handLayer); clearGroup(cameraLayer);
        ui.label.textContent = 'Frame unavailable';
        say(`${error.message} Select another scene or try reloading.`, true);
      }
    } finally {
      if (temporary) disposeObject(temporary);
      if (ticket === frameRequest) renderingFrame = false;
    }
  }

  function fitBounds(manifest, buffer) {
    const bounds = new THREE.Box3();
    const point = new THREE.Vector3();
    for (const frame of manifest.frames) {
      if (frame.url) continue;
      const collections = [frame.points, ...(frame.hands || []).filter((hand) => hand.valid !== false).map((hand) => hand.vertices)];
      for (const collection of collections) {
        const positions = xyz(collection, buffer, 'scene bounds');
        for (let i = 0; i < positions.length; i += 3) bounds.expandByPoint(point.fromArray(positions, i));
      }
    }
    if (bounds.isEmpty() && manifest.bounds?.min && manifest.bounds?.max) {
      bounds.min.fromArray(manifest.bounds.min); bounds.max.fromArray(manifest.bounds.max);
    }
    const preset = manifest.camera || manifest.observer;
    if (bounds.isEmpty() && !(finiteVector(preset?.position) && finiteVector(preset?.target))) {
      throw new Error('This reconstruction has no valid geometry or viewing bounds.');
    }
    const radius = Math.max(0.08, bounds.isEmpty() ? 1 : bounds.getSize(new THREE.Vector3()).length() / 2);
    if (finiteVector(preset?.position) && finiteVector(preset?.target)) {
      return { radius, preset: { ...preset, up: finiteVector(preset.up) ? preset.up : [0, -1, 0] } };
    }
    const center = bounds.getCenter(new THREE.Vector3());
    const direction = new THREE.Vector3(0.65, -0.45, -1).normalize();
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(24)) * 1.15;
    return { radius, preset: { target: center.toArray(), position: center.clone().addScaledVector(direction, distance).toArray(), up: [0, -1, 0] } };
  }

  async function loadScene(entry, catalogURL) {
    const ticket = ++sceneRequest;
    ++frameRequest;
    setPlaying(false);
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    input.pause();
    current = null;
    renderingFrame = false;
    ui.play.disabled = ui.slider.disabled = true;
    ui.label.textContent = 'Loading…';
    host.setAttribute('aria-busy', 'true');
    clearGroup(pointLayer); clearGroup(handLayer); clearGroup(cameraLayer);
    say(`Loading ${entry.label || 'reconstruction'}…`);
    try {
      let data = cache.get(entry.id);
      if (!data) {
        const url = new URL(entry.url, catalogURL);
        const manifest = await readJSON(url, signal);
        if (!Array.isArray(manifest.frames) || !manifest.frames.length) throw new Error('No prediction frames are available for this scene.');
        if (manifest.frame_ids && manifest.frame_ids.length !== manifest.frames.length) throw new Error('The source-frame index is incomplete.');
        let buffer = null;
        if (manifest.buffer) {
          const response = await fetch(new URL(manifest.buffer, url), { signal });
          if (!response.ok) throw new Error(`Could not load the scene geometry (${response.status}).`);
          buffer = await response.arrayBuffer();
        }
        const view = fitBounds(manifest, buffer);
        data = { manifest, buffer, url, ...view, frameCache: new Map(),
          fps: Math.min(30, Math.max(0.5, Number(manifest.fps) || 5)),
          description: entry.scope || manifest.notes || 'Saved prediction moments. Drag to explore the original reconstructed world.',
        };
        if (Array.isArray(data.description)) data.description = data.description.join(' ');
        cache.set(entry.id, data);
        if (cache.size > 3) cache.delete(cache.keys().next().value);
      }
      if (ticket !== sceneRequest || signal.aborted) return;
      current = data;
      ui.slider.min = '0'; ui.slider.max = String(data.manifest.frames.length - 1); ui.slider.step = '1';
      ui.play.disabled = ui.slider.disabled = data.manifest.frames.length < 2;
      inputScene = inputCatalog.scenes.find(s => s.id === entry.id);
      if (!inputScene) throw new Error('Matching input video is unavailable.');
      input.poster = inputScene.poster;
      input.replaceChildren();
      for (const file of [inputScene.video, inputScene.video.replace(/\.mp4$/, '.webm')]) {
        const source = document.createElement('source'); source.src = file;
        source.type = file.endsWith('.webm') ? 'video/webm' : 'video/mp4'; input.append(source);
      }
      input.load();
      byId('input-cameras').textContent = inputScene.cameras.join(' · ');
      byId('input-note').textContent = inputScene.note;
      samples.replaceChildren(...data.manifest.frames.map((frame, i) => {
        const button = document.createElement('button'); button.textContent = `${(frame.source_position / 30).toFixed(2)} s`;
        button.setAttribute('aria-label', `Sample ${i+1}, source frame ${frame.frame_id}`);
        button.addEventListener('click', () => { setPlaying(false); setFrame(i); }); return button;
      }));
      resetView();
      await setFrame(0);
    } catch (error) {
      if (ticket !== sceneRequest || error.name === 'AbortError') return;
      ui.label.textContent = 'Scene unavailable';
      say(`${error.message} Choose another scene or reload this page.`, true);
    } finally {
      if (ticket === sceneRequest) host.setAttribute('aria-busy', 'false');
    }
  }

  ui.play.addEventListener('click', () => setPlaying(!playing));
  ui.slider.addEventListener('input', () => { setPlaying(false); setFrame(Number(ui.slider.value)); });
  ui.reset.addEventListener('click', resetView);
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (fullscreenTarget.requestFullscreen) await fullscreenTarget.requestFullscreen();
      else say('Fullscreen is unavailable in this browser. The viewer remains interactive.');
    } catch { say('Fullscreen was not available. You can continue exploring in this window.'); }
  }
  ui.fullscreen.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    const active = document.fullscreenElement === fullscreenTarget;
    ui.fullscreen.textContent = active ? '⤡' : '⤢';
    ui.fullscreen.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Open fullscreen viewer');
    ui.fullscreen.title = active ? 'Exit fullscreen' : 'Open fullscreen viewer';
    ui.fullscreen.setAttribute('aria-pressed', String(active));
    resize();
  });
  renderer.domElement.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (![' ', 'arrowleft', 'arrowright', 'home', 'end', '+', '=', '-', '_', 'r', 'f'].includes(key)) return;
    event.preventDefault();
    if (key === ' ') setPlaying(!playing);
    else if (key === 'r') resetView();
    else if (key === 'f') toggleFullscreen();
    else if (['+', '=', '-', '_'].includes(key)) {
      const offset = camera.position.clone().sub(controls.target);
      const distance = THREE.MathUtils.clamp(offset.length() * (key === '+' || key === '=' ? 0.85 : 1.18), controls.minDistance, controls.maxDistance);
      camera.position.copy(controls.target).add(offset.setLength(distance)); controls.update();
    } else if (current) {
      setPlaying(false);
      setFrame(key === 'home' ? 0 : key === 'end' ? current.manifest.frames.length - 1 : frameIndex + (key === 'arrowright' ? 1 : -1));
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPlaying(false); });
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault(); contextLost = true; setPlaying(false);
    say('The graphics context was interrupted. Waiting for the browser to restore 3D…', true);
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    if (current) setFrame(frameIndex);
  });

  function animate(now) {
    if (disposed) return;
    animation = requestAnimationFrame(animate);
    if (contextLost || document.hidden) return;
    if (playing && current && !renderingFrame && now >= nextFrameAt) {
      nextFrameAt = now + 1000 / current.fps;
      setFrame((frameIndex + 1) % current.manifest.frames.length);
    }
    controls.update();
    renderer.render(scene, camera);
  }
  animation = requestAnimationFrame(animate);
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    disposed = true; controller?.abort(); cancelAnimationFrame(animation); observer.disconnect(); controls.dispose();
    clearGroup(pointLayer); clearGroup(handLayer); clearGroup(cameraLayer); pointSprite.dispose(); renderer.dispose();
  });

  const catalogURL = new URL(host.dataset.catalog || 'assets/scenes/scenes.json', document.baseURI);
  const catalog = await readJSON(catalogURL);
  const entries = catalog.scenes;
  if (!Array.isArray(entries) || !entries.length || entries.some((entry) => !entry.id || !entry.url)) {
    throw new Error('No reconstruction exports are available yet.');
  }
  ui.select.replaceChildren(...entries.map((entry) => new Option(entry.label || entry.id, entry.id)));
  ui.select.disabled = false;
  ui.select.addEventListener('change', () => {
    const selected = entries.find((entry) => entry.id === ui.select.value);
    if (selected) loadScene(selected, catalogURL);
  });
  const first = entries.find((entry) => entry.id === catalog.default_scene) || entries[0];
  ui.select.value = first.id;
  await loadScene(first, catalogURL);
}

start().catch((error) => {
  host?.setAttribute('aria-busy', 'false');
  say(error.message || 'The interactive reconstruction could not be loaded.', true);
  console.error('FReSH reconstruction viewer:', error);
});
