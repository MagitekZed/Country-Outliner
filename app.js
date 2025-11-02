/*
 * Country Outliner – v1.2.0
 *
 * This script powers the responsive, themeable country outline viewer.  It leverages D3
 * for geo projections and TopoJSON parsing, Fuse.js for fuzzy country name search, and
 * PixiJS for rich WebGL drawing and effects.  Three visual themes are included by
 * default: Neon, Wireframe Glow and Blueprint.  Additional themes can be added by
 * extending the THEMES object below.  A simple check for WebGL support is used to
 * gracefully notify users on outdated browsers.
 */

(function () {
    // Check for WebGL support up front.  If unsupported, reveal the compatibility message
    // and abort script execution.  This keeps the rest of the code simple and avoids
    // maintaining separate rendering engines.
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) {
        document.getElementById('compat-message').classList.remove('hidden');
        document.getElementById('app').style.display = 'none';
        return;
    }

    // References to DOM elements
    const searchInput = document.getElementById('country-search');
    const autocompleteList = document.getElementById('autocomplete');
    const menuToggle = document.getElementById('menu-toggle');
    const controlPanel = document.getElementById('control-panel');
    const themeSelect = document.getElementById('theme-select');
    const paletteSelect = document.getElementById('palette-select');
    const animateCheckbox = document.getElementById('animate-checkbox');
    const durationSlider = document.getElementById('duration-slider');
    const durationValueLabel = document.getElementById('duration-value');
    const mapContainer = document.getElementById('map-container');

    // Application state
    let countryFeatures = [];
    let fuse = null;
    let currentFeature = null;
    let currentThemeKey = null;
    let currentPaletteIndex = 0;
    let drawingTicker = null;

    // Create and attach the Pixi application to the map container.  The
    // `resizeTo` option causes Pixi to resize its canvas automatically when the
    // container’s dimensions change.
    const pixiApp = new PIXI.Application({
        backgroundAlpha: 0,
        resizeTo: mapContainer,
        antialias: true,
        autoDensity: true
    });
    mapContainer.appendChild(pixiApp.view);

    // Container for country graphics.  We recreate this container every time a new
    // country is selected in order to cleanly dispose of previous shapes and filters.
    let countryContainer = null;

    /**
     * Definition of visual themes.  Each theme provides a display name, one or more
     * preset palettes, and lifecycle hooks to apply custom filters or effects.
     *
     * Each theme entry exposes:
     *  - `name`: Human‑readable theme name for the UI.
     *  - `palettes`: Array of palette objects.  Each palette has a `name` field and
     *     a `stroke` colour (in hex integer form) that defines the primary line colour.
     *  - `apply`: Called when drawing begins; sets up filters on the container
     *     based on the chosen palette.  It receives `(container, palette)`.
     *  - `onFrame`: Called on every animation frame during drawing.  Used to
     *     animate flicker or emit particles.  Receives `(container, headPosition, progress)`.
     *  - `onComplete`: Called once the outline has fully drawn; used to settle
     *     animations or adjust final appearance.  Receives `(container)`.
     */
    const THEMES = {
        neon: {
            name: 'Neon',
            palettes: [
                { name: 'Cyan', stroke: 0x00e5ff },
                { name: 'Magenta', stroke: 0xff00ff },
                { name: 'Lime', stroke: 0x00ff88 },
                { name: 'Orange', stroke: 0xffa500 }
            ],
            apply(container, palette) {
                // Apply a strong outer glow around the stroke.  The GlowFilter
                // distance controls the radius of the blur, and outerStrength
                // controls the brightness.
                const glow = new PIXI.filters.GlowFilter({
                    distance: 15,
                    outerStrength: 4,
                    innerStrength: 0,
                    color: palette.stroke,
                    quality: 0.5
                });
                container.filters = [glow];
            },
            onFrame(container, headPosition, progress) {
                // Introduce a subtle flicker effect by modulating the container
                // alpha.  The fluctuation is very small so as not to distract.
                container.alpha = 0.98 + (Math.random() * 0.04);
            },
            onComplete(container) {
                // Stabilize alpha when animation completes.  Remove flicker.
                container.alpha = 1;
            }
        },
        glow: {
            name: 'Wireframe Glow',
            palettes: [
                { name: 'Electric Blue', stroke: 0x33b5e5 },
                { name: 'Violet', stroke: 0x9966cc },
                { name: 'Mint', stroke: 0x64ffda },
                { name: 'Hot Pink', stroke: 0xf06292 }
            ],
            apply(container, palette) {
                const glow = new PIXI.filters.GlowFilter({
                    distance: 10,
                    outerStrength: 2.2,
                    innerStrength: 0,
                    color: palette.stroke,
                    quality: 0.6
                });
                container.filters = [glow];
            },
            onFrame() {
                // No per‑frame behaviour for this theme.
            },
            onComplete() {
                // No post‑draw adjustments.
            }
        },
        blueprint: {
            name: 'Blueprint',
            palettes: [
                { name: 'Classic', stroke: 0xaecfff },
                { name: 'Teal', stroke: 0x4db6ac },
                { name: 'Indigo', stroke: 0x5c6bc0 },
                { name: 'Sky', stroke: 0x81d4fa }
            ],
            apply(container, palette) {
                // Use a soft drop shadow to evoke depth on a dark backdrop.  The
                // shadow colour is a little darker than the stroke to emulate
                // blueprint chalk outlines.
                const dropShadow = new PIXI.filters.DropShadowFilter({
                    distance: 4,
                    rotation: 45,
                    blur: 4,
                    color: palette.stroke,
                    alpha: 0.6,
                    quality: 0.5
                });
                container.filters = [dropShadow];
            },
            onFrame() {
                // Blueprint remains static during draw.
            },
            onComplete() {
                // Nothing extra on completion.
            }
        }
    };

    /**
     * Populate the theme select dropdown based on the THEMES definition.
     */
    function populateThemeSelect() {
        Object.keys(THEMES).forEach(key => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = THEMES[key].name;
            themeSelect.appendChild(opt);
        });
        // Set default theme
        currentThemeKey = Object.keys(THEMES)[0];
        themeSelect.value = currentThemeKey;
    }

    /**
     * Populate the palette select dropdown based on the currently selected theme.
     */
    function populatePaletteSelect() {
        const theme = THEMES[currentThemeKey];
        paletteSelect.innerHTML = '';
        theme.palettes.forEach((pal, idx) => {
            const opt = document.createElement('option');
            opt.value = idx;
            opt.textContent = pal.name;
            paletteSelect.appendChild(opt);
        });
        currentPaletteIndex = 0;
        paletteSelect.value = '0';
    }

    /**
     * Fetch and parse the world countries dataset.  Builds an array of objects
     * suitable for the search index and initializes Fuse.js.  If properties
     * expected in the TopoJSON are missing, this function falls back to using
     * the feature’s `id` as its name.
     */
    async function loadCountries() {
        const topo = await d3.json('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json');
        const features = topojson.feature(topo, topo.objects.countries).features;
        const items = [];
        for (const f of features) {
            const props = f.properties || {};
            // Prefer the NAME field, falling back to NAME_LONG or id.
            const name = props.name || props.name_long || f.id;
            items.push({ name, feature: f });
        }
        // Sort alphabetically for consistent ordering.
        items.sort((a, b) => a.name.localeCompare(b.name));
        countryFeatures = items;
        // Initialise Fuse for fuzzy searching across country names.  The threshold
        // controls how exact the match must be; lower thresholds return fewer
        // results but higher relevance.
        fuse = new Fuse(countryFeatures, {
            keys: ['name'],
            threshold: 0.3
        });
    }

    /**
     * Display autocomplete suggestions for the search box.  Uses the Fuse.js
     * results to build the list.  Clicking a suggestion will populate the
     * input and trigger a draw.
     */
    function showAutocomplete(query) {
        // Clear previous suggestions
        autocompleteList.innerHTML = '';
        if (!query || query.trim().length < 1) {
            autocompleteList.style.display = 'none';
            return;
        }
        const results = fuse.search(query, { limit: 10 });
        if (!results.length) {
            autocompleteList.style.display = 'none';
            return;
        }
        results.forEach(res => {
            const div = document.createElement('div');
            div.classList.add('item');
            div.textContent = res.item.name;
            div.addEventListener('click', () => {
                searchInput.value = res.item.name;
                autocompleteList.style.display = 'none';
                selectCountryByName(res.item.name);
            });
            autocompleteList.appendChild(div);
        });
        autocompleteList.style.display = 'block';
    }

    /**
     * Locate a feature by its name and invoke the draw logic.  If no matching
     * feature is found, nothing happens.
     */
    function selectCountryByName(name) {
        const match = countryFeatures.find(c => c.name === name);
        if (match) {
            currentFeature = match.feature;
            drawCurrentFeature();
        }
    }

    /**
     * Compute the projected rings for the current feature and render the outline
     * using PixiJS.  Existing graphics are disposed of and a new container
     * created for the new draw.  Animation is handled with a ticker that
     * progressively reveals the lines; when disabled the outline is drawn
     * immediately.
     */
    function drawCurrentFeature() {
        if (!currentFeature) return;
        // Dispose of any previous container and its children/filters to avoid
        // memory leaks.  Remove ticker if present.
        if (countryContainer) {
            pixiApp.stage.removeChild(countryContainer);
            countryContainer.destroy({ children: true, texture: false, baseTexture: false });
            countryContainer = null;
        }
        if (drawingTicker) {
            pixiApp.ticker.remove(drawingTicker);
            drawingTicker = null;
        }
        // Create a new container for the current country.
        countryContainer = new PIXI.Container();
        pixiApp.stage.addChild(countryContainer);
        // Apply the selected theme's effect immediately.  We pass in the
        // container and the currently selected palette definition.  Note that
        // filters apply after drawing has started; applying here ensures that
        // glow/drop shadows are present even before the animation begins.
        const theme = THEMES[currentThemeKey];
        const palette = theme.palettes[currentPaletteIndex];
        theme.apply(countryContainer, palette);
        // Determine projection and scaling.  Use d3.geoEqualEarth as a base
        // projection for all countries; fitExtent will reposition and scale
        // the projection to occupy the map container with a margin.
        const bboxPadding = 20;
        const width = mapContainer.clientWidth;
        const height = mapContainer.clientHeight;
        const projection = d3.geoEqualEarth();
        const path = d3.geoPath(projection);
        projection.fitExtent(
            [[bboxPadding, bboxPadding], [width - bboxPadding, height - bboxPadding]],
            currentFeature
        );
        // Extract rings (all polygon parts) from the feature.  Both Polygons
        // and MultiPolygons are handled.
        const rings = [];
        const geom = currentFeature.geometry;
        if (geom.type === 'Polygon') {
            geom.coordinates.forEach(r => rings.push(r));
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates.forEach(poly => {
                poly.forEach(r => rings.push(r));
            });
        }
        // Project coordinates to screen points.  Also compute total length
        // across all rings for animation progress.
        const paths = [];
        let totalLength = 0;
        rings.forEach(ring => {
            const pts = [];
            let ringLength = 0;
            for (let i = 0; i < ring.length; i++) {
                const coord = ring[i];
                const [x, y] = projection(coord);
                pts.push([x, y]);
                if (i > 0) {
                    const dx = x - pts[i - 1][0];
                    const dy = y - pts[i - 1][1];
                    ringLength += Math.hypot(dx, dy);
                }
            }
            paths.push({ points: pts, length: ringLength });
            totalLength += ringLength;
        });
        // Determine line width relative to canvas size.  Use a base width of
        // 1.5px but scale up slightly on high‑DPI or large displays.
        const lineWidth = Math.max(1.5, Math.min(width, height) / 400);
        // Create a Graphics object for each ring.  We store these to update
        // them progressively during animation.
        const graphicsList = paths.map(() => new PIXI.Graphics());
        graphicsList.forEach(g => countryContainer.addChild(g));
        // If animation is disabled, draw everything immediately and exit.
        if (!animateCheckbox.checked) {
            graphicsList.forEach((graphics, idx) => {
                const p = paths[idx].points;
                graphics.lineStyle(lineWidth, palette.stroke, 1);
                graphics.moveTo(p[0][0], p[0][1]);
                for (let i = 1; i < p.length; i++) {
                    graphics.lineTo(p[i][0], p[i][1]);
                }
            });
            // Finalise theme after drawing.
            theme.onComplete(countryContainer);
            return;
        }
        // Otherwise animate the draw.  Define a ticker callback that draws
        // partial paths based on elapsed time.  The duration slider
        // represents seconds; convert to milliseconds.
        const durationMs = parseFloat(durationSlider.value) * 1000;
        const startTime = performance.now();
        drawingTicker = delta => {
            const now = performance.now();
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / durationMs, 1);
            const currentLength = totalLength * progress;
            // Determine which segment the head is in for the particle system
            let remaining = currentLength;
            let headPos = null;
            // Draw each ring progressively
            for (let i = 0; i < paths.length; i++) {
                const { points, length } = paths[i];
                const graphics = graphicsList[i];
                graphics.clear();
                graphics.lineStyle(lineWidth, palette.stroke, 1);
                if (remaining <= 0) {
                    // Nothing to draw for this ring yet
                    continue;
                }
                if (remaining >= length) {
                    // Draw the full ring and close it back to the starting point.  
                    graphics.moveTo(points[0][0], points[0][1]);
                    for (let j = 1; j < points.length; j++) {
                        graphics.lineTo(points[j][0], points[j][1]);
                    }
                    // Close the ring to avoid a visible gap.
                    graphics.lineTo(points[0][0], points[0][1]);
                    remaining -= length;
                    continue;
                }
                // Draw partial segment
                let segRemaining = remaining;
                graphics.moveTo(points[0][0], points[0][1]);
                for (let j = 1; j < points.length; j++) {
                    const x0 = points[j - 1][0];
                    const y0 = points[j - 1][1];
                    const x1 = points[j][0];
                    const y1 = points[j][1];
                    const segLen = Math.hypot(x1 - x0, y1 - y0);
                    if (segRemaining >= segLen) {
                        graphics.lineTo(x1, y1);
                        segRemaining -= segLen;
                    } else {
                        const ratio = segRemaining / segLen;
                        const hx = x0 + (x1 - x0) * ratio;
                        const hy = y0 + (y1 - y0) * ratio;
                        graphics.lineTo(hx, hy);
                        headPos = { x: hx, y: hy };
                        segRemaining = 0;
                        break;
                    }
                }
                remaining = 0;
            }
            // If head position hasn’t been computed (e.g. because the current
            // length spans multiple full rings), set it to the last point of
            // the last ring for theme onFrame calls.
            if (!headPos && paths.length) {
                const lastPoints = paths[paths.length - 1].points;
                headPos = {
                    x: lastPoints[lastPoints.length - 1][0],
                    y: lastPoints[lastPoints.length - 1][1]
                };
            }
            // Call theme per‑frame hook.
            theme.onFrame(countryContainer, headPos, progress);
            // When progress reaches 1, stop the ticker and finalise.
            if (progress >= 1) {
                pixiApp.ticker.remove(drawingTicker);
                drawingTicker = null;
                theme.onComplete(countryContainer);
            }
        };
        pixiApp.ticker.add(drawingTicker);
    }

    /**
     * Initialise the application by loading country data and hooking up UI event
     * handlers.  This function is invoked immediately at the end of the IIFE.
     */
    async function init() {
        await loadCountries();
        populateThemeSelect();
        populatePaletteSelect();
        // Attach event listeners
        searchInput.addEventListener('input', () => {
            showAutocomplete(searchInput.value);
        });
        searchInput.addEventListener('focus', () => {
            if (searchInput.value) showAutocomplete(searchInput.value);
        });
        searchInput.addEventListener('blur', () => {
            // Delay hiding so click events still register
            setTimeout(() => {
                autocompleteList.style.display = 'none';
            }, 150);
        });
        themeSelect.addEventListener('change', () => {
            currentThemeKey = themeSelect.value;
            populatePaletteSelect();
            if (currentFeature) drawCurrentFeature();
        });
        paletteSelect.addEventListener('change', () => {
            currentPaletteIndex = parseInt(paletteSelect.value, 10);
            if (currentFeature) drawCurrentFeature();
        });
        animateCheckbox.addEventListener('change', () => {
            if (currentFeature) drawCurrentFeature();
        });
        durationSlider.addEventListener('input', () => {
            durationValueLabel.textContent = durationSlider.value;
            // If user changes duration mid-animation, restart the draw to honour
            // the new speed.
            if (currentFeature && animateCheckbox.checked) {
                drawCurrentFeature();
            }
        });
        // Toggle control panel on small screens
        menuToggle.addEventListener('click', () => {
            const isOpen = controlPanel.classList.contains('open');
            if (isOpen) {
                controlPanel.classList.remove('open');
            } else {
                controlPanel.classList.add('open');
            }
        });
    }
    // Immediately invoke init to kick off the application.
    init();
})();