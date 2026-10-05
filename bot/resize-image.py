import sys
import os
import warnings
from PIL import Image, ImageOps

# Bound decompression before allocating the resized canvas.
Image.MAX_IMAGE_PIXELS = 20_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)
with Image.open(sys.argv[1]) as image:
    image = ImageOps.exif_transpose(image).convert('RGB')
    # Preserve the entire composition; add a quiet border if output is not 16:9.
    image = ImageOps.pad(image, (1280, 720), method=Image.Resampling.LANCZOS, color='#071329')
    image.save(sys.argv[2], format='PNG', optimize=True)
    os.chmod(sys.argv[2], 0o600)
