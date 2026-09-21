"""
提示词反推扩展 - 图标生成脚本
使用 Pillow 生成 Chrome 扩展所需的 3 种尺寸图标 (16x16, 48x48, 128x128)

使用方法:
    python generate_icons.py

生成的图标将保存在 icons/ 目录下
"""
import os
from PIL import Image, ImageDraw

# 图标配置
ICON_COLOR = (59, 130, 246)  # #3B82F6 蓝色
BG_COLOR = (59, 130, 246, 255)  # 蓝色背景
STAR_COLOR = (255, 255, 255, 255)  # 白色星星
CORNER_RADIUS_RATIO = 0.22  # 圆角比例

SIZES = [16, 48, 128]
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")


def draw_rounded_rect(draw, xy, radius, fill):
    """绘制圆角矩形"""
    draw.rounded_rectangle(xy, radius=radius, fill=fill)


def draw_star(draw, center, size, fill):
    """
    绘制四角星 (Sparkle 图标)
    center: (x, y) 中心点
    size: 星星大小
    """
    cx, cy = center
    s = size

    # 四角星的 8 个顶点
    points = [
        (cx, cy - s),          # 上
        (cx + s * 0.25, cy - s * 0.25),  # 右上
        (cx + s, cy),          # 右
        (cx + s * 0.25, cy + s * 0.25),  # 右下
        (cx, cy + s),          # 下
        (cx - s * 0.25, cy + s * 0.25),  # 左下
        (cx - s, cy),          # 左
        (cx - s * 0.25, cy - s * 0.25),  # 左上
    ]
    draw.polygon(points, fill=fill)


def draw_small_star(draw, center, size, fill):
    """绘制小星星 (右上角装饰)"""
    cx, cy = center
    s = size
    r = s * 0.3

    # 简化版小圆点星
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)


def generate_icon(size):
    """生成指定尺寸的图标"""
    # 创建透明背景
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 绘制圆角矩形背景
    margin = max(1, size // 10)
    radius = int(size * CORNER_RADIUS_RATIO)
    draw_rounded_rect(
        draw,
        [margin, margin, size - margin, size - margin],
        radius,
        BG_COLOR,
    )

    # 绘制主星星 (居中偏左下)
    star_size = size * 0.28
    star_center = (size * 0.42, size * 0.42)
    draw_star(draw, star_center, star_size, STAR_COLOR)

    # 绘制小装饰星 (右上角)
    if size >= 48:
        small_star_size = size * 0.08
        small_star_center = (size * 0.72, size * 0.28)
        draw_small_star(draw, small_star_center, small_star_size, (255, 255, 255, 200))

    return img


def main():
    # 创建输出目录
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print("生成 Chrome 扩展图标...")
    print(f"输出目录: {OUTPUT_DIR}")
    print()

    for size in SIZES:
        icon = generate_icon(size)
        filename = f"icon{size}.png"
        filepath = os.path.join(OUTPUT_DIR, filename)
        icon.save(filepath, "PNG")
        print(f"  [OK] {filename} ({size}x{size})")

    print()
    print("图标生成完成!")
    print()
    print("下一步:")
    print("  1. 在 Chrome 中打开 chrome://extensions/")
    print("  2. 开启「开发者模式」")
    print("  3. 点击「加载已解压的扩展程序」")
    print("  4. 选择 prompt-reverse-extension 目录")
    print("  5. 启动 Python 后端: cd server && python app.py")


if __name__ == "__main__":
    main()
