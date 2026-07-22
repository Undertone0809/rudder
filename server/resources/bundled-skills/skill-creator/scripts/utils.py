"""Shared utilities for skill-creator scripts."""

from __future__ import annotations

import re
from pathlib import Path


FRONTMATTER_PATTERN = re.compile(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", re.DOTALL)


def extract_frontmatter_text(content: str) -> str:
    """Return the raw YAML frontmatter text from a SKILL.md file."""
    match = FRONTMATTER_PATTERN.match(content)
    if not match:
        raise ValueError("SKILL.md missing frontmatter (expected opening and closing ---)")
    return match.group(1)


def _count_indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _parse_scalar(value: str):
    value = value.strip()
    if not value:
        return ""

    if value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]

    lowered = value.lower()
    if lowered in {"true", "false"}:
        return lowered == "true"
    if lowered in {"null", "~"}:
        return None

    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if re.fullmatch(r"-?\d+\.\d+", value):
        return float(value)

    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [_parse_scalar(part.strip()) for part in inner.split(",")]

    return value


def _fold_lines(lines: list[str]) -> str:
    paragraphs: list[list[str]] = [[]]
    for line in lines:
        if line == "":
            if paragraphs[-1]:
                paragraphs.append([])
            continue
        paragraphs[-1].append(line)

    folded = [" ".join(paragraph).strip() for paragraph in paragraphs if paragraph]
    return "\n\n".join(part for part in folded if part)


def _parse_block_scalar(lines: list[str], start: int, indent: int, style: str):
    collected: list[str] = []
    index = start
    while index < len(lines):
        raw = lines[index]
        if not raw.strip():
            collected.append("")
            index += 1
            continue

        current_indent = _count_indent(raw)
        if current_indent < indent:
            break
        collected.append(raw[indent:])
        index += 1

    if style.startswith("|"):
        value = "\n".join(collected)
    else:
        value = _fold_lines(collected)
    return value, index


def _looks_like_mapping_entry(text: str) -> bool:
    if text.startswith("- "):
        return False
    return bool(re.match(r"^[A-Za-z0-9_-]+:\s*.*$", text))


def _next_nonempty_index(lines: list[str], start: int, min_indent: int):
    index = start
    while index < len(lines):
        raw = lines[index]
        if not raw.strip():
            index += 1
            continue
        indent = _count_indent(raw)
        if indent < min_indent:
            return None
        return index
    return None


def _parse_list(lines: list[str], start: int, indent: int):
    items = []
    index = start
    while index < len(lines):
        raw = lines[index]
        if not raw.strip():
            index += 1
            continue

        current_indent = _count_indent(raw)
        if current_indent < indent:
            break
        if current_indent != indent or not raw[indent:].startswith("- "):
            raise ValueError(f"Invalid list entry near line: {raw}")

        remainder = raw[indent + 2 :].strip()
        index += 1

        if remainder:
            items.append(_parse_scalar(remainder))
            continue

        next_index = _next_nonempty_index(lines, index, indent + 2)
        if next_index is None:
            items.append("")
            continue

        nested_indent = _count_indent(lines[next_index])
        nested_text = lines[next_index][nested_indent:]
        if nested_text.startswith("- "):
            value, index = _parse_list(lines, next_index, nested_indent)
        elif _looks_like_mapping_entry(nested_text):
            value, index = _parse_mapping(lines, next_index, nested_indent)
        else:
            value, index = _parse_block_scalar(lines, next_index, nested_indent, ">")
        items.append(value)

    return items, index


def _parse_mapping(lines: list[str], start: int, indent: int):
    mapping = {}
    index = start

    while index < len(lines):
        raw = lines[index]
        if not raw.strip():
            index += 1
            continue

        current_indent = _count_indent(raw)
        if current_indent < indent:
            break
        if current_indent != indent:
            raise ValueError(f"Unexpected indentation near line: {raw}")

        text = raw[indent:]
        if text.startswith("- "):
            raise ValueError(f"Unexpected list item near line: {raw}")
        if ":" not in text:
            raise ValueError(f"Invalid mapping entry near line: {raw}")

        key, remainder = text.split(":", 1)
        key = key.strip()
        remainder = remainder.strip()
        index += 1

        if remainder in {"|", ">", "|-", ">-"}:
            value, index = _parse_block_scalar(lines, index, indent + 2, remainder)
        elif remainder:
            value = _parse_scalar(remainder)
        else:
            next_index = _next_nonempty_index(lines, index, indent + 2)
            if next_index is None:
                value = ""
            else:
                nested_indent = _count_indent(lines[next_index])
                nested_text = lines[next_index][nested_indent:]
                if nested_text.startswith("- "):
                    value, index = _parse_list(lines, next_index, nested_indent)
                elif _looks_like_mapping_entry(nested_text):
                    value, index = _parse_mapping(lines, next_index, nested_indent)
                else:
                    value, index = _parse_block_scalar(lines, next_index, nested_indent, ">")
        mapping[key] = value

    return mapping, index


def parse_frontmatter(frontmatter_text: str) -> dict:
    """Parse a small YAML subset used by SKILL.md frontmatter without PyYAML."""
    lines = frontmatter_text.splitlines()
    mapping, index = _parse_mapping(lines, 0, 0)

    trailing = [line for line in lines[index:] if line.strip()]
    if trailing:
        raise ValueError(f"Unexpected trailing content in frontmatter: {trailing[0]}")
    return mapping


def load_skill_frontmatter(skill_path: Path) -> tuple[dict, str]:
    """Load and parse the frontmatter from a skill directory."""
    content = (skill_path / "SKILL.md").read_text()
    frontmatter_text = extract_frontmatter_text(content)
    frontmatter = parse_frontmatter(frontmatter_text)
    if not isinstance(frontmatter, dict):
        raise ValueError("Frontmatter must be a mapping")
    return frontmatter, content


def parse_skill_md(skill_path: Path) -> tuple[str, str, str]:
    """Parse a SKILL.md file, returning (name, description, full_content)."""
    frontmatter, content = load_skill_frontmatter(skill_path)
    name = frontmatter.get("name", "")
    description = frontmatter.get("description", "")
    return str(name or ""), str(description or ""), content
