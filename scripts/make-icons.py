#!/usr/bin/env python3
"""Rebuilds every app icon from ONE master file: icons/maskable-512.png

To change the icon: replace icons/maskable-512.png with your own 512x512 PNG, then run
    pip install pillow
    python3 scripts/make-icons.py

Make the master a full square with a solid background and keep the artwork inside the middle 80%
(the "safe zone"), because phones crop it to a circle or rounded square.
"""
from pathlib import Path
from PIL import Image

icons = Path(__file__).resolve().parent.parent / 'icons'
master = Image.open(icons / 'maskable-512.png').convert('RGBA')
if master.size != (512, 512):
    raise SystemExit('icons/maskable-512.png must be exactly 512 x 512 pixels')

def resized(img, n):                      # sharp for upscaling pixel art, smooth for shrinking
    return img.resize((n, n), Image.NEAREST if n > img.width else Image.LANCZOS)

resized(master, 192).save(icons / 'icon-192.png')            # app icon (declared "any maskable" in the manifest)
resized(master, 180).save(icons / 'apple-touch-icon.png')    # iPhone home screen: full square, iOS rounds the corners itself
safe = master.crop((51, 51, 461, 461))                         # centre 80%: favicons look better without the padding
resized(safe, 32).save(icons / 'icon-32.png')
resized(safe, 64).save(icons / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
print('Icons rebuilt from icons/maskable-512.png')
