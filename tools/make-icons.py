# -*- coding: utf-8 -*-
"""由 brand/*.jpg 原始代币图，导出四个站点各自的 PWA / favicon 图标集。

用法（仓库根目录下执行）：
    python tools/make-icons.py

源图放在 brand/ 下：brand/tkcc.jpg、brand/orion.jpg、brand/pick.jpg、brand/leo.jpg。
换图后重跑本脚本即可；注意 sw.js 的 CACHE 版本号要手动 +1（SHELL 清单变了）。

裁剪策略（逐图自动判定）：
  1) 纯白背景（TKCC）      → 去掉白边到最小外接框，再补白成正方形（图标主体尽量占满）。
  2) 纯色/近纯色背景（ORION）→ 按内容外接框居中裁成正方形，留 8% 余量；
     这样既不会切到主体，也避免"贴边补色"在渐变背景上留下竖条接缝。
  3) 其它（照片，LEO / PICK）→ 直接居中裁成正方形。

依赖：Pillow（pip install pillow）
"""
import os
import sys
from PIL import Image, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = {s: os.path.join(ROOT, 'brand', s + '.jpg') for s in ('tkcc', 'orion', 'pick', 'leo')}


def border_pixels(im, step_ratio=48):
    w, h = im.size
    px = im.load()
    step = max(1, max(w, h) // step_ratio)
    s = []
    for x in range(0, w, step):
        s.append(px[x, 0]); s.append(px[x, h - 1])
    for y in range(0, h, step):
        s.append(px[0, y]); s.append(px[w - 1, y])
    return s


def border_is_white(im, thr=238, ratio=0.92):
    s = border_pixels(im)
    return sum(1 for c in s if min(c) > thr) / max(1, len(s)) > ratio


def bbox_of(im, bg, thr):
    diff = ImageChops.difference(im, Image.new('RGB', im.size, bg)).convert('L')
    return diff.point(lambda p: 255 if p > thr else 0).getbbox()


def is_uniform_bg(im, bg, tol=30, ratio=0.75):
    s = border_pixels(im)
    near = sum(1 for c in s if max(abs(c[i] - bg[i]) for i in range(3)) <= tol)
    return near / max(1, len(s)) > ratio


def corner_color(im):
    w, h = im.size
    px = im.load()
    cs = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]]
    return tuple(sum(c[i] for c in cs) // len(cs) for i in range(3))


def square_with_edge(canvas_side, im, bg):
    """把 im 放到 (canvas_side, canvas_side) 画布中央；补边用边缘像素拉伸，
    纯色补边会在渐变背景上留下可见接缝。"""
    w, h = im.size
    ox, oy = (canvas_side - w) // 2, (canvas_side - h) // 2
    canvas = Image.new('RGB', (canvas_side, canvas_side), bg)
    canvas.paste(im, (ox, oy))
    rx, ry = canvas_side - ox - w, canvas_side - oy - h
    if ox > 0:
        canvas.paste(im.crop((0, 0, 1, h)).resize((ox, h), Image.NEAREST), (0, oy))
        canvas.paste(im.crop((w - 1, 0, w, h)).resize((rx, h), Image.NEAREST), (ox + w, oy))
    if oy > 0:
        canvas.paste(im.crop((0, 0, w, 1)).resize((w, oy), Image.NEAREST), (ox, 0))
        canvas.paste(im.crop((0, h - 1, w, h)).resize((w, ry), Image.NEAREST), (ox, oy + h))
    return canvas


def center_crop_square(im, side, cx, cy):
    w, h = im.size
    x = max(0, min(w - side, int(round(cx - side / 2))))
    y = max(0, min(h - side, int(round(cy - side / 2))))
    return im.crop((x, y, x + side, y + side))


def prepare(src):
    im = Image.open(src).convert('RGB')
    w, h = im.size
    if border_is_white(im):
        bg = (255, 255, 255)
        bb = bbox_of(im, bg, 16)
        if bb:
            im = im.crop(bb)
        note = 'autocrop-white'
        sq = square_with_edge(max(im.size), im, bg)
        return sq, bg, '%s %sx%s' % (note, *im.size)

    bg = corner_color(im)
    if is_uniform_bg(im, bg):
        bb = bbox_of(im, bg, 25) or (0, 0, w, h)
        bw, bh = bb[2] - bb[0], bb[3] - bb[1]
        side = min(int(max(bw, bh) * 1.08), min(w, h))
        im2 = center_crop_square(im, side, (bb[0] + bb[2]) / 2.0, (bb[1] + bb[3]) / 2.0)
        if im2.size[0] != im2.size[1]:
            im2 = square_with_edge(max(im2.size), im2, bg)
        return im2, bg, 'smart-crop(bbox %s) side=%s' % (bb, side)

    side = min(w, h)
    return center_crop_square(im, side, w / 2.0, h / 2.0), bg, 'center-crop side=%s' % side


def report(path):
    return '%8.1f KB  %s' % (os.path.getsize(path) / 1024.0, os.path.relpath(path, ROOT))


def main():
    missing = [p for p in SRC.values() if not os.path.exists(p)]
    if missing:
        sys.exit('缺少源图：%s' % missing)
    for site, src in SRC.items():
        sq, bg, note = prepare(src)
        print('=== %-6s %s  ->  %sx%s  bg=%s' % (site, note, sq.size[0], sq.size[1], bg))
        out = os.path.join(ROOT, site)
        sq.resize((128, 128), Image.LANCZOS).save(os.path.join(out, 'icon-128.png'), optimize=True)
        sq.resize((192, 192), Image.LANCZOS).save(os.path.join(out, 'icon-192.png'), optimize=True)
        sq.resize((512, 512), Image.LANCZOS).save(os.path.join(out, 'icon-512.png'), optimize=True)
        sq.resize((180, 180), Image.LANCZOS).save(os.path.join(out, 'apple-touch-icon.png'), optimize=True)

        mk = Image.new('RGB', (512, 512), bg)
        inner = sq.resize((int(512 * 0.88), int(512 * 0.88)), Image.LANCZOS)
        mk.paste(inner, ((512 - inner.size[0]) // 2, (512 - inner.size[1]) // 2))
        mk.save(os.path.join(out, 'icon-maskable-512.png'), optimize=True)
        for f in ('icon-128.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'icon-maskable-512.png'):
            print('    ' + report(os.path.join(out, f)))


if __name__ == '__main__':
    main()
