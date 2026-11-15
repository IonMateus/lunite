# References and credits

Data (all public NASA / IAU sources; raw files, URLs and SHA-256 in `tools/raw_manifest.json`):

- **LOLA terrain:** NASA LRO Lunar Orbiter Laser Altimeter, gridded data records (LDEM), PDS Geosciences Node, Washington University in St. Louis. https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/
- **LOLA illumination maps:** average Sun/Earth visibility, south pole, PDS EXTRAS. https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/extras/illumination/
- **Ephemerides:** JPL Horizons API (DE441, MOON_ME frame). https://ssd.jpl.nasa.gov/horizons/
- **Landing-site coordinates:**
  - NASA NSSDCA. https://nssdc.gsfc.nasa.gov/planetary/lunar/apolloland.html
  - LROC (NASA/ASU). https://www.lroc.asu.edu/
  - IAU/USGS Gazetteer of Planetary Nomenclature. https://planetarynames.wr.usgs.gov/
  - NASA Artemis III regions. https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/
- **Textures (visual only):** NASA Scientific Visualization Studio.
  - CGI Moon Kit 4720. https://svs.gsfc.nasa.gov/4720
  - VIIRS Earth 30763. https://svs.gsfc.nasa.gov/30763
  - Black Marble 30876. https://svs.gsfc.nasa.gov/30876

Code:

- **three.js r160:** MIT licence, see `vendor/three-LICENSE.txt`. https://threejs.org
- Everything else in this repository was written for this project, with AI assistance (Claude).
