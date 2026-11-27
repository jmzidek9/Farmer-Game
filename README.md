# Farmer-Game

Harvest Haven comes in two versions. Double-click either file to play:

| Version | File | Source |
|---|---|---|
| **Realistic**: Blender textures, realistic trees, sculpted mountain, ocean waves | `Harvest Haven - Realistic.html` | repo root (`index.html`, `src/`, `assets/`) |
| **Low Poly**: the original low-poly look and island | `Harvest Haven - Low Poly.html` | `lowpoly/` |

Each version keeps its own save and settings, so playing one doesn't overwrite the other.

To rebuild after changing code: `python tools/build.py` builds both (`python tools/build.py realistic` or `lowpoly` builds one).
