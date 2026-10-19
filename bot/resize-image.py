import sys
import os
import warnings
from PIL import Image, ImageOps

# Bound decompression before allocating the resized canvas.
Image.MAX_IMAGE_PIXELS = 20_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)
mode = sys.argv[3] if len(sys.argv) > 3 else 'gif'
width = int(sys.argv[4]) if len(sys.argv) > 5 else (1080 if mode == 'png' else 1280)
height = int(sys.argv[5]) if len(sys.argv) > 5 else (1080 if mode == 'png' else 720)
with Image.open(sys.argv[1]) as image:
    image = ImageOps.exif_transpose(image).convert('RGB')
    # Keep the whole frame. Pad when the model returns a different ratio.
    image = ImageOps.pad(image, (width, height), method=Image.Resampling.LANCZOS, color='#071329')
    if mode == 'png':
        image.save(sys.argv[2], format='PNG', optimize=True)
        os.chmod(sys.argv[2], 0o600)
        sys.exit(0)
    # Legacy GIF documents remain supported for existing queued releases.
    first = image.convert('P', palette=Image.Palette.ADAPTIVE, colors=128)
    second = first.copy()
    # Keep two frames even when the illustration is static (Pillow merges identical frames).
    second.putpixel((0, 0), (first.getpixel((0, 0)) + 1) % 128)
    first.save(sys.argv[2], format='GIF', save_all=True, append_images=[second],
               duration=[1000, 1000], loop=0, optimize=False)
    os.chmod(sys.argv[2], 0o600)
