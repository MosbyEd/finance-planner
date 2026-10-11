"""Значок для Mac из иконки iOS-приложения: квадрат во всю площадь → скруглённая «плитка» по сетке macOS
(824×824 в холсте 1024, мягкая тень снизу) и набор размеров для iconutil.

    python3 macos/make-icon.py <иконка 1024×1024.png> <папка .iconset>
"""

import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

source, target = Path(sys.argv[1]), Path(sys.argv[2])
target.mkdir(parents=True, exist_ok=True)

CANVAS, BODY, RADIUS, SCALE = 1024, 824, 185, 4
offset = (CANVAS - BODY) // 2

# Маска со сглаженными углами: рисуем крупно и уменьшаем.
mask = Image.new("L", (BODY * SCALE, BODY * SCALE), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, BODY * SCALE - 1, BODY * SCALE - 1), RADIUS * SCALE, fill=255)
mask = mask.resize((BODY, BODY), Image.LANCZOS)

art = Image.open(source).convert("RGBA").resize((BODY, BODY), Image.LANCZOS)
art.putalpha(ImageChops.multiply(art.getchannel("A"), mask))

shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
shadow_mask = Image.new("L", (CANVAS, CANVAS), 0)
shadow_mask.paste(mask, (offset, offset + 12))
shadow.putalpha(shadow_mask.filter(ImageFilter.GaussianBlur(14)).point(lambda a: int(a * 0.35)))

icon = Image.alpha_composite(shadow, Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0)))
icon.alpha_composite(art, (offset, offset))

for size in (16, 32, 128, 256, 512):
    icon.resize((size, size), Image.LANCZOS).save(target / f"icon_{size}x{size}.png")
    icon.resize((size * 2, size * 2), Image.LANCZOS).save(target / f"icon_{size}x{size}@2x.png")
