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
// (stroke weight, colors, animation) can trigger a redraw without retyping.
let currentFeature = null;

// DOM references (initialised in init once the document is ready)
let inputEl;
let suggestionsEl;
let drawingContainer;

// Initialise after the DOM has loaded.  Without waiting for
// DOMContentLoaded the script would try to access elements that do
// not yet exist when loaded in the <head>.
window.addEventListener('DOMContentLoaded', () => {
  inputEl = document.getElementById('country-input');
  suggestionsEl = document.getElementById('suggestions');
  drawingContainer = document.getElementById('drawing-container');
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

  // Grab references to the style controls and set initial values
  const strokeWeightEl = document.getElementById('stroke-weight');
  const strokeColorEl = document.getElementById('stroke-color');
  const backgroundColorEl = document.getElementById('background-color');
  const animateEl = document.getElementById('animate-outline');

  // Apply initial background colour
  drawingContainer.style.backgroundColor = backgroundColorEl.value;

  // Whenever any of the style controls change, redraw the current feature (if any)
  function handleStyleChange() {
    // Update the container background immediately for background colour changes
    drawingContainer.style.backgroundColor = backgroundColorEl.value;
    if (currentFeature) {
      drawCountry(currentFeature);
    }
  }
  strokeWeightEl.addEventListener('change', handleStyleChange);
  strokeColorEl.addEventListener('input', handleStyleChange);
  backgroundColorEl.addEventListener('input', handleStyleChange);
  animateEl.addEventListener('change', handleStyleChange);
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
  drawCountry(feature);
  // store the selected feature so that changing styles can re-render it
  currentFeature = feature;
}

/**
 * Draw the selected country and overlay disputed border segments.
 *
 * @param {object} feature GeoJSON feature representing the selected country
 */
function drawCountry(feature) {
  // Clear any existing SVG
  drawingContainer.innerHTML = '';

  const { width, height } = drawingContainer.getBoundingClientRect();
  const svg = d3
    .select(drawingContainer)
    .append('svg')
    .attr('width', width)
    .attr('height', height);

  // Determine which projection to use based on the selected country.  Most
  // countries are rendered with the Equal Earth projection (a pseudocylindrical,
  // equal‑area projection) because it preserves north‑up orientation and
  // produces recognizable shapes【159340284396829†L36-L48】.  However, some
  // countries have parts far from the mainland—most notably the United
  // States (Alaska and Hawaii) and Russia (the far east)—which makes the
  // default projection overly wide.  For the United States we use the
  // built‑in Albers USA composite projection, which repositions and scales
  // Alaska and Hawaii so they fit neatly below the contiguous states.  For
  // Russia we rotate the Equal Earth projection to center the country’s
  // longitudinal midpoint, which tucks the far eastern territories closer
  // to the rest of the nation.  All other countries use the unrotated
  // Equal Earth projection.
  let projection;
  try {
    const props = feature.properties || {};
    // Normalized country name for matching presets
    const normName = normalize(props.name || props.NAME || props.name_long || props.NAME_LONG || '');
    const isoA3 = (props.iso_a3 || props.adm0_a3 || props.ADM0_A3 || '').toString().toUpperCase();
    if (isoA3 === 'USA' || normName === 'united states' || normName === 'united states of america') {
      // Use the Albers USA composite projection.  This projection relocates Alaska
      // and Hawaii and scales them appropriately relative to the contiguous
      // states.  It is part of the core d3-geo library.
      projection = d3.geoAlbersUsa();
    } else if (isoA3 === 'RUS' || normName === 'russia' || normName === 'russian federation') {
      // For Russia, rotate the Equal Earth projection so that the country’s
      // longitude midpoint sits at the prime meridian.  This reduces the
      // apparent width by keeping the far eastern territories close to the
      // mainland.  Compute the geographic bounds and average longitude to
      // determine the centre.
      const bounds = d3.geoBounds(feature);
      const minLon = bounds[0][0];
      const maxLon = bounds[1][0];
      // If the geometry crosses the antimeridian, adjust the longitudes to
      // produce a meaningful midpoint.  When maxLon < minLon (e.g. 170°E to
      // -170°W), wrap the values into a 360° range by adding 360° to the
      // negative longitude.
      let midpoint;
      if (maxLon < minLon) {
        // Example: minLon = 170, maxLon = -170.  Convert maxLon to 190 to
        // compute midpoint correctly ((170 + 190)/2 = 180).  After
        // computing the midpoint, bring it back to the -180–180 range.
        midpoint = (minLon + (maxLon + 360)) / 2;
        if (midpoint > 180) midpoint -= 360;
      } else {
        midpoint = (minLon + maxLon) / 2;
      }
      projection = d3.geoEqualEarth().rotate([-midpoint, 0]);
    } else {
      // Default projection for most countries
      projection = d3.geoEqualEarth();
    }
  } catch (e) {
    // Fallback to equal earth if anything goes wrong
    projection = d3.geoEqualEarth();
  }

  // Fit the projection to the available drawing area with padding on all
  // sides.  The fitExtent method sets the projection’s scale and
  // translation so that the feature occupies the rectangle defined by
  // [[padding, padding], [width − padding, height − padding]].  This keeps
  // the outline centered both horizontally and vertically with a margin
  // of space around it.
  // Always fit the projection to the drawing area.  The fitExtent method
  // adjusts the scale and translation so the geometry fills the available
  // space with a 20 px margin on each side.  Even composite projections
  // such as geoAlbersUsa can be fit using this method.  If the selected
  // projection does not implement fitExtent (unlikely in d3 v7), this call
  // will be ignored.
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

  const path = d3.geoPath().projection(projection);

  // Draw the country outline
  // Determine user-selected stroke weight and colour
  const strokeWeightEl = document.getElementById('stroke-weight');
  const strokeColorEl = document.getElementById('stroke-color');
  const animateEl = document.getElementById('animate-outline');
  const backgroundColorEl = document.getElementById('background-color');
  // Map stroke weight keywords to numeric stroke widths (in pixels)
  const strokeMap = { light: 1, medium: 2, heavy: 3 };
  const outlineWidth = strokeMap[strokeWeightEl.value] || 2;
  const disputedWidth = outlineWidth * 0.66; // slightly thinner for disputed lines
  const strokeColor = strokeColorEl.value || '#ffffff';
  const animate = animateEl.checked;
  // Update background colour of the drawing container
  drawingContainer.style.backgroundColor = backgroundColorEl.value;

  // Append the main outline path
  const mainPath = svg
    .append('path')
    .datum(feature)
    .attr('d', path)
    .attr('stroke', strokeColor)
    .attr('stroke-width', outlineWidth)
    .attr('fill', 'none');

  // If animation is enabled, draw the outline gradually over 20 seconds.
  if (animate) {
    const length = mainPath.node().getTotalLength();
    mainPath
      .attr('stroke-dasharray', length)
      .attr('stroke-dashoffset', length)
      .transition()
      .duration(20000)
      .ease(d3.easeLinear)
      .attr('stroke-dashoffset', 0)
      .on('end', () => {
        // Remove dash attributes after animation finishes for a clean outline
        mainPath.attr('stroke-dasharray', null).attr('stroke-dashoffset', null);
      });
  }

  // Compute bounding box of the selected country in geographic coordinates.
  const featureBbox = d3.geoBounds(feature);

  // Filter disputed lines that intersect the selected country's bbox.
  const relevantLines = precomputedDisputed.filter((d) =>
    intersects(featureBbox, d.bbox)
  );

  // Draw dashed disputed segments
  svg
    .selectAll('path.disputed')
    .data(relevantLines.map((d) => d.feature))
    .join('path')
    .attr('class', 'disputed')
    .attr('d', path)
    .attr('stroke', '#ff8080')
    .attr('stroke-width', disputedWidth)
    .attr('stroke-dasharray', '4,3')
    .attr('fill', 'none');
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