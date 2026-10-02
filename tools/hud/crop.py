"""Crop/zoom helper for HUD inspection: python tools/hud/crop.py in.png out.png x y w h [scale]"""
import sys
from PIL import Image
a = sys.argv
im = Image.open(a[1])
x, y, w, h = map(int, a[3:7])
s = float(a[7]) if len(a) > 7 else 2
c = im.crop((x, y, x + w, y + h))
c = c.resize((int(w * s), int(h * s)), Image.LANCZOS)
c.save(a[2])
