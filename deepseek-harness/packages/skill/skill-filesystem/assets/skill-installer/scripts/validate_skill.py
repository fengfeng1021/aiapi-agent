"""Validate a skill folder's SKILL.md structure.

Usage: validate_skill.py <path/to/skill-folder>

Checks the YAML frontmatter envelope, the required name and description,
the kebab-case grammar, legacy invocation keys, and a non-empty body.
Exits 0 when valid, 1 with one `path: message` line per issue otherwise.
Standard library only.
"""

import re
import sys
from pathlib import Path

SKILL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
LEGACY_KEYS = {
    "disableModelInvocation": "disable-model-invocation",
    "modelInvocable": "disable-model-invocation",
    "userInvocable": "user-invocable",
}


def split_envelope(text):
    lines = text.split("\n")
    if not lines or lines[0].rstrip("\r") != "---":
        return None
    for index in range(1, len(lines)):
        if lines[index].rstrip("\r") == "---":
            yaml_text = "\n".join(lines[1:index])
            body = "\n".join(lines[index + 1 :])
            return yaml_text, body
    return None


def parse_simple_mapping(yaml_text):
    """Parse flat `key: value` lines; returns None on structural problems."""
    data = {}
    for lineno, line in enumerate(yaml_text.split("\n"), start=2):
        if not line.strip():
            continue
        match = re.match(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$", line)
        if not match:
            return None
        key, raw = match.group(1), match.group(2).strip()
        if (raw.startswith('"') and raw.endswith('"') and len(raw) >= 2) or (
            raw.startswith("'") and raw.endswith("'") and len(raw) >= 2
        ):
            raw = raw[1:-1]
        data[key] = raw
    return data


def validate(folder):
    issues = []
    skill_file = Path(folder) / "SKILL.md"
    if not skill_file.is_file():
        return [f"{skill_file}: missing SKILL.md"]
    text = skill_file.read_text(encoding="utf-8")
    split = split_envelope(text)
    if split is None:
        return [f"{skill_file}: missing YAML frontmatter envelope"]
    yaml_text, body = split
    data = parse_simple_mapping(yaml_text)
    if data is None:
        return [f"{skill_file}: frontmatter is not a flat mapping"]
    name = data.get("name", "")
    if not name:
        issues.append(f"{skill_file}: frontmatter requires a name")
    elif not SKILL_NAME.match(name):
        issues.append(f'{skill_file}: skill name "{name}" must be kebab-case like "code-review"')
    if not data.get("description", ""):
        issues.append(f"{skill_file}: frontmatter requires a description")
    for legacy, canonical in LEGACY_KEYS.items():
        if legacy in data:
            issues.append(f'{skill_file}: frontmatter field "{legacy}" is unsupported; use "{canonical}"')
    if not body.strip():
        issues.append(f"{skill_file}: body must be non-empty")
    return issues


def main(argv):
    if len(argv) != 2:
        print("usage: validate_skill.py <path/to/skill-folder>", file=sys.stderr)
        return 2
    issues = validate(argv[1])
    for issue in issues:
        print(issue)
    return 1 if issues else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
