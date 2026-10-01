# -*- coding: utf-8 -*-
"""生成 uTools 插件 logo.png（纯标准库，不依赖 Pillow）。

设计：**透明背景** + 单色线性图标 —— 一个文件夹轮廓，里面是终端提示符 ">_"。
没有底色板块、没有渐变，放在亮色或暗色主题下都干净。

取色 [47,127,208] 是刻意的：它与白底(#f6f8fc)和 uTools 暗底(#15181e)
的对比度都约 4.2:1，两种主题下都清楚，不需要为明暗各出一版。
"""
import struct
import zlib
from pathlib import Path

SIZE = 256
SS = 4  # 超采样倍数，用于抗锯齿

# 线条颜色（见文件头的取色理由）
LOGO_COLOR = (47, 127, 208)

# 线宽（超采样坐标系）
STROKE = 14 * SS

# 图形定义：折线列表（闭合图形把首点重复一次即可），坐标为 256 画布坐标系。
# 整体外框约 x 33..223 / y 57..199，视觉重心落在画布中心。
FOLDER = [(40, 192), (40, 64), (98, 64), (116, 86), (216, 86), (216, 192), (40, 192)]
PROMPT = [
    [(84, 115), (114, 139), (84, 163)],  # ">" 两段
    [(132, 163), (170, 163)],  # "_"
]


def seg_dist(px, py, ax, ay, bx, by):
    """点到线段的距离。每段按胶囊体求并集，拐角自然是圆角。"""
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    return ((px - (ax + t * vx)) ** 2 + (py - (ay + t * vy)) ** 2) ** 0.5


def polyline_dist(px, py, polys):
    best = float("inf")
    for pts in polys:
        for i in range(len(pts) - 1):
            ax, ay = pts[i][0] * SS, pts[i][1] * SS
            bx, by = pts[i + 1][0] * SS, pts[i + 1][1] * SS
            d = seg_dist(px, py, ax, ay, bx, by)
            if d < best:
                best = d
    return best


def build_pixels():
    W = SIZE * SS
    half = STROKE / 2
    feather = 1.5  # 边缘羽化宽度（超采样像素）
    polys = [FOLDER] + PROMPT
    r, g, b = LOGO_COLOR

    buf = []
    for y in range(W):
        row = []
        py = y + 0.5
        for x in range(W):
            d = polyline_dist(x + 0.5, py, polys)
            if d >= half + feather:
                row.append((0, 0, 0, 0))
                continue
            cov = 1.0 if d <= half else (half + feather - d) / feather
            row.append((r, g, b, int(round(cov * 255))))
        buf.append(row)
    return buf


def downsample(buf):
    """SS×SS 盒式降采样。按 alpha 预乘求平均，避免边缘发灰。"""
    out = []
    n = SS * SS
    for y in range(SIZE):
        row = []
        for x in range(SIZE):
            rs = gs = bs = as_ = 0
            for dy in range(SS):
                line = buf[y * SS + dy]
                for dx in range(SS):
                    pr, pg, pb, pa = line[x * SS + dx]
                    rs += pr * pa
                    gs += pg * pa
                    bs += pb * pa
                    as_ += pa
            if as_ == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((rs // as_, gs // as_, bs // as_, as_ // n))
        out.append(row)
    return out


def write_png(path, pixels):
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    Path(path).write_bytes(png)


if __name__ == "__main__":
    target = Path(__file__).resolve().parent.parent / "logo.png"
    write_png(target, downsample(build_pixels()))
    print("written:", target)
