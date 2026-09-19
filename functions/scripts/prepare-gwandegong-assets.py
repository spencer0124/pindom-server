"""Resize the supplied inventory into anonymous mobile assets; originals stay untouched.

python3 scripts/prepare-gwandegong-assets.py inventory.json /tmp/gwandegong-assets
Requires Pillow. The private inventory remains outside the repository.
"""

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageOps


def initials(value):
    consonants = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
    return "".join(consonants[(ord(c) - 0xAC00) // 588] for c in value)


def prepare(inventory_path, output_dir):
    inventory = json.loads(Path(inventory_path).read_text())
    groups = list(dict.fromkeys(item["person"] for item in inventory))
    expected = [("yhj", "ㅇㅎㅈ", 4), ("jsy", "ㅈㅅㅇ", 3),
                ("ljw", "ㅇㅈㅇ", 3), ("kmj", "ㄱㅁㅈ", 13)]
    assert len(groups) == 4 and len(inventory) == 23, "Unexpected inventory size"
    for person, (_, label, count) in zip(groups, expected):
        assert initials(person) == label, "Unexpected contributor order"
        numbers = sorted(item["number"] for item in inventory if item["person"] == person)
        assert numbers == list(range(1, count + 1)), "Duplicate or missing source number"

    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    records = []
    for item in inventory:
        group, label, _ = expected[groups.index(item["person"])]
        place_id = f"place-gdg-{group}-{item['number']:02}"
        record = {"id": place_id, "contributorInitials": label,
                  "sourceNumber": item["number"], "assets": {}}
        for source_kind, details in item["files"].items():
            kind = "cover" if source_kind == "background" else "cutout"
            suffix = "jpg" if kind == "cover" else "png"
            name = f"{place_id}-{kind}.{suffix}"
            with Image.open(details["sourcePath"]) as source:
                image = ImageOps.exif_transpose(source).convert("RGBA")
                image.thumbnail((1600, 1600) if kind == "cover" else (1800, 1800),
                                Image.Resampling.LANCZOS)
                image.info.clear()
                if kind == "cover":
                    opaque = Image.new("RGB", image.size, "white")
                    opaque.paste(image, mask=image.getchannel("A"))
                    opaque.save(output / name, "JPEG", quality=88, optimize=True)
                else:
                    image.save(output / name, "PNG", optimize=True)
            data = (output / name).read_bytes()
            record["assets"][kind] = {
                "fileName": name, "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data), "width": image.width, "height": image.height,
                "contentType": "image/jpeg" if kind == "cover" else "image/png",
                "source": "provided",
            }
        records.append(record)
    (output / "assets.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"places": len(records), "assets": sum(len(r["assets"]) for r in records),
                      "bytes": sum(a["bytes"] for r in records for a in r["assets"].values())}))


if __name__ == "__main__":
    prepare(sys.argv[1], sys.argv[2])
