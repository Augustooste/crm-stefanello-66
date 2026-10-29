from pathlib import Path
import json
import subprocess
import sys
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
FONT = ImageFont.truetype('/usr/share/fonts/noto/NotoSans-Regular.ttf', 19)

def main() -> None:
    samples = json.loads((ROOT / 'scenes/samples.json').read_text(encoding='utf-8'))
    every_second = '--every-second' in sys.argv[2:]
    output = ROOT / 'review-1s' if every_second else ROOT
    stills = output / 'stills'
    stills.mkdir(parents=True, exist_ok=True)
    if every_second:
        plan = json.loads((ROOT / 'scenes/plan.json').read_text(encoding='utf-8'))
        bounds, cursor = [], 0
        for scene in plan:
            cursor += scene['duration']
            bounds.append((cursor, scene['id']))
        samples = [{'time': second + 0.5,
                    'scene': next(scene for end, scene in bounds if second + 0.5 < end)}
                   for second in range(int(cursor))]
        (output / 'samples.json').write_text(json.dumps(samples, ensure_ascii=False, indent=2), encoding='utf-8')
    if len(sys.argv) > 1:
        video = ROOT / sys.argv[1]
        for sample in samples:
            target = stills / f"still_{sample['time']:.2f}s.png"
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(sample['time']),
                            '-i', str(video), '-frames:v', '1', '-update', '1', str(target)],
                           check=True)
        expected = {f"still_{sample['time']:.2f}s.png" for sample in samples}
        for old in stills.glob('still_*s.png'):
            if old.name not in expected:
                old.unlink()
    cell_w, cell_h = 640, 397
    for page, start in enumerate(range(0, len(samples), 9), 1):
        group = samples[start:start + 9]
        sheet = Image.new('RGB', (cell_w * 3, cell_h * ((len(group) + 2) // 3)), '#101722')
        draw = ImageDraw.Draw(sheet)
        for index, sample in enumerate(group):
            frame = Image.open(stills / f"still_{sample['time']:.2f}s.png").convert('RGB')
            frame.thumbnail((640, 360), Image.Resampling.LANCZOS)
            x, y = (index % 3) * cell_w, (index // 3) * cell_h
            sheet.paste(frame, (x, y))
            label = f"{start + index + 1:02d} · {sample['time']:.2f}s · {sample['scene']}"
            draw.text((x + 12, y + 365), label, font=FONT, fill='#ffffff')
        target = output / (f'sheet-{page}.jpg' if every_second else f'contact-sheet-{page}.jpg')
        sheet.save(target, quality=95)
        print(target)

if __name__ == '__main__':
    main()
