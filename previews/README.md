# Tool preview uploads

This folder holds poster images that show up on the landing page when a tool does not have a video preview. To replace the generated SVG placeholders with real screenshots:

1. Capture a screenshot of the tool's main view (PNG or JPG is fine).
2. Name the file after the tool slug used in `tool-manifest.js` (for example, `grid_permutations.png`).
3. Save it in this `previews/` folder and update the corresponding `poster` path in `tool-manifest.js` to point at your file.

Once the poster path is set, `index.html` will automatically show the uploaded image instead of the "Preview unavailable" fallback.
