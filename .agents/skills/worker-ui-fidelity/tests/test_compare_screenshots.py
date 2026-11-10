"""Exercise the screenshot comparator through its public CLI."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest

from PIL import Image


SKILL = Path(__file__).resolve().parents[1]
SCRIPT = SKILL / "scripts/compare_screenshots.py"
SCRATCH = Path(tempfile.gettempdir())


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=SCRATCH)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.reference = self.root / "source.png"
        self.actual = self.root / "capture.png"
        self.output = self.root / "round-01"
        Image.new("RGB", (8, 6), "white").save(self.reference)
        Image.new("RGB", (8, 6), "white").save(self.actual)

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--reference", str(self.reference),
             "--actual", str(self.actual), "--output", str(self.output), *args],
            text=True, capture_output=True,
        )

    def report(self):
        return json.loads((self.output / "report.json").read_text())

    def test_identical_images_produce_evidence_without_claiming_acceptance(self):
        original = self.reference.read_bytes()
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = self.report()
        self.assertEqual(report["reference"]["sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(report["comparison"]["changed_pixels"], 0)
        self.assertEqual(report["visual_status"], "not_reviewed")
        self.assertEqual(self.reference.read_bytes(), original)
        for name in ("reference.png", "actual.png", "side-by-side.png", "overlay.png", "difference.png"):
            with Image.open(self.output / name) as image:
                image.load()
        with Image.open(self.output / "side-by-side.png") as image:
            self.assertEqual(image.size, (16, 6))

    def test_moved_element_is_localized_without_being_aligned_away(self):
        with Image.open(self.reference) as source:
            source.putpixel((1, 1), (0, 0, 0))
            source.save(self.reference)
        with Image.open(self.actual) as capture:
            capture.putpixel((4, 1), (0, 0, 0))
            capture.save(self.actual)
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = self.report()
        self.assertEqual(report["comparison"]["changed_pixels"], 2)
        self.assertAlmostEqual(report["comparison"]["changed_fraction"], 2 / 48)
        self.assertEqual(report["comparison"]["difference_bounds"], [1, 1, 5, 2])
        with Image.open(self.output / "difference.png") as difference:
            self.assertEqual(difference.getpixel((1, 1)), 255)
            self.assertEqual(difference.getpixel((4, 1)), 255)
            self.assertEqual(difference.getpixel((0, 0)), 0)

    def test_size_mismatch_requires_explicit_alignment_without_creating_output(self):
        Image.new("RGB", (16, 12), "white").save(self.actual)
        result = self.run_cli()
        self.assertEqual(result.returncode, 2)
        self.assertIn("Size mismatch", result.stderr)
        self.assertFalse(self.output.exists())

    def test_explicit_system_bar_crop_and_density_resize_are_recorded(self):
        capture = Image.new("RGB", (16, 16), "black")
        capture.paste("white", (0, 2, 16, 14))
        capture.save(self.actual)
        original = self.actual.read_bytes()
        result = self.run_cli(
            "--actual-crop", "0,2,16,12", "--resize-actual",
            "--alignment-note", "Remove system bars; capture density is 2x.",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        report = self.report()
        self.assertEqual(report["actual"]["crop_xywh"], [0, 2, 16, 12])
        self.assertEqual(report["actual"]["original_size"], [16, 16])
        self.assertEqual(report["processing"]["resize_actual"], True)
        self.assertEqual(report["processing"]["alignment_note"], "Remove system bars; capture density is 2x.")
        self.assertEqual(report["comparison"]["changed_pixels"], 0)
        self.assertEqual(self.actual.read_bytes(), original)

    def test_alignment_cannot_silently_crop_stretch_or_accept_invalid_coordinates(self):
        cases = [
            (["--actual-crop", "0,0,8,6"], "alignment-note"),
            (["--resize-actual"], "alignment-note"),
            (["--actual-crop", "1,0,8,6", "--alignment-note", "crop"], "outside"),
            (["--actual-crop", "0,0,0,6", "--alignment-note", "crop"], "positive"),
            (["--actual-crop", "oops", "--alignment-note", "crop"], "integers"),
            (["--reference-crop", "0,0,4,6", "--resize-actual",
              "--alignment-note", "density"], "Aspect ratios differ"),
        ]
        for args, message in cases:
            with self.subTest(args=args):
                result = self.run_cli(*args)
                self.assertEqual(result.returncode, 2)
                self.assertIn(message, result.stderr)
                self.assertFalse(self.output.exists())

    def test_an_existing_round_is_never_overwritten(self):
        self.assertEqual(self.run_cli().returncode, 0)
        report = (self.output / "report.json").read_bytes()
        Image.new("RGB", (8, 6), "black").save(self.actual)
        self.assertEqual(self.run_cli().returncode, 2)
        self.assertEqual((self.output / "report.json").read_bytes(), report)
        with Image.open(self.output / "actual.png") as image:
            self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))

    def test_output_cannot_replace_an_input_directory(self):
        self.output = self.root
        original = self.reference.read_bytes()
        self.assertEqual(self.run_cli().returncode, 2)
        self.assertEqual(self.reference.read_bytes(), original)
        self.assertFalse((self.root / "report.json").exists())

    def test_unreadable_capture_does_not_leave_partial_evidence(self):
        self.actual.write_text("not an image")
        self.assertEqual(self.run_cli().returncode, 2)
        self.assertFalse(self.output.exists())

    def test_transparency_is_composited_on_the_documented_surface(self):
        Image.new("RGBA", (8, 6), (0, 0, 0, 0)).save(self.actual)
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.report()["comparison"]["changed_pixels"], 0)
        self.assertEqual(self.report()["processing"]["alpha_background"], "#ffffff")

    def test_reference_crop_is_explicit_and_retains_original_hash(self):
        result = self.run_cli(
            "--reference-crop", "1,1,4,3", "--actual-crop", "1,1,4,3",
            "--alignment-note", "Same title region; full screen is reviewed separately.",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.report()["reference"]["crop_xywh"], [1, 1, 4, 3])
        self.assertEqual(self.report()["comparison"]["size"], [4, 3])


if __name__ == "__main__":
    unittest.main()
