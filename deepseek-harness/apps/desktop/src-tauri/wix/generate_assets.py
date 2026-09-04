"""Generate the text-free DeepSeek Harness artwork used by the WiX installer."""

from __future__ import annotations

from pathlib import Path
from struct import unpack_from

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parent
SCALE = 4
WHALE_ICON = ROOT.parent / "icons" / "128x128@2x.png"

INK = (15, 17, 20)  # #0F1114
PANEL_TOP = (249, 249, 250)  # #F9F9FA
PANEL_BOTTOM = (235, 237, 240)  # #EBEDF0
LINE = (211, 214, 219)  # #D3D6DB
WHITE = (255, 255, 255)


def blend(left: tuple[int, int, int], right: tuple[int, int, int], amount: float):
    return tuple(round(a + (b - a) * amount) for a, b in zip(left, right))


def vertical_gradient(size: tuple[int, int], top, bottom) -> Image.Image:
    width, height = size
    image = Image.new("RGB", size)
    pixels = image.load()
    for y in range(height):
        color = blend(top, bottom, y / max(height - 1, 1))
        for x in range(width):
            pixels[x, y] = color
    return image


def whale_mark(width: int) -> Image.Image:
    """Load the application's official whale silhouette and render it solid black."""
    source = Image.open(WHALE_ICON).convert("RGBA")
    alpha = source.getchannel("A")
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError(f"{WHALE_ICON.name} has no visible pixels")
    alpha = alpha.crop(bounds)
    height = round(width * alpha.height / alpha.width)
    alpha = alpha.resize((width, height), Image.Resampling.LANCZOS)
    mark = Image.new("RGBA", (width, height), (*INK, 255))
    mark.putalpha(alpha)
    return mark


def paste_centered(canvas: Image.Image, image: Image.Image, center: tuple[int, int]) -> None:
    x = center[0] - image.width // 2
    y = center[1] - image.height // 2
    canvas.alpha_composite(image, (x, y))


def build_banner() -> Image.Image:
    width, height = 493 * SCALE, 58 * SCALE
    base = Image.new("RGBA", (width, height), (*WHITE, 255))

    # WiX paints heading copy on the left. Keep that area white and seat the
    # official black whale in a quiet monochrome panel on the far right.
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.polygon(
        [(377 * SCALE, 0), (493 * SCALE, 0), (493 * SCALE, height), (352 * SCALE, height)],
        fill=(*PANEL_TOP, 255),
    )
    draw.line((365 * SCALE, 0, 340 * SCALE, height), fill=(*LINE, 150), width=SCALE)
    base.alpha_composite(overlay)
    paste_centered(base, whale_mark(43 * SCALE), (443 * SCALE, 29 * SCALE))
    return base.convert("RGB").resize((493, 58), Image.Resampling.LANCZOS)


def build_dialog() -> Image.Image:
    width, height = 493 * SCALE, 312 * SCALE
    base = Image.new("RGBA", (width, height), (*WHITE, 255))

    # WiX draws welcome/completion copy on the right; all artwork stays inside
    # the 154 px brand rail shared by the default installer pages.
    panel = vertical_gradient((154 * SCALE, height), PANEL_TOP, PANEL_BOTTOM).convert("RGBA")
    base.alpha_composite(panel, (0, 0))
    rail = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(rail)
    draw.line((153 * SCALE, 0, 153 * SCALE, height), fill=(*LINE, 255), width=SCALE)
    base.alpha_composite(rail)

    # A restrained white tile keeps the silhouette crisp on every Windows
    # display profile and replaces the stock blue installer artwork entirely.
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        (24 * SCALE, 83 * SCALE, 130 * SCALE, 189 * SCALE),
        radius=29 * SCALE,
        fill=(0, 0, 0, 42),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(7 * SCALE))
    base.alpha_composite(shadow)

    tile = Image.new("RGBA", base.size, (0, 0, 0, 0))
    tile_draw = ImageDraw.Draw(tile)
    tile_draw.rounded_rectangle(
        (24 * SCALE, 79 * SCALE, 130 * SCALE, 185 * SCALE),
        radius=29 * SCALE,
        fill=(*WHITE, 255),
        outline=(*LINE, 255),
        width=SCALE,
    )
    tile_draw.line(
        (43 * SCALE, 220 * SCALE, 111 * SCALE, 220 * SCALE),
        fill=(*INK, 230),
        width=2 * SCALE,
    )
    tile_draw.line(
        (57 * SCALE, 229 * SCALE, 97 * SCALE, 229 * SCALE),
        fill=(*LINE, 255),
        width=SCALE,
    )
    base.alpha_composite(tile)
    paste_centered(base, whale_mark(78 * SCALE), (77 * SCALE, 132 * SCALE))
    return base.convert("RGB").resize((493, 312), Image.Resampling.LANCZOS)


def save_and_validate(image: Image.Image, path: Path, expected_size: tuple[int, int]) -> None:
    image.save(path, format="BMP")
    with path.open("rb") as stream:
        header = stream.read(54)
    if header[:2] != b"BM":
        raise ValueError(f"{path.name} is not a BMP")
    width, height = unpack_from("<ii", header, 18)
    bits_per_pixel = unpack_from("<H", header, 28)[0]
    if (width, abs(height)) != expected_size or bits_per_pixel != 24:
        raise ValueError(
            f"{path.name}: expected {expected_size} at 24-bit, got "
            f"{(width, abs(height))} at {bits_per_pixel}-bit"
        )


if __name__ == "__main__":
    save_and_validate(build_banner(), ROOT / "banner.bmp", (493, 58))
    save_and_validate(build_dialog(), ROOT / "dialog.bmp", (493, 312))
    print("Generated 24-bit WiX artwork: banner.bmp (493x58), dialog.bmp (493x312)")
