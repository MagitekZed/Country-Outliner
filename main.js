// Country Outline Viewer v1.2.6
//
// This release rebuilds the rendering engine from the ground up to
// isolate and fix the blank‑canvas issue seen in earlier PixiJS
// versions.  The new implementation draws country outlines using
// plain PixiJS Graphics calls and D3 projections.  Animation and
// fancy effects will be added back in a future update once the core
// drawing functionality is confirmed to be reliable.  For now, the
// application provides a responsive layout, theme switching and
// optional performance mode toggle.  The only universal control
// affecting the rendering is the theme selector; animation and
// performance toggles currently have no effect but are left in
// place for future expansion.

/* global d3, PIXI */

// Data source URLs.  These endpoints host Natural Earth 1:50m
// geometry for admin 0 countries and disputed boundary lines.  They
// include CORS headers to allow direct fetching from GitHub Pages or
// local file contexts.
const COUNTRIES_URL =
  'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_countries.geojson';
const DISPUTED_URL =
  'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_boundary_lines_disputed_areas.geojson';

// Theme definitions.  Each theme specifies stroke and optional fill
// colours (in hex) as well as a background colour for the map area.
// Additional properties (glow, shadow, etc.) are ignored in this
// simplified build but retained for forward compatibility.
const THEMES = {
  wireframe: {
    stroke: 0xffffff,
    fill: null,
    fillAlpha: 0,
    bg: 0x0a0a0a,
  },
  neon: {
    stroke: 0x00e5ff,
    fill: null,
    fillAlpha: 0,
    bg: 0x000010,
  },
  blueprint: {
    stroke: 0xffffff,
    fill: 0x0a2535,
    fillAlpha: 0.15,
    bg: 0x0a2535,
  },
};

// State variables for loaded data and lookup tables.
let countriesData;
let disputedData;
let precomputedDisputed = [];
let nameToFeature = new Map();

// DOM references set on DOMContentLoaded.
let inputEl;
let suggestionsEl;
let drawingContainer;
let themeSelectEl;
let perfModeEl;
let animateToggleEl;
let animDurationEl;
let durationDisplayEl;

// PixiJS application and stage container.  Created once on
// page load.  The view (canvas) is appended to the drawing
// container; its renderer is resized on each draw.  If Pixi fails
// to initialise (e.g. missing script or WebGL unsupported), these
// variables remain null and the app cannot draw outlines.
let pixiApp = null;
let currentFeature = null;

// Initialise the application once the DOM is ready.  Set up the
// PixiJS renderer, load the datasets, and hook up UI events.
window.addEventListener('DOMContentLoaded', () => {
  inputEl = document.getElementById('country-input');
  suggestionsEl = document.getElementById('suggestions');
  drawingContainer = document.getElementById('drawing-container');
  themeSelectEl = document.getElementById('theme-select');
  perfModeEl = document.getElementById('perf-mode');
  animateToggleEl = document.getElementById('animate-outline');
  animDurationEl = document.getElementById('animation-duration');
  durationDisplayEl = document.getElementById('duration-display');

  // Initialise PixiJS.  Use a fixed starting size based on the
  // container; we'll resize on each draw.  If PIXI is not defined
  // (script failed to load) we leave pixiApp null and log an error.
  try {
    if (typeof PIXI !== 'undefined' && PIXI.Application) {
      const width = drawingContainer.clientWidth || 800;
      const height = drawingContainer.clientHeight || 600;
      pixiApp = new PIXI.Application({
        width,
        height,
        antialias: true,
        autoDensity: true,
        backgroundAlpha: 0,
      });
      // Style the canvas to fill its container.
      pixiApp.view.style.width = '100%';
      pixiApp.view.style.height = '100%';
      drawingContainer.appendChild(pixiApp.view);
      console.log('PixiJS initialised');
    } else {
      console.error('PIXI is undefined; cannot initialise PixiJS');
    }
  } catch (err) {
    console.error('Error initialising PixiJS', err);
    pixiApp = null;
  }

  // Set up the menu toggle on small screens.  On wider screens
  // controls are always visible, so toggling has no effect.
  const menuBtn = document.getElementById('menu-toggle');
  const controlsPanel = document.getElementById('controls');
  if (menuBtn && controlsPanel) {
    menuBtn.addEventListener('click', () => {
      controlsPanel.classList.toggle('open');
    });
  }

  // Load GeoJSON data and set up the input after loading.  If
  // fetching fails, display an error message.
  loadData().catch((err) => {
    console.error('Failed to load data', err);
    showMessage('Failed to load map data.');
  });
});

/**
 * Fetch countries and disputed boundaries, then build lookup tables
 * and prepare for drawing.
 */
async function loadData() {
  showMessage('Loading data…');
  const [cData, dData] = await Promise.all([
    fetch(COUNTRIES_URL).then((res) => res.json()),
    fetch(DISPUTED_URL).then((res) => res.json()),
  ]);
  console.log('Data loaded', {
    countries: cData.features ? cData.features.length : 0,
    disputed: dData.features ? dData.features.length : 0,
  });
  countriesData = cData;
  disputedData = dData;
  // Build name map for suggestions
  countriesData.features.forEach((feat) => {
    const name = feat.properties.name || '';
    nameToFeature.set(normalize(name), feat);
  });
  // Precompute bounding boxes of disputed lines for quick filtering
  precomputedDisputed = disputedData.features.map((feat) => {
    return { feature: feat, bbox: d3.geoBounds(feat) };
  });
  // Remove loading message and initialise the UI
  clearMessage();
  setupInput();
}

/**
 * Set up the country search input and UI control handlers.
 */
function setupInput() {
  // Update suggestions as the user types
  inputEl.addEventListener('input', () => {
    const query = normalize(inputEl.value.trim());
    updateSuggestions(query);
  });
  // Hide suggestions when clicking outside of the search box
  document.addEventListener('click', (evt) => {
    if (!suggestionsEl.contains(evt.target) && evt.target !== inputEl) {
      suggestionsEl.classList.remove('visible');
    }
  });
  // Display initial duration
  if (durationDisplayEl) {
    durationDisplayEl.textContent = animDurationEl.value + 's';
  }
  // When any control changes, redraw the current country
  function handleControlsChange() {
    if (durationDisplayEl) {
      durationDisplayEl.textContent = animDurationEl.value + 's';
    }
    if (currentFeature && pixiApp) {
      drawCountry(currentFeature);
    }
  }
  themeSelectEl.addEventListener('change', handleControlsChange);
  perfModeEl.addEventListener('change', handleControlsChange);
  animateToggleEl.addEventListener('change', handleControlsChange);
  animDurationEl.addEventListener('input', handleControlsChange);
}

/**
 * Update the suggestions list based on a normalized query.
 *
 * @param {string} query
 */
function updateSuggestions(query) {
  suggestionsEl.innerHTML = '';
  if (!query) {
    suggestionsEl.classList.remove('visible');
    return;
  }
  const matches = [];
  nameToFeature.forEach((feat, normName) => {
    if (normName.includes(query)) {
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

/**
 * Called when a suggestion is clicked.  Stores the selected feature
 * and triggers a draw.
 *
 * @param {object} feat GeoJSON feature
 */
function selectCountry(feat) {
  currentFeature = feat;
  console.log('Selecting country', feat.properties && feat.properties.name);
  if (pixiApp) {
    drawCountry(feat);
  } else {
    console.warn('PixiJS not initialised; cannot draw');
  }
}

/**
 * Draw the selected country using PixiJS.  This function is
 * intentionally simple: it clears the stage, sets up the D3
 * projection, fits it to the container and then draws each polygon
 * ring as a path on the Pixi stage.  There is no animation or
 * effects in this build.  Disputed borders are drawn as dashed red
 * lines over the outline.
 *
 * @param {object} feature GeoJSON feature
 */
function drawCountry(feature) {
  // Clear the Pixi stage
  pixiApp.stage.removeChildren();
  // Determine theme and apply background
  const themeName = themeSelectEl ? themeSelectEl.value : 'wireframe';
  const theme = THEMES[themeName] || THEMES.wireframe;
  const bgHex = theme.bg != null ? theme.bg.toString(16).padStart(6, '0') : '000000';
  drawingContainer.style.backgroundColor = `#${bgHex}`;
  // Resize renderer to match container
  const width = drawingContainer.clientWidth || 1;
  const height = drawingContainer.clientHeight || 1;
  pixiApp.renderer.resize(width, height);
  // Choose projection: Albers USA for USA, rotated Equal Earth for
  // Russia, default Equal Earth otherwise
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
  // Fit projection into container with padding
  const padding = 20;
  if (typeof projection.fitExtent === 'function') {
    projection.fitExtent(
      [
        [padding, padding],
        [width - padding, height - padding],
      ],
      feature
    );
  }
  // Extract polygons from feature
  const polygons = [];
  const geom = feature.geometry;
  if (geom) {
    if (geom.type === 'Polygon') {
      polygons.push(geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach((coords) => polygons.push(coords));
    }
  }
  console.log('Drawing polygons', polygons.length);
  // Draw each polygon: each polygon is an array of rings; each ring is an array of [lon, lat]
  polygons.forEach((poly) => {
    const g = new PIXI.Graphics();
    // Set stroke style.  Use a sensible default if theme.stroke is undefined
    const strokeColour = theme.stroke != null ? theme.stroke : 0xffffff;
    g.lineStyle(2, strokeColour, 1);
    // Begin fill if applicable
    if (theme.fill != null && theme.fillAlpha > 0) {
      g.beginFill(theme.fill, theme.fillAlpha);
    }
    poly.forEach((ring) => {
      const pts = ring.map((coord) => projection(coord));
      if (pts.length > 0) {
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          g.lineTo(pts[i][0], pts[i][1]);
        }
        g.lineTo(pts[0][0], pts[0][1]);
      }
    });
    if (theme.fill != null && theme.fillAlpha > 0) {
      g.endFill();
    }
    pixiApp.stage.addChild(g);
  });
  // Draw disputed borders (red dashed lines)
  const featureBbox = d3.geoBounds(feature);
  const relevant = precomputedDisputed.filter((d) => intersects(featureBbox, d.bbox));
  relevant.forEach((d) => {
    const f = d.feature;
    if (!f.geometry || f.geometry.type !== 'LineString') return;
    const coords = f.geometry.coordinates;
    const pts = coords.map((c) => projection(c));
    const g = new PIXI.Graphics();
    g.lineStyle(1.5, 0xff8080, 1);
    // Simple dash pattern: alternate draw segments of fixed length
    let drawSegment = true;
    let dashRemaining = 5; // length of current segment
    let px = pts[0][0];
    let py = pts[0][1];
    g.moveTo(px, py);
    for (let i = 1; i < pts.length; i++) {
      let qx = pts[i][0];
      let qy = pts[i][1];
      let dx = qx - px;
      let dy = qy - py;
      let segLen = Math.hypot(dx, dy);
      while (segLen > 0.0001) {
        const step = Math.min(dashRemaining, segLen);
        const t = step / segLen;
        const rx = px + dx * t;
        const ry = py + dy * t;
        if (drawSegment) {
          g.lineTo(rx, ry);
        } else {
          g.moveTo(rx, ry);
        }
        segLen -= step;
        px = rx;
        py = ry;
        dashRemaining -= step;
        if (dashRemaining <= 0) {
          drawSegment = !drawSegment;
          dashRemaining = drawSegment ? 5 : 3; // alternate dash and gap lengths
        }
      }
    }
    pixiApp.stage.addChild(g);
  });
}

/**
 * Check whether two bounding boxes intersect.  Each bbox is an
 * array [[minLon, minLat], [maxLon, maxLat]].  Returns true
 * if there is any overlap.
 */
function intersects(bboxA, bboxB) {
  const [aMin, aMax] = bboxA;
  const [bMin, bMax] = bboxB;
  if (bMax[0] < aMin[0] || bMin[0] > aMax[0]) return false;
  if (bMax[1] < aMin[1] || bMin[1] > aMax[1]) return false;
  return true;
}

/**
 * Normalize a string by removing diacritics and converting to
 * lowercase.  Used for searching country names.
 */
function normalize(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Display a temporary message in the drawing container.
 */
function showMessage(msg) {
  drawingContainer.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'loading';
  div.textContent = msg;
  drawingContainer.appendChild(div);
}

/**
 * Remove any loading messages from the drawing container.
 */
function clearMessage() {
  const loading = drawingContainer.querySelector('.loading');
  if (loading) loading.remove();
}