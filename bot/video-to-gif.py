import json
import os
import subprocess
import sys
from PIL import Image

source, destination = sys.argv[1:3]
probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', source], timeout=10))
video = next(s for s in probe['streams'] if s['codec_type'] == 'video')
if not 3 <= float(probe['format']['duration']) <= 10 or max(video['width'], video['height']) > 4096:
    raise ValueError('Invalid video dimensions or duration')
# Keep actual preview dimensions; upscaling indexed frames greatly inflates GIFs.
# Prefer detail, then reduce resolution/FPS/palette to stay within a 2 MB budget.
limit = 2_000_000
for fps, colors, detail in [(6, 128, 768), (6, 96, 640), (5, 64, 512), (4, 48, 480), (4, 32, 384)]:
    filters = (f'[0:v]trim=duration=3,setpts=PTS-STARTPTS,fps={fps},'
               f'scale={detail}:{detail * 9 // 16}:force_original_aspect_ratio=decrease:flags=lanczos,'
               f'pad={detail}:{detail * 9 // 16}:(ow-iw)/2:(oh-ih)/2,format=rgb24,split[f][r];'
               '[r]reverse[rev];[f][rev]concat=n=2:v=1:a=0,split[a][b];'
               f'[a]palettegen=max_colors={colors}[p];[b][p]paletteuse=dither=none:diff_mode=rectangle[out]')
    result = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-threads', '1',
                    '-filter_complex_threads', '1', '-i', source, '-filter_complex', filters,
                    '-map', '[out]', '-an', '-loop', '0', '-gifflags', '+offsetting+transdiff', '-f', 'gif', destination],
                   timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if result.returncode:
        sys.stderr.write(result.stderr.decode('utf-8', errors='replace')[-2000:])
        raise ValueError(f'FFmpeg conversion failed ({result.returncode})')
    if os.path.getsize(destination) <= limit:
        break
if os.path.getsize(destination) > limit:
    raise ValueError('GIF exceeds size limit')
with Image.open(destination) as image:
    if image.size != (detail, detail * 9 // 16) or image.n_frames < 2 or image.info.get('loop') != 0:
        raise ValueError('Invalid GIF')
    duration = 0
    first = image.convert('RGB').tobytes()
    for frame in range(image.n_frames):
        image.seek(frame)
        duration += image.info.get('duration', 0)
    if first != image.convert('RGB').tobytes() or not 4000 <= duration <= 7000:
        raise ValueError('Invalid loop endpoints or duration')
    print(json.dumps({'width': image.width, 'height': image.height, 'fps': fps, 'colors': colors, 'frames': image.n_frames, 'duration': duration / 1000, 'bytes': os.path.getsize(destination), 'loop': True}))
