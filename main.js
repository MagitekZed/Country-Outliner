// Country Outline Viewer v1.2.7
//
// This build moves away from the WebGL renderer entirely and uses
// the HTML5 Canvas 2D context for drawing.  D3 is used to compute
// geographic projections and fit countries into the drawing area.
// Animation and special effects are not implemented here; the
// primary goal is to ensure that outlines render reliably on all
// browsers and devices.  Once this baseline is stable, more
// elaborate effects can be layered atop the 2D drawing.

/* global d3 */

// Remote GeoJSON sources
const COUNTRIES_URL =
  'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_countries.geojson';
const DISPUTED_URL =
  'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_boundary_lines_disputed_areas.geojson';

// Themes (stroke, optional fill, background).  Colours are stored
// as CSS hex strings for convenience when applying to the 2D
// context.
const THEMES = {
  wireframe: {
    stroke: '#ffffff',
    fill: null,
    fillAlpha: 0,
    bg: '#0a0a0a',
  },
  neon: {
    stroke: '#00e5ff',
    fill: null,
    fillAlpha: 0,
    bg: '#000010',
  },
  blueprint: {
    stroke: '#ffffff',
    fill: '#0a2535',
    fillAlpha: 0.15,
    bg: '#0a2535',
  },
};

// Loaded data and lookup tables
let countriesData;
let disputedData;
let precomputedDisputed = [];
let nameToFeature = new Map();

// DOM elements
let inputEl;
let suggestionsEl;
let drawingContainer;
let themeSelectEl;
let perfModeEl;
let animateToggleEl;
let animDurationEl;
let durationDisplayEl;

// Canvas and rendering context
let canvas;
let ctx;

// Currently selected feature
let currentFeature = null;

window.addEventListener('DOMContentLoaded', () => {
  inputEl = document.getElementById('country-input');
  suggestionsEl = document.getElementById('suggestions');
  drawingContainer = document.getElementById('drawing-container');
  themeSelectEl = document.getElementById('theme-select');
  perfModeEl = document.getElementById('perf-mode');
  animateToggleEl = document.getElementById('animate-outline');
  animDurationEl = document.getElementById('animation-duration');
  durationDisplayEl = document.getElementById('duration-display');
  // Create and append the canvas
  canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  drawingContainer.appendChild(canvas);
  ctx = canvas.getContext('2d');
  // Menu toggle for mobile
  const menuBtn = document.getElementById('menu-toggle');
  const controlsPanel = document.getElementById('controls');
  if (menuBtn && controlsPanel) {
    menuBtn.addEventListener('click', () => {
      controlsPanel.classList.toggle('open');
    });
  }
  // Load data
  loadData().catch((err) => {
    console.error('Failed to load data', err);
    showMessage('Failed to load map data.');
  });
});

async function loadData() {
  showMessage('Loading data…');
  const [cData, dData] = await Promise.all([
    fetch(COUNTRIES_URL).then((res) => res.json()),
    fetch(DISPUTED_URL).then((res) => res.json()),
  ]);
  console.log('Loaded data', {
    countries: cData.features ? cData.features.length : 0,
    disputed: dData.features ? dData.features.length : 0,
  });
  countriesData = cData;
  disputedData = dData;
  // Build lookup
  countriesData.features.forEach((feat) => {
    const name = feat.properties.name || '';
    nameToFeature.set(normalize(name), feat);
  });
  precomputedDisputed = disputedData.features.map((feat) => {
    return { feature: feat, bbox: d3.geoBounds(feat) };
  });
  clearMessage();
  setupInput();
}

function setupInput() {
  inputEl.addEventListener('input', () => {
    const query = normalize(inputEl.value.trim());
    updateSuggestions(query);
  });
  document.addEventListener('click', (evt) => {
    if (!suggestionsEl.contains(evt.target) && evt.target !== inputEl) {
      suggestionsEl.classList.remove('visible');
    }
  });
  if (durationDisplayEl) {
    durationDisplayEl.textContent = animDurationEl.value + 's';
  }
  function handleControlsChange() {
    if (durationDisplayEl) {
      durationDisplayEl.textContent = animDurationEl.value + 's';
    }
    if (currentFeature) {
      drawCountry(currentFeature);
    }
  }
  themeSelectEl.addEventListener('change', handleControlsChange);
  perfModeEl.addEventListener('change', handleControlsChange);
  animateToggleEl.addEventListener('change', handleControlsChange);
  animDurationEl.addEventListener('input', handleControlsChange);
}

function updateSuggestions(query) {
  suggestionsEl.innerHTML = '';
  if (!query) {
    suggestionsEl.classList.remove('visible');
    return;
  }
  const matches = [];
  nameToFeature.forEach((feat, norm) => {
    if (norm.includes(query)) {
      matches.push({ name: feat.properties.name, feat });
    }
  });
  matches.sort((a, b) => a.name.localeCompare(b.name));
  const limited = matches.slice(0, 8);
  if (limited.length === 0) {
    suggestionsEl.classList.remove('visible');
    return;
  }
  limited.forEach((item) => {
    const div = document.createElement('div');
    div.textContent = item.name;
    div.addEventListener('click', () => {
      inputEl.value = item.name;
      suggestionsEl.classList.remove('visible');
      selectCountry(item.feat);
    });
    suggestionsEl.appendChild(div);
  });
  suggestionsEl.classList.add('visible');
}

function selectCountry(feat) {
  currentFeature = feat;
  console.log('Selected', feat.properties && feat.properties.name);
  drawCountry(feat);
}

function drawCountry(feature) {
  // Determine container size and resize canvas
  const rect = drawingContainer.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Apply background colour
  const themeName = themeSelectEl ? themeSelectEl.value : 'wireframe';
  const theme = THEMES[themeName] || THEMES.wireframe;
  drawingContainer.style.backgroundColor = theme.bg || '#000000';
  // Choose projection
  let projection;
  const props = feature.properties || {};
  const isoA3 = (props.iso_a3 || props.adm0_a3 || props.ADM0_A3 || '').toString().toUpperCase();
  const normName = normalize(props.name || '');
  if (isoA3 === 'USA' || normName === 'united states' || normName === 'united states of america') {
    projection = d3.geoAlbersUsa();
  } else if (isoA3 === 'RUS' || normName === 'russia' || normName === 'russian federation') {
    const bounds = d3.geoBounds(feature);
    let minLon = bounds[0][0];
    let maxLon = bounds[1][0];
    let midpoint;
    if (maxLon < minLon) {
      midpoint = (minLon + (maxLon + 360)) / 2;
      if (midpoint > 180) midpoint -= 360;
    } else {
      midpoint = (minLon + maxLon) / 2;
    }
    projection = d3.geoEqualEarth().rotate([-midpoint, 0]);
  } else {
    projection = d3.geoEqualEarth();
  }
  // Fit to container
  const padding = 20;
  if (typeof projection.fitExtent === 'function') {
    projection.fitExtent(
      [
        [padding, padding],
        [canvas.width - padding, canvas.height - padding],
      ],
      feature
    );
  }
  // Extract polygons
  const polygons = [];
  const geom = feature.geometry;
  if (geom) {
    if (geom.type === 'Polygon') {
      polygons.push(geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach((coords) => polygons.push(coords));
    }
  }
  console.log('Drawing with Canvas polygons', polygons.length);
  // Draw polygons
  ctx.lineWidth = 2;
  ctx.strokeStyle = theme.stroke || '#ffffff';
  polygons.forEach((poly) => {
    // Fill if needed
    if (theme.fill && theme.fillAlpha && theme.fillAlpha > 0) {
      ctx.fillStyle = theme.fill;
      ctx.globalAlpha = theme.fillAlpha;
    } else {
      ctx.fillStyle = 'transparent';
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    poly.forEach((ring) => {
      ring.forEach((coord, index) => {
        const pt = projection(coord);
        if (index === 0) {
          ctx.moveTo(pt[0], pt[1]);
        } else {
          ctx.lineTo(pt[0], pt[1]);
        }
      });
      // Close ring
      const first = projection(ring[0]);
      ctx.lineTo(first[0], first[1]);
    });
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
  });
  // Draw disputed borders as red dashed lines
  const featureBbox = d3.geoBounds(feature);
  const relevant = precomputedDisputed.filter((d) => intersects(featureBbox, d.bbox));
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ff8080';
  relevant.forEach((d) => {
    const f = d.feature;
    if (!f.geometry || f.geometry.type !== 'LineString') return;
    const coords = f.geometry.coordinates;
    ctx.beginPath();
    coords.forEach((coord, index) => {
      const pt = projection(coord);
      if (index === 0) {
        ctx.moveTo(pt[0], pt[1]);
      } else {
        ctx.lineTo(pt[0], pt[1]);
      }
    });
    ctx.stroke();
  });
  ctx.restore();
}

function intersects(bboxA, bboxB) {
  const [aMin, aMax] = bboxA;
  const [bMin, bMax] = bboxB;
  if (bMax[0] < aMin[0] || bMin[0] > aMax[0]) return false;
  if (bMax[1] < aMin[1] || bMin[1] > aMax[1]) return false;
  return true;
}

function normalize(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function showMessage(msg) {
  drawingContainer.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'loading';
  div.textContent = msg;
  drawingContainer.appendChild(div);
}

function clearMessage() {
  const loading = drawingContainer.querySelector('.loading');
  if (loading) loading.remove();
}