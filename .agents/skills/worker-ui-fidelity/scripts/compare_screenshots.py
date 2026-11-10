#!/usr/bin/env python3
"""Generate comparison evidence; never decide whether a UI is acceptable."""
import argparse
import hashlib
import io
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageOps


def read_image(path):
    data = path.read_bytes()
    with Image.open(io.BytesIO(data)) as source:
        original_size = source.size
        oriented = ImageOps.exif_transpose(source).convert("RGBA")
    # Transparent images need an explicit, reproducible viewing surface.
    image = Image.alpha_composite(
        Image.new("RGBA", oriented.size, "white"), oriented
    ).convert("RGB")
    return image, {
        "path": str(path.resolve()),
        "sha256": hashlib.sha256(data).hexdigest(),
        "original_size": list(original_size),
        "oriented_size": list(image.size),
    }


def crop_image(image, crop, info):
    info["crop_xywh"] = crop
    if crop is not None:
        x, y, width, height = crop
        if x < 0 or y < 0 or width <= 0 or height <= 0:
            raise ValueError("Crop requires nonnegative x,y and positive width,height.")
        if x + width > image.width or y + height > image.height:
            raise ValueError("Crop is outside the source image.")
        image = image.crop((x, y, x + width, y + height))
    info["cropped_size"] = list(image.size)
    return image


def compare(args):
    if (args.reference_crop or args.actual_crop or args.resize_actual) and not args.alignment_note.strip():
        raise ValueError("Crop/resize requires --alignment-note with the reason and coordinate mapping.")
    reference, reference_info = read_image(args.reference)
    actual, actual_info = read_image(args.actual)
    reference = crop_image(reference, args.reference_crop, reference_info)
    actual = crop_image(actual, args.actual_crop, actual_info)
    if args.resize_actual:
        if reference.width * actual.height != reference.height * actual.width:
            raise ValueError("Aspect ratios differ; resizing must not stretch the UI.")
        actual = actual.resize(reference.size, Image.Resampling.LANCZOS)
    if reference.size != actual.size:
        raise ValueError(
            f"Size mismatch: reference {reference.size}, actual {actual.size}. "
            "Recapture with matching settings or declare crop/resize explicitly."
        )
    difference = ImageChops.difference(reference, actual)
    red, green, blue = difference.split()
    magnitude = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    histogram = magnitude.histogram()
    changed = sum(histogram[1:])
    side_by_side = Image.new("RGB", (reference.width * 2, reference.height))
    side_by_side.paste(reference, (0, 0))
    side_by_side.paste(actual, (reference.width, 0))
    images = {
        "reference.png": reference,
        "actual.png": actual,
        "side-by-side.png": side_by_side,
        "overlay.png": Image.blend(reference, actual, 0.5),
        "difference.png": magnitude.point(lambda value: min(255, value * 4)),
    }
    report = {
        "schema_version": 1,
        "reference": reference_info,
        "actual": actual_info,
        "processing": {
            "alpha_background": "#ffffff",
            "exif_transposed": True,
            "difference_gain": 4,
            "resize_actual": args.resize_actual,
            "resampling": "LANCZOS" if args.resize_actual else None,
            "alignment_note": args.alignment_note,
        },
        "comparison": {
            "size": list(reference.size),
            "changed_pixels": changed,
            "changed_fraction": changed / (reference.width * reference.height),
            "difference_bounds": magnitude.getbbox(),
        },
        "visual_status": "not_reviewed",
        "artifacts": list(images),
    }
    args.output.mkdir(parents=True, exist_ok=False)
    for name, image in images.items():
        image.save(args.output / name)
    (args.output / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def crop_argument(value):
    try:
        values = tuple(int(part) for part in value.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("Crop must be x,y,width,height integers.")
    if len(values) != 4:
        raise argparse.ArgumentTypeError("Crop must be x,y,width,height integers.")
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--actual", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--reference-crop", type=crop_argument, help="Oriented source pixels: x,y,width,height")
    parser.add_argument("--actual-crop", type=crop_argument, help="Oriented source pixels: x,y,width,height")
    parser.add_argument("--resize-actual", action="store_true", help="Explicit uniform resize to reference dimensions")
    parser.add_argument("--alignment-note", default="", help="Required reason for any crop or resize")
    args = parser.parse_args()
    try:
        compare(args)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f"Evidence written to {args.output}; visual review still required.")


if __name__ == "__main__":
    main()
