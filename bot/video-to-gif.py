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
# Buffer the loop at preview resolution: full-HD palette/reverse buffers exceed 256 MB.
# Upscale only after palette application; matching endpoints prevent a jump.
for fps, colors, detail in [(6, 96, 640), (4, 64, 480), (4, 48, 400)]:
    filters = (f'[0:v]trim=duration=3,setpts=PTS-STARTPTS,fps={fps},'
               f'scale={detail}:{detail * 9 // 16}:force_original_aspect_ratio=decrease:flags=lanczos,'
               f'pad={detail}:{detail * 9 // 16}:(ow-iw)/2:(oh-ih)/2,format=rgb24,split[f][r];'
               '[r]reverse[rev];[f][rev]concat=n=2:v=1:a=0,split[a][b];'
               f'[a]palettegen=max_colors={colors}[p];[b][p]paletteuse=dither=none[out]')
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-threads', '1',
                    '-filter_complex_threads', '1', '-i', source, '-filter_complex', filters,
                    '-map', '[out]', '-an', '-loop', '0', '-f', 'gif', destination],
                   check=True, timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    # Resize indexed frames using one shared palette; this keeps matching endpoints.
    with Image.open(destination) as small:
        palette = small.copy()
        frames, durations = [], []
        for index in range(small.n_frames):
            small.seek(index)
            durations.append(small.info.get('duration', 0))
            frames.append(small.convert('RGB').resize((1280, 720), Image.Resampling.NEAREST)
                          .quantize(palette=palette, dither=Image.Dither.NONE))
    frames[0].save(destination, format='GIF', save_all=True, append_images=frames[1:],
                   duration=durations, loop=0, disposal=2, optimize=False)
    del frames, palette
    if os.path.getsize(destination) <= 10_000_000:
        break
if os.path.getsize(destination) > 10_000_000:
    raise ValueError('GIF exceeds size limit')
with Image.open(destination) as image:
    if image.size != (1280, 720) or image.n_frames < 2 or image.info.get('loop') != 0:
        raise ValueError('Invalid GIF')
    duration = 0
    first = image.convert('RGB').tobytes()
    for frame in range(image.n_frames):
        image.seek(frame)
        duration += image.info.get('duration', 0)
    if first != image.convert('RGB').tobytes() or not 4000 <= duration <= 7000:
        raise ValueError('Invalid loop endpoints or duration')
    print(json.dumps({'width': 1280, 'height': 720, 'frames': image.n_frames, 'duration': duration / 1000, 'bytes': os.path.getsize(destination), 'loop': True}))
