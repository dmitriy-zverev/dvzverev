"""Reserve an opaque disclaimer band in the final 1280x720 PNG."""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

path, text, fraction = sys.argv[1:]
fonts = [os.environ.get('BOT_DISCLAIMER_FONT', ''),
         '/usr/share/fonts/dejavu/DejaVuSans.ttf',
         '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf',
         '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
         '/System/Library/Fonts/Supplemental/Arial.ttf']
font_path = next((f for f in fonts if f and os.path.isfile(f)), None)
if not font_path:
    raise RuntimeError('Cyrillic disclaimer font unavailable')
with Image.open(path) as source:
    image = source.convert('RGB')
    if image.size != (1280, 720):
        raise RuntimeError('Unexpected image dimensions')
    draw = ImageDraw.Draw(image)
    height = max(72, round(720 * float(fraction)))
    font = ImageFont.truetype(font_path, 30)
    lines, line = [], ''
    for word in text.split():
        candidate = (line + ' ' + word).strip()
        if draw.textlength(candidate, font=font) > 1200:
            lines.append(line)
            line = word
        else:
            line = candidate
    lines.append(line)
    height = max(height, len(lines) * 40 + 24)
    draw.rectangle((0, 720 - height, 1280, 720), fill='white')
    for i, line in enumerate(lines):
        draw.text((40, 720 - height + 12 + i * 40), line, fill='black', font=font)
    temporary = path + '.disclaimer.tmp'
    image.save(temporary, format='PNG', optimize=True)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
