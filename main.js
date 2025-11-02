/*
 * Country Outliner v1.2.1
 *
 * This script bootstraps the PixiJS-based renderer, loads geographic data,
 * builds the user interface, and orchestrates drawing animated country
 * outlines.  Themes are defined at the bottom of this file; each one
 * encapsulates styling and filter configuration for different visual
 * aesthetics.  The engine requires WebGL; when unsupported a fallback
 * message is displayed instead of attempting to draw via Canvas or SVG.
 */

(() => {
  // Alias mapping for common country synonyms. Keys are lower-cased for
  // comparison. Values correspond to the canonical Natural Earth names in
  // the dataset. Extend this mapping to support more informal names.
  const aliasMapping = {
    "usa": "United States of America",
    "us": "United States of America",
    "united states": "United States of America",
    "united states of america": "United States of America",
    "u.s.": "United States of America",
    "uk": "United Kingdom",
    "great britain": "United Kingdom",
    "britain": "United Kingdom",
    "russia": "Russia",
    "czech republic": "Czechia",
    "ivory coast": "Côte d’Ivoire",
    "cote d'ivoire": "Côte d’Ivoire",
    "south korea": "South Korea",
    "north korea": "North Korea",
    "uae": "United Arab Emirates",
    "vatican": "Vatican",
    "vatican city": "Vatican",
    "drc": "Dem. Rep. Congo",
    "democratic republic of the congo": "Dem. Rep. Congo",
    "swaziland": "eSwatini",
    "eswatini": "eSwatini",
    "laos": "Laos",
    "bolivia": "Bolivia",
    "venezuela": "Venezuela",
    "tanzania": "Tanzania"
  };

  // Grab DOM references
  const compatMessage = document.getElementById('compat-message');
  const appContainer = document.getElementById('app');
  const mapContainer = document.getElementById('map-container');
  const countryInput = document.getElementById('country-input');
  const countriesList = document.getElementById('countries-list');
  const themeSelect = document.getElementById('theme-select');
  const accentInput = document.getElementById('accent-color');
  const animateToggle = document.getElementById('animate-toggle');
  const durationSlider = document.getElementById('duration-slider');
  const durationDisplay = document.getElementById('duration-display');
  const perfToggle = document.getElementById('perf-toggle');
  const menuToggle = document.getElementById('menu-toggle');
  const topBar = document.querySelector('.top-bar');

  // App state
  const state = {
    features: [],       // loaded GeoJSON country features
    app: null,          // PIXI.Application instance
    strokeContainer: null,
    fillContainer: null,
    maskGraphics: null,
    currentRings: [],
    animationFrame: null,
    startTime: null,
    duration: 20000,    // milliseconds; updated from slider
    animate: true,
    perfMode: false,
    theme: null,        // current theme object
    accentColor: accentInput ? accentInput.value : '#00ffff',
    projection: null,
    currentFeature: null
  };

  // Define themes.  Each theme defines functions to apply filters and style
  // properties to the stroke container, to update per-frame state (tick)
  // and to finalise after animation completes (complete).  When adding
  // additional themes keep the method signatures consistent.
  const themes = {
    neon: {
      name: 'Neon',
      apply(context) {
        const { strokeContainer, accentColor } = context;
        // Set blend mode to additive so glows accumulate
        strokeContainer.blendMode = PIXI.BLEND_MODES.ADD;
        // Create glow filter with accent colour
        const color = PIXI.utils.string2hex(accentColor);
        const glow = new PIXI.filters.GlowFilter({
          distance: 20,
          outerStrength: 4,
          innerStrength: 0,
          color
        });
        strokeContainer.filters = [glow];
        // Slight flicker by modifying alpha in tick
        context._flickerPhase = 0;
      },
      tick(context, progress) {
        // Random flicker around 0.98–1.0 to simulate neon flicker
        if (!context.animate) return;
        if (context._flickerPhase === undefined) context._flickerPhase = 0;
        context._flickerPhase += 0.1;
        if (context._flickerPhase > 1) context._flickerPhase = 0;
        const jitter = 0.98 + Math.random() * 0.03;
        context.strokeContainer.alpha = jitter;
      },
      complete(context) {
        context.strokeContainer.alpha = 1;
        // Keep glow active after animation
      }
    },
    wireframe: {
      name: 'Wireframe Glow',
      apply(context) {
        const { strokeContainer, accentColor } = context;
        strokeContainer.blendMode = PIXI.BLEND_MODES.NORMAL;
        // More subtle glow
        const color = PIXI.utils.string2hex(accentColor);
        const glow = new PIXI.filters.GlowFilter({
          distance: 10,
          outerStrength: 1.5,
          innerStrength: 0,
          color
        });
        strokeContainer.filters = [glow];
      },
      tick(context, progress) {
        // No per-frame updates necessary
      },
      complete(context) {
        // Nothing extra on completion
      }
    },
    blueprint: {
      name: 'Blueprint',
      apply(context) {
        const { strokeContainer, fillContainer, accentColor } = context;
        // Use normal blending and drop shadow to simulate blueprint lines
        strokeContainer.blendMode = PIXI.BLEND_MODES.NORMAL;
        const color = PIXI.utils.string2hex(accentColor);
        // Drop shadow filter for blueprint effect
        const drop = new PIXI.filters.DropShadowFilter({
          distance: 4,
          color,
          alpha: 0.6,
          blur: 3,
          rotation: 45
        });
        strokeContainer.filters = [drop];
        // Fill colour slightly transparent, using accent colour at 20% opacity
        context.fillColor = accentColor + '33';
      },
      tick(context, progress) {
        // No per-frame updates for blueprint
      },
      complete(context) {
        // Fill appears on completion; handled outside
      }
    }
  };

  // Utility: remove diacritics and lower-case for searching
  function normalizeName(str) {
    return str.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  }

  // Initialize the application once DOMContentLoaded and scripts loaded
  function init() {
    // Check WebGL support
    if (!PIXI.utils.isWebGLSupported()) {
      compatMessage.classList.remove('hidden');
      return;
    }
    compatMessage.classList.add('hidden');
    appContainer.classList.remove('hidden');

    // Initialise PixiJS application and append to map container
    state.app = new PIXI.Application({
      resizeTo: mapContainer,
      antialias: true,
      backgroundAlpha: 0
    });
    mapContainer.appendChild(state.app.view);

    // Create containers for stroke and fill
    state.strokeContainer = new PIXI.Container();
    state.fillContainer = new PIXI.Container();
    state.app.stage.addChild(state.fillContainer);
    state.app.stage.addChild(state.strokeContainer);

    // Mask graphics (drawn per-frame)
    state.maskGraphics = new PIXI.Graphics();

    // Load geographic data
    Promise.all([
      fetch('https://unpkg.com/world-atlas@2.0.2/countries-50m.json').then(r => r.json()),
      // Boundary lines for disputed borders (optional). Fetch failures are ignored.
      fetch('https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_boundary_lines_land.geojson')
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    ]).then(([topology, boundaries]) => {
      // Convert TopoJSON to GeoJSON features
      const geo = topojson.feature(topology, topology.objects.countries).features;
      state.features = geo;
      state.boundaries = boundaries;
      buildCountryList();
    });

    // Event listeners
    countryInput.addEventListener('change', onCountrySelected);
    themeSelect.addEventListener('change', onThemeChange);
    accentInput.addEventListener('input', onAccentChange);
    animateToggle.addEventListener('change', onAnimateToggle);
    durationSlider.addEventListener('input', onDurationChange);
    perfToggle.addEventListener('change', onPerfToggle);
    menuToggle.addEventListener('click', onMenuToggle);
    window.addEventListener('resize', onResize);
    // Update duration display initial
    durationDisplay.textContent = durationSlider.value + 's';
    // Set initial theme
    state.theme = themes[themeSelect.value];
    // Attempt to draw the first country if a value has been typed
    // Note: drawCountry will be invoked when the user selects from the list.
  }

  // Build the datalist options based on loaded features and alias mapping
  function buildCountryList() {
    if (!countriesList) return;
    // Clear existing options
    countriesList.innerHTML = '';
    const added = new Set();
    state.features.forEach(f => {
      const name = f.properties.name;
      if (!added.has(name)) {
        const option = document.createElement('option');
        option.value = name;
        countriesList.appendChild(option);
        added.add(name);
      }
    });
    // Add aliases
    Object.keys(aliasMapping).forEach(alias => {
      const canonical = aliasMapping[alias];
      if (!added.has(alias)) {
        const option = document.createElement('option');
        option.value = alias;
        countriesList.appendChild(option);
      }
    });
  }

  // Resolve the user input to a canonical feature name
  function resolveCountryName(input) {
    if (!input) return null;
    const key = normalizeName(input.trim());
    if (aliasMapping[key]) {
      return aliasMapping[key];
    }
    // Try to find feature with matching name (case-insensitive, diacritics-insensitive)
    for (const f of state.features) {
      if (normalizeName(f.properties.name) === key) {
        return f.properties.name;
      }
    }
    return null;
  }

  // Called when a country is selected or input changes
  function onCountrySelected() {
    const inputVal = countryInput.value;
    const canonical = resolveCountryName(inputVal);
    if (!canonical) {
      // No match; do nothing
      return;
    }
    drawCountry(canonical);
  }

  // Apply theme change
  function onThemeChange() {
    const key = themeSelect.value;
    state.theme = themes[key] || themes.neon;
    if (state.currentFeature) {
      drawCountry(state.currentFeature.properties.name);
    }
  }

  // Change accent color
  function onAccentChange() {
    state.accentColor = accentInput.value;
    if (state.currentFeature) {
      drawCountry(state.currentFeature.properties.name);
    }
  }

  // Toggle animation
  function onAnimateToggle() {
    state.animate = animateToggle.checked;
    if (state.currentFeature) {
      drawCountry(state.currentFeature.properties.name);
    }
  }

  // Update duration
  function onDurationChange() {
    const seconds = parseInt(durationSlider.value, 10);
    state.duration = seconds * 1000;
    durationDisplay.textContent = seconds + 's';
    if (state.currentFeature) {
      drawCountry(state.currentFeature.properties.name);
    }
  }

  // Performance mode toggle
  function onPerfToggle() {
    state.perfMode = perfToggle.checked;
    if (state.currentFeature) {
      drawCountry(state.currentFeature.properties.name);
    }
  }

  // Menu toggle for small screens
  function onMenuToggle() {
    topBar.classList.toggle('advanced-hidden');
  }

  // Window resize handler; re-fit current feature to new dimensions
  function onResize() {
    if (state.currentFeature) {
      drawCountry(state.currentFeature.properties.name);
    }
  }

  // Compute projection and ring data for a feature
  function computeRings(feature) {
    // Determine projection: special case for USA
    let projection;
    const name = feature.properties.name;
    if (name === 'United States of America') {
      projection = d3.geoAlbersUsa();
    } else {
      const centroid = d3.geoCentroid(feature);
      const [clon] = centroid;
      projection = d3.geoEqualEarth().rotate([-clon, 0]);
    }
    // Fit projection into map container with 20px padding
    const width = mapContainer.clientWidth;
    const height = mapContainer.clientHeight;
    const padding = 20;
    projection.fitExtent([[padding, padding], [width - padding, height - padding]], feature);
    // Convert geometry to rings of projected points
    const geo = feature.geometry;
    const rings = [];
    // Helper to process a polygon
    function processPolygon(coords) {
      coords.forEach((ringCoords) => {
        const pts = ringCoords.map(coord => projection(coord));
        // Compute segment lengths
        let length = 0;
        const segments = [];
        for (let i = 0; i < pts.length - 1; i++) {
          const dx = pts[i + 1][0] - pts[i][0];
          const dy = pts[i + 1][1] - pts[i][1];
          const segLen = Math.hypot(dx, dy);
          segments.push(segLen);
          length += segLen;
        }
        rings.push({ points: pts, segments, length });
      });
    }
    if (geo.type === 'Polygon') {
      processPolygon(geo.coordinates);
    } else if (geo.type === 'MultiPolygon') {
      geo.coordinates.forEach(processPolygon);
    }
    return { rings, projection };
  }

  // Draw the selected country
  function drawCountry(name) {
    // Cancel any existing animation
    if (state.animationFrame) {
      cancelAnimationFrame(state.animationFrame);
      state.animationFrame = null;
    }
    state.startTime = null;
    // Find feature by name
    const feature = state.features.find(f => f.properties.name === name);
    if (!feature) return;
    state.currentFeature = feature;
    // Compute rings and projection
    const { rings, projection } = computeRings(feature);
    state.currentRings = rings;
    state.projection = projection;
    // Clear previous drawings
    state.strokeContainer.removeChildren();
    state.fillContainer.removeChildren();
    state.maskGraphics.clear();
    // Create stroke graphics (full path drawn once)
    const strokeG = new PIXI.Graphics();
    strokeG.strokeGraphic = true; // marker to adjust later
    const strokeWidth = state.perfMode ? 1.5 : 2.5;
    strokeG.lineStyle(strokeWidth, PIXI.utils.string2hex(state.accentColor), 1);
    rings.forEach(ring => {
      const pts = ring.points;
      if (pts.length > 0) {
        strokeG.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          strokeG.lineTo(pts[i][0], pts[i][1]);
        }
      }
    });
    state.strokeContainer.addChild(strokeG);
    // Create fill graphics (for blueprint theme)
    const fillG = new PIXI.Graphics();
    rings.forEach(ring => {
      const pts = ring.points;
      if (pts.length > 0) {
        fillG.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          fillG.lineTo(pts[i][0], pts[i][1]);
        }
      }
    });
    state.fillContainer.addChild(fillG);
    // Store references for theme
    state.strokeGraphics = strokeG;
    state.fillGraphics = fillG;
    // Apply theme styling
    applyCurrentTheme();
    // Hide fill until completion
    state.fillContainer.visible = false;
    // Setup mask
    state.maskGraphics.clear();
    // Initially assign mask if animating
    if (state.animate) {
      strokeG.mask = state.maskGraphics;
    } else {
      strokeG.mask = null;
    }
    // Start animation or draw full
    if (state.animate) {
      state.startTime = performance.now();
      animateFrame();
    } else {
      // No animation: reveal full stroke immediately and fill if blueprint
      strokeG.mask = null;
      if (state.theme.name === 'Blueprint') {
        state.fillContainer.visible = true;
        state.fillGraphics.clear();
        // Fill with theme-specified fill color
        rings.forEach(ring => {
          const pts = ring.points;
          if (pts.length > 0) {
            state.fillGraphics.beginFill(PIXI.utils.string2hex(state.fillColor));
            state.fillGraphics.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) {
              state.fillGraphics.lineTo(pts[i][0], pts[i][1]);
            }
            state.fillGraphics.endFill();
          }
        });
      }
      // Force theme complete stage
      if (state.theme.complete) {
        state.theme.complete(state);
      }
    }
  }

  // Apply filters and styling for the current theme
  function applyCurrentTheme() {
    // Reset filters and blend modes
    state.strokeContainer.filters = [];
    state.strokeContainer.blendMode = PIXI.BLEND_MODES.NORMAL;
    // Clear fill; will be filled on completion if theme needs
    state.fillContainer.children.forEach(child => {
      child.clear?.();
    });
    // Set accent and fill color on container context
    const context = {
      strokeContainer: state.strokeContainer,
      fillContainer: state.fillContainer,
      accentColor: state.accentColor,
      perfMode: state.perfMode,
      animate: state.animate,
      fillColor: null
    };
    // Apply theme
    if (state.theme && state.theme.apply) {
      state.theme.apply(context);
    }
    // Save any fillColor back
    if (context.fillColor) {
      state.fillColor = context.fillColor;
    } else {
      state.fillColor = state.accentColor + '33';
    }
  }

  // Animation loop
  function animateFrame(now) {
    state.animationFrame = requestAnimationFrame(animateFrame);
    if (!state.startTime) state.startTime = now;
    const elapsed = now - state.startTime;
    let progress = Math.min(elapsed / state.duration, 1);
    // Clear mask
    const mg = state.maskGraphics;
    mg.clear();
    // Draw partial mask for each ring
    const strokeWidth = state.perfMode ? 1.5 : 2.5;
    mg.lineStyle(strokeWidth + 2, 0xffffff, 1);
    state.currentRings.forEach(ring => {
      const drawLen = progress * ring.length;
      let remaining = drawLen;
      const pts = ring.points;
      const segs = ring.segments;
      if (pts.length === 0) return;
      mg.moveTo(pts[0][0], pts[0][1]);
      let drawnFirst = false;
      for (let i = 0; i < segs.length; i++) {
        const segLen = segs[i];
        if (remaining >= segLen) {
          // draw full segment
          mg.lineTo(pts[i + 1][0], pts[i + 1][1]);
          remaining -= segLen;
        } else {
          // draw partial segment
          const ratio = segLen === 0 ? 0 : (remaining / segLen);
          const dx = pts[i + 1][0] - pts[i][0];
          const dy = pts[i + 1][1] - pts[i][1];
          const x = pts[i][0] + dx * ratio;
          const y = pts[i][1] + dy * ratio;
          mg.lineTo(x, y);
          break;
        }
      }
    });
    // Per-theme tick
    if (state.theme && state.theme.tick) {
      state.theme.tick(state, progress);
    }
    // Completion
    if (progress >= 1) {
      // Remove mask so full stroke shows
      state.strokeGraphics.mask = null;
      state.maskGraphics.clear();
      // Draw fill if blueprint theme
      if (state.theme.name === 'Blueprint') {
        // Fill geometry
        state.fillGraphics.clear();
        state.currentRings.forEach(ring => {
          const pts = ring.points;
          if (pts.length > 0) {
            state.fillGraphics.beginFill(PIXI.utils.string2hex(state.fillColor));
            state.fillGraphics.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) {
              state.fillGraphics.lineTo(pts[i][0], pts[i][1]);
            }
            state.fillGraphics.endFill();
          }
        });
        state.fillContainer.visible = true;
      }
      // Call theme complete
      if (state.theme && state.theme.complete) {
        state.theme.complete(state);
      }
      cancelAnimationFrame(state.animationFrame);
      state.animationFrame = null;
    }
  }

  // Kick off initialization after all dependencies are loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();