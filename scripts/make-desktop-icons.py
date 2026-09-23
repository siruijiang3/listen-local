"""Generate simple original application icons; Pillow is a build-only dependency."""
from pathlib import Path
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parents[1] / 'src-tauri/icons'
root.mkdir(parents=True, exist_ok=True)
image = Image.new('RGBA', (256, 256), '#285942')
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((35, 35, 221, 221), radius=70, outline='#f6f4ed', width=9)
for x, height in ((82, 50), (105, 92), (128, 125), (151, 80), (174, 45)):
    draw.rounded_rectangle((x-5, 128-height//2, x+5, 128+height//2), radius=5, fill='#f6f4ed')
for size in (32, 128):
    image.resize((size, size), Image.Resampling.LANCZOS).save(root / f'{size}x{size}.png')
image.save(root / 'icon.ico', sizes=[(16,16),(32,32),(48,48),(128,128),(256,256)])
