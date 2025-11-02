/*
 * main.js – entry point for Country Outliner v1.2.0
 *
 * This file sets up the data loading, projection logic, Three.js
 * scene, UI bindings and theme system.  It uses D3 for geo
 * projection, TopoJSON for efficient boundary storage, THREE.js for
 * rendering and MeshLine for variable‑width outlines.  Fuse.js
 * provides fuzzy searching of country names and tween.js makes
 * animating numeric values straightforward.
 */

const d3Geo = window.d3;
const topojson = window.topojson;
const THREE = window.THREE;
const MeshLine = window.MeshLine || window.THREE.MeshLine;
const MeshLineMaterial = window.MeshLineMaterial || window.THREE.MeshLineMaterial;
const Tween = window.TWEEN;

// Theme definitions.  Each theme describes how to assemble one or
// more line meshes for the outline and may spawn particles on
// animation frames.  Themes can be extended in future releases.
const THEMES = {
  wireframe: {
    name: 'Wireframe Glow',
    background: '#0a0a0a',
    colors: ['#00bfff'],
    lineWidths: [1.5, 6, 12],
    opacities: [1.0, 0.5, 0.2],
    blending: [THREE.NormalBlending, THREE.AdditiveBlending, THREE.AdditiveBlending],
    particle: {
      color: 0x00bfff,
      size: 2,
      max: 80,
      speed: 0.6,
      lifetime: 0.9,
    },
  },
  neon: {
    name: 'Neon',
    background: '#000000',
    colors: ['#00ffff'],
    // Outer glows use thicker lines with additive blending
    lineWidths: [2.5, 8, 16],
    opacities: [1.0, 0.7, 0.3],
    blending: [THREE.NormalBlending, THREE.AdditiveBlending, THREE.AdditiveBlending],
    particle: {
      color: 0x00ffff,
      size: 3,
      max: 120,
      speed: 0.8,
      lifetime: 1.2,
    },
  },
  blueprint: {
    name: 'Blueprint',
    background: '#031e34',
    colors: ['#ffffff'],
    // Drop shadow effect simulated via multiple layers with slight offsets
    lineWidths: [1.8, 3.6],
    opacities: [1.0, 0.3],
    blending: [THREE.NormalBlending, THREE.NormalBlending],
    offsets: [0, 1.5], // pixel offsets in world units for blueprint shadow
    particle: null, // blueprint has no particles
  },
};

// Application state
const state = {
  world: null, // TopoJSON topology
  features: [], // GeoJSON features
  index: [], // Search index items { name, id, iso }
  fuse: null, // Fuse.js instance for fuzzy searching
  projection: null, // Current projection function
  currentCountry: null, // Currently displayed feature
  renderer: null,
  scene: null,
  camera: null,
  lineGroup: null,
  particleSystem: null,
  animationTween: null,
  animating: true,
  animationDuration: 15000, // ms default
  themeKey: 'wireframe',
  mounted: false,
  // DOM elements
  countryInput: null,
  countriesList: null,
  themeSelect: null,
  animateToggle: null,
  durationSlider: null,
  durationValue: null,
  menuToggle: null,
  primaryControls: null,
  secondaryControls: null,
};

// Utility: convert hex colour string to THREE.Color
function colorFromHex(hex) {
  return new THREE.Color(hex);
}

// Particle system for visual spark/ember effects.  Uses a
// Points object updated every frame.  Spawn parameters come from
// theme.particle.  Particles are recycled to avoid GC churn.
class ParticleSystem {
  constructor(scene, params) {
    this.params = params;
    this.particles = [];
    this.geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(params.max * 3);
    this.alphas = new Float32Array(params.max);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));
    const material = new THREE.PointsMaterial({
      size: params.size,
      color: params.color,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: false,
    });
    this.points = new THREE.Points(this.geometry, material);
    scene.add(this.points);
    // Preallocate particle data
    for (let i = 0; i < params.max; i++) {
      this.particles.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, life: 0, age: 0 });
    }
  }
  update(dt) {
    const speed = this.params.speed;
    const lifetime = this.params.lifetime;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (p.active) {
        p.age += dt;
        if (p.age > lifetime) {
          p.active = false;
          this.positions[i * 3 + 2] = 9999; // move offscreen
          this.alphas[i] = 0;
        } else {
          // update position
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          this.positions[i * 3] = p.x;
          this.positions[i * 3 + 1] = p.y;
          this.positions[i * 3 + 2] = 0;
          // fade out over lifetime
          const alpha = 1.0 - p.age / lifetime;
          this.alphas[i] = alpha;
        }
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.alpha.needsUpdate = true;
  }
  spawn(x, y, count) {
    for (let i = 0; i < this.particles.length && count > 0; i++) {
      const p = this.particles[i];
      if (!p.active) {
        p.active = true;
        p.x = x;
        p.y = y;
        p.z = 0;
        // random velocity direction
        const angle = Math.random() * Math.PI * 2;
        const speed = this.params.speed * (0.5 + Math.random());
        p.vx = Math.cos(angle) * speed;
        p.vy = Math.sin(angle) * speed;
        p.age = 0;
        count--;
        this.positions[i * 3] = p.x;
        this.positions[i * 3 + 1] = p.y;
        this.positions[i * 3 + 2] = 0;
        this.alphas[i] = 1.0;
      }
    }
  }
  setActive(active) {
    this.points.visible = active && !!this.params;
  }
}

async function loadData() {
  // Fetch the world TopoJSON at 110m resolution.  This strikes a
  // balance between detail and payload.  We use JSDelivr for fast
  // global delivery.  The file contains a GeometryCollection named
  // 'countries'.
  // Use unpkg.com for the TopoJSON instead of jsDelivr.  The jsDelivr
  // endpoint started returning 403 errors when loaded from a file://
  // origin, whereas unpkg.com serves the file with permissive CORS
  // headers.  Pin to a specific version to avoid any breaking
  // changes in the future.
  const url = 'https://unpkg.com/world-atlas@2.0.2/countries-110m.json';
  const response = await fetch(url);
  const world = await response.json();
  state.world = world;
  const countries = topojson.feature(world, world.objects.countries).features;
  state.features = countries;
  // Build search index.  Use country name and id; fuse.js will
  // handle fuzzy matching.  We exclude empty names just in case.
  const index = [];
  for (const f of countries) {
    const name = f.properties.name || '';
    if (name) {
      index.push({ name, id: f.id });
    }
  }
  state.index = index;
  // Create Fuse.js instance for fuzzy searching names
  state.fuse = new window.Fuse(index, {
    keys: ['name'],
    threshold: 0.3,
    includeScore: false,
  });
  // Populate datalist with country names (in alphabetical order)
  const list = index
    .map((item) => item.name)
    .sort((a, b) => a.localeCompare(b));
  const datalist = document.getElementById('countriesList');
  list.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    datalist.appendChild(option);
  });
}

function setupRenderer() {
  const container = document.getElementById('canvasContainer');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  state.renderer = renderer;
  // Orthographic camera for 2D view.  We'll update its frustum
  // based on the bounds of the current country.
  const aspect = container.clientWidth / container.clientHeight;
  const camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, -10, 10);
  camera.position.set(0, 0, 5);
  state.camera = camera;
  const scene = new THREE.Scene();
  state.scene = scene;
  // Setup initial ambient light (not strictly necessary for MeshLine, but safe)
  const light = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(light);
  // Resize handler
  window.addEventListener('resize', () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    // update resolution uniform on line materials when available
    if (state.lineGroup) {
      state.lineGroup.children.forEach((mesh) => {
        if (mesh.material && mesh.material.uniforms && mesh.material.uniforms.resolution) {
          mesh.material.uniforms.resolution.value.set(w, h);
        }
      });
    }
    // update camera aspect
    const aspect = w / h;
    // We'll adjust camera bounds when drawing; here just update aspect
    state.camera.updateProjectionMatrix();
    render();
  });
}

function setTheme(key) {
  state.themeKey = key;
  const theme = THEMES[key];
  // Update background color
  document.body.style.backgroundColor = theme.background;
  // If a country is already displayed, rebuild the line group
  if (state.currentCountry) {
    drawCountry(state.currentCountry);
  }
}

function createLineMeshes(rings, theme) {
  // rings: array of Float32Array positions (flattened x,y,z) for each ring
  const group = new THREE.Group();
  const lineWidths = theme.lineWidths;
  const opacities = theme.opacities;
  const blendingModes = theme.blending;
  const offsets = theme.offsets || null;
  const colors = theme.colors;
  // For each line layer, build meshes for all rings
  for (let layer = 0; layer < lineWidths.length; layer++) {
    const meshes = [];
    const width = lineWidths[layer];
    const opacity = opacities[layer] !== undefined ? opacities[layer] : 1.0;
    const blending = blendingModes[layer] || THREE.NormalBlending;
    const colorHex = colors[0];
    const color = new THREE.Color(colorHex);
    // For blueprint shadow effect, we apply a fixed offset on this layer
    const layerOffset = offsets && offsets[layer] ? offsets[layer] : 0;
    for (const ring of rings) {
      const geometry = new MeshLine();
      geometry.setPoints(ring);
      const material = new MeshLineMaterial({
        lineWidth: width,
        color: color,
        transparent: true,
        opacity: opacity,
        blending: blending,
        depthWrite: false,
        resolution: new THREE.Vector2(state.renderer.domElement.clientWidth, state.renderer.domElement.clientHeight),
        // disable dashing for now; themes with dashed lines could set dashArray
        // dashArray: 0,
      });
      // For blueprint layer offset: translate the mesh slightly down-right
      const mesh = new THREE.Mesh(geometry, material);
      if (layerOffset) {
        mesh.position.set(layerOffset, -layerOffset, 0);
      }
      // Initially hide geometry until animation reveals it
      geometry.geometry.setDrawRange(0, 0);
      meshes.push(mesh);
      group.add(mesh);
    }
  }
  return group;
}

// Compute maximum vertex count across all rings for uniform animation
function computeMaxVertices(rings) {
  let maxVertices = 0;
  for (const ring of rings) {
    // ring is Float32Array [x,y,z, x,y,z,...]
    maxVertices = Math.max(maxVertices, ring.length / 3);
  }
  return maxVertices;
}

function drawCountry(feature) {
  // Remove existing group and particles
  if (state.lineGroup) {
    state.scene.remove(state.lineGroup);
    state.lineGroup = null;
  }
  if (state.particleSystem) {
    state.scene.remove(state.particleSystem.points);
    state.particleSystem = null;
  }
  state.currentCountry = feature;
  const theme = THEMES[state.themeKey];
  // Determine projection based on country.  Use Albers USA for
  // United States, rotated equal‑earth for Russia, otherwise equal‑earth.
  const iso3 = feature.id;
  let projection;
  if (iso3 === '840') {
    // USA composite projection; approximated by d3.geoAlbersUsa
    projection = d3Geo.geoAlbersUsa();
  } else if (iso3 === '643') {
    // Russia: rotate so Far East wraps around
    projection = d3Geo.geoEqualEarth().rotate([100, 0]);
  } else {
    projection = d3Geo.geoEqualEarth();
  }
  state.projection = projection;
  // Project geometry coordinates into 2D and build rings array
  // Each ring becomes a Float32Array of [x,y,0,...]
  const rings = [];
  // A feature may be MultiPolygon or Polygon
  const coords = feature.geometry.coordinates;
  const type = feature.geometry.type;
  if (type === 'Polygon') {
    // coords is array of rings
    coords.forEach((ring) => {
      const flat = [];
      ring.forEach(([lon, lat]) => {
        const [x, y] = projection([lon, lat]);
        flat.push(x, y, 0);
      });
      rings.push(new Float32Array(flat));
    });
  } else if (type === 'MultiPolygon') {
    coords.forEach((poly) => {
      poly.forEach((ring) => {
        const flat = [];
        ring.forEach(([lon, lat]) => {
          const [x, y] = projection([lon, lat]);
          flat.push(x, y, 0);
        });
        rings.push(new Float32Array(flat));
      });
    });
  }
  // Compute bounding box
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 3) {
      const x = ring[i];
      const y = ring[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  // Compute scale and offset to fit within view
  const container = document.getElementById('canvasContainer');
  const margin = 20; // pixels
  const width = container.clientWidth;
  const height = container.clientHeight;
  // Determine scaling factor based on bounding box extents vs. container size
  const dataWidth = maxX - minX;
  const dataHeight = maxY - minY;
  const scaleX = (width - margin * 2) / dataWidth;
  const scaleY = (height - margin * 2) / dataHeight;
  const scale = Math.min(scaleX, scaleY);
  // Offset to centre geometry
  const offsetX = -((minX + maxX) / 2);
  const offsetY = -((minY + maxY) / 2);
  // Apply transformation to rings (copy to new arrays to avoid reusing original)
  const transformedRings = [];
  for (const ring of rings) {
    const coords = new Float32Array(ring.length);
    for (let i = 0; i < ring.length; i += 3) {
      const x = (ring[i] + offsetX) * scale;
      const y = (ring[i + 1] + offsetY) * scale;
      coords[i] = x;
      coords[i + 1] = y;
      coords[i + 2] = 0;
    }
    transformedRings.push(coords);
  }
  // Adjust camera frustum to match container dims.  We set the
  // orthographic bounds equal to half of container size in world units
  // (scale implicitly maps world coords into pixel space).  We choose
  // symmetrical bounds around zero.  Because we scaled the data to
  // fill [-(width/2-margin), (width/2-margin)] etc, we can simply
  // set camera left/right to ± width/2 and top/bottom to ± height/2.
  const left = -width / 2;
  const right = width / 2;
  const topVal = height / 2;
  const bottomVal = -height / 2;
  state.camera.left = left;
  state.camera.right = right;
  state.camera.top = topVal;
  state.camera.bottom = bottomVal;
  state.camera.updateProjectionMatrix();
  // Build line meshes according to theme
  const group = createLineMeshes(transformedRings, theme);
  state.lineGroup = group;
  state.scene.add(group);
  // Build particle system if theme defines one
  if (theme.particle) {
    state.particleSystem = new ParticleSystem(state.scene, theme.particle);
  }
  // Compute maximum vertices across rings
  const maxVertices = computeMaxVertices(transformedRings);
  // Cancel existing animation tween
  if (state.animationTween) {
    state.animationTween.stop();
  }
  // Duration in ms
  const duration = state.animationDuration;
  // Prepare tween value
  const params = { progress: 0 };
  const tween = new Tween.Tween(params)
    .to({ progress: 1 }, duration)
    .easing(Tween.Easing.Linear.None)
    .onUpdate(() => {
      // Update draw range for each ring in each mesh layer
      const drawCount = Math.floor(params.progress * maxVertices);
      group.children.forEach((mesh) => {
        const geom = mesh.geometry;
        geom.geometry.setDrawRange(0, drawCount);
      });
      // Spawn particles at current head position (approximate using last drawn vertices)
      if (state.particleSystem && state.animating) {
        // Determine head position from the first ring (largest) if exists
        if (transformedRings.length > 0) {
          const ring = transformedRings[0];
          const idx = Math.min(drawCount - 1, ring.length / 3 - 1);
          if (idx >= 0) {
            const x = ring[idx * 3];
            const y = ring[idx * 3 + 1];
            state.particleSystem.spawn(x, y, 4);
          }
        }
      }
    })
    .onComplete(() => {
      // After the outline is fully drawn, ensure draw ranges are full
      group.children.forEach((mesh) => {
        const geom = mesh.geometry;
        geom.geometry.setDrawRange(0, maxVertices);
      });
    });
  state.animationTween = tween;
  // Start animation only if animating flag is true
  if (state.animating) {
    tween.start();
  } else {
    // Immediately render full
    params.progress = 1;
    tween.onUpdateCallback(params);
    tween.onCompleteCallback();
  }
  render();
}

function render() {
  if (!state.renderer) return;
  state.renderer.render(state.scene, state.camera);
}

function animate(time) {
  requestAnimationFrame(animate);
  // update tween engine
  Tween.update();
  // update particles
  if (state.particleSystem) {
    state.particleSystem.update(0.016); // approximate dt for 60fps
  }
  render();
}

function setupUI() {
  state.countryInput = document.getElementById('countryInput');
  state.themeSelect = document.getElementById('themeSelect');
  state.animateToggle = document.getElementById('animateToggle');
  state.durationSlider = document.getElementById('durationSlider');
  state.durationValue = document.getElementById('durationValue');
  state.menuToggle = document.getElementById('menuToggle');
  state.primaryControls = document.getElementById('primaryControls');
  state.secondaryControls = document.getElementById('secondaryControls');
  // Update duration display
  state.durationValue.textContent = state.durationSlider.value + 's';
  // Listen for country input events
  state.countryInput.addEventListener('change', (e) => {
    const query = e.target.value.trim();
    if (!query) return;
    // Use Fuse.js to find best matching country
    const results = state.fuse.search(query);
    let selected = null;
    // If the typed value matches exactly, pick that; otherwise use top match
    for (const item of state.index) {
      if (item.name.toLowerCase() === query.toLowerCase()) {
        selected = item;
        break;
      }
    }
    if (!selected && results.length > 0) {
      selected = results[0].item;
    }
    if (selected) {
      // Find feature by id
      const feature = state.features.find((f) => f.id === selected.id);
      if (feature) {
        drawCountry(feature);
      }
    }
  });
  // Theme selection
  state.themeSelect.addEventListener('change', (e) => {
    const key = e.target.value;
    setTheme(key);
  });
  // Animate toggle
  state.animateToggle.addEventListener('change', (e) => {
    const checked = e.target.checked;
    state.animating = checked;
    // Restart animation on toggle change
    if (state.currentCountry) {
      drawCountry(state.currentCountry);
    }
    if (state.particleSystem) {
      state.particleSystem.setActive(checked);
    }
  });
  // Duration slider
  state.durationSlider.addEventListener('input', (e) => {
    const value = parseInt(e.target.value, 10);
    state.animationDuration = value * 1000;
    state.durationValue.textContent = value + 's';
    // Restart animation with new duration
    if (state.currentCountry) {
      drawCountry(state.currentCountry);
    }
  });
  // Menu toggle for small screens
  state.menuToggle.addEventListener('click', () => {
    const panel = document.getElementById('controlPanel');
    if (panel.classList.contains('open')) {
      panel.classList.remove('open');
    } else {
      panel.classList.add('open');
    }
  });
}

async function init() {
  await loadData();
  setupRenderer();
  setupUI();
  // Set default theme
  setTheme(state.themeKey);
  // Kick off animation loop
  requestAnimationFrame(animate);
}

init().catch((err) => console.error(err));