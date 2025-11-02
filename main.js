// Main script for the Country Outline Viewer.
//
// This module loads Natural Earth datasets for countries and disputed
// boundaries, sets up a simple autocomplete UI, and draws the selected
// country's outline using the Equal Earth projection.  Equal Earth is an
// equal‑area pseudocylindrical projection that keeps the parallels and
// central meridian straight, preserving a north‑up orientation and
// reducing distortion for countries far from the equator【159340284396829†L36-L48】.
// Disputed border segments are overlaid as dashed lines.

// D3 and d3-geo-projection are loaded globally via script tags in
// index.html.  Access them through the global `d3` object.  The
// azimuthal equal-area projection is available as d3.geoAzimuthalEqualArea.

// Remote datasets hosted by Natural Earth via CloudFront.  These files
// contain medium-scale (1:50m) geometry for admin 0 countries and
// disputed boundary lines. See the naturalearth-3.3.0 release for
// details.  Note: these endpoints set permissive CORS headers, so
// they can be fetched directly from the browser.
const COUNTRIES_URL =
  'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_countries.geojson';
const DISPUTED_URL =
  'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_boundary_lines_disputed_areas.geojson';

let countriesData; // GeoJSON FeatureCollection for countries
let disputedData; // GeoJSON FeatureCollection for disputed lines
let precomputedDisputed = []; // array of {feature, bbox}
let nameToFeature = new Map(); // maps normalized name to feature

// Remember the currently selected country feature so that style changes
// (theme, animation, duration) can trigger a redraw without retyping.
let currentFeature = null;

// DOM references (initialised in init once the document is ready)
let inputEl;
let suggestionsEl;
let drawingContainer;
let themeSelectEl;
let perfModeEl;
let animateToggleEl;
let animDurationEl;
let durationDisplayEl;

// Pixi application and container for the current drawing.  These
// variables are initialised in the DOMContentLoaded handler.  The
// application’s view will be appended to the drawing container and
// automatically sized to fill it.
let pixiApp = null;
let currentDrawContainer = null;
// Flag indicating whether the Pixi renderer was successfully initialised.
// If false, the code falls back to an SVG based renderer that does not
// require the PixiJS library.  The fallback preserves the basic
// functionality (country outline, fill and disputed borders) and
// supports animation, but omits glow and shadow effects.
let usePixi = false;

// Themes definition.  Each theme specifies stroke colour, glow
// settings, optional shadow and fill.  Colours are provided as hex
// integers for Pixi.  The glow and shadow sizes are specified in
// pixels.  Fill alpha controls the opacity of the fill (0 = none).
const THEMES = {
  wireframe: {
    stroke: 0xffffff,
    glow: 0x00bfa5,
    glowSize: 4,
    glowAlpha: 0.4,
    fill: null,
    fillAlpha: 0,
    shadow: null,
    bg: 0x0a0a0a,
  },
  neon: {
    stroke: 0x00e5ff,
    glow: 0x00e5ff,
    glowSize: 6,
    glowAlpha: 0.6,
    fill: null,
    fillAlpha: 0,
    shadow: null,
    bg: 0x000010,
  },
  blueprint: {
    stroke: 0xffffff,
    glow: 0x004080,
    glowSize: 3,
    glowAlpha: 0.3,
    fill: 0x0a2535,
    fillAlpha: 0.15,
    shadow: { color: 0x000000, alpha: 0.5, offsetX: 2, offsetY: 2 },
    bg: 0x0a2535,
  },
};

// Initialise after the DOM has loaded.  Without waiting for
// DOMContentLoaded the script would try to access elements that do
// not yet exist when loaded in the <head>.
window.addEventListener('DOMContentLoaded', () => {
  inputEl = document.getElementById('country-input');
  suggestionsEl = document.getElementById('suggestions');
  drawingContainer = document.getElementById('drawing-container');
  themeSelectEl = document.getElementById('theme-select');
  perfModeEl = document.getElementById('perf-mode');
  animateToggleEl = document.getElementById('animate-outline');
  animDurationEl = document.getElementById('animation-duration');
  durationDisplayEl = document.getElementById('duration-display');

  // Initialise PixiJS application and append it to the drawing container.
  // If PixiJS is unavailable or fails to initialise (e.g. missing CDN
  // script or lack of WebGL support), we fall back to the SVG renderer.
  // We perform additional runtime checks to ensure the renderer and its
  // view are defined before attempting to append to the DOM.  Without
  // these checks, calling drawingContainer.appendChild(pixiApp.view) when
  // view is undefined would throw an error such as "Cannot read properties
  // of undefined (reading 'canvas')".  Newer releases of PixiJS (v8+) can
  // leave the renderer undefined if WebGL initialisation fails, so
  // explicitly verify that both the renderer and view exist.
  try {
    console.log('Attempting to initialise PixiJS');
    if (typeof PIXI !== 'undefined' && PIXI.Application) {
      // Manually set the width and height to avoid issues with the resizeTo
      // option in certain PixiJS versions.  We'll listen for window
      // resize events and update the renderer size accordingly.
      const initialWidth = drawingContainer.clientWidth || 800;
      const initialHeight = drawingContainer.clientHeight || 600;
      const app = new PIXI.Application({
        width: initialWidth,
        height: initialHeight,
        antialias: true,
        autoDensity: true,
        backgroundAlpha: 0,
      });
      // Verify the renderer and view exist before using them.
      if (app.renderer && app.renderer.view) {
        pixiApp = app;
        drawingContainer.appendChild(pixiApp.view);
        usePixi = true;
        console.log('PixiJS initialised successfully', pixiApp);
        // Handle resizing: adjust the Pixi renderer to match the container
        const resizeObserver = new ResizeObserver(() => {
          const w = drawingContainer.clientWidth;
          const h = drawingContainer.clientHeight;
          pixiApp.renderer.resize(w, h);
        });
        resizeObserver.observe(drawingContainer);
      } else {
        console.error('PixiJS initialisation failed: renderer or view is undefined');
        console.warn('Falling back to SVG renderer');
        pixiApp = null;
        usePixi = false;
      }
    } else {
      // PIXI is undefined; fall back to SVG renderer
      usePixi = false;
      console.warn('PIXI is undefined; using SVG fallback');
    }
  } catch (e) {
    console.error('Failed to initialise PixiJS', e);
    pixiApp = null;
    usePixi = false;
    console.warn('Using SVG fallback due to Pixi initialisation error');
  }

  // Set up the responsive menu toggle for narrow screens.  On
  // small viewports the controls panel is hidden by default and
  // revealed when the user clicks the hamburger icon.  The menu
  // toggle is ignored on larger screens where the controls are
  // always visible.
  const menuBtn = document.getElementById('menu-toggle');
  const controlsPanel = document.getElementById('controls');
  if (menuBtn && controlsPanel) {
    menuBtn.addEventListener('click', () => {
      controlsPanel.classList.toggle('open');
    });
  }

  loadData().catch((err) => {
    console.error('Error loading data:', err);
    showMessage('Failed to load map data. Check your connection.');
  });
});

/**
 * Fetch both datasets in parallel and prepare them for use.
 */
async function loadData() {
  showMessage('Loading data…');
  const [cData, dData] = await Promise.all([
    fetch(COUNTRIES_URL).then((res) => res.json()),
    fetch(DISPUTED_URL).then((res) => res.json()),
  ]);
  console.log('GeoJSON data loaded', {
    countriesCount: cData && cData.features ? cData.features.length : 0,
    disputedCount: dData && dData.features ? dData.features.length : 0,
  });
  countriesData = cData;
  disputedData = dData;

  // Build a mapping from normalized country names to their feature for quick lookup.
  countriesData.features.forEach((feat) => {
    const name = feat.properties.name;
    nameToFeature.set(normalize(name), feat);
  });

  // Precompute bounding boxes for disputed lines to speed up filtering.
  precomputeDisputed();

  // Remove loading message and initialise UI.
  clearMessage();
  setupInput();
}

/**
 * Compute bounding boxes for each disputed line feature.
 */
function precomputeDisputed() {
  precomputedDisputed = disputedData.features.map((feat) => {
    const bbox = d3.geoBounds(feat);
    return { feature: feat, bbox };
  });
}

/**
 * Set up the autocomplete input behaviour.
 */
function setupInput() {
  // When the user types, update suggestions.
  inputEl.addEventListener('input', () => {
    const query = normalize(inputEl.value.trim());
    updateSuggestions(query);
  });

  // Hide suggestions when clicking outside of the control panel.
  document.addEventListener('click', (evt) => {
    if (!suggestionsEl.contains(evt.target) && evt.target !== inputEl) {
      suggestionsEl.classList.remove('visible');
    }
  });

  // Display the initial value of the animation duration
  if (durationDisplayEl) {
    durationDisplayEl.textContent = animDurationEl.value + 's';
  }

  // When any control changes, redraw the current feature (if any).  We update
  // the duration display and call drawCountry() to apply the new theme,
  // animation toggle, performance mode or duration.  Background colours are
  // applied inside drawCountry based on the selected theme.
  function handleControlsChange() {
    if (durationDisplayEl) {
      durationDisplayEl.textContent = animDurationEl.value + 's';
    }
    if (currentFeature) {
      // Redraw using the appropriate renderer based on the Pixi flag
      if (usePixi) {
        drawCountry(currentFeature);
      } else {
        drawCountryFallback(currentFeature);
      }
    }
  }
  themeSelectEl.addEventListener('change', handleControlsChange);
  perfModeEl.addEventListener('change', handleControlsChange);
  animateToggleEl.addEventListener('change', handleControlsChange);
  animDurationEl.addEventListener('input', handleControlsChange);
}

/**
 * Update the suggestions dropdown based on the current query.  The
 * matching uses a simple substring search on the normalized names.
 *
 * @param {string} query normalized user input
 */
function updateSuggestions(query) {
  suggestionsEl.innerHTML = '';
  if (!query) {
    suggestionsEl.classList.remove('visible');
    return;
  }

  // Collect matches where the country name contains the query substring.
  const matches = [];
  nameToFeature.forEach((feat, normName) => {
    if (normName.includes(query)) {
      matches.push({ name: feat.properties.name, feat });
    }
  });

  // Sort matches alphabetically and limit to 8 suggestions.
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
 * Called when a country has been selected from the suggestions.  This
 * function fits the projection to the country's bounds and draws its
 * outline along with any disputed border segments.
 *
 * @param {object} feature GeoJSON feature representing the selected country
 */
function selectCountry(feature) {
  // Draw the country using the appropriate renderer.  If Pixi was
  // successfully initialised use the WebGL renderer; otherwise use the
  // SVG fallback.  This allows the app to function even when the
  // PixiJS script fails to load or WebGL is unavailable.
  console.log('Country selected', feature && feature.properties ? feature.properties.name : feature, 'usePixi:', usePixi);
  if (usePixi) {
    drawCountry(feature);
  } else {
    drawCountryFallback(feature);
  }
  // Store the selected feature so that changing styles can re-render it
  currentFeature = feature;
}

/**
 * Draw the selected country and overlay disputed border segments.
 *
 * @param {object} feature GeoJSON feature representing the selected country
 */
function drawCountry(feature) {
  // Guard against missing Pixi application
  if (!pixiApp) {
    console.error('PixiJS application not initialised');
    return;
  }
  // Clear any previous drawing by removing children from the stage.  We do
  // not remove the Pixi view from the DOM because it is reused across
  // draws.  This ensures old graphics are cleared before new ones are
  // added.
  pixiApp.stage.removeChildren();

  // Determine selected theme and other UI settings.  Fall back to
  // sensible defaults if controls are missing.
  const themeName = themeSelectEl ? themeSelectEl.value : 'wireframe';
  const theme = THEMES[themeName] || THEMES.wireframe;
  const perfMode = perfModeEl && perfModeEl.checked;
  const animate = animateToggleEl && animateToggleEl.checked;
  let durationMs = 20000;
  if (animDurationEl) {
    const val = parseFloat(animDurationEl.value);
    if (!isNaN(val)) {
      durationMs = val * 1000;
    }
  }
  // Apply the background colour based on the current theme.  Convert
  // numeric hex values to six‑character hex strings with a leading '#'.
  const bgHex = theme.bg != null ? theme.bg.toString(16).padStart(6, '0') : '000000';
  drawingContainer.style.backgroundColor = `#${bgHex}`;

  // Compute projection for the selected country.  Use Equal Earth by
  // default; switch to Albers USA for the United States and rotate
  // Equal Earth for Russia to centre its longitude.  Compute width and
  // height of the drawing area each time in case the container has
  // resized (responsive design).  Fit the projection to the container
  // with 20 px padding on each side.
  const { width, height } = drawingContainer.getBoundingClientRect();
  let projection;
  let projectionType = 'equalEarth';
  try {
    const props = feature.properties || {};
    const normName = normalize(
      props.name || props.NAME || props.name_long || props.NAME_LONG || ''
    );
    const isoA3 = (
      props.iso_a3 || props.adm0_a3 || props.ADM0_A3 || ''
    )
      .toString()
      .toUpperCase();
    if (
      isoA3 === 'USA' ||
      normName === 'united states' ||
      normName === 'united states of america'
    ) {
      projection = d3.geoAlbersUsa();
      projectionType = 'albersUsa';
    } else if (
      isoA3 === 'RUS' ||
      normName === 'russia' ||
      normName === 'russian federation'
    ) {
      const bounds = d3.geoBounds(feature);
      const minLon = bounds[0][0];
      const maxLon = bounds[1][0];
      let midpoint;
      if (maxLon < minLon) {
        midpoint = (minLon + (maxLon + 360)) / 2;
        if (midpoint > 180) midpoint -= 360;
      } else {
        midpoint = (minLon + maxLon) / 2;
      }
      projection = d3.geoEqualEarth().rotate([-midpoint, 0]);
      projectionType = 'equalEarthRotated';
    } else {
      projection = d3.geoEqualEarth();
      projectionType = 'equalEarth';
    }
  } catch (e) {
    projection = d3.geoEqualEarth();
    projectionType = 'equalEarth';
    console.error('Error determining projection, defaulting to equalEarth', e);
  }
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

  // Extract polygons (arrays of linear rings) from the feature.  A
  // MultiPolygon contains multiple coordinate sets; treat each as its
  // own polygon.  Each polygon is represented as an array of rings,
  // where the first ring is the outer boundary and subsequent rings
  // (if any) are holes.  Coordinates are given in [lon, lat] pairs.
  const polys = [];
  const geom = feature.geometry;
  if (geom) {
    if (geom.type === 'Polygon') {
      polys.push(geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach((coords) => {
        polys.push(coords);
      });
    }
  }

  // Precompute projected coordinate arrays and segment information for
  // each polygon.  For animation we flatten all ring segments into a
  // single list, marking the beginning of each ring with a moveTo flag.
  const polyDatas = [];
  let maxTotalLength = 0;
  polys.forEach((polyRings) => {
    // Project each ring into screen coordinates.  Each projected ring
    // is an array of [x, y] pairs.
    const projRings = polyRings.map((ring) => {
      return ring.map((coord) => {
        const [x, y] = projection(coord);
        return [x, y];
      });
    });
    // Flatten segments across all rings.  Each segment stores start,
    // end, length and a flag indicating whether to move without drawing
    // (true for the first segment of each ring).  We skip the final
    // closing segment because the ring is implicitly closed.
    const segments = [];
    let totalLength = 0;
    projRings.forEach((ring) => {
      if (ring.length < 2) return;
      for (let i = 0; i < ring.length - 1; i++) {
        const start = ring[i];
        const end = ring[i + 1];
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const len = Math.hypot(dx, dy);
        const moveTo = i === 0; // move at start of each ring
        segments.push({ start, end, length: len, moveTo });
        totalLength += len;
      }
    });
    // Some polygons might have no segments (degenerate); skip them
    if (segments.length === 0) return;
    if (totalLength > maxTotalLength) maxTotalLength = totalLength;
    // Create graphics elements for stroke, glow and fill
    const lineGraphics = new PIXI.Graphics();
    const glowGraphics = new PIXI.Graphics();
    let fillGraphics = null;
    if (theme.fill != null && theme.fillAlpha > 0) {
      fillGraphics = new PIXI.Graphics();
      // Draw the fill geometry immediately; hide it until animation completes
      fillGraphics.beginFill(theme.fill, theme.fillAlpha);
      projRings.forEach((ring) => {
        if (ring.length < 2) return;
        fillGraphics.moveTo(ring[0][0], ring[0][1]);
        for (let i = 1; i < ring.length; i++) {
          fillGraphics.lineTo(ring[i][0], ring[i][1]);
        }
      });
      fillGraphics.endFill();
      fillGraphics.visible = false;
    }
    // Glow graphics: thicker stroke with blur and additive blending
    if (theme.glow != null && theme.glowAlpha > 0) {
      const glowWidth = theme.glowSize || 6;
      glowGraphics.lineStyle(glowWidth, theme.glow, theme.glowAlpha);
      // Use additive blending for the glow if available.  PixiJS v8
      // defines ADD in BLEND_MODES, but fall back to ADDITIVE or SCREEN
      // if ADD is undefined.  Default to NORMAL when no additive
      // blending is available.
      let addMode = null;
      if (typeof PIXI !== 'undefined' && PIXI.BLEND_MODES) {
        addMode = PIXI.BLEND_MODES.ADD;
        if (addMode === undefined) {
          addMode = PIXI.BLEND_MODES.ADDITIVE;
        }
        if (addMode === undefined) {
          addMode = PIXI.BLEND_MODES.SCREEN;
        }
        if (addMode === undefined) {
          addMode = PIXI.BLEND_MODES.NORMAL;
        }
      }
      glowGraphics.blendMode = addMode;
      // Optionally apply a blur filter for soft glow.  Reduce intensity
      // in performance mode by lowering blur radius and alpha.
      const blurRadius = perfMode ? Math.max(1, (theme.glowSize || 6) / 2) : (theme.glowSize || 6);
      try {
        const blurFilter = new PIXI.filters.BlurFilter(blurRadius);
        glowGraphics.filters = [blurFilter];
      } catch (e) {
        // BlurFilter may not be available; ignore if not
      }
    }
    // Line graphics: base outline
    const strokeWidth = 2; // fixed width for outline
    lineGraphics.lineStyle(strokeWidth, theme.stroke, 1);
    polyDatas.push({ segments, totalLength, lineGraphics, glowGraphics, fillGraphics });
  });

  // Build a container for the current draw.  We will add glow, line and
  // fill graphics in proper order.  Fill is added first so it sits
  // beneath the stroke and glow.  Glow is added before the line so
  // that it appears behind the crisp outline.
  const container = new PIXI.Container();
  polyDatas.forEach((pd) => {
    if (pd.fillGraphics) {
      container.addChild(pd.fillGraphics);
    }
    if (theme.glow != null && theme.glowAlpha > 0) {
      container.addChild(pd.glowGraphics);
    }
    container.addChild(pd.lineGraphics);
  });
  pixiApp.stage.addChild(container);

  // Log details about the draw preparation
  console.log('Drawing with Pixi', {
    theme: themeName,
    projection: projectionType,
    polygons: polyDatas.length,
    totalLengths: polyDatas.map((pd) => pd.totalLength),
    maxTotalLength,
    animate,
    perfMode,
  });

  // Helper function to draw a partial path on a graphics object.  It
  // draws up to drawLength along the segment list.  If drawLength is
  // greater than the total length, the entire path is drawn.  When
  // moveTo flag is true for a segment, the drawing cursor jumps to
  // the start point without drawing a connecting line.
  function drawSegments(graphics, segments, drawLength, lineWidth, color, alpha) {
    graphics.clear();
    // Set line style; default alpha is 1 if unspecified
    const a = alpha !== undefined ? alpha : 1;
    graphics.lineStyle(lineWidth, color, a);
    let remaining = drawLength;
    for (const seg of segments) {
      if (seg.moveTo) {
        graphics.moveTo(seg.start[0], seg.start[1]);
      }
      if (remaining <= 0) {
        break;
      }
      if (remaining >= seg.length) {
        // Draw the entire segment
        graphics.lineTo(seg.end[0], seg.end[1]);
        remaining -= seg.length;
      } else {
        // Draw a partial segment
        const t = remaining / seg.length;
        const x = seg.start[0] + (seg.end[0] - seg.start[0]) * t;
        const y = seg.start[1] + (seg.end[1] - seg.start[1]) * t;
        graphics.lineTo(x, y);
        remaining = 0;
      }
    }
  }

  // Function to draw dashed disputed lines.  Dashed patterns are
  // approximated by repeatedly drawing and skipping segments of a
  // specified pattern length.  Pattern is an array of dash/gap lengths.
  function drawDashed(graphics, points, pattern, width, color, alpha) {
    graphics.lineStyle(width, color, alpha);
    let patternIndex = 0;
    let draw = true;
    let remainingSegment = pattern[0];
    graphics.moveTo(points[0][0], points[0][1]);
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i];
      const end = points[i + 1];
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      let segmentLength = Math.hypot(dx, dy);
      let sx = start[0];
      let sy = start[1];
      while (segmentLength > 0) {
        const step = Math.min(remainingSegment, segmentLength);
        const t = step / segmentLength;
        const ex = sx + dx * (step / Math.hypot(dx, dy));
        const ey = sy + dy * (step / Math.hypot(dx, dy));
        if (draw) {
          graphics.lineTo(ex, ey);
        } else {
          graphics.moveTo(ex, ey);
        }
        segmentLength -= step;
        remainingSegment -= step;
        sx = ex;
        sy = ey;
        if (remainingSegment <= 0) {
          patternIndex = (patternIndex + 1) % pattern.length;
          remainingSegment = pattern[patternIndex];
          draw = !draw;
        }
      }
    }
  }

  // Render function: draws each polygon based on current progress (0–1).
  function render(progress) {
    const globalLength = maxTotalLength * progress;
    polyDatas.forEach((pd) => {
      const drawLength = Math.min(globalLength, pd.totalLength);
      // Draw glow first
      if (theme.glow != null && theme.glowAlpha > 0) {
        const alpha = perfMode ? Math.min(theme.glowAlpha, 0.3) : theme.glowAlpha;
        const blurWidth = theme.glowSize || 6;
        // Reapply blur filter with reduced radius in perf mode
        if (pd.glowGraphics.filters && pd.glowGraphics.filters[0] instanceof PIXI.filters.BlurFilter) {
          const bf = pd.glowGraphics.filters[0];
          bf.blur = perfMode ? Math.max(1, blurWidth / 2) : blurWidth;
        }
        drawSegments(pd.glowGraphics, pd.segments, drawLength, theme.glowSize || 6, theme.glow, alpha);
      }
      // Draw outline
      drawSegments(pd.lineGraphics, pd.segments, drawLength, 2, theme.stroke, 1);
      // Show fill when complete
      if (pd.fillGraphics) {
        pd.fillGraphics.visible = drawLength >= pd.totalLength;
      }
    });
  }

  // Draw disputed borders using dashed red lines.  Disputed segments are
  // static (non‑animated) and always rendered on top of the country.
  function drawDisputedLines() {
    // Compute bounding box of the selected country in geographic coordinates
    const featureBbox = d3.geoBounds(feature);
    // Filter relevant disputed lines that intersect the bbox
    const relevantLines = precomputedDisputed.filter((d) => intersects(featureBbox, d.bbox));
    if (relevantLines.length === 0) return;
    const disputedContainer = new PIXI.Container();
    relevantLines.forEach((d) => {
      const f = d.feature;
      if (!f.geometry || f.geometry.type !== 'LineString') return;
      const coords = f.geometry.coordinates;
      // Project each coordinate
      const pts = coords.map((c) => {
        const [x, y] = projection(c);
        return [x, y];
      });
      // Create a graphics for this line
      const g = new PIXI.Graphics();
      // Use a red colour similar to previous versions
      drawDashed(g, pts, [4, 3], 1.5, 0xff8080, 1);
      disputedContainer.addChild(g);
    });
    pixiApp.stage.addChild(disputedContainer);
  }

  // Start the rendering.  If animation is disabled or the geometry has
  // no length, draw the final state immediately.  Otherwise, animate
  // over the specified duration.  Use PixiJS ticker for smooth updates.
  if (!animate || maxTotalLength === 0) {
    render(1);
    drawDisputedLines();
  } else {
    // Initialize progress to 0
    render(0);
    drawDisputedLines();
    const startTime = performance.now();
    function tick() {
      const elapsed = performance.now() - startTime;
      let t = elapsed / durationMs;
      if (t > 1) t = 1;
      render(t);
      if (t >= 1) {
        pixiApp.ticker.remove(tick);
      }
    }
    pixiApp.ticker.add(tick);
  }
}

/**
 * Fallback renderer using SVG for browsers where PixiJS failed to
 * initialise (e.g. the Pixi library is not loaded or WebGL is
 * unavailable).  This function draws the selected country using d3
 * projections and standard SVG paths.  It supports basic animation
 * of the outline and optional fill, but does not implement glow or
 * shadow effects.  The theme’s stroke and fill colours are used to
 * style the paths.  Disputed borders are drawn with a dashed red
 * stroke on top of the country.
 *
 * @param {object} feature GeoJSON feature representing the selected country
 */
function drawCountryFallback(feature) {
  // Clear previous drawing and remove any loading message
  drawingContainer.innerHTML = '';
  clearMessage();

  console.log('Using SVG fallback renderer');

  // Determine selected theme and UI settings
  const themeName = themeSelectEl ? themeSelectEl.value : 'wireframe';
  const theme = THEMES[themeName] || THEMES.wireframe;
  const animate = animateToggleEl && animateToggleEl.checked;
  // Determine animation duration (in ms)
  let durationMs = 20000;
  if (animDurationEl) {
    const val = parseFloat(animDurationEl.value);
    if (!isNaN(val)) durationMs = val * 1000;
  }
  // Apply background colour from theme
  const bgHex = theme.bg != null ? theme.bg.toString(16).padStart(6, '0') : '000000';
  drawingContainer.style.backgroundColor = `#${bgHex}`;

  // Compute projection: replicate logic from the Pixi renderer to
  // choose Equal Earth, Albers USA or rotated Equal Earth for Russia.
  const { width, height } = drawingContainer.getBoundingClientRect();
  let projection;
  try {
    const props = feature.properties || {};
    const normName = normalize(
      props.name || props.NAME || props.name_long || props.NAME_LONG || ''
    );
    const isoA3 = (
      props.iso_a3 || props.adm0_a3 || props.ADM0_A3 || ''
    )
      .toString()
      .toUpperCase();
    if (
      isoA3 === 'USA' ||
      normName === 'united states' ||
      normName === 'united states of america'
    ) {
      projection = d3.geoAlbersUsa();
    } else if (
      isoA3 === 'RUS' ||
      normName === 'russia' ||
      normName === 'russian federation'
    ) {
      const bounds = d3.geoBounds(feature);
      const minLon = bounds[0][0];
      const maxLon = bounds[1][0];
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
  } catch (e) {
    projection = d3.geoEqualEarth();
  }
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
  // Create an SVG element sized to the drawing container
  const svg = d3
    .select(drawingContainer)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', `0 0 ${width} ${height}`);

  // Path generator using the projection
  const pathGen = d3.geoPath().projection(projection);

  // Extract polygons from the feature.  For MultiPolygons we treat each
  // constituent polygon separately to compute individual path lengths
  // and apply the animation consistently.
  const polygons = [];
  const geom = feature.geometry;
  if (geom) {
    if (geom.type === 'Polygon') {
      polygons.push({ type: 'Polygon', coordinates: geom.coordinates });
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach((coords) => {
        polygons.push({ type: 'Polygon', coordinates: coords });
      });
    }
  }
  // Prepare arrays to store SVG path elements and their lengths
  const polyPaths = [];
  const lengths = [];
  // Convert theme colours to CSS hex strings
  const strokeHex = theme.stroke != null
    ? '#' + theme.stroke.toString(16).padStart(6, '0')
    : '#ffffff';
  const fillHex = theme.fill != null
    ? '#' + theme.fill.toString(16).padStart(6, '0')
    : null;
  const fillAlpha = theme.fillAlpha != null ? theme.fillAlpha : 0;
  // Draw each polygon; compute length and create fill path behind stroke
  polygons.forEach((poly) => {
    const dStr = pathGen(poly);
    // Create stroke path
    const strokePath = svg.append('path')
      .attr('d', dStr)
      .attr('fill', 'none')
      .attr('stroke', strokeHex)
      .attr('stroke-width', 2)
      .attr('vector-effect', 'non-scaling-stroke');
    // Compute length; catching potential errors
    let len = 0;
    try {
      len = strokePath.node().getTotalLength();
    } catch (e) {
      len = 0;
    }
    lengths.push(len);
    // Create fill path behind stroke if fill is defined and alpha > 0
    let fillPath = null;
    if (fillHex && fillAlpha > 0) {
      fillPath = svg.append('path')
        .attr('d', dStr)
        .attr('fill', fillHex)
        .attr('fill-opacity', fillAlpha)
        .attr('stroke', 'none');
      // Move fill behind stroke
      fillPath.lower();
      // Hide fill until animation completes
      if (animate && len > 0) {
        fillPath.attr('opacity', 0);
      }
    }
    polyPaths.push({ strokePath, fillPath, length: len });
  });
  // Determine maximum length across all polygons
  const maxLength = lengths.length > 0 ? Math.max(...lengths) : 0;
  // Draw disputed lines: filter those intersecting the country's bbox
  const featureBbox = d3.geoBounds(feature);
  const relevantLines = precomputedDisputed.filter((d) => intersects(featureBbox, d.bbox));
  if (relevantLines.length > 0) {
    svg
      .selectAll('path.disputed')
      .data(relevantLines.map((d) => d.feature))
      .join('path')
      .attr('class', 'disputed')
      .attr('d', (d) => pathGen(d))
      .attr('fill', 'none')
      .attr('stroke', '#ff8080')
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '4,3');
  }
  // Animation: draw outlines using a single dash equal to the maximum
  // length across polygons.  This ensures small islands draw at the
  // same speed as the mainland.  After the animation completes,
  // remove dash attributes and reveal the fill paths.
  polyPaths.forEach(({ strokePath, fillPath, length }) => {
    if (animate && maxLength > 0) {
      // Apply a single dash equal to maxLength; offset initial dash
      strokePath
        .attr('stroke-dasharray', maxLength)
        .attr('stroke-dashoffset', maxLength)
        .transition()
        .duration(durationMs)
        .ease(d3.easeLinear)
        .attr('stroke-dashoffset', 0)
        .on('end', () => {
          strokePath.attr('stroke-dasharray', null);
          strokePath.attr('stroke-dashoffset', null);
          if (fillPath) fillPath.attr('opacity', 1);
        });
    } else {
      // Not animated: show stroke and fill immediately
      strokePath.attr('stroke-dasharray', null);
      strokePath.attr('stroke-dashoffset', null);
      if (fillPath) fillPath.attr('opacity', 1);
    }
  });
}

/**
 * Determine whether two bounding boxes intersect.  Each bbox is an
 * array of the form [[minLon, minLat], [maxLon, maxLat]].
 *
 * @param {number[][]} bboxA bounding box of the first geometry
 * @param {number[][]} bboxB bounding box of the second geometry
 * @returns {boolean} true if the bounding boxes intersect
 */
function intersects(bboxA, bboxB) {
  const [aMin, aMax] = bboxA;
  const [bMin, bMax] = bboxB;
  // Check for separation along the x (longitude) axis
  if (bMax[0] < aMin[0] || bMin[0] > aMax[0]) return false;
  // Check for separation along the y (latitude) axis
  if (bMax[1] < aMin[1] || bMin[1] > aMax[1]) return false;
  return true;
}

/**
 * Normalize a string by converting to lower case and removing diacritics.
 *
 * @param {string} str input string
 * @returns {string} normalized string
 */
function normalize(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Display a temporary message in the drawing container (e.g. while
 * loading). This will replace any existing content.
 *
 * @param {string} msg message to display
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